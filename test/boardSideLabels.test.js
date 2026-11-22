'use strict';

// Players could not tell whether they were white or black: the board image shows the piece colours and seat numbers
// only, and the panel said "輪到：白方（座位 1）" without saying who seat 1 is. The panel text now names each side's
// player, says whose turn it is by name, and in the lobby says that the order of joining decides the sides. Mentions
// show the names without pinging anyone (allowedMentions stays empty).

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBoardMessagePayload, buildSideLines } = require('../src/systems/games/board/discord/boardPresenter');
const { GAME_SIDES, describeTurn, seatSide } = require('../src/systems/games/board/renderer/svgBoardRenderer');

const FIRST = '100000000000000101';
const SECOND = '100000000000000102';

function session(gameKey, status, { turn = null, players = [FIRST, SECOND], retired = [] } = {}) {
  return {
    id: 'session-1', gameKey, status, revision: 3, rulesVersion: 1,
    players: players.map((userId, seat) => ({ userId, seat, status: retired.includes(userId) ? 'retired' : 'active' })),
    turn: turn ? { playerId: turn, phase: 'move' } : null,
    outcome: null,
  };
}

test('every coloured game has two sides that match the piece colours, and the image\'s turn line uses them', () => {
  assert.deepEqual(Object.keys(GAME_SIDES).sort(), ['checkers', 'chess', 'go', 'gomoku', 'xiangqi']);
  assert.deepEqual([seatSide('chess', 0).name, seatSide('chess', 1).name], ['白方', '黑方']);
  assert.deepEqual([seatSide('go', 0).name, seatSide('go', 1).name], ['黑方', '白方']);
  assert.deepEqual([seatSide('gomoku', 0).name, seatSide('gomoku', 1).name], ['黑方', '白方']);
  assert.deepEqual([seatSide('xiangqi', 0).name, seatSide('xiangqi', 1).name], ['紅方', '黑方']);
  assert.equal(seatSide('chess', 2), null);
  assert.equal(seatSide('werewolf', 0), null);
  assert.equal(seatSide('constructor', 0), null);
  assert.equal(describeTurn({ gameKey: 'chess', turn: { playerId: SECOND } }, [FIRST, SECOND]), '輪到：黑方（座位 2）');
  assert.equal(describeTurn({ gameKey: 'go', turn: { playerId: FIRST } }, [FIRST, SECOND]), '輪到：黑方（座位 1）');
});

test('a running chess game names white and black and whose turn it is', () => {
  assert.deepEqual(buildSideLines(session('chess', 'active', { turn: FIRST })), [
    `⚪ 白方（座位 1）：<@${FIRST}>`,
    `⚫ 黑方（座位 2）：<@${SECOND}>`,
    `輪到：⚪ 白方 <@${FIRST}>`,
  ]);
  assert.deepEqual(buildSideLines(session('go', 'active', { turn: SECOND })).at(-1), `輪到：⚪ 白方 <@${SECOND}>`);
  assert.deepEqual(buildSideLines(session('xiangqi', 'active', { turn: FIRST })).slice(0, 2), [
    `🔴 紅方（座位 1）：<@${FIRST}>`,
    `⚫ 黑方（座位 2）：<@${SECOND}>`,
  ]);
});

test('the lobby says the order of joining decides the sides, and who has joined so far', () => {
  assert.deepEqual(buildSideLines(session('chess', 'lobby', { players: [FIRST] })), [
    '先加入的是⚪ 白方，第二位加入的是⚫ 黑方。',
    `⚪ 白方：<@${FIRST}>`,
  ]);
  assert.deepEqual(buildSideLines(session('gomoku', 'lobby'))[0], '先加入的是⚫ 黑方，第二位加入的是⚪ 白方。');
});

test('a finished game keeps the sides, marks a player who left and names no turn; other games get no side lines', () => {
  assert.deepEqual(buildSideLines(session('chess', 'completed', { retired: [SECOND] })), [
    `⚪ 白方（座位 1）：<@${FIRST}>`,
    `⚫ 黑方（座位 2）：<@${SECOND}>（已離開）`,
  ]);
  assert.deepEqual(buildSideLines(session('werewolf', 'active', { turn: FIRST })), []);
  assert.deepEqual(buildSideLines(session('turtle-soup', 'lobby')), []);
  // An ID that is not a Discord ID is never put in a mention.
  assert.deepEqual(buildSideLines(session('chess', 'active', { players: ['<@&1>', SECOND], turn: '<@&1>' })), [
    '⚪ 白方（座位 1）：玩家 1',
    `⚫ 黑方（座位 2）：<@${SECOND}>`,
    '輪到：⚪ 白方 玩家 1',
  ]);
});

test('the panel shows the status in words and the sides, and still pings no one', async () => {
  const payload = await buildBoardMessagePayload({ session: session('chess', 'active', { turn: SECOND }), game: null }, {
    renderPng: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  const [embed] = payload.embeds;
  assert.equal(embed.description.split('\n')[0], '狀態：進行中｜版本：3');
  assert.match(embed.description, new RegExp(`輪到：⚫ 黑方 <@${SECOND}>`, 'u'));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

// Live test (v1.3.4): a finished game's image ended with the engine's English reason code ("turtle-soup-solved") and the
// turtle soup reveal button read "reveal". Both now read in Chinese, and a won two-sided game names the winning side.
test('a finished game says in Chinese how it ended and who won; the reveal button is labelled in Chinese', () => {
  const finished = (gameKey, outcome) => describeTurn({ gameKey, turn: null, outcome }, [FIRST, SECOND]);
  assert.equal(finished('chess', { type: 'win', winnerIds: [FIRST], reason: 'checkmate' }), '對局已結束：將死，白方獲勝');
  assert.equal(finished('xiangqi', { type: 'win', winnerIds: [SECOND], reason: 'stalemate' }), '對局已結束：困斃，黑方獲勝');
  assert.equal(finished('chess', { type: 'draw', winnerIds: [], reason: 'stalemate' }), '對局已結束：逼和');
  assert.equal(finished('go', { type: 'win', winnerIds: [SECOND], reason: 'resignation' }), '對局已結束：對手認輸，白方獲勝');
  assert.equal(finished('turtle-soup', { type: 'win', winnerIds: [FIRST], reason: 'turtle-soup-solved' }), '對局已結束：湯底已被猜中');
  assert.equal(finished('chess', { type: 'draw', winnerIds: [], reason: 'host-ended' }), '對局已結束：房主結束了對局');
  assert.equal(finished('chess', { type: 'draw', winnerIds: [], reason: 'something-new' }), '對局已結束');
  assert.equal(finished('chess', { type: 'draw', winnerIds: [], reason: 'constructor' }), '對局已結束');
  assert.equal(describeTurn({ gameKey: 'chess', turn: null, outcome: null }, [FIRST, SECOND]), '等待中');

  const { buildBoardComponents } = require('../src/systems/games/board/discord/boardPresenter');
  const rows = buildBoardComponents({ session: { ...session('turtle-soup', 'completed'), id: 'session-1' } });
  assert.deepEqual(rows.flatMap((row) => row.components.map((component) => component.label)), ['查看湯底']);
});
