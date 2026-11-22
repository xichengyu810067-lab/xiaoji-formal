'use strict';

// The host launcher keeps the bot's JSON stores outside the program folder and names that folder on the command
// line (--retained-data-root=<absolute folder>), so a new release folder starts with them. Without the argument the
// stores stay in the program folder's src/data, as before. Each case runs in its own Node process, because the
// folder can be set only once and only before any store resolves its path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const MODULE = path.join(__dirname, '..', 'src', 'platform', 'retainedDataSource.js');
const PROGRAM_ROOT = path.resolve(__dirname, '..');
const root = makeRealTempDir('xiaoji-retained-args-');

test.after(() => removeRealTempDir(root));

function run(args, extra = '') {
  const script = [
    `const source = require(${JSON.stringify(MODULE)});`,
    'let configured;',
    'try { configured = source.configureRetainedDataSourceRootFromArgs(JSON.parse(process.argv[1])); }',
    "catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); process.exit(0); }",
    extra,
    "process.stdout.write(JSON.stringify({ configured, file: source.retainedDataFile('guildConfig.json') }));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script, JSON.stringify(args)], {
    encoding: 'utf8',
    env: { ...process.env, XIAOJI_RUNTIME_MODE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('without the argument the stores stay in the program folder, whatever else is on the command line', () => {
  for (const args of [[], ['--inspect'], ['retained-data-root=/tmp']]) {
    assert.deepEqual(run(args), { configured: null, file: path.join(PROGRAM_ROOT, 'src', 'data', 'guildConfig.json') });
  }
});

test('the launcher\'s folder is used for every store, in its src/data', () => {
  const folder = path.join(root, 'retained');
  fs.mkdirSync(folder);
  assert.deepEqual(run([`--retained-data-root=${folder}`]),
    { configured: folder, file: path.join(folder, 'src', 'data', 'guildConfig.json') });
});

test('a relative, missing, linked or repeated folder stops the start', () => {
  const folder = path.join(root, 'real');
  fs.mkdirSync(folder);
  const link = path.join(root, 'linked');
  // A junction on Windows (no privilege needed); the type is ignored elsewhere.
  fs.symlinkSync(folder, link, 'junction');
  const cases = [
    [['--retained-data-root=relative/folder'], /absolute/u],
    [['--retained-data-root='], /absolute/u],
    [[`--retained-data-root=${path.join(root, 'missing')}`], /ENOENT/u],
    [[`--retained-data-root=${link}`], /without links/u],
    [[`--retained-data-root=${folder}`, `--retained-data-root=${folder}`], /only once/u],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    assert.match(result.error, message, JSON.stringify(args));
  }
});

test('the folder cannot be named after a store has resolved its path', () => {
  const folder = path.join(root, 'late');
  fs.mkdirSync(folder);
  const script = [
    `const source = require(${JSON.stringify(MODULE)});`,
    "source.retainedDataFile('polls.json');",
    `try { source.configureRetainedDataSourceRootFromArgs([${JSON.stringify(`--retained-data-root=${folder}`)}]); }`,
    "catch (error) { process.stdout.write(error.message); }",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, XIAOJI_RUNTIME_MODE: '' } });
  assert.match(result.stdout, /before stores load/u);
});

test('the bot names the folder first thing, before anything that could resolve a store', () => {
  const index = fs.readFileSync(path.join(PROGRAM_ROOT, 'src', 'index.js'), 'utf8');
  const firstCode = index.split('\n').find((line) => line.trim() && !line.trim().startsWith('//'));
  assert.match(firstCode,
    /^require\('\.\/platform\/retainedDataSource'\)\.configureRetainedDataSourceRootFromArgs\(process\.argv\.slice\(2\)\);$/u);
});
