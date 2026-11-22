const fs = require('node:fs');
const path = require('node:path');

const { BoardCoreError, cloneJson } = require('../core/contracts');

const RESVG_VERSION = '2.6.2';
// Font bytes remain at the original public asset path during this relocation.
const FONT_DIRECTORY = path.join(__dirname, '..', '..', '..', '..', '..', 'assets', 'fonts');
const FONT_FILES = Object.freeze([
  path.join(FONT_DIRECTORY, 'NotoSansSymbols-Regular.ttf'),
  path.join(FONT_DIRECTORY, 'Cubic_11.ttf'),
  path.join(FONT_DIRECTORY, 'NotoSansSymbols2-Regular.ttf'),
]);

const THEMES = Object.freeze({
  light: Object.freeze({
    canvas: '#f6f2e8', board: '#dfbf83', boardAlt: '#cfa969', line: '#342719', text: '#241b13',
    muted: '#6e5b45', river: '#efe0bd', pieceText: '#111111', pieceStroke: '#151515',
  }),
  dark: Object.freeze({
    canvas: '#171b24', board: '#705436', boardAlt: '#5a422c', line: '#f2dfbd', text: '#fff4dd',
    muted: '#c9b998', river: '#3a4d59', pieceText: '#111111', pieceStroke: '#fff5de',
  }),
});

const SEAT_COLORS = Object.freeze(['#f7f4ea', '#242936', '#cf453b', '#2f73c5', '#2f9a62', '#f0b429']);
const GAME_LABELS = Object.freeze({
  'turtle-soup': '海龜湯',
  chess: '西洋棋',
  gomoku: '五子棋',
  go: '圍棋',
  checkers: '六角星跳棋',
  xiangqi: '象棋',
  werewolf: '狼人殺',
});

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BoardCoreError('INVALID_PUBLIC_VIEW', `${label} must be finite.`);
  return number;
}

function validatePublicBoard(view) {
  const publicView = cloneJson(view, 'public board view');
  if (!publicView || typeof publicView !== 'object' || !publicView.board || typeof publicView.board !== 'object') {
    throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Public view must include a board.');
  }
  if (!['grid', 'graph', 'narrative'].includes(publicView.board.kind)) {
    throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Board kind is not supported.');
  }
  if (!Array.isArray(publicView.board.points) || !Array.isArray(publicView.board.pieces)) {
    throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Board points and pieces must be arrays.');
  }
  if (publicView.board.kind === 'grid') {
    if (!Number.isInteger(publicView.board.width) || publicView.board.width < 2 || publicView.board.width > 25 ||
        !Number.isInteger(publicView.board.height) || publicView.board.height < 2 || publicView.board.height > 25) {
      throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Grid dimensions are invalid.');
    }
  }
  const pointIds = new Set();
  for (const point of publicView.board.points) {
    const id = String(point?.id || '');
    if (!id || pointIds.has(id)) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Graph point IDs must be unique.');
    finite(point.x, 'point.x');
    finite(point.y, 'point.y');
    pointIds.add(id);
  }
  const pieceIds = new Set();
  for (const piece of publicView.board.pieces) {
    const id = String(piece?.id || '');
    if (!id || pieceIds.has(id)) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Piece IDs must be unique.');
    if (!piece.position || typeof piece.position !== 'object') throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Piece position is required.');
    if (Object.hasOwn(piece.position, 'pointId')) {
      if (!pointIds.has(String(piece.position.pointId))) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Piece graph point does not exist.');
    } else {
      const x = finite(piece.position.x, 'piece.position.x');
      const y = finite(piece.position.y, 'piece.position.y');
      if (publicView.board.kind === 'grid' &&
          (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= publicView.board.width || y >= publicView.board.height)) {
        throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Piece grid position is outside the board.');
      }
    }
    pieceIds.add(id);
  }
  return publicView;
}

