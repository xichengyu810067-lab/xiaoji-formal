const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PUBLIC_PACKAGE_SCRIPTS,
  SYNTHETIC_SCENARIO_FIXTURES,
  assertAllowedPath,
  buildPublicExportPlan,
  exportPublicFiles,
  gitEnvironment,
  isIgnoredUntracked,
  listUntrackedUnignored,
} = require('../scripts/create-public-export');

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// Stands in for story text: a refusal may name the rule and the path, never a value from the file.
const PRIVATE_VALUE = 'synthetic-private-value-that-must-never-be-echoed';

function makeSource(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-export-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function planFor(root, paths, options = {}) {
  return buildPublicExportPlan({ sourceRoot: root, manifest: { version: 1, paths }, ...options });
}

function refused(pattern) {
  return (error) => {
    assert.match(error.message, pattern);
    assert.equal(error.message.includes(PRIVATE_VALUE), false);
    return true;
  };
}

test('retrieval indexes and scenario documents are refused by file name wherever they sit', (t) => {
  const names = [
    'retrieval-index.v1.json',
    'retrieval-index.json',
    'Retrieval-Index.V2.JSON',
    'retrieval-index.v1.jsonl',
    'scenario.json',
    'red-door-scenario.v1.json',
    'Scenarios.JSON',
    'turtle-scenario.jsonc',
  ];
  for (const name of names) {
    const root = makeSource(t, { [`src/corpus/${name}`]: '{}' });
    assert.throws(() => planFor(root, ['src/corpus']), refused(/refuses scenario corpus file/), name);
    assert.throws(() => planFor(root, [`src/corpus/${name}`]), refused(/refuses scenario corpus file/), name);
  }
  assert.throws(() => assertAllowedPath('src/corpus/retrieval-index.v1.json'), /refuses scenario corpus file/);
  assert.equal(assertAllowedPath('src/corpus/settings.json'), 'src/corpus/settings.json');
});

test('copies of the retrieval index are refused too: the rule is not anchored to the start or the extension', (t) => {
  const copies = [
    'backup-retrieval-index.json',
    'old.retrieval-index.v1.json',
    'my_retrieval-index.v1.jsonl',
    'RETRIEVAL-INDEX-copy.JSON',
    'retrieval-index.v1.json.bak',
    'retrieval-index.v1.json~',
    'retrieval-index.v1.json.4242.tmp',
    'retrieval-index',
  ];
  for (const name of copies) {
    const root = makeSource(t, { [`src/corpus/${name}`]: '{}' });
    assert.throws(() => planFor(root, ['src/corpus']), refused(/refuses scenario corpus file/), name);
    assert.throws(() => assertAllowedPath(`src/corpus/${name}`), refused(/refuses scenario corpus file/), name);
  }
  // A listed synthetic fixture is the only exception, whatever the file is called.
  const fixture = 'test/fixtures/backup-retrieval-index.json';
  const root = makeSource(t, { [fixture]: '{}' });
  assert.throws(() => planFor(root, [fixture]), refused(/refuses scenario corpus file/));
  assert.deepEqual(planFor(root, [fixture], { syntheticFixtures: [fixture] }), [fixture]);
});

test('ordinary files whose names merely resemble the rules are still exported', (t) => {
  const root = makeSource(t, {
    'src/config/settings.json': JSON.stringify({ theme: 'dark', note: 'the answer and the solution are public knowledge' }),
    'src/config/index.json': '[]',
    'src/config/index-retrieval.json': '[]',
    'src/scenarioProvider.js': 'module.exports = {};\n',
    'docs/retrieval-notes.md': '# notes\n',
  });
  assert.deepEqual(planFor(root, ['src', 'docs']), [
    'docs/retrieval-notes.md',
    'src/config/index-retrieval.json',
    'src/config/index.json',
    'src/config/settings.json',
    'src/scenarioProvider.js',
  ]);
});

test('scenario-shaped JSON keys are refused whatever the file is called', (t) => {
  const documents = {
    revealText: JSON.stringify({ revealText: PRIVATE_VALUE }),
    nestedSolution: JSON.stringify({ a: [{ b: { Solution: PRIVATE_VALUE } }] }),
    answer: JSON.stringify({ answer: PRIVATE_VALUE }),
    snakeCase: JSON.stringify({ reveal_text: PRIVATE_VALUE }),
    solutionFactIds: JSON.stringify({ 'solution-fact-ids': [PRIVATE_VALUE] }),
    chinese: JSON.stringify({ 答案: PRIVATE_VALUE }),
    escapedKey: `{"\\u0072evealText": "${PRIVATE_VALUE}"}`,
    withBom: `${BYTE_ORDER_MARK}${JSON.stringify({ revealText: PRIVATE_VALUE })}`,
    jsonLines: `{"id":"a","revealText":"${PRIVATE_VALUE}"}\n{"id":"b"}\n`,
    truncated: `{"fine": 1, "answers": ["${PRIVATE_VALUE}"`,
  };
  for (const [label, content] of Object.entries(documents)) {
    const extension = label === 'jsonLines' ? 'jsonl' : 'json';
    const root = makeSource(t, { [`src/config/notes.${extension}`]: content });
    assert.throws(() => planFor(root, ['src/config']), refused(/scenario-shaped JSON/), label);
  }
});

test('JSON values that mention the words, deep nesting, and very wide arrays are not mistaken for scenarios', (t) => {
  let nested = '"leaf"';
  for (let depth = 0; depth < 1_500; depth += 1) nested = `[${nested}]`;
  const wide = `[${Array.from({ length: 200_000 }, (_, index) => index).join(',')}]`;
  const root = makeSource(t, {
    'src/config/values.json': JSON.stringify({ title: 'answer', text: 'the solution and the revealText are discussed' }),
    'src/config/deep.json': nested,
    'src/config/wide.json': wide,
  });
  assert.deepEqual(planFor(root, ['src/config']), [
    'src/config/deep.json',
    'src/config/values.json',
    'src/config/wide.json',
  ]);
});

test('JSON that cannot be screened as text is refused instead of skipped', (t) => {
  const utf16 = Buffer.from(`${BYTE_ORDER_MARK}${JSON.stringify({ title: 'harmless' })}`, 'utf16le');
  const root = makeSource(t, { 'src/config/wide-chars.json': utf16 });
  assert.throws(() => planFor(root, ['src/config']), refused(/unreadable JSON/));
});

test('a synthetic fixture is exempt only when listed by exact path under test/fixtures', (t) => {
  const fixture = 'test/fixtures/synthetic-scenario.json';
  const answers = 'test/fixtures/synthetic-answers.json';
  const keyed = 'test/fixtures/synthetic-keyed-scenario.json';
  const body = JSON.stringify({ revealText: 'synthetic reveal', solutionFactIds: ['a'] });
  // Built in pieces so this test file never contains a literal private-key header.
  const keyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const root = makeSource(t, {
    [fixture]: body,
    [answers]: JSON.stringify({ answer: 'synthetic' }),
    [keyed]: JSON.stringify({ revealText: 'synthetic', note: keyHeader }),
    'test/fixtures/unlisted-scenario.json': body,
    'src/synthetic-scenario.json': body,
  });

  // Not listed: refused by name, and a normally named file is refused by content.
  assert.throws(() => planFor(root, [fixture]), refused(/refuses scenario corpus file/));
  assert.throws(() => planFor(root, [answers]), refused(/scenario-shaped JSON/));

  // Listed by exact path: exempt from both screens, whether given as an array or a Set.
  assert.deepEqual(planFor(root, [fixture], { syntheticFixtures: [fixture] }), [fixture]);
  assert.deepEqual(planFor(root, [answers], { syntheticFixtures: new Set([answers]) }), [answers]);

  // Listing one fixture exempts neither an unlisted fixture nor the same name elsewhere.
  for (const other of ['test/fixtures/unlisted-scenario.json', 'src/synthetic-scenario.json']) {
    assert.throws(
      () => planFor(root, [other], { syntheticFixtures: [fixture] }),
      refused(/refuses scenario corpus file/),
      other
    );
  }

  // The exemption covers the scenario screens only; secret scanning still applies.
  assert.throws(() => planFor(root, [keyed], { syntheticFixtures: [keyed] }), refused(/sensitive content/));
});

test('the exception list cannot exempt anything outside test/fixtures or any non-JSON file', (t) => {
  const root = makeSource(t, { 'src/ok.js': 'module.exports = {};\n' });
  for (const entry of [
    'src/synthetic-scenario.json',
    'test/fixtures/helper.js',
    'test/synthetic-scenario.json',
    'data/test/fixtures/x.json',
  ]) {
    assert.throws(
      () => planFor(root, ['src/ok.js'], { syntheticFixtures: [entry] }),
      /must be a JSON file under test\/fixtures\//u,
      entry
    );
  }
  assert.throws(
    () => planFor(root, ['src/ok.js'], { syntheticFixtures: ['../test/fixtures/x.json'] }),
    /Unsafe public export path/u
  );
});

test('an export that would carry private scenario material creates no output at all', (t) => {
  const root = makeSource(t, {
    'src/ok.js': 'module.exports = {};\n',
    'src/notes.json': JSON.stringify({ solution: PRIVATE_VALUE }),
  });
  const output = path.join(os.tmpdir(), `xiaoji-export-guard-out-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const manifest = { version: 1, paths: ['src'] };

  assert.throws(() => exportPublicFiles({ sourceRoot: root, manifest, outputPath: output }), refused(/scenario-shaped JSON/));
  assert.equal(fs.existsSync(output), false);

  fs.rmSync(path.join(root, 'src/notes.json'));
  const result = exportPublicFiles({ sourceRoot: root, manifest, outputPath: output });
  assert.deepEqual(result.files, ['src/ok.js']);
  assert.equal(fs.existsSync(path.join(output, 'src/ok.js')), true);
});

test('live-test tooling is refused even when the manifest lists it by mistake, and no output is created', (t) => {
  const root = makeSource(t, {
    'src/ok.js': 'module.exports = {};\n',
    'tools/live-test/cleanup.js': 'module.exports = {};\n',
    'tools/live-test/constants.js': 'module.exports = {};\n',
    'tools/other/helper.js': 'module.exports = {};\n',
  });
  for (const paths of [['src', 'tools/live-test'], ['tools'], ['tools/live-test/cleanup.js'], ['tools/Live-Test']]) {
    assert.throws(() => planFor(root, paths), refused(/refuses protected path/u), JSON.stringify(paths));
  }
  for (const entry of ['tools/live-test/cleanup.js', 'test/live-test/cleanup.test.js', 'LIVE-TEST/x.js']) {
    assert.throws(() => assertAllowedPath(entry), /refuses protected path/u, entry);
  }
  assert.deepEqual(planFor(root, ['src', 'tools/other']), ['src/ok.js', 'tools/other/helper.js']);

  const output = path.join(os.tmpdir(), `xiaoji-export-guard-live-test-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  assert.throws(() => exportPublicFiles({ sourceRoot: root, manifest: { version: 1, paths: ['src', 'tools/live-test'] }, outputPath: output }),
    refused(/refuses protected path/u));
  assert.equal(fs.existsSync(output), false);

  // The same mistake in this repository's real manifest fails too.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public-export', 'manifest.json'), 'utf8'));
  assert.throws(() => buildPublicExportPlan({ manifest: { ...manifest, paths: [...manifest.paths, 'tools/live-test'] } }),
    /refuses protected path: tools\/live-test/u);
});

test('the live_test spelling and files named livetest* are refused too, wherever they sit', (t) => {
  for (const entry of ['tools/live_test/cleanup.js', 'LIVE_TEST/x.js', 'test/live_test/a.test.js']) {
    assert.throws(() => assertAllowedPath(entry), /refuses protected path/u, entry);
  }
  for (const entry of [
    'test/liveTestCleanup.test.js',
    'test/liveTestConstants.test.js',
    'test/support/liveTestFixtures.js',
    'docs/LIVETEST-notes.md',
    'src/livetest.js',
  ]) {
    assert.throws(() => assertAllowedPath(entry), /refuses protected file/u, entry);
  }
  // Names that only contain the words elsewhere are still exported.
  for (const entry of ['test/aliveTest.test.js', 'src/test-live.js', 'docs/live-testing-guide.md']) {
    assert.equal(assertAllowedPath(entry), entry);
  }
  const root = makeSource(t, {
    'test/ok.test.js': 'module.exports = {};\n',
    'test/liveTestCleanup.test.js': 'module.exports = {};\n',
  });
  assert.throws(() => planFor(root, ['test']), refused(/refuses protected file: test\/liveTestCleanup\.test\.js/u));
  assert.deepEqual(planFor(root, ['test/ok.test.js']), ['test/ok.test.js']);
});

test('the repository export plan passes and its exception list is explicit and confined to fixtures', () => {
  assert.equal(Object.isFrozen(SYNTHETIC_SCENARIO_FIXTURES), true);
  for (const entry of SYNTHETIC_SCENARIO_FIXTURES) {
    assert.match(entry, /^test\/fixtures\/.+\.(?:json|jsonc|json5|jsonl|ndjson)$/u);
  }

  const files = buildPublicExportPlan();
  assert.ok(files.includes('src/index.js'));
  assert.ok(files.includes('src/systems/games/board/turtleSoup/scenarioProvider.js'));
  assert.equal(files.some((file) => file.split('/').includes('live-test')), false);
  for (const file of files) {
    const baseName = path.posix.basename(file).toLowerCase();
    assert.equal(/^retrieval-index/u.test(baseName), false, file);
    if (/scenario.*\.(?:json[c5l]?|ndjson)$/u.test(baseName)) {
      assert.ok(SYNTHETIC_SCENARIO_FIXTURES.includes(file), file);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Files git ignores stay out of the export. These tests use a throwaway git work tree, so they are
// skipped on a machine without git; the checks without a work tree run everywhere.
// ---------------------------------------------------------------------------------------------

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const needsGit = { skip: hasGit ? false : 'git is not installed' };

// A work tree with the given files. Nothing is committed: `track` lists the files that are staged (with
// -f, so a file that .gitignore matches can be tracked), every other file stays untracked. git runs without
// the variables a git hook or `rebase -x` hands down, so it can only touch this directory.
function makeRepository(t, files, { track = [] } = {}) {
  const root = makeSource(t, files);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, env: gitEnvironment() });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  if (track.length) git('add', '-f', '--', ...track);
  return root;
}

const SECRET_LINE = `DISCORD_TOKEN=${PRIVATE_VALUE}\n`;

test('isIgnoredUntracked matches a file, or anything below a listed directory', () => {
  assert.equal(isIgnoredUntracked('a/b.txt', null), false);
  assert.equal(isIgnoredUntracked('a/b.txt', []), false);
  assert.equal(isIgnoredUntracked('a/b.txt', ['a/b.txt']), true);
  assert.equal(isIgnoredUntracked('a/b.txt.bak', ['a/b.txt']), false);
  assert.equal(isIgnoredUntracked('a/dist/x/y.js', ['a/dist/']), true);
  assert.equal(isIgnoredUntracked('a/dist', ['a/dist/']), true);
  assert.equal(isIgnoredUntracked('a/distant/x.js', ['a/dist/']), false);
});

test('in a git work tree the plan leaves out ignored files and never reads them', needsGit, (t) => {
  const files = {
    '.gitignore': 'dist/\n*.log\n*.local\n',
    'site/index.html': 'ok\n',
    'site/dist/bundle.js': 'built\n',
    'site/app.log': 'log\n',
    'site/settings.local': SECRET_LINE,
  };
  const repository = makeRepository(t, files, { track: ['.gitignore', 'site/index.html'] });
  assert.deepEqual(planFor(repository, ['site']), ['site/index.html']);
  // The same files without a work tree: every file on disk counts, and the content screen refuses the secret.
  const copy = makeSource(t, files);
  assert.throws(() => planFor(copy, ['site']), refused(/rejected sensitive content in site\/settings\.local/u));
});

test('an ignored file that is tracked anyway is exported, and an untracked file git does not ignore is too', needsGit, (t) => {
  const repository = makeRepository(t, {
    '.gitignore': 'site/forced.txt\n',
    'site/forced.txt': 'forced\n',
    'site/tracked.txt': 'tracked\n',
    'site/new.txt': 'new\n',
  }, { track: ['.gitignore', 'site/forced.txt', 'site/tracked.txt'] });
  assert.deepEqual(planFor(repository, ['site']), ['site/forced.txt', 'site/new.txt', 'site/tracked.txt']);
});

test('nested .gitignore files and negations apply, a manifest entry that is ignored is refused', needsGit, (t) => {
  const repository = makeRepository(t, {
    '.gitignore': 'dist/\n*.log\n',
    'site/.gitignore': '*.tmp\n!keep.tmp\n',
    'site/a.txt': 'a\n',
    'site/scratch.tmp': 'scratch\n',
    'site/keep.tmp': 'keep\n',
    'site/dist/bundle.js': 'built\n',
    'site/app.log': 'log\n',
  }, { track: ['.gitignore', 'site/.gitignore', 'site/a.txt'] });
  assert.deepEqual(planFor(repository, ['site']), ['site/.gitignore', 'site/a.txt', 'site/keep.tmp']);
  assert.throws(() => planFor(repository, ['site/app.log']), refused(/refuses a path that git ignores: site\/app\.log/u));
  assert.throws(() => planFor(repository, ['site/dist']), refused(/refuses a path that git ignores: site\/dist/u));
});

test('only the repository .gitignore files decide, not a per-clone exclude file', needsGit, (t) => {
  const repository = makeRepository(t, { 'site/a.txt': 'a\n', 'site/local.txt': 'local\n' }, { track: ['site/a.txt'] });
  fs.mkdirSync(path.join(repository, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repository, '.git', 'info', 'exclude'), 'site/local.txt\n');
  assert.deepEqual(planFor(repository, ['site']), ['site/a.txt', 'site/local.txt']);
});

test('an export copies no ignored file into its output', needsGit, (t) => {
  const repository = makeRepository(t, {
    '.gitignore': '.dev.vars\n',
    'site/index.html': 'ok\n',
    'site/.dev.vars': SECRET_LINE,
  }, { track: ['.gitignore', 'site/index.html'] });
  const outputPath = path.join(makeSource(t, {}), 'out');
  const result = exportPublicFiles({ sourceRoot: repository, outputPath, manifest: { version: 1, paths: ['site'] } });
  assert.deepEqual(result.files, ['site/index.html']);
  assert.deepEqual(fs.readdirSync(path.join(outputPath, 'site')).sort(), ['index.html']);
});

test('without a git work tree every file on disk counts, even next to a .gitignore', (t) => {
  const root = makeSource(t, {
    '.gitignore': 'dist/\n',
    'site/index.html': 'ok\n',
    'site/dist/bundle.js': 'built\n',
  });
  assert.deepEqual(planFor(root, ['site']), ['site/dist/bundle.js', 'site/index.html']);
});

// A directory that has a .git but is not a repository: git cannot answer there, and must not look above
// the temporary directory for another repository either.
function makeUnreadableWorkTree(t, files) {
  const root = makeSource(t, files);
  fs.mkdirSync(path.join(root, '.git'));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  t.after(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });
  return root;
}

test('when git cannot answer inside a work tree, the plan fails instead of guessing', (t) => {
  const root = makeUnreadableWorkTree(t, { 'site/index.html': 'ok\n' });
  assert.throws(() => planFor(root, ['site']), /Public export could not ask git which files are ignored/u);
});

// ---------------------------------------------------------------------------------------------
// A real export refuses files that git neither tracks nor ignores. The plan and a dry run do not.
// ---------------------------------------------------------------------------------------------

const UNTRACKED_FILES = {
  '.gitignore': 'cache/\n',
  'site/index.html': 'ok\n',
  'site/scratch-notes.txt': `notes ${PRIVATE_VALUE}\n`,
  'site/draft.md': 'draft\n',
  'outside/untracked.txt': 'not in the plan\n',
};
const SITE_MANIFEST = { version: 1, paths: ['site'] };

test('a real export refuses files git does not track, names them, and creates no output', needsGit, (t) => {
  const repository = makeRepository(t, UNTRACKED_FILES, { track: ['.gitignore', 'site/index.html'] });
  const outputPath = path.join(makeSource(t, {}), 'out');
  assert.throws(
    () => exportPublicFiles({ sourceRoot: repository, outputPath, manifest: SITE_MANIFEST }),
    (error) => {
      assert.match(error.message, /^Public export refuses files that git does not track: site\/draft\.md, site\/scratch-notes\.txt\. /u);
      // Only the paths of files in the plan are named: no content, no file outside the plan.
      assert.equal(error.message.includes(PRIVATE_VALUE), false);
      assert.equal(error.message.includes('outside/untracked.txt'), false);
      return true;
    },
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test('the plan and a dry run list the untracked files too and refuse nothing', needsGit, (t) => {
  const repository = makeRepository(t, UNTRACKED_FILES, { track: ['.gitignore', 'site/index.html'] });
  const expected = ['site/draft.md', 'site/index.html', 'site/scratch-notes.txt'];
  assert.deepEqual(buildPublicExportPlan({ sourceRoot: repository, manifest: SITE_MANIFEST }), expected);
  assert.deepEqual(exportPublicFiles({ sourceRoot: repository, manifest: SITE_MANIFEST, dryRun: true }), {
    dryRun: true,
    files: expected,
  });
});

test('a real export goes through when every file of the plan is tracked, staged or ignored', needsGit, (t) => {
  const repository = makeRepository(t, {
    '.gitignore': 'cache/\n',
    'site/index.html': 'ok\n',
    'site/staged.txt': 'staged, not committed\n',
    'site/cache/build.js': 'ignored\n',
    'outside/untracked.txt': 'not in the plan\n',
  }, { track: ['.gitignore', 'site/index.html', 'site/staged.txt'] });
  const outputPath = path.join(makeSource(t, {}), 'out');
  const result = exportPublicFiles({ sourceRoot: repository, outputPath, manifest: SITE_MANIFEST });
  assert.deepEqual(result.files, ['site/index.html', 'site/staged.txt']);
  assert.deepEqual(fs.readdirSync(path.join(outputPath, 'site')).sort(), ['index.html', 'staged.txt']);
});

test('only the first files are named when a real export refuses many', needsGit, (t) => {
  const many = {};
  for (let index = 0; index < 55; index += 1) many[`site/draft-${String(index).padStart(2, '0')}.txt`] = 'draft\n';
  const repository = makeRepository(t, { 'site/index.html': 'ok\n', ...many }, { track: ['site/index.html'] });
  const outputPath = path.join(makeSource(t, {}), 'out');
  assert.throws(
    () => exportPublicFiles({ sourceRoot: repository, outputPath, manifest: SITE_MANIFEST }),
    (error) => {
      assert.match(error.message, /site\/draft-49\.txt and 5 more\. /u);
      assert.equal(error.message.includes('draft-50'), false);
      return true;
    },
  );
});

test('without a git work tree a real export asks nothing about untracked files', (t) => {
  const root = makeSource(t, { 'site/index.html': 'ok\n', 'site/scratch-notes.txt': 'notes\n' });
  const outputPath = path.join(makeSource(t, {}), 'out');
  assert.equal(listUntrackedUnignored(root), null);
  const result = exportPublicFiles({ sourceRoot: root, outputPath, manifest: SITE_MANIFEST });
  assert.deepEqual(result.files, ['site/index.html', 'site/scratch-notes.txt']);
});

test('when git cannot answer, asking for the untracked files fails instead of guessing', (t) => {
  const root = makeUnreadableWorkTree(t, { 'site/index.html': 'ok\n' });
  assert.throws(() => listUntrackedUnignored(root), /Public export could not ask git which files are untracked/u);
});

// ---------------------------------------------------------------------------------------------
// Files that hold local secrets are refused by name, with or without git.
// ---------------------------------------------------------------------------------------------

test('Wrangler local secrets, runtime.env and cookie files are refused by name wherever they sit', (t) => {
  const refusedFiles = [
    '.dev.vars', '.dev.vars.production', '.dev.vars.staging', '.DEV.VARS', 'runtime.env', 'cookies.txt',
    'youtube.cookies.txt', 'youtube-cookies-2026.txt',
  ];
  for (const name of refusedFiles) {
    const root = makeSource(t, { [`site/${name}`]: 'x\n', 'site/ok.txt': 'ok\n' });
    for (const paths of [['site'], [`site/${name}`]]) {
      assert.throws(() => planFor(root, paths), (error) => {
        assert.match(error.message, /^Public export refuses protected file: /u);
        assert.ok(error.message.toLowerCase().endsWith(`site/${name}`.toLowerCase()), name);
        return true;
      }, name);
    }
  }
  for (const directory of ['.wrangler', '.cookies']) {
    const root = makeSource(t, { [`site/${directory}/state.txt`]: 'x\n', 'site/ok.txt': 'ok\n' });
    assert.throws(() => planFor(root, ['site']), refused(new RegExp(`refuses protected path: site/\\${directory}/state\\.txt`, 'u')), directory);
  }
  // A template, and files that only resemble the rules, are not secrets.
  const fine = makeSource(t, {
    'site/.dev.vars.example': 'TOKEN=your_token_here\n',
    'site/dev-vars.md': 'notes\n',
    'site/cookies-policy.txt': 'policy\n',
    'site/runtime-env.md': 'notes\n',
    'site/wrangler.toml': 'name = "x"\n',
  });
  assert.deepEqual(planFor(fine, ['site']), [
    'site/.dev.vars.example',
    'site/cookies-policy.txt',
    'site/dev-vars.md',
    'site/runtime-env.md',
    'site/wrangler.toml',
  ]);
});

test('a .dev.vars is refused in a work tree whether it is tracked or untracked, and left out when git ignores it', needsGit, (t) => {
  const files = { 'site/index.html': 'ok\n', 'site/.dev.vars': 'x\n' };
  const tracked = makeRepository(t, files, { track: ['site/index.html', 'site/.dev.vars'] });
  assert.throws(() => planFor(tracked, ['site']), refused(/refuses protected file: site\/\.dev\.vars/u));
  const untracked = makeRepository(t, files, { track: ['site/index.html'] });
  assert.throws(() => planFor(untracked, ['site']), refused(/refuses protected file: site\/\.dev\.vars/u));
  // The dry run and the real export refuse it as well: the name is checked before anything else.
  assert.throws(() => exportPublicFiles({ sourceRoot: untracked, manifest: SITE_MANIFEST, dryRun: true }), refused(/refuses protected file/u));
  const outputPath = path.join(makeSource(t, {}), 'out');
  assert.throws(() => exportPublicFiles({ sourceRoot: untracked, outputPath, manifest: SITE_MANIFEST }), refused(/refuses protected file/u));
  assert.equal(fs.existsSync(outputPath), false);
  // Ignored, it never reaches the plan; naming it in the manifest is refused.
  const ignored = makeRepository(t, { '.gitignore': '.dev.vars\n', ...files }, { track: ['.gitignore', 'site/index.html'] });
  assert.deepEqual(planFor(ignored, ['site']), ['site/index.html']);
  assert.throws(() => planFor(ignored, ['site/.dev.vars']), refused(/refuses protected file: site\/\.dev\.vars/u));
});

// ---------------------------------------------------------------------------------------------
// git runs without the variables a git hook hands down, and the command line warns about the files git
// does not track.
// ---------------------------------------------------------------------------------------------

test('gitEnvironment drops the variables that point git at a repository and keeps the others', () => {
  const environment = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    GIT_CONFIG_PARAMETERS: "'core.pager=cat'",
    GIT_CONFIG_COUNT: '1',
    GIT_DIR: '/outer/.git',
    GIT_WORK_TREE: '/outer',
    GIT_INDEX_FILE: '/outer/.git/index',
    GIT_COMMON_DIR: '/outer/.git',
    GIT_OBJECT_DIRECTORY: '/outer/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/outer/.git/objects',
    GIT_PREFIX: 'sub/',
    git_dir: '/outer/lowercase',
  };
  const cleaned = gitEnvironment(environment);
  assert.deepEqual(Object.keys(cleaned).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'HOME', 'PATH']);
  assert.equal(environment.GIT_DIR, '/outer/.git', "the caller's object is left alone");
  if (hasGit) {
    // Whatever this git lists as local to a repository is dropped, apart from the variables that pass configuration.
    const listed = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', windowsHide: true }).stdout
      .split(/\s+/u).filter((name) => /^GIT_[A-Z0-9_]+$/u.test(name));
    assert.ok(listed.length >= 7);
    const kept = Object.keys(gitEnvironment(Object.fromEntries(listed.map((name) => [name, 'x'])))).sort();
    assert.deepEqual(kept, listed.filter((name) => /^GIT_CONFIG(?:_PARAMETERS|_COUNT)?$/u.test(name)).sort());
  }
});

test('every git command here runs without the variables a git hook hands down, so no outer index is touched', needsGit, (t) => {
  // A repository with one staged file stands in for the work tree a hook, or git rebase -x, runs in.
  const outer = makeRepository(t, { 'outer.txt': 'outer\n' }, { track: ['outer.txt'] });
  const outerGit = path.join(outer, '.git');
  const snapshot = () => ({
    index: fs.readFileSync(path.join(outerGit, 'index')).toString('hex'),
    objects: fs.readdirSync(path.join(outerGit, 'objects'), { recursive: true }).sort(),
  });
  const before = snapshot();
  const handedDown = {
    GIT_DIR: outerGit,
    GIT_INDEX_FILE: path.join(outerGit, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(outerGit, 'objects'),
    GIT_COMMON_DIR: outerGit,
  };
  const saved = Object.fromEntries(Object.keys(handedDown).map((name) => [name, process.env[name]]));
  Object.assign(process.env, handedDown);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  // Everything from here runs with those variables set, as it would inside a hook.
  const repository = makeRepository(t, {
    '.gitignore': 'cache/\n',
    'site/index.html': 'ok\n',
    'site/note.txt': 'note\n',
  }, { track: ['.gitignore', 'site/index.html'] });
  assert.deepEqual(planFor(repository, ['site']), ['site/index.html', 'site/note.txt']);
  const outputPath = path.join(makeSource(t, {}), 'out');
  assert.throws(
    () => exportPublicFiles({ sourceRoot: repository, outputPath, manifest: SITE_MANIFEST }),
    /refuses files that git does not track: site\/note\.txt\./u,
  );
  // The throwaway repository staged its own files ...
  const staged = spawnSync('git', ['ls-files'], { cwd: repository, encoding: 'utf8', windowsHide: true, env: gitEnvironment() });
  assert.deepEqual(staged.stdout.trim().split('\n').sort(), ['.gitignore', 'site/index.html']);
  // ... and the outer repository did not change at all.
  assert.deepEqual(snapshot(), before);
});

const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'create-public-export.js'), 'utf8');

// A work tree that holds its own copy of the script and a manifest for site/, so that the command line can
// be run against it (the script reads the repository it sits in).
function makeCommandLineRepository(t, files, track) {
  return makeRepository(t, {
    'scripts/create-public-export.js': SCRIPT_SOURCE,
    'public-export/manifest.json': `${JSON.stringify(SITE_MANIFEST)}\n`,
    ...files,
  }, { track: ['scripts/create-public-export.js', 'public-export/manifest.json', ...track] });
}

function runExportCommandLine(root, args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'create-public-export.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('a dry run on the command line warns about files git does not track and still succeeds', needsGit, (t) => {
  const root = makeCommandLineRepository(t, UNTRACKED_FILES, ['.gitignore', 'site/index.html']);
  const result = runExportCommandLine(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Public export dry run: 3 files\.\r?\n$/u);
  assert.match(result.stderr, /^Warning: 2 file\(s\) in the plan are not tracked by git, so a real export would refuse them: site\/draft\.md, site\/scratch-notes\.txt\.\r?\n$/u);
  // Only paths are printed, and only the ones in the plan.
  assert.equal(`${result.stdout}${result.stderr}`.includes(PRIVATE_VALUE), false);
  assert.equal(result.stderr.includes('outside/untracked.txt'), false);
});

test('a real export on the command line refuses them, names them and creates no output', needsGit, (t) => {
  const root = makeCommandLineRepository(t, UNTRACKED_FILES, ['.gitignore', 'site/index.html']);
  const outputPath = path.join(makeSource(t, {}), 'out');
  const result = runExportCommandLine(root, ['--output', outputPath]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Public export refuses files that git does not track: site\/draft\.md, site\/scratch-notes\.txt\. /u);
  assert.equal(fs.existsSync(outputPath), false);
});

test('with every file of the plan tracked the command line prints no warning and a real export goes through', needsGit, (t) => {
  const root = makeCommandLineRepository(t, UNTRACKED_FILES, ['.gitignore', 'site/index.html', 'site/draft.md', 'site/scratch-notes.txt']);
  const dryRun = runExportCommandLine(root, ['--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.stderr, '');
  const outputPath = path.join(makeSource(t, {}), 'out');
  const real = runExportCommandLine(root, ['--output', outputPath]);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^Public export prepared: 3 files\.\r?\n$/u);
  assert.deepEqual(fs.readdirSync(path.join(outputPath, 'site')).sort(), ['draft.md', 'index.html', 'scratch-notes.txt']);
});

test('the repository .gitignore keeps local secret files out wherever they sit, except the template', needsGit, (t) => {
  const repository = makeRepository(t, { '.gitignore': fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8') });
  const ignored = (file) => spawnSync('git', ['check-ignore', '-q', '--', file], {
    cwd: repository,
    windowsHide: true,
    env: gitEnvironment(),
  }).status === 0;
  for (const file of [
    'cloudflare/status-worker/.dev.vars',
    'website/.dev.vars',
    'a/b/.dev.vars.production',
    'website/.wrangler/state.txt',
    'src/deep/.wrangler/cache.json',
    'cookies.txt',
    'src/youtube-cookies-1.txt',
    'x/runtime.env',
  ]) {
    assert.equal(ignored(file), true, file);
  }
  for (const file of ['.dev.vars.example', 'website/.dev.vars.example', 'docs/dev-vars.md', 'website/wrangler.toml']) {
    assert.equal(ignored(file), false, file);
  }
});

function exportPackage(t, packageText) {
  const root = makeSource(t, { 'package.json': packageText });
  const output = path.join(os.tmpdir(), `xiaoji-export-package-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  exportPublicFiles({ sourceRoot: root, manifest: { version: 1, paths: ['package.json'] }, outputPath: output });
  return fs.readFileSync(path.join(output, 'package.json'));
}

test('the exported package.json keeps only the public scripts and is otherwise the file as copied', (t) => {
  // Only allowed scripts: the file is not rewritten, whatever its layout.
  const allowedOnly = '{"name":"synthetic",\r\n  "scripts": {"start": "node src/index.js",   "test": "node scripts/run-tests.js"}}';
  assert.deepEqual(exportPackage(t, allowedOnly), Buffer.from(allowedOnly, 'utf8'));
  // An unlisted script is left out and the allowed ones stay, in their order.
  const exported = JSON.parse(exportPackage(t, `${JSON.stringify({
    name: 'synthetic',
    scripts: { start: 'node src/index.js', 'synthetic:local-operation': 'node local.js', test: 'node scripts/run-tests.js' },
    dependencies: { 'discord.js': '^14.27.0' },
  }, null, 2)}\n`).toString('utf8'));
  assert.deepEqual(exported, {
    name: 'synthetic',
    scripts: { start: 'node src/index.js', test: 'node scripts/run-tests.js' },
    dependencies: { 'discord.js': '^14.27.0' },
  });
  // A package without scripts is copied as it is.
  assert.deepEqual(exportPackage(t, '{"name":"synthetic"}'), Buffer.from('{"name":"synthetic"}', 'utf8'));
});

test('every script of the repository package.json is a public one, so its export is byte for byte the same', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'package.json'));
  const { scripts } = JSON.parse(source.toString('utf8'));
  assert.deepEqual(Object.keys(scripts).filter((name) => !PUBLIC_PACKAGE_SCRIPTS.includes(name)), []);
  assert.ok(Object.isFrozen(PUBLIC_PACKAGE_SCRIPTS));
  assert.deepEqual(exportPackage(t, source), source);
});

test('a JEV_API_KEY line with a real value is refused; an empty or placeholder line is not', (t) => {
  for (const line of [`JEV_API_KEY=${PRIVATE_VALUE}`, `export JEV_API_KEY = ${PRIVATE_VALUE}`, `jev_api_key=${PRIVATE_VALUE}`]) {
    const root = makeSource(t, { 'docs/setup.md': `# Setup\n${line}\n` });
    assert.throws(() => planFor(root, ['docs/setup.md']), refused(/sensitive content/), line);
  }
  for (const line of ['JEV_API_KEY=', 'JEV_API_KEY=your_jev_api_key', 'JEV_API_KEY=optional_value', 'export JEV_API_KEY=', 'The JEV_API_KEY variable holds the key']) {
    const root = makeSource(t, { 'docs/setup.md': `# Setup\n${line}\n` });
    assert.deepEqual(planFor(root, ['docs/setup.md']), ['docs/setup.md'], line);
  }
});
