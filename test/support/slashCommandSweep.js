'use strict';

// The fake Discord and the checks behind the slash command sweep (test/allSlashCommandsSweep.test.js).
//
// The sweep runs every public slash command path through the real interaction handler
// (src/events/interactionCreate.js), the real commands and services, and a real coin database in a temporary
// directory. Only Discord, the network and chance are replaced, and only by what is in this file:
//   - the guilds, members, users, roles, channels, threads and messages the bot can see (createSweepWorld);
//   - the interactions a user sends (createChatInputInteraction, createComponentInteraction,
//     createModalSubmitInteraction, createAutocompleteInteraction). Slash options go through discord.js's own
//     CommandInteractionOptionResolver, and every answer follows discord.js's rules: a second first answer and an edit
//     before any answer are refused the way discord.js refuses them, and a message or a suggestion list Discord would
//     refuse fails the way Discord fails it;
//   - the network (installOfflineFetch): every request is answered 503 Service Unavailable, so nothing leaves the
//     machine;
//   - chance (installDeterministicRandomness): Math.random and node:crypto's randomInt, randomBytes and randomUUID give
//     the same values on every sweep, so a run is classified the same way every time.
// Every fake object is strict. Reading a property it does not have throws FakeNotImplementedError and is written down
// on the run, even when the command catches the error, so a gap in the fake is never mistaken for a broken command.
//
// Order of use in a test file:
//   1. require this file, call installDeterministicRandomness() and then createSweepEnvironment() before requiring
//      anything under src: modules take their random functions and their data paths while they load;
//   2. call installOfflineFetch() and captureLogger();
//   3. require the commands, the interaction handler and the services, open the database (openSweepDatabase), build
//      the world (createSweepWorld) and start watching what the bot keeps (createStateTracker);
//   4. for each run: mark the state, beginRun(), an interaction, the handler, finishRun(), the changes since the
//      mark, classifyRun().

const fs = require('node:fs');
const nodeCrypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  Collection,
  CommandInteractionOptionResolver,
  ComponentType,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  DiscordjsTypeError,
  InteractionType,
  MessageFlags,
  MessageFlagsBitField,
  PermissionFlagsBits,
  PermissionsBitField,
} = require('discord.js');
const { makeRealTempDir, realTmpdir, removeRealTempDir } = require('./realTempDir');

// Synthetic Discord IDs. None of them belongs to a real guild, channel or user.
const IDS = Object.freeze({
  owner: '760000000000000001',
  member: '760000000000000002',
  target: '760000000000000003',
  pendingOwner: '760000000000000004',
  bot: '760000000000000009',
  approvedGuild: '761000000000000001',
  pendingGuild: '761000000000000002',
  approvedChannel: '762000000000000001',
  pendingChannel: '762000000000000002',
  directChannel: '762000000000000003',
  role: '763000000000000001',
  attachment: '764000000000000001',
});

// What interactionCreate answers when a command throws.
const COMMAND_FAILED_MESSAGE = '指令執行失敗，請稍後再試。';

// ---------------------------------------------------------------------------------------------------------
// Chance: seeded
// ---------------------------------------------------------------------------------------------------------

// sfc32, a small generator with 128 bits of state. The sweep seeds it from the name of each run (beginRun), so the
// numbers a run draws depend only on which run it is, not on what ran before it.
const randomState = new Uint32Array(4);

function nextRandomUint32() {
  const [a, b, c, d] = randomState;
  const result = (((a + b) >>> 0) + d) >>> 0;
  randomState[3] = (d + 1) >>> 0;
  randomState[0] = b ^ (b >>> 9);
  randomState[1] = (c + (c << 3)) >>> 0;
  const rotated = ((c << 21) | (c >>> 11)) >>> 0;
  randomState[2] = (rotated + result) >>> 0;
  return result;
}

function nextRandomFloat() {
  return nextRandomUint32() / 4_294_967_296;
}

function seedRandomness(label) {
  const digest = nodeCrypto.createHash('sha256').update(String(label)).digest();
  for (let index = 0; index < 4; index += 1) randomState[index] = digest.readUInt32LE(index * 4);
  for (let round = 0; round < 12; round += 1) nextRandomUint32();
}

let uuidSequence = 0;

// Replaces Math.random and node:crypto's randomInt, randomBytes and randomUUID for this process. randomUUID counts
// instead of drawing, so every id stays unique however the runs are seeded. Returns the function that puts the real
// ones back.
function installDeterministicRandomness() {
  const original = {
    random: Math.random,
    randomInt: nodeCrypto.randomInt,
    randomBytes: nodeCrypto.randomBytes,
    randomUUID: nodeCrypto.randomUUID,
  };
  seedRandomness('sweep');
  Math.random = nextRandomFloat;
  nodeCrypto.randomInt = function deterministicRandomInt(minimum, maximum, callback) {
    let low = minimum;
    let high = maximum;
    let done = callback;
    if (typeof high === 'function' || high === undefined) {
      done = high;
      high = low;
      low = 0;
    }
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high <= low) {
      throw new RangeError(`randomInt needs safe integers with min < max (got ${low}, ${high})`);
    }
    const value = low + Math.floor(nextRandomFloat() * (high - low));
    if (typeof done === 'function') {
      process.nextTick(done, null, value);
      return undefined;
    }
    return value;
  };
  nodeCrypto.randomBytes = function deterministicRandomBytes(size, callback) {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) bytes[index] = nextRandomUint32() & 0xff;
    if (typeof callback === 'function') {
      process.nextTick(callback, null, bytes);
      return undefined;
    }
    return bytes;
  };
  nodeCrypto.randomUUID = function deterministicRandomUUID() {
    uuidSequence += 1;
    return `5eed0000-0000-4000-8000-${uuidSequence.toString(16).padStart(12, '0')}`;
  };
  return function restoreRandomness() {
    Math.random = original.random;
    Object.assign(nodeCrypto, {
      randomInt: original.randomInt, randomBytes: original.randomBytes, randomUUID: original.randomUUID,
    });
  };
}

// ---------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------

// Variables that could point a store at real data, load a private extension, start a server, or reach a real
// service. They are removed before anything under src loads; the sweep then sets only what it needs.
const CLEARED_PREFIXES = ['XIAOJI_', 'GAME_', 'PUBLIC_STATUS_', 'STATUS_SNAPSHOT_', 'GITHUB_RELEASE_', 'AI_MEMORY_'];
const CLEARED_NAMES = [
  'AI_CONVERSATION_PATH', 'AUTO_DEPLOY_COMMANDS', 'BOT_OWNER_ID', 'CLIENT_ID', 'COIN_DB_PATH', 'COIN_TIMEZONE',
  'COIN_V22_EXPECTED_SOURCE_SHA256', 'CWA_API_KEY', 'DISCORD_CLIENT_ID', 'DISCORD_TOKEN', 'GROQ_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENWEATHER_API_KEY', 'OWNER_ID', 'TURTLE_SOUP_CORPUS_ROOT',
];

// Directories on this machine no answer may name, however the platform writes them: the sweep's temporary root, the
// system temp directory and the checkout. createSweepEnvironment fills it.
const localDirectories = [];

