const testControlRuntimeController = require('./platform/testControlRuntimeBootstrap');

if (process.env.XIAOJI_RUNTIME_MODE !== 'test-control') require('dotenv').config({ quiet: true });

// Counts this start as failed before anything below can fail; after three failed starts in a
// row this one sends no Owner DM until it succeeds (src/systems/safety/ownerDmStartGuard.js).
const { createOwnerDmStartGuard } = require('./systems/safety/ownerDmStartGuard');
const ownerDmStartGuard = createOwnerDmStartGuard({
  runtimeMode: testControlRuntimeController.active ? 'test-control' : 'production',
});
ownerDmStartGuard.begin();

// The liveness record: whether the last stop was asked for by signal, and how long a stop nobody
// asked for lasted (src/systems/safety/outageMonitor.js). It reads the record before anything else
// can fail; what it finds is told by src/systems/safety/outageNotice.js once the bot is steady.
const { createOutageMonitor } = require('./systems/safety/outageMonitor');
const outageMonitor = createOutageMonitor({
  runtimeMode: testControlRuntimeController.active ? 'test-control' : 'production',
  ownerDmGate: ownerDmStartGuard,
});
outageMonitor.begin();

// A stop asked for while the modules below are loading (a few seconds, all of it synchronous).
// Node calls a signal listener only when the event loop turns, which it does not do while this
// file loads, so this function does not run in that window: what its being registered does is
// that Node does not take its default for the signal (ending the process at once, with the record
// still at "running", which is an outage). The signal waits instead, and is taken, once the loop
// turns, by the stop handlers registered further down, which write it down as a stop and stop the
// process cleanly. A SIGKILL, or a forced kill, in that window is not a signal and stays an
// outage. The body is the defence for a loop that turns before the real handlers replace this
// one (it writes the record and ends the process at once, as nothing has started that needs a
// clean stop). A signal that is a stop: Ctrl-C (SIGINT) and SIGTERM; on Windows also SIGHUP, which
// is what closing the console window sends, and SIGBREAK (Ctrl-Break). Test-control has its own
// stop and takes none of this.
const STOP_SIGNALS = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
const earlyStop = () => {
  ownerDmStartGuard.noteSignalStop();
  outageMonitor.noteSignalStop();
  process.exit(0);
};
if (!testControlRuntimeController.active) {
  for (const signal of STOP_SIGNALS) process.on(signal, earlyStop);
}