function normalizeRendererView(view) {
  const publicView = validatePublicBoard(view);
  const board = publicView.board;
  if (board.kind === 'grid' && ['chess', 'gomoku', 'go', 'xiangqi'].includes(publicView.gameKey)) {
    board.columnLabels ??= Array.from({ length: board.width }, (_, x) => String.fromCharCode(65 + x));
    board.rowLabels ??= Array.from({ length: board.height }, (_, y) => publicView.gameKey === 'chess' ? board.height - y : y + 1);
  }
  if (board.kind === 'grid' && ['go', 'gomoku', 'xiangqi'].includes(publicView.gameKey) && !board.coordinateMode) {
    board.coordinateMode = 'intersections';
  }
  const decorations = Array.isArray(board.decorations) ? [...board.decorations] : [];
  if (board.kind === 'grid' && ['go', 'gomoku'].includes(publicView.gameKey) && !decorations.some((item) => item.type === 'star')) {
    const starCoordinates = publicView.gameKey === 'go' && board.width === 9 && board.height === 9
      ? [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]]
      : publicView.gameKey === 'gomoku' && board.width === 15 && board.height === 15
        ? [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]
        : [];
    for (const [x, y] of starCoordinates) decorations.push({ type: 'star', position: { x, y } });
  }
  if (publicView.gameKey === 'xiangqi' && publicView.boardHints) {
    const river = publicView.boardHints.riverBetweenRows;
    if (Array.isArray(river) && river.length === 2 && !decorations.some((item) => item.type === 'river')) {
      decorations.push({ type: 'river', afterRow: Math.min(...river), leftLabel: '楚河', rightLabel: '漢界' });
    }
    const palaceHints = decorations.some((item) => item.type === 'line') ? [] : (publicView.boardHints.palaces || []);
    for (const palace of palaceHints) {
      if (![palace.x, palace.y, palace.width, palace.height].every(Number.isInteger)) continue;
      const right = palace.x + palace.width - 1;
      const bottom = palace.y + palace.height - 1;
      decorations.push({ type: 'line', from: { x: palace.x, y: palace.y }, to: { x: right, y: bottom } });
      decorations.push({ type: 'line', from: { x: right, y: palace.y }, to: { x: palace.x, y: bottom } });
    }
  }
  board.decorations = decorations;
  return publicView;
}

function seatIndex(ownerId, playerOrder) {
  if (ownerId == null) return -1;
  const index = playerOrder.indexOf(ownerId);
  if (index >= 0) return index;
  let hash = 0;
  for (const character of String(ownerId)) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return hash % SEAT_COLORS.length;
}

function semanticSeatFill(gameKey, seat, piece) {
  if (piece.fill) return piece.fill;
  if (['go', 'gomoku'].includes(gameKey) && seat === 0) return '#111111';
  if (['go', 'gomoku'].includes(gameKey) && seat === 1) return '#f7f4ea';
  if (gameKey === 'xiangqi' && seat === 0) return '#cf453b';
  if (gameKey === 'xiangqi' && seat === 1) return '#242936';
  return SEAT_COLORS[(seat < 0 ? 0 : seat) % SEAT_COLORS.length];
}

