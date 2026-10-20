'use strict';

// Test harness for the protected side effects as index.js wires them: the real bootstrap
// (ledgers in a temporary data folder), the real runtimes, protectedEffects, and a REST
// client that records every request and never reaches Discord. One "process" is one
// createProcess() call; a restart is another call on the same layout.

const fs = require('node:fs');
const path = require('node:path');
const { makeRealTempDir, removeRealTempDir } = require('../support/realTempDir');
const coinDatabase = require('../../src/services/coinDatabase');
const coinDatabaseEscalations = require('../../src/systems/economy/coinDatabaseEscalations');
const { createPublicEffectAuthority } = require('../../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../../src/platform/publicEffectAdapter');
const { configureChainReactionFence } = require('../../src/systems/safety/chainReactionFence');
const { settleLedgerShutdown } = require('../../src/systems/safety/ledgerEscalation');
const { OwnerSafetyNotifier } = require('../../src/systems/safety/ownerSafetyNotifier');
const { WelcomeSideEffectRuntime } = require('../../src/systems/safety/welcomeSideEffectRuntime');
const { PublicSideEffectRuntime } = require('../../src/systems/safety/publicSideEffectRuntime');
const { createProtectedEffects, resolveBotIdentity } = require('../../src/systems/safety/protectedEffects');
const layoutModule = require('../../src/systems/safety/ledgerLayout');
const { createSyntheticRest } = require('./syntheticRest');

const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000009';
const OTHER_APPLICATION_ID = '10000000000000099';
const DM_CHANNEL_ID = '10000000000000098';

let nextMessage = 50_000n;

// Records every request. GET /users/@me answers `identity` after `identityFailures`
// transient (503) failures; POST /users/@me/channels opens a DM with the recipient (the
// Owner's is DM_CHANNEL_ID, anyone else's is their own ID with its first digit set to 2).
function recordingRest({ identity = BOT_ID, identityFailures = 0, identityStatus = 503 } = {}) {
  const calls = [];
  let identityCalls = 0;
  return {
    calls,
    options: { retries: 0, rejectOnRateLimit: null },
    get identityCalls() { return identityCalls; },
    async get(route) {
      calls.push(['GET', route]);
      if (route === '/users/@me') {
        identityCalls += 1;
        if (identityCalls <= identityFailures) {
          throw Object.assign(new Error('synthetic identity failure'), { status: identityStatus });
        }
        return { id: identity };
      }
      throw new Error(`unexpected GET ${route}`);
    },
    async post(route, options) {
      calls.push(['POST', route, options?.body]);
      if (route === '/users/@me/channels') {
        const recipient = String(options?.body?.recipient_id || '');
        const id = recipient === OWNER_ID ? DM_CHANNEL_ID : `2${recipient.slice(1)}`;
        return { id, type: 1, recipients: [{ id: recipient }] };
      }
      nextMessage += 1n;
      return { id: (10_000_000_000_000_000n + nextMessage).toString(), channel_id: route.split('/')[2] };
    },
    async put(route) {
      calls.push(['PUT', route]);
      return {};
    },
    async delete(route) {
      calls.push(['DELETE', route]);
      return {};
    },
  };
}

// The requests that change something on Discord (everything but the identity read).
function protectedCalls(rest) {
  return rest.calls.filter(([method]) => method !== 'GET');
}

// The DMs sent to the Owner: the content of every message posted to the DM channel.
function ownerMessages(rest) {
  return rest.calls.filter(([method, route]) => method === 'POST' && route === `/channels/${DM_CHANNEL_ID}/messages`)
    .map(([, , body]) => body.content);
}

