'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { SAFE_CODES, safeControlLine } = require('../src/platform/testControlProtocol');
const {
  TEST_DATA_ROOT_MARKER,
  assertDataRootOutsideProject,
  assertDataRootOutsideRepository,
  assertTestDataRoot,
  assertTestDataRootDirectory,
  assertTestDataRootMarker,
  readDataRootIdentity,
  serializeTestDataRootMarker,
} = require('../src/platform/testControlPolicy');
const { runStartLauncher } = require('./test-control-supervisor');

const SAFE_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR',
]);
const TRUST_OWNED_CONFIG_KEYS = new Set([
  'XIAOJI_RUNTIME_MODE', 'XIAOJI_TEST_MODE', 'XIAOJI_TEST_LAUNCHER',
  'XIAOJI_TEST_EXPECTED_APPLICATION_ID', 'XIAOJI_TEST_FORBIDDEN_APPLICATION_IDS',
  'XIAOJI_TEST_ALLOWED_GUILD_IDS', 'XIAOJI_TEST_ALLOWED_CHANNEL_IDS',
  'XIAOJI_TEST_ALLOWED_ACTOR_IDS', 'XIAOJI_TEST_ALLOWED_COMMANDS',
  'XIAOJI_TEST_ALLOWED_COMPONENT_PREFIXES', 'XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES',
  'XIAOJI_TEST_ALLOWED_EVENTS', 'XIAOJI_TEST_ALLOWED_JOBS', 'XIAOJI_TEST_DATA_ROOT',
  'XIAOJI_DATA_ROOT', 'XIAOJI_TEST_CONTROL_SESSION', 'XIAOJI_TEST_OWNER_SESSION',
]);
const FORBIDDEN_CHILD_KEYS = new Set(['NODE_OPTIONS', 'NODE_PATH', 'INIT_CWD']);

function fixedError(code) {
  const error = new Error('Test-control launcher rejected the configuration.');
  error.code = code;
  return error;
}

function readRealFile(filePath, code) {
  if (!path.isAbsolute(filePath || '')) throw fixedError(code);
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw fixedError(code); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131_072) throw fixedError(code);
  if (path.resolve(fs.realpathSync.native(filePath)) !== path.resolve(filePath)) throw fixedError(code);
  return fs.readFileSync(filePath);
}

function parseArgs(args) {
  const result = { action: args[0], configPath: null, trustPath: null };
  if (!['start', 'deploy', 'init-data-root'].includes(result.action)) throw fixedError('TEST_LAUNCH_ACTION_INVALID');
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw fixedError('TEST_LAUNCH_ARGUMENT_INVALID');
    if (flag === '--config') result.configPath = value;
    else if (flag === '--trust') result.trustPath = value;
    else throw fixedError('TEST_LAUNCH_ARGUMENT_INVALID');
  }
  if (result.action === 'init-data-root') {
    // Marker creation reads only the trust file; it never needs the token-bearing config.
    if (result.configPath) throw fixedError('TEST_LAUNCH_ARGUMENT_INVALID');
    if (!result.trustPath) throw fixedError('TEST_LAUNCH_ARGUMENT_REQUIRED');
    return result;
  }
  if (!result.configPath || !result.trustPath) throw fixedError('TEST_LAUNCH_ARGUMENT_REQUIRED');
  return result;
}

function arrayOfStrings(value, name, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0) ||
      value.some((item) => typeof item !== 'string' || !item.trim())) throw fixedError(name);
  return value.map((item) => item.trim());
}

function readTrust(trustPath) {
  let trust;
  try { trust = JSON.parse(readRealFile(trustPath, 'TEST_TRUST_FILE_INVALID').toString('utf8')); }
  catch (error) { if (error.code) throw error; throw fixedError('TEST_TRUST_FILE_INVALID'); }
  if (trust?.schemaVersion !== 1 || typeof trust.expectedApplicationId !== 'string' ||
      typeof trust.dataRoot !== 'string') throw fixedError('TEST_TRUST_SCHEMA_INVALID');
  return Object.freeze({
    expectedApplicationId: trust.expectedApplicationId.trim(),
    forbiddenApplicationIds: arrayOfStrings(trust.forbiddenApplicationIds, 'TEST_TRUST_SCHEMA_INVALID', { required: true }),
    allowedGuildIds: arrayOfStrings(trust.allowedGuildIds, 'TEST_TRUST_SCHEMA_INVALID', { required: true }),
    allowedChannelIds: arrayOfStrings(trust.allowedChannelIds, 'TEST_TRUST_SCHEMA_INVALID', { required: true }),
    allowedActorIds: arrayOfStrings(trust.allowedActorIds, 'TEST_TRUST_SCHEMA_INVALID', { required: true }),
    allowedCommands: arrayOfStrings(trust.allowedCommands || [], 'TEST_TRUST_SCHEMA_INVALID'),
    allowedComponentPrefixes: arrayOfStrings(trust.allowedComponentPrefixes || [], 'TEST_TRUST_SCHEMA_INVALID'),
    allowedMessageFeatures: arrayOfStrings(trust.allowedMessageFeatures || [], 'TEST_TRUST_SCHEMA_INVALID'),
    allowedEvents: arrayOfStrings(trust.allowedEvents || [], 'TEST_TRUST_SCHEMA_INVALID'),
    allowedJobs: arrayOfStrings(trust.allowedJobs || [], 'TEST_TRUST_SCHEMA_INVALID'),
    dataRoot: trust.dataRoot,
  });
}

