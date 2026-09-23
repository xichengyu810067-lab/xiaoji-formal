const fs = require('node:fs');
const path = require('node:path');

const { BoardCoreError, cloneJson } = require('../contracts');

const RESVG_VERSION = '2.6.2';
const FONT_DIRECTORY = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = Object.freeze([
  path.join(FONT_DIRECTORY, 'NotoSansSymbols-Regular.ttf'),
  path.join(FONT_DIRECTORY, 'Cubic_11.ttf'),
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

function drawPiece({ piece, x, y, radius, playerOrder, colors, gameKey }) {
  const seat = seatIndex(piece.ownerId, playerOrder);
  const fill = semanticSeatFill(gameKey, seat, piece);
  const darkText = ['#f7f4ea', '#f0b429'].includes(fill);
  const hideStoneSymbol = ['go', 'gomoku'].includes(gameKey) && ['●', '○', ''].includes(String(piece.symbol || ''));
  const symbol = hideStoneSymbol ? '' : escapeXml(piece.symbol || '●');
  const dash = seat < 1 ? 'none' : `${2 + (seat % 3) * 2} ${2 + ((seat + 1) % 3) * 2}`;
  const badge = seat >= 0
    ? `<circle cx="${x + radius * 0.68}" cy="${y - radius * 0.68}" r="${Math.max(7, radius * 0.28)}" fill="${colors.canvas}" stroke="${colors.line}" stroke-width="2"/><text x="${x + radius * 0.68}" y="${y - radius * 0.68}" text-anchor="middle" dominant-baseline="central" font-family="Cubic 11" font-size="${Math.max(10, radius * 0.32)}" fill="${colors.text}">${seat + 1}</text>`
    : '';
  return `<g data-piece-id="${escapeXml(piece.id)}" data-seat="${seat}"><circle cx="${x}" cy="${y}" r="${radius}" fill="${escapeXml(fill)}" stroke="${colors.pieceStroke}" stroke-width="3" stroke-dasharray="${dash}"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans Symbols, Cubic 11" font-size="${radius * 1.15}" fill="${darkText ? '#111111' : '#ffffff'}">${symbol}</text>${badge}</g>`;
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
  const scale = Math.min(frame.width / Math.max(1, maxX - minX), frame.height / Math.max(1, maxY - minY));
  const left = frame.left + (frame.width - (maxX - minX) * scale) / 2;
  const top = frame.top + (frame.height - (maxY - minY) * scale) / 2;
  const pointMap = new Map(board.points.map((point) => [point.id, {
    x: left + (point.x - minX) * scale,
    y: top + (point.y - minY) * scale,
  }]));
  const resolvePosition = (position) => pointMap.get(position.pointId);
  let result = `<rect x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" rx="24" fill="${colors.boardAlt}" stroke="${colors.line}" stroke-width="4"/>`;
  for (const edge of board.edges || []) {
    const from = pointMap.get(edge.from); const to = pointMap.get(edge.to);
    if (!from || !to) throw new BoardCoreError('INVALID_PUBLIC_VIEW', 'Graph edge point does not exist.');
    result += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${colors.line}" stroke-width="2"/>`;
  }
  result += drawDecorations(board, { resolvePosition }, colors, 'foreground');
  const radius = Math.max(12, Math.min(28, scale * 0.32));
  for (const point of pointMap.values()) result += `<circle cx="${point.x}" cy="${point.y}" r="${Math.max(2, radius * 0.12)}" fill="${colors.line}"/>`;
  for (const piece of board.pieces) {
    const point = resolvePosition(piece.position);
    result += drawPiece({ piece, ...point, radius, playerOrder, colors, gameKey });
  }
  return result;
}

function renderNarrative(view, frame, colors) {
  const prompts = (view.prompts || []).slice(0, 5);
  let result = `<rect x="${frame.left}" y="${frame.top}" width="${frame.width}" height="${frame.height}" rx="28" fill="${colors.boardAlt}" stroke="${colors.line}" stroke-width="4"/>`;
  result += `<text x="${frame.left + 40}" y="${frame.top + 70}" font-family="Cubic 11" font-size="34" fill="${colors.text}">${escapeXml(view.title || '海龜湯')}</text>`;
  prompts.forEach((prompt, index) => {
    result += `<text x="${frame.left + 40}" y="${frame.top + 130 + index * 52}" font-family="Cubic 11" font-size="24" fill="${colors.text}">${escapeXml(prompt.text).slice(0, 80)}</text>`;
  });
  return result;
}

function describeTurn(publicView, playerOrder) {
  if (!publicView.turn?.playerId) return publicView.outcome?.reason || '等待中';
  const seat = playerOrder.indexOf(publicView.turn.playerId);
  const seatNumber = seat >= 0 ? seat + 1 : null;
  let side = '玩家';
  if (['go', 'gomoku'].includes(publicView.gameKey)) side = seat === 0 ? '黑方' : seat === 1 ? '白方' : '玩家';
  else if (publicView.gameKey === 'chess') side = seat === 0 ? '白方' : seat === 1 ? '黑方' : '玩家';
  else if (publicView.gameKey === 'xiangqi') side = seat === 0 ? '紅方' : seat === 1 ? '黑方' : '玩家';
  return `輪到：${side}${seatNumber ? `（座位 ${seatNumber}）` : ''}`;
}

function renderBoardSvg(view, options = {}) {
  const publicView = normalizeRendererView(view);
  const width = Number.isInteger(options.width) && options.width >= 480 ? options.width : 960;
  const height = Number.isInteger(options.height) && options.height >= 480 ? options.height : 960;
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
  const fontBuffers = options.fontBuffers || loadBundledFontBuffers();
  const renderer = new Resvg(svg, {
    background: (THEMES[options.theme] || THEMES.light).canvas,
    shapeRendering: 2,
    textRendering: 1,
    font: {
      fontBuffers,
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
  RESVG_VERSION,
  SEAT_COLORS,
  THEMES,
  escapeXml,
  describeTurn,
  loadBundledFontBuffers,
  normalizeRendererView,
  renderBoardPng,
  renderBoardSvg,
  validatePublicBoard,
};
