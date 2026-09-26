const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const relocatedModules = [
  'discord/boardControls',
  'discord/boardCustomId',
  'discord/boardDiscordRuntime',
  'discord/boardInteractionAdapter',
  'discord/boardPresenter',
  'discord/discordBoardBridge',
  'discord/turtleSoupDiscordAdapter',
  'engines/checkers',
  'engines/checkers/board',
  'engines/chess',
  'engines/go',
  'engines/gomoku',
  'engines/turtleSoup',
  'engines/xiangqi',
  'renderer/svgBoardRenderer',
  'storage/boardSchema',
  'storage/sqliteBoardStore',
  'turtleSoup/boardStoreAdapter',
  'turtleSoup/buildIndexCli',
  'turtleSoup/errors',
  'turtleSoup/judgeOutput',
  'turtleSoup/judgeWorkflow',
  'turtleSoup/providerAdapter',
  'turtleSoup/retriever',
  'turtleSoup/revealService',
  'turtleSoup/scenarioProvider',
  'turtleSoup/scenarioSchema',
  'turtleSoup/trustedJudgeAction',
];

test('old board module paths expose the same CommonJS exports as the relocated implementations', () => {
  for (const modulePath of relocatedModules) {
    const oldModule = require(path.join('..', 'src', 'games', modulePath));
    const newModule = require(path.join('..', 'src', 'systems', 'games', 'board', modulePath));
    assert.strictEqual(oldModule, newModule, modulePath);
  }
});

test('the original turtle soup index CLI path still runs as an executable entry', () => {
  const entry = path.join(__dirname, '..', 'src', 'games', 'turtleSoup', 'buildIndexCli.js');
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node src\/games\/turtleSoup\/buildIndexCli\.js/);
});
