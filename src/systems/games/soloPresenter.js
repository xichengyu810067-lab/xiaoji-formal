const { GameError } = require('./soloGameError');
const { buildSoloCustomId } = require('./soloCustomId');
const { nextTetrisShape } = require('./soloGameRules');

const LABELS = Object.freeze({ tetris: '俄羅斯方塊', 'number-match': '數字配對', sudoku: '數獨' });
const DIFFICULTIES = Object.freeze({ easy: '簡單', normal: '一般', complex: '複雜', hard: '困難' });
const CELL = 34;

function box(x, y, width, height, fill, stroke = '#38435d') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="3" fill="${fill}" stroke="${stroke}"/>`;
}

function digit(value, x, y, size = 23, color = '#f6f7fb') {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${size}" fill="${color}">${value}</text>`;
}

function gridSvg(state, game) {
  if (game === 'tetris') {
    if (!Array.isArray(state.board) || state.board.length !== 20 || !state.board.every((row) => Array.isArray(row) && row.length === 10)) {
      throw new GameError('INVALID_STATE', 'Tetris board is invalid.');
    }
    const board = state.board.map((row, y) => row.map((value, x) => box(42 + x * CELL, 70 + y * CELL, CELL - 2, CELL - 2, value ? '#70c9ff' : '#18243d')).join('')).join('');
    const shape = state.gameOver ? [] : nextTetrisShape(state);
    const next = shape.map(([x, y]) => box(430 + x * CELL, 130 + y * CELL, CELL - 2, CELL - 2, '#f7cc70')).join('');
    return { width: 640, height: 805, body: `${board}${next}${digit(Number(state.score) || 0, 500, 240, 28)}${digit(Number(state.pieceIndex) + 1 || 1, 500, 305, 24)}` };
  }
  if (game === 'number-match') {
    const { rows, columns, board } = state;
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows * columns > 100 || !Array.isArray(board) || board.length !== rows * columns) {
      throw new GameError('INVALID_STATE', 'Number match board is invalid.');
    }
    const cell = 78;
    const body = board.map((value, index) => {
      const x = 70 + (index % columns) * cell;
      const y = 100 + Math.floor(index / columns) * cell;
      return box(x, y, cell - 5, cell - 5, value == null ? '#18243d' : '#294768') + (value == null ? '' : digit(Number(value), x + 36, y + 36, 31));
    }).join('');
    return { width: Math.max(480, 140 + columns * cell), height: Math.max(390, 190 + rows * cell), body };
  }
  if (game === 'sudoku') {
    if (!Array.isArray(state.puzzle) || !Array.isArray(state.entries) || state.puzzle.length !== 9 || state.entries.length !== 9 ||
        !state.puzzle.every((row) => Array.isArray(row) && row.length === 9) || !state.entries.every((row) => Array.isArray(row) && row.length === 9)) {
      throw new GameError('INVALID_STATE', 'Sudoku board is invalid.');
    }
    const cell = 56;
    let body = '';
    for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) {
      const x = 72 + column * cell;
      const y = 94 + row * cell;
      const fixed = Number(state.puzzle[row][column]) !== 0;
      const value = Number(state.entries[row][column]);
      body += box(x, y, cell - 2, cell - 2, fixed ? '#294768' : '#18243d');
      if (Number.isInteger(value) && value > 0 && value <= 9) body += digit(value, x + 27, y + 27, 27, fixed ? '#f6f7fb' : '#f7cc70');
    }
    for (let index = 0; index <= 9; index += 3) {
      body += `<path d="M${72 + index * cell} 94v${9 * cell} M72 ${94 + index * cell}h${9 * cell}" stroke="#70c9ff" stroke-width="3"/>`;
    }
    return { width: 650, height: 660, body };
  }
  throw new GameError('INVALID_STATE', 'Unsupported solo game.');
}

function buildSoloSvg(session) {
  const frame = gridSvg(session.state, session.gameType);
  const title = LABELS[session.gameType];
  if (!title) throw new GameError('INVALID_STATE', 'Unsupported solo game.');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">` +
    `<rect width="100%" height="100%" fill="#101a2f"/>${digit('✦', 35, 33, 23, '#f7cc70')}` +
    `<text x="70" y="41" font-family="Arial,sans-serif" font-size="28" fill="#f6f7fb">${title}</text>${frame.body}</svg>`;
  return svg;
}

function renderSoloPng(session) {
  const { Resvg } = require('@resvg/resvg-js');
  return Buffer.from(new Resvg(buildSoloSvg(session)).render().asPng());
}

function buildSoloMessagePayload(session, { renderPng = renderSoloPng } = {}) {
  const png = renderPng(session);
  if (!Buffer.isBuffer(png) || png.length < 8) throw new GameError('RENDER_FAILED', 'Solo game PNG is missing.');
  const name = `solo-${session.id}-r${session.revision}.png`;
  const active = session.status === 'active';
  const rewardText = active ? '' : session.status === 'expired' ? '｜已逾時' : session.rewardStatus === 'granted'
    ? `｜已結算 ${session.rewardAmount} 吉幣`
    : session.rewardStatus === 'no_reward' ? '｜本局沒有獎勵' : '｜獎勵待確認';
  const moveVerb = { tetris: 'move.t', 'number-match': 'move.n', sudoku: 'move.s' }[session.gameType];
  const controls = active ? [{ type: 1, components: [
    { type: 2, custom_id: buildSoloCustomId({ sessionId: session.id, revision: session.revision, verb: moveVerb }), label: '輸入一步', style: 1 },
    { type: 2, custom_id: buildSoloCustomId({ sessionId: session.id, revision: session.revision, verb: 'refresh' }), label: '重新整理', style: 2 },
  ] }] : [];
  return {
    content: `${LABELS[session.gameType]}・${DIFFICULTIES[session.difficulty]}｜${active ? '進行中' : '已結束'}${rewardText}｜第 ${session.revision} 版\n只有建立者可以操作。`,
    files: [{ attachment: png, name }],
    embeds: [{ image: { url: `attachment://${name}` } }],
    components: controls,
    allowedMentions: { parse: [] },
  };
}

module.exports = { buildSoloMessagePayload, buildSoloSvg, renderSoloPng };
