'use strict';

// How the solo games get their reward port. The assembly root makes the one reward coordinator of
// the process and hands it to the solo games; the solo runtime builds none of its own and refuses to start without
// one. A finished game still pays once through the ledger, and a reward port or an economy switch reader that answers
// with a promise-like object instead of an answer is refused cleanly, whatever that object looks like.
// The assembly test also covers the work system: the root hands it the same coordinator as the solo games.
// Only a synthetic coin database in a temporary directory is used, and the one test that starts src/index.js blocks
// the network first and never logs in.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-solo-reward-port-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { setGuildEconomyEnabled } = require('../src/services/coinService');
const { getWalletPlayerWithApi } = require('../src/services/coinWalletService');
const { buildSudoku } = require('../src/systems/games/soloGameRules');
const { createDefaultSoloDiscordRuntime } = require('../src/systems/games/soloDiscordRuntime');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');

const PROJECT_ROOT = path.join(__dirname, '..');
const CLOCK = () => new Date('2026-10-03T00:00:00.000Z');
const SILENT_LOGGER = { error() {} };
let roundCount = 0;

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// Every blank cell of the puzzle with its solution: one batch that completes the game.
function blanks(board) {
  const cells = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      if (board.puzzle[row][column] === 0) cells.push({ row, column, value: board.solution[row][column] });
    }
  }
  return cells;
}

// The reward key of a game, derived here independently of the code under test.
const gameRewardKeyOf = (sessionId, userId) => `reward:v1:${crypto.createHash('sha256')
  .update(JSON.stringify(['game', `discord:${sessionId}`, 'completion', userId])).digest('hex')}`;

// Creates a one-batch sudoku for `userId` and binds it to its panel message. Applying the returned action completes it.
async function openRound(service, { sessionId, seed, userId = 'player', guildId = 'guild' }) {
  await service.create({ userId, guildId, channelId: 'room', gameType: 'sudoku', difficulty: 'easy' });
  const scope = { sessionId, actorId: userId, guildId, channelId: 'room', messageId: 'panel' };
  await service.bindMessage(scope);
  return { scope, action: { type: 'set_batch', cells: blanks(buildSudoku(seed, 'easy')) } };
}

// Runs `work` and reports every promise rejection that nobody handled while it ran and a little after.
async function unhandledRejectionsDuring(work) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await work();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

// Promise-like answers a port may give instead of a plain value. A thenable needs a then method and nothing else: no
// catch, and a then that may throw.
const PROMISE_LIKE_ANSWERS = Object.freeze({
  'a thenable with only then, which never settles': () => ({ then() {} }),
  'a thenable with only then, which rejects': () => ({ then(_resolve, reject) { reject(new Error('late failure')); } }),
  'a thenable whose then throws': () => ({ then() { throw new Error('then failed'); } }),
  'a promise that rejects': () => Promise.reject(new Error('rejected')),
  'a promise that resolves': () => Promise.resolve({ receipt: { id: 1 }, debtOffset: 0 }),
});

const PORTS = Object.freeze([
  {
    name: 'the economy switch reader',
    options: (answer) => ({ readGuildEconomyEnabledWithApi: () => answer() }),
    message: 'Economy switch must be read inside the transaction.',
  },
  {
    name: 'the reward port',
    options: (answer) => ({ grantRewardOnceV2WithApi: () => answer() }),
    message: 'Reward grant must complete inside the transaction.',
  },
]);

test('an economy switch reader or reward port that answers with a promise-like object is refused cleanly, whatever it looks like', async () => {
  for (const port of PORTS) {
    for (const [answerName, answer] of Object.entries(PROMISE_LIKE_ANSWERS)) {
      const label = `${port.name}: ${answerName}`;
      roundCount += 1;
      const sessionId = `reward-port-promise-like-${roundCount}`;
      const seed = `${sessionId}-seed`;
      const service = createSoloSessionService({
        withDatabase: withCoinDatabase,
        withTransaction: withCoinTransaction,
        clock: CLOCK,
        idFactory: () => sessionId,
        seedFactory: () => seed,
        ...port.options(answer),
      });
      const { scope, action } = await openRound(service, { sessionId, seed });

      const unhandled = await unhandledRejectionsDuring(async () => {
        await assert.rejects(
          () => service.apply({ ...scope, expectedRevision: 0, interactionId: `${sessionId}-action`, action }),
          (error) => error.name === 'GameError' && error.code === 'REWARD_CONTRACT_INVALID' && error.message === port.message,
          label,
        );
      });

      assert.deepEqual(unhandled, [], label);
      // The transaction rolled back: the game is still running and nothing about a reward was recorded.
      const session = await service.get(scope);
      assert.deepEqual([session.status, session.revision, session.actionCount], ['active', 0, 0], label);
      const rewards = await withCoinDatabase((api) => Number(api.get(
        'SELECT COUNT(*) AS count FROM discord_game_rewards WHERE session_id = ?', [sessionId]).count));
      assert.equal(rewards, 0, label);
    }
  }
});