// label: a point name to print on the piece instead of its symbol (Chinese checkers), so a player can read the
// start point of a move straight off the piece; the colour already says whose piece it is, so no seat badge.
function drawPiece({ piece, x, y, radius, playerOrder, colors, gameKey, label = null }) {
  const seat = seatIndex(piece.ownerId, playerOrder);
  const fill = semanticSeatFill(gameKey, seat, piece);
  const darkText = ['#f7f4ea', '#f0b429'].includes(fill);
  const hideStoneSymbol = ['go', 'gomoku'].includes(gameKey) && ['●', '○', ''].includes(String(piece.symbol || ''));
  const symbol = hideStoneSymbol ? '' : escapeXml(piece.symbol || '●');
  const dash = seat < 1 ? 'none' : `${2 + (seat % 3) * 2} ${2 + ((seat + 1) % 3) * 2}`;
  if (label !== null) {
    return `<g data-piece-id="${escapeXml(piece.id)}" data-seat="${seat}"><circle cx="${x}" cy="${y}" r="${radius}" fill="${escapeXml(fill)}" stroke="${colors.pieceStroke}" stroke-width="3" stroke-dasharray="${dash}"/><text data-point-label="${escapeXml(label)}" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${pointLabelSize(radius)}" fill="${darkText ? '#111111' : '#ffffff'}">${escapeXml(label)}</text></g>`;
  }
  const badge = seat >= 0
    ? `<circle cx="${x + radius * 0.68}" cy="${y - radius * 0.68}" r="${Math.max(7, radius * 0.28)}" fill="${colors.canvas}" stroke="${colors.line}" stroke-width="2"/><text x="${x + radius * 0.68}" y="${y - radius * 0.68}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${Math.max(10, radius * 0.32)}" fill="${colors.text}">${seat + 1}</text>`
    : '';
  return `<g data-piece-id="${escapeXml(piece.id)}" data-seat="${seat}"><circle cx="${x}" cy="${y}" r="${radius}" fill="${escapeXml(fill)}" stroke="${colors.pieceStroke}" stroke-width="3" stroke-dasharray="${dash}"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans Symbols 2, Noto Sans Symbols, Cubic 11" font-size="${radius * 1.15}" fill="${darkText ? '#111111' : '#ffffff'}">${symbol}</text>${badge}</g>`;
}

// Cubic 11 is a pixel font drawn on an 11-pixel grid; whole multiples of 11 stay sharp.
function pointLabelSize(radius) {
  return Math.max(11, Math.round((radius * 0.62) / 11) * 11);
}

function drawDecorations(board, geometry, colors, layer = 'foreground') {
  const decorations = Array.isArray(board.decorations) ? board.decorations : [];
  return decorations.map((decoration) => {
    if (decoration.type === 'river' && geometry.gridPoint && layer === 'background') {
      const afterRow = finite(decoration.afterRow, 'river.afterRow');
      const top = geometry.gridPoint(0, afterRow).y;
      const bottom = geometry.gridPoint(0, afterRow + 1).y;
      const y = Math.min(top, bottom) + Math.abs(bottom - top) * 0.08;
      const height = Math.abs(bottom - top) * 0.84;
      const left = escapeXml(decoration.leftLabel || '楚河');
      const right = escapeXml(decoration.rightLabel || '漢界');
      return `<g data-decoration="river"><rect x="${geometry.left}" y="${y}" width="${geometry.width}" height="${height}" fill="${colors.river}"/><text x="${geometry.left + geometry.width * 0.28}" y="${y + height / 2}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${Math.max(18, height * 0.42)}" fill="${colors.text}">${left}</text><text x="${geometry.left + geometry.width * 0.72}" y="${y + height / 2}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${Math.max(18, height * 0.42)}" fill="${colors.text}">${right}</text></g>`;
    }
    if (decoration.type === 'line' && geometry.resolvePosition && layer === 'foreground') {
      const from = geometry.resolvePosition(decoration.from);
      const to = geometry.resolvePosition(decoration.to);
      return `<line data-decoration="line" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${colors.line}" stroke-width="${finite(decoration.width ?? 2, 'line.width')}"/>`;
    }
    if (decoration.type === 'star' && geometry.resolvePosition && layer === 'foreground') {
      const point = geometry.resolvePosition(decoration.position);
      return `<circle data-decoration="star" cx="${point.x}" cy="${point.y}" r="${finite(decoration.radius ?? 5, 'star.radius')}" fill="${colors.line}"/>`;
    }
    return '';
  }).join('');
}

