'use strict';

// The Owner DM start guard: three failed starts in a row hold the next start's Owner DMs back
// until it has run for ten minutes after ready. Each "process" below is one guard; a process
// that is simply dropped stands for one that crashed or exited non-zero.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { makeRealTempDir } = require('./support/realTempDir');
const { TEST_DATA_ROOT_MARKER } = require('../src/platform/testControlPolicy');
const {
  FAILURE_THRESHOLD,
  GUARD_FILE_NAME,
  STABLE_AFTER_READY_MS,
  createOwnerDmStartGuard,
  inspectOwnerDmStartGuard,
  writeGuardFile,
} = require('../src/systems/safety/ownerDmStartGuard');

const GUARD_MODULE = path.join(__dirname, '..', 'src', 'systems', 'safety', 'ownerDmStartGuard.js');
const SUPPRESSING = (reason, failures) =>
  `[OWNER_DM_GUARD] code=OWNER_DM_GUARD_SUPPRESSING reason=${reason} failures=${failures} threshold=3`;

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(['info', String(line)]),
    warn: (line) => lines.push(['warn', String(line)]),
    error: (line) => lines.push(['error', String(line)]),
  };
}

function dataRoot(t) {
  const root = makeRealTempDir('xiaoji-owner-dm-guard-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// One process of the bot, as far as the guard sees it, with its own logger and timers.
function startProcess(root, { runtimeMode = 'production', env = { XIAOJI_DATA_ROOT: root }, clock = { value: 1_000 },
  ...options } = {}) {
  const logger = capturingLogger();
  const timers = [];
  const guard = createOwnerDmStartGuard({
    runtimeMode,
    env,
    coinDbPath: path.join(root, 'xiaoji.sqlite'),
    logger,
    now: () => clock.value,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    ...options,
  });
  const begun = guard.begin();
  return {
    guard,
    begun,
    logger,
    timers,
    lines: () => logger.lines.map(([, line]) => line),
    // The ten minutes after ready have passed.
    passReadyWait() {
      const pending = timers.filter((timer) => !timer.cleared);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].ms, STABLE_AFTER_READY_MS);
      pending[0].callback();
    },
  };
}

function count(root) {
  return JSON.parse(fs.readFileSync(path.join(root, GUARD_FILE_NAME), 'utf8')).consecutiveFailures;
}

function seed(root, failures) {
  writeGuardFile(path.join(root, GUARD_FILE_NAME), failures, 1);
}

test('one and two failed starts in a row still send Owner DMs; after the third the next start sends none and says so',
  (t) => {
    const root = dataRoot(t);
    assert.equal(FAILURE_THRESHOLD, 3);
    // Three starts that each crash (or exit non-zero) before they succeed.
    for (const previous of [0, 1, 2]) {
      const started = startProcess(root);
      assert.equal(started.guard.allowsOwnerDm(), true, `after ${previous} failed starts`);
      assert.deepEqual([started.begun.mode, started.begun.previousFailures, started.begun.suppressed],
        ['active', previous, false]);
      assert.equal(count(root), previous + 1, 'the start counts as failed at once');
      assert.deepEqual(started.lines(), []);
    }
    const fourth = startProcess(root);
    assert.equal(fourth.guard.allowsOwnerDm(), false);
    assert.deepEqual(fourth.logger.lines, [['warn', SUPPRESSING('start-failures', 3)]]);
    assert.equal(count(root), 4);
    // It failed as well: the next one still sends nothing.
    const fifth = startProcess(root);
    assert.equal(fifth.guard.allowsOwnerDm(), false);
    assert.deepEqual(fifth.lines(), [SUPPRESSING('start-failures', 4)]);
    assert.equal(count(root), 5);
    // The file holds a count and a time, never a path or anything else.
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, GUARD_FILE_NAME), 'utf8'))).sort(),
      ['consecutiveFailures', 'schema', 'updatedAtMs']);
    assert.deepEqual(fs.readdirSync(root), [GUARD_FILE_NAME]);
  });

