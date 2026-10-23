'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEST_MODE = 'test-control';
const ID_PATTERN = /^\d{16,22}$/;
const REQUIRED_DATA_PATHS = Object.freeze([
  'COIN_DB_PATH',
  'XIAOJI_AUDIT_DATA_PATH',
  'XIAOJI_INVITER_WHITELIST_PATH',
  'XIAOJI_REMINDERS_PATH',
  'XIAOJI_CALENDAR_PATH',
  'AI_CONVERSATION_PATH',
  'XIAOJI_MEMORY_PATH',
]);
const RETAINED_DATA_FILES = Object.freeze(['guildConfig.json', 'polls.json', 'guildQuotas.json']);
// The most threads the test bot may open and use in one run (see claimOwnThreadRecorder).
const MAX_OWN_THREADS = 50;
// policy -> its own-thread recorder, until the test egress claims it (claimOwnThreadRecorder): the policy object itself
// only reads, so nothing else holding it can widen the scope.
const ownThreadRecorders = new WeakMap();
// A test data root is accepted only when it carries this marker, created for the same
// test application and bound to this exact directory (bigint dev:ino). Production data
// directories never carry it, so a trust file that points dataRoot at production data
// fails closed before any data path is used. The marker guards against configuration
// mistakes; it is not an access control.
const TEST_DATA_ROOT_MARKER = '.xiaoji-test-root.json';
const TEST_DATA_ROOT_MARKER_PURPOSE = 'xiaoji-test-control-data-root';
const TEST_DATA_ROOT_MARKER_SCHEMA_VERSION = 1;
const TEST_DATA_ROOT_MARKER_MAX_BYTES = 1024;
const TEST_DATA_ROOT_MARKER_KEYS = 'dataRootIdentity,expectedApplicationId,purpose,schemaVersion';
const SYNTHETIC_REGISTRY_SYMBOL = Symbol.for('xiaoji.liveTestSyntheticRegistry');
// File identity dev:ino where dev is unsigned and ino is signed (BigInt64Array).
// NTFS sequence >= 0x8000 reads as negative inode.
const DIRECTORY_IDENTITY_PATTERN = /^\d+:-?\d+$/;

class TestControlError extends Error {
  constructor(code) {
    super('Test control rejected the operation.');
    this.name = 'TestControlError';
    this.code = code;
  }
}

function fail(code) {
  throw new TestControlError(code);
}

