const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
let configuredPathResolver = null;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function configureArchivePathResolver(resolveDataPath) {
  if (typeof resolveDataPath !== 'function') throw new Error('DataPaths resolver port is required.');
  configuredPathResolver = resolveDataPath;
}

function getArchivePath({ resolveDataPath = configuredPathResolver, env = process.env } = {}) {
  if (typeof resolveDataPath !== 'function') throw new Error('Archive DataPaths resolver port is not configured.');
  if (env.XIAOJI_ARCHIVE_DB_PATH && !path.isAbsolute(env.XIAOJI_ARCHIVE_DB_PATH)) {
    throw new Error('XIAOJI_ARCHIVE_DB_PATH must be absolute.');
  }
  const descriptor = resolveDataPath({ kind: 'archive', explicitEnvName: 'XIAOJI_ARCHIVE_DB_PATH',
    rootRelativePath: 'archive/conversations.sqlite', env });
  if (!descriptor || !path.isAbsolute(descriptor.filePath || '')) {
    throw new Error('Archive DataPaths resolver returned an invalid path.');
  }
  const archiveIdentity = process.platform === 'win32'
    ? path.resolve(descriptor.filePath).toLowerCase() : path.resolve(descriptor.filePath);
  for (const name of ['COIN_DB_PATH', 'AI_CONVERSATION_PATH', 'XIAOJI_MEMORY_PATH']) {
    if (!env[name]) continue;
    const identity = process.platform === 'win32'
      ? path.resolve(env[name]).toLowerCase() : path.resolve(env[name]);
    if (archiveIdentity === identity) throw new Error(`Archive path collides with ${name}.`);
  }
  return descriptor.filePath;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function contentText(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  return value;
}

function optionalId(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || typeof value === 'string' &&
    (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
      value.slice(0, 19) !== date.toISOString().slice(0, 19))) {
    throw new Error('A reliable timestamp is required.');
  }
  return date.toISOString();
}

function validateFilter(filter = {}) {
  const userId = requiredText(filter.userId, 'userId');
  const guildId = optionalId(filter.guildId);
  const channelId = optionalId(filter.channelId);
  const scope = filter.scope || (guildId ? 'guild' : 'all');
  if (!['all', 'dm', 'guild'].includes(scope) || scope === 'guild' && !guildId ||
    scope === 'dm' && guildId || scope === 'all' && guildId) throw new Error('Invalid archive scope.');
  const from = filter.from ? timestamp(filter.from) : null;
  const to = filter.to ? timestamp(filter.to) : null;
  if (from && to && from > to) throw new Error('Invalid time range.');
  return { userId, scope, guildId, channelId, from, to };
}

function filterSql(filter, { tableAlias = '' } = {}) {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const clauses = [`${prefix}user_id = ?`];
  const args = [filter.userId];
  if (filter.scope === 'dm') clauses.push(`${prefix}guild_id IS NULL`);
  if (filter.scope === 'guild') { clauses.push(`${prefix}guild_id = ?`); args.push(filter.guildId); }
  if (filter.channelId !== null) { clauses.push(`${prefix}channel_id = ?`); args.push(filter.channelId); }
  if (filter.from) { clauses.push(`${prefix}happened_at >= ?`); args.push(filter.from); }
  if (filter.to) { clauses.push(`${prefix}happened_at <= ?`); args.push(filter.to); }
  return { where: clauses.join(' AND '), args };
}