function assertInside(root, filePath, label) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the temporary sweep root`);
  }
}

// Points every store at a new temporary directory and returns its layout:
//   root/data     the data root: the coin database, admission files, retained JSON stores and personal data;
//   root/release  an empty stand-in for the release the retained data came from, so the personal data stores never
//                 look at the checkout's own src/data.
// XIAOJI_DATA_ROOT stays unset; every store is named one by one.
function createSweepEnvironment(prefix) {
  const root = makeRealTempDir(prefix);
  const dataRoot = path.join(root, 'data');
  const sourceRoot = path.join(root, 'release');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(sourceRoot);
  localDirectories.splice(0, localDirectories.length, root, realTmpdir(), path.resolve(__dirname, '..', '..'));

  for (const name of Object.keys(process.env)) {
    if (CLEARED_NAMES.includes(name) || CLEARED_PREFIXES.some((prefixText) => name.startsWith(prefixText))) {
      delete process.env[name];
    }
  }

  const files = {
    coinDatabase: path.join(dataRoot, 'coins.sqlite'),
    audit: path.join(dataRoot, 'guildAudit.json'),
    whitelist: path.join(dataRoot, 'inviterWhitelist.json'),
    reminders: path.join(dataRoot, 'reminders.json'),
    calendar: path.join(dataRoot, 'calendarEvents.json'),
    memory: path.join(dataRoot, 'xiaojiMemory.json'),
    conversations: path.join(dataRoot, 'aiConversationHistory.json'),
  };
  Object.assign(process.env, {
    COIN_DB_PATH: files.coinDatabase,
    COIN_TIMEZONE: 'Asia/Taipei',
    XIAOJI_AUDIT_DATA_PATH: files.audit,
    XIAOJI_INVITER_WHITELIST_PATH: files.whitelist,
    XIAOJI_REMINDERS_PATH: files.reminders,
    XIAOJI_CALENDAR_PATH: files.calendar,
    XIAOJI_MEMORY_PATH: files.memory,
    AI_CONVERSATION_PATH: files.conversations,
    // test-control sends the retained JSON stores (guild settings, polls, quotas) to XIAOJI_TEST_DATA_ROOT instead
    // of src/data, and keeps src/index.js and the conversation provider from reading a .env file.
    XIAOJI_RUNTIME_MODE: 'test-control',
    XIAOJI_TEST_DATA_ROOT: dataRoot,
    BOT_OWNER_ID: IDS.owner,
    // Synthetic weather keys, so /weather goes as far as the network and meets the offline fetch.
    CWA_API_KEY: 'synthetic-sweep-cwa-key',
    OPENWEATHER_API_KEY: 'synthetic-sweep-openweather-key',
  });
  for (const filePath of Object.values(files)) assertInside(root, filePath, filePath);

  fs.writeFileSync(files.audit, `${JSON.stringify({
    [IDS.approvedGuild]: { guildId: IDS.approvedGuild, name: 'Sweep Approved Guild', status: 'approved' },
    [IDS.pendingGuild]: { guildId: IDS.pendingGuild, name: 'Sweep Pending Guild', status: 'pending' },
  }, null, 2)}\n`);
  fs.writeFileSync(files.whitelist, '[]\n');
  for (const name of ['guildConfig.json', 'polls.json', 'guildQuotas.json']) {
    fs.writeFileSync(path.join(dataRoot, name), '{}\n');
  }
  fs.writeFileSync(files.reminders, '{}\n');
  fs.writeFileSync(files.calendar, '{}\n');

  // The personal data stores (reminders, calendar) accept an explicit path only with a provenance receipt whose
  // digest the operator saved. A fresh receipt is what a new deployment writes.
  require('../../src/platform/retainedDataSource').configureRetainedDataSourceRoot(sourceRoot);
  const { createProvenance } = require('../../src/platform/personalDataPaths');
  process.env.XIAOJI_REMINDERS_PROVENANCE_SHA256 = createProvenance('reminders', files.reminders).sha256;
  process.env.XIAOJI_CALENDAR_PROVENANCE_SHA256 = createProvenance('calendar', files.calendar).sha256;

  return Object.freeze({ root, dataRoot, sourceRoot, files });
}

function removeSweepEnvironment(environment) {
  removeRealTempDir(environment.root);
}

// Opens a brand-new coin database at the sweep's path.
async function openSweepDatabase(environment) {
  const database = require('../../src/services/coinDatabase');
  database.resetCoinDatabaseForTests();
  const databasePath = database.getCoinDatabasePath();
  assertInside(environment.root, databasePath, 'the coin database');
  await database.initializeNewCoinDatabase({ expectedPath: databasePath });
  return databasePath;
}

function closeSweepDatabase() {
  require('../../src/services/coinDatabase').resetCoinDatabaseForTests();
}

// ---------------------------------------------------------------------------------------------------------
// State: what a run changed
// ---------------------------------------------------------------------------------------------------------

// Watches what the bot keeps: every table of the coin database (balances, transactions, inventory, board and
// personal-game sessions, feature settings and usage, ...), the JSON stores of the data root (reminders, calendar,
// polls, quotas, guild settings, admission) and the side-effect ledgers. The coin database is watched through write
// counters: a trigger on every table counts each row inserted, updated or deleted in sweep_write_counts, one row per
// table, so a write that is rolled back leaves no trace, a run's writes are known table by table, and the database
// does not grow with the sweep. An update counts even when it leaves every value as it was: a refused run has no
// business writing at all (and a WHEN clause comparing every column would double the schema sql.js parses again after
// every export). The triggers change nothing the bot reads back: changes() counts only the statement's own rows, and
// last_insert_rowid() is the statement's own row again once a trigger ends. A change of the schema (a table made,
// dropped or altered) shows in SQLite's schema version. Files are compared by content whenever their size, times or
// identity change. The fake Discord's own record of sent, edited and deleted messages, reactions, threads and REST
// requests is on the run (run.effects).
const WRITE_COUNT_TABLE = 'sweep_write_counts';

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function quoteLiteral(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

// Every file under `root`, by full path.
function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function createStateTracker({ roots, ignoredFiles = [] }) {
  const database = require('../../src/services/coinDatabase');
  const ignored = new Set(ignoredFiles.map((file) => path.resolve(file)));
  const fileCache = new Map();
  // The schema version every table had a trigger at.
  let watchedSchemaVersion = null;
  // The files as the last comparison saw them, and how much had happened outside a run then. Reading every file's
  // times is the slow part of a mark, so a mark taken right after a comparison takes the files from it, unless
  // something happened outside a run since (tracker.orphan grew) or the sweep said it changed something between runs
  // (forgetFiles). The database is read afresh for every mark.
  let lastFiles = null;
  let orphanSizeThen = -1;
  const orphanSize = () => Object.values(tracker.orphan).reduce((sum, list) => sum + list.length, 0);
  // How often the state was marked, how long marking and comparing took, and how many file contents were read.
  const stats = { marks: 0, milliseconds: 0, filesHashed: 0 };

  // The content digest of every file under the roots, by path relative to its root (after the root's number when
  // there are several). A file is read again only when its size, times or identity changed.
  function fileDigests() {
    const digests = new Map();
    for (const [index, root] of roots.entries()) {
      const prefix = roots.length > 1 ? `${index}:` : '';
      for (const file of listFiles(root)) {
        if (ignored.has(path.resolve(file)) || file.endsWith('.tmp')) continue;
        const stat = fs.statSync(file);
        const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
        const cached = fileCache.get(file);
        let digest = cached?.key === key ? cached.digest : null;
        if (digest === null) {
          digest = nodeCrypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
          stats.filesHashed += 1;
          fileCache.set(file, { key, digest });
        }
        digests.set(`${prefix}${path.relative(root, file).replace(/\\/gu, '/')}`, digest);
      }
    }
    return digests;
  }

  // The schema version and the write counters, in one statement.
  const readDatabase = (api) => {
    const row = api.get(`SELECT (SELECT schema_version FROM pragma_schema_version) AS version, `
      + `(SELECT group_concat(table_name || '=' || writes, char(10)) FROM ${WRITE_COUNT_TABLE}) AS counts`);
    return {
      schemaVersion: Number(row.version),
      writes: new Map(String(row.counts ?? '').split('\n').filter(Boolean).map((line) => {
        const at = line.lastIndexOf('=');
        return [line.slice(0, at), Number(line.slice(at + 1))];
      })),
    };
  };
  const schemaVersion = (api) => Number(api.get('PRAGMA schema_version').schema_version);

  // Puts the counting triggers on every table that has none yet. Tables are made as they are first needed (the board
  // store's, a game's), and a table dropped and made again loses its triggers, so this looks again whenever the
  // schema version moved.
  async function watchNewTables() {
    const unwatched = await database.withCoinDatabase((api) => {
      const version = schemaVersion(api);
      if (version === watchedSchemaVersion) return null;
      const names = (type) => new Set(api.all('SELECT name FROM sqlite_master WHERE type = ?', [type]).map((row) => row.name));
      const triggers = names('trigger');
      const tables = [...names('table')].filter((name) => !name.startsWith('sqlite_') && name !== WRITE_COUNT_TABLE);
      return {
        version,
        counting: names('table').has(WRITE_COUNT_TABLE),
        tables: tables.filter((name) => !triggers.has(`sweep_count_${name}_insert`)).sort(),
      };
    });
    if (!unwatched) return;
    if (unwatched.counting && unwatched.tables.length === 0) {
      watchedSchemaVersion = unwatched.version;
      return;
    }
    await database.withCoinTransaction((api) => {
      api.run(`CREATE TABLE IF NOT EXISTS ${WRITE_COUNT_TABLE} (table_name TEXT PRIMARY KEY, writes INTEGER NOT NULL)`);
      for (const name of unwatched.tables) {
        // The counter row is made here, so a trigger only ever updates it: a statement inside a trigger takes the
        // conflict policy of the statement that fired it (INSERT OR ABORT, OR REPLACE, ...), and an update of a counter
        // has no conflict to resolve.
        if (!api.get(`SELECT 1 AS found FROM ${WRITE_COUNT_TABLE} WHERE table_name = ?`, [name])) {
          api.run(`INSERT INTO ${WRITE_COUNT_TABLE} (table_name, writes) VALUES (?, 0)`, [name]);
        }
        for (const event of ['insert', 'update', 'delete']) {
          api.run(`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`sweep_count_${name}_${event}`)} AFTER `
            + `${event.toUpperCase()} ON ${quoteIdentifier(name)} BEGIN UPDATE ${WRITE_COUNT_TABLE} `
            + `SET writes = writes + 1 WHERE table_name = ${quoteLiteral(name)}; END`);
        }
      }
      watchedSchemaVersion = schemaVersion(api);
    });
  }

  async function timed(work) {
    const started = performance.now();
    try {
      return await work();
    } finally {
      stats.milliseconds += performance.now() - started;
    }
  }

  return Object.freeze({
    watchNewTables,
    stats,
    // Says that the sweep changed something itself since the last run, so the next mark reads every file again.
    forgetFiles() {
      lastFiles = null;
    },
    // Where the state stands now; take it right before a run. The database is read through its operation queue, so
    // whatever the bot queued before is done first.
    mark: () => timed(async () => {
      stats.marks += 1;
      if (watchedSchemaVersion === null) await watchNewTables();
      let state = await database.withCoinDatabase(readDatabase);
      if (state.schemaVersion !== watchedSchemaVersion) {
        await watchNewTables();
        state = await database.withCoinDatabase(readDatabase);
      }
      const files = lastFiles && orphanSize() === orphanSizeThen ? lastFiles : fileDigests();
      return { ...state, files };
    }),
    // What changed since `mark`: the tables written (with the number of rows written), whether the schema changed,
    // and the files whose content changed (made, changed or removed).
    changesSince: (mark) => timed(async () => {
      const after = await database.withCoinDatabase(readDatabase);
      const files = fileDigests();
      lastFiles = files;
      orphanSizeThen = orphanSize();
      const changedFiles = [...new Set([...mark.files.keys(), ...files.keys()])]
        .filter((file) => mark.files.get(file) !== files.get(file));
      const tables = [...after.writes].filter(([name, writes]) => writes !== (mark.writes.get(name) ?? 0))
        .map(([name, writes]) => [name, writes - (mark.writes.get(name) ?? 0)])
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return {
        tables: Object.fromEntries(tables),
        schemaChanged: after.schemaVersion !== mark.schemaVersion,
        files: changedFiles.sort(),
      };
    }),
  });
}

// ---------------------------------------------------------------------------------------------------------
// The current run: what the fakes write down
// ---------------------------------------------------------------------------------------------------------

const tracker = {
  run: null,
  // What happened while no run was active (between runs, or from a timer a run left behind).
  orphan: { missing: [], effects: [], logs: [], unhandled: [], fetches: [], modals: [] },
};

function sink() {
  return tracker.run || tracker.orphan;
}

class FakeNotImplementedError extends Error {
  constructor(label) {
    super(`這個假物件沒實作 ${label}`);
    this.name = 'FakeNotImplementedError';
    this.code = 'FAKE_NOT_IMPLEMENTED';
  }
}

// Properties the language and Node look up on any object (await, JSON.stringify, util.inspect, assert). Asking for
// them is not a use of Discord, so they read as absent instead of throwing.
const LANGUAGE_PROBES = new Set(['then', 'toJSON', 'inspect', 'asymmetricMatch', 'nodeType', '$$typeof']);

function strict(label, target) {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property in object || LANGUAGE_PROBES.has(property)) {
        return Reflect.get(object, property, receiver);
      }
      const name = `${label}.${String(property)}`;
      sink().missing.push(name);
      throw new FakeNotImplementedError(name);
    },
  });
}

function noteEffect(effect) {
  sink().effects.push(effect);
}

// ---------------------------------------------------------------------------------------------------------
// The network: offline
// ---------------------------------------------------------------------------------------------------------

function installOfflineFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    let host = 'invalid-url';
    try { host = new URL(url).host; } catch { /* recorded as invalid-url */ }
    sink().fetches.push({ host, method: String(init.method || input?.method || 'GET').toUpperCase() });
    return new Response(JSON.stringify({ message: 'synthetic offline sweep' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' },
    });
  };
  return function restoreFetch() {
    globalThis.fetch = original;
  };
}

// The project logger prints to the console. During the sweep every line goes to the run instead, and an error with
// its cause is kept so a failure the command swallowed can be shown.
function captureLogger() {
  const logger = require('../../src/utils/logger');
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = (message) => { sink().logs.push({ level: 'info', message: String(message) }); };
  logger.warn = (message) => { sink().logs.push({ level: 'warn', message: String(message) }); };
  logger.error = (message, cause) => { sink().logs.push({ level: 'error', message: String(message), cause }); };
  return function restoreLogger() {
    Object.assign(logger, original);
  };
}

function captureUnhandledRejections() {
  const listener = (reason) => { sink().unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  return function restore() {
    process.off('unhandledRejection', listener);
  };
}

// ---------------------------------------------------------------------------------------------------------
// The world the bot can see
// ---------------------------------------------------------------------------------------------------------

const MEMBER_PERMISSION_FLAGS = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseApplicationCommands, PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ChangeNickname,
];

function snowflakeTimestamp(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

function discordApiError(code, message, status = 404) {
  return new DiscordAPIError({ message, code }, code, status, 'GET', 'https://discord.invalid/api/v10/sweep', {});
}

let snowflakeSequence = 0n;
// IDs for messages and interactions, newer than every fixture ID and unique within the process.
function nextSnowflake() {
  snowflakeSequence += 1n;
  return String((1767225600000n - 1420070400000n) << 22n | snowflakeSequence);
}

function computePermissions(bits) {
  const permissions = new PermissionsBitField(bits);
  if (permissions.has(PermissionFlagsBits.Administrator)) return new PermissionsBitField(PermissionsBitField.All).freeze();
  return permissions.freeze();
}

function createUser(id, { username, globalName = null, bot = false }) {
  return strict(`user(${username})`, {
    id,
    username,
    globalName,
    discriminator: '0',
    bot,
    system: false,
    partial: false,
    avatar: null,
    get tag() { return username; },
    get displayName() { return globalName ?? username; },
    createdTimestamp: snowflakeTimestamp(id),
    get createdAt() { return new Date(snowflakeTimestamp(id)); },
    toString() { return `<@${id}>`; },
    displayAvatarURL() { return 'https://cdn.discordapp.com/embed/avatars/0.png'; },
    avatarURL() { return null; },
  });
}

function createRole(guild, id, { name, position, members = [] }) {
  const role = strict(`role(${name})`, {
    id,
    name,
    guild,
    position,
    color: 0,
    hoist: false,
    managed: false,
    mentionable: true,
    editable: true,
    permissions: computePermissions(id === guild.id ? MEMBER_PERMISSION_FLAGS : []),
    get members() { return new Collection(members.map((member) => [member.id, member])); },
    toString() { return id === guild.id ? '@everyone' : `<@&${id}>`; },
  });
  return { role, members };
}

function createMember(guild, user, { permissions, roles }) {
  const roleCache = new Collection(roles.map((role) => [role.id, role]));
  const member = strict(`member(${user.username})`, {
    id: user.id,
    user,
    guild,
    nickname: null,
    get displayName() { return user.globalName ?? user.username; },
    partial: false,
    pending: false,
    premiumSince: null,
    communicationDisabledUntil: null,
    joinedTimestamp: snowflakeTimestamp(user.id),
    get joinedAt() { return new Date(snowflakeTimestamp(user.id)); },
    permissions: computePermissions(permissions),
    roles: strict(`member(${user.username}).roles`, {
      cache: roleCache,
      get highest() { return [...roleCache.values()].sort((left, right) => right.position - left.position)[0]; },
    }),
    toString() { return `<@${user.id}>`; },
    displayAvatarURL() { return user.displayAvatarURL(); },
  });
  return member;
}

function compareSnowflakes(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// A channel's message manager. fetch() answers one message by ID, or a page of history the way discord.js does:
// newest first, at most `limit` (50 unless asked, 100 at most), before or after a message ID.
function createMessageManager(label, messageCache) {
  return strict(`${label}.messages`, {
    cache: messageCache,
    async fetch(options) {
      const single = typeof options === 'string' ? options : (typeof options?.message === 'string' ? options.message : null);
      if (single !== null) {
        const message = messageCache.get(single);
        if (!message) throw discordApiError(10008, 'Unknown Message');
        return message;
      }
      const limit = Math.min(Math.max(Number(options?.limit) || 50, 1), 100);
      let list = [...messageCache.values()].sort((left, right) => compareSnowflakes(right.id, left.id));
      if (options?.before) list = list.filter((message) => compareSnowflakes(message.id, options.before) < 0);
      if (options?.after) list = list.filter((message) => compareSnowflakes(message.id, options.after) > 0);
      return new Collection(list.slice(0, limit).map((message) => [message.id, message]));
    },
  });
}

// A text channel, or a thread when `parent` is given. send() keeps the message so a later fetch or edit finds it.
function createTextChannel(guild, id, name, world, { parent = null } = {}) {
  const messageCache = new Collection();
  const label = parent ? `thread(${name})` : `channel(${name})`;
  const channel = strict(label, {
    id,
    name,
    guild,
    guildId: guild.id,
    type: parent ? ChannelType.PublicThread : ChannelType.GuildText,
    parentId: parent ? parent.id : null,
    parent,
    nsfw: false,
    topic: null,
    viewable: true,
    archived: false,
    locked: false,
    createdTimestamp: snowflakeTimestamp(id),
    url: `https://discord.com/channels/${guild.id}/${id}`,
    isTextBased: () => true,
    isThread: () => Boolean(parent),
    isDMBased: () => false,
    isVoiceBased: () => false,
    isSendable: () => true,
    toString() { return `<#${id}>`; },
    permissionsFor(subject) {
      const subjectId = typeof subject === 'string' ? subject : subject?.id;
      const member = guild.members.cache.get(subjectId);
      if (member) return member.permissions;
      const role = guild.roles.cache.get(subjectId);
      if (role) return role.permissions;
      return null;
    },
    async send(payload) {
      const body = toMessageBody(payload, 'channel.send');
      noteEffect({ kind: 'channel.send', channelId: id, body });
      const refused = checkVisibleMessage(body, `${label}.send`, sink());
      if (refused.length > 0) throw refusedByDiscord(refused);
      return world.createMessage(channel, body, { author: world.botUser });
    },
    messages: createMessageManager(label, messageCache),
  });
  return channel;
}