test('the default solo game runtime refuses to start without the reward coordinator of the assembly root', () => {
  const withoutCoordinator = [
    undefined,
    {},
    { client: {}, runtimeLogger: SILENT_LOGGER },
    { rewardCoordinator: null },
    { rewardCoordinator: {} },
    { rewardCoordinator: { grant() {} } },
    { rewardCoordinator: { grantInTransaction: 'not a function' } },
  ];
  for (const [index, options] of withoutCoordinator.entries()) {
    assert.throws(
      () => createDefaultSoloDiscordRuntime(options),
      (error) => error.name === 'GameError' && error.code === 'REWARD_NOT_CONFIGURED',
      `case ${index}`,
    );
  }
});

test('the default solo game runtime pays through the very coordinator it was given', async () => {
  const requests = [];
  const rewardCoordinator = Object.freeze({
    grantInTransaction(_api, request) {
      requests.push(request);
      return { receipt: { id: 41 }, debtOffset: 0 };
    },
  });
  const runtime = createDefaultSoloDiscordRuntime({ client: {}, runtimeLogger: SILENT_LOGGER, rewardCoordinator });
  const session = await runtime.service.create({
    userId: 'player', guildId: 'guild', channelId: 'room', gameType: 'sudoku', difficulty: 'easy',
  });
  const scope = { sessionId: session.id, actorId: 'player', guildId: 'guild', channelId: 'room', messageId: 'panel' };
  await runtime.service.bindMessage(scope);
  const { seed } = await withCoinDatabase((api) => api.get('SELECT seed FROM discord_game_sessions WHERE id = ?', [session.id]));

  const outcome = await runtime.service.apply({
    ...scope,
    expectedRevision: 0,
    interactionId: `${session.id}-action`,
    action: { type: 'set_batch', cells: blanks(buildSudoku(seed, 'easy')) },
  });

  assert.equal(outcome.rewardStatus, 'granted');
  assert.deepEqual(requests, [{
    kind: 'game',
    canonicalSourceId: `discord:${session.id}`,
    rewardKind: 'completion',
    userId: 'player',
    sourceGuildId: 'guild',
    amount: 20,
    metadata: { game: 'sudoku', difficulty: 'easy' },
  }]);
});

test('with the real reward coordinator a finished game pays once, leaves its receipt, and a replay cannot pay again', async () => {
  const guildId = '10000000000000021';
  const userId = '10000000000000022';
  await setGuildEconomyEnabled(guildId, true, { operatorId: 'owner-1' });
  await withCoinTransaction((api) => { getWalletPlayerWithApi(api, guildId, userId); });
  const runtime = createDefaultSoloDiscordRuntime({
    client: {}, runtimeLogger: SILENT_LOGGER, rewardCoordinator: createRuntimeRewardCoordinator(),
  });
  const session = await runtime.service.create({ userId, guildId, channelId: 'room', gameType: 'sudoku', difficulty: 'easy' });
  const scope = { sessionId: session.id, actorId: userId, guildId, channelId: 'room', messageId: 'panel' };
  await runtime.service.bindMessage(scope);
  const { seed } = await withCoinDatabase((api) => api.get('SELECT seed FROM discord_game_sessions WHERE id = ?', [session.id]));
  const request = {
    ...scope,
    expectedRevision: 0,
    interactionId: `${session.id}-action`,
    action: { type: 'set_batch', cells: blanks(buildSudoku(seed, 'easy')) },
  };
  const receiptCount = () => withCoinDatabase((api) => Number(api.get(
    'SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE reward_key = ?', [gameRewardKeyOf(session.id, userId)]).count));

  const first = await runtime.service.apply(request);

  assert.equal(first.status, 'completed');
  assert.equal(first.rewardStatus, 'granted');
  assert.equal(first.rewardAmount, 20);
  assert.equal(await receiptCount(), 1);
  const stored = await withCoinDatabase((api) => ({
    grant: api.get('SELECT amount, debt_offset, net_amount FROM reward_grants_v2 WHERE reward_key = ?',
      [gameRewardKeyOf(session.id, userId)]),
    reward: api.get('SELECT status, amount, receipt_id FROM discord_game_rewards WHERE session_id = ?', [session.id]),
  }));
  assert.deepEqual(stored.grant, { amount: 20, debt_offset: 0, net_amount: 20 });
  assert.equal(stored.reward.status, 'granted');
  assert.equal(stored.reward.amount, 20);
  assert.ok(Number(stored.reward.receipt_id) > 0);

  const replay = await runtime.service.apply(request);

  assert.equal(replay.replayed, true);
  assert.equal(await receiptCount(), 1);
});