function createSchema(db, { allowCreate = false } = {}) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`Unsupported archive schema version: ${version}`);
  if (version === SCHEMA_VERSION) {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!['archive_identity', 'ai_events', 'public_messages', 'private_summaries', 'access_audit', 'deletion_receipts',
      'import_receipts', 'import_quarantine'].every((name) => names.has(name))) {
      throw new Error('Archive schema version does not match its tables.');
    }
    const eventColumns = new Set(db.prepare('PRAGMA table_info(ai_events)').all().map((row) => row.name));
    if (!eventColumns.has('delivery_state')) throw new Error('Archive delivery schema is missing.');
    return;
  }
  if (!allowCreate) throw new Error('Uninitialized archive cannot be opened as an active archive.');
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  if (existing.length) throw new Error('Unversioned archive already contains tables.');
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE archive_identity (
      generation TEXT PRIMARY KEY, receipt_hash TEXT NOT NULL, initialized_at TEXT NOT NULL
    );
    CREATE TABLE ai_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, interaction_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('received','pending','partial','delivered','unverified_legacy')),
      user_id TEXT NOT NULL, guild_id TEXT, channel_id TEXT NOT NULL,
      happened_at TEXT NOT NULL, content TEXT NOT NULL, source_id TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('live','legacy'))
    );
    CREATE INDEX ai_events_scope_time ON ai_events(user_id, guild_id, channel_id, happened_at DESC, id DESC);
    CREATE INDEX ai_events_interaction ON ai_events(interaction_key);
    CREATE TABLE public_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, happened_at TEXT NOT NULL,
      content TEXT NOT NULL, source_id TEXT, origin TEXT NOT NULL CHECK (origin IN ('live','legacy'))
    );
    CREATE INDEX public_messages_scope_time ON public_messages(user_id, guild_id, channel_id, happened_at DESC, id DESC);
    CREATE TABLE private_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary_key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      guild_id TEXT, channel_id TEXT, happened_at TEXT NOT NULL,
      user_summary TEXT NOT NULL, assistant_summary TEXT NOT NULL,
      correction_version INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL CHECK (origin IN ('live','legacy'))
    );
    CREATE INDEX private_summaries_scope_time ON private_summaries(user_id, guild_id, channel_id, happened_at DESC, id DESC);
    CREATE TABLE access_audit (
      id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, scope_hash TEXT NOT NULL,
      operation TEXT NOT NULL, row_count INTEGER NOT NULL, happened_at TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE deletion_receipts (
      receipt_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, scope_hash TEXT NOT NULL,
      row_count INTEGER NOT NULL, happened_at TEXT NOT NULL
    );
    CREATE TABLE import_receipts (
      source_hash TEXT NOT NULL, source_kind TEXT NOT NULL,
      imported_count INTEGER NOT NULL, quarantined_count INTEGER NOT NULL,
      happened_at TEXT NOT NULL, PRIMARY KEY(source_hash, source_kind)
    );
    CREATE TABLE import_quarantine (
      source_hash TEXT NOT NULL, source_kind TEXT NOT NULL, position_hash TEXT NOT NULL,
      reason TEXT NOT NULL, PRIMARY KEY(source_hash, source_kind, position_hash)
    );
    PRAGMA user_version = 1;
    COMMIT;
  `);
}

let savepointSequence = 0;
function transaction(db, work) {
  const nested = db.isTransaction;
  const savepoint = `archive_nested_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    else db.exec('ROLLBACK');
    throw error;
  }
}

function appendJournal(filePath, entry) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(entry)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function readJournal(filePath, expectedGeneration = null) {
  if (!fs.existsSync(filePath)) throw new Error('Archive deletion journal is missing.');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive deletion journal must be a regular file.');
  const [headerLine, ...entryLines] = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(headerLine || 'null');
  if (header?.version !== 1 || header.type !== 'header' ||
    !/^[a-f0-9-]{36}$/.test(header.generation || '') ||
    expectedGeneration && header.generation !== expectedGeneration) {
    throw new Error('Archive deletion journal generation mismatch.');
  }
  return entryLines.map((line) => {
    const entry = JSON.parse(line);
    if (entry.version !== 1 || entry.generation !== header.generation ||
      !SHA256.test(entry.receiptId) || !entry.actorId) {
      throw new Error('Archive deletion journal is invalid.');
    }
    if (!entry.maxIds || ['ai_events', 'public_messages', 'private_summaries'].some((name) =>
      !Number.isSafeInteger(entry.maxIds[name]) || entry.maxIds[name] < 0)) {
      throw new Error('Archive deletion journal high-water mark is invalid.');
    }
    entry.filter = validateFilter(entry.filter);
    timestamp(entry.happenedAt);
    return entry;
  });
}

