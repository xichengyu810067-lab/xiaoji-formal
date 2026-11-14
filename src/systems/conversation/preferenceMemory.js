// Preference memory: what a member says they like while chatting with 小吉 (food, music, games, how they want to be
// called...), kept so later conversations can use it. It lives in a Turso database (libSQL over HTTPS) named by
// TURSO_DATABASE_URL and TURSO_AUTH_TOKEN; without both the feature is off and nothing is stored or asked.
//
// Where a preference is kept depends on the member's choice, asked once with two buttons on their first chat:
// - public: one memory shared by every server 小吉 is in (and direct messages);
// - private (also before they choose): a separate memory per server, and one for direct messages.
// A member can stop collection (and its use) at any time and delete everything (/memory). Only the member can read
// their own memory; the bot owner can read the shared memory of members who chose public (private extension), and
// every 168 hours receives what was added to the memory of every member, public or not, in one report
// (listMemoryAddedBetween, for the weeklyMemoryReport hook of an extension; see memoryReportSchedule.js).
//
// Nothing sensitive is kept: health, religion, politics, sexuality, real names, addresses, phone numbers, schools,
// accounts or passwords, other people, links, mentions and long numbers are refused before anything is written.

const { createFixedCodeLog } = require('./fixedCodeLog');
const { recordServiceOutcome, registerServiceConfiguration } = require('../../platform/serviceHealth');
const {
  INTERNAL_DATA_REPLACEMENT,
  containsInternalDisclosure,
  looksLikeInjectionAttempt,
  sanitizeAdmittedProviderData,
  sanitizeUntrustedText,
} = require('./disclosurePolicy');

const PREFERENCE_CATEGORIES = Object.freeze(['food', 'music', 'game', 'hobby', 'media', 'nickname', 'chat_style', 'other']);
const CATEGORY_LABELS = Object.freeze({
  food: '食物', music: '音樂', game: '遊戲', hobby: '興趣', media: '作品', nickname: '稱呼', chat_style: '聊天風格', other: '其他',
});
const MAX_PREFERENCE_LENGTH = 100;
// Per member and memory (shared, or one server); the least recently used goes first.
const MAX_PREFERENCES_PER_SCOPE = 30;
// A preference not used for a year is deleted.
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GLOBAL_SCOPE = 'global';
const DM_SCOPE = 'dm';

// Kept out of memory whatever the model asks. Plain alternatives of literal text: linear time.
const SENSITIVE_PREFERENCE = new RegExp([
  String.raw`健康|疾病|生病|病史|憂鬱|焦慮症|躁鬱|藥物|吃藥|服藥|醫院|看醫生|懷孕|殘障|身心障礙`,
  String.raw`宗教|信仰|基督|天主|佛教|道教|伊斯蘭|回教|教會|拜拜`,
  String.raw`政治|政黨|國民黨|民進黨|民眾黨|時代力量|投票給|支持.{0,4}(?:黨|候選人)`,
  String.raw`性向|同性戀|異性戀|雙性戀|跨性別|LGBT|性生活|性經驗`,
  String.raw`真名|本名|全名|姓名|名字叫|住址|地址|住在|家在|電話|手機|號碼|email|e-mail|信箱|學校|就讀|國小|國中|高中|大學|公司在|上班在`,
  String.raw`身分證|護照|帳號|帳戶|密碼|password|token|金鑰|卡號|銀行|存款|薪水|收入|生日|出生|年齡|幾歲`,
  String.raw`https?:|www\.|discord\.gg|<@|<#|@everyone|@here|\d{6,}`,
  // Names and homes in other words ("我叫…", "住台北"), and anything that reads as an instruction to 小吉 rather than a liking.
  String.raw`我叫|名叫|名字|本人是|住|搬到|老家|忽略|無視|規則|系統|指令|設定|提示|prompt|ignore|instruction|假裝|扮演|主人|擁有者|開發者|管理員|權限|越獄|模式`,
].join('|'), 'iu');

const log = createFixedCodeLog();
let configuredStore;
let storeOverride = null;
let lastPruneAt = 0;
// A store that does not answer in time is treated as unavailable, so a stuck connection cannot hold up a chat.
const DEFAULT_STORE_TIMEOUT_MS = 3000;
let storeTimeoutMs = DEFAULT_STORE_TIMEOUT_MS;