test('a start that ends before ten minutes after ready still failed; ten minutes after ready reset the count and resume DMs',
  (t) => {
    const root = dataRoot(t);
    seed(root, 3);
    const early = startProcess(root);
    assert.equal(early.guard.allowsOwnerDm(), false);
    early.guard.noteReady();
    assert.equal(early.timers.length, 1);
    assert.equal(early.timers[0].ms, STABLE_AFTER_READY_MS);
    // The process ends before the wait is over (the timer never fires): a failed start.
    assert.equal(count(root), 4);
    const stable = startProcess(root);
    assert.equal(stable.guard.allowsOwnerDm(), false);
    stable.guard.noteReady();
    stable.guard.noteReady();
    assert.equal(stable.timers.length, 1, 'a second ready starts no second wait');
    stable.passReadyWait();
    assert.equal(stable.guard.allowsOwnerDm(), true, 'the Owner DMs resume in the start that succeeded');
    assert.equal(count(root), 0);
    assert.deepEqual(stable.logger.lines, [['warn', SUPPRESSING('start-failures', 4)],
      ['info', '[OWNER_DM_GUARD] code=OWNER_DM_GUARD_RESUMED failures=4']]);
    // The next start finds no failure behind it; one that succeeds after one failure resets quietly.
    const next = startProcess(root);
    assert.deepEqual([next.guard.allowsOwnerDm(), next.begun.previousFailures, count(root)], [true, 0, 1]);
    const after = startProcess(root);
    after.guard.noteReady();
    after.passReadyWait();
    assert.equal(count(root), 0);
    assert.deepEqual(after.lines(), ['[OWNER_DM_GUARD] code=OWNER_DM_GUARD_RESET failures=1']);
  });

test('SIGINT or SIGTERM before the start succeeded leaves the count as it was; after it succeeded nothing changes', (t) => {
  const root = dataRoot(t);
  seed(root, 2);
  const stopped = startProcess(root);
  assert.equal(count(root), 3);
  stopped.guard.noteReady();
  stopped.guard.noteSignalStop();
  assert.equal(count(root), 2, 'neither a failure nor a success');
  assert.equal(stopped.timers[0].cleared, true);
  // A late timer or ready changes nothing after the stop.
  stopped.timers[0].callback();
  stopped.guard.noteReady();
  assert.equal(count(root), 2);
  assert.equal(stopped.timers.length, 1);

  // A start that is held back and then stopped by signal: still held back next time.
  seed(root, 3);
  const held = startProcess(root);
  held.guard.noteSignalStop();
  assert.equal(count(root), 3);
  assert.equal(startProcess(root).guard.allowsOwnerDm(), false);

  // After the start succeeded, a signal stop does not undo the reset.
  seed(root, 1);
  const succeeded = startProcess(root, { clock: { value: 5_000 } });
  succeeded.guard.noteReady();
  succeeded.passReadyWait();
  const written = fs.readFileSync(path.join(root, GUARD_FILE_NAME), 'utf8');
  succeeded.guard.noteSignalStop();
  assert.equal(fs.readFileSync(path.join(root, GUARD_FILE_NAME), 'utf8'), written);
  assert.equal(count(root), 0);
});

// A file system that refuses what `refuse(name, target)` says, with the given error code.
function failingFilesystem(refuse, code) {
  const wrap = (name) => (...args) => {
    if (refuse(name, String(args[0]))) throw Object.assign(new Error(`synthetic ${code}`), { code });
    return fs[name](...args);
  };
  return { ...fs, lstatSync: wrap('lstatSync'), openSync: wrap('openSync'), renameSync: wrap('renameSync'),
    readFileSync: wrap('readFileSync') };
}

