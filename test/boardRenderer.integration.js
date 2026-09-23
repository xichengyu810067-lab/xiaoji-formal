const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderBoardPng } = require('../src/games/renderer/svgBoardRenderer');

function gridView(gameKey, width, height, coordinateMode, pieces, decorations = []) {
  return {
    gameKey, rulesVersion: 'synthetic-render-1',
    board: { kind: 'grid', width, height, coordinateMode, points: [], pieces, decorations },
    turn: { playerId: 'p1', phase: 'move' }, prompts: [], outcome: null,
  };
}

function checkersView() {
  const points = [];
  const edges = [];
  for (let row = 0; row < 11; row += 1) {
    const count = row < 6 ? row + 1 : 11 - row;
    for (let column = 0; column < count; column += 1) {
      const id = `${row}:${column}`;
      points.push({ id, x: column - (count - 1) / 2, y: row * 0.86 });
      if (column > 0) edges.push({ from: `${row}:${column - 1}`, to: id });
    }
  }
  return {
    gameKey: 'checkers', rulesVersion: 'synthetic-render-1',
    board: {
      kind: 'graph', width: null, height: null, points, edges,
      pieces: [
        { id: 'p1-a', ownerId: 'p1', position: { pointId: '0:0' }, symbol: '●' },
        { id: 'p2-a', ownerId: 'p2', position: { pointId: '5:0' }, symbol: '●' },
        { id: 'p3-a', ownerId: 'p3', position: { pointId: '5:5' }, symbol: '●' },
        { id: 'p4-a', ownerId: 'p4', position: { pointId: '10:0' }, symbol: '●' },
      ],
    },
    turn: { playerId: 'p1', phase: 'move' }, prompts: [], outcome: null,
  };
}

function sampleViews() {
  return new Map([
    ['chess', gridView('chess', 8, 8, 'cells', [
      { id: 'wk', ownerId: 'p1', position: { x: 4, y: 7 }, symbol: '♔' },
      { id: 'wq', ownerId: 'p1', position: { x: 3, y: 7 }, symbol: '♕' },
      { id: 'bk', ownerId: 'p2', position: { x: 4, y: 0 }, symbol: '♚' },
      { id: 'bq', ownerId: 'p2', position: { x: 3, y: 0 }, symbol: '♛' },
    ])],
    ['gomoku', gridView('gomoku', 15, 15, 'intersections', [
      { id: 'black', ownerId: 'p1', position: { x: 7, y: 7 }, symbol: '●' },
      { id: 'white', ownerId: 'p2', position: { x: 8, y: 7 }, symbol: '●' },
    ], [{ type: 'star', position: { x: 7, y: 7 } }])],
    ['go', gridView('go', 9, 9, 'intersections', [
      { id: 'go-black', ownerId: 'p1', position: { x: 2, y: 2 }, symbol: '●' },
      { id: 'go-white', ownerId: 'p2', position: { x: 6, y: 6 }, symbol: '●' },
    ], [{ type: 'star', position: { x: 4, y: 4 } }])],
    ['checkers', checkersView()],
    ['xiangqi', gridView('xiangqi', 9, 10, 'intersections', [
      { id: 'red-king', ownerId: 'p1', position: { x: 4, y: 9 }, symbol: '帥' },
      { id: 'red-rook', ownerId: 'p1', position: { x: 0, y: 9 }, symbol: '車' },
      { id: 'black-king', ownerId: 'p2', position: { x: 4, y: 0 }, symbol: '將' },
      { id: 'black-rook', ownerId: 'p2', position: { x: 8, y: 0 }, symbol: '車' },
    ], [
      { type: 'river', afterRow: 4, leftLabel: '楚河', rightLabel: '漢界' },
      { type: 'line', from: { x: 3, y: 0 }, to: { x: 5, y: 2 } },
      { type: 'line', from: { x: 5, y: 0 }, to: { x: 3, y: 2 } },
      { type: 'line', from: { x: 3, y: 7 }, to: { x: 5, y: 9 } },
      { type: 'line', from: { x: 5, y: 7 }, to: { x: 3, y: 9 } },
    ])],
    ['turtle-soup', {
      gameKey: 'turtle-soup', rulesVersion: 'synthetic-render-1',
      title: '海龜湯',
      board: { kind: 'narrative', width: null, height: null, points: [], pieces: [] },
      turn: null,
      prompts: [
        { type: 'question', text: '請透過是非問題推理真相。' },
        { type: 'status', text: '裁判只會回答是、否或無關。' },
      ],
      outcome: null,
    }],
  ]);
}

function analyzePng(buffer, PNG) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const image = PNG.sync.read(buffer);
  assert.equal(image.width, 960);
  assert.equal(image.height, 960);
  const colors = new Set();
  let opaque = 0;
  let brightness = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset]; const green = image.data[offset + 1]; const blue = image.data[offset + 2];
    const alpha = image.data[offset + 3];
    if (alpha > 0) opaque += 1;
    brightness += (red + green + blue) / 3;
    if (colors.size < 5000) colors.add(`${red},${green},${blue},${alpha}`);
  }
  return { width: image.width, height: image.height, opaque, uniqueColors: colors.size, meanBrightness: brightness / (image.width * image.height) };
}

function main() {
  const dependencyRoot = process.argv[2];
  const outputDirectory = process.argv[3];
  if (!dependencyRoot || !outputDirectory) throw new Error('Usage: node test/boardRenderer.integration.js <isolated-node_modules> <output-directory>');
  const { Resvg } = require(path.join(path.resolve(dependencyRoot), '@resvg', 'resvg-js'));
  const { PNG } = require(path.join(path.resolve(dependencyRoot), 'pngjs'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const report = { resvgVersion: RESVG_VERSION, samples: {} };
  for (const [name, view] of sampleViews()) {
    report.samples[name] = {};
    for (const theme of ['light', 'dark']) {
      const buffer = renderBoardPng(view, {
        Resvg,
        resvgVersion: '2.6.2',
        theme,
        playerOrder: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      });
      const metrics = analyzePng(buffer, PNG);
      assert(metrics.opaque === metrics.width * metrics.height);
      assert(metrics.uniqueColors > 24);
      fs.writeFileSync(path.join(outputDirectory, `${name}-${theme}.png`), buffer);
      report.samples[name][theme] = metrics;
    }
    assert(report.samples[name].light.meanBrightness - report.samples[name].dark.meanBrightness > 40);
  }
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Board renderer validation passed for ${Object.keys(report.samples).length} game views.`);
}

const RESVG_VERSION = '2.6.2';
main();