// The direct-message channel between the bot and `user`. A DM channel has no guild, name or permission overwrites;
// those read as undefined, as on discord.js's DMChannel.
function createDmChannel(user, id, world) {
  const messageCache = new Collection();
  const channel = strict(`dm(${user.username})`, {
    id,
    type: ChannelType.DM,
    recipientId: user.id,
    recipient: user,
    guild: undefined,
    guildId: undefined,
    name: undefined,
    parentId: undefined,
    permissionsFor: undefined,
    url: `https://discord.com/channels/@me/${id}`,
    isTextBased: () => true,
    isThread: () => false,
    isDMBased: () => true,
    isVoiceBased: () => false,
    isSendable: () => true,
    toString() { return `<#${id}>`; },
    async send(payload) {
      const body = toMessageBody(payload, 'dm.send');
      noteEffect({ kind: 'dm.send', channelId: id, body });
      const refused = checkVisibleMessage(body, `dm(${user.username}).send`, sink());
      if (refused.length > 0) throw refusedByDiscord(refused);
      return world.createMessage(channel, body, { author: world.botUser });
    },
    messages: createMessageManager(`dm(${user.username})`, messageCache),
  });
  return channel;
}

// The bot's view: two guilds (the one the sweep runs in, and another one whose old record says pending; no guild is
// reviewed any more), their members, a text channel each, and a role. The bot owner is also the owner of the approved guild and holds Administrator there; the member holds only
// what @everyone holds; the target is another plain member every user option names. The member also has a
// direct-message channel with the bot. More text channels of the approved guild are made on demand (channelFor), and
// every message the bot sends is kept in order (messages), with the run that made it.
function createSweepWorld({ commands, extensionHost }) {
  const world = {};
  const users = {
    owner: createUser(IDS.owner, { username: 'sweep_owner', globalName: '掃描擁有者' }),
    member: createUser(IDS.member, { username: 'sweep_member', globalName: '掃描成員' }),
    target: createUser(IDS.target, { username: 'sweep_target', globalName: '掃描目標' }),
    pendingOwner: createUser(IDS.pendingOwner, { username: 'sweep_pending_owner' }),
    bot: createUser(IDS.bot, { username: 'xiaoji_sweep_bot', globalName: '小吉', bot: true }),
  };
  world.users = users;
  world.botUser = users.bot;

  // The state behind each message, so an interaction's editReply changes the same message a fetch returns.
  const messageStates = new Map();
  world.messages = [];
  world.stateOf = (message) => messageStates.get(message.id);
  // Applies an edit to a message when Discord would accept what the message then shows, and refuses it otherwise.
  world.editMessage = (message, edit, where) => {
    const state = messageStates.get(message.id);
    const next = { ...state };
    if (edit.content !== undefined) next.content = edit.content;
    if (edit.embeds !== undefined) next.embeds = edit.embeds;
    if (edit.components !== undefined) next.components = edit.components;
    if (edit.filesGiven) next.files = edit.files;
    const refused = checkVisibleMessage({ ...next, flags: edit.flags }, where, sink());
    if (refused.length > 0) throw refusedByDiscord(refused);
    Object.assign(state, next);
    return message;
  };
  // An ephemeral message exists only for the interaction that sent it: like Discord, the channel cannot fetch it.
  world.createMessage = (channel, body, { author, ephemeral = false }) => {
    const id = nextSnowflake();
    const state = {
      content: body.content ?? '', embeds: body.embeds ?? [], components: body.components ?? [], files: body.files ?? [],
    };
    messageStates.set(id, state);
    const createdTimestamp = Date.now();
    const message = strict(`message(${id})`, {
      id,
      channel,
      channelId: channel.id,
      guild: channel.guild,
      guildId: channel.guildId,
      author,
      get content() { return state.content; },
      get embeds() { return state.embeds; },
      get components() { return state.components; },
      createdTimestamp,
      get createdAt() { return new Date(createdTimestamp); },
      flags: new MessageFlagsBitField(ephemeral ? MessageFlags.Ephemeral : 0).freeze(),
      editable: true,
      deletable: true,
      pinned: false,
      // The thread started from this message, once there is one.
      thread: null,
      url: `https://discord.com/channels/${channel.guildId}/${channel.id}/${id}`,
      toString() { return state.content; },
      async fetch() { return message; },
      async edit(payload) {
        const edit = toMessageBody(payload, 'message.edit');
        noteEffect({ kind: 'message.edit', messageId: id, body: edit });
        return world.editMessage(message, edit, `message(${id}).edit`);
      },
      async delete() {
        noteEffect({ kind: 'message.delete', messageId: id });
        channel.messages.cache.delete(id);
        return message;
      },
      async react(emoji) {
        noteEffect({ kind: 'message.react', messageId: id, emoji: String(emoji) });
        return strict('reaction', { emoji: String(emoji), message });
      },
      // Like Discord, a thread started from a message has that message's ID.
      async startThread(options = {}) {
        if (ephemeral || !channel.guild) throw discordApiError(50024, 'Cannot execute action on this channel type', 400);
        const thread = world.createThread(channel, id, String(options.name || 'thread'));
        noteEffect({ kind: 'thread.create', threadId: id, name: String(options.name || '') });
        Reflect.set(message, 'thread', thread);
        return thread;
      },
    });
    const origin = tracker.run
      ? Object.freeze({ path: tracker.run.path, variant: tracker.run.variant, actor: tracker.run.actor })
      : null;
    world.messages.push(Object.freeze({ id, message, channel, ephemeral, origin }));
    if (!ephemeral) channel.messages.cache.set(id, message);
    return message;
  };

  function buildGuild({ id, name, ownerId, adminIds, memberUsers }) {
    const memberCache = new Collection();
    const roleCache = new Collection();
    const channelCache = new Collection();
    const guild = strict(`guild(${name})`, {
      id,
      name,
      ownerId,
      available: true,
      createdTimestamp: snowflakeTimestamp(id),
      get createdAt() { return new Date(snowflakeTimestamp(id)); },
      get memberCount() { return memberCache.size; },
      iconURL() { return null; },
      toString() { return name; },
      members: null,
      roles: null,
      channels: null,
      client: null,
    });
    const everyone = createRole(guild, id, { name: '@everyone', position: 0 });
    const sweepRole = createRole(guild, IDS.role, { name: 'sweep-role', position: 1 });
    roleCache.set(id, everyone.role);
    roleCache.set(IDS.role, sweepRole.role);

    for (const user of memberUsers) {
      const isBot = user.id === IDS.bot;
      const permissions = isBot || adminIds.includes(user.id)
        ? [PermissionFlagsBits.Administrator]
        : MEMBER_PERMISSION_FLAGS;
      const roles = user.id === IDS.target || user.id === IDS.member ? [everyone.role, sweepRole.role] : [everyone.role];
      const member = createMember(guild, user, { permissions, roles });
      memberCache.set(user.id, member);
      everyone.members.push(member);
      if (roles.includes(sweepRole.role)) sweepRole.members.push(member);
    }

    const managers = {
      members: strict(`guild(${name}).members`, {
        cache: memberCache,
        get me() { return memberCache.get(IDS.bot); },
        async fetchMe() { return memberCache.get(IDS.bot); },
        async fetch(options) {
          if (options === undefined) return new Collection(memberCache);
          const single = typeof options === 'string' ? options : (typeof options?.user === 'string' ? options.user : null);
          if (single !== null) {
            const member = memberCache.get(single);
            if (!member) throw discordApiError(10007, 'Unknown Member');
            return member;
          }
          if (Array.isArray(options?.user)) {
            return memberCache.filter((member) => options.user.includes(member.id));
          }
          if (typeof options?.query === 'string') {
            const query = options.query.toLowerCase();
            return memberCache.filter((member) => member.user.username.toLowerCase().startsWith(query))
              .first(Number(options.limit) || 1)
              .reduce((found, member) => found.set(member.id, member), new Collection());
          }
          return new Collection(memberCache);
        },
      }),
      roles: strict(`guild(${name}).roles`, {
        cache: roleCache,
        get everyone() { return roleCache.get(id); },
        async fetch(roleId) {
          if (roleId === undefined) return new Collection(roleCache);
          return roleCache.get(roleId) ?? null;
        },
      }),
      channels: strict(`guild(${name}).channels`, {
        cache: channelCache,
        async fetch(channelIdToFetch) {
          if (channelIdToFetch === undefined) return new Collection(channelCache);
          const channel = channelCache.get(channelIdToFetch);
          if (!channel) throw discordApiError(10003, 'Unknown Channel');
          return channel;
        },
      }),
    };
    return { guild, managers, channelCache };
  }

  const approved = buildGuild({
    id: IDS.approvedGuild,
    name: 'Sweep Approved Guild',
    ownerId: IDS.owner,
    adminIds: [IDS.owner],
    memberUsers: [users.owner, users.member, users.target, users.bot],
  });
  const pending = buildGuild({
    id: IDS.pendingGuild,
    name: 'Sweep Pending Guild',
    ownerId: IDS.pendingOwner,
    adminIds: [IDS.pendingOwner],
    memberUsers: [users.pendingOwner, users.member, users.target, users.bot],
  });

  const guildCache = new Collection();
  const channelCache = new Collection();
  const client = strict('client', {
    user: users.bot,
    application: strict('client.application', { id: IDS.bot }),
    commands,
    extensionHost,
    // src/index.js sets this to the test-control policy; a normal start has none.
    testControlPolicy: null,
    readyAt: new Date(0),
    readyTimestamp: 0,
    isReady: () => true,
    ws: strict('client.ws', { ping: 42 }),
    users: strict('client.users', {
      cache: new Collection(Object.values(users).map((user) => [user.id, user])),
      async fetch(userId) {
        const user = Object.values(users).find((candidate) => candidate.id === userId);
        if (!user) throw discordApiError(10013, 'Unknown User');
        return user;
      },
    }),
    guilds: strict('client.guilds', {
      cache: guildCache,
      async fetch(guildId) {
        if (guildId === undefined) return new Collection(guildCache);
        const guild = guildCache.get(typeof guildId === 'string' ? guildId : guildId?.guild);
        if (!guild) throw discordApiError(10004, 'Unknown Guild');
        return guild;
      },
    }),
    channels: strict('client.channels', {
      cache: channelCache,
      async fetch(channelId) {
        const channel = channelCache.get(channelId);
        if (!channel) throw discordApiError(10003, 'Unknown Channel');
        return channel;
      },
    }),
  });

  for (const [built, channelId, channelName] of [
    [approved, IDS.approvedChannel, 'sweep-approved'],
    [pending, IDS.pendingChannel, 'sweep-pending'],
  ]) {
    // A proxy forwards writes to its target, so these land on the guild object every caller holds.
    Reflect.set(built.guild, 'members', built.managers.members);
    Reflect.set(built.guild, 'roles', built.managers.roles);
    Reflect.set(built.guild, 'channels', built.managers.channels);
    Reflect.set(built.guild, 'client', client);
    const channel = createTextChannel(built.guild, channelId, channelName, world);
    built.channelCache.set(channel.id, channel);
    channelCache.set(channel.id, channel);
    guildCache.set(built.guild.id, built.guild);
  }

  // A text channel of the approved guild by name, made the first time it is asked for, with an ID that depends only
  // on the order the names were first asked for.
  const namedChannels = new Map();
  world.channelFor = (name) => {
    if (namedChannels.has(name)) return namedChannels.get(name);
    const id = String(762000000000001000n + BigInt(namedChannels.size + 1));
    const channel = createTextChannel(approved.guild, id, name, world);
    approved.channelCache.set(id, channel);
    channelCache.set(id, channel);
    namedChannels.set(name, channel);
    return channel;
  };
  world.createThread = (parent, id, name) => {
    const thread = createTextChannel(approved.guild, id, name, world, { parent });
    approved.channelCache.set(id, thread);
    channelCache.set(id, thread);
    return thread;
  };

  world.client = client;
  world.guilds = { approved: approved.guild, pending: pending.guild };
  world.channels = {
    approved: approved.channelCache.get(IDS.approvedChannel),
    pending: pending.channelCache.get(IDS.pendingChannel),
    direct: createDmChannel(users.member, IDS.directChannel, world),
  };
  channelCache.set(IDS.directChannel, world.channels.direct);
  world.role = approved.guild.roles.cache.get(IDS.role);
  world.attachment = strict('attachment', {
    id: IDS.attachment,
    name: 'sweep-proof.png',
    contentType: 'image/png',
    size: 2048,
    width: 64,
    height: 64,
    ephemeral: false,
    description: null,
    url: `https://cdn.discordapp.com/attachments/${IDS.approvedChannel}/${IDS.attachment}/sweep-proof.png`,
    proxyURL: `https://media.discordapp.net/attachments/${IDS.approvedChannel}/${IDS.attachment}/sweep-proof.png`,
  });
  return world;
}