const {
  Client,
  DiscordjsError,
  DiscordjsErrorCodes,
  Events,
  GatewayIntentBits,
  Partials,
  Routes,
} = require('discord.js');
const { DiscordAPIError, HTTPError } = require('@discordjs/rest');
const { deployCommands, shouldAutoDeployCommands } = require('../deploy-commands');
const { loadCommands } = require('./loadCommands');
const { createExtensionHost, loadPrivateExtensionHost } = require('./extensions/extensionHost');
const { registerNonPublicCommandNames } = require('./systems/conversation/disclosurePolicy');
const { configureBoardRuntime } = require('./systems/games/board/core/boardRuntimeRegistry');
const { createBoardDiscordRuntime, logTurtleSoupStartup } = require('./systems/games/board/discord/boardDiscordRuntime');
const { prepareFileScenarioProvider } = require('./systems/games/board/turtleSoup/scenarioProvider');
const { configureSoloRuntime } = require('./systems/games/soloRuntimeRegistry');
const { createDefaultSoloDiscordRuntime } = require('./systems/games/soloDiscordRuntime');
const { configureArchivePathResolver } = require('./services/aiArchiveService');
const { resolveDataPath } = require('./platform/dataPaths');
const { preflightRuntimeData } = require('./platform/runtimeDataPreflight');
const { startRuntime } = require('./platform/startupSequence');
const { registerEvents } = require('./handlers/registerEvents');
const { getBotOwnerId, getDiscordClientId, getDiscordToken, requireEnvValue } = require('./utils/env');
const { TestControlError, loadTestControlPolicy, preflightTestIdentity } = require('./platform/testControlPolicy');
const { createTestControlEgress } = require('./platform/testControlEgress');
const { installEgressGuard, readPrivateGuildIds } = require('./platform/egressGuard');
const { createEgressLimiter } = require('./platform/egressLimiter');
const { getTestControlStartupDiagnostics } = require('./platform/testControlStartupDiagnostics');
const { createPublicEffectAuthority } = require('./platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('./platform/publicEffectAdapter');
const { selectExtensionHost } = require('./platform/testControlExtension');
const logger = require('./utils/logger');
const { stopPublicStatusServer } = require('./services/publicStatusServer');
const { stopStatusSnapshotPublisher } = require('./services/statusSnapshotPublisher');
const { stopGameServer } = require('./services/gameServer');
const { stopReleaseAnnouncementScheduler } = require('./services/releaseAnnouncementService');
const { OwnerSafetyNotifier } = require('./systems/safety/ownerSafetyNotifier');
const { createOutageNotice } = require('./systems/safety/outageNotice');
const { WelcomeSideEffectRuntime } = require('./systems/safety/welcomeSideEffectRuntime');
const { PublicSideEffectRuntime } = require('./systems/safety/publicSideEffectRuntime');
const { configureChainReactionFence } = require('./systems/safety/chainReactionFence');
const { settleLedgerShutdown } = require('./systems/safety/ledgerEscalation');
const coinDatabaseEscalations = require('./systems/economy/coinDatabaseEscalations');
const { createProtectedEffects } = require('./systems/safety/protectedEffects');
const { flushWelcomedMembers } = require('./systems/community/welcomedMembers');
const { flushMemberLeaveNotices } = require('./systems/community/memberLeaveNotices');
const { version } = require('../package.json');

configureArchivePathResolver(resolveDataPath);

const startupDiagnostics = getTestControlStartupDiagnostics({
  active: testControlRuntimeController.active,
  isStopping: () => testControlRuntimeController.isStopping(),
});
startupDiagnostics.configureTrustedTypes({
  DiscordjsError,
  DiscordAPIError,
  HTTPError,
  tokenInvalidCode: DiscordjsErrorCodes.TokenInvalid,
});
startupDiagnostics.enterPhase('CONFIG_VALIDATE');

const token = getDiscordToken();
const clientId = getDiscordClientId();
const ownerId = getBotOwnerId();
const testControlPolicy = loadTestControlPolicy();
if (testControlPolicy && !testControlRuntimeController.active) {
  throw new TestControlError('TEST_CONTROL_CHANNEL_REQUIRED');
}
const extensionHost = selectExtensionHost(testControlPolicy, {
  createEmpty: createExtensionHost,
  loadPrivate: loadPrivateExtensionHost,
});

// What an extension owns is not public: the AI reply check does not read "/name 指令" of such a command as the public list.
registerNonPublicCommandNames(extensionHost.ownedCommandNames());

requireEnvValue('DISCORD_TOKEN', token);
if (testControlPolicy) requireEnvValue('DISCORD_CLIENT_ID', clientId, ['CLIENT_ID']);
requireEnvValue('BOT_OWNER_ID', ownerId, ['OWNER_ID']);

startupDiagnostics.enterPhase('CLIENT_SETUP');

const client = new Client({
  rest: { retries: 0 },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  // Without this, discord.js emits no guildMemberRemove for a member that is not in its cache (most
  // members of a larger server, who joined before this process started). The member arrives partial:
  // no join time, and a nickname only when it was cached (src/events/guildMemberRemove.js).
  partials: [Partials.GuildMember],
});
client.testControlPolicy = testControlPolicy;
if (testControlPolicy) {
  client.testControlRuntimeController = testControlRuntimeController;
  client.testControlEgress = createTestControlEgress(testControlPolicy, {
    isStopping: () => testControlRuntimeController.isStopping(),
    startupDiagnostics,
  });
  client.testControlEgress.install(client.rest);
  client.rest.setToken(token);
  client.on(Events.ShardDisconnect, (event) => startupDiagnostics.recordGatewayClose(event));
}
let privateGuildIds = [];
try {
  privateGuildIds = readPrivateGuildIds(process.env);
} catch {
  logger.warn('[EGRESS] code=EGRESS_PRIVATE_GUILDS_INVALID');
}
client.egressGuard = installEgressGuard(client.rest, {
  approvedReleaseTag: `v${version}`,
  privateGuildIds,
  ownerId,
  resolveChannelGuild: (channelId) => client.channels.cache.get(channelId)?.guildId ?? null,
  logger,
});
// Reservations are made before protected runtimes claim durable work; the guard consumes
// one only when the corresponding REST request is admitted.  Ordinary replies reserve and
// consume at this same final boundary.
client.egressLimiter = createEgressLimiter();
client.egressGuard.setAdmission((details) => client.egressLimiter.admit(details));

const turtleSoupCorpus = prepareFileScenarioProvider({
  rootDir: process.env.TURTLE_SOUP_CORPUS_ROOT,
});
const boardRuntime = configureBoardRuntime(createBoardDiscordRuntime({
  client,
  scenarioProvider: turtleSoupCorpus.provider,
  scenarioProviderReadiness: turtleSoupCorpus.readiness,
}));
// Log what the runtime will actually use (corpus code, scenario count, judge code), so a
// mismatch between the prepared corpus and the running game shows up at startup.
logTurtleSoupStartup(boardRuntime, logger);
// The one reward coordinator of this process is made here and handed to the solo games and to the work system, which
// build none of their own.
const { createRuntimeRewardCoordinator } = require('./coordinators/rewardRuntime');
const rewardCoordinator = createRuntimeRewardCoordinator();
const soloRuntime = configureSoloRuntime(createDefaultSoloDiscordRuntime({
  client, runtimeLogger: logger, rewardCoordinator,
}));
const { configureWorkRewardCoordinator } = require('./systems/work/workRewardPort');
configureWorkRewardCoordinator(rewardCoordinator);
// The work role coordinator is the one the /work command loads itself; the work system reaches it through its port.
const { workRoleCoordinator } = require('./coordinators/workRoleCoordinator');
const { configureWorkRoleCoordinator } = require('./systems/work/workRolePort');
configureWorkRoleCoordinator(workRoleCoordinator);
const ownerSafetyNotifier = new OwnerSafetyNotifier({
  client, ownerId, botId: clientId, logger, ownerDmGate: ownerDmStartGuard,
});
const publicEffectAuthority = createPublicEffectAuthority();
const publicEffectIssuer = publicEffectAuthority.createIssuer();
const welcomeSideEffectRuntime = new WelcomeSideEffectRuntime({
  client, botId: clientId, logger, effectAuthority: publicEffectAuthority,
});
const publicSideEffectRuntime = new PublicSideEffectRuntime({
  client, botId: clientId, logger, effectAuthority: publicEffectAuthority,
});
configurePublicEffectAdapter({
  publicEffectRuntime: publicSideEffectRuntime,
  publicEffectIssuer,
  publicEffectAuthority,
});
configureChainReactionFence(publicSideEffectRuntime);
// The life cycle of the protected side effects: the ledger bootstrap before login, the bot
// identity check at ready, the Owner notices, the hourly lastSeen, and the stop
// (src/systems/safety/protectedEffects.js). The runtimes only ever use the ledgers it
// delivers.
const protectedEffects = createProtectedEffects({
  runtimeMode: testControlPolicy ? 'test-control' : 'production',
  logger,
  reporter: testControlPolicy?.reporter || null,
  ownerId,
  configuredClientId: clientId,
  policy: testControlPolicy,
  rest: client.rest,
  isStopping: () => (testControlPolicy ? testControlRuntimeController.isStopping() : shutdownStarted),
  assertRunning: () => (testControlPolicy ? testControlRuntimeController.assertRunning() : true),
  alertOptions: { ownerDmGate: ownerDmStartGuard },
});
protectedEffects.attachRuntimes({
  owner: ownerSafetyNotifier,
  welcome: welcomeSideEffectRuntime,
  public: publicSideEffectRuntime,
});
// What the liveness record finds is told here, once the bot has been steady again: one fixed
// notice per server and one Owner notice, both written by code (src/systems/safety/outageNotice.js)
// and neither through the AI conversation.
outageMonitor.attachDelivery(createOutageNotice({ client, ownerNotifier: ownerSafetyNotifier, logger }).deliver);

client.extensionHost = extensionHost;
client.testControlStartupDiagnostics = startupDiagnostics;
client.boardRuntime = boardRuntime;
client.soloRuntime = soloRuntime;
client.welcomeSideEffectRuntime = welcomeSideEffectRuntime;
client.protectedEffects = protectedEffects;
client.commands = loadCommands(undefined, { extensionHost });
ownerSafetyNotifier.install();
registerEvents(client, undefined, { publicEffectAuthority });
// The start succeeds ten minutes after ready, unless the process ends or is stopped first.
// Prepended, so a ready handler that throws cannot keep it from starting the wait; the ready
// check below is prepended after it and so still runs first.
client.prependOnceListener(Events.ClientReady, () => ownerDmStartGuard.noteReady());
// The end of the last run is measured here, and the minute heartbeat starts; the signs of a restored
// backup in the ledger bootstrap report make an outage of their own kind. Prepended for the same
// reason; it never throws.
client.prependOnceListener(Events.ClientReady, () =>
  outageMonitor.noteReady(client, { bootReport: protectedEffects.bootReport }));
// Runs before every other ClientReady listener (ready.js) and synchronously: the runtimes
// are armed only once the logged-in bot is known to be the one the ledgers were opened for.
client.prependOnceListener(Events.ClientReady, (readyClient) => {
  protectedEffects.onClientReady(readyClient);
});

process.on('unhandledRejection', (reason) => {
  if (testControlPolicy) {
    startupDiagnostics.reportFailure(reason);
    logger.error('[TEST_CONTROL] code=TEST_UNHANDLED_REJECTION operation=process');
    testControlRuntimeController.requestStop('START_FAILED');
  }
  else logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  if (testControlPolicy) {
    startupDiagnostics.reportFailure(error);
    logger.error('[TEST_CONTROL] code=TEST_UNCAUGHT_EXCEPTION operation=process');
    testControlRuntimeController.requestStop('START_FAILED');
  } else {
    logger.error('Uncaught exception', error);
    process.exitCode = 1;
  }
});

// The records of who was welcomed and of the leave notices are written merged, a moment after each change.
// This writes what is still waiting. Neither flush is meant to throw, and each has its own guard anyway: this runs
// first in the stop and first in its last finally, so one that throws must not skip the other flush, the ledger
// report or the exit.
function flushMemberRecords() {
  try { flushWelcomedMembers(); } catch { noteMemberRecordsFlushFailed(); }
  try { flushMemberLeaveNotices(); } catch { noteMemberRecordsFlushFailed(); }
}

// One fixed line (no path, no ID, no error text), written by a guard of its own: a logger that fails cannot keep
// the stop from going on. The record is written again at the next flush.
function noteMemberRecordsFlushFailed() {
  try { logger.warn('[SHUTDOWN] code=MEMBER_RECORDS_FLUSH_FAILED'); } catch { /* the stop goes on */ }
}

let shutdownStarted = false;
async function shutdown(signal, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // No heartbeat and no outage notice from here on (synchronous, never throws). That this stop was
  // asked for is already on disk: the signal handlers below wrote it before this ran.
  outageMonitor.stop();
  logger.info(`收到 ${signal}，正在關閉小吉。`);
  // Before any step that can wait or fail (a private shutdown hook included), and once more at the end
  // for what events still in flight added during the stop.
  flushMemberRecords();
  // Quiesces the runtimes, writes lastSeen and waits for quarantine flags (bounded), stops
  // the runtimes, and closes the ledgers (protectedEffects.js); it never rejects.
  try {
    await protectedEffects.stop();
  } finally {
    // Ledger escalations end the process with a non-zero code, which test-control reports
    // even though it hides every log line (see ledgerEscalation.js). The code is recorded
    // on process.exitCode now, so a later step that throws cannot lose it, and a failure
    // code set earlier (for example by an uncaught exception) is kept. coinDatabaseEscalations
    // may only be read by these shutdown reports: a read takes the escalations it returns.
    settleLedgerShutdown({
      sources: [publicSideEffectRuntime, welcomeSideEffectRuntime, ownerSafetyNotifier, protectedEffects,
        coinDatabaseEscalations],
      logger, processRef: process, exitCode,
    });
  }
  // A later step that throws is logged as one fixed line; the stop still goes on to the last
  // report and the exit. A failed stop must stay visible to a service manager (and to
  // test-control, which hides the log line), so it exits non-zero: a code recorded above (3 or
  // 1) is kept, and an otherwise clean stop becomes 1.
  let stepFailed = false;
  try {
    await boardRuntime.stopLifecycle();
    await stopReleaseAnnouncementScheduler();
    await extensionHost.runHook('shutdown', { client, signal });
    await stopGameServer().catch(() => {
      logger.warn('[GAME_SERVER] Server shutdown failed.');
    });
    await stopPublicStatusServer().catch(() => {
      logger.warn('[PUBLIC_STATUS] Server shutdown failed.');
    });
    stopStatusSnapshotPublisher();
    const destroyResult = client.destroy();
    if (testControlPolicy) await destroyResult;
    testControlRuntimeController.dispose();
  } catch (error) {
    stepFailed = true;
    const cause = String(error?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_]/gu, '').slice(0, 40) || 'Error';
    logger.error(`[SHUTDOWN] code=SHUTDOWN_STEP_FAILED cause=${cause}`);
  } finally {
    flushMemberRecords();
    // A coin database write during the later steps (the board lifecycle, the extension hook,
    // an event still in flight) can escalate after the report above. This last shutdown report
    // reads coinDatabaseEscalations once more and gets only those, so none is printed twice
    // and a clean code still becomes the escalation code. The exit follows even if it throws.
    try {
      settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: process });
    } finally {
      if (stepFailed && !process.exitCode) process.exitCode = 1;
      process.exit(process.exitCode);
    }
  }
}

