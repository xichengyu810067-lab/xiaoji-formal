const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-sudoku-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const { applySudokuAction, buildSudoku, publicState } = require('../src/systems/games/soloGameRules');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');
const { parseMove } = require('../src/systems/games/soloDiscordRuntime');

function blanks(board) {
  const cells = [];
  for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) {
    if (board.puzzle[row][column] === 0) cells.push({ row, column, value: board.solution[row][column] });
  }
  return cells;
}

test('single and multi-cell entries reject wrong answers without changing the visible board', () => {
  const board = buildSudoku('public-puzzle', 'easy');
  const [first, second] = blanks(board);
  const wrong = { ...second, value: second.value === 9 ? 1 : second.value + 1 };
  const before = JSON.stringify(board.entries);
  const fields = { cells: `${String.fromCharCode(65 + first.column)}${first.row + 1}=${first.value} ` +
    `${String.fromCharCode(65 + wrong.column)}${wrong.row + 1}=${wrong.value}` };
  const batch = parseMove({ fields: { getTextInputValue: (key) => fields[key] } }, { gameType: 'sudoku' }, 'move.sb');
  assert.equal(batch.cells.length, 2);
  assert.throws(() => applySudokuAction(board, batch), (error) => error.code === 'WRONG_SUDOKU_ENTRY');
  assert.throws(() => applySudokuAction(board, { type: 'set', ...wrong }),
    (error) => error.code === 'WRONG_SUDOKU_ENTRY');
  assert.equal(JSON.stringify(board.entries), before);
  const publicBoard = publicState({ id: 'public', game_type: 'sudoku', difficulty: 'easy', status: 'active',
    action_count: 0, expires_at: '2099-01-01' }, board);
  assert.equal(JSON.stringify(publicBoard).includes('solution'), false);
  const cleared = applySudokuAction(board, { type: 'set', ...first, value: 0 });
  assert.equal(cleared.entries[first.row][first.column], 0);
});

test('one completed batch produces one reward and a replay cannot pay again', async () => {
  try {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
    let rewards = 0;
    const service = createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction,
      grantRewardOnceV2WithApi: () => { rewards += 1; return { receipt: { id: rewards }, debtOffset: 0 }; },
      clock: () => new Date('2026-09-29T00:00:00.000Z'),
      idFactory: () => 'public-sudoku-round', seedFactory: () => 'public-sudoku-seed' });
    await service.create({ userId: 'player', guildId: 'guild', channelId: 'room',
      gameType: 'sudoku', difficulty: 'easy' });
    const scope = { sessionId: 'public-sudoku-round', actorId: 'player', guildId: 'guild',
      channelId: 'room', messageId: 'panel' };
    await service.bindMessage(scope);
    const board = buildSudoku('public-sudoku-seed', 'easy');
    const action = { type: 'set_batch', cells: blanks(board) };
    const first = await service.apply({ ...scope, expectedRevision: 0, interactionId: 'public-action', action });
    assert.equal(first.status, 'completed');
    assert.equal(first.rewardAmount, 20);
    assert.equal(first.actionCount, 1);
    const replay = await service.apply({ ...scope, expectedRevision: 0, interactionId: 'public-action', action });
    assert.equal(replay.replayed, true);
    assert.equal(rewards, 1);
  } finally {
    resetCoinDatabaseForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