test('a count that cannot be written or read holds that start\'s DMs back and never stops the start', (t) => {
  const root = dataRoot(t);
  const guardPath = path.join(root, GUARD_FILE_NAME);
  // The first write of a start fails: nothing is counted, so this start sends no Owner DM.
  const unwritable = failingFilesystem((name, target) => name === 'openSync' && target.endsWith('.tmp'), 'EACCES');
  const blocked = startProcess(root, { filesystem: unwritable });
  assert.equal(blocked.guard.allowsOwnerDm(), false);
  assert.deepEqual(blocked.lines(), ['[OWNER_DM_GUARD] code=OWNER_DM_GUARD_WRITE_FAILED stage=start cause=EACCES',
    SUPPRESSING('write-failed', 0)]);
  assert.equal(fs.existsSync(guardPath), false);
  // A signal stop has nothing to put back; a start that succeeds still resumes its DMs.
  blocked.guard.noteSignalStop();
  assert.equal(fs.existsSync(guardPath), false);
  const recovering = startProcess(root, { filesystem: unwritable });
  recovering.guard.noteReady();
  recovering.passReadyWait();
  assert.equal(recovering.guard.allowsOwnerDm(), true);
  assert.deepEqual(recovering.lines().slice(-2), [
    '[OWNER_DM_GUARD] code=OWNER_DM_GUARD_WRITE_FAILED stage=reset cause=EACCES',
    '[OWNER_DM_GUARD] code=OWNER_DM_GUARD_RESUMED failures=0']);
  assert.deepEqual(fs.readdirSync(root), [], 'no temporary file is left behind');

  // A rename that fails leaves the old count and no temporary file.
  seed(root, 1);
  const unrenamable = startProcess(root, { filesystem: failingFilesystem((name) => name === 'renameSync', 'EIO') });
  assert.equal(unrenamable.guard.allowsOwnerDm(), false);
  assert.equal(count(root), 1);
  assert.deepEqual(fs.readdirSync(root), [GUARD_FILE_NAME]);

  // A count that cannot be read is taken as the threshold.
  const unreadable = startProcess(root, {
    filesystem: failingFilesystem((name, target) => name === 'lstatSync' && target === guardPath, 'EIO'),
  });
  assert.equal(unreadable.guard.allowsOwnerDm(), false);
  assert.deepEqual(unreadable.lines(), ['[OWNER_DM_GUARD] code=OWNER_DM_GUARD_WRITE_FAILED stage=start cause=EIO',
    `${SUPPRESSING('state-unreadable', 3)} cause=EIO`]);
  assert.equal(count(root), 1);
});

test('a count that cannot be trusted holds the start back until a start succeeds and writes 0 again', (t) => {
  const root = dataRoot(t);
  const guardPath = path.join(root, GUARD_FILE_NAME);
  for (const text of ['not json', '{"schema":1,"consecutiveFailures":-1,"updatedAtMs":1}',
    '{"schema":2,"consecutiveFailures":0,"updatedAtMs":1}', '{"schema":1,"consecutiveFailures":0}',
    '{"schema":1,"consecutiveFailures":0,"updatedAtMs":1,"extra":true}', `{"pad":"${'x'.repeat(2_000)}"}`]) {
    fs.writeFileSync(guardPath, text);
    const started = startProcess(root);
    assert.equal(started.guard.allowsOwnerDm(), false, text.slice(0, 40));
    assert.deepEqual(started.lines(), [SUPPRESSING('state-invalid', 3)]);
    // Overwritten with the threshold plus this start.
    assert.equal(count(root), 4);
  }
  fs.writeFileSync(guardPath, 'not json');
  const repaired = startProcess(root);
  repaired.guard.noteReady();
  repaired.passReadyWait();
  assert.equal(count(root), 0);
  assert.equal(repaired.guard.allowsOwnerDm(), true);

  // A name taken by a folder is never written over.
  fs.rmSync(guardPath);
  fs.mkdirSync(guardPath);
  const folder = startProcess(root);
  assert.equal(folder.guard.allowsOwnerDm(), false);
  assert.deepEqual(folder.lines(), [
    '[OWNER_DM_GUARD] code=OWNER_DM_GUARD_WRITE_FAILED stage=start cause=OWNER_DM_GUARD_FILE_INVALID',
    SUPPRESSING('state-invalid', 3)]);
  assert.equal(fs.statSync(guardPath).isDirectory(), true);
  assert.deepEqual(inspectOwnerDmStartGuard(root), { state: 'invalid', cause: null, consecutiveFailures: null,
    threshold: 3, suppressNextStart: true });
  fs.rmdirSync(guardPath);

  // A temporary file left by a cut-off write is replaced.
  fs.writeFileSync(`${guardPath}.tmp`, 'half');
  startProcess(root);
  assert.equal(count(root), 1);
  assert.deepEqual(fs.readdirSync(root), [GUARD_FILE_NAME]);
});