function withStoreTimeout(work) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Preference memory did not answer in time.'),
      { code: 'PREFERENCE_MEMORY_TIMEOUT' })), storeTimeoutMs);
    timer.unref?.();
  });
  // Every store call is an outcome for the status page (serviceHealth.js).
  return Promise.race([Promise.resolve().then(work), timeout])
    .then((value) => { recordServiceOutcome('memory_store', true); return value; },
      (error) => { recordServiceOutcome('memory_store', false); throw error; })
    .finally(() => clearTimeout(timer));
}

function scopeForGuild(guildId) {
  return guildId ? `guild:${guildId}` : DM_SCOPE;
}

function rowValue(row, name, index) {
  if (Array.isArray(row)) return row[index];
  return row?.[name];
}

// A store on Turso. createClientImpl is @libsql/client/web's createClient (HTTP only, no native code).
function createTursoMemoryStore({ url, authToken, createClientImpl } = {}) {
  const createClient = createClientImpl || require('@libsql/client/web').createClient;
  // Every HTTP request gives up after a few seconds (withStoreTimeout also stops waiting for it).
  const client = createClient({
    url,
    authToken,
    fetch: (resource, init = {}) => fetch(resource, { ...init, signal: AbortSignal.timeout(DEFAULT_STORE_TIMEOUT_MS + 2000) }),
  });
  let ready = null;
  const ensureSchema = () => {
    ready ||= client.batch([
      `CREATE TABLE IF NOT EXISTS xiaoji_memory_consent (
        user_id TEXT PRIMARY KEY, choice TEXT, collecting INTEGER NOT NULL DEFAULT 1, prompted_at INTEGER,
        updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS xiaoji_memory_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, scope TEXT NOT NULL, category TEXT NOT NULL,
        value TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS xiaoji_memory_preferences_user ON xiaoji_memory_preferences (user_id, scope)',
      // Channel memory (channelMemory.js): what members who chat with 小吉 say in servers, and 小吉's replies there.
      `CREATE TABLE IF NOT EXISTS xiaoji_memory_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL,
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL,
        author_name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS xiaoji_memory_messages_message ON xiaoji_memory_messages (message_id, role)',
      'CREATE INDEX IF NOT EXISTS xiaoji_memory_messages_channel ON xiaoji_memory_messages (guild_id, channel_id, created_at)',
      'CREATE INDEX IF NOT EXISTS xiaoji_memory_messages_user ON xiaoji_memory_messages (user_id, period, created_at)',
      `CREATE TABLE IF NOT EXISTS xiaoji_memory_usage (
        user_id TEXT NOT NULL, period TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (user_id, period, day))`,
      // The server food maps of /food (src/systems/food/foodGuide.js): places members recommend.
      `CREATE TABLE IF NOT EXISTS xiaoji_food_spots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
        area TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS xiaoji_food_spots_guild ON xiaoji_food_spots (guild_id, created_at)',
      // /stock watchlists (src/systems/stocks/watchlist.js): the symbols a member follows.
      `CREATE TABLE IF NOT EXISTS xiaoji_stock_watchlist (
        user_id TEXT NOT NULL, symbol TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, symbol))`,
      // Which revision of the memory notice each member has seen; a new revision asks everyone once more.
      `CREATE TABLE IF NOT EXISTS xiaoji_memory_prompts (
        user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, prompted_at INTEGER NOT NULL)`,
    ], 'write').catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  };
  const execute = async (sql, args = []) => {
    await ensureSchema();
    return client.execute({ sql, args });
  };
  const toPreference = (row) => ({
    id: Number(rowValue(row, 'id', 0)),
    scope: String(rowValue(row, 'scope', 1)),
    category: String(rowValue(row, 'category', 2)),
    value: String(rowValue(row, 'value', 3)),
    createdAt: Number(rowValue(row, 'created_at', 4)),
    lastUsedAt: Number(rowValue(row, 'last_used_at', 5)),
  });
  const COLUMNS = 'id, scope, category, value, created_at, last_used_at';
  const MESSAGE_COLUMNS = 'id, user_id, scope, guild_id, channel_id, role, author_name, content, created_at, message_id';
  const toMessage = (row) => ({
    id: Number(rowValue(row, 'id', 0)),
    userId: String(rowValue(row, 'user_id', 1)),
    scope: String(rowValue(row, 'scope', 2)),
    guildId: String(rowValue(row, 'guild_id', 3)),
    channelId: String(rowValue(row, 'channel_id', 4)),
    role: String(rowValue(row, 'role', 5)),
    authorName: String(rowValue(row, 'author_name', 6)),
    content: String(rowValue(row, 'content', 7)),
    createdAt: Number(rowValue(row, 'created_at', 8)),
    messageId: String(rowValue(row, 'message_id', 9)),
  });
  const toAddedPreference = (row) => ({
    id: Number(rowValue(row, 'id', 0)),
    userId: String(rowValue(row, 'user_id', 1)),
    scope: String(rowValue(row, 'scope', 2)),
    category: String(rowValue(row, 'category', 3)),
    value: String(rowValue(row, 'value', 4)),
    createdAt: Number(rowValue(row, 'created_at', 5)),
  });
  return Object.freeze({
    async getConsent(userId) {
      const result = await execute(
        'SELECT choice, collecting, prompted_at FROM xiaoji_memory_consent WHERE user_id = ?', [userId]);
      const row = result.rows?.[0];
      if (!row) return null;
      const choice = rowValue(row, 'choice', 0);
      const promptedAt = rowValue(row, 'prompted_at', 2);
      return {
        choice: choice === 'public' || choice === 'private' ? choice : null,
        collecting: Number(rowValue(row, 'collecting', 1)) !== 0,
        promptedAt: promptedAt === null || promptedAt === undefined ? null : Number(promptedAt),
      };
    },
    async saveConsent(userId, { choice, collecting, promptedAt }, now) {
      await execute(`INSERT INTO xiaoji_memory_consent (user_id, choice, collecting, prompted_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET choice = excluded.choice, collecting = excluded.collecting,
          prompted_at = excluded.prompted_at, updated_at = excluded.updated_at`,
      [userId, choice, collecting ? 1 : 0, promptedAt, now]);
    },
    async listPreferences(userId, scopes = null) {
      const result = scopes
        ? await execute(`SELECT ${COLUMNS} FROM xiaoji_memory_preferences WHERE user_id = ? AND scope IN (${
          scopes.map(() => '?').join(', ')}) ORDER BY last_used_at DESC, id DESC`, [userId, ...scopes])
        // The member's own list is ordered by when each was first kept, so its numbers do not move as chats use them.
        : await execute(`SELECT ${COLUMNS} FROM xiaoji_memory_preferences WHERE user_id = ? ORDER BY scope, id`, [userId]);
      return (result.rows || []).map(toPreference);
    },
    async addPreference(userId, scope, category, value, now) {
      const existing = await execute(
        'SELECT id FROM xiaoji_memory_preferences WHERE user_id = ? AND scope = ? AND value = ?', [userId, scope, value]);
      if (existing.rows?.length) {
        await execute('UPDATE xiaoji_memory_preferences SET category = ?, last_used_at = ? WHERE id = ?',
          [category, now, rowValue(existing.rows[0], 'id', 0)]);
        return;
      }
      await execute(`INSERT INTO xiaoji_memory_preferences (user_id, scope, category, value, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [userId, scope, category, value, now, now]);
      await execute(`DELETE FROM xiaoji_memory_preferences WHERE user_id = ? AND scope = ? AND id NOT IN (
        SELECT id FROM xiaoji_memory_preferences WHERE user_id = ? AND scope = ?
        ORDER BY last_used_at DESC, id DESC LIMIT ?)`, [userId, scope, userId, scope, MAX_PREFERENCES_PER_SCOPE]);
    },
    async touchPreferences(userId, ids, now) {
      if (!ids.length) return;
      await execute(`UPDATE xiaoji_memory_preferences SET last_used_at = ? WHERE user_id = ? AND id IN (${
        ids.map(() => '?').join(', ')})`, [now, userId, ...ids]);
    },
    async deletePreference(userId, id) {
      const result = await execute('DELETE FROM xiaoji_memory_preferences WHERE user_id = ? AND id = ?', [userId, id]);
      return Number(result.rowsAffected) > 0;
    },
    async deleteAllPreferences(userId) {
      const result = await execute('DELETE FROM xiaoji_memory_preferences WHERE user_id = ?', [userId]);
      return Number(result.rowsAffected) || 0;
    },
    async pruneInactive(before) {
      await execute('DELETE FROM xiaoji_memory_preferences WHERE last_used_at < ?', [before]);
    },
    async countFoodSpots(guildId) {
      const result = await execute('SELECT COUNT(*) AS n FROM xiaoji_food_spots WHERE guild_id = ?', [guildId]);
      return Number(rowValue(result.rows?.[0], 'n', 0)) || 0;
    },
    async addFoodSpot({ guildId, userId, name, area, kind, note, createdAt }) {
      const result = await execute(`INSERT INTO xiaoji_food_spots (guild_id, user_id, name, area, kind, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [guildId, userId, name, area, kind, note, createdAt]);
      return { id: Number(rowValue(result.rows?.[0], 'id', 0)), guildId, userId, name, area, kind, note, createdAt };
    },
    async listFoodSpots(guildId, { area = '', kind = '' } = {}) {
      const result = await execute(`SELECT id, user_id, name, area, kind, note, created_at FROM xiaoji_food_spots
        WHERE guild_id = ? AND (? = '' OR area LIKE '%' || ? || '%') AND (? = '' OR kind LIKE '%' || ? || '%')
        ORDER BY created_at DESC, id DESC LIMIT 50`, [guildId, area, area, kind, kind]);
      return (result.rows || []).map((row) => ({
        id: Number(rowValue(row, 'id', 0)), userId: String(rowValue(row, 'user_id', 1)), name: String(rowValue(row, 'name', 2)),
        area: String(rowValue(row, 'area', 3)), kind: String(rowValue(row, 'kind', 4)), note: String(rowValue(row, 'note', 5)),
        createdAt: Number(rowValue(row, 'created_at', 6)),
      }));
    },
    async getFoodSpot(guildId, id) {
      const result = await execute('SELECT id, user_id FROM xiaoji_food_spots WHERE guild_id = ? AND id = ?', [guildId, id]);
      const row = result.rows?.[0];
      return row ? { id: Number(rowValue(row, 'id', 0)), userId: String(rowValue(row, 'user_id', 1)) } : null;
    },
    async deleteFoodSpot(guildId, id) {
      await execute('DELETE FROM xiaoji_food_spots WHERE guild_id = ? AND id = ?', [guildId, id]);
    },
    async listWatchlist(userId) {
      const result = await execute('SELECT symbol FROM xiaoji_stock_watchlist WHERE user_id = ? ORDER BY added_at, symbol', [userId]);
      return (result.rows || []).map((row) => String(rowValue(row, 'symbol', 0)));
    },
    async addToWatchlist(userId, symbol, now) {
      const result = await execute('INSERT OR IGNORE INTO xiaoji_stock_watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)',
        [userId, symbol, now]);
      return Number(result.rowsAffected) > 0;
    },
    async removeFromWatchlist(userId, symbol) {
      const result = await execute('DELETE FROM xiaoji_stock_watchlist WHERE user_id = ? AND symbol = ?', [userId, symbol]);
      return Number(result.rowsAffected) > 0;
    },
    async getPromptRevision(userId) {
      const result = await execute('SELECT revision FROM xiaoji_memory_prompts WHERE user_id = ?', [userId]);
      const row = result.rows?.[0];
      return row ? Number(rowValue(row, 'revision', 0)) : 0;
    },
    async savePromptRevision(userId, revision, now) {
      await execute(`INSERT INTO xiaoji_memory_prompts (user_id, revision, prompted_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET revision = excluded.revision, prompted_at = excluded.prompted_at`,
      [userId, revision, now]);
    },
    async usageByDay(userId, period) {
      const result = await execute('SELECT day, count FROM xiaoji_memory_usage WHERE user_id = ? AND period = ?', [userId, period]);
      return (result.rows || []).map((row) => ({ day: Number(rowValue(row, 'day', 0)), count: Number(rowValue(row, 'count', 1)) }));
    },
    // Adds one message; false when it was already kept (the same Discord message again). A member message is counted.
    async addMessage(entry) {
      const result = await execute(`INSERT OR IGNORE INTO xiaoji_memory_messages
        (period, user_id, scope, guild_id, channel_id, message_id, role, author_name, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [entry.period, entry.userId, entry.scope, entry.guildId, entry.channelId,
        entry.messageId, entry.role, entry.authorName, entry.content, entry.createdAt]);
      const added = Number(result.rowsAffected) > 0;
      if (added && entry.role === 'member') {
        await execute(`INSERT INTO xiaoji_memory_usage (user_id, period, day, count) VALUES (?, ?, ?, 1)
          ON CONFLICT (user_id, period, day) DO UPDATE SET count = count + 1`, [entry.userId, entry.period, entry.day]);
      }
      return added;
    },
    async listChannelMessages(guildId, channelId, period, limit) {
      const result = await execute(`SELECT ${MESSAGE_COLUMNS} FROM xiaoji_memory_messages
        WHERE guild_id = ? AND channel_id = ? AND period = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [guildId, channelId, period, limit]);
      return (result.rows || []).map(toMessage).reverse();
    },
    async listOwnMessages(userId, scopes, period, limit) {
      const result = await execute(`SELECT ${MESSAGE_COLUMNS} FROM xiaoji_memory_messages
        WHERE user_id = ? AND role = 'member' AND period = ? AND scope IN (${scopes.map(() => '?').join(', ')})
        ORDER BY created_at DESC, id DESC LIMIT ?`, [userId, period, ...scopes, limit]);
      return (result.rows || []).map(toMessage).reverse();
    },
    async countOwnMessages(userId, period) {
      const result = await execute(`SELECT COUNT(*) AS n FROM xiaoji_memory_messages
        WHERE user_id = ? AND role = 'member' AND period = ?`, [userId, period]);
      return Number(rowValue(result.rows?.[0], 'n', 0)) || 0;
    },
    async deleteOwnMessages(userId) {
      const result = await execute('DELETE FROM xiaoji_memory_messages WHERE user_id = ?', [userId]);
      return Number(result.rowsAffected) || 0;
    },
    // Everything of an earlier month: its messages and its counts.
    async deleteMessagesBefore(period) {
      await execute('DELETE FROM xiaoji_memory_messages WHERE period < ?', [period]);
      await execute('DELETE FROM xiaoji_memory_usage WHERE period < ?', [period]);
    },
    // What every member added in [since, until), oldest first, at most limit of each kind.
    async listPreferencesAddedBetween(since, until, limit) {
      const result = await execute(`SELECT id, user_id, scope, category, value, created_at FROM xiaoji_memory_preferences
        WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id LIMIT ?`, [since, until, limit]);
      return (result.rows || []).map(toAddedPreference);
    },
    async listMessagesAddedBetween(since, until, limit) {
      const result = await execute(`SELECT ${MESSAGE_COLUMNS} FROM xiaoji_memory_messages
        WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id LIMIT ?`, [since, until, limit]);
      return (result.rows || []).map(toMessage);
    },
  });
}

// The same interface in memory, for tests and local runs.
function createInMemoryMemoryStore() {
  const consents = new Map();
  let preferences = [];
  let nextId = 1;
  const prompts = new Map();
  const watchlists = new Map();
  let foodSpots = [];
  let nextFoodSpotId = 1;
  const usage = new Map();
  let messages = [];
  let nextMessageId = 1;
  const byTime = (a, b) => a.createdAt - b.createdAt || a.id - b.id;
  const publicMessage = ({ id, userId, scope, guildId, channelId, role, authorName, content, createdAt, messageId }) =>
    ({ id, userId, scope, guildId, channelId, role, authorName, content, createdAt, messageId });
  const copy = (entry) => ({ ...entry });
  const order = (a, b) => b.lastUsedAt - a.lastUsedAt || b.id - a.id;
  return Object.freeze({
    async getConsent(userId) {
      return consents.has(userId) ? { ...consents.get(userId) } : null;
    },
    async saveConsent(userId, { choice, collecting, promptedAt }) {
      consents.set(userId, { choice: choice ?? null, collecting: Boolean(collecting), promptedAt: promptedAt ?? null });
    },
    async listPreferences(userId, scopes = null) {
      return preferences.filter((entry) => entry.userId === userId && (!scopes || scopes.includes(entry.scope)))
        .sort((a, b) => (scopes ? order(a, b) : a.scope.localeCompare(b.scope) || a.id - b.id))
        .map(({ userId: _owner, ...entry }) => copy(entry));
    },
    async addPreference(userId, scope, category, value, now) {
      const existing = preferences.find((entry) => entry.userId === userId && entry.scope === scope && entry.value === value);
      if (existing) {
        existing.category = category;
        existing.lastUsedAt = now;
        return;
      }
      preferences.push({ id: nextId++, userId, scope, category, value, createdAt: now, lastUsedAt: now });
      const kept = new Set(preferences.filter((entry) => entry.userId === userId && entry.scope === scope)
        .sort(order).slice(0, MAX_PREFERENCES_PER_SCOPE).map((entry) => entry.id));
      preferences = preferences.filter((entry) => entry.userId !== userId || entry.scope !== scope || kept.has(entry.id));
    },
    async touchPreferences(userId, ids, now) {
      for (const entry of preferences) if (entry.userId === userId && ids.includes(entry.id)) entry.lastUsedAt = now;
    },
    async deletePreference(userId, id) {
      const before = preferences.length;
      preferences = preferences.filter((entry) => entry.userId !== userId || entry.id !== id);
      return preferences.length < before;
    },
    async deleteAllPreferences(userId) {
      const before = preferences.length;
      preferences = preferences.filter((entry) => entry.userId !== userId);
      return before - preferences.length;
    },
    async pruneInactive(before) {
      preferences = preferences.filter((entry) => entry.lastUsedAt >= before);
    },
    async countFoodSpots(guildId) {
      return foodSpots.filter((spot) => spot.guildId === guildId).length;
    },
    async addFoodSpot(spot) {
      const entry = { ...spot, id: nextFoodSpotId++ };
      foodSpots.push(entry);
      return { ...entry };
    },
    async listFoodSpots(guildId, { area = '', kind = '' } = {}) {
      return foodSpots.filter((spot) => spot.guildId === guildId && (!area || spot.area.includes(area)) && (!kind || spot.kind.includes(kind)))
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id).slice(0, 50)
        .map(({ id, userId, name, area: place, kind: type, note, createdAt }) => ({ id, userId, name, area: place, kind: type, note, createdAt }));
    },
    async getFoodSpot(guildId, id) {
      const spot = foodSpots.find((entry) => entry.guildId === guildId && entry.id === id);
      return spot ? { id: spot.id, userId: spot.userId } : null;
    },
    async deleteFoodSpot(guildId, id) {
      foodSpots = foodSpots.filter((entry) => entry.guildId !== guildId || entry.id !== id);
    },
    async listWatchlist(userId) {
      return [...(watchlists.get(userId) || [])];
    },
    async addToWatchlist(userId, symbol) {
      const list = watchlists.get(userId) || [];
      if (list.includes(symbol)) return false;
      watchlists.set(userId, [...list, symbol]);
      return true;
    },
    async removeFromWatchlist(userId, symbol) {
      const list = watchlists.get(userId) || [];
      if (!list.includes(symbol)) return false;
      watchlists.set(userId, list.filter((entry) => entry !== symbol));
      return true;
    },
    async getPromptRevision(userId) {
      return prompts.get(userId) || 0;
    },
    async savePromptRevision(userId, revision) {
      prompts.set(userId, revision);
    },
    async usageByDay(userId, period) {
      return [...usage.entries()].filter(([key]) => key.startsWith(`${userId}|${period}|`))
        .map(([key, count]) => ({ day: Number(key.split('|')[2]), count }));
    },
    async addMessage(entry) {
      if (messages.some((row) => row.messageId === entry.messageId && row.role === entry.role)) return false;
      messages.push({ ...entry, id: nextMessageId++ });
      if (entry.role === 'member') {
        const key = `${entry.userId}|${entry.period}|${entry.day}`;
        usage.set(key, (usage.get(key) || 0) + 1);
      }
      return true;
    },
    async listChannelMessages(guildId, channelId, period, limit) {
      return messages.filter((row) => row.guildId === guildId && row.channelId === channelId && row.period === period)
        .sort(byTime).slice(-limit).map(publicMessage);
    },
    async listOwnMessages(userId, scopes, period, limit) {
      return messages.filter((row) => row.userId === userId && row.role === 'member' && row.period === period &&
        scopes.includes(row.scope)).sort(byTime).slice(-limit).map(publicMessage);
    },
    async countOwnMessages(userId, period) {
      return messages.filter((row) => row.userId === userId && row.role === 'member' && row.period === period).length;
    },
    async deleteOwnMessages(userId) {
      const before = messages.length;
      messages = messages.filter((row) => row.userId !== userId);
      return before - messages.length;
    },
    async deleteMessagesBefore(period) {
      messages = messages.filter((row) => row.period >= period);
      for (const key of [...usage.keys()]) if (key.split('|')[1] < period) usage.delete(key);
    },
    async listPreferencesAddedBetween(since, until, limit) {
      return preferences.filter((entry) => entry.createdAt >= since && entry.createdAt < until)
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).slice(0, limit)
        .map(({ id, userId, scope, category, value, createdAt }) => ({ id, userId, scope, category, value, createdAt }));
    },
    async listMessagesAddedBetween(since, until, limit) {
      return messages.filter((row) => row.createdAt >= since && row.createdAt < until)
        .sort(byTime).slice(0, limit).map(publicMessage);
    },
  });
}

function configureMemoryStoreForTests(store, { timeoutMs = DEFAULT_STORE_TIMEOUT_MS } = {}) {
  storeOverride = store;
  storeTimeoutMs = timeoutMs;
  lastPruneAt = 0;
}

function getMemoryStore() {
  if (storeOverride) return storeOverride;
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  // Only a Turso endpoint: never an arbitrary server or a local file named by the deployment.
  if (!url || !authToken || !/^(?:libsql|https):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.turso\.io\/?$/iu.test(url)) return null;
  configuredStore ||= createTursoMemoryStore({ url, authToken });
  return configuredStore;
}

function isMemoryConfigured() {
  return Boolean(getMemoryStore());
}

registerServiceConfiguration('memory_store', isMemoryConfigured);

function reportStoreFailure(error) {
  log.write('PREFERENCE_MEMORY_UNAVAILABLE', 'warn',
    `[PREFERENCE_MEMORY] code=PREFERENCE_MEMORY_UNAVAILABLE reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
}

// A member who never answered has the default: private, collecting, not yet asked.
function normalizeConsent(consent) {
  return {
    choice: consent?.choice === 'public' ? 'public' : consent?.choice === 'private' ? 'private' : null,
    collecting: consent ? consent.collecting !== false : true,
    promptedAt: consent?.promptedAt ?? null,
  };
}

function readableScopes(consent, guildId) {
  return consent.choice === 'public' ? [GLOBAL_SCOPE] : [scopeForGuild(guildId)];
}

function writableScope(consent, guildId) {
  return consent.choice === 'public' ? GLOBAL_SCOPE : scopeForGuild(guildId);
}

// One preference the model or the member asked to keep, cleaned; null when it must not be kept.
function acceptPreference(entry) {
  const category = PREFERENCE_CATEGORIES.includes(entry?.category) ? entry.category : 'other';
  const raw = sanitizeUntrustedText(entry?.preference ?? entry?.value ?? '').replace(/\s+/gu, ' ').trim();
  if (!raw || raw.length > MAX_PREFERENCE_LENGTH) return null;
  if (SENSITIVE_PREFERENCE.test(raw) || looksLikeInjectionAttempt(raw) || containsInternalDisclosure(raw)) return null;
  const admitted = sanitizeAdmittedProviderData(raw);
  if (!admitted || admitted !== raw || admitted.includes(INTERNAL_DATA_REPLACEMENT)) return null;
  return { category, value: raw };
}

async function maybePrune(store, now) {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  await store.pruneInactive(now - RETENTION_MS);
}

// What one AI reply may use and add. Any failure (no configuration, Turso unreachable) turns the memory off for this
// reply: the chat goes on, nothing is read or written.
async function loadMemoryContext({ userId, guildId = null, now = Date.now() } = {}) {
  const store = getMemoryStore();
  if (!store || !userId) return { available: false, enabled: false, preferences: [], consent: null };
  try {
    return await withStoreTimeout(async () => {
      await maybePrune(store, now);
      const consent = normalizeConsent(await store.getConsent(userId));
      if (!consent.collecting) return { available: true, enabled: false, preferences: [], consent };
      const preferences = await store.listPreferences(userId, readableScopes(consent, guildId));
      if (preferences.length) await store.touchPreferences(userId, preferences.map((entry) => entry.id), now);
      return {
        available: true,
        enabled: true,
        preferences: preferences.map(({ category, value }) => ({ category, value })),
        consent,
      };
    });
  } catch (error) {
    reportStoreFailure(error);
    return { available: false, enabled: false, preferences: [], consent: null };
  }
}

// Keeps what passes acceptPreference, where the member's choice says. Returns how many were kept.
async function rememberPreferences({ userId, guildId = null, entries = [], now = Date.now() } = {}) {
  const store = getMemoryStore();
  // Nothing said in direct messages is remembered.
  if (!store || !userId || !guildId) return 0;
  const accepted = entries.slice(0, 3).map(acceptPreference).filter(Boolean);
  if (!accepted.length) return 0;
  try {
    return await withStoreTimeout(async () => {
      const consent = normalizeConsent(await store.getConsent(userId));
      if (!consent.collecting) return 0;
      const scope = writableScope(consent, guildId);
      for (const entry of accepted) await store.addPreference(userId, scope, entry.category, entry.value, now);
      return accepted.length;
    });
  } catch (error) {
    reportStoreFailure(error);
    return 0;
  }
}

async function getPromptRevision(userId) {
  const store = getMemoryStore();
  if (!store) return null;
  return withStoreTimeout(() => store.getPromptRevision(userId));
}

async function savePromptRevision(userId, revision, now = Date.now()) {
  const store = getMemoryStore();
  if (!store) return;
  await withStoreTimeout(() => store.savePromptRevision(userId, revision, now));
}

async function getConsent(userId) {
  const store = getMemoryStore();
  if (!store) return null;
  return withStoreTimeout(async () => normalizeConsent(await store.getConsent(userId)));
}

async function updateConsent(userId, patch, now = Date.now()) {
  const store = getMemoryStore();
  if (!store) return null;
  return withStoreTimeout(async () => {
    const consent = { ...normalizeConsent(await store.getConsent(userId)), ...patch };
    await store.saveConsent(userId, consent, now);
    return consent;
  });
}

// Every preference of the member, in every memory: for the member's own view and copy.
async function listOwnPreferences(userId) {
  const store = getMemoryStore();
  if (!store) return null;
  return withStoreTimeout(() => store.listPreferences(userId));
}

async function forgetOwnPreference(userId, id) {
  const store = getMemoryStore();
  if (!store) return false;
  return withStoreTimeout(() => store.deletePreference(userId, id));
}

async function forgetAllOwnPreferences(userId) {
  const store = getMemoryStore();
  if (!store) return 0;
  return withStoreTimeout(() => store.deleteAllPreferences(userId));
}

// The shared memory of a member who chose public, for the bot owner; null for a member who did not.
async function listPublicPreferencesForOwner(userId) {
  const store = getMemoryStore();
  if (!store) return null;
  return withStoreTimeout(async () => {
    const consent = normalizeConsent(await store.getConsent(userId));
    if (consent.choice !== 'public') return null;
    return store.listPreferences(userId, [GLOBAL_SCOPE]);
  });
}

// The most rows of each kind one report reads.
const MEMORY_REPORT_ROW_LIMIT = 5000;
const MEMORY_REPORT_TIMEOUT_MS = 30_000;

// For the bot owner's weekly memory report (memoryReportSchedule.js): every preference and channel-memory message any
// member added in [since, until), whatever the member chose about sharing. null when the memory is off. truncated
// says a kind reached MEMORY_REPORT_ROW_LIMIT (the oldest are kept). A failure is thrown.
async function listMemoryAddedBetween({ since, until, limit = MEMORY_REPORT_ROW_LIMIT } = {}) {
  const store = getMemoryStore();
  if (!store) return null;
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) throw new RangeError('A report window is required.');
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Preference memory did not answer in time.'),
      { code: 'PREFERENCE_MEMORY_TIMEOUT' })), MEMORY_REPORT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const [preferences, messages] = await Promise.race([Promise.all([
      store.listPreferencesAddedBetween(since, until, limit),
      store.listMessagesAddedBetween(since, until, limit),
    ]), timeout]);
    return { preferences, messages, truncated: preferences.length >= limit || messages.length >= limit };
  } finally {
    clearTimeout(timer);
  }
}

function describeScope(scope, guildId) {
  if (scope === GLOBAL_SCOPE) return '所有伺服器共用';
  if (scope === DM_SCOPE) return '私訊';
  if (guildId && scope === scopeForGuild(guildId)) return '這個伺服器';
  return '其他伺服器';
}

module.exports = {
  CATEGORY_LABELS,
  DM_SCOPE,
  getMemoryStore,
  normalizeConsent,
  readableScopes,
  withStoreTimeout,
  writableScope,
  GLOBAL_SCOPE,
  MAX_PREFERENCES_PER_SCOPE,
  MEMORY_REPORT_ROW_LIMIT,
  PREFERENCE_CATEGORIES,
  RETENTION_MS,
  acceptPreference,
  configureMemoryStoreForTests,
  createInMemoryMemoryStore,
  createTursoMemoryStore,
  describeScope,
  forgetAllOwnPreferences,
  forgetOwnPreference,
  getConsent,
  getPromptRevision,
  isMemoryConfigured,
  listOwnPreferences,
  listMemoryAddedBetween,
  listPublicPreferencesForOwner,
  loadMemoryContext,
  rememberPreferences,
  savePromptRevision,
  scopeForGuild,
  updateConsent,
};