function parseList(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function requireIds(value, code, { allowEmpty = false } = {}) {
  const values = parseList(value);
  if ((!allowEmpty && values.length === 0) || values.some((item) => !ID_PATTERN.test(item))) fail(code);
  return new Set(values);
}

function pathIdentity(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assertRealDirectory(value, code) {
  if (!value || !path.isAbsolute(value)) fail(code);
  let stat;
  try { stat = fs.lstatSync(value); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  const real = fs.realpathSync.native(value);
  if (pathIdentity(real) !== pathIdentity(value)) fail(code);
  return real;
}

// File identity is compared only as exact bigint dev/ino. Windows file IDs exceed 2^53,
// so Number stats can make two different files look identical (a spurious alias).
function readBigintLstat(target) {
  return fs.lstatSync(target, { bigint: true });
}

function exactFileIdentity(stat, code) {
  if (typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint') fail(code);
  return `${stat.dev}:${stat.ino}`;
}

function assertRealFileInside(root, value, code, lstat = readBigintLstat) {
  if (!value || !path.isAbsolute(value)) fail(code);
  let stat;
  try { stat = lstat(value); } catch { fail(code); }
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) > 1) fail(code);
  const real = fs.realpathSync.native(value);
  if (!isInside(root, real)) fail(code);
  return { real, identity: exactFileIdentity(stat, code) };
}

// File ID 0 and the all-ones value (FILE_INVALID_FILE_ID, which some volumes report when
// they have no usable 64-bit ID) cannot identify a directory.
const UNUSABLE_DIRECTORY_INODE = 0xFFFFFFFFFFFFFFFFn;

// The data root's own bigint dev:ino. On local NTFS it survives renames and moves within
// one volume, but a copy, a backup restore, or a move to another volume yields a new
// identity.
function readDataRootIdentity(dataRoot, lstat = readBigintLstat) {
  let stat;
  try { stat = lstat(dataRoot); } catch { fail('TEST_DATA_ROOT_INVALID'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('TEST_DATA_ROOT_INVALID');
  const identity = exactFileIdentity(stat, 'TEST_DATA_ROOT_INVALID');
  // Node's bigint stat is signed (BigInt64Array). Convert to unsigned to handle NTFS
  // file numbers where sequence >= 0x8000 reads as negative.
  const ino = BigInt.asUintN(64, stat.ino);
  if (ino === 0n || ino === UNUSABLE_DIRECTORY_INODE) fail('TEST_DATA_ROOT_INVALID');
  return identity;
}

function serializeTestDataRootMarker(expectedApplicationId, dataRootIdentity) {
  return `${JSON.stringify({
    schemaVersion: TEST_DATA_ROOT_MARKER_SCHEMA_VERSION,
    purpose: TEST_DATA_ROOT_MARKER_PURPOSE,
    expectedApplicationId,
    dataRootIdentity,
  }, null, 2)}\n`;
}

function readMarkerText(markerPath, expectedIdentity) {
  let descriptor;
  try {
    descriptor = fs.openSync(markerPath, 'r');
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || exactFileIdentity(stat, 'TEST_DATA_ROOT_MARKER_INVALID') !== expectedIdentity ||
        stat.size > TEST_DATA_ROOT_MARKER_MAX_BYTES) fail('TEST_DATA_ROOT_MARKER_INVALID');
    const buffer = Buffer.alloc(TEST_DATA_ROOT_MARKER_MAX_BYTES + 1);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count > TEST_DATA_ROOT_MARKER_MAX_BYTES) fail('TEST_DATA_ROOT_MARKER_INVALID');
    return buffer.subarray(0, count).toString('utf8');
  } catch (error) {
    if (error instanceof TestControlError) throw error;
    return fail('TEST_DATA_ROOT_MARKER_INVALID');
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
  }
}

// dataRoot must already be a canonical real directory. The marker must be a plain,
// single-link regular file directly inside it, with a closed schema, an application ID
// equal to the expected test application, and the identity of this same directory.
function assertTestDataRootMarker(dataRoot, expectedApplicationId, { lstat = readBigintLstat } = {}) {
  const markerPath = path.join(dataRoot, TEST_DATA_ROOT_MARKER);
  let linkStat;
  try { linkStat = lstat(markerPath); } catch (error) {
    fail(error?.code === 'ENOENT' ? 'TEST_DATA_ROOT_MARKER_MISSING' : 'TEST_DATA_ROOT_MARKER_INVALID');
  }
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || Number(linkStat.nlink) > 1 ||
      linkStat.size > TEST_DATA_ROOT_MARKER_MAX_BYTES) fail('TEST_DATA_ROOT_MARKER_INVALID');
  const identity = exactFileIdentity(linkStat, 'TEST_DATA_ROOT_MARKER_INVALID');
  let real;
  try { real = fs.realpathSync.native(markerPath); } catch { fail('TEST_DATA_ROOT_MARKER_INVALID'); }
  if (pathIdentity(real) !== pathIdentity(markerPath)) fail('TEST_DATA_ROOT_MARKER_INVALID');
  let marker;
  try { marker = JSON.parse(readMarkerText(markerPath, identity).replace(/^\uFEFF/u, '')); } catch (error) {
    if (error instanceof TestControlError) throw error;
    fail('TEST_DATA_ROOT_MARKER_INVALID');
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
      Object.keys(marker).sort().join(',') !== TEST_DATA_ROOT_MARKER_KEYS ||
      marker.schemaVersion !== TEST_DATA_ROOT_MARKER_SCHEMA_VERSION ||
      marker.purpose !== TEST_DATA_ROOT_MARKER_PURPOSE ||
      typeof marker.expectedApplicationId !== 'string' || !ID_PATTERN.test(marker.expectedApplicationId) ||
      typeof marker.dataRootIdentity !== 'string' || !DIRECTORY_IDENTITY_PATTERN.test(marker.dataRootIdentity)) {
    fail('TEST_DATA_ROOT_MARKER_INVALID');
  }
  if (marker.expectedApplicationId !== String(expectedApplicationId || '')) fail('TEST_DATA_ROOT_MARKER_MISMATCH');
  if (marker.dataRootIdentity !== readDataRootIdentity(dataRoot, lstat)) {
    fail('TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH');
  }
  return { real, identity };
}

function assertTestDataRootDirectory({ dataRoot, expectedApplicationId }) {
  if (!ID_PATTERN.test(String(expectedApplicationId || ''))) fail('TEST_EXPECTED_APP_REQUIRED');
  return assertRealDirectory(String(dataRoot || ''), 'TEST_DATA_ROOT_INVALID');
}

// The main checkout keeps a .git directory and every linked worktree a .git file. Any
// .git file or link, or a non-empty .git directory, marks a checkout; an empty .git
// directory is not a repository for Git either, so it alone does not.
function hasRepositoryMarker(directory) {
  const candidate = path.join(directory, '.git');
  let stat;
  try { stat = fs.lstatSync(candidate); } catch (error) {
    return !['ENOENT', 'ENOTDIR'].includes(error?.code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  try { return fs.readdirSync(candidate).length > 0; } catch { return true; }
}

// A test data root must not be, or sit below, any Git checkout (main or worktree).
function assertDataRootOutsideRepository(dataRoot) {
  for (let directory = path.resolve(dataRoot); ; directory = path.dirname(directory)) {
    if (hasRepositoryMarker(directory)) fail('TEST_DATA_ROOT_IN_REPOSITORY');
    if (path.dirname(directory) === directory) return;
  }
}

// Launcher-side gate shared by start and deploy: the trusted dataRoot must be a real
// directory outside every Git checkout that carries a marker for the trusted test
// application and for this same directory.
function assertTestDataRoot({ dataRoot, expectedApplicationId }) {
  const real = assertTestDataRootDirectory({ dataRoot, expectedApplicationId });
  assertDataRootOutsideRepository(real);
  assertTestDataRootMarker(real, expectedApplicationId);
  return real;
}

function assertDataRootOutsideProject(dataRoot, projectRoot) {
  if (pathIdentity(dataRoot) === pathIdentity(projectRoot) || isInside(projectRoot, dataRoot) ||
      isInside(dataRoot, projectRoot)) {
    fail('TEST_DATA_ROOT_IN_WORKTREE');
  }
}

function createReporter(logger = console) {
  const seen = new Map();
  return Object.freeze({
    deny(code, operation) {
      const safeCode = /^[A-Z0-9_]+$/.test(code) ? code : 'TEST_CONTROL_DENIED';
      const safeOperation = /^[a-z0-9_]+$/.test(operation) ? operation : 'unknown';
      const key = `${safeCode}:${safeOperation}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      if (seen.get(key) === 1) logger.warn(`[TEST_CONTROL] code=${safeCode} operation=${safeOperation}`);
    },
    count(code, operation) { return seen.get(`${code}:${operation}`) || 0; },
  });
}

// The private synthetic harness is never part of this module's require graph. When it is not
// preloaded (all normal starts), this lookup is a no-op. The harness still has to prove the same
// data root and test application before a generated actor becomes admissible.
function allowsSyntheticActor(policy, id) {
  const registry = globalThis[SYNTHETIC_REGISTRY_SYMBOL];
  if (!registry || registry.active !== true || registry.dataRoot !== policy.dataRoot ||
      registry.expectedApplicationId !== policy.expectedApplicationId || typeof registry.allowsActor !== 'function') {
    return false;
  }
  try { return registry.allowsActor(String(id || '')) === true; } catch { return false; }
}

function hasAnyMarker(env) {
  return [env.XIAOJI_RUNTIME_MODE, env.XIAOJI_TEST_MODE, env.XIAOJI_TEST_LAUNCHER]
    .some((value) => String(value || '').trim() !== '');
}

function loadTestControlPolicy(env = process.env, {
  cwd = process.cwd(),
  logger = console,
  lstat = readBigintLstat,
} = {}) {
  if (!hasAnyMarker(env)) return null;
  if (env.XIAOJI_RUNTIME_MODE !== TEST_MODE || env.XIAOJI_TEST_MODE !== 'true' ||
      env.XIAOJI_TEST_LAUNCHER !== 'true') fail('TEST_LAUNCHER_REQUIRED');
  if (String(env.AUTO_DEPLOY_COMMANDS || '').toLowerCase() === 'true') fail('TEST_AUTO_DEPLOY_FORBIDDEN');
  if (env.XIAOJI_PRIVATE_EXTENSION_PATH || env.XIAOJI_EXTENSION_ASSEMBLY_MANIFEST_PATH) {
    fail('TEST_PRIVATE_EXTENSION_FORBIDDEN');
  }
  if (!String(env.BOT_OWNER_ID || env.OWNER_ID || '').trim()) fail('TEST_OWNER_REQUIRED');

  const expectedApplicationId = String(env.XIAOJI_TEST_EXPECTED_APPLICATION_ID || '').trim();
  if (!ID_PATTERN.test(expectedApplicationId)) fail('TEST_EXPECTED_APP_REQUIRED');
  const forbiddenApplicationIds = requireIds(env.XIAOJI_TEST_FORBIDDEN_APPLICATION_IDS,
    'TEST_FORBIDDEN_APPS_REQUIRED');
  if (forbiddenApplicationIds.has(expectedApplicationId)) fail('TEST_EXPECTED_APP_FORBIDDEN');

  const allowedGuildIds = requireIds(env.XIAOJI_TEST_ALLOWED_GUILD_IDS, 'TEST_GUILD_ALLOWLIST_REQUIRED');
  const allowedChannelIds = requireIds(env.XIAOJI_TEST_ALLOWED_CHANNEL_IDS, 'TEST_CHANNEL_ALLOWLIST_REQUIRED');
  const allowedActorIds = requireIds(env.XIAOJI_TEST_ALLOWED_ACTOR_IDS, 'TEST_ACTOR_ALLOWLIST_REQUIRED');
  const allowedCommands = new Set(parseList(env.XIAOJI_TEST_ALLOWED_COMMANDS));
  const allowedComponentPrefixes = new Set(parseList(env.XIAOJI_TEST_ALLOWED_COMPONENT_PREFIXES));
  const allowedMessageFeatures = new Set(parseList(env.XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES));
  const allowedEvents = new Set(parseList(env.XIAOJI_TEST_ALLOWED_EVENTS));
  const allowedJobs = new Set(parseList(env.XIAOJI_TEST_ALLOWED_JOBS));

  if (['mention', 'conversation'].some((name) => allowedMessageFeatures.has(name)) &&
      !env.OPENAI_API_KEY && !env.GROQ_API_KEY && (!env.ANTHROPIC_API_KEY || /^your_/iu.test(env.ANTHROPIC_API_KEY))) {
    fail('TEST_AI_PROVIDER_REQUIRED');
  }
  if (allowedCommands.has('weather') && !env.CWA_API_KEY && !env.OPENWEATHER_API_KEY) {
    fail('TEST_WEATHER_PROVIDER_REQUIRED');
  }

  const dataRoot = assertRealDirectory(String(env.XIAOJI_TEST_DATA_ROOT || ''), 'TEST_DATA_ROOT_INVALID');
  if (pathIdentity(env.XIAOJI_DATA_ROOT || '') !== pathIdentity(dataRoot)) fail('TEST_DATA_ROOT_MISMATCH');
  assertDataRootOutsideProject(dataRoot, cwd);
  assertDataRootOutsideRepository(dataRoot);
  const marker = assertTestDataRootMarker(dataRoot, expectedApplicationId, { lstat });

  // Seed with the marker so no data path can overwrite it.
  const pathIdentities = new Set([pathIdentity(marker.real)]);
  const fileIdentities = new Set([marker.identity]);
  for (const name of REQUIRED_DATA_PATHS) {
    const descriptor = assertRealFileInside(dataRoot, String(env[name] || ''), 'TEST_DATA_PATH_INVALID', lstat);
    const normalized = pathIdentity(descriptor.real);
    if (pathIdentities.has(normalized) || fileIdentities.has(descriptor.identity)) fail('TEST_DATA_PATH_ALIAS');
    pathIdentities.add(normalized);
    fileIdentities.add(descriptor.identity);
  }
  for (const name of RETAINED_DATA_FILES) {
    const descriptor = assertRealFileInside(dataRoot, path.join(dataRoot, name), 'TEST_DATA_PATH_INVALID', lstat);
    const normalized = pathIdentity(descriptor.real);
    if (pathIdentities.has(normalized) || fileIdentities.has(descriptor.identity)) fail('TEST_DATA_PATH_ALIAS');
    pathIdentities.add(normalized);
    fileIdentities.add(descriptor.identity);
  }
  if (env.XIAOJI_ARCHIVE_DB_PATH) {
    const descriptor = assertRealFileInside(dataRoot, env.XIAOJI_ARCHIVE_DB_PATH, 'TEST_DATA_PATH_INVALID', lstat);
    const normalized = pathIdentity(descriptor.real);
    if (pathIdentities.has(normalized) || fileIdentities.has(descriptor.identity)) fail('TEST_DATA_PATH_ALIAS');
  } else if (env.XIAOJI_ARCHIVE_CAPTURE_ENABLED === 'true') {
    fail('TEST_ARCHIVE_PATH_REQUIRED');
  }
  if (env.TURTLE_SOUP_CORPUS_ROOT) {
    const corpusRoot = assertRealDirectory(env.TURTLE_SOUP_CORPUS_ROOT, 'TEST_CORPUS_ROOT_INVALID');
    if (!isInside(dataRoot, corpusRoot)) fail('TEST_CORPUS_ROOT_INVALID');
  }

  const reporter = createReporter(logger);
  // Threads the test bot itself opened in an allowed channel during this run (testControlEgress.js records them from
  // Discord's answer to the thread creation): in scope like their parent channel. Kept only in memory for this run,
  // at most MAX_OWN_THREADS, never written to the trust file; a thread anyone else opened stays out of scope.
  const ownThreads = new Map();
  const policy = {
    mode: TEST_MODE,
    expectedApplicationId,
    forbiddenApplicationIds,
    allowedGuildIds,
    allowedChannelIds,
    allowedActorIds,
    allowedCommands,
    allowedComponentPrefixes,
    allowedMessageFeatures,
    allowedEvents,
    allowedJobs,
    dataRoot,
    reporter,
    allowsGuild(id) { return allowedGuildIds.has(String(id || '')); },
    allowsChannel(id) {
      const channel = String(id || '');
      return allowedChannelIds.has(channel) || ownThreads.has(channel);
    },
    hasOwnThreadRoom() { return ownThreads.size < MAX_OWN_THREADS; },
    allowsActor(id) { return allowedActorIds.has(String(id || '')) || allowsSyntheticActor(policy, id); },
    allowsCommand(name) { return allowedCommands.has(String(name || '')); },
    allowsComponent(customId) {
      return [...allowedComponentPrefixes].some((prefix) => String(customId || '').startsWith(prefix));
    },
    allowsMessageFeature(name) { return allowedMessageFeatures.has(String(name || '')); },
    allowsEvent(name) { return allowedEvents.has(String(name || '')); },
    allowsJob(name) { return allowedJobs.has(String(name || '')); },
    assertIdentity({ configuredClientId, applicationId, botUserId }) {
      const ids = [configuredClientId, applicationId, botUserId].map((value) => String(value || ''));
      if (ids.some((id) => forbiddenApplicationIds.has(id))) fail('TEST_FORMAL_APP_FORBIDDEN');
      if (ids.some((id) => id !== expectedApplicationId)) fail('TEST_APP_IDENTITY_MISMATCH');
      return true;
    },
    assertReady(client) {
      policy.assertIdentity({
        configuredClientId: expectedApplicationId,
        applicationId: client?.application?.id || expectedApplicationId,
        botUserId: client?.user?.id,
      });
      const joined = [...(client?.guilds?.cache?.keys?.() || [])].map(String);
      if (joined.some((id) => !allowedGuildIds.has(id)) ||
          [...allowedGuildIds].some((id) => !joined.includes(id))) fail('TEST_READY_GUILD_MISMATCH');
      return true;
    },
  };
  // A thread joins the scope only when the test bot owns it, its parent is an allowed channel (not another thread)
  // and its guild is allowed. Returns whether it is in scope.
  function recordOwnThread({ threadId, parentId, guildId, ownerId } = {}) {
    const thread = String(threadId || '');
    const parent = String(parentId || '');
    if (!ID_PATTERN.test(thread) || !allowedChannelIds.has(parent) || !allowedGuildIds.has(String(guildId || '')) ||
        String(ownerId || '') !== expectedApplicationId) {
      return false;
    }
    if (allowedChannelIds.has(thread) || ownThreads.has(thread)) return true;
    if (ownThreads.size >= MAX_OWN_THREADS) {
      reporter.deny('TEST_OWN_THREAD_LIMIT', 'thread_scope');
      return false;
    }
    ownThreads.set(thread, parent);
    return true;
  }
  const frozen = Object.freeze(policy);
  ownThreadRecorders.set(frozen, recordOwnThread);
  return frozen;
}

async function preflightTestIdentity({ policy, rest, configuredClientId, Routes }) {
  if (!policy) return null;
  const application = await rest.get(Routes.oauth2CurrentApplication());
  const user = await rest.get(Routes.user('@me'));
  policy.assertIdentity({ configuredClientId, applicationId: application?.id, botUserId: user?.id });
  for (const guildId of policy.allowedGuildIds) await rest.get(Routes.guild(guildId));
  for (const channelId of policy.allowedChannelIds) {
    const channel = await rest.get(Routes.channel(channelId));
    if (!policy.allowsGuild(channel?.guild_id)) fail('TEST_CHANNEL_GUILD_MISMATCH');
  }
  return true;
}

// The own-thread recorder of a policy, for the one test egress that installs it; null for anyone after it.
function claimOwnThreadRecorder(policy) {
  const recorder = ownThreadRecorders.get(policy) || null;
  ownThreadRecorders.delete(policy);
  return recorder;
}

function getTestControlPolicy(client) {
  return client?.testControlPolicy || null;
}

module.exports = {
  REQUIRED_DATA_PATHS,
  RETAINED_DATA_FILES,
  TEST_DATA_ROOT_MARKER,
  TEST_MODE,
  TestControlError,
  SYNTHETIC_REGISTRY_SYMBOL,
  assertDataRootOutsideProject,
  assertDataRootOutsideRepository,
  assertTestDataRoot,
  assertTestDataRootDirectory,
  assertTestDataRootMarker,
  claimOwnThreadRecorder,
  createReporter,
  getTestControlPolicy,
  allowsSyntheticActor,
  loadTestControlPolicy,
  preflightTestIdentity,
  readDataRootIdentity,
  serializeTestDataRootMarker,
};