function renderGrid(board, frame, playerOrder, colors, gameKey) {
  const intersections = board.coordinateMode === 'intersections';
  const horizontalUnits = intersections ? board.width - 1 : board.width;
  const verticalUnits = intersections ? board.height - 1 : board.height;
  const cell = Math.min(frame.width / horizontalUnits, frame.height / verticalUnits);
  const width = cell * horizontalUnits;
  const height = cell * verticalUnits;
  const left = frame.left + (frame.width - width) / 2;
  const top = frame.top + (frame.height - height) / 2;
  const gridPoint = (x, y) => ({
    x: left + (intersections ? x : x + 0.5) * cell,
    y: top + (intersections ? y : y + 0.5) * cell,
  });
  const geometry = { left, top, width, height, gridPoint, resolvePosition: (position) => gridPoint(position.x, position.y) };
  let result = `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="8" fill="${colors.board}" stroke="${colors.line}" stroke-width="4"/>`;
  if (!intersections && board.cellPattern !== 'plain') {
    for (let y = 0; y < board.height; y += 1) for (let x = 0; x < board.width; x += 1) {
      if ((x + y) % 2 === 1) {
        result += `<rect x="${left + x * cell}" y="${top + y * cell}" width="${cell}" height="${cell}" fill="${colors.boardAlt}"/>`;
      }
    }
  }
  result += drawDecorations(board, geometry, colors, 'background');
  const columns = intersections ? board.width : board.width + 1;
  const rows = intersections ? board.height : board.height + 1;
  for (let x = 0; x < columns; x += 1) {
    const position = left + x * cell;
    result += `<line x1="${position}" y1="${top}" x2="${position}" y2="${top + height}" stroke="${colors.line}" stroke-width="2"/>`;
  }
  for (let y = 0; y < rows; y += 1) {
    const position = top + y * cell;
    result += `<line x1="${left}" y1="${position}" x2="${left + width}" y2="${position}" stroke="${colors.line}" stroke-width="2"/>`;
  }
  result += drawDecorations(board, { ...geometry, resolvePosition: (position) => gridPoint(position.x, position.y) }, colors, 'foreground');
  const radius = Math.max(14, cell * (intersections ? 0.38 : 0.36));
  if (board.showCoordinates !== false) {
    for (let x = 0; x < board.width; x += 1) {
      const point = gridPoint(x, 0);
      result += `<text x="${point.x}" y="${top - (intersections ? radius + 18 : 14)}" text-anchor="middle" font-family="Cubic 11" font-size="18" fill="${colors.text}">${escapeXml(board.columnLabels?.[x] ?? x + 1)}</text>`;
    }
    for (let y = 0; y < board.height; y += 1) {
      const point = gridPoint(0, y);
      result += `<text x="${left - (intersections ? radius + 22 : 18)}" y="${point.y}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="18" fill="${colors.text}">${escapeXml(board.rowLabels?.[y] ?? y + 1)}</text>`;
    }
  }
  for (const piece of board.pieces) {
    const point = gridPoint(piece.position.x, piece.position.y);
    result += drawPiece({ piece, ...point, radius, playerOrder, colors, gameKey });
  }
  return result;
}