function readIdentity(filePath, { expectedKind = 'active' } = {}) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error('Archive identity receipt is missing.'); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive identity receipt must be a regular file.');
  const identity = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (identity.kind !== expectedKind) throw new Error('Archive snapshot cannot be opened as an active archive.');
  if (identity.schemaVersion !== SCHEMA_VERSION ||
    !/^[a-f0-9-]{36}$/.test(identity.generation || '') ||
    !SHA256.test(identity.receiptHash || '')) throw new Error('Archive identity receipt is invalid.');
  return identity;
}

const CONTENT_TABLES = ['ai_events', 'public_messages', 'private_summaries'];

function deletionHighWaterMarks(db) {
  return Object.fromEntries(CONTENT_TABLES.map((table) => [table,
    Number(db.prepare(`SELECT COALESCE(MAX(id), 0) AS highest FROM ${table}`).get().highest)]));
}

function deleteMatching(db, filter, journalEntry = null) {
  const { where, args } = filterSql(filter);
  let count = 0;
  for (const table of CONTENT_TABLES) {
    const replayClause = journalEntry
      ? " AND (happened_at < ? OR (happened_at = ? AND origin = 'legacy') OR id <= ?)" : '';
    const parameters = journalEntry
      ? [...args, journalEntry.happenedAt, journalEntry.happenedAt, journalEntry.maxIds[table]] : args;
    count += Number(db.prepare(`DELETE FROM ${table} WHERE ${where}${replayClause}`).run(...parameters).changes);
    if (journalEntry && journalEntry.maxIds[table] > 0) {
      db.prepare('INSERT INTO sqlite_sequence(name,seq) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name=?)')
        .run(table, journalEntry.maxIds[table], table);
      db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(journalEntry.maxIds[table], table);
    }
  }
  return count;
}

