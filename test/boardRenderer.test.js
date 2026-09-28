const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
  FONT_FILES,
  RESVG_VERSION,
  escapeXml,
  loadBundledFontBuffers,
  normalizeRendererView,
  renderBoardPng,
  renderBoardSvg,
  validatePublicBoard,
} = require('../src/games/renderer/svgBoardRenderer');

function gridView() {
  return {
    gameKey: 'xiangqi',
    rulesVersion: 'test-1',
    board: {
      kind: 'grid', width: 9, height: 10, coordinateMode: 'intersections', points: [],
      pieces: [
        { id: 'red-general', ownerId: 'red', position: { x: 4, y: 9 }, symbol: '帥' },
        { id: 'black-general', ownerId: 'black', position: { x: 4, y: 0 }, symbol: '將' },
      ],
      decorations: [
        { type: 'river', afterRow: 4, leftLabel: '楚河', rightLabel: '漢界' },
        { type: 'line', from: { x: 3, y: 0 }, to: { x: 5, y: 2 } },
        { type: 'line', from: { x: 5, y: 0 }, to: { x: 3, y: 2 } },
      ],
    },
    turn: { playerId: 'red', phase: 'move' }, prompts: [], outcome: null,
  };
}

test('bundled board fonts are exact pinned bytes and do not depend on host fonts', () => {
  assert.equal(FONT_FILES.length, 3);
  const hashes = loadBundledFontBuffers().map((buffer) => createHash('sha256').update(buffer).digest('hex'));
  assert.deepEqual(hashes, [
    '0088617baec0e8ac47e022cc1f38695f772301c9ef6d1f24a785abbef1e05d79',
    '0193f5f033612496df6b45ee92ac3b335bc6a5a24ff95da55ca87b33e57dcf62',
    '7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21',
  ]);
});

test('native PNG renderer draws distinct Chinese glyphs without system fonts', () => {
  // Inspect real native output: SVG text assertions cannot detect missing glyphs.
  const view = gridView();
  const options = { playerOrder: ['red', 'black'], title: '象棋' };
  const original = renderBoardPng(view, options);
  const changedPiece = structuredClone(view);
  changedPiece.board.pieces[0].symbol = '車';
  assert.notDeepEqual(original, renderBoardPng(changedPiece, options), 'different Chinese pieces must not both render as missing-glyph boxes');
  assert.notDeepEqual(original, renderBoardPng(view, { ...options, title: '圍棋' }), 'Chinese game titles must retain distinct glyphs');
  const changedRiver = structuredClone(view);
  changedRiver.board.decorations[0].leftLabel = '漢界';
  assert.notDeepEqual(original, renderBoardPng(changedRiver, options), 'river labels must retain distinct glyphs');
});

test('native chess glyphs remain distinguishable with only bundled fonts', () => {
  const { Resvg } = require('@resvg/resvg-js');
  const view = gridView();
  view.board.pieces = [view.board.pieces[0]];
  view.board.decorations = [];
  const images = new Set();
  for (const symbol of '♔♕♖♗♘♙♚♛♜♝♞♟') {
    view.board.pieces[0].symbol = symbol;
    const png = renderBoardPng(view, { playerOrder: ['red'] });
    images.add(createHash('sha256').update(png).digest('hex'));
  }
  assert.equal(images.size, 12, 'each chess piece must have a distinct raster glyph');
  const svg = renderBoardSvg(view, { playerOrder: ['red'] });
  const expected = Buffer.from(new Resvg(svg, {
    background: '#f6f2e8', shapeRendering: 2, textRendering: 1,
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Cubic 11', sansSerifFamily: 'Cubic 11' },
  }).render().asPng());
  assert.deepEqual(renderBoardPng(view, { playerOrder: ['red'] }), expected, 'PNG output must use the bundled native font files, not host fallback fonts');
});

test('grid labels match the coordinates accepted by Discord move inputs', () => {
  const { parseGridCoordinate } = require('../src/systems/games/board/discord/boardInteractionAdapter');
  for (const [gameKey, width, height] of [['chess', 8, 8], ['gomoku', 15, 15], ['go', 9, 9], ['xiangqi', 9, 10]]) {
    const view = { ...gridView(), gameKey, board: { kind: 'grid', width, height, points: [], pieces: [] } };
    const { board } = normalizeRendererView(view);
    assert.equal(board.columnLabels[0], 'A');
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const input = `${board.columnLabels[x]}${board.rowLabels[y]}`;
        const coordinate = gameKey === 'chess'
          ? { x: input.charCodeAt(0) - 65, y: 8 - Number(input.slice(1)) }
          : parseGridCoordinate(input, board);
        assert.deepEqual(coordinate, { x, y });
      }
    }
    assert.equal(view.board.columnLabels, undefined, 'normalization must not mutate saved game state');
  }
});

test('grid renderer supports coordinates, river, palace lines, Chinese pieces, and seat markers', () => {
  const svg = renderBoardSvg(gridView(), { playerOrder: ['red', 'black'], title: '象棋' });
  assert.match(svg, /data-decoration="river"/);
  assert.equal((svg.match(/data-decoration="river"/g) || []).length, 1);
  assert.equal((svg.match(/data-decoration="line"/g) || []).length, 2);
  assert.match(svg, /data-piece-id="red-general" data-seat="0"/);
  assert.match(svg, />帥<\/text>/);
  assert.match(svg, />將<\/text>/);
  assert.match(svg, />楚河<\/text>/);
  assert.match(svg, /font-family="Noto Sans Symbols 2, Noto Sans Symbols, Cubic 11"/);
});

