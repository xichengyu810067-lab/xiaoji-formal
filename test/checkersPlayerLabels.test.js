'use strict';

// Live test F2 (v1.3.4): in a Chinese checkers game nobody could tell who had joined, which colour was theirs or what
// to type for a move. The lobby listed no players (so a second player kept pressing 加入 and got ALREADY_JOINED), the
// running game said only "輪到：玩家（座位 1）", and the image labelled its 121 points with tiny q…r… IDs. Now the
// panel lists every seat with its colour and player, says where each player starts and heads, names whose turn it is,
// and explains the point names; the image prints a short name (E5) inside every point and piece; and a move is typed
// with those names (the q…r… IDs still work).

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/systems/games/board/engines/checkers');
const {
  BOARD_POINTS, CAMP_BY_ID, CAMP_DIRECTIONS, LABEL_BY_POINT_ID, POINT_ID_BY_LABEL,
} = require('../src/systems/games/board/engines/checkers/board');
const { buildBoardMessagePayload, buildSideLines } = require('../src/systems/games/board/discord/boardPresenter');
const { MODAL_DEFINITIONS, createActionParsers, parseCheckersPath } = require('../src/systems/games/board/discord/boardControls');
const { describeTurn, renderBoardSvg, seatSide } = require('../src/systems/games/board/renderer/svgBoardRenderer');

const FIRST = '100000000000000101';
const SECOND = '100000000000000102';
const THIRD = '100000000000000103';

function session(status, { players = [FIRST, SECOND], turn = null, retired = [] } = {}) {
  return {
    id: 'session-ck', gameKey: 'checkers', status, revision: 4, rulesVersion: '1.0.0',
    players: players.map((userId, seat) => ({ userId, seat, status: retired.includes(userId) ? 'retired' : 'active' })),
    turn: turn ? { playerId: turn, phase: 'move' } : null,
    outcome: null,
  };
}

function view(players = [FIRST, SECOND]) {
  return engine.getPublicView(engine.createInitialState({ players, seed: 'synthetic-seed' }));
}

test('every point has a short name: a row letter from the top and its place in the row from the left', () => {
  assert.equal(LABEL_BY_POINT_ID.size, 121);
  assert.equal(POINT_ID_BY_LABEL.size, 121);
  assert.equal(LABEL_BY_POINT_ID.get('q4r-8'), 'A1');
  assert.equal(LABEL_BY_POINT_ID.get('q-4r-4'), 'E1');
  assert.equal(LABEL_BY_POINT_ID.get('q8r-4'), 'E13');
  assert.equal(LABEL_BY_POINT_ID.get('q0r0'), 'I5');
  assert.equal(LABEL_BY_POINT_ID.get('q-4r8'), 'Q1');
  for (const label of POINT_ID_BY_LABEL.keys()) assert.match(label, /^[A-Q]\d{1,2}$/u);
  const publicView = view();
  assert.ok(publicView.board.points.every((point) => point.label === LABEL_BY_POINT_ID.get(point.id)));
  // Two players start in the upper-right and lower-left corners, as the panel says.
  const centre = (campId) => {
    const points = CAMP_BY_ID.get(campId).pointIds.map((id) => BOARD_POINTS.find((point) => point.id === id));
    return { x: points.reduce((sum, point) => sum + point.x, 0) / 10, y: points.reduce((sum, point) => sum + point.y, 0) / 10 };
  };
  assert.equal(CAMP_DIRECTIONS.xp, '右上角');
  assert.ok(centre('xp').x > 6 && centre('xp').y < 7);
  assert.equal(CAMP_DIRECTIONS.xn, '左下角');
  assert.ok(centre('xn').x < 6 && centre('xn').y > 7);
  assert.equal(CAMP_DIRECTIONS.zn, '上方');
  assert.ok(centre('zn').y < centre('xp').y);
});

test('a move is typed with the point names, in any case; the q…r… IDs still work, and unknown names are refused', () => {
  assert.deepEqual(parseCheckersPath('E5 F5'), ['q0r-4', 'q0r-3']);
  assert.deepEqual(parseCheckersPath('e5，g5  i5'), ['q0r-4', 'q0r-2', 'q0r0']);
  assert.deepEqual(parseCheckersPath('q0r0 I6'), ['q0r0', 'q1r0']);
  for (const [input, message] of [
    ['E5', /至少兩個點位/u],
    ['E5 A5', /沒有 A5 這個點位/u],
    ['E5 R1', /沒有 R1 這個點位/u],
    ['E5 hello', /沒有 hello 這個點位/u],
    ['E5 e5', /不可重複/u],
    ['I5 q0r0', /不可重複/u],
  ]) {
    assert.throws(() => parseCheckersPath(input), (error) => error.code === 'INVALID_COORDINATE' && message.test(error.message), input);
  }
  const interaction = { fields: { getTextInputValue: () => 'M4 L4' } };
  const parsed = createActionParsers().checkers.move({ interaction });
  assert.equal(parsed.type, 'move');
  assert.deepEqual(parsed.path.map((id) => LABEL_BY_POINT_ID.get(id)), ['M4', 'L4']);
  const field = MODAL_DEFINITIONS.checkers.move.fields[0];
  assert.equal(field.placeholder, 'E5 F5');
  assert.ok(field.label.length <= 45);
});