function capturingLogger() {
  const lines = [];
  const push = (level) => (line) => lines.push([level, String(line)]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

// root/project is the program folder; the coin database sits outside it (root/data) or,
// with inProject, inside it (root/project/data).
function createLayout(t, name, { inProject = false } = {}) {
  const root = makeRealTempDir(`xiaoji-protected-${name}-`);
  const project = path.join(root, 'project');
  const dataDir = inProject ? path.join(project, 'data') : path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const coinDbPath = path.join(dataDir, 'xiaoji.sqlite');
  const directories = Object.freeze({ ledgerDirectory: path.join(dataDir, 'safety'),
    witnessDirectory: path.join(dataDir, 'safety-witness') });
  t.after(() => {
    coinDatabase.resetCoinDatabaseForTests();
    removeRealTempDir(root);
  });
  return Object.freeze({ root, project, dataDir, coinDbPath, directories,
    paths: (purposeId) => layoutModule.purposePaths(directories, purposeId) });
}

// Opens the layout's coin database (fresh: a new one) as the process's coin database.
async function openCoinDatabase(layout, { fresh = false } = {}) {
  coinDatabase.resetCoinDatabaseForTests();
  process.env.COIN_DB_PATH = layout.coinDbPath;
  if (fresh) await coinDatabase.initializeNewCoinDatabase({ expectedPath: layout.coinDbPath });
  else await coinDatabase.initializeCoinDatabase();
}

// One process of the bot. env is the process environment the runtimes and the bootstrap
// see; configuredClientId is DISCORD_CLIENT_ID; loggedInAs is client.user.id at ready.
// ownerDmGate is the Owner DM start guard, handed to the Owner notifier and the ledger alerts as
// index.js does.
function createProcess(layout, { env = {}, rest = recordingRest(), configuredClientId = BOT_ID, loggedInAs = BOT_ID,
  bootstrap = null, bootstrapOptions = {}, alertNow = null, stopDeadlineMs = null, monotonic = null,
  setIntervalFn = null, clearIntervalFn = null, resolveIdentity = null, ownerDmGate = null } = {}) {
  const logger = capturingLogger();
  // client.rest is a real REST answered by the recording handlers (syntheticRest.js); `rest`
  // stays the handlers, whose calls the tests read.
  const transport = createSyntheticRest(rest);
  const client = { rest: transport, user: { id: loggedInAs } };
  const authority = createPublicEffectAuthority();
  const owner = new OwnerSafetyNotifier({ client, ownerId: OWNER_ID, botId: configuredClientId, logger, env,
    installHandler: () => () => {}, ownerDmGate });
  const welcome = new WelcomeSideEffectRuntime({ client, botId: configuredClientId, logger, env,
    effectAuthority: authority });
  const publicRuntime = new PublicSideEffectRuntime({ client, botId: configuredClientId, logger, env,
    effectAuthority: authority });
  configurePublicEffectAdapter({ publicEffectRuntime: publicRuntime, publicEffectIssuer: authority.createIssuer(),
    publicEffectAuthority: authority });
  configureChainReactionFence(publicRuntime);
  const protectedEffects = createProtectedEffects({
    runtimeMode: 'production',
    env,
    logger,
    ownerId: OWNER_ID,
    configuredClientId,
    rest: transport,
    ...(bootstrap ? { bootstrap } : {}),
    // The identity retries do not wait in tests.
    resolveIdentity: resolveIdentity || ((options) => resolveBotIdentity({ ...options, sleep: async () => {} })),
    bootstrapOptions: { projectRoot: layout.project, coinDbPath: layout.coinDbPath, ...bootstrapOptions },
    alertOptions: { ...(alertNow ? { now: alertNow } : {}), ...(ownerDmGate ? { ownerDmGate } : {}) },
    ...(stopDeadlineMs ? { stopDeadlineMs } : {}),
    ...(monotonic ? { monotonic } : {}),
    ...(setIntervalFn ? { setIntervalFn } : {}),
    ...(clearIntervalFn ? { clearIntervalFn } : {}),
  });
  protectedEffects.attachRuntimes({ owner, welcome, public: publicRuntime });
  client.protectedEffects = protectedEffects;
  owner.install();
  return {
    client,
    rest,
    logger,
    authority,
    owner,
    welcome,
    publicRuntime,
    protectedEffects,
    // index.js: inside the public preflight, after the coin database is open. reserve: more
    // paths the runtimes must treat as other data (a ledger among them is refused).
    async preflight({ reserve = [] } = {}) {
      const ledgers = await protectedEffects.start();
      const reservedDescriptors = [{ filePath: layout.coinDbPath }, ...reserve.map((filePath) => ({ filePath }))];
      return {
        ledgers,
        owner: owner.preflight({ reservedDescriptors, ledgers }),
        welcome: welcome.preflight({ reservedDescriptors, ledgers }),
        public: publicRuntime.preflight({ reservedDescriptors, ledgers }),
      };
    },
    // The prepended ClientReady listener; resolves once the start's notices were handed on.
    async ready() {
      await protectedEffects.onClientReady(client);
      await owner.waitForIdleForTests();
    },
    // index.js shutdown(): the stop, then the escalation exit code, then the later stop
    // steps (laterSteps stands in for the board lifecycle and the rest; one that throws is
    // logged as one line), and in any case a last report of the coin database alone, just
    // before the process exits. A failed step makes an otherwise clean exit code 1.
    async stop({ laterSteps = async () => {} } = {}) {
      await protectedEffects.stop();
      const processRef = {};
      settleLedgerShutdown({ sources: [publicRuntime, welcome, owner, protectedEffects, coinDatabaseEscalations],
        logger, processRef, exitCode: 0 });
      let stepFailed = false;
      try {
        await laterSteps();
      } catch (error) {
        stepFailed = true;
        const cause = String(error?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_]/gu, '').slice(0, 40) || 'Error';
        logger.error(`[SHUTDOWN] code=SHUTDOWN_STEP_FAILED cause=${cause}`);
      } finally {
        try {
          settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef });
        } finally {
          if (stepFailed && !processRef.exitCode) processRef.exitCode = 1;
        }
      }
      return processRef.exitCode;
    },
  };
}

// Every registration, decoded.
async function registrations() {
  const raw = await coinDatabase.readSafetyLedgerRegistrations();
  return Object.fromEntries(Object.entries(raw).map(([purposeId, entry]) => [purposeId, JSON.parse(entry.value)]));
}

// Every file under a directory, relative, sorted (an absent directory has none).
function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath || entry.path, entry.name))).sort();
}

module.exports = {
  BOT_ID,
  DM_CHANNEL_ID,
  OTHER_APPLICATION_ID,
  OWNER_ID,
  capturingLogger,
  createLayout,
  createProcess,
  filesUnder,
  openCoinDatabase,
  ownerMessages,
  protectedCalls,
  recordingRest,
  registrations,
};