// The buttons and select menus a message shows now, in the order Discord lays them out.
function componentsOf(world, message) {
  const found = [];
  const visit = (component) => {
    if (component?.type === ComponentType.Button || component?.type === ComponentType.StringSelect) found.push(component);
    for (const child of component?.components || []) visit(child);
    if (component?.accessory) visit(component.accessory);
  };
  for (const row of world.stateOf(message)?.components || []) visit(row);
  return found;
}

// ---------------------------------------------------------------------------------------------------------
// Command paths and option values
// ---------------------------------------------------------------------------------------------------------

const OPTION_TYPE_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(ApplicationCommandOptionType).filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value, name]),
));

// Every path a user can type: "ping", "bank balance", or "group subcommand" under a command. `options` are the
// option definitions of that path, from the command's toJSON().
function flattenCommandPaths(commands) {
  const paths = [];
  // Code unit order, the same on every platform and locale.
  const byName = (left, right) => (left.data.name < right.data.name ? -1 : left.data.name > right.data.name ? 1 : 0);
  for (const command of [...commands.values()].sort(byName)) {
    const json = command.data.toJSON();
    // A command is offered in direct messages unless its builder turns that off (dm_permission false, or contexts
    // without the bot DM context, 1).
    const directMessages = json.dm_permission !== false && !(Array.isArray(json.contexts) && !json.contexts.includes(1));
    const base = { commandName: json.name, directMessages };
    const leaves = (json.options || []).filter((option) =>
      option.type === ApplicationCommandOptionType.Subcommand || option.type === ApplicationCommandOptionType.SubcommandGroup);
    if (leaves.length === 0) {
      paths.push({ ...base, key: json.name, group: null, subcommand: null, options: json.options || [] });
      continue;
    }
    for (const option of leaves) {
      if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const sub of option.options || []) {
          paths.push({
            ...base, key: `${json.name} ${option.name} ${sub.name}`, group: option.name, subcommand: sub.name,
            options: sub.options || [],
          });
        }
      } else {
        paths.push({
          ...base, key: `${json.name} ${option.name}`, group: null, subcommand: option.name, options: option.options || [],
        });
      }
    }
  }
  return paths;
}

// Values for options whose name asks for a format a generic value would not meet. Anything not named here gets a
// generic value of its type. A function receives the run context ({ path, items }).
const NAMED_STRING_VALUES = Object.freeze({
  'guild-id': () => IDS.approvedGuild,
  'external-server-ids': () => IDS.approvedGuild,
  // The evening of the sweep's own day (it runs at noon in Taipei), so /calendar list shows what was added.
  'starts-at': () => '2026-03-02 20:00',
  time: () => '10m',
  city: () => '臺北市',
  seed: () => '蘋果',
  choice: () => 'big',
  confirm: () => 'RESET',
  'review-token': () => 'a'.repeat(64),
  'campaign-id': () => 'sweep-campaign-1',
  'source-reference': () => 'sweep-reference-1',
  'item-id': (context) => context.itemIdFor(context.path),
  'weapon-item-id': (context) => context.items.weapon,
  id: () => 'sweep-missing-id',
  name: () => '掃描測試品項',
  title: () => '掃描測試活動',
  question: () => '掃描測試問題？',
  option1: () => '選項甲',
  option2: () => '選項乙',
  option3: () => '選項丙',
  option4: () => '選項丁',
  option5: () => '選項戊',
  message: () => '掃描測試提醒內容',
  content: () => '掃描測試回報內容',
  description: () => '掃描測試描述',
  reason: () => '掃描測試原因',
  // One step per line; the command numbers them itself.
  steps: () => '準備材料\n完成餐點',
  'task-type': () => '掃描測試任務',
});

// Options whose value is text a user writes freely. The long-data pass fills them to the longest the option accepts.
const FREE_TEXT_OPTIONS = Object.freeze(new Set([
  'name', 'title', 'question', 'option1', 'option2', 'option3', 'option4', 'option5', 'message', 'content',
  'description', 'reason', 'steps', 'task-type', 'source-reference',
]));
const LONG_TEXT_UNIT = '掃描長文字測試，';
// Options that say how many rows a list shows. The long-data pass asks for the most rows the option accepts, and
// for the second page where there are pages: the first pass already filled the first page with short entries.
const LIST_SIZE_OPTIONS = Object.freeze(new Set(['limit', 'days']));
const LONG_DATA_PAGE = 2;

const NAMED_INTEGER_VALUES = Object.freeze({
  // A poll closes on a timer; at the longest duration it can never close while the sweep runs.
  'duration-minutes': () => 1440,
});

function fitString(value, option) {
  let text = String(value);
  const minimum = Number.isInteger(option.min_length) ? option.min_length : 0;
  const maximum = Number.isInteger(option.max_length) ? option.max_length : 6000;
  while (text.length < minimum) text += '0';
  return text.slice(0, maximum);
}

function fitNumber(value, option) {
  let number = value;
  if (typeof option.min_value === 'number') number = Math.max(number, option.min_value);
  if (typeof option.max_value === 'number') number = Math.min(number, option.max_value);
  return number;
}

// The value Discord would deliver for one option definition, as discord.js's transformOption leaves it: { name,
// type, value } plus the resolved user, member, channel, role or attachment.
function generateOptionValue(option, context) {
  const { world, guild } = context;
  const base = { name: option.name, type: option.type };
  if (Array.isArray(option.choices) && option.choices.length > 0) return { ...base, value: option.choices[0].value };
  switch (option.type) {
    case ApplicationCommandOptionType.String: {
      const named = NAMED_STRING_VALUES[option.name];
      let text = named ? named(context) : `掃描測試${option.name}`;
      if (context.longest && (FREE_TEXT_OPTIONS.has(option.name) || !named) && Number.isInteger(option.max_length)) {
        text = LONG_TEXT_UNIT.repeat(Math.ceil(option.max_length / LONG_TEXT_UNIT.length));
      }
      return { ...base, value: fitString(text, option) };
    }
    case ApplicationCommandOptionType.Integer: {
      const named = NAMED_INTEGER_VALUES[option.name];
      let value = named ? named(context) : (typeof option.min_value === 'number' ? option.min_value : 1);
      if (context.longest && LIST_SIZE_OPTIONS.has(option.name) && typeof option.max_value === 'number') {
        value = option.max_value;
      }
      if (context.longest && option.name === 'page') value = LONG_DATA_PAGE;
      return { ...base, value: fitNumber(value, option) };
    }
    case ApplicationCommandOptionType.Number: {
      const fallback = typeof option.min_value === 'number' ? option.min_value : 1;
      return { ...base, value: fitNumber(fallback, option) };
    }
    case ApplicationCommandOptionType.Boolean:
      return { ...base, value: true };
    // In a direct message there is no member to resolve, and no guild channel or role to pick: such an option is
    // left empty there (null).
    case ApplicationCommandOptionType.User:
    case ApplicationCommandOptionType.Mentionable: {
      const member = guild ? guild.members.cache.get(IDS.target) ?? null : null;
      return { ...base, value: IDS.target, user: world.users.target, member };
    }
    case ApplicationCommandOptionType.Channel: {
      if (!guild) return null;
      // A run in a channel of its own names that channel; every other run names the guild's first channel.
      const channel = context.optionChannel ?? guild.channels.cache.first();
      return { ...base, value: channel.id, channel };
    }
    case ApplicationCommandOptionType.Role: {
      if (!guild) return null;
      const role = guild.roles.cache.get(IDS.role);
      return { ...base, value: role.id, role };
    }
    case ApplicationCommandOptionType.Attachment:
      return { ...base, value: world.attachment.id, attachment: world.attachment };
    default:
      throw new Error(`The sweep cannot fill option type ${OPTION_TYPE_NAMES[option.type] || option.type}.`);
  }
}