function openArchive({ filePath = getArchivePath(), initialize = null } = {}) {
  if (!path.isAbsolute(filePath)) throw new Error('Archive path must be absolute.');
  const resolved = path.resolve(filePath);
  const journalPath = `${resolved}.deletions.jsonl`;
  const identityPath = `${resolved}.identity.json`;
  let databaseStat = null;
  try { databaseStat = fs.lstatSync(resolved); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const newDatabase = !databaseStat;
  if (newDatabase && !initialize) throw new Error('Archive database is missing; explicit initialization is required.');
  if (!newDatabase && initialize) throw new Error('Archive database already exists; initialization is forbidden.');
  if (databaseStat && (!databaseStat.isFile() || databaseStat.isSymbolicLink())) {
    throw new Error('Archive database must be a regular file.');
  }
  if (newDatabase && (fs.existsSync(journalPath) || fs.existsSync(identityPath))) {
    throw new Error('Archive database is missing while an identity or deletion receipt exists. Restore under controlled procedure.');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved, { timeout: 5000 });
  let closed = false;
  let archiveIdentity;
  function close() {
    if (!closed) { db.close(); closed = true; }
  }
  let journalEntries;
  try {
    createSchema(db, { allowCreate: newDatabase });
    if (newDatabase) {
      const generation = crypto.randomUUID();
      const receiptHash = hash(requiredText(initialize.initializationId, 'initializationId'));
      db.prepare('INSERT INTO archive_identity VALUES (?,?,?)').run(generation, receiptHash, new Date().toISOString());
      fs.writeFileSync(identityPath,
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: 'active', generation, receiptHash })}\n`,
        { flag: 'wx', mode: 0o600 });
    }
    archiveIdentity = readIdentity(identityPath);
    const databaseIdentity = db.prepare('SELECT generation, receipt_hash FROM archive_identity LIMIT 1').get();
    if (!databaseIdentity || databaseIdentity.generation !== archiveIdentity.generation ||
      databaseIdentity.receipt_hash !== archiveIdentity.receiptHash) throw new Error('Archive generation or initialization receipt mismatch.');
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
    if (newDatabase) fs.writeFileSync(journalPath,
      `${JSON.stringify({ version: 1, type: 'header', generation: archiveIdentity.generation })}\n`,
      { flag: 'wx', mode: 0o600 });
    journalEntries = readJournal(journalPath, archiveIdentity.generation);
    const journalIds = new Set(journalEntries.map((entry) => entry.receiptId));
    const priorDeletes = db.prepare('SELECT receipt_id FROM deletion_receipts').all();
    if (priorDeletes.some((entry) => !journalIds.has(entry.receipt_id))) {
      throw new Error('Archive deletion journal is missing or incomplete.');
    }
    for (const entry of journalEntries) {
      transaction(db, () => {
        if (db.prepare('SELECT 1 FROM deletion_receipts WHERE receipt_id = ?').get(entry.receiptId)) return;
        const count = deleteMatching(db, entry.filter, entry);
        db.prepare('INSERT INTO deletion_receipts VALUES (?, ?, ?, ?, ?)').run(
          entry.receiptId, entry.actorId, hash(JSON.stringify(entry.filter)), count, entry.happenedAt
        );
      });
    }
  } catch (error) { close(); throw error; }

  function isDeletedByJournal({ userId, guildId, channelId, happenedAt, origin }) {
    return journalEntries.some(({ filter, happenedAt: deletedAt }) =>
      filter.userId === userId && (filter.scope === 'all' ||
        filter.scope === 'dm' && guildId === null || filter.scope === 'guild' && filter.guildId === guildId) &&
      (filter.channelId === null || filter.channelId === channelId) &&
      (!filter.from || happenedAt >= filter.from) && (!filter.to || happenedAt <= filter.to) &&
      (happenedAt < deletedAt || origin === 'legacy' && happenedAt === deletedAt));
  }

  function appendInteraction({ interactionKey, userId, guildId = null, channelId, happenedAt,
    userContent, assistantContent, sourceId = null, origin = 'live' }) {
    const key = requiredText(interactionKey, 'interactionKey');
    const scope = { userId: requiredText(userId, 'userId'), guildId: optionalId(guildId),
      channelId: requiredText(channelId, 'channelId'), happenedAt: timestamp(happenedAt) };
    const user = contentText(userContent, 'userContent');
    const assistant = contentText(assistantContent, 'assistantContent');
    if (isDeletedByJournal({ ...scope, origin })) return { persisted: false, reason: 'deleted_scope' };
    return transaction(db, () => {
      const insert = db.prepare(`INSERT INTO ai_events
        (event_key,interaction_key,role,delivery_state,user_id,guild_id,channel_id,happened_at,content,source_id,origin)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`);
      const rows = [
        ['user', user], ['assistant', assistant],
      ];
      let inserted = 0;
      for (const [role, content] of rows) {
        const eventKey = hash(`${key}:${role}`);
        const prior = db.prepare('SELECT content, user_id, guild_id, channel_id, happened_at, origin FROM ai_events WHERE event_key = ?').get(eventKey);
        if (prior && (prior.content !== content || prior.user_id !== scope.userId || prior.guild_id !== scope.guildId ||
          prior.channel_id !== scope.channelId || prior.happened_at !== scope.happenedAt || prior.origin !== origin)) {
          throw new Error('Archive event identity conflict.');
        }
        const deliveryState = role === 'user' ? 'received' : origin === 'legacy' ? 'unverified_legacy' : 'pending';
        inserted += Number(insert.run(eventKey, key, role, deliveryState, scope.userId, scope.guildId, scope.channelId,
          scope.happenedAt, content, optionalId(sourceId), origin).changes);
      }
      return { persisted: true, inserted };
    });
  }

  function appendPublicMessage({ messageId, userId, guildId, channelId, happenedAt, content, origin = 'live' }) {
    const scope = { userId: requiredText(userId, 'userId'), guildId: requiredText(guildId, 'guildId'),
      channelId: requiredText(channelId, 'channelId'), happenedAt: timestamp(happenedAt) };
    const body = requiredText(content, 'content');
    const eventKey = hash(`public:${requiredText(messageId, 'messageId')}`);
    if (isDeletedByJournal({ ...scope, origin })) return { persisted: false, reason: 'deleted_scope' };
    return transaction(db, () => {
      const prior = db.prepare('SELECT content, user_id, guild_id, channel_id, happened_at, origin FROM public_messages WHERE event_key = ?').get(eventKey);
      if (prior && (prior.content !== body || prior.user_id !== scope.userId || prior.guild_id !== scope.guildId ||
        prior.channel_id !== scope.channelId || prior.happened_at !== scope.happenedAt || prior.origin !== origin)) {
        throw new Error('Public message identity conflict.');
      }
      const inserted = db.prepare(`INSERT INTO public_messages
        (event_key,user_id,guild_id,channel_id,happened_at,content,source_id,origin)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).run(
        eventKey, scope.userId, scope.guildId, scope.channelId, scope.happenedAt,
        body, messageId, origin).changes;
      return { persisted: true, inserted: Number(inserted) };
    });
  }

  function appendSummary({ summaryKey, userId, guildId = null, channelId = null, happenedAt,
    userSummary = '', assistantSummary = '', origin = 'live' }) {
    const scope = { userId: requiredText(userId, 'userId'), guildId: optionalId(guildId),
      channelId: optionalId(channelId), happenedAt: timestamp(happenedAt) };
    if (isDeletedByJournal({ ...scope, origin })) return { persisted: false, reason: 'deleted_scope' };
    const key = hash(requiredText(summaryKey, 'summaryKey'));
    return transaction(db, () => {
      const prior = db.prepare('SELECT * FROM private_summaries WHERE summary_key = ?').get(key);
      if (prior && ((prior.correction_version === 0 &&
        (prior.user_summary !== userSummary || prior.assistant_summary !== assistantSummary)) ||
        prior.user_id !== scope.userId || prior.guild_id !== scope.guildId ||
        prior.channel_id !== scope.channelId || prior.happened_at !== scope.happenedAt || prior.origin !== origin)) {
        throw new Error('Summary identity conflict.');
      }
      const inserted = db.prepare(`INSERT INTO private_summaries
        (summary_key,user_id,guild_id,channel_id,happened_at,user_summary,assistant_summary,origin)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(summary_key) DO NOTHING`).run(
        key, scope.userId, scope.guildId, scope.channelId, scope.happenedAt,
        String(userSummary), String(assistantSummary), origin).changes;
      return { persisted: true, inserted: Number(inserted) };
    });
  }

  function markDeliveredAndSummary({ interactionKey, summary }) {
    const key = requiredText(interactionKey, 'interactionKey');
    const eventKey = hash(`${key}:assistant`);
    return transaction(db, () => {
      const assistant = db.prepare('SELECT * FROM ai_events WHERE event_key = ?').get(eventKey);
      if (!assistant || assistant.origin !== 'live' ||
        !['pending', 'delivered'].includes(assistant.delivery_state)) throw new Error('Assistant delivery cannot be confirmed.');
      if (summary?.summaryKey !== key || summary.userId !== assistant.user_id ||
        optionalId(summary.guildId) !== assistant.guild_id ||
        optionalId(summary.channelId) !== assistant.channel_id ||
        timestamp(summary.happenedAt) !== assistant.happened_at) {
        throw new Error('Assistant delivery summary scope does not match the raw event.');
      }
      if (assistant.delivery_state === 'pending') {
        db.prepare("UPDATE ai_events SET delivery_state = 'delivered' WHERE event_key = ?").run(eventKey);
      }
      const projected = appendSummary(summary);
      if (!projected.persisted) throw new Error(`Archive rejected summary: ${projected.reason}`);
      return { persisted: true, summaryInserted: projected.inserted };
    });
  }

  function markPartialDelivery(interactionKey) {
    const eventKey = hash(`${requiredText(interactionKey, 'interactionKey')}:assistant`);
    return Number(db.prepare("UPDATE ai_events SET delivery_state = 'partial' WHERE event_key = ? AND delivery_state = 'pending'")
      .run(eventKey).changes);
  }

  function listEvents(filter, { kind = 'ai', limit = 20, cursor = null } = {}) {
    const scope = validateFilter(filter);
    if (!['ai', 'public', 'summary'].includes(kind)) throw new Error('Invalid archive kind.');
    const size = Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 25) throw new Error('Invalid page limit.');
    const table = { ai: 'ai_events', public: 'public_messages', summary: 'private_summaries' }[kind];
    const { where, args } = filterSql(scope);
    let cursorSql = '';
    if (cursor !== null) {
      if (!Number.isSafeInteger(cursor) || cursor <= 0) throw new Error('Invalid cursor.');
      cursorSql = ' AND id < ?'; args.push(cursor);
    }
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}${cursorSql} ORDER BY id DESC LIMIT ?`).all(...args, size + 1);
    const page = rows.slice(0, size);
    return { rows: page, nextCursor: rows.length > size ? Number(page.at(-1).id) : null };
  }

  function listRecentSummaries(userId, limit = 12) {
    const owner = requiredText(userId, 'userId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('Invalid summary limit.');
    return db.prepare(`SELECT * FROM private_summaries WHERE user_id = ?
      ORDER BY happened_at DESC, id DESC LIMIT ?`).all(owner, limit);
  }

  function correctSummary({ summaryId, userId, userSummary, assistantSummary }) {
    if (!Number.isSafeInteger(summaryId) || summaryId <= 0) throw new Error('Invalid summary ID.');
    const owner = requiredText(userId, 'userId');
    return transaction(db, () => Number(db.prepare(`UPDATE private_summaries SET
      user_summary = ?, assistant_summary = ?, correction_version = correction_version + 1
      WHERE id = ? AND user_id = ?`).run(
      String(userSummary), String(assistantSummary), summaryId, owner).changes));
  }

  function auditAccess({ actorId, filter, operation, rowCount, result, happenedAt = new Date() }) {
    const scope = validateFilter(filter);
    db.prepare('INSERT INTO access_audit (actor_id,scope_hash,operation,row_count,happened_at,result) VALUES (?,?,?,?,?,?)').run(
      requiredText(actorId, 'actorId'), hash(JSON.stringify(scope)), requiredText(operation, 'operation'),
      Number(rowCount), timestamp(happenedAt), requiredText(result, 'result'));
  }

  function deleteScope({ actorId, filter, happenedAt = new Date() }) {
    const scope = validateFilter(filter);
    const at = timestamp(happenedAt);
    const receiptId = hash(JSON.stringify([requiredText(actorId, 'actorId'), scope, at, crypto.randomUUID()]));
    const maxIds = deletionHighWaterMarks(db);
    const entry = { version: 1, generation: archiveIdentity.generation,
      receiptId, actorId, filter: scope, happenedAt: at, maxIds };
    appendJournal(journalPath, entry);
    journalEntries.push(entry);
    try {
      return transaction(db, () => {
        const count = deleteMatching(db, scope);
        db.prepare('INSERT INTO deletion_receipts VALUES (?,?,?,?,?)').run(receiptId, actorId,
          hash(JSON.stringify(scope)), count, at);
        db.prepare('INSERT INTO access_audit (actor_id,scope_hash,operation,row_count,happened_at,result) VALUES (?,?,?,?,?,?)').run(
          actorId, hash(JSON.stringify(scope)), 'delete', count, at, 'applied');
        return { receiptId, deleted: count };
      });
    } catch (error) {
      close();
      throw error;
    }
  }

  function assertWritable() {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return true;
  }

  function importLegacyConversation(filePath) {
    if (!path.isAbsolute(filePath)) throw new Error('Legacy source path must be absolute.');
    const bytes = fs.readFileSync(filePath);
    const sourceHash = hash(bytes);
    const sourceKind = 'conversation-v1';
    const prior = db.prepare('SELECT * FROM import_receipts WHERE source_hash = ? AND source_kind = ?').get(sourceHash, sourceKind);
    if (prior) return { imported: 0, quarantined: prior.quarantined_count, replayed: true };
    if (db.prepare('SELECT 1 FROM deletion_receipts LIMIT 1').get()) {
      throw new Error('New legacy import is blocked after a deletion; manual reconciliation is required.');
    }
    const data = JSON.parse(bytes.toString('utf8'));
    if (data?.version !== 1 || !data.conversations || typeof data.conversations !== 'object' || Array.isArray(data.conversations)) {
      throw new Error('Invalid legacy conversation source.');
    }
    let imported = 0; let quarantined = 0;
      const quarantine = db.prepare('INSERT OR IGNORE INTO import_quarantine VALUES (?,?,?,?)');
      for (const [key, conversation] of Object.entries(data.conversations)) {
        if (!Array.isArray(conversation?.turns)) {
          quarantine.run(sourceHash, sourceKind, hash(key), 'invalid_conversation'); quarantined += 1; continue;
        }
        for (const [index, turn] of conversation.turns.entries()) {
          const position = `${key}:${index}`;
          try {
            const userId = requiredText(conversation.userId, 'userId');
            const channelId = requiredText(conversation.channelId, 'channelId');
            const sourceGuild = requiredText(conversation.guildId, 'guildId');
            if (key !== `${sourceGuild}:${channelId}:${userId}`) throw new Error('source_identity_mismatch');
            const guildId = optionalId(conversation.guildId) === 'dm' ? null : optionalId(conversation.guildId);
            const at = timestamp(turn.createdAt);
            if (typeof turn.user !== 'string' || typeof turn.assistant !== 'string') throw new Error('invalid_turn');
            const result = appendInteraction({ interactionKey: `legacy:${sourceHash}:${position}`,
              userId, guildId, channelId, happenedAt: at, userContent: turn.user,
              assistantContent: turn.assistant, sourceId: null, origin: 'legacy' });
            imported += result.inserted || 0;
          } catch (_error) {
            quarantine.run(sourceHash, sourceKind, hash(position), 'invalid_or_deleted_turn'); quarantined += 1;
          }
        }
      }
    db.prepare('INSERT INTO import_receipts VALUES (?,?,?,?,?)').run(sourceHash, sourceKind, imported, quarantined, new Date().toISOString());
    return { imported, quarantined, replayed: false };
  }

  function importLegacyMemory(filePath) {
    if (!path.isAbsolute(filePath)) throw new Error('Legacy source path must be absolute.');
    const bytes = fs.readFileSync(filePath);
    const sourceHash = hash(bytes);
    const sourceKind = 'memory-v1';
    const prior = db.prepare('SELECT * FROM import_receipts WHERE source_hash = ? AND source_kind = ?').get(sourceHash, sourceKind);
    if (prior) return { imported: 0, quarantined: prior.quarantined_count, replayed: true };
    if (db.prepare('SELECT 1 FROM deletion_receipts LIMIT 1').get()) {
      throw new Error('New legacy import is blocked after a deletion; manual reconciliation is required.');
    }
    const data = JSON.parse(bytes.toString('utf8'));
    if (!data || typeof data.private_user_memory !== 'object' || typeof data.public_channel_memory !== 'object') {
      throw new Error('Invalid legacy memory source.');
    }
    let imported = 0; let quarantined = 0;
    const quarantine = db.prepare('INSERT OR IGNORE INTO import_quarantine VALUES (?,?,?,?)');
    const invalid = (position, reason) => {
      quarantine.run(sourceHash, sourceKind, hash(position), reason);
      quarantined += 1;
    };
    for (const [userId, records] of Object.entries(data.private_user_memory)) {
      if (!Array.isArray(records)) { invalid(`private:${userId}`, 'invalid_record_list'); continue; }
      for (const [index, record] of records.entries()) {
        const position = `private:${userId}:${index}`;
        try {
          if (record.userId !== userId || !record.channelId || typeof record.userContentSummary !== 'string' ||
            typeof record.assistantContentSummary !== 'string') throw new Error('invalid_summary');
          const result = appendSummary({ summaryKey: `legacy:${sourceHash}:${position}`, userId,
            guildId: record.guildId, channelId: record.channelId, happenedAt: record.timestamp,
            userSummary: record.userContentSummary, assistantSummary: record.assistantContentSummary,
            origin: 'legacy' });
          imported += result.inserted || 0;
        } catch (_error) { invalid(position, 'invalid_or_deleted_summary'); }
      }
    }
    for (const [guildId, records] of Object.entries(data.public_channel_memory)) {
      if (!Array.isArray(records)) { invalid(`public:${guildId}`, 'invalid_record_list'); continue; }
      for (const [index, record] of records.entries()) {
        const position = `public:${guildId}:${index}`;
        try {
          if (record.guildId !== guildId || typeof record.originalContent !== 'string') throw new Error('invalid_public_record');
          const result = appendPublicMessage({ messageId: `legacy:${sourceHash}:${position}`,
            userId: record.userId, guildId, channelId: record.channelId,
            happenedAt: record.timestamp, content: record.originalContent, origin: 'legacy' });
          imported += result.inserted || 0;
        } catch (_error) { invalid(position, 'invalid_or_deleted_public_record'); }
      }
    }
    db.prepare('INSERT INTO import_receipts VALUES (?,?,?,?,?)').run(sourceHash, sourceKind, imported, quarantined, new Date().toISOString());
    return { imported, quarantined, replayed: false };
  }

  async function backupTo(destination) {
    if (!path.isAbsolute(destination)) throw new Error('Backup path must be absolute.');
    if (fs.existsSync(destination) || fs.existsSync(`${destination}.deletions.jsonl`) ||
      fs.existsSync(`${destination}.identity.json`)) {
      throw new Error('Backup destination already exists.');
    }
    await backup(db, destination);
    try {
      fs.copyFileSync(journalPath, `${destination}.deletions.jsonl`, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(`${destination}.identity.json`,
        `${JSON.stringify({ ...archiveIdentity, kind: 'snapshot' })}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new Error(`Backup deletion journal was not copied: ${error.message}`);
    }
    return { databasePath: destination, deletionJournalPath: `${destination}.deletions.jsonl`,
      identityPath: `${destination}.identity.json` };
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION, filePath: resolved, journalPath, identityPath,
    assertWritable, appendInteraction, markDeliveredAndSummary, markPartialDelivery,
    appendPublicMessage, appendSummary, listEvents, correctSummary, auditAccess,
    deleteScope, importLegacyConversation, importLegacyMemory, backupTo, listRecentSummaries,
    close,
  });
}