function buildChildEnvironment({ parentEnv = process.env, config, trust }) {
  for (const key of Object.keys(config)) {
    const normalized = key.toUpperCase();
    if (TRUST_OWNED_CONFIG_KEYS.has(normalized)) throw fixedError('TEST_CONFIG_TRUST_COLLISION');
    if (FORBIDDEN_CHILD_KEYS.has(normalized) || normalized.startsWith('NPM_CONFIG_')) {
      throw fixedError('TEST_CONFIG_PROCESS_OPTION_FORBIDDEN');
    }
  }
  const child = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SAFE_PARENT_KEYS.has(key.toUpperCase())) child[key] = value;
  }
  Object.assign(child, config, {
    XIAOJI_RUNTIME_MODE: 'test-control',
    XIAOJI_TEST_MODE: 'true',
    XIAOJI_TEST_LAUNCHER: 'true',
    XIAOJI_TEST_EXPECTED_APPLICATION_ID: trust.expectedApplicationId,
    XIAOJI_TEST_FORBIDDEN_APPLICATION_IDS: trust.forbiddenApplicationIds.join(','),
    XIAOJI_TEST_ALLOWED_GUILD_IDS: trust.allowedGuildIds.join(','),
    XIAOJI_TEST_ALLOWED_CHANNEL_IDS: trust.allowedChannelIds.join(','),
    XIAOJI_TEST_ALLOWED_ACTOR_IDS: trust.allowedActorIds.join(','),
    XIAOJI_TEST_ALLOWED_COMMANDS: trust.allowedCommands.join(','),
    XIAOJI_TEST_ALLOWED_COMPONENT_PREFIXES: trust.allowedComponentPrefixes.join(','),
    XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: trust.allowedMessageFeatures.join(','),
    XIAOJI_TEST_ALLOWED_EVENTS: trust.allowedEvents.join(','),
    XIAOJI_TEST_ALLOWED_JOBS: trust.allowedJobs.join(','),
    XIAOJI_TEST_DATA_ROOT: trust.dataRoot,
    XIAOJI_DATA_ROOT: trust.dataRoot,
  });
  const defaults = {
    COIN_DB_PATH: 'xiaoji.sqlite',
    XIAOJI_AUDIT_DATA_PATH: 'guildAudit.json',
    XIAOJI_INVITER_WHITELIST_PATH: 'inviterWhitelist.json',
    XIAOJI_REMINDERS_PATH: 'reminders.json',
    XIAOJI_CALENDAR_PATH: 'calendarEvents.json',
    AI_CONVERSATION_PATH: 'aiConversationHistory.json',
    XIAOJI_MEMORY_PATH: 'xiaojiMemory.json',
  };
  for (const [key, name] of Object.entries(defaults)) if (!child[key]) child[key] = path.join(trust.dataRoot, name);
  child.AUTO_DEPLOY_COMMANDS = 'false';
  child.XIAOJI_RELEASE_DISPATCH_ENABLED = 'false';
  child.PUBLIC_STATUS_ENABLED = 'false';
  child.GAME_SERVER_ENABLED = 'false';
  delete child.STATUS_SNAPSHOT_PUBLISHER_URL;
  delete child.STATUS_SNAPSHOT_PUBLISHER_KEY_ID;
  delete child.STATUS_SNAPSHOT_PUBLISHER_SECRET;
  delete child.XIAOJI_PRIVATE_EXTENSION_PATH;
  delete child.XIAOJI_EXTENSION_ASSEMBLY_MANIFEST_PATH;
  return child;
}

// Same-file detection compares exact bigint dev/ino; Number file IDs above 2^53 on
// Windows could make two different files look like one.
function readBigintStat(target) {
  return fs.statSync(target, { bigint: true });
}