function renderGraph(board, frame, playerOrder, colors, gameKey) {
  if (!board.points.length) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Graph board must include points.');
  const xs = board.points.map((point) => Number(point.x));
  const ys = board.points.map((point) => Number(point.y));
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  // Chinese checkers moves are typed as point names, so every point carries its name: printed inside the empty point,
  // and on the piece that stands on it.
  const showPointLabels = gameKey === 'checkers';
  const inset = showPointLabels ? Math.round(frame.width * 0.05) : 0;
  const scale = Math.min((frame.width - inset * 2) / Math.max(1, maxX - minX), (frame.height - inset * 2) / Math.max(1, maxY - minY));
  const left = frame.left + (frame.width - (maxX - minX) * scale) / 2;
  const top = frame.top + (frame.height - (maxY - minY) * scale) / 2;
  const pointMap = new Map(board.points.map((point) => [point.id, {
    x: left + (point.x - minX) * scale,
    y: top + (point.y - minY) * scale,
    label: String(point.label ?? point.id),
  }]));
  const resolvePosition = (position) => pointMap.get(position.pointId);
  let result = `<rect x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" rx="24" fill="${colors.boardAlt}" stroke="${colors.line}" stroke-width="4"/>`;
  for (const edge of board.edges || []) {
    const from = pointMap.get(edge.from); const to = pointMap.get(edge.to);
    if (!from || !to) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Graph edge point does not exist.');
    result += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${colors.line}" stroke-width="2"/>`;
  }
  result += drawDecorations(board, { resolvePosition }, colors, 'foreground');
  const radius = showPointLabels ? Math.max(12, scale * 0.42) : Math.max(12, Math.min(28, scale * 0.32));
  const occupied = new Set(board.pieces.map((piece) => String(piece.position.pointId)));
  for (const [id, point] of pointMap) {
    if (!showPointLabels) {
      result += `<circle cx="${point.x}" cy="${point.y}" r="${Math.max(2, radius * 0.12)}" fill="${colors.line}"/>`;
    } else if (!occupied.has(id)) {
      result += `<circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="${colors.board}" stroke="${colors.line}" stroke-width="2"/><text data-point-label="${escapeXml(point.label)}" x="${point.x}" y="${point.y}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${pointLabelSize(radius)}" fill="${colors.text}">${escapeXml(point.label)}</text>`;
    }
  }
  for (const piece of board.pieces) {
    const point = resolvePosition(piece.position);
    result += drawPiece({ piece, x: point.x, y: point.y, radius, playerOrder, colors, gameKey, label: showPointLabels ? point.label : null });
  }
  return result;
}

// Roughly how wide a character is in Cubic 11, in em: CJK and full-width forms are square, the rest about half.
function charWidth(character) {
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(character) ? 1 : 0.55;
}

// Closing punctuation never starts a line: it stays at the end of the line before, a little past the width.
const NO_LINE_START = new Set([...'。，、；：？！」』）》〉】〕…—．,.;:?!)]}%']);

// Breaks a text into lines no wider than maxEm (in em of the font size).
function wrapText(text, maxEm) {
  const lines = [];
  let line = '';
  let width = 0;
  for (const character of String(text ?? '').replace(/\s+/gu, ' ').trim()) {
    const next = charWidth(character);
    if (line && width + next > maxEm && !NO_LINE_START.has(character)) {
      lines.push(line.trimEnd());
      line = '';
      width = 0;
      if (character === ' ') continue;
    }
    line += character;
    width += next;
  }
  if (line) lines.push(line);
  return lines;
}

// A text-only board (turtle soup, the lobby): the title, then each prompt wrapped to the frame's width so a long
// scenario reads in full. Lines that do not fit in the frame are cut, the last one ending in "…".
function renderNarrative(view, frame, colors) {
  const fontSize = 24;
  const lineHeight = 34;
  const padding = 40;
  // One em is kept free for closing punctuation hanging at the end of a line.
  const maxEm = (frame.width - padding * 2) / fontSize - 1;
  const firstLine = frame.top + 130;
  const maxLines = Math.max(1, Math.floor((frame.top + frame.height - padding - firstLine) / lineHeight) + 1);
  const lines = [];
  for (const prompt of (view.prompts || []).slice(0, 5)) {
    if (lines.length) lines.push({ gap: true });
    for (const text of wrapText(prompt?.text, maxEm)) lines.push({ text });
  }
  while (lines.length && lines[0].gap) lines.shift();
  const shown = lines.slice(0, maxLines);
  while (shown.length && shown.at(-1).gap) shown.pop();
  if (lines.length > shown.length && shown.length) {
    const last = shown.at(-1);
    last.text = `${[...last.text].slice(0, Math.max(1, [...last.text].length - 1)).join('')}…`;
  }
  let result = `<rect x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" rx="28" fill="${colors.boardAlt}" stroke="${colors.line}" stroke-width="4"/>`;
  result += `<text x="${frame.left + padding}" y="${frame.top + 70}" font-family="Cubic 11" font-size="34" fill="${colors.text}">${escapeXml(view.title || GAME_LABELS[view.gameKey] || '桌遊')}</text>`;
  let y = firstLine;
  for (const line of shown) {
    if (line.gap) {
      y += lineHeight * 0.5;
      continue;
    }
    result += `<text x="${frame.left + padding}" y="${y}" font-family="Cubic 11" font-size="${fontSize}" fill="${colors.text}">${escapeXml(line.text)}</text>`;
    y += lineHeight;
  }
  return result;
}