function initializeArchive({ filePath = getArchivePath(), initializationId } = {}) {
  return openArchive({ filePath, initialize: { initializationId: requiredText(initializationId, 'initializationId') } });
}

function restoreArchiveBackup(options = {}) {
  const { backupPath, targetPath } = options;
  if (Object.hasOwn(options, 'authoritativeJournalPath')) {
    throw new Error('Restore cannot accept a caller-supplied deletion journal.');
  }
  for (const [label, value] of Object.entries({ backupPath, targetPath })) {
    if (!path.isAbsolute(value || '')) throw new Error(`${label} must be absolute.`);
  }
  if (fs.existsSync(targetPath) || fs.existsSync(`${targetPath}.deletions.jsonl`) ||
    fs.existsSync(`${targetPath}.identity.json`)) {
    throw new Error('Restore target already exists.');
  }
  const activePath = getArchivePath();
  if (path.resolve(activePath) === path.resolve(targetPath)) {
    throw new Error('Restore target must differ from the current active archive.');
  }
  const active = openArchive({ filePath: activePath });
  active.close();
  const activeIdentity = readIdentity(`${activePath}.identity.json`);
  const authoritativeJournalPath = `${activePath}.deletions.jsonl`;
  const backupIdentity = readIdentity(`${backupPath}.identity.json`, { expectedKind: 'snapshot' });
  if (activeIdentity.generation !== backupIdentity.generation) {
    throw new Error('Archive generation mismatch between active archive and snapshot.');
  }
  readJournal(authoritativeJournalPath, backupIdentity.generation);
  fs.copyFileSync(backupPath, targetPath, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(authoritativeJournalPath, `${targetPath}.deletions.jsonl`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(`${targetPath}.identity.json`,
    `${JSON.stringify({ ...backupIdentity, kind: 'active' })}\n`, { flag: 'wx', mode: 0o600 });
  const restored = openArchive({ filePath: targetPath });
  restored.close();
  return { filePath: targetPath, journalPath: `${targetPath}.deletions.jsonl`,
    identityPath: `${targetPath}.identity.json` };
}

module.exports = { SCHEMA_VERSION, configureArchivePathResolver, getArchivePath,
  initializeArchive, openArchive, restoreArchiveBackup };