testControlRuntimeController.bindShutdown((reason) =>
  shutdown(reason, reason === 'START_FAILED' ? 1 : 0)
);
// The stop handlers take the place of the early one above.
for (const signal of STOP_SIGNALS) process.removeListener(signal, earlyStop);
// A stop asked for by signal is neither a failed nor a successful start: the Owner DM start
// guard puts its count back first, whatever the stop that follows ends with. The liveness record
// says the same, synchronously and at once (the host may kill the process a few seconds after
// the signal): a stop that was asked for is not an outage.
process.on('SIGINT', () => {
  if (testControlPolicy) testControlRuntimeController.requestStop('OWNER_REQUEST');
  else {
    ownerDmStartGuard.noteSignalStop();
    outageMonitor.noteSignalStop();
    void shutdown('SIGINT');
  }
});
process.on('SIGTERM', () => {
  if (testControlPolicy) testControlRuntimeController.requestStop('OWNER_REQUEST');
  else {
    ownerDmStartGuard.noteSignalStop();
    outageMonitor.noteSignalStop();
    void shutdown('SIGTERM');
  }
});
// On Windows a stop asked for at the console is more than Ctrl-C: closing the console window is
// SIGHUP, and Ctrl-Break is SIGBREAK (kill() and taskkill do not send a signal a handler can see
// at all, and are no clean stop). Node ends the process by itself without a handler, and this one
// stops it the same clean way; the host ends it for good a few seconds after a closed window, which
// the synchronous record write beats. Test-control keeps the default.
if (process.platform === 'win32' && !testControlPolicy) {
  for (const signal of ['SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
      ownerDmStartGuard.noteSignalStop();
      outageMonitor.noteSignalStop();
      void shutdown(signal);
    });
  }
}