// The sides of the games whose pieces have a colour, by seat (the order the players joined in): the mark and the name
// the panel text and the image both use, matching the piece colours of semanticSeatFill (Chinese checkers uses
// SEAT_COLORS in seat order, for up to six players). Other games have no sides.
const GAME_SIDES = Object.freeze({
  checkers: Object.freeze([
    Object.freeze({ mark: '⚪', name: '白方' }),
    Object.freeze({ mark: '⚫', name: '黑方' }),
    Object.freeze({ mark: '🔴', name: '紅方' }),
    Object.freeze({ mark: '🔵', name: '藍方' }),
    Object.freeze({ mark: '🟢', name: '綠方' }),
    Object.freeze({ mark: '🟡', name: '黃方' }),
  ]),
  chess: Object.freeze([Object.freeze({ mark: '⚪', name: '白方' }), Object.freeze({ mark: '⚫', name: '黑方' })]),
  go: Object.freeze([Object.freeze({ mark: '⚫', name: '黑方' }), Object.freeze({ mark: '⚪', name: '白方' })]),
  gomoku: Object.freeze([Object.freeze({ mark: '⚫', name: '黑方' }), Object.freeze({ mark: '⚪', name: '白方' })]),
  xiangqi: Object.freeze([Object.freeze({ mark: '🔴', name: '紅方' }), Object.freeze({ mark: '⚫', name: '黑方' })]),
});

function seatSide(gameKey, seat) {
  return Object.hasOwn(GAME_SIDES, gameKey) ? GAME_SIDES[gameKey][seat] || null : null;
}

// How a finished game ended, in the words the image's bottom line uses. The engines' reason codes are English
// identifiers; a code with no entry here still reads as a plain "對局已結束".
const OUTCOME_REASONS = Object.freeze({
  checkmate: '將死',
  stalemate: '逼和',
  'insufficient-material': '子力不足，和局',
  'threefold-repetition': '同一局面重複三次，和局',
  'fivefold-repetition': '同一局面重複五次，和局',
  'fifty-move-rule': '五十步規則，和局',
  'seventy-five-move-rule': '七十五步規則，和局',
  'agreed-draw': '雙方同意和局',
  resignation: '對手認輸',
  'five-in-a-row': '五子連線',
  'board-full': '棋盤已滿，和局',
  'area-score': '數子計分',
  'area-score-tie': '數子計分平手',
  'all-pieces-in-target-camp': '全部棋子進入目標營地',
  'last-active-player': '其他玩家都已離開',
  'turtle-soup-solved': '湯底已被猜中',
  'host-ended': '房主結束了對局',
  'werewolf-village-win': '好人陣營獲勝',
  'werewolf-wolves-win': '狼人陣營獲勝',
});

function describeOutcome(publicView, playerOrder) {
  const outcome = publicView.outcome;
  // In xiangqi a player with no legal move loses (困斃), unlike chess where it is a draw.
  const reason = publicView.gameKey === 'xiangqi' && outcome.reason === 'stalemate'
    ? '困斃'
    : (Object.hasOwn(OUTCOME_REASONS, outcome.reason) ? OUTCOME_REASONS[outcome.reason] : null);
  const winners = Array.isArray(outcome.winnerIds) ? outcome.winnerIds : [];
  const side = outcome.type === 'win' && winners.length === 1
    ? seatSide(publicView.gameKey, playerOrder.indexOf(String(winners[0])))
    : null;
  const parts = [reason, side ? `${side.name}獲勝` : null].filter(Boolean);
  return parts.length ? `對局已結束：${parts.join('，')}` : '對局已結束';
}

