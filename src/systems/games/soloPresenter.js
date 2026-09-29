const path = require('node:path');
const { GameError } = require('./soloGameError');
const { buildSoloCustomId } = require('./soloCustomId');
const { nextTetrisShape } = require('./soloGameRules');

const LABELS = Object.freeze({ tetris: '俄羅斯方塊', 'number-match': '數字配對', sudoku: '數獨' });
const DIFFICULTIES = Object.freeze({ easy: '簡單', normal: '一般', complex: '複雜', hard: '困難' });
const CELL = 34;
const FONT_FILE = path.join(__dirname, '..', '..', 'games', 'assets', 'fonts', 'Cubic_11.ttf');

function box(x, y, width, height, fill, stroke = '#38435d') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="3" fill="${fill}" stroke="${stroke}"/>`;
}

function digit(value, x, y, size = 23, color = '#f6f7fb') {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${size}" fill="${color}">${value}</text>`;
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
    for (let column = 0; column < 9; column += 1) body += digit(String.fromCharCode(65 + column), 99 + column * cell, 75, 22);
    for (let row = 0; row < 9; row += 1) body += digit(row + 1, 52, 121 + row * cell, 22);
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
    '<rect width="100%" height="100%" fill="#101a2f"/><circle cx="35" cy="33" r="4" fill="#f7cc70"/>' +
    `<text x="70" y="41" font-family="Cubic 11" font-size="28" fill="#f6f7fb">${title}</text>${frame.body}</svg>`;
  return svg;
}

function renderSoloPng(session) {
  const { Resvg } = require('@resvg/resvg-js');
  return Buffer.from(new Resvg(buildSoloSvg(session), { font: {
    fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: 'Cubic 11', sansSerifFamily: 'Cubic 11',
  } }).render().asPng());
}

function sudokuProgress(state) {
  if (!Array.isArray(state?.entries) || state.entries.length !== 9) return null;
  const entries = state.entries;
  if (!entries.every((row) => Array.isArray(row) && row.length === 9)) return null;
  const filled = entries.flat().filter((value) => Number.isInteger(value) && value >= 1 && value <= 9).length;
  return { filled, fullButUnsolved: filled === 81 && state.completed !== true };
}

function buildSoloMessagePayload(session, { renderPng = renderSoloPng } = {}) {
  const png = renderPng(session);
  if (!Buffer.isBuffer(png) || png.length < 8) throw new GameError('RENDER_FAILED', 'Solo game PNG is missing.');
  const name = `solo-${session.id}-r${session.revision}.png`;
  const active = session.status === 'active';
  const rewardText = active ? '' : session.status === 'expired' ? '' : session.rewardStatus === 'granted'
    ? Number.isSafeInteger(session.rewardDebtOffset) && Number.isSafeInteger(session.rewardNetAmount)
      ? session.rewardDebtOffset > 0
        ? `｜獎勵 ${session.rewardAmount} 吉幣（抵欠款 ${session.rewardDebtOffset}，錢包入帳 ${session.rewardNetAmount}）`
        : `｜錢包入帳 ${session.rewardNetAmount} 吉幣`
      : `｜已結算 ${session.rewardAmount} 吉幣`
    : session.rewardStatus === 'no_reward' ? '｜本局沒有獎勵' : '｜獎勵待確認';
  const progress = session.gameType === 'sudoku' ? sudokuProgress(session.state) : null;
  const progressText = active && progress ? `｜已填 ${progress.filled}/81` : '';
  const guidance = progress?.fullButUnsolved ? '\n盤面已填滿但尚未通關；請檢查每列、每欄與每個九宮格的重複數字。' : '';
  const moveVerb = { tetris: 'move.t', 'number-match': 'move.n', sudoku: 'move.s' }[session.gameType];
  const controls = active ? [{ type: 1, components: [
    { type: 2, custom_id: buildSoloCustomId({ sessionId: session.id, revision: session.revision, verb: moveVerb }), label: '輸入一步', style: 1 },
    ...(session.gameType === 'sudoku' ? [{ type: 2, custom_id: buildSoloCustomId({ sessionId: session.id, revision: session.revision, verb: 'move.sb' }), label: '批次填答', style: 1 }] : []),
    { type: 2, custom_id: buildSoloCustomId({ sessionId: session.id, revision: session.revision, verb: 'refresh' }), label: '重新整理', style: 2 },
  ] }] : [];
  return {
    content: `${LABELS[session.gameType]}・${DIFFICULTIES[session.difficulty]}｜${active ? '進行中' : session.status === 'expired' ? '已逾時' : '已結束'}${progressText}${rewardText}｜第 ${session.revision} 版\n只有建立者可以操作。${session.gameType === 'sudoku' ? '\n座標：上方 A–I 是欄，左側 1–9 是列；A1 是左上角。' : ''}${guidance}`,
    files: [{ attachment: png, name }],
    embeds: [{ image: { url: `attachment://${name}` } }],
    components: controls,
    allowedMentions: { parse: [] },
  };
}

module.exports = { buildSoloMessagePayload, buildSoloSvg, renderSoloPng };
