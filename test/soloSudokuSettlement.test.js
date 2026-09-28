const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A new synthetic database is selected before loading the economic service.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-solo-sudoku-'));
process.env.COIN_DB_PATH = path.join(temp, 'synthetic.sqlite');

const { initializeNewCoinDatabase, withCoinDatabase, withCoinTransaction, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { getWalletPlayerWithApi, setDebtWithApi } = require('../src/systems/economy/coinWalletService');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');
const { buildSudoku, countSudokuSolutions } = require('../src/systems/games/soloGameRules');
const { parseMove } = require('../src/systems/games/soloDiscordRuntime');
const { buildSoloMessagePayload } = require('../src/systems/games/soloPresenter');

function serviceFor(id, seed) {
  const coordinator = createRuntimeRewardCoordinator();
  return createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction,
    grantRewardOnceV2WithApi: (api, request) => coordinator.grantInTransaction(api, request),
    clock: () => new Date('2026-09-26T00:00:00.000Z'), idFactory: () => id, seedFactory: () => seed });
}

async function prepareFinalMove(service, userId, id, seed) {
  const created = await service.create({ userId, guildId: '20001', channelId: '30001', gameType: 'sudoku', difficulty: 'easy' });
  await service.bindMessage({ sessionId: id, actorId: userId, guildId: '20001', channelId: '30001', messageId: `panel${id}` });
  const scope = { sessionId: id, actorId: userId, guildId: '20001', channelId: '30001', messageId: `panel${id}` };
  const answer = buildSudoku(seed, 'easy');
  assert.equal(countSudokuSolutions(answer.puzzle), 1);
  const blanks = [];
  for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) {
    if (answer.puzzle[row][column] === 0) blanks.push({ row, column, value: answer.solution[row][column] });
  }
  for (const [index, cell] of blanks.slice(0, -1).entries()) {
    const fields = { cell: `${String.fromCharCode(65 + cell.column)}${cell.row + 1}`, value: String(cell.value) };
    const result = await service.apply({ ...scope, expectedRevision: index, interactionId: `${id}move${index}`,
      action: parseMove({ fields: { getTextInputValue: (key) => fields[key] } }, created) });
    assert.equal(result.status, 'active');
  }
  return { scope, finalAction: { type: 'set', ...blanks.at(-1) }, revision: blanks.length - 1 };
}

test('real v22 Sudoku completion pays once; debt can consume the gross prize and survives reopen', async () => {
  try {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
    const first = serviceFor('sudokunodebt', 'seednodebt');
    const a = await prepareFinalMove(first, '10001', 'sudokunodebt', 'seednodebt');
    const [one, two] = await Promise.allSettled([
      first.apply({ ...a.scope, expectedRevision: a.revision, interactionId: 'finala', action: a.finalAction }),
      serviceFor('unused', 'unused').apply({ ...a.scope, expectedRevision: a.revision, interactionId: 'finalb', action: a.finalAction }),
    ]);
    const winner = [one, two].find((item) => item.status === 'fulfilled').value;
    assert.equal([one, two].filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal([one, two].find((item) => item.status === 'rejected').reason.code, 'SESSION_NOT_ACTIVE');
    assert.equal(winner.status, 'completed');
    assert.equal(winner.rewardAmount, 20);
    assert.equal(winner.rewardNetAmount, 20);
    assert.equal(winner.rewardDebtOffset, 0);
    const replay = await first.apply({ ...a.scope, expectedRevision: a.revision,
      interactionId: one.status === 'fulfilled' ? 'finala' : 'finalb', action: a.finalAction });
    assert.equal(replay.replayed, true);

    const second = serviceFor('sudokuwithdebt', 'seedwithdebt');
    await withCoinTransaction((api) => {
      getWalletPlayerWithApi(api, '20001', '10002');
      setDebtWithApi(api, '10002', 25, '2026-09-26T00:00:00.000Z');
    });
    const b = await prepareFinalMove(second, '10002', 'sudokuwithdebt', 'seedwithdebt');
    const indebted = await second.apply({ ...b.scope, expectedRevision: b.revision, interactionId: 'finaldebt', action: b.finalAction });
    assert.equal(indebted.status, 'completed');
    assert.equal(indebted.rewardAmount, 20);
    assert.equal(indebted.rewardDebtOffset, 20);
    assert.equal(indebted.rewardNetAmount, 0);
    assert.match(buildSoloMessagePayload(indebted, { renderPng: () => Buffer.from('synthetic png') }).content, /抵欠款 20，錢包入帳 0/);

    const persisted = await withCoinDatabase((api) => ({
      first: api.get('SELECT balance,total_earned FROM coin_wallets WHERE user_id = ?', ['10001']),
      second: api.get('SELECT balance,total_earned FROM coin_wallets WHERE user_id = ?', ['10002']),
      debt: api.get('SELECT amount FROM coin_debts WHERE user_id = ?', ['10002']),
      grants: api.get("SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE kind = 'game'"),
      rewards: api.get('SELECT COUNT(*) AS count FROM discord_game_rewards'),
    }));
    assert.deepEqual([persisted.first.balance, persisted.first.total_earned], [20, 20]);
    assert.deepEqual([persisted.second.balance, persisted.second.total_earned, persisted.debt.amount], [0, 20, 5]);
    assert.equal(persisted.grants.count, 2);
    assert.equal(persisted.rewards.count, 2);

    resetCoinDatabaseForTests();
    const reopened = serviceFor('unusedreopen', 'unusedreopen');
    const restored = await reopened.get(b.scope);
    assert.equal(restored.rewardStatus, 'granted');
    assert.equal(restored.rewardDebtOffset, 20);
    assert.equal(restored.rewardNetAmount, 0);
    assert.match(buildSoloMessagePayload(restored, { renderPng: () => Buffer.from('synthetic png') }).content, /錢包入帳 0/);
  } finally {
    resetCoinDatabaseForTests();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