function describeTurn(publicView, playerOrder) {
  if (!publicView.turn?.playerId) return publicView.outcome ? describeOutcome(publicView, playerOrder) : '等待中';
  const seat = playerOrder.indexOf(publicView.turn.playerId);
  const seatNumber = seat >= 0 ? seat + 1 : null;
  const side = seatSide(publicView.gameKey, seat)?.name || '玩家';
  return `輪到：${side}${seatNumber ? `（座位 ${seatNumber}）` : ''}`;
}

function renderBoardSvg(view, options = {}) {
  const publicView = normalizeRendererView(view);
  // The 121-point star needs a larger image than the other boards for its point names to stay readable.
  const defaultSize = publicView.gameKey === 'checkers' && publicView.board.kind === 'graph' ? 1440 : 960;
  const width = Number.isInteger(options.width) && options.width >= 480 ? options.width : defaultSize;
  const height = Number.isInteger(options.height) && options.height >= 480 ? options.height : defaultSize;
  const colors = THEMES[options.theme] || THEMES.light;
  const playerOrder = Array.isArray(options.playerOrder) ? options.playerOrder.map(String) : [];
  const frame = { left: 84, top: 130, width: width - 168, height: height - 230 };
  const title = escapeXml(options.title || GAME_LABELS[publicView.gameKey] || '桌遊');
  let body;
  if (publicView.board.kind === 'grid') body = renderGrid(publicView.board, frame, playerOrder, colors, publicView.gameKey);
  else if (publicView.board.kind === 'graph') body = renderGraph(publicView.board, frame, playerOrder, colors, publicView.gameKey);
  else body = renderNarrative(publicView, frame, colors);
  const turn = describeTurn(publicView, playerOrder);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><rect width="${width}" height="${height}" fill="${colors.canvas}"/><text x="${width / 2}" y="48" text-anchor="middle" font-family="Cubic 11" font-size="36" fill="${colors.text}">${title}</text>${body}<text x="${width / 2}" y="${height - 34}" text-anchor="middle" font-family="Cubic 11" font-size="22" fill="${colors.muted}">${escapeXml(turn)}</text></svg>`;
}

function loadBundledFontBuffers(fsImpl = fs) {
  return FONT_FILES.map((filePath) => fsImpl.readFileSync(filePath));
}

function resolveResvg(options) {
  if (options.Resvg) {
    if (options.resvgVersion !== RESVG_VERSION) {
      throw new BoardCoreError('RENDERER_VERSION_MISMATCH', `Renderer requires @resvg/resvg-js ${RESVG_VERSION}.`);
    }
    return options.Resvg;
  }
  let packageJson;
  let moduleValue;
  try {
    packageJson = require('@resvg/resvg-js/package.json');
    moduleValue = require('@resvg/resvg-js');
  } catch (_error) {
    throw new BoardCoreError('RENDERER_NOT_INSTALLED', `Install @resvg/resvg-js ${RESVG_VERSION}.`);
  }
  if (packageJson.version !== RESVG_VERSION) {
    throw new BoardCoreError('RENDERER_VERSION_MISMATCH', `Renderer requires @resvg/resvg-js ${RESVG_VERSION}.`);
  }
  return moduleValue.Resvg;
}

function renderBoardPng(view, options = {}) {
  const svg = renderBoardSvg(view, options);
  const Resvg = resolveResvg(options);
  const renderer = new Resvg(svg, {
    background: (THEMES[options.theme] || THEMES.light).canvas,
    shapeRendering: 2,
    textRendering: 1,
    font: {
      // The native resvg-js API loads files; fontBuffers is WASM-only.
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: 'Cubic 11',
      sansSerifFamily: 'Cubic 11',
    },
  });
  return Buffer.from(renderer.render().asPng());
}

module.exports = {
  FONT_FILES,
  GAME_LABELS,
  GAME_SIDES,
  RESVG_VERSION,
  SEAT_COLORS,
  THEMES,
  escapeXml,
  describeTurn,
  wrapText,
  loadBundledFontBuffers,
  normalizeRendererView,
  renderBoardPng,
  renderBoardSvg,
  seatSide,
  validatePublicBoard,
};