test('without a usable location nothing is counted and the Owner DMs go on, with one log line', (t) => {
  const root = dataRoot(t);
  const missing = path.join(root, 'missing');
  const absent = startProcess(root, { env: { XIAOJI_DATA_ROOT: missing } });
  assert.deepEqual([absent.begun.mode, absent.guard.allowsOwnerDm()], ['unavailable', true]);
  assert.deepEqual(absent.lines(),
    ['[OWNER_DM_GUARD] code=OWNER_DM_GUARD_UNAVAILABLE cause=LEDGER_PATH_INVALID reason=base-missing']);
  absent.guard.noteReady();
  absent.guard.noteSignalStop();
  assert.deepEqual([absent.timers.length, fs.existsSync(missing)], [0, false]);

  // Inside the program folder (as the default coin database is): refused, nothing written there.
  const inside = startProcess(root, { env: { XIAOJI_DATA_ROOT: __dirname } });
  assert.deepEqual([inside.begun.mode, inside.guard.allowsOwnerDm()], ['unavailable', true]);
  assert.deepEqual(inside.lines(), ['[OWNER_DM_GUARD] code=OWNER_DM_GUARD_UNAVAILABLE cause=LEDGER_PATH_IN_PROJECT reason=base']);
  assert.equal(fs.existsSync(path.join(__dirname, GUARD_FILE_NAME)), false);

  // A test-control data root is never used by a production start.
  fs.writeFileSync(path.join(root, TEST_DATA_ROOT_MARKER), '{}');
  const testRoot = startProcess(root);
  assert.equal(testRoot.begun.mode, 'unavailable');
  assert.deepEqual(testRoot.lines(),
    ['[OWNER_DM_GUARD] code=OWNER_DM_GUARD_UNAVAILABLE cause=LEDGER_TEST_ROOT_IN_PRODUCTION reason=marker']);
  assert.deepEqual(fs.readdirSync(root), [TEST_DATA_ROOT_MARKER]);
});

test('test-control reads and writes nothing, so its runs never change the production count', (t) => {
  const root = dataRoot(t);
  seed(root, 2);
  const before = fs.readFileSync(path.join(root, GUARD_FILE_NAME));
  // Even pointed at the production data root, five test-control runs that each fail.
  for (let run = 0; run < 5; run += 1) {
    const testControl = startProcess(root, { runtimeMode: 'test-control' });
    assert.deepEqual([testControl.begun.mode, testControl.guard.allowsOwnerDm()], ['inactive', true]);
    testControl.guard.noteReady();
    testControl.guard.noteSignalStop();
    assert.deepEqual([testControl.timers.length, testControl.lines()], [0, []]);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, GUARD_FILE_NAME)), before);
  assert.deepEqual(fs.readdirSync(root), [GUARD_FILE_NAME]);
  // The next production start still finds two failures: it sends Owner DMs.
  const production = startProcess(root);
  assert.deepEqual([production.begun.previousFailures, production.guard.allowsOwnerDm()], [2, true]);
});

