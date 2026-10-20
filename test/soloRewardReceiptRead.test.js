const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Characterization of how a finished solo game reads its reward receipt back (refactor
// Pins the receipt lookup before it moves to the reward ledger's owner.
// Only a synthetic coin database in a temporary directory is used.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-solo-receipt-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { setGuildEconomyEnabled } = require('../src/services/coinService');
const { getWalletPlayerWithApi, setDebtWithApi } = require('../src/services/coinWalletService');
const { grantRewardOnceV2WithApi } = require('../src/services/featurePlatformService');
const { buildSudoku } = require('../src/systems/games/soloGameRules');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const squash = (sql) => sql.replace(/\s+/g, ' ').trim();
// The game reward key, derived here independently of the code under test.
const gameRewardKeyOf = (sessionId, userId) => `reward:v1:${crypto.createHash('sha256')
  .update(JSON.stringify(['game', `discord:${sessionId}`, 'completion', userId])).digest('hex')}`;
const RECEIPT_READ = 'SELECT debt_offset, net_amount FROM reward_grants_v2 WHERE reward_key = ?';

function blanks(board) {
  const cells = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      if (board.puzzle[row][column] === 0) cells.push({ row, column, value: board.solution[row][column] });
    }
  }
  return cells;
}

// A read-only database that records every statement the session service issues on it.
function recordingDatabase(statements) {
  return (work) => withCoinDatabase((api) => work({
    ...api,
    get: (sql, params) => { statements.push({ sql: squash(sql), params }); return api.get(sql, params); },
    all: (sql, params) => { statements.push({ sql: squash(sql), params }); return api.all(sql, params); },
    run: (sql, params) => { statements.push({ sql: squash(sql), params }); return api.run(sql, params); },
  }));
}

const ledgerReads = (statements) => statements.filter((entry) => entry.sql.includes('reward_grants'));

// Starts a one-batch sudoku and, unless `finish` is false, completes it.
async function playSudoku({ sessionId, guildId, userId, grant, statements, finish = true }) {
  const service = createSoloSessionService({
    withDatabase: recordingDatabase(statements),
    withTransaction: withCoinTransaction,
    grantRewardOnceV2WithApi: grant,
    clock: () => new Date('2026-10-02T00:00:00.000Z'),
    idFactory: () => sessionId,
    seedFactory: () => `${sessionId}-seed`,
  });
  await service.create({ userId, guildId, channelId: 'room', gameType: 'sudoku', difficulty: 'easy' });
  const scope = { sessionId, actorId: userId, guildId, channelId: 'room', messageId: 'panel' };
  await service.bindMessage(scope);
  if (!finish) return { service, scope, outcome: null };
  const board = buildSudoku(`${sessionId}-seed`, 'easy');
  const outcome = await service.apply({
    ...scope, expectedRevision: 0, interactionId: `${sessionId}-action`,
    action: { type: 'set_batch', cells: blanks(board) },
  });
  return { service, scope, outcome };
}

test('a game paid through the reward ledger reads back the debt split of its own receipt', async () => {
  const guildId = 'solo-receipt-guild';
  const userId = 'solo-receipt-player';
  const sessionId = 'solo-receipt-debt';
  await setGuildEconomyEnabled(guildId, true, { operatorId: 'owner-1' });
  await withCoinTransaction((api) => {
    getWalletPlayerWithApi(api, guildId, userId);
    setDebtWithApi(api, userId, 8);
  });
  const statements = [];
  const { service, scope, outcome } = await playSudoku({
    sessionId, guildId, userId, grant: grantRewardOnceV2WithApi, statements,
  });
  assert.equal(outcome.rewardStatus, 'granted');
  assert.deepEqual([outcome.rewardAmount, outcome.rewardDebtOffset, outcome.rewardNetAmount], [20, 8, 12]);
  const stored = await withCoinDatabase((api) => api.get(
    'SELECT debt_offset, net_amount FROM reward_grants_v2 WHERE reward_key = ?', [gameRewardKeyOf(sessionId, userId)]));
  assert.deepEqual(stored, { debt_offset: 8, net_amount: 12 });

  statements.length = 0;
  const session = await service.get(scope);

  assert.equal(session.status, 'completed');
  assert.equal(session.rewardStatus, 'granted');
  assert.equal(session.rewardDebtOffset, 8);
  assert.equal(session.rewardNetAmount, 12);
  // One lookup on the read-only api the service was given, keyed by the game reward key.
  assert.deepEqual(ledgerReads(statements), [{ sql: RECEIPT_READ, params: [gameRewardKeyOf(sessionId, userId)] }]);
});

test('a granted game without a stored receipt leaves the debt split out', async () => {
  const userId = 'solo-receipt-player-2';
  const sessionId = 'solo-receipt-missing';
  const statements = [];
  const { service, scope, outcome } = await playSudoku({
    sessionId, guildId: 'solo-receipt-guild-2', userId, statements,
    grant: () => ({ receipt: { id: 1 }, debtOffset: 0 }),
  });
  assert.equal(outcome.rewardStatus, 'granted');

  statements.length = 0;
  const session = await service.get(scope);

  assert.equal(session.rewardStatus, 'granted');
  assert.equal(Object.hasOwn(session, 'rewardDebtOffset'), false);
  assert.equal(Object.hasOwn(session, 'rewardNetAmount'), false);
  assert.deepEqual(ledgerReads(statements), [{ sql: RECEIPT_READ, params: [gameRewardKeyOf(sessionId, userId)] }]);
});

test('a game that paid nothing or is still running does not read the reward ledger', async () => {
  const guildId = 'solo-receipt-off';
  await setGuildEconomyEnabled(guildId, false, { operatorId: 'owner-1' });
  const grants = [];
  const statements = [];
  const unpaid = await playSudoku({
    sessionId: 'solo-receipt-unpaid', guildId, userId: 'solo-receipt-player-3', statements,
    grant: (api, input) => { grants.push(input); return { receipt: { id: 1 }, debtOffset: 0 }; },
  });
  assert.equal(unpaid.outcome.rewardStatus, 'no_reward');

  statements.length = 0;
  const unpaidSession = await unpaid.service.get(unpaid.scope);
  assert.equal(unpaidSession.rewardStatus, 'no_reward');
  assert.equal(Object.hasOwn(unpaidSession, 'rewardDebtOffset'), false);
  assert.deepEqual(ledgerReads(statements), []);
  assert.deepEqual(grants, []);

  const running = await playSudoku({
    sessionId: 'solo-receipt-running', guildId, userId: 'solo-receipt-player-3', statements, finish: false,
  });
  statements.length = 0;
  const runningSession = await running.service.get(running.scope);
  assert.equal(runningSession.status, 'active');
  assert.equal(Object.hasOwn(runningSession, 'rewardStatus'), false);
  assert.deepEqual(ledgerReads(statements), []);
});