// variant 'full' fills every option of the path; 'required' only the required ones; 'longest' and
// 'longest-required' do the same with free text at the longest length the option accepts and lists at their largest.
// `overrides` (by option name) replace a generated value, and an override of undefined leaves the option out.
function buildOptionValues(entry, context, { variant = 'full', overrides = {} } = {}) {
  const values = [];
  const requiredOnly = variant === 'required' || variant === 'longest-required';
  const optionContext = { ...context, longest: variant.startsWith('longest') };
  for (const option of entry.options) {
    if (requiredOnly && !option.required) continue;
    if (Object.hasOwn(overrides, option.name) && overrides[option.name] === undefined) continue;
    const generated = generateOptionValue(option, optionContext);
    if (!generated) continue;
    values.push(Object.hasOwn(overrides, option.name) ? { ...generated, value: overrides[option.name] } : generated);
  }
  return values;
}

// Whether a user can run `entry` in a direct message with the bot: the command is not limited to guilds, and no
// required option needs a guild channel or role.
function runsInDirectMessages(entry) {
  return entry.directMessages && !entry.options.some((option) => option.required &&
    [ApplicationCommandOptionType.Channel, ApplicationCommandOptionType.Role].includes(option.type));
}

function describeOptionValues(values) {
  return Object.fromEntries(values.map((option) => [option.name, option.value]));
}

// ---------------------------------------------------------------------------------------------------------
// Messages as discord.js would send them
// ---------------------------------------------------------------------------------------------------------

function snakeCase(value) {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
    key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`), snakeCase(inner),
  ]));
}

function toJsonComponent(value) {
  return typeof value?.toJSON === 'function' ? value.toJSON() : snakeCase(value);
}

// The body of a message from what a command passed to reply, editReply, followUp, update or send, the way
// discord.js's MessagePayload builds it. What discord.js itself refuses (content that is not text) throws here too.
// filesGiven says whether the files were given at all: an edit that leaves them out keeps the message's files, and
// `attachments: []` removes them.
function toMessageBody(options, method) {
  if (typeof options === 'string') return { content: options, files: [], filesGiven: false };
  if (!options || typeof options !== 'object') {
    throw new TypeError(`${method} was given ${options === null ? 'null' : typeof options} instead of message options`);
  }
  const body = { files: [], filesGiven: false };
  if (options.content === null) body.content = '';
  else if (options.content !== undefined) {
    if (typeof options.content !== 'string') {
      throw new RangeError(`${method}: message content must be a string (got ${typeof options.content})`);
    }
    body.content = options.content;
  }
  if (options.embeds !== undefined) body.embeds = options.embeds.map(toJsonComponent);
  if (options.components !== undefined) body.components = options.components.map(toJsonComponent);
  if (options.files !== undefined) {
    body.files = options.files.map((file) => ({ name: String(file?.name ?? file?.attachment?.name ?? 'file') }));
    body.filesGiven = true;
  } else if (Array.isArray(options.attachments) && options.attachments.length === 0) {
    body.filesGiven = true;
  }
  let flags = 0;
  if (options.flags !== undefined && options.flags !== null) {
    flags = Number(Array.isArray(options.flags)
      ? options.flags.reduce((sum, flag) => sum | Number(flag), 0)
      : typeof options.flags === 'object' && 'bitfield' in options.flags ? options.flags.bitfield : options.flags);
  }
  if (options.ephemeral) flags |= MessageFlags.Ephemeral;
  body.flags = flags;
  body.ephemeral = Boolean(flags & MessageFlags.Ephemeral);
  return body;
}

// Discord's limits for a message (https://discord.com/developers/docs/resources/message and .../components).
const LIMITS = Object.freeze({
  content: 2000, embeds: 10, embedTitle: 256, embedDescription: 4096, embedFields: 25, fieldName: 256,
  fieldValue: 1024, footer: 2048, author: 256, embedTotal: 6000, rows: 5, rowItems: 5, buttonLabel: 80,
  customId: 100, selectPlaceholder: 150, selectOptions: 25, selectOptionText: 100,
});

// Text a user must never see: values that were never filled in, raw objects and errors, stack traces, paths on disk
// and raw database errors.
const BROKEN_TEXT_PATTERNS = Object.freeze([
  ['undefined', /\bundefined\b/u],
  ['NaN', /\bNaN\b/u],
  ['[object …]', /\[object [A-Za-z]+\]/u],
  ['null', /\bnull\b/u],
  ['function', /\bfunction\b/u],
  ['stack trace', /(?:^|\n)\s*at\s+(?:async\s+)?\S+.*:\d+:\d+\)?/u],
  ['error class', /\b(?:[A-Z][A-Za-z]*)?Error(?:\s*\[[^\]]*\])?:\s/u],
  ['file path', /[A-Za-z]:\\|\\\\\?\\|(?<![\w./:-])\/(?:home|Users|tmp|var|usr|opt|root|private|mnt|srv)\/|node_modules|\bsrc[\\/][\w./\\-]+\.js\b|\.js:\d+/u],
  ['SQLITE_', /SQLITE_/u],
  ['raw SQLite error', /\bno such (?:table|column)\b|\bconstraint failed\b|near "[^"]*": syntax error/iu],
]);

function namesLocalDirectory(text) {
  return localDirectories.some((directory) => text.includes(directory) || text.includes(directory.replace(/\\/gu, '/')));
}

function collectEmbedTexts(embed) {
  return [embed?.title, embed?.description, embed?.footer?.text, embed?.author?.name,
    ...(embed?.fields || []).flatMap((field) => [field?.name, field?.value])].filter((text) => typeof text === 'string');
}

function collectComponentTexts(component) {
  const texts = [component?.label, component?.placeholder, component?.content, component?.title, component?.value]
    .filter((text) => typeof text === 'string');
  for (const option of component?.options || []) texts.push(...[option?.label, option?.description].filter(Boolean));
  for (const child of component?.components || []) texts.push(...collectComponentTexts(child));
  if (component?.accessory) texts.push(...collectComponentTexts(component.accessory));
  return texts;
}

function messageTexts(body) {
  return [
    ...(typeof body.content === 'string' ? [body.content] : []),
    ...(body.embeds || []).flatMap(collectEmbedTexts),
    ...(body.components || []).flatMap(collectComponentTexts),
  ];
}

function customIdsOf(body) {
  const found = [];
  const visit = (component) => {
    if (typeof component?.custom_id === 'string') found.push(component.custom_id);
    for (const child of component?.components || []) visit(child);
    if (component?.accessory) visit(component.accessory);
  };
  for (const component of body.components || []) visit(component);
  return found;
}

function checkComponents(components, where, problems, componentsV2) {
  const customIds = new Set();
  const visit = (component, label) => {
    if (typeof component?.custom_id === 'string') {
      if (component.custom_id.length === 0 || component.custom_id.length > LIMITS.customId) {
        problems.push(`${label}: custom_id length ${component.custom_id.length}`);
      }
      if (customIds.has(component.custom_id)) problems.push(`${label}: duplicate custom_id ${component.custom_id}`);
      customIds.add(component.custom_id);
    }
    if (component?.type === 2) {
      const isLink = component.style === 5;
      const isPremium = component.style === 6;
      if (!isPremium && !component.label && !component.emoji) problems.push(`${label}: button without label or emoji`);
      if (typeof component.label === 'string' && component.label.length > LIMITS.buttonLabel) {
        problems.push(`${label}: button label longer than ${LIMITS.buttonLabel}`);
      }
      if (isLink && (!component.url || component.custom_id)) problems.push(`${label}: link button needs a url and no custom_id`);
      if (!isLink && !isPremium && !component.custom_id) problems.push(`${label}: button without custom_id`);
    }
    if ([3, 5, 6, 7, 8].includes(component?.type)) {
      if (typeof component.placeholder === 'string' && component.placeholder.length > LIMITS.selectPlaceholder) {
        problems.push(`${label}: select placeholder too long`);
      }
      if (component.type === 3) {
        const options = component.options || [];
        if (options.length < 1 || options.length > LIMITS.selectOptions) problems.push(`${label}: ${options.length} select options`);
        for (const option of options) {
          if (!option?.label || option.label.length > LIMITS.selectOptionText ||
              !option?.value || option.value.length > LIMITS.selectOptionText ||
              (option.description && option.description.length > LIMITS.selectOptionText)) {
            problems.push(`${label}: select option outside Discord's limits`);
          }
        }
        if (Number.isInteger(component.max_values) && component.max_values > options.length) {
          problems.push(`${label}: max_values above the number of options`);
        }
      }
    }
    (component?.components || []).forEach((child, index) => visit(child, `${label}.${index}`));
    if (component?.accessory) visit(component.accessory, `${label}.accessory`);
  };
  if (!componentsV2) {
    if (components.length > LIMITS.rows) problems.push(`${where}: ${components.length} action rows`);
    components.forEach((row, index) => {
      if (row?.type !== 1) {
        problems.push(`${where}: top-level component ${index} is not an action row`);
        return;
      }
      const items = row.components || [];
      if (items.length < 1 || items.length > LIMITS.rowItems) problems.push(`${where}: action row ${index} holds ${items.length} components`);
      if (items.some((item) => item?.type !== 2) && items.length > 1) problems.push(`${where}: a select menu shares action row ${index}`);
    });
  }
  components.forEach((component, index) => visit(component, `${where}.components.${index}`));
}

// Writes down on the run what Discord would refuse and what a user should never read in a message that is about to
// become visible. Returns what Discord would refuse; the caller then fails the request the way Discord does.
function checkVisibleMessage(body, where, run) {
  const problems = [];
  const broken = [];
  const componentsV2 = Boolean(Number(body.flags || 0) & MessageFlags.IsComponentsV2);
  const content = typeof body.content === 'string' ? body.content : '';
  const embeds = body.embeds || [];
  const components = body.components || [];
  if (!componentsV2 && !content.trim() && embeds.length === 0 && components.length === 0 && (body.files || []).length === 0) {
    problems.push(`${where}: empty message (Discord refuses it)`);
  }
  if (content.length > LIMITS.content) problems.push(`${where}: content is ${content.length} characters (limit ${LIMITS.content})`);
  if (embeds.length > LIMITS.embeds) problems.push(`${where}: ${embeds.length} embeds`);
  let embedTotal = 0;
  embeds.forEach((embed, index) => {
    const label = `${where}.embeds.${index}`;
    const fields = embed?.fields || [];
    if ((embed?.title || '').length > LIMITS.embedTitle) problems.push(`${label}: title too long`);
    if ((embed?.description || '').length > LIMITS.embedDescription) problems.push(`${label}: description too long`);
    if (fields.length > LIMITS.embedFields) problems.push(`${label}: ${fields.length} fields`);
    fields.forEach((field, fieldIndex) => {
      if (typeof field?.name !== 'string' || field.name.length < 1 || field.name.length > LIMITS.fieldName) {
        problems.push(`${label}.fields.${fieldIndex}: name outside 1..${LIMITS.fieldName}`);
      }
      if (typeof field?.value !== 'string' || field.value.length < 1 || field.value.length > LIMITS.fieldValue) {
        problems.push(`${label}.fields.${fieldIndex}: value outside 1..${LIMITS.fieldValue}`);
      }
    });
    if ((embed?.footer?.text || '').length > LIMITS.footer) problems.push(`${label}: footer too long`);
    if ((embed?.author?.name || '').length > LIMITS.author) problems.push(`${label}: author too long`);
    embedTotal += collectEmbedTexts(embed).reduce((sum, text) => sum + text.length, 0);
  });
  if (embedTotal > LIMITS.embedTotal) problems.push(`${where}: embeds hold ${embedTotal} characters (limit ${LIMITS.embedTotal})`);
  checkComponents(components, where, problems, componentsV2);
  for (const text of messageTexts(body)) {
    for (const [name, pattern] of BROKEN_TEXT_PATTERNS) {
      if (pattern.test(text)) broken.push(`${where}: text shows ${name}: ${JSON.stringify(text.slice(0, 120))}`);
    }
    if (namesLocalDirectory(text)) broken.push(`${where}: text names a local directory: ${JSON.stringify(text.slice(0, 120))}`);
  }
  run.violations.push(...problems, ...broken);
  return problems;
}