// Real processes: the count is written before anything else runs, so a crash, an exit with
// code 1, or a kill all count, and nothing has to be written at the end.
test('across real processes a crash or a non-zero exit counts, and the fourth start holds its DMs back', (t) => {
  const root = dataRoot(t);
  const script = `
    const path = require('node:path');
    const { createOwnerDmStartGuard } = require(${JSON.stringify(GUARD_MODULE)});
    const root = process.env.GUARD_TEST_ROOT;
    const guard = createOwnerDmStartGuard({ env: { XIAOJI_DATA_ROOT: root }, coinDbPath: path.join(root, 'xiaoji.sqlite'),
      logger: { info: (line) => console.log(line), warn: (line) => console.log(line), error: (line) => console.log(line) } });
    guard.begin();
    console.log('ALLOWS ' + guard.allowsOwnerDm());
    if (process.env.GUARD_TEST_END === 'crash') throw new Error('synthetic crash');
    process.exit(Number(process.env.GUARD_TEST_END));
  `;
  const run = (end) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GUARD_TEST_ROOT: root, GUARD_TEST_END: end } });
  const outcomes = ['crash', '1', '3'].map((end) => run(end));
  assert.deepEqual(outcomes.map((outcome) => outcome.status), [1, 1, 3]);
  assert.deepEqual(outcomes.map((outcome) => outcome.stdout.trim()), ['ALLOWS true', 'ALLOWS true', 'ALLOWS true']);
  assert.equal(count(root), 3);
  const fourth = run('0');
  assert.equal(fourth.status, 0);
  assert.deepEqual(fourth.stdout.trim().split(/\r?\n/u), [SUPPRESSING('start-failures', 3), 'ALLOWS false']);
  assert.equal(count(root), 4);
});

// index.js counts the start before anything can fail, hands the guard to both senders of Owner
// DMs, starts the ten-minute wait at ready, and puts the count back on SIGINT and SIGTERM only.
test('index.js begins the guard first, gates every Owner DM with it, and notes ready and signal stops', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8').replace(/\r\n/gu, '\n');
  const begin = source.indexOf('ownerDmStartGuard.begin();');
  assert.ok(begin > source.indexOf("require('dotenv').config({ quiet: true });"));
  for (const later of ["require('discord.js')", "startupDiagnostics.enterPhase('CONFIG_VALIDATE');",
    "requireEnvValue('DISCORD_TOKEN', token);", 'new Client({', 'async function start() {']) {
    assert.ok(begin < source.indexOf(later), later);
  }
  // Test-control is told by the same signal that makes this process a test-control run, read
  // before any .env file is loaded.
  assert.match(source, /createOwnerDmStartGuard\(\{\n {2}runtimeMode: testControlRuntimeController\.active \? 'test-control' : 'production',\n\}\);/u);
  assert.match(source, /new OwnerSafetyNotifier\(\{\n {2}client, ownerId, botId: clientId, logger, ownerDmGate: ownerDmStartGuard,\n\}\);/u);
  assert.match(source, /createProtectedEffects\(\{[^}]*\n {2}alertOptions: \{ ownerDmGate: ownerDmStartGuard \},\n\}\);/u);
  // Prepended after the event files are registered, so it runs before every ready handler (one that
  // throws cannot skip it), and before the ready check is prepended, so that check still runs first.
  const noteReadyAt = source.indexOf('\nclient.prependOnceListener(Events.ClientReady, () => ownerDmStartGuard.noteReady());\n');
  assert.ok(noteReadyAt > source.indexOf('registerEvents(client,'));
  assert.ok(noteReadyAt < source.indexOf('client.prependOnceListener(Events.ClientReady, (readyClient) => {'));
  assert.equal(source.split('ownerDmStartGuard.noteReady()').length, 2, 'registered once');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = source.slice(source.indexOf(`process.on('${signal}', () => {`));
    // The liveness record (outageMonitor.js) is told on the next line, before the stop begins.
    assert.match(handler, new RegExp(`^process\\.on\\('${signal}', \\(\\) => \\{\\n {2}if \\(testControlPolicy\\) ` +
      `testControlRuntimeController\\.requestStop\\('OWNER_REQUEST'\\);\\n {2}else \\{\\n {4}ownerDmStartGuard\\.noteSignalStop\\(\\);` +
      `\\n {4}outageMonitor\\.noteSignalStop\\(\\);\\n {4}void shutdown\\('${signal}'\\);\\n {2}\\}\\n\\}\\);`, 'u'));
  }
  // Only a stop asked for by signal puts the count back (the handler that stands in until the modules
  // are loaded, SIGINT, SIGTERM, and on Windows the console-window and Ctrl-Break handler): a failed
  // start or a stop for any other reason leaves this start counted as failed.
  assert.equal(source.match(/ownerDmStartGuard\.noteSignalStop\(\)/gu).length, 4);
  const shutdown = source.slice(source.indexOf('async function shutdown('), source.indexOf('testControlRuntimeController.bindShutdown('));
  assert.equal(shutdown.includes('ownerDmStartGuard'), false);
  assert.equal(source.slice(source.indexOf('start().catch(')).includes('ownerDmStartGuard'), false);
});

