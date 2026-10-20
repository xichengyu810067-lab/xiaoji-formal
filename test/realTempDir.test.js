'use strict';

// test/support/realTempDir.js names the temporary directories of tests by their real path, so that code which refuses a
// data root whose real path differs from the path it was given is still reached when the runner's temp directory is a
// link or has a short name. The checks that depend on such a temp directory run in a child process whose temp
// directory is a link to a real directory, inside a sandbox of this test.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeRealTempDir, realTmpdir, removeRealTempDir } = require('./support/realTempDir');

test('a directory made by makeRealTempDir is its own real path inside the real temp directory, and removeRealTempDir removes it', () => {
  const first = makeRealTempDir('xiaoji-real-temp-');
  const second = makeRealTempDir('xiaoji-real-temp-');
  try {
    for (const directory of [first, second]) {
      assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(fs.statSync(directory).isDirectory());
      assert.equal(path.dirname(directory), realTmpdir());
      assert.ok(path.basename(directory).startsWith('xiaoji-real-temp-'));
    }
    assert.notEqual(first, second);
  } finally {
    removeRealTempDir(first);
    removeRealTempDir(second);
  }
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

// Runs in a child process whose temp directory (TEMP and TMP on Windows, TMPDIR elsewhere) is a link. It reports what the
// plain call gives, what the helpers give, and what the cleanup guard does with paths that are not inside the temp
// directory: all of them are inside the sandbox, so nothing outside it can be touched.
const PROBE = String.raw`'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { helper, link, target, outside } = JSON.parse(process.env.XIAOJI_REAL_TEMP_PROBE);
const { makeRealTempDir, realTmpdir, removeRealTempDir } = require(helper);
const real = (value) => fs.realpathSync.native(value);
const report = {};
report.tmpdirIsTheLink = os.tmpdir() === link;
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
report.plainPathIsNotReal = real(plain) !== plain;
fs.rmSync(plain, { recursive: true });
const made = makeRealTempDir('probe-');
report.madeIsReal = real(made) === made;
report.madeIsInTarget = path.dirname(made) === real(target);
report.realTmpdirIsTarget = realTmpdir() === real(target);
removeRealTempDir(made);
report.removed = !fs.existsSync(made);
const refused = {};
const victims = {
  outside,
  target: real(target),
  sandbox: path.dirname(real(target)),
  sibling: real(target) + '-sibling',
  escape: path.join(real(target), '..', 'outside'),
};
for (const [label, victim] of Object.entries(victims)) {
  try { removeRealTempDir(victim); refused[label] = 'removed'; } catch (error) { refused[label] = error.message; }
}
report.refused = refused;
report.outsideKept = fs.existsSync(path.join(outside, 'keep.txt'));
process.stdout.write(JSON.stringify(report));
`;

test('with a temp directory that is a link, makeRealTempDir still gives real paths and the cleanup guard holds', (t) => {
  const sandbox = makeRealTempDir('xiaoji-real-temp-sandbox-');
  t.after(() => removeRealTempDir(sandbox));
  const target = path.join(sandbox, 'target');
  const outside = path.join(sandbox, 'outside');
  const link = path.join(sandbox, 'link');
  fs.mkdirSync(target);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
  fs.symlinkSync(target, link, 'junction');

  const run = spawnSync(process.execPath, ['-e', PROBE], {
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      TEMP: link,
      TMP: link,
      TMPDIR: link,
      XIAOJI_REAL_TEMP_PROBE: JSON.stringify({
        helper: path.join(__dirname, 'support', 'realTempDir.js'), link, target, outside,
      }),
    },
  });

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const refusal = 'unsafe cleanup target';
  assert.deepEqual(JSON.parse(run.stdout), {
    // The temp directory of the child is the link, and a plain mkdtemp in it is not a real path.
    tmpdirIsTheLink: true,
    plainPathIsNotReal: true,
    // The helpers resolve it: the new directory is its own real path, inside the target of the link.
    madeIsReal: true,
    madeIsInTarget: true,
    realTmpdirIsTarget: true,
    removed: true,
    // Nothing that is not inside the real temp directory is removed, and the temp directory itself is not either.
    refused: { outside: refusal, target: refusal, sandbox: refusal, sibling: refusal, escape: refusal },
    outsideKept: true,
  });
});

// A child process that calls removeRealTempDir on each given path and reports what happened to it. Everything it
// is pointed at was made by the test inside its own sandbox, so a cleanup that wrongly goes through removes only that.
const REFUSAL_PROBE = String.raw`'use strict';
const { helper, victims } = JSON.parse(process.env.XIAOJI_REAL_TEMP_PROBE);
const { removeRealTempDir } = require(helper);
const outcomes = {};
for (const [label, victim] of Object.entries(victims)) {
  try { removeRealTempDir(victim); outcomes[label] = 'removed'; } catch (error) { outcomes[label] = error.message; }
}
process.stdout.write(JSON.stringify(outcomes));
`;

function runRefusalProbe({ victims, env = {}, cwd = process.cwd() }) {
  const run = spawnSync(process.execPath, ['-e', REFUSAL_PROBE], {
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
    windowsHide: true,
    cwd,
    env: {
      ...process.env,
      ...env,
      XIAOJI_REAL_TEMP_PROBE: JSON.stringify({ helper: path.join(__dirname, 'support', 'realTempDir.js'), victims }),
    },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout);
}

function makeSandbox(t) {
  const sandbox = makeRealTempDir('xiaoji-real-temp-sandbox-');
  t.after(() => removeRealTempDir(sandbox));
  return sandbox;
}

test('a path inside the temp directory that goes through a link leaving it is refused, and the outside is kept', (t) => {
  const sandbox = makeSandbox(t);
  const tempDirectory = path.join(sandbox, 'temp');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(tempDirectory);
  fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'sub', 'keep.txt'), 'kept');
  fs.symlinkSync(outside, path.join(tempDirectory, 'junction'), 'junction');

  const outcomes = runRefusalProbe({
    env: { TEMP: tempDirectory, TMP: tempDirectory, TMPDIR: tempDirectory },
    victims: {
      throughLink: path.join(tempDirectory, 'junction', 'sub'),
      theLinkItself: path.join(tempDirectory, 'junction'),
      missingBehindLink: path.join(tempDirectory, 'junction', 'not-there', 'deeper'),
    },
  });

  const refusal = 'unsafe cleanup target';
  assert.deepEqual(outcomes, { throughLink: refusal, theLinkItself: refusal, missingBehindLink: refusal });
  assert.equal(fs.readFileSync(path.join(outside, 'sub', 'keep.txt'), 'utf8'), 'kept');
});