// Loaded with --require before src/index.js: no socket can open, no Discord request is answered, and login is a probe
// that reports what the assembly root did with the reward coordinator. The factory of the reward coordinator, the
// constructor of the solo runtime and the setter of the work system's reward port are wrapped before index.js takes
// them from their modules, so every coordinator the process makes, the one the solo runtime is given and the one the
// work system is handed are seen. The data preflight, which needs a fully initialized data directory, is skipped.
const ASSEMBLY_PRELOAD = String.raw`'use strict';
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const blocked = () => { throw new Error('XIAOJI_TEST_NETWORK_BLOCKED'); };
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
dns.lookup = (hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  process.nextTick(() => done(new Error('XIAOJI_TEST_NETWORK_BLOCKED')));
};
const path = require('node:path');
const root = process.env.XIAOJI_STARTUP_TEST_ROOT;
const { REST } = require(require.resolve('@discordjs/rest', { paths: [root] }));
REST.prototype.request = async function blockedRequest() { throw new Error('XIAOJI_TEST_REST_BLOCKED'); };
const { Client } = require(require.resolve('discord.js', { paths: [root] }));

const made = [];
const soloOptions = [];
const rewardRuntime = require(path.join(root, 'src', 'coordinators', 'rewardRuntime.js'));
const makeCoordinator = rewardRuntime.createRuntimeRewardCoordinator;
rewardRuntime.createRuntimeRewardCoordinator = function recordedFactory(...args) {
  const coordinator = makeCoordinator.apply(this, args);
  made.push(coordinator);
  return coordinator;
};
const soloRuntime = require(path.join(root, 'src', 'systems', 'games', 'soloDiscordRuntime.js'));
const makeSolo = soloRuntime.createDefaultSoloDiscordRuntime;
soloRuntime.createDefaultSoloDiscordRuntime = function recordedSolo(options) {
  soloOptions.push(options);
  return makeSolo.call(this, options);
};
const workPort = require(path.join(root, 'src', 'systems', 'work', 'workRewardPort.js'));
const configureWork = workPort.configureWorkRewardCoordinator;
const workConfigured = [];
workPort.configureWorkRewardCoordinator = function recordedWorkPort(coordinator) {
  workConfigured.push(coordinator);
  return configureWork.call(this, coordinator);
};

Client.prototype.login = async function reportingLogin() {
  const given = soloOptions.length === 1 ? soloOptions[0].rewardCoordinator : undefined;
  let workHolds;
  try { workHolds = workPort.getWorkRewardCoordinator(); } catch (error) { workHolds = undefined; }
  process.stdout.write('XIAOJI_TEST_REWARD_ASSEMBLY ' + JSON.stringify({
    soloRuntimesMade: soloOptions.length,
    coordinatorsMade: made.length,
    givenIsAssemblyRoots: made.length > 0 && made.includes(given),
    givenCanGrantInTransaction: typeof (given && given.grantInTransaction) === 'function',
    clientHoldsSoloRuntime: Boolean(this.soloRuntime),
    workConfigurations: workConfigured.length,
    workPortHoldsTheSoloCoordinator: given !== undefined && workHolds === given,
  }) + '\n');
  throw new Error('XIAOJI_TEST_LOGIN_BLOCKED');
};
const preflightPath = require.resolve(path.join(root, 'src', 'platform', 'runtimeDataPreflight.js'));
const preflight = require(preflightPath);
require.cache[preflightPath].exports = { ...preflight, preflightRuntimeData: async () => {} };
`;
const ASSEMBLY_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR',
]);

test('the assembly root makes one reward coordinator and the solo games and the work system get that very instance', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-solo-reward-assembly-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // An empty working directory, so dotenv finds no .env file.
  const cwd = path.join(scratch, 'cwd');
  fs.mkdirSync(cwd);
  const preload = path.join(scratch, 'preload.js');
  fs.writeFileSync(preload, ASSEMBLY_PRELOAD);
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ASSEMBLY_PARENT_KEYS.has(key.toUpperCase())));
  const token = 'synthetic-solo-reward-token-0123456789';

  const run = spawnSync(process.execPath, ['--require', preload, path.join(PROJECT_ROOT, 'src', 'index.js')], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...parentEnv,
      XIAOJI_STARTUP_TEST_ROOT: PROJECT_ROOT,
      DISCORD_TOKEN: token,
      DISCORD_CLIENT_ID: '123456789012345678',
      BOT_OWNER_ID: '323456789012345678',
    },
  });

  assert.equal(run.signal, null, 'startup must end by itself');
  const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('XIAOJI_TEST_REWARD_ASSEMBLY '));
  assert.ok(line, `startup reached the login probe\n${run.stdout}\n${run.stderr}`);
  assert.deepEqual(JSON.parse(line.slice('XIAOJI_TEST_REWARD_ASSEMBLY '.length)), {
    soloRuntimesMade: 1,
    // Exactly one reward coordinator exists after the assembly, and the solo runtime was given it.
    coordinatorsMade: 1,
    givenIsAssemblyRoots: true,
    givenCanGrantInTransaction: true,
    clientHoldsSoloRuntime: true,
    // The work system was handed its reward coordinator once, and the port holds the one the solo runtime has.
    workConfigurations: 1,
    workPortHoldsTheSoloCoordinator: true,
  });
  assert.equal(`${run.stdout}${run.stderr}`.includes(token), false);
});