// The real entry point: a start that fails (here, before login, for a coin database that was never
// initialized) is counted by index.js itself, and the fourth such start says at once that it holds
// the Owner DMs back. No request can leave: the network is blocked before src/index.js loads.
const STARTUP_PRELOAD = String.raw`'use strict';
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const blocked = () => { throw new Error('XIAOJI_TEST_NETWORK_BLOCKED'); };
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
dns.lookup = (hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  process.nextTick(() => done(new Error('XIAOJI_TEST_NETWORK_BLOCKED')));
};
`;
const STARTUP_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR',
]);

test('src/index.js counts each failed start, and the fourth one in a row holds the Owner DMs back', (t) => {
  const root = dataRoot(t);
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  const preload = path.join(root, 'preload.js');
  fs.writeFileSync(preload, STARTUP_PRELOAD);
  const parentEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => STARTUP_PARENT_KEYS.has(key.toUpperCase())));
  const start = () => spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '..', 'src', 'index.js')], {
    cwd, encoding: 'utf8', shell: false, timeout: 120_000, windowsHide: true,
    env: { ...parentEnv, DISCORD_TOKEN: 'synthetic-token-for-a-failing-start', BOT_OWNER_ID: '444444444444444444',
      XIAOJI_DATA_ROOT: root, COIN_DB_PATH: path.join(root, 'xiaoji.sqlite') },
  });
  for (const expected of [1, 2, 3]) {
    const run = start();
    assert.equal(run.signal, null, 'the failed start ends by itself');
    assert.equal(run.status, 1);
    assert.equal(count(root), expected);
    assert.equal(`${run.stdout}${run.stderr}`.includes('OWNER_DM_GUARD'), false, run.stderr);
  }
  const fourth = start();
  assert.equal(fourth.status, 1);
  // One line at the start (a warning, on stderr), before anything else could fail.
  assert.match(fourth.stderr,
    /^\[[^\]]+\] \[warn\] \[OWNER_DM_GUARD\] code=OWNER_DM_GUARD_SUPPRESSING reason=start-failures failures=3 threshold=3\r?\n/u);
  assert.equal(fourth.stderr.split('\n').filter((line) => line.includes('OWNER_DM_GUARD')).length, 1);
  assert.equal(count(root), 4);
  // Only the count and the liveness record (outageMonitor.js) were written to the data root, and
  // nothing in the program folder.
  assert.deepEqual(fs.readdirSync(root).sort(), ['cwd', GUARD_FILE_NAME, 'outage-state.json', 'preload.js'].sort());
  assert.equal(fs.existsSync(path.join(__dirname, '..', GUARD_FILE_NAME)), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'outage-state.json')), false);
});