test('an empty or relative path is refused instead of being resolved against the working directory', (t) => {
  const sandbox = makeSandbox(t);
  const workingDirectory = path.join(sandbox, 'cwd');
  fs.mkdirSync(path.join(workingDirectory, 'relative-victim'), { recursive: true });
  fs.writeFileSync(path.join(workingDirectory, 'relative-victim', 'keep.txt'), 'kept');

  // The working directory is inside the real temp directory, so a path resolved against it would pass the location check.
  const outcomes = runRefusalProbe({
    cwd: workingDirectory,
    victims: {
      empty: '',
      dot: '.',
      relative: 'relative-victim',
      relativeWithDot: path.join('.', 'relative-victim'),
    },
  });

  const refusal = 'unsafe cleanup target';
  assert.deepEqual(outcomes, { empty: refusal, dot: refusal, relative: refusal, relativeWithDot: refusal });
  assert.equal(fs.readFileSync(path.join(workingDirectory, 'relative-victim', 'keep.txt'), 'utf8'), 'kept');
  assert.throws(() => removeRealTempDir(undefined), /unsafe cleanup target/u);
});

test('cleanup is refused when the temp directory is a drive root or the home directory', (t) => {
  const sandbox = makeSandbox(t);
  const victim = path.join(sandbox, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'kept');
  const root = path.parse(sandbox).root;

  const asRoot = runRefusalProbe({ env: { TEMP: root, TMP: root, TMPDIR: root }, victims: { victim } });
  assert.deepEqual(asRoot, { victim: 'unsafe temp directory' });
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'kept');

  const asHome = runRefusalProbe({
    env: { TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox, HOME: sandbox, USERPROFILE: sandbox },
    victims: { victim },
  });
  assert.deepEqual(asHome, { victim: 'unsafe temp directory' });
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'kept');
});

test('a path that does not exist yet inside the temp directory is accepted and nothing happens', (t) => {
  const sandbox = makeSandbox(t);
  assert.doesNotThrow(() => removeRealTempDir(path.join(sandbox, 'not-there', 'deeper')));
  assert.ok(fs.statSync(sandbox).isDirectory());
});