test('graph renderer resolves point IDs and differentiates multiplayer seats', () => {
  const view = {
    gameKey: 'checkers', rulesVersion: 'test-1',
    board: {
      kind: 'graph', width: null, height: null,
      points: [
        { id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 0.5, y: 1 },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
      pieces: [
        { id: 'pa', ownerId: 'p1', position: { pointId: 'a' }, symbol: '●' },
        { id: 'pb', ownerId: 'p2', position: { pointId: 'b' }, symbol: '●' },
        { id: 'pc', ownerId: 'p3', position: { pointId: 'c' }, symbol: '●' },
      ],
    },
    turn: { playerId: 'p1', phase: 'move' }, prompts: [], outcome: null,
  };
  const svg = renderBoardSvg(view, { playerOrder: ['p1', 'p2', 'p3'] });
  assert.match(svg, /data-seat="0"/);
  assert.match(svg, /data-seat="1"/);
  assert.match(svg, /data-seat="2"/);
  assert.throws(
    () => validatePublicBoard({ ...view, board: { ...view.board, pieces: [{ id: 'bad', ownerId: 'p1', position: { pointId: 'missing' }, symbol: 'x' }] } }),
    /does not exist/
  );
});

test('renderer escapes public text and rejects an unpinned resvg implementation', () => {
  const view = gridView();
  const svg = renderBoardSvg(view, { title: '<script>alert(1)</script>' });
  assert(!svg.includes('<script>'));
  assert(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(escapeXml('"<&'), '&quot;&lt;&amp;');
  assert.throws(
    () => renderBoardPng(view, { Resvg: class {}, resvgVersion: '2.6.1' }),
    (error) => error?.code === 'RENDERER_VERSION_MISMATCH' && error.message.includes(RESVG_VERSION)
  );
});

test('Go stones use black-first white-second semantics and user-facing turn labels', () => {
  const view = {
    gameKey: 'go', rulesVersion: 'test-1',
    board: {
      kind: 'grid', width: 9, height: 9, coordinateMode: 'intersections', points: [],
      pieces: [
        { id: 'black-stone', ownerId: 'p1', position: { x: 2, y: 2 }, symbol: '●' },
        { id: 'white-stone', ownerId: 'p2', position: { x: 6, y: 6 }, symbol: '●' },
      ],
    },
    turn: { playerId: 'p1', phase: 'move' }, prompts: [], outcome: null,
  };
  const svg = renderBoardSvg(view, { playerOrder: ['p1', 'p2'] });
  assert.match(svg, />圍棋<\/text>/);
  assert.match(svg, /輪到：黑方（座位 1）/);
  assert.match(svg, /data-piece-id="black-stone"[\s\S]*?fill="#111111"/);
  assert.match(svg, /data-piece-id="white-stone"[\s\S]*?fill="#f7f4ea"/);
  assert.equal((svg.match(/>●<\/text>/g) || []).length, 0);
});

test('intersection edge coordinates are offset away from Xiangqi pieces', () => {
  const svg = renderBoardSvg(gridView(), { playerOrder: ['red', 'black'] });
  assert.match(svg, />象棋<\/text>/);
  assert.match(svg, /輪到：紅方（座位 1）/);
  const leftPieceX = Number(/data-piece-id="red-general"[^>]*><circle cx="([0-9.]+)"/u.exec(svg)?.[1]);
  const rowTenX = Number(new RegExp(`<text x="([0-9.]+)" y="[0-9.]+"[^>]*>10<\\/text>`).exec(svg)?.[1]);
  assert(Number.isFinite(leftPieceX));
  assert(Number.isFinite(rowTenX));
  assert(leftPieceX - rowTenX > 35);
});

test('renderer normalizes the committed Go and Xiangqi public-view shapes', () => {
  const go = normalizeRendererView({
    gameKey: 'go', rulesVersion: '1',
    board: {
      kind: 'grid', width: 9, height: 9,
      points: Array.from({ length: 81 }, (_, index) => ({ id: `p-${index}`, x: index % 9, y: Math.floor(index / 9) })),
      pieces: [{ id: 'stone', ownerId: 'p1', position: { x: 4, y: 4 }, symbol: '●' }],
    },
    turn: { playerId: 'p2', phase: 'play' }, prompts: [], outcome: null,
  });
  assert.equal(go.board.coordinateMode, 'intersections');
  assert.equal(go.board.decorations.filter((item) => item.type === 'star').length, 5);

  const xiangqi = normalizeRendererView({
    gameKey: 'xiangqi', rulesVersion: '1',
    board: {
      kind: 'grid', width: 9, height: 10,
      points: Array.from({ length: 90 }, (_, index) => ({ id: `p-${index}`, x: index % 9, y: Math.floor(index / 9) })),
      pieces: [],
    },
    boardHints: {
      riverBetweenRows: [4, 5],
      palaces: [{ color: 'black', x: 3, y: 0, width: 3, height: 3 }, { color: 'red', x: 3, y: 7, width: 3, height: 3 }],
    },
    turn: { playerId: 'red', phase: 'move' }, prompts: [], outcome: null,
  });
  assert.equal(xiangqi.board.coordinateMode, 'intersections');
  assert.equal(xiangqi.board.decorations.filter((item) => item.type === 'river').length, 1);
  assert.equal(xiangqi.board.decorations.filter((item) => item.type === 'line').length, 4);
});