// The error Discord answers a message it refuses with: 50006 for an empty message, 50035 for anything else.
function refusedByDiscord(problems) {
  const empty = problems.some((problem) => problem.includes('empty message'));
  return discordApiError(empty ? 50006 : 50035, empty ? 'Cannot send an empty message' : 'Invalid Form Body', 400);
}

// A modal as Discord receives it: its title, custom ID and text inputs, checked against Discord's limits.
function checkModal(modal, run) {
  const data = toJsonComponent(modal);
  const refused = [];
  const broken = [];
  if (!data?.custom_id || data.custom_id.length > LIMITS.customId) refused.push('showModal: custom_id outside 1..100');
  if (!data?.title || data.title.length > 45) refused.push('showModal: title outside 1..45');
  const rows = data?.components || [];
  if (rows.length < 1 || rows.length > 5) refused.push(`showModal: ${rows.length} rows`);
  const inputs = rows.flatMap((row) => row?.components || []);
  for (const input of inputs) {
    if (input?.type !== ComponentType.TextInput || !input.custom_id || !input.label || input.label.length > 45) {
      refused.push(`showModal: text input ${input?.custom_id ?? '?'} outside Discord's limits`);
    }
  }
  const texts = [data?.title, ...rows.flatMap(collectComponentTexts)].filter((text) => typeof text === 'string');
  for (const text of texts) {
    for (const [name, pattern] of BROKEN_TEXT_PATTERNS) {
      if (pattern.test(text)) broken.push(`showModal: text shows ${name}: ${JSON.stringify(text.slice(0, 120))}`);
    }
  }
  run.violations.push(...refused, ...broken);
  return { data, inputs, refused };
}

// ---------------------------------------------------------------------------------------------------------
// The interactions
// ---------------------------------------------------------------------------------------------------------

// `kind` is 'autocomplete' for a run that sends an autocomplete interaction (judged on its suggestion list), and
// 'answer' for every other run.
function beginRun({ path: commandPath, actor, variant, options, kind = 'answer' }) {
  const run = {
    path: commandPath,
    actor,
    variant,
    options,
    kind,
    events: [],
    protocol: [],
    violations: [],
    missing: [],
    effects: [],
    logs: [],
    unhandled: [],
    fetches: [],
    modals: [],
    thrown: null,
    startedAt: performance.now(),
    firstAnswerMs: null,
  };
  seedRandomness(`${commandPath}|${variant}`);
  tracker.run = run;
  return run;
}

function noteFirstAnswer(run) {
  if (run.firstAnswerMs === null) run.firstAnswerMs = Math.round(performance.now() - run.startedAt);
}

function finishRun(run) {
  if (tracker.run === run) tracker.run = null;
  return run;
}

// What every interaction has: who sent it from where, and the answers discord.js's InteractionResponses gives it. A
// component or a modal from a message also answers by updating that message (update, deferUpdate). `kind` is
// 'command', 'button', 'select' or 'modal'.
function createInteraction(world, { run, user, guild, channel, kind, sourceMessage = null, own = {} }) {
  const member = guild ? guild.members.cache.get(user.id) ?? null : null;
  const state = { deferred: false, replied: false, ephemeral: null, original: null };
  const id = nextSnowflake();
  const label = kind === 'command' ? 'interaction' : `${kind}Interaction`;
  let interaction = null;

  function refuse(code, method) {
    run.protocol.push(`${method}: ${code}`);
    return new DiscordjsError(DiscordjsErrorCodes[code]);
  }

  function original(body) {
    if (!state.original) {
      state.original = world.createMessage(channel, body, { author: world.botUser, ephemeral: state.ephemeral === true });
    }
    return state.original;
  }

  function answerValue(optionsGiven, message) {
    if (optionsGiven && typeof optionsGiven === 'object' && optionsGiven.withResponse) {
      return strict('interactionCallbackResponse', {
        interaction: strict('interactionCallback', { id, type: 4 }),
        resource: strict('interactionCallbackResource', { type: 4, message }),
      });
    }
    if (optionsGiven && typeof optionsGiven === 'object' && optionsGiven.fetchReply) return message;
    return strict('interactionResponse', { id, interaction, async fetch() { return state.original; } });
  }

  const responses = {
    // A message Discord refuses is not sent and leaves the interaction as it was, as with discord.js, where replied
    // and deferred change only after Discord accepted the request. The attempt is kept as "<method>:refused".
    async reply(optionsGiven) {
      if (state.deferred || state.replied) throw refuse('InteractionAlreadyReplied', 'reply');
      const body = toMessageBody(optionsGiven, 'reply');
      const refused = checkVisibleMessage(body, 'reply', run);
      if (refused.length > 0) {
        run.events.push({ method: 'reply:refused', body });
        throw refusedByDiscord(refused);
      }
      state.replied = true;
      state.ephemeral = body.ephemeral;
      noteFirstAnswer(run);
      run.events.push({ method: 'reply', body });
      return answerValue(optionsGiven, original(body));
    },
    async deferReply(optionsGiven = {}) {
      if (state.deferred || state.replied) throw refuse('InteractionAlreadyReplied', 'deferReply');
      const body = toMessageBody({ ...optionsGiven, content: undefined }, 'deferReply');
      state.deferred = true;
      state.ephemeral = body.ephemeral;
      noteFirstAnswer(run);
      run.events.push({ method: 'deferReply', body: { ephemeral: body.ephemeral } });
      return answerValue(optionsGiven, original({ content: '' }));
    },
    async editReply(optionsGiven) {
      if (!state.deferred && !state.replied) throw refuse('InteractionNotReplied', 'editReply');
      const body = toMessageBody(optionsGiven, 'editReply');
      const message = original({ content: '' });
      try {
        world.editMessage(message, body, 'editReply');
      } catch (error) {
        run.events.push({ method: 'editReply:refused', body });
        throw error;
      }
      run.events.push({ method: 'editReply', body: { ...body, ephemeral: state.ephemeral } });
      state.replied = true;
      return message;
    },
    async followUp(optionsGiven) {
      if (!state.deferred && !state.replied) throw refuse('InteractionNotReplied', 'followUp');
      const body = toMessageBody(optionsGiven, 'followUp');
      const refused = checkVisibleMessage(body, 'followUp', run);
      if (refused.length > 0) {
        run.events.push({ method: 'followUp:refused', body });
        throw refusedByDiscord(refused);
      }
      run.events.push({ method: 'followUp', body });
      state.replied = true;
      return world.createMessage(channel, body, { author: world.botUser, ephemeral: body.ephemeral });
    },
    async deleteReply() {
      if (!state.deferred && !state.replied) throw refuse('InteractionNotReplied', 'deleteReply');
      run.events.push({ method: 'deleteReply' });
    },
    async fetchReply() {
      if (!state.original) throw discordApiError(10008, 'Unknown Message');
      return state.original;
    },
  };
  if (kind !== 'modal') {
    // A modal cannot answer a modal: discord.js's ModalSubmitInteraction has no showModal.
    responses.showModal = async function showModal(modal) {
      if (state.deferred || state.replied) throw refuse('InteractionAlreadyReplied', 'showModal');
      const { data, inputs, refused } = checkModal(modal, run);
      if (refused.length > 0) {
        run.events.push({ method: 'showModal:refused', body: { title: data?.title || '' } });
        throw refusedByDiscord(refused);
      }
      state.replied = true;
      noteFirstAnswer(run);
      run.events.push({ method: 'showModal', body: { title: data?.title || '' } });
      run.modals.push({ customId: data.custom_id, title: data.title, inputs });
    };
  }
  if (sourceMessage) {
    // The message the component (or the modal's button) was on: update edits it in place.
    responses.update = async function update(optionsGiven) {
      if (state.deferred || state.replied) throw refuse('InteractionAlreadyReplied', 'update');
      const body = toMessageBody(optionsGiven, 'update');
      try {
        world.editMessage(sourceMessage, body, 'update');
      } catch (error) {
        run.events.push({ method: 'update:refused', body });
        throw error;
      }
      state.replied = true;
      state.original = sourceMessage;
      noteFirstAnswer(run);
      run.events.push({ method: 'update', body });
      return answerValue(optionsGiven, sourceMessage);
    };
    responses.deferUpdate = async function deferUpdate(optionsGiven = {}) {
      if (state.deferred || state.replied) throw refuse('InteractionAlreadyReplied', 'deferUpdate');
      state.deferred = true;
      state.original = sourceMessage;
      noteFirstAnswer(run);
      run.events.push({ method: 'deferUpdate' });
      return answerValue(optionsGiven, sourceMessage);
    };
  }

  const target = {
    id,
    applicationId: IDS.bot,
    token: `synthetic-sweep-token-${id}`,
    version: 1,
    locale: 'zh-TW',
    guildLocale: 'zh-TW',
    createdTimestamp: Date.now(),
    get createdAt() { return new Date(this.createdTimestamp); },
    client: world.client,
    // InteractionContextType: 0 a guild, 1 the bot's direct messages.
    context: guild ? 0 : 1,
    guildId: guild ? guild.id : null,
    guild: guild ?? null,
    channelId: channel.id,
    channel,
    user,
    member,
    memberPermissions: member ? member.permissions : null,
    appPermissions: computePermissions([PermissionFlagsBits.Administrator]),
    get deferred() { return state.deferred; },
    set deferred(value) { state.deferred = value; },
    get replied() { return state.replied; },
    set replied(value) { state.replied = value; },
    get ephemeral() { return state.ephemeral; },
    // The board runtime marks an interaction it deferred with this expando property; on a real interaction it reads
    // as undefined until then.
    __boardReplyDeferred: undefined,
    inGuild: () => Boolean(guild),
    inCachedGuild: () => Boolean(guild),
    inRawGuild: () => false,
    isRepliable: () => true,
    isCommand: () => kind === 'command',
    isChatInputCommand: () => kind === 'command',
    isContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isMessageComponent: () => kind === 'button' || kind === 'select',
    isAnySelectMenu: () => kind === 'select',
    isStringSelectMenu: () => kind === 'select',
    isUserSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isSelectMenu: () => kind === 'select',
    ...responses,
    ...own,
  };
  interaction = strict(label, target);
  return interaction;
}

// A ChatInputCommandInteraction for `entry`, sent by `user` in `guild`/`channel` with the option values `values`.
// With guild null it is sent in the user's direct messages with the bot: no guild, member or member permissions.
function createChatInputInteraction(world, { run, user, guild, channel, entry, values }) {
  const hoisted = values.map((value) => ({ ...value }));
  let optionTree = hoisted;
  if (entry.subcommand) {
    optionTree = [{ name: entry.subcommand, type: ApplicationCommandOptionType.Subcommand, options: hoisted }];
    if (entry.group) {
      optionTree = [{ name: entry.group, type: ApplicationCommandOptionType.SubcommandGroup, options: optionTree }];
    }
  }
  const resolved = {};
  const addResolved = (key, item) => {
    if (!item) return;
    resolved[key] ??= new Collection();
    resolved[key].set(item.id, item);
  };
  for (const value of hoisted) {
    addResolved('users', value.user);
    addResolved('members', value.member);
    addResolved('channels', value.channel);
    addResolved('roles', value.role);
    addResolved('attachments', value.attachment);
  }
  const options = strict('interaction.options', new CommandInteractionOptionResolver(world.client, optionTree, resolved));
  return createInteraction(world, {
    run, user, guild, channel, kind: 'command',
    own: {
      type: InteractionType.ApplicationCommand,
      commandType: ApplicationCommandType.ChatInput,
      commandId: `${IDS.bot.slice(0, -1)}8`,
      commandName: entry.commandName,
      commandGuildId: null,
      options,
      toString() { return `/${entry.key}`; },
    },
  });
}

// A button press or a string-select choice on `message`, by `user`. A component interaction has no command name and
// no options: on discord.js's MessageComponentInteraction those read as undefined.
function createComponentInteraction(world, { run, user, guild, channel, message, component, values = [] }) {
  const isSelect = component.type === ComponentType.StringSelect;
  return createInteraction(world, {
    run, user, guild, channel, kind: isSelect ? 'select' : 'button', sourceMessage: message,
    own: {
      type: InteractionType.MessageComponent,
      componentType: component.type,
      customId: component.custom_id,
      component,
      message,
      values: isSelect ? values : undefined,
      commandName: undefined,
      options: undefined,
      toString() { return component.custom_id; },
    },
  });
}