function loadLaunchConfiguration({ configPath, trustPath, parentEnv = process.env, stat = readBigintStat }) {
  const configReal = path.resolve(configPath);
  const trustReal = path.resolve(trustPath);
  if (configReal === trustReal) throw fixedError('TEST_TRUST_NOT_INDEPENDENT');
  let configStat;
  let trustStat;
  try {
    configStat = stat(configReal);
    trustStat = stat(trustReal);
  } catch {
    throw fixedError('TEST_CONFIG_FILE_INVALID');
  }
  if ([configStat?.dev, configStat?.ino, trustStat?.dev, trustStat?.ino].some((value) => typeof value !== 'bigint')) {
    throw fixedError('TEST_CONFIG_FILE_INVALID');
  }
  if (configStat.dev === trustStat.dev && configStat.ino === trustStat.ino) {
    throw fixedError('TEST_TRUST_NOT_INDEPENDENT');
  }
  const config = dotenv.parse(readRealFile(configReal, 'TEST_CONFIG_FILE_INVALID'));
  const trust = readTrust(trustReal);
  // Both start and deploy stop here, before any child process or data access, unless
  // the trusted dataRoot lies outside every Git checkout and carries the marker for the
  // trusted test application and for this same directory.
  assertTestDataRoot({ dataRoot: trust.dataRoot, expectedApplicationId: trust.expectedApplicationId });
  return { env: buildChildEnvironment({ parentEnv, config, trust }), trust };
}

// Creates the test-only marker in the trusted dataRoot. It writes only into an empty
// directory outside every Git checkout; a directory holding just a matching marker is
// accepted unchanged, and any other content (for example production data) is refused
// without writing. The marker records this directory's identity, so a copied or
// restored directory must be initialized again.
function initializeTestDataRoot({ trustPath, projectRoot = path.join(__dirname, '..') }) {
  const trust = readTrust(path.resolve(trustPath));
  if (trust.forbiddenApplicationIds.includes(trust.expectedApplicationId)) {
    throw fixedError('TEST_EXPECTED_APP_FORBIDDEN');
  }
  const dataRoot = assertTestDataRootDirectory({
    dataRoot: trust.dataRoot, expectedApplicationId: trust.expectedApplicationId,
  });
  assertDataRootOutsideProject(dataRoot, projectRoot);
  assertDataRootOutsideRepository(dataRoot);
  let entries;
  try { entries = fs.readdirSync(dataRoot); } catch { throw fixedError('TEST_DATA_ROOT_INVALID'); }
  if (entries.length === 1 && entries[0] === TEST_DATA_ROOT_MARKER) {
    assertTestDataRootMarker(dataRoot, trust.expectedApplicationId);
    return Object.freeze({ code: 'TEST_DATA_ROOT_MARKER_PRESENT', created: false });
  }
  if (entries.length !== 0) throw fixedError('TEST_DATA_ROOT_NOT_EMPTY');
  const dataRootIdentity = readDataRootIdentity(dataRoot);
  try {
    fs.writeFileSync(path.join(dataRoot, TEST_DATA_ROOT_MARKER),
      serializeTestDataRootMarker(trust.expectedApplicationId, dataRootIdentity), { flag: 'wx' });
  } catch {
    throw fixedError('TEST_DATA_ROOT_MARKER_WRITE_FAILED');
  }
  assertTestDataRootMarker(dataRoot, trust.expectedApplicationId);
  return Object.freeze({ code: 'TEST_DATA_ROOT_MARKER_CREATED', created: true });
}

async function main(args = process.argv.slice(2), {
  processRef = process,
  spawnSyncFn = spawnSync,
  runStart = runStartLauncher,
} = {}) {
  const options = parseArgs(args);
  const projectRoot = path.join(__dirname, '..');
  if (options.action === 'init-data-root') {
    const result = initializeTestDataRoot({ trustPath: options.trustPath, projectRoot });
    processRef.stdout.write(`${safeControlLine(result.code, 'launcher')}\n`);
    processRef.exitCode = 0;
    return result;
  }
  const { env } = loadLaunchConfiguration(options);
  if (options.action === 'start') {
    const result = await runStart({ childEnv: env, projectRoot, ownerProcess: processRef, stderr: processRef.stderr });
    processRef.exitCode = result.outcome === 'GRACEFUL' && result.stopReason === 'OWNER_REQUEST' ? 0 : 1;
    return result;
  }
  const childArgs = [path.join(projectRoot, 'deploy-commands.js'), '--test-control'];
  const result = spawnSyncFn(process.execPath, childArgs, {
    cwd: projectRoot, env, stdio: 'inherit', shell: false,
  });
  if (result.error) throw fixedError('TEST_CHILD_SPAWN_FAILED');
  processRef.exitCode = result.status ?? 1;
  return Object.freeze({ outcome: result.status === 0 ? 'GRACEFUL' : 'FAILED', ready: false });
}

if (require.main === module) {
  main().catch((error) => {
    const code = SAFE_CODES.has(error?.code) ? error.code : 'TEST_BOOTSTRAP_FAILED';
    console.error(safeControlLine(code, 'launcher'));
    process.exitCode = 1;
  });
}

module.exports = {
  SAFE_PARENT_KEYS,
  buildChildEnvironment,
  initializeTestDataRoot,
  loadLaunchConfiguration,
  main,
  parseArgs,
  readTrust,
};
