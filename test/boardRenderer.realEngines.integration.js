const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeRendererView, renderBoardPng } = require('../src/games/renderer/svgBoardRenderer');

function requireEngine(root, name) {
  return require(path.join(path.resolve(root), 'src', 'games', 'engines', name));
}

function context(players, actorId, revision) {
  return { actorId, players, activePlayers: players, retiredPlayers: [], revision, now: '2026-09-22T00:00:00.000Z' };
}

function initial(engine, players) {
  const rules = typeof engine.normalizeOptions === 'function' ? engine.normalizeOptions({}) : {};
  return engine.createInitialState({ players, rules, seed: `renderer-${engine.key}-seed` });
}

function actualViews({ chessRoot, goRoot, checkersRoot }) {
  const players = ['p1', 'p2'];
  const chess = requireEngine(chessRoot, 'chess.js');
  const gomoku = requireEngine(chessRoot, 'gomoku.js');
  const go = requireEngine(goRoot, 'go.js');
  const xiangqi = requireEngine(goRoot, 'xiangqi.js');
  const checkers = requireEngine(checkersRoot, 'checkers.js');

  let gomokuState = initial(gomoku, players);
  gomokuState = gomoku.applyAction(gomokuState, { type: 'place', x: 7, y: 7 }, context(players, 'p1', 0)).state;
  gomokuState = gomoku.applyAction(gomokuState, { type: 'place', x: 8, y: 7 }, context(players, 'p2', 1)).state;
  let goState = initial(go, players);
  goState = go.applyAction(goState, { type: 'move', x: 2, y: 2 }, context(players, 'p1', 0)).state;
  goState = go.applyAction(goState, { type: 'move', x: 6, y: 6 }, context(players, 'p2', 1)).state;

  return new Map([
    ['chess', chess.getPublicView(initial(chess, players), { viewerId: 'p1', isActivePlayer: true })],
    ['gomoku', gomoku.getPublicView(gomokuState, { viewerId: 'p1', isActivePlayer: true })],
    ['go', go.getPublicView(goState, { viewerId: 'p1', isActivePlayer: true })],
    ['xiangqi', xiangqi.getPublicView(initial(xiangqi, players), { viewerId: 'p1', isActivePlayer: true })],
    ['checkers', checkers.getPublicView(initial(checkers, players), { viewerId: 'p1', isActivePlayer: true })],
  ]);
}

function inspectPng(buffer, PNG) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const image = PNG.sync.read(buffer);
  assert.deepEqual({ width: image.width, height: image.height }, { width: 960, height: 960 });
  return { bytes: buffer.length, width: image.width, height: image.height };
}

function main() {
  const [dependencyRoot, chessRoot, goRoot, checkersRoot, outputDirectory] = process.argv.slice(2);
  if (![dependencyRoot, chessRoot, goRoot, checkersRoot, outputDirectory].every(Boolean)) {
    throw new Error('Usage: node test/boardRenderer.realEngines.integration.js <isolated-node_modules> <chess-root> <go-root> <checkers-root> <output-directory>');
  }
  const { Resvg } = require(path.join(path.resolve(dependencyRoot), '@resvg', 'resvg-js'));
  const { PNG } = require(path.join(path.resolve(dependencyRoot), 'pngjs'));
  const views = actualViews({ chessRoot, goRoot, checkersRoot });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const report = {
    resvg: '2.6.2', pngjs: '7.0.0', chessJs: '1.4.0',
    candidates: {
      chessGomoku: '0e8514451b4b0eab0ca5a08785485508e3e07087',
      goXiangqi: 'fc49837f87374f3bae48cc3d549c7d537c29f0b2',
      checkers: 'e686db7d8f85857853dc18fb9e88d8cd4d887620',
    },
    samples: {},
  };
  for (const [name, view] of views) {
    const normalized = normalizeRendererView(view);
    if (['gomoku', 'go', 'xiangqi'].includes(name)) assert.equal(normalized.board.coordinateMode, 'intersections');
    if (['gomoku', 'go'].includes(name)) assert(normalized.board.decorations.filter((item) => item.type === 'star').length >= 5);
    if (name === 'xiangqi') {
      assert.equal(normalized.board.decorations.filter((item) => item.type === 'river').length, 1);
      assert.equal(normalized.board.decorations.filter((item) => item.type === 'line').length, 4);
    }
    report.samples[name] = {};
    for (const theme of ['light', 'dark']) {
      const buffer = renderBoardPng(view, {
        Resvg, resvgVersion: '2.6.2', theme, playerOrder: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      });
      report.samples[name][theme] = inspectPng(buffer, PNG);
      fs.writeFileSync(path.join(outputDirectory, `${name}-${theme}.png`), buffer);
    }
  }
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Real-engine renderer validation passed for ${views.size} committed engine views.`);
}

main();