// The submission of a modal shown from a button on `message`, with `fieldValues` by text input custom ID. Like
// discord.js's ModalSubmitFields, asking for an input the modal does not have throws.
function createModalSubmitInteraction(world, { run, user, guild, channel, message, modal, fieldValues }) {
  const fieldCollection = new Collection(modal.inputs.map((input) => [input.custom_id, Object.freeze({
    type: ComponentType.TextInput, customId: input.custom_id, value: String(fieldValues[input.custom_id] ?? ''),
  })]));
  const fields = strict('modalInteraction.fields', {
    fields: fieldCollection,
    getField(customId) {
      const field = fieldCollection.get(customId);
      if (!field) throw new DiscordjsTypeError(DiscordjsErrorCodes.ModalSubmitInteractionFieldNotFound, customId);
      return field;
    },
    getTextInputValue(customId) {
      return this.getField(customId).value;
    },
  });
  return createInteraction(world, {
    run, user, guild, channel, kind: 'modal', sourceMessage: message,
    own: {
      type: InteractionType.ModalSubmit,
      customId: modal.customId,
      fields,
      message,
      isFromMessage: () => Boolean(message),
      commandName: undefined,
      options: undefined,
      toString() { return modal.customId; },
    },
  });
}

// Discord's limits for the answer to an autocomplete interaction: at most 25 choices, each with a name of 1 to 100
// characters and a value of the focused option's type, at most 100 characters for text
// (https://discord.com/developers/docs/interactions/application-commands, application command option choice).
const CHOICE_LIMITS = Object.freeze({ choices: 25, name: 100, value: 100 });

// Writes down on the run what Discord would refuse in a suggestion list and what a user should never read in a
// choice's name. Returns what Discord would refuse.
function checkChoices(choices, optionType, run) {
  const refused = [];
  const broken = [];
  if (!Array.isArray(choices)) {
    refused.push(`respond: the choices are ${choices === null ? 'null' : typeof choices}, not a list`);
  } else {
    if (choices.length > CHOICE_LIMITS.choices) {
      refused.push(`respond: ${choices.length} choices (limit ${CHOICE_LIMITS.choices})`);
    }
    choices.forEach((choice, index) => {
      const where = `respond: choice ${index}`;
      const name = choice?.name;
      if (typeof name !== 'string' || name.length < 1 || name.length > CHOICE_LIMITS.name) {
        refused.push(`${where}: name outside 1..${CHOICE_LIMITS.name} characters`);
      }
      const value = choice?.value;
      const fits = optionType === ApplicationCommandOptionType.String
        ? typeof value === 'string' && value.length <= CHOICE_LIMITS.value
        : typeof value === 'number' && Number.isFinite(value) &&
          (optionType !== ApplicationCommandOptionType.Integer || Number.isSafeInteger(value));
      if (!fits) refused.push(`${where}: value ${JSON.stringify(value)} does not fit a ${OPTION_TYPE_NAMES[optionType]} option`);
      if (typeof name !== 'string') return;
      for (const [label, pattern] of BROKEN_TEXT_PATTERNS) {
        if (pattern.test(name)) broken.push(`${where}: name shows ${label}: ${JSON.stringify(name.slice(0, 120))}`);
      }
      if (namesLocalDirectory(name)) broken.push(`${where}: name names a local directory`);
    });
  }
  run.violations.push(...refused, ...broken);
  return refused;
}

// An AutocompleteInteraction for `entry`, sent while `user` types: `values` are the options typed so far, as Discord
// sends them (raw values, nothing resolved), one of them marked `focused`. Like discord.js's, it answers only through
// respond(), once; the reply methods and the reply state of the other interactions are not there and read as
// undefined, as on discord.js.
function createAutocompleteInteraction(world, { run, user, guild, channel, entry, values }) {
  const member = guild ? guild.members.cache.get(user.id) ?? null : null;
  const state = { responded: false };
  const id = nextSnowflake();
  const focused = values.find((value) => value.focused);
  const hoisted = values.map((value) => ({ ...value }));
  let optionTree = hoisted;
  if (entry.subcommand) {
    optionTree = [{ name: entry.subcommand, type: ApplicationCommandOptionType.Subcommand, options: hoisted }];
    if (entry.group) {
      optionTree = [{ name: entry.group, type: ApplicationCommandOptionType.SubcommandGroup, options: optionTree }];
    }
  }
  const absent = Object.fromEntries(['reply', 'deferReply', 'editReply', 'followUp', 'deleteReply', 'fetchReply',
    'showModal', 'update', 'deferUpdate', 'deferred', 'replied', 'ephemeral'].map((name) => [name, undefined]));
  return strict('autocompleteInteraction', {
    ...absent,
    id,
    applicationId: IDS.bot,
    token: `synthetic-sweep-token-${id}`,
    version: 1,
    locale: 'zh-TW',
    guildLocale: 'zh-TW',
    createdTimestamp: Date.now(),
    get createdAt() { return new Date(this.createdTimestamp); },
    client: world.client,
    context: guild ? 0 : 1,
    guildId: guild ? guild.id : null,
    guild: guild ?? null,
    channelId: channel.id,
    channel,
    user,
    member,
    memberPermissions: member ? member.permissions : null,
    appPermissions: computePermissions([PermissionFlagsBits.Administrator]),
    type: InteractionType.ApplicationCommandAutocomplete,
    commandType: ApplicationCommandType.ChatInput,
    commandId: `${IDS.bot.slice(0, -1)}8`,
    commandName: entry.commandName,
    commandGuildId: null,
    options: strict('autocompleteInteraction.options', new CommandInteractionOptionResolver(world.client, optionTree, {})),
    get responded() { return state.responded; },
    set responded(value) { state.responded = value; },
    async respond(choices) {
      if (state.responded) {
        run.protocol.push('respond: InteractionAlreadyReplied');
        throw new DiscordjsError(DiscordjsErrorCodes.InteractionAlreadyReplied);
      }
      const refused = checkChoices(choices, focused?.type, run);
      if (refused.length > 0) {
        run.events.push({ method: 'respond:refused' });
        throw refusedByDiscord(refused);
      }
      state.responded = true;
      noteFirstAnswer(run);
      run.events.push({ method: 'respond', choices: choices.map((choice) => ({ name: choice.name, value: choice.value })) });
    },
    inGuild: () => Boolean(guild),
    inCachedGuild: () => Boolean(guild),
    inRawGuild: () => false,
    isRepliable: () => false,
    isCommand: () => false,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isAutocomplete: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isMessageComponent: () => false,
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isSelectMenu: () => false,
  });
}

// Lets promises the command started without awaiting them settle, so what they log or write lands on this run.
async function settle() {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------------------
// Judging one run
// ---------------------------------------------------------------------------------------------------------

// What a user saw: the text of every visible answer, in order.
function answerTexts(run) {
  return run.events
    .filter((event) => ['reply', 'editReply', 'followUp', 'update'].includes(event.method))
    .map((event) => messageTexts(event.body).join(' / '));
}

// What a command says when it could not do what was asked, whatever the cause: "cannot", "failed", "try again
// later", "cannot for now", "an error / a fault occurred". Any answer with one of these phrases is a failure, unless
// it is one of FRIENDLY_REFUSALS.
const FAILURE_PHRASES = Object.freeze([/無法/u, /失敗/u, /請稍後(?:再試|重試)/u, /暫時不能/u, /發生(?:錯誤|異常)/u]);
// Answers that use one of those phrases and are still right, with the reason: only the ones the sweep meets, each
// reviewed (a sentence of src that refuses what the rules do not allow, or gives a game's result, and hides no
// error). A new one is added here after the same review.
const FRIENDLY_REFUSALS = Object.freeze([
  ['活存餘額不足，無法建立定存。', '/bank fixed-create from the bank balance of a user who keeps nothing there'],
  ['目前無法判定，棋局已保留。', 'the turtle-soup verdict "cannot be determined" is an answer of the game (the sweep\'s '
    + 'judge gives it to every question and guess)'],
]);
// Answers that are right only when the network is down: the service a command calls could not be reached. They pass
// only on a run whose command may use the network and did; like FRIENDLY_REFUSALS, only the ones the sweep meets.
const OFFLINE_ANSWERS = Object.freeze([
  '臺灣天氣資料暫時無法查詢，請稍後再試。',
]);
// Answers that say the stored data or the system is in a broken state, whatever words they use.
const INTEGRITY_ANSWERS = Object.freeze([
  /無法安全讀寫/u, /請通知管理員/u, /無法驗證/u, /核對帳務/u, /請人工(?:核對|處理|對帳)/u, /請聯絡機器人擁有者/u,
  /尚未完成啟動/u,
]);

// Refusals a user may get, by kind: a server permission, the bot owner, a feature that only works in a server, or a
// game, hand or panel that belongs to someone else (its host, its players, the one who started it).
const REFUSALS = Object.freeze([
  ['permission', /權限才能使用|需要 (?:Administrator|Manage Server|管理)|管理員才能/u],
  ['owner', /你沒有權限使用這個指令|只有小吉擁有者|只有機器人擁有者|擁有者專用/u],
  ['guild-only', /只能在伺服器(?:文字頻道)?內(?:使用|設定|管理)/u],
  ['not-yours', /只有(?:房主|目前棋局的參與者|這局的建立者|開局的玩家)可以/u],
]);

// What a refused run (denied) may still change, with the reason. Nothing else: no other table, no file, no message,
// reaction, thread or REST request.
const REFUSAL_MAY_CHANGE = Object.freeze({
  feature_usage_daily: 'interactionCreate counts every interaction whose handler returned, a refusal included '
    + '(src/services/publicStatusService.js, recordPublicInteraction)',
});
const REFUSED_CATEGORIES = Object.freeze(['denied']);

const DEFECT_CATEGORIES = Object.freeze([
  'unhandled-exception', 'no-response', 'protocol-violation', 'command-failed', 'bad-content',
  'internal-error', 'unexpected-network', 'changed-on-refusal',
]);
const HARNESS_CATEGORIES = Object.freeze(['fake-insufficient']);

function errorSummary(error) {
  if (!error) return null;
  if (error instanceof Error) return `${error.name}${error.code ? `[${error.code}]` : ''}: ${error.message}`;
  return String(error);
}

function firstStackFrame(error) {
  const lines = String(error?.stack || '').split('\n').slice(1);
  const frame = lines.find((line) => /[\\/]src[\\/]/u.test(line)) || lines[0] || '';
  const match = frame.match(/([\\/]src[\\/][^:)]+):(\d+)/u);
  return match ? `src${match[1].replace(/\\/gu, '/').replace(/^\/src/u, '')}:${match[2]}` : null;
}

// The errors this run logged, with the error a command or the handler caught as the cause when there is one.
function loggedErrors(run) {
  return run.logs.filter((entry) => entry.level === 'error');
}

// The error codes that mean the user's request was refused by the rules or has nothing to show, reviewed one by one
// from the codes the sweep meets (the board and personal-game runtimes log every refusal with its code). An error
// logged with any other code, or with none (a TypeError, a raw database error), is a fault, and the run fails with
// the code in its message.
const DOMAIN_CODES = Object.freeze(new Set([
  // Nothing there: the session the control or the command names does not exist (any more).
  'SESSION_NOT_FOUND',
  // Already done: the channel holds a game, the user is in the lobby.
  'SESSION_ALREADY_ACTIVE', 'ALREADY_JOINED',
  // Not this user's to do: host-only controls, controls for the players of the game (the board's check and the
  // turtle-soup judge's) or the maker of a personal game, and moves out of turn.
  'HOST_ONLY', 'NOT_A_PLAYER', 'NOT_PARTICIPANT', 'NOT_OWNER', 'NOT_YOUR_TURN',
  // Against the rules of the game: an illegal move or input, a given sudoku cell, a draw claim the position does not
  // allow.
  'ACTION_NOT_LEGAL', 'INVALID_ACTION', 'GIVEN_LOCKED', 'CLAIM_NOT_AVAILABLE',
]));