test('the lobby lists the colours by joining order and who has joined', () => {
  assert.deepEqual(buildSideLines(session('lobby', { players: [FIRST] })), [
    '依加入順序分配棋色：⚪ 白方、⚫ 黑方、🔴 紅方、🔵 藍方、🟢 綠方、🟡 黃方。',
    '已加入 1 人；2、3、4 或 6 人時房主可以開始。',
    `⚪ 白方：<@${FIRST}>`,
  ]);
  assert.deepEqual(buildSideLines(session('lobby', { players: [FIRST, SECOND, THIRD] })).slice(1), [
    '已加入 3 人；2、3、4 或 6 人時房主可以開始。',
    `⚪ 白方：<@${FIRST}>`,
    `⚫ 黑方：<@${SECOND}>`,
    `🔴 紅方：<@${THIRD}>`,
  ]);
});

test('a running game names each seat with colour, player, start and goal, whose turn it is, and how to write a move', () => {
  const lines = buildSideLines(session('active', { turn: SECOND }), view());
  assert.deepEqual(lines.slice(0, 3), [
    `⚪ 白方（座位 1）：<@${FIRST}>｜從右上角出發，目標左下角`,
    `⚫ 黑方（座位 2）：<@${SECOND}>｜從左下角出發，目標右上角`,
    `輪到：⚫ 黑方 <@${SECOND}>`,
  ]);
  assert.match(lines[3], /由上而下 A～Q/u);
  assert.match(lines[3], /例如 E5 F5/u);
  // Three players start in alternate corners.
  const three = buildSideLines(session('active', { players: [FIRST, SECOND, THIRD], turn: FIRST }), view([FIRST, SECOND, THIRD]));
  assert.deepEqual(three.slice(0, 3), [
    `⚪ 白方（座位 1）：<@${FIRST}>｜從右上角出發，目標左下角`,
    `⚫ 黑方（座位 2）：<@${SECOND}>｜從左上角出發，目標右下角`,
    `🔴 紅方（座位 3）：<@${THIRD}>｜從下方出發，目標上方`,
  ]);
  // Without the public view the seats are still named; a finished game drops the turn and the move help.
  assert.equal(buildSideLines(session('active', { turn: FIRST }))[0], `⚪ 白方（座位 1）：<@${FIRST}>`);
  assert.deepEqual(buildSideLines(session('completed', { retired: [SECOND] }), view()), [
    `⚪ 白方（座位 1）：<@${FIRST}>｜從右上角出發，目標左下角`,
    `⚫ 黑方（座位 2）：<@${SECOND}>（已離開）｜從左下角出發，目標右上角`,
  ]);
  assert.equal(describeTurn({ gameKey: 'checkers', turn: { playerId: SECOND } }, [FIRST, SECOND]), '輪到：黑方（座位 2）');
  assert.equal(seatSide('checkers', 5).name, '黃方');
  assert.equal(seatSide('checkers', 6), null);
});

test('the image prints every point name inside its point or on the piece standing there, in a larger picture', () => {
  const publicView = view();
  const svg = renderBoardSvg(publicView, { playerOrder: [FIRST, SECOND], title: '六角星跳棋' });
  assert.match(svg, /^<svg [^>]*width="1440" height="1440"/u);
  const labels = [...svg.matchAll(/data-point-label="([^"]+)"[^>]*font-size="(\d+)"/gu)];
  assert.equal(labels.length, 121);
  assert.deepEqual(new Set(labels.map((match) => match[1])), new Set(POINT_ID_BY_LABEL.keys()));
  assert.ok(labels.every((match) => Number(match[2]) >= 22), 'point names are drawn at 22px or more');
  assert.ok(!svg.includes('>q0r0<'), 'the axial IDs are no longer printed');
  // The pieces carry the names of the points they stand on, and the seat colours of 白方 and 黑方.
  const firstCampPiece = publicView.board.pieces.find((piece) => piece.ownerId === FIRST);
  const label = LABEL_BY_POINT_ID.get(firstCampPiece.position.pointId);
  assert.match(svg, new RegExp(`data-piece-id="${firstCampPiece.id}" data-seat="0"><circle [^>]*fill="#f7f4ea"[^>]*/><text data-point-label="${label}"`, 'u'));
  assert.match(svg, /data-seat="1"><circle [^>]*fill="#242936"/u);
  // An explicit size still wins.
  assert.match(renderBoardSvg(publicView, { width: 960, height: 960 }), /^<svg [^>]*width="960"/u);
});

test('the panel carries the seat lines and the move help, and still pings no one', async () => {
  const payload = await buildBoardMessagePayload({ session: session('active', { turn: FIRST }), game: view() }, {
    renderPng: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  const [embed] = payload.embeds;
  assert.match(embed.description, new RegExp(`⚪ 白方（座位 1）：<@${FIRST}>｜從右上角出發`, 'u'));
  assert.match(embed.description, new RegExp(`輪到：⚪ 白方 <@${FIRST}>`, 'u'));
  assert.match(embed.description, /例如 E5 F5/u);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const lobby = await buildBoardMessagePayload({ session: session('lobby', { players: [FIRST] }), game: null }, {
    renderPng: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  assert.match(lobby.embeds[0].description, new RegExp(`⚪ 白方：<@${FIRST}>`, 'u'));
});