async function start() {
  // The bot identity is read with the token before login (protectedEffects.start). Under
  // test-control the token was set above, behind the egress guard.
  if (!testControlPolicy) client.rest.setToken(token);
  await testControlRuntimeController.awaitBound();
  testControlRuntimeController.assertRunning();
  await testControlRuntimeController.awaitStartupFreshness();
  testControlRuntimeController.assertRunning();
  await startRuntime({
    preflightControl: () => preflightTestIdentity({
      policy: testControlPolicy,
      rest: client.rest,
      configuredClientId: clientId,
      Routes,
    }),
    preflightPublic: () => preflightRuntimeData({
      bootstrapLedgers: () => protectedEffects.start(),
      checkOwnerSafetyNotifications: (context) => ownerSafetyNotifier.preflight(context),
      checkWelcomeSideEffects: (context) => welcomeSideEffectRuntime.preflight(context),
      checkPublicSideEffects: (context) => publicSideEffectRuntime.preflight(context),
    }),
    preflightPrivate: () => testControlPolicy ? undefined : extensionHost.preflight({ client }),
    shouldDeploy: shouldAutoDeployCommands,
    deploy: async () => {
      logger.info('AUTO_DEPLOY_COMMANDS 已啟用，登入前部署 Slash Commands。');
      await deployCommands({ extensionHost });
    },
    login: () => client.login(token),
    testControlDiagnostics: testControlPolicy ? client.testControlEgress : null,
    startupDiagnostics: testControlPolicy ? startupDiagnostics : null,
    runtimeControl: testControlPolicy ? testControlRuntimeController : null,
  });
}

start().catch(async (error) => {
  if (testControlPolicy) {
    startupDiagnostics.reportFailure(error);
    logger.error('[TEST_CONTROL] code=TEST_RUNTIME_START_FAILED operation=start');
    testControlRuntimeController.requestStop('START_FAILED');
  } else {
    try {
      await protectedEffects.stop();
    } finally {
      // Settled even if a stop step throws, so the failed start keeps a non-zero code. As in
      // shutdown(), only this report reads coinDatabaseEscalations, and the read takes them.
      settleLedgerShutdown({
        sources: [publicSideEffectRuntime, welcomeSideEffectRuntime, ownerSafetyNotifier, protectedEffects,
          coinDatabaseEscalations],
        logger, processRef: process, exitCode: 1,
      });
    }
    logger.error('小吉啟動失敗。', error);
  }
});