function isDomainError(error) {
  return typeof error?.code === 'string' && DOMAIN_CODES.has(error.code);
}

// Warnings that do not mean a fault, with the reason; like DOMAIN_CODES, only the ones the sweep meets. Every other
// warning is one: what handleCommandError (src/utils/moderation.js) and the chain launchers log when they catch an
// error ("/command failed: …", "/board word-chain failed: CODE"), a store that could not be written, and so on.
const HARMLESS_WARNINGS = Object.freeze([
  [/^\[PERMISSION_BLOCK\] /u, 'the permission guard writes down whom it refused'],
  [/^weather command failed: provider_error$/u, 'the weather service was out of reach: only on a run whose command may '
    + 'reach the network and did (OFFLINE_ANSWERS)', 'offline'],
]);

// The warnings of the run that mean a fault. `offline` says whether the run's command may reach the network and did.
function faultWarnings(run, offline) {
  return run.logs.filter((entry) => entry.level === 'warn' && !HARMLESS_WARNINGS.some(([pattern, , when]) =>
    pattern.test(entry.message) && (when !== 'offline' || offline)));
}

function withoutSentences(text, sentences) {
  return sentences.reduce((remaining, sentence) => remaining.split(sentence).join(''), text);
}

function refusalOf(texts) {
  for (const [kind, pattern] of REFUSALS) {
    if (texts.some((text) => pattern.test(text))) return kind;
  }
  return null;
}

function describeEffect(effect) {
  return effect.kind === 'rest'
    ? `rest ${effect.method.toUpperCase()} ${effect.route.replace(/\d{17,20}/gu, ':id')}`
    : `${effect.kind}${effect.body?.files?.length ? ` (${effect.body.files.length} file)` : ''}`;
}

// The result of a run before it is judged: what the user saw (`texts`, the last one shown), and everything else the
// run did.
function baseResult(run, texts) {
  const lastText = texts.at(-1) ?? '';
  const result = {
    path: `/${run.path}`,
    actor: run.actor,
    variant: run.variant,
    category: 'ok',
    refusal: null,
    reply: lastText.replace(/\s+/gu, ' ').slice(0, 80),
    // How long the last answer was, in characters: the long-data pass checks that its lists really reached the limit.
    replyLength: lastText.length,
    detail: null,
    error: null,
    errorAt: null,
    options: run.options,
    // The interaction's answers in order (reply, deferReply, editReply, followUp, update, respond, ...), what else
    // reached the fake Discord (channel messages, message edits and reactions, REST requests of the side-effect
    // runtime), and the custom IDs of the components the answers show.
    answers: run.events.map((event) => event.method),
    effects: run.effects.map(describeEffect),
    customIds: [...new Set(run.events.filter((event) => event.body).flatMap((event) => customIdsOf(event.body)))].slice(0, 20),
    modals: run.modals.map((modal) => modal.title),
    // What the run changed in what the bot keeps: the tables it wrote (rows written by table), the files whose
    // content changed, and whether the database schema changed (createStateTracker).
    writes: null,
    // Warnings and errors the run logged (informational lines left out), and the hosts it asked the network for.
    logs: run.logs.filter((entry) => entry.level !== 'info').map((entry) => `${entry.level}: ${entry.message}`.slice(0, 200)),
    fetchedHosts: [...new Set(run.fetches.map((fetch) => fetch.host))],
    // Milliseconds from the start of the run to its first answer. Discord drops an interaction that is not answered
    // within 3 seconds; this is reported, not judged, because it depends on the machine.
    firstAnswerMs: run.firstAnswerMs ?? null,
  };
  const set = (category, detail = null, error = null) => {
    result.category = category;
    result.detail = detail;
    result.error = errorSummary(error);
    result.errorAt = error ? firstStackFrame(error) : null;
    return result;
  };
  return { result, set };
}

// What every run is judged on first, whatever answers it: a rejection, an unhandled rejection, a gap in the fake, an
// unexpected request to the network. Returns the result when one of them decides it.
function judgeFaults(run, result, set, networkAllowed) {
  if (run.thrown) return set('unhandled-exception', 'interactionCreate.execute rejected', run.thrown);
  if (run.unhandled.length > 0) return set('unhandled-exception', 'unhandled rejection during the run', run.unhandled[0]);
  if (run.missing.length > 0) {
    return set('fake-insufficient', [...new Set(run.missing)].join(', '), loggedErrors(run)[0]?.cause ?? null);
  }
  if (run.fetches.length > 0 && !networkAllowed) {
    return set('unexpected-network', `fetched ${result.fetchedHosts.join(', ')}`);
  }
  return null;
}

// Judges a run on what it answered. `networkAllowed` says whether the run's command is one that is meant to reach the
// network (the test names them).
function judgeAnswers(run, { networkAllowed = false }) {
  const texts = answerTexts(run);
  const lastText = texts.at(-1) ?? '';
  const answered = run.events.some((event) => ['reply', 'showModal', 'update', 'deferUpdate'].includes(event.method)) ||
    (run.events.some((event) => event.method === 'deferReply') &&
      run.events.some((event) => event.method === 'editReply' || event.method === 'followUp'));
  const errors = loggedErrors(run);
  const { result, set } = baseResult(run, texts);

  const fault = judgeFaults(run, result, set, networkAllowed);
  if (fault) return fault;
  // A message Discord refused, or text a user must not read, is the cause of whatever the command did next (a
  // fallback answer, the handler's failure answer, or none), so it is reported first, with what followed.
  if (run.violations.length > 0) {
    const followed = answered ? `then answered ${JSON.stringify(lastText.slice(0, 60))}` : 'and never answered';
    return set('bad-content', `${run.violations.join('; ')}; ${followed}`, errors[0]?.cause ?? null);
  }
  if (!answered) {
    const deferred = run.events.some((event) => event.method === 'deferReply');
    return set('no-response', deferred ? 'deferred and never answered' : 'never answered', errors[0]?.cause ?? null);
  }
  const followUps = run.events.filter((event) => event.method === 'followUp').length;
  if (run.protocol.length > 0 || followUps > 5) {
    return set('protocol-violation', run.protocol.join('; ') || `${followUps} follow-ups`, errors[0]?.cause ?? null);
  }
  if (texts.some((text) => text.includes(COMMAND_FAILED_MESSAGE))) {
    const handled = errors.find((entry) => / failed$/u.test(entry.message)) || errors[0];
    return set('command-failed', handled?.message ?? 'the handler answered with its failure message', handled?.cause ?? null);
  }
  const offline = networkAllowed && run.fetches.length > 0;
  const allowed = [...FRIENDLY_REFUSALS.map(([sentence]) => sentence), ...(offline ? OFFLINE_ANSWERS : [])];
  const failureText = texts.find((text) => {
    const remaining = withoutSentences(text, allowed);
    return FAILURE_PHRASES.some((pattern) => pattern.test(remaining)) ||
      INTEGRITY_ANSWERS.some((pattern) => pattern.test(remaining));
  });
  const warnings = faultWarnings(run, offline);
  const faults = errors.filter((entry) => !isDomainError(entry.cause));
  if (failureText || warnings.length > 0 || faults.length > 0) {
    const shown = faults[0] ?? errors[0];
    const detail = [failureText ? `answered ${JSON.stringify(failureText.slice(0, 80))}` : null,
      ...errors.map((entry) => `${entry.message}${entry.cause?.code ? ` (${entry.cause.code})` : ''}`),
      ...warnings.map((entry) => entry.message)].filter(Boolean).join('; ');
    return set('internal-error', detail, shown?.cause ?? null);
  }
  // A service error with a code that the command turned into a specific answer is a normal outcome; that it was
  // logged as an error is kept as a note.
  const note = errors.length > 0
    ? `logged ${errors.map((entry) => `${entry.message} (${entry.cause?.code})`).join('; ')}`
    : null;
  if (offline) return set('offline-unavailable', note);
  const refusal = refusalOf(texts);
  if (refusal) {
    result.refusal = refusal;
    return set('denied', note);
  }
  return set('ok', note);
}

// Judges an autocomplete run: its only answer is one suggestion list Discord accepts.
function judgeAutocomplete(run) {
  const responses = run.events.filter((event) => event.method === 'respond');
  const choices = responses[0]?.choices ?? [];
  const { result, set } = baseResult(run, [choices.map((choice) => choice.name).join(' / ')]);
  result.choices = choices.map((choice) => choice.value);
  const fault = judgeFaults(run, result, set, false);
  if (fault) return fault;
  if (run.violations.length > 0) return set('bad-content', run.violations.join('; '), loggedErrors(run)[0]?.cause ?? null);
  if (responses.length === 0) return set('no-response', 'never responded', loggedErrors(run)[0]?.cause ?? null);
  if (run.protocol.length > 0) return set('protocol-violation', run.protocol.join('; '));
  const errors = loggedErrors(run);
  const warnings = run.logs.filter((entry) => entry.level === 'warn');
  if (errors.length > 0 || warnings.length > 0) {
    return set('internal-error', [...errors, ...warnings].map((entry) => entry.message).join('; '), errors[0]?.cause ?? null);
  }
  return set('ok');
}

// Puts the changes of the run on its result and holds a refused run to having changed nothing beyond
// REFUSAL_MAY_CHANGE. `changes` is what createStateTracker saw;
// `sourceMessageChanged` says whether the message a pressed control was on now shows something else.
function judgeChanges(result, { changes, sourceMessageChanged = false }) {
  result.writes = {
    tables: changes.tables, files: changes.files, schemaChanged: changes.schemaChanged, sourceMessage: sourceMessageChanged,
  };
  if (!REFUSED_CATEGORIES.includes(result.category)) return result;
  const changed = changesBeyond(result, REFUSAL_MAY_CHANGE);
  if (changed.length === 0) return result;
  const was = `${result.category}${result.refusal ? ` (${result.refusal})` : ''}`;
  result.category = 'changed-on-refusal';
  result.detail = `${was}, yet changed ${changed.join(', ')}`;
  return result;
}

// What a judged run changed beyond the tables `allowed` names: messages, reactions, threads and REST requests, other
// tables, the schema, files, and the message its control was on.
function changesBeyond(result, allowed) {
  const { writes } = result;
  return [
    ...result.effects,
    ...Object.entries(writes.tables).filter(([table]) => !Object.hasOwn(allowed, table))
      .map(([table, rows]) => `table ${table} (${rows} rows written)`),
    ...(writes.schemaChanged ? ['the database schema'] : []),
    ...writes.files.map((file) => `file ${file}`),
    ...(writes.sourceMessage ? ['the message the control was on'] : []),
  ];
}

// Judges a finished run. `changes` (required) is what the run changed in what the bot keeps (createStateTracker's
// changesSince); see judgeAnswers, judgeAutocomplete and judgeChanges for the rest.
function classifyRun(run, options) {
  if (!options?.changes) throw new TypeError('classifyRun needs the changes of the run (createStateTracker)');
  const result = run.kind === 'autocomplete' ? judgeAutocomplete(run, options) : judgeAnswers(run, options);
  return judgeChanges(result, options);
}

module.exports = {
  COMMAND_FAILED_MESSAGE,
  DEFECT_CATEGORIES,
  FRIENDLY_REFUSALS,
  FakeNotImplementedError,
  HARNESS_CATEGORIES,
  IDS,
  REFUSAL_MAY_CHANGE,
  beginRun,
  buildOptionValues,
  captureLogger,
  captureUnhandledRejections,
  changesBeyond,
  classifyRun,
  closeSweepDatabase,
  componentsOf,
  createAutocompleteInteraction,
  createChatInputInteraction,
  createComponentInteraction,
  createMember,
  createModalSubmitInteraction,
  createStateTracker,
  createSweepEnvironment,
  createSweepWorld,
  createTextChannel,
  createUser,
  describeOptionValues,
  finishRun,
  flattenCommandPaths,
  installDeterministicRandomness,
  installOfflineFetch,
  noteEffect,
  openSweepDatabase,
  removeSweepEnvironment,
  runsInDirectMessages,
  settle,
  strict,
  tracker,
};
