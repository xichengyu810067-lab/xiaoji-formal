const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const boundaries = require('../scripts/check-boundaries');
const { assertAllowedPath, buildPublicExportPlan, gitEnvironment } = require('../scripts/create-public-export');
const { checkProject } = require('../scripts/check-project');

const {
  ADAPTER_FILES,
  collectViolations,
  findBoundaryFailures,
  formatReport,
  loadBaseline,
  loadsIn,
  scanSource,
} = boundaries;

const projectRoot = path.join(__dirname, '..');
const checkerPath = path.join(projectRoot, 'scripts', 'check-boundaries.js');
const STUB = 'module.exports = {};\n';

// Source text for the synthetic projects. Loads are built by these helpers instead of being written out
// in this file, because the project check reads every relative require of an exported file, strings
// included, and would take the synthetic ones for dependencies of this test.
const load = (request, quote = "'") => `require(${quote}${request}${quote})`;
const loads = (...requests) => `${requests.map((request) => `${load(request)};`).join('\n')}\n`;
const forward = (request, lineEnd = '\n') => `module.exports = ${load(request)};${lineEnd}`;
const cliForward = (request) => [
  `const implementation = ${load(request)};`,
  'if (require.main === module) process.exitCode = implementation.main();',
  'module.exports = implementation;',
  '',
].join('\n');

function baselineJson(entries) {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

function entry(id, file, target, extra = {}) {
  return { id, rule: id.split('-')[0], file, target, count: 1, disposition: 'unscheduled', ...extra };
}

// Builds a throwaway project from { relativePath: content } with an empty baseline unless the files
// bring their own, and removes it when the test ends.
function makeProject(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries({ 'scripts/boundary-baseline.json': baselineJson([]), ...files })) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

// "file -> target" for every violation one rule finds, sorted.
function found(root, rule) {
  const { violations, errors } = collectViolations({ root, rules: [rule] });
  assert.deepEqual(errors, []);
  return [...violations.values()].map((violation) => `${violation.file} -> ${violation.target}`).sort();
}

function failuresOf(root, rule) {
  return findBoundaryFailures({ projectRoot: root, rules: [rule] });
}

function assertBlocks(root, rule, pattern) {
  const failures = failuresOf(root, rule);
  assert.ok(failures.length > 0, `${rule} should fail this project`);
  assert.ok(failures.some((failure) => pattern.test(failure)), `no ${rule} failure matches ${pattern}:\n${failures.join('\n')}`);
}

// -------------------------------------------------------------------------------------------
// The real project
// -------------------------------------------------------------------------------------------

test('the real project has no boundary violation beyond the recorded baseline', () => {
  assert.deepEqual(findBoundaryFailures(), []);
});

test('every registered adapter still exists, so the adapter list does not rot', () => {
  for (const file of ADAPTER_FILES) {
    assert.ok(fs.existsSync(path.join(projectRoot, file)), `${file} is registered but missing; remove it from ADAPTER_FILES`);
  }
});

test('the checker, its baseline, this test and the extension contract are part of the public export', () => {
  const exported = new Set(buildPublicExportPlan());
  for (const file of [
    'scripts/check-boundaries.js',
    'scripts/boundary-baseline.json',
    'test/architectureBoundaries.test.js',
    'docs/EXTENSION_CONTRACT.md',
  ]) {
    assert.ok(exported.has(file), `${file} must be in the public export`);
  }
});

test('npm run check runs the boundary check and fails with its findings', (t) => {
  assert.doesNotThrow(() => checkProject());
  const original = boundaries.findBoundaryFailures;
  boundaries.findBoundaryFailures = () => ['R9 synthetic boundary failure'];
  t.after(() => { boundaries.findBoundaryFailures = original; });
  assert.throws(() => checkProject(), /R9 synthetic boundary failure/u);
});

// -------------------------------------------------------------------------------------------
// R1 to R5: dependency direction
// -------------------------------------------------------------------------------------------

test('R1 refuses entry code that loads a storage engine, also through the legacy board path', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': STUB,
    'src/systems/safety/sideEffectLedger.js': STUB,
    'src/systems/games/board/storage/sqliteBoardStore.js': STUB,
    'src/games/storage/sqliteBoardStore.js': forward('../../systems/games/board/storage/sqliteBoardStore'),
    'src/utils/guildConfig.js': STUB,
    'src/commands/a.js': `const db = ${load('../services/coinDatabase')};\n`,
    'src/events/b.js': `const config = ${load('../utils/guildConfig')};\n`,
    'src/handlers/c.js': `const ledger = ${load('../systems/safety/sideEffectLedger')};\n`,
    'src/index.js': `const store = ${load('./games/storage/sqliteBoardStore')};\n`,
    'deploy-commands.js': loads('./src/services/coinDatabase'),
    'src/loadCommands.js': loads('./systems/games/board/storage/sqliteBoardStore'),
    // Below the entry layer the same modules are fine.
    'src/services/ok.js': loads('./coinDatabase'),
    'src/systems/ok.js': loads('../services/coinDatabase'),
  });
  assert.deepEqual(found(root, 'R1'), [
    'deploy-commands.js -> src/services/coinDatabase.js',
    'src/commands/a.js -> src/services/coinDatabase.js',
    'src/events/b.js -> src/utils/guildConfig.js',
    'src/handlers/c.js -> src/systems/safety/sideEffectLedger.js',
    'src/index.js -> src/games/storage/sqliteBoardStore.js',
    'src/loadCommands.js -> src/systems/games/board/storage/sqliteBoardStore.js',
  ]);
  assertBlocks(root, 'R1', /R1 new violation: src\/commands\/a\.js:1 loads the storage engine src\/services\/coinDatabase\.js/u);
});

test('R1 passes when entry code only calls systems and services', (t) => {
  const root = makeProject(t, {
    'src/services/coinService.js': STUB,
    'src/commands/a.js': `const coins = ${load('../services/coinService')};\n`,
  });
  assert.deepEqual(failuresOf(root, 'R1'), []);
});

test('R2 refuses systems, services and platform code that load a command or an event', (t) => {
  const root = makeProject(t, {
    'src/commands/ping.js': STUB,
    'src/commands/folder/index.js': STUB,
    'src/events/ready.js': STUB,
    'src/systems/games/launcher.js': `const ping = ${load('../../commands/ping')};\n`,
    'src/systems/games/viaIndex.js': `const folder = ${load('../../commands/folder')};\n`,
    'src/services/s.js': `const ready = ${load('../events/ready')};\n`,
    'src/platform/p.js': `const lazy = () => ${load('../commands/ping')};\n`,
    // Entry code may load entry code.
    'src/events/other.js': loads('../commands/ping'),
    'src/loadCommands.js': loads('./commands/ping'),
    'src/handlers/h.js': loads('../events/ready'),
    'src/index.js': loads('./events/ready'),
    'deploy-commands.js': loads('./src/commands/ping'),
  });
  assert.deepEqual(found(root, 'R2'), [
    'src/platform/p.js -> src/commands/ping.js',
    'src/services/s.js -> src/events/ready.js',
    'src/systems/games/launcher.js -> src/commands/ping.js',
    'src/systems/games/viaIndex.js -> src/commands/folder/index.js',
  ]);
  assertBlocks(root, 'R2', /R2 new violation: src\/systems\/games\/launcher\.js:1 loads the Discord entry module src\/commands\/ping\.js/u);
});

test('R3 refuses systems and services that load a coordinator and coordinators that load entry code', (t) => {
  const root = makeProject(t, {
    'src/coordinators/reward.js': STUB,
    'src/commands/ping.js': STUB,
    'src/systems/work/a.js': loads('../../coordinators/reward'),
    'src/services/b.js': loads('../coordinators/reward'),
    'src/coordinators/up.js': loads('../commands/ping'),
    // Entry code calls coordinators; coordinators call systems.
    'src/index.js': loads('./coordinators/reward'),
    'src/commands/uses.js': loads('../coordinators/reward'),
    'src/coordinators/down.js': loads('../systems/work/a'),
  });
  assert.deepEqual(found(root, 'R3'), [
    'src/coordinators/up.js -> src/commands/ping.js',
    'src/services/b.js -> src/coordinators/reward.js',
    'src/systems/work/a.js -> src/coordinators/reward.js',
  ]);
  assertBlocks(root, 'R3', /R3 new violation: src\/systems\/work\/a\.js:1 loads the coordinator src\/coordinators\/reward\.js/u);
});

// A module that moved into src/coordinators leaves an adapter at its old path for outside callers. The
// registered adapters (ADAPTER_FILES) stand in for it: src/services/workService.js and
// src/systems/community/calendarSystem.js are registered, src/services/unregistered.js is not.
test('R3 lets a registered one-line adapter forward to a coordinator, and exempts nothing else', (t) => {
  const root = makeProject(t, {
    'src/coordinators/launch.js': STUB,
    'src/coordinators/other.js': STUB,
    // Exempt: registered, and a one-line forward (in both forms R8 accepts).
    'src/services/workService.js': forward('../coordinators/launch'),
    'src/systems/community/calendarSystem.js': cliForward('../../coordinators/launch'),
    // Not exempt: the same file when it is not registered, and any other file that loads a coordinator.
    'src/services/unregistered.js': forward('../coordinators/launch'),
    'src/systems/work/w.js': loads('../../coordinators/launch'),
    // Not exempt: a registered adapter that is more than a one-line forward loses the exemption for
    // every load it has, the forward included. R8 reports its format.
    'src/services/chipService.js': `${forward('../coordinators/launch')}${loads('../coordinators/other')}`,
    // A registered adapter that forwards to something that is not a coordinator is not an R3 matter.
    'src/systems/economy/coinService.js': STUB,
    'src/services/coinService.js': forward('../systems/economy/coinService'),
  });
  assert.deepEqual(found(root, 'R3'), [
    'src/services/chipService.js -> src/coordinators/launch.js',
    'src/services/chipService.js -> src/coordinators/other.js',
    'src/services/unregistered.js -> src/coordinators/launch.js',
    'src/systems/work/w.js -> src/coordinators/launch.js',
  ]);
  assert.deepEqual(found(root, 'R8'), ['src/services/chipService.js -> format']);
  assertBlocks(root, 'R3', /R3 new violation: src\/services\/unregistered\.js:1 loads the coordinator src\/coordinators\/launch\.js/u);
  assertBlocks(root, 'R8', /R8 new violation: src\/services\/chipService\.js:1 is a registered adapter but is not a one-line forward/u);
});

test('R8 keeps production code from loading an adapter that forwards to a coordinator', (t) => {
  const root = makeProject(t, {
    'src/coordinators/launch.js': STUB,
    'src/services/workService.js': forward('../coordinators/launch'),
    'src/systems/economy/coinService.js': STUB,
    'src/services/coinService.js': forward('../systems/economy/coinService'),
    // Entry code and a system alike must load the coordinator itself.
    'src/commands/board.js': loads('../services/workService', '../services/coinService'),
    'src/systems/games/runtime.js': loads('../../services/workService'),
    // Tests may use the old path, and the adapter of a module that is not a coordinator may be loaded.
    'test/uses.test.js': loads('../src/services/workService'),
  });
  assert.deepEqual(found(root, 'R8'), [
    'src/commands/board.js -> src/services/workService.js',
    'src/systems/games/runtime.js -> src/services/workService.js',
  ]);
  assertBlocks(root, 'R8', /R8 new violation: src\/commands\/board\.js:1 loads the adapter src\/services\/workService\.js, which only forwards to a coordinator/u);
  // The adapter itself is not an R3 violation, and so loading it is not an R3 violation either.
  assert.deepEqual(found(root, 'R3'), []);
});

test('R4 refuses the economy loading casino, work, games, community or conversation code', (t) => {
  const root = makeProject(t, {
    'src/systems/work/w.js': STUB,
    'src/systems/casino/c.js': STUB,
    'src/systems/games/g.js': STUB,
    'src/systems/community/m.js': STUB,
    'src/systems/conversation/v.js': STUB,
    'src/services/workService.js': STUB,
    'src/services/featurePlatformService.js': STUB,
    'src/services/auditService.js': STUB,
    'src/utils/u.js': STUB,
    'src/systems/economy/own.js': STUB,
    'src/systems/economy/ledger.js': loads('../work/w', '../casino/c', '../games/g', '../community/m', '../conversation/v'),
    // A service file of the economy counts as economy code.
    'src/services/coinService.js': loads('./workService'),
    // Allowed: its own system, utils, the reward ledger and modules that belong to no listed system.
    'src/systems/economy/fine.js': loads('./own', '../../utils/u', '../../services/featurePlatformService', '../../services/auditService'),
  });
  assert.deepEqual(found(root, 'R4'), [
    'src/services/coinService.js -> src/services/workService.js',
    'src/systems/economy/ledger.js -> src/systems/casino/c.js',
    'src/systems/economy/ledger.js -> src/systems/community/m.js',
    'src/systems/economy/ledger.js -> src/systems/conversation/v.js',
    'src/systems/economy/ledger.js -> src/systems/games/g.js',
    'src/systems/economy/ledger.js -> src/systems/work/w.js',
  ]);
  assertBlocks(root, 'R4', /R4 new violation: src\/systems\/economy\/ledger\.js:2 loads src\/systems\/casino\/c\.js, which belongs to casino/u);
});

test('R5 refuses platform and utils that load systems, services or coordinators, except runtimeDataPreflight', (t) => {
  const root = makeProject(t, {
    'src/systems/work/w.js': STUB,
    'src/services/s.js': STUB,
    'src/coordinators/c.js': STUB,
    'src/platform/a.js': loads('../systems/work/w'),
    'src/platform/b.js': `const lazy = () => ${load('../services/s')};\n`,
    'src/platform/c.js': loads('../coordinators/c'),
    'src/utils/u.js': loads('../services/s'),
    // A require without an extension also finds a JSON file.
    'src/services/table.json': '{}\n',
    'src/platform/d.js': loads('../services/table'),
    // The one declared exception.
    'src/platform/runtimeDataPreflight.js': loads('../services/s'),
    // Platform and utils may load each other.
    'src/platform/ok.js': loads('../utils/ok2'),
    'src/utils/ok2.js': loads('../platform/ok'),
  });
  assert.deepEqual(found(root, 'R5'), [
    'src/platform/a.js -> src/systems/work/w.js',
    'src/platform/b.js -> src/services/s.js',
    'src/platform/c.js -> src/coordinators/c.js',
    'src/platform/d.js -> src/services/table.json',
    'src/utils/u.js -> src/services/s.js',
  ]);
  assertBlocks(root, 'R5', /R5 new violation: src\/platform\/a\.js:1 loads src\/systems\/work\/w\.js/u);
});

test('loads are found on every line, once per place, and comments are not loads', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': STUB,
    'src/commands/a.js': [
      `// const db = ${load('../services/coinDatabase')};`,
      '/*',
      ` * ${load('../services/coinDatabase')};`,
      ' */',
      `const first = ${load('../services/coinDatabase')};`,
      `const second = () => ${load('../services/coinDatabase', '"')};`,
      '',
    ].join('\n'),
  });
  const { violations } = collectViolations({ root, rules: ['R1'] });
  const [violation] = [...violations.values()];
  assert.equal(violations.size, 1);
  assert.equal(violation.count, 2);
  assert.deepEqual(violation.lines, [5, 6]);
});

// A call written without a relative require showing up in this file (see `load`).
const call = (name, open, argument, close = ')') => `${name}${open}${argument}${close}`;
const quoted = (text, quote) => `${quote}${text}${quote}`;

test('loads are read in every spelling the language allows, and only in code', (t) => {
  const engine = '../services/coinDatabase';
  const spellings = {
    'src/commands/backtick.js': `${call('require', '(', quoted(engine, '`'))};\n`,
    'src/commands/spaced.js': `${call('require', '  (  ', quoted(engine, '"'), '  )')};\n`,
    'src/commands/lines.js': `${call('require', '(\n  ', quoted(engine, "'"), '\n)')};\n`,
    'src/commands/dynamic-import.js': `${call('import', '(', quoted(engine, "'"))};\n`,
    'src/commands/esm.js': `import engine ${'from'} ${quoted(engine, "'")};\n`,
    'src/commands/placeholder.js': `const text = \`\${${call('require', '(', quoted(engine, "'"))}}\`;\n`,
  };
  const notLoads = {
    'src/commands/trailing.js': `const x = 1; // ${call('require', '(', quoted(engine, "'"))}\n`,
    'src/commands/block.js': `/* ${call('require', '(', quoted(engine, "'"))} */ const x = 1;\n`,
    'src/commands/string.js': `const text = "${call('require', '(', quoted(engine, "'"))}";\n`,
    'src/commands/template.js': `const text = \`${call('require', '(', quoted(engine, "'"))}\`;\n`,
    'src/commands/regex.js': "const pattern = /require\\('\\.\\.\\/services\\/coinDatabase'\\)/;\n",
    'src/commands/computed.js': `${call('require', '(', `"../services/" + name`)};\n`,
    'src/commands/computed-template.js': `${call('require', '(', '`../services/${name}`')};\n`,
    'src/commands/package.js': `${call('require', '(', quoted('discord.js', "'"))};\n`,
  };
  const root = makeProject(t, { 'src/services/coinDatabase.js': STUB, ...spellings, ...notLoads });
  assert.deepEqual(found(root, 'R1'), Object.keys(spellings).sort().map((file) => `${file} -> src/services/coinDatabase.js`));
});

test('the scanner tells code from comments, strings, templates and regular expressions', () => {
  const source = [
    "const a = 'x // y'; // trailing 'quote'",
    '/* block',
    '   comment */ const b = "z";',
    'const c = `t ${f(1, "q")} u`;',
    "const d = /ab+[/]c'\"`/g; // a regular expression that holds every kind of quote",
    'const e = a / b / c;',
    'const g = (a) / 2; const h = list[0] / 2;',
    'const i = typeof /x/ === "function" ? \'fine\' : 0;',
    '',
  ].join('\n');
  const scan = scanSource(source);
  assert.equal(scan.problem, null);
  assert.equal(scan.code.length, source.length);
  assert.equal(scan.sql.length, source.length);
  assert.equal(scan.code.split('\n').length, source.split('\n').length);
  assert.deepEqual(scan.ordered.map(([, literal]) => literal.value), ['x // y', 'z', 't \u0001 u', 'q', 'function', 'fine']);
  assert.equal(scan.literals.get(source.indexOf('`t ')).dynamic, true);
  assert.equal(scan.literals.get(source.indexOf("'x")).dynamic, false);
  for (const hidden of ['x // y', 'trailing', 'block', 'comment', 'ab+', 'every kind']) {
    assert.equal(scan.code.includes(hidden), false, hidden);
  }
  for (const shown of ['const a =', 'f(1, ', 'a / b / c', '(a) / 2', 'list[0] / 2', 'typeof']) {
    assert.ok(scan.code.includes(shown), shown);
  }
  assert.ok(scan.sql.includes('x // y'));
  assert.equal(scan.sql.includes('trailing'), false);
  assert.equal(scan.sql.includes('f(1'), false);
});

test('the scanner follows escapes, nested templates, line continuations and a leading shebang', () => {
  const source = [
    '#!/usr/bin/env node',
    "const a = 'it\\'s';",
    'const b = "say \\"hi\\" // not a comment";',
    "const c = 'one \\",
    "two';",
    'const d = `outer ${`inner ${deep} text`} tail`;',
    'const e = `escaped \\${not a placeholder} and \\` quote`;',
    "const f = /[/'\"]\\//.test(a);",
    "const g = 'after';",
    '',
  ].join('\n');
  const scan = scanSource(source);
  assert.equal(scan.problem, null);
  assert.deepEqual(scan.ordered.map(([, literal]) => literal.value), [
    "it\\'s",
    'say \\"hi\\" // not a comment',
    'one \\\ntwo',
    'outer \u0001 tail',
    'inner \u0001 text',
    'escaped \\${not a placeholder} and \\` quote',
    'after',
  ]);
  assert.equal(scan.code.split('\n')[0].trim(), '');
});

test('the scanner reports what it cannot close instead of guessing', (t) => {
  for (const [source, pattern] of [
    ["const s = 'never closed;\nconst t = 1;\n", /a string that never closes \(line 1\)/u],
    // A carriage return ends the line too: the quote after it does not close the string above it.
    ["const s = 'never closed;\rconst t = x';\n", /a string that never closes \(line 1\)/u],
    ['const t = `never closed\n', /a template literal that never closes \(line 1\)/u],
    ['const t = `a ${b\n', /a template placeholder that never closes \(line 1\)/u],
    ['const a = 1;\n/* never closed\nconst b = 2;\n', /a comment that never closes \(line 2\)/u],
  ]) {
    assert.match(scanSource(source).problem, pattern, source);
  }
  const root = makeProject(t, { 'src/commands/a.js': "const s = 'never closed;\nconst t = 1;\n" });
  const { errors } = collectViolations({ root, rules: ['R1'] });
  assert.deepEqual(errors, ['src/commands/a.js could not be read reliably: a string that never closes (line 1)']);
  assertBlocks(root, 'R1', /src\/commands\/a\.js could not be read reliably/u);
});

test('a line comment ends at the first line terminator, \\n, \\r, U+2028 or U+2029, and what follows is code', (t) => {
  const engine = '../services/coinDatabase';
  for (const [label, end] of [
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
  ]) {
    // The load inside the comment is no load; the one after the line end is.
    const source = `// ${load('./hidden')}${end}const engine = ${load(engine)};\n`;
    const scan = scanSource(source);
    assert.equal(scan.problem, null, label);
    assert.equal(scan.code.length, source.length, label);
    assert.equal(scan.code.includes('hidden'), false, label);
    assert.deepEqual(loadsIn(scan).map(({ request }) => request), [engine], label);
    const root = makeProject(t, { 'src/services/coinDatabase.js': STUB, 'src/commands/a.js': source });
    assert.deepEqual(found(root, 'R1'), ['src/commands/a.js -> src/services/coinDatabase.js'], label);
  }
  // Every comment ends at its own terminator; a comment at the end of the text has none.
  const mixed = [
    `// one ${load('./a')}\r${load('../one')};`,
    `// two ${load('./b')}\u2028${load('../two')};`,
    `/* three */ ${load('../three')}; // last`,
  ].join(' ');
  const scan = scanSource(mixed);
  assert.equal(scan.problem, null);
  assert.deepEqual(loadsIn(scan).map(({ request }) => request), ['../one', '../two', '../three']);
});

test('the scanner reads a slash after ++, -- or a keyword used as a property name as a division', () => {
  for (const expression of [
    'total++ / count / 2',
    'total-- / count / 2',
    'total ++ / count / 2',
    'list[index]++ / count / 2',
    'value.in / count / 2',
    'value.of / count / 2',
    'value?.in / count / 2',
    'value . new / count / 2',
    'value.typeof / count / 2',
    'value.return / count / 2',
    'value.await / count / 2',
    'value\n  .instanceof / count / 2',
    // A line terminator in front of the slash is white space as well.
    'total\r/ count / 2',
    'total\u2028/ count / 2',
    'total\u2029/ count / 2',
  ]) {
    const source = `const ratio = ${expression};\n`;
    const scan = scanSource(source);
    assert.equal(scan.problem, null, expression);
    // Both slashes divide, so no text between them is taken for a regular expression and blanked.
    assert.equal(scan.code, source, expression);
  }
  // Where the slash does open a regular expression: after a keyword, after a prefix ++ and after a spread.
  for (const source of [
    'function f(text) { return /hidden/.test(text); }',
    'const kind = typeof /hidden/;',
    'const first = ++/hidden/.lastIndex;',
    'const second = 1 + ++ /hidden/.lastIndex;',
    'function f() { return ++/hidden/.lastIndex; }',
    'async function f(list) { return [...await /hidden/.exec(list)]; }',
    'const third = condition ? other : /hidden/.test(text);',
    'items.forEach((item) => /hidden/.test(item));',
  ]) {
    const scan = scanSource(`${source}\n`);
    assert.equal(scan.problem, null, source);
    assert.equal(scan.code.includes('hidden'), false, source);
  }
});

test('a slash that opens no regular expression closing on its line is read as a division, not reported', () => {
  const engine = '../services/coinDatabase';
  for (const [label, end] of [['a line feed', '\n'], ['a carriage return', '\r']]) {
    const source = `function f() { return /never closed${end}const engine = ${load(engine)}; }\n`;
    const scan = scanSource(source);
    assert.equal(scan.problem, null, label);
    assert.ok(scan.code.includes('never closed'), label);
    assert.deepEqual(loadsIn(scan).map(({ request }) => request), [engine], label);
  }
});

// -------------------------------------------------------------------------------------------
// R6: table owners
// -------------------------------------------------------------------------------------------

const SCHEMA = [
  'const schema = `',
  'CREATE TABLE IF NOT EXISTS coin_jobs (id INTEGER);',
  'CREATE TABLE IF NOT EXISTS coin_wallets (id INTEGER);',
  'CREATE TABLE IF NOT EXISTS feature_guild_settings (id INTEGER);',
  'CREATE TABLE IF NOT EXISTS casino_games (id INTEGER);',
  '`;',
  "const touch = 'SELECT * FROM coin_jobs; UPDATE coin_wallets SET id = 1; INSERT INTO casino_games VALUES (1)';",
  '',
].join('\n');

test('R6 refuses a file that names a table another system owns, for every SQL verb that names a table', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': SCHEMA,
    // Owners: the feature platform for its own table, work for its own table, the economy for its own.
    'src/services/featurePlatformService.js': "api.get('SELECT * FROM feature_guild_settings');\n",
    'src/systems/work/own.js': "api.get('SELECT * FROM coin_jobs');\n",
    'src/systems/economy/own.js': "api.get('SELECT * FROM coin_wallets');\n",
    // Not owners.
    'src/systems/economy/e.js': "api.get('SELECT * FROM coin_jobs WHERE id = 1');\n",
    'src/systems/work/w.js': [
      "api.run('UPDATE coin_wallets SET id = 2');",
      "api.all('SELECT 1 FROM coin_jobs j JOIN coin_wallets w ON 1');",
      '',
    ].join('\n'),
    'src/services/wordChainService.js': "db.run('INSERT INTO feature_guild_settings (id) VALUES (1)');\n",
    // Several lines between the verb and the table name, and the same table twice.
    'src/services/casinoService.js': [
      'const query = `SELECT *',
      '  FROM',
      '    coin_wallets`;',
      "api.get('DELETE FROM coin_wallets');",
      '',
    ].join('\n'),
  });
  assert.deepEqual(found(root, 'R6'), [
    'src/services/casinoService.js -> coin_wallets',
    'src/services/wordChainService.js -> feature_guild_settings',
    'src/systems/economy/e.js -> coin_jobs',
    'src/systems/work/w.js -> coin_wallets',
  ]);
  const { violations } = collectViolations({ root, rules: ['R6'] });
  const casino = violations.get('R6|src/services/casinoService.js|coin_wallets');
  assert.equal(casino.count, 2);
  assert.deepEqual(casino.lines, [2, 4]);
  assertBlocks(root, 'R6', /R6 new violation: src\/systems\/economy\/e\.js:1 names table coin_jobs, which belongs to work/u);
  assertBlocks(root, 'R6', /R6 new violation: src\/services\/wordChainService\.js:1 names table feature_guild_settings, which belongs to feature platform/u);
});

test('R6 does not see comments, lower-case SQL words or table names built at run time', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': SCHEMA,
    'src/systems/economy/blind.js': [
      '// SELECT * FROM coin_jobs',
      '/*',
      ' * UPDATE coin_jobs SET id = 1',
      ' */',
      "api.get('select * from coin_jobs');",
      'api.get(`SELECT * FROM ${table}`);',
      "api.get('SELECT * FROM ' + name);",
      "api.get('SELECT * FROM ' + 'coin_jobs');",
      "api.get('PRAGMA table_info(coin_jobs)');",
      "api.get('SELECT * FROM dual');",
      "api.run('SELECT 1'); // FROM coin_jobs",
      // An escaped backslash and an n are not the escape \n: the keyword stays glued to the word.
      "api.get('SELECT 1\\\\nFROM coin_jobs');",
      '',
    ].join('\n'),
  });
  assert.deepEqual(found(root, 'R6'), []);
});

// The notes at the top of scripts/check-boundaries.js list these spellings as unseen. The test keeps the
// notes true: whoever teaches R6 one of them moves it into R6_SPELLINGS and out of the notes.
test('R6 does not see the spellings its notes list as blind spots', (t) => {
  for (const [label, literal] of [
    ['a name in single quotes, in a template', "`SELECT * FROM 'coin_jobs'`"],
    ['a name in single quotes, in a double-quoted string', '"SELECT * FROM \'coin_jobs\'"'],
    ['a block comment between the keyword and the name', "'SELECT * FROM /* note */ coin_jobs'"],
    ['a line comment between the keyword and the name', '`SELECT * FROM -- note\n coin_jobs`'],
    ['a comma list after a subquery', "'SELECT * FROM (SELECT 1) s, coin_jobs'"],
    ['a comma list after a table-valued function', "'SELECT * FROM json_each(x), coin_jobs'"],
    ['CREATE TEMP TABLE', "'CREATE TEMP TABLE coin_jobs (id INTEGER)'"],
    ['CREATE TEMPORARY TABLE', "'CREATE TEMPORARY TABLE coin_jobs (id INTEGER)'"],
    ['\\x20 and \\u0020 for the space', "'SELECT * FROM\\x20coin_jobs; SELECT * FROM\\u0020coin_jobs'"],
    ['\\f and \\v for the space', "'SELECT * FROM\\fcoin_jobs; SELECT * FROM\\vcoin_jobs'"],
    ['a line continuation for the space', "'SELECT * FROM \\\ncoin_jobs'"],
  ]) {
    const root = makeProject(t, {
      'src/services/coinDatabase.js': SCHEMA,
      'src/systems/economy/e.js': `const query = ${literal};\n`,
    });
    assert.deepEqual(found(root, 'R6'), [], label);
  }
});

// Every spelling in which the economy, which does not own the work table coin_jobs, can name it.
const R6_SPELLINGS = [
  ['plain', "'SELECT * FROM coin_jobs'"],
  ['in double quotes inside a single-quoted string', "'SELECT * FROM \"coin_jobs\"'"],
  ['in double quotes inside a double-quoted string', '"SELECT * FROM \\"coin_jobs\\""'],
  ['in backticks inside a single-quoted string', "'SELECT * FROM `coin_jobs`'"],
  ['in backticks inside a template', '`SELECT * FROM \\`coin_jobs\\``'],
  ['in brackets', "'SELECT * FROM [coin_jobs]'"],
  ['after the main schema', "'SELECT * FROM main.coin_jobs'"],
  ['after the temp schema', "'SELECT * FROM temp.coin_jobs'"],
  ['after a quoted schema', "'SELECT * FROM \"main\".\"coin_jobs\"'"],
  ['second in a comma list', "'SELECT * FROM coin_wallets, coin_jobs'"],
  ['third in a comma list with aliases', "'SELECT * FROM coin_wallets w, coin_wallets AS v, coin_jobs j WHERE 1'"],
  ['in a comma list over several lines', '`SELECT *\n  FROM coin_wallets w,\n       coin_jobs j`'],
  ['UPDATE OR IGNORE', "'UPDATE OR IGNORE coin_jobs SET id = 1'"],
  ['UPDATE OR REPLACE', "'UPDATE OR REPLACE coin_jobs SET id = 1'"],
  ['INSERT OR REPLACE INTO', "'INSERT OR REPLACE INTO coin_jobs (id) VALUES (1)'"],
  ['a JOIN', "'SELECT * FROM coin_wallets JOIN coin_jobs ON 1'"],
  ['in capitals', "'SELECT * FROM COIN_JOBS'"],
  ['in mixed case', "'DELETE FROM Coin_Jobs'"],
  ['ALTER TABLE', "'ALTER TABLE coin_jobs ADD COLUMN extra INTEGER'"],
  ['RENAME TO', "'ALTER TABLE coin_wallets RENAME TO coin_jobs'"],
  ['DROP TABLE', "'DROP TABLE coin_jobs'"],
  ['DROP TABLE IF EXISTS', "'DROP TABLE IF EXISTS coin_jobs'"],
  ['CREATE INDEX', "'CREATE INDEX idx_extra ON coin_jobs (id)'"],
  ['CREATE UNIQUE INDEX IF NOT EXISTS', "'CREATE UNIQUE INDEX IF NOT EXISTS idx_extra ON coin_jobs (id)'"],
  ['CREATE TRIGGER', "'CREATE TRIGGER trg AFTER INSERT ON coin_jobs BEGIN SELECT 1; END'"],
  // JavaScript escapes for white space glued to the keywords: \n, \t and \r are written as two characters.
  ['\\n between the clauses', "'SELECT 1\\nFROM\\ncoin_jobs\\nWHERE 1'"],
  ['\\t between the clauses', "'SELECT 1\\tFROM\\tcoin_jobs\\tWHERE 1'"],
  ['\\r between the clauses', "'SELECT 1\\rFROM\\rcoin_jobs\\rWHERE 1'"],
  ['\\r\\n and \\t mixed', "'SELECT 1\\r\\n\\tFROM\\t\\tcoin_jobs\\r\\nWHERE 1'"],
  ['\\n in a template', '`SELECT 1\\nFROM\\ncoin_jobs`'],
  ['\\n in a double-quoted string', '"SELECT 1\\nFROM\\ncoin_jobs"'],
  ['\\n around a quoted name', '"SELECT 1\\nFROM\\n\\"coin_jobs\\"\\nWHERE 1"'],
  ['\\n inside a comma list', "'SELECT * FROM coin_wallets w,\\ncoin_jobs j'"],
  ['\\n before a JOIN', "'SELECT * FROM coin_wallets\\nJOIN\\ncoin_jobs ON 1'"],
];

test('R6 reads a table name however SQL spells it: quoted, prefixed, listed, capitalised or changed by DDL', (t) => {
  for (const [label, literal] of R6_SPELLINGS) {
    const root = makeProject(t, {
      'src/services/coinDatabase.js': SCHEMA,
      'src/systems/economy/e.js': `const query = ${literal};\n`,
    });
    assert.deepEqual(found(root, 'R6'), ['src/systems/economy/e.js -> coin_jobs'], label);
  }
  // The owner may use every one of them.
  const own = makeProject(t, {
    'src/services/coinDatabase.js': SCHEMA,
    'src/systems/work/w.js': `${R6_SPELLINGS.filter(([, literal]) => !literal.includes('coin_wallets'))
      .map(([, literal]) => `const query = ${literal};`).join('\n')}\n`,
  });
  assert.deepEqual(found(own, 'R6'), []);
});

test('R6 refuses a file that creates a table of another family, and lets a family create its own', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': SCHEMA,
    'src/systems/work/w.js': "const query = 'CREATE TABLE IF NOT EXISTS coin_wallets_extra (id INTEGER)';\n",
    'src/systems/work/virtual.js': "const query = 'CREATE VIRTUAL TABLE coin_search USING fts5(text)';\n",
    'src/systems/work/own.js': "const query = 'CREATE TABLE IF NOT EXISTS coin_work_extra (id INTEGER)';\n",
    'src/systems/economy/own.js': "const query = 'CREATE TABLE IF NOT EXISTS coin_more (id INTEGER)';\n",
  });
  assert.deepEqual(found(root, 'R6'), [
    'src/systems/work/virtual.js -> coin_search',
    'src/systems/work/w.js -> coin_wallets_extra',
  ]);
});

test('R6 asks for an owner when a table is created that no family claims', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': `${SCHEMA}const extra = 'CREATE TABLE mystery_things (id INTEGER)';\n`,
  });
  assert.deepEqual(found(root, 'R6'), ['src/services/coinDatabase.js -> no-owner:mystery_things']);
  assertBlocks(root, 'R6', /R6 new violation: src\/services\/coinDatabase\.js creates table mystery_things, which has no declared owner/u);
});

// -------------------------------------------------------------------------------------------
// R7: extension hooks
// -------------------------------------------------------------------------------------------

test('R7 refuses a hook that runs without being listed in the extension contract', (t) => {
  const root = makeProject(t, {
    'docs/EXTENSION_CONTRACT.md': [
      'The host supports:',
      '- `hooks.ready` and `hooks.shutdown`',
      '- `hooks.workRole.syncJobRoleForMember`',
      '',
    ].join('\n'),
    // Listed: plain names, the forwarder with a prefix, and a name in double quotes.
    'src/events/ready.js': "host.runHook('ready', { client });\n",
    'src/index.js': 'await host.runHook("shutdown", { client });\n',
    'src/commands/work.js': [
      'async function runWorkRoleHook(client, hookName, payload) {',
      '  return host.runHook(`workRole.${hookName}`, payload);',
      '}',
      "await runWorkRoleHook(client, 'syncJobRoleForMember', {});",
      "await runWorkRoleHook(interaction.client, 'syncPrimaryJobRoleForMember', {});",
      '',
    ].join('\n'),
    // Not listed: a name on the line after the call, and a name handed to an injected runner.
    'src/events/messageCreate.js': "host.runHook(\n  'messageCreate',\n  { message },\n);\n",
    'src/systems/work/w.js': [
      'const invoke = runHook || ((name, payload) => host.runHook(name, payload));',
      "await invoke('workRole.clearPrimaryJobRoleForMember', {});",
      '',
    ].join('\n'),
  });
  assert.deepEqual(found(root, 'R7'), [
    'src/commands/work.js -> workRole.syncPrimaryJobRoleForMember',
    'src/events/messageCreate.js -> messageCreate',
    'src/systems/work/w.js -> workRole.clearPrimaryJobRoleForMember',
  ]);
  assertBlocks(root, 'R7', /R7 new violation: src\/systems\/work\/w\.js:2 runs hook workRole\.clearPrimaryJobRoleForMember, which docs\/EXTENSION_CONTRACT\.md does not list/u);
});

test('R7 does not see comments or hook names built at run time', (t) => {
  const root = makeProject(t, {
    'docs/EXTENSION_CONTRACT.md': '- `hooks.ready`\n',
    'src/events/e.js': [
      "// host.runHook('commentedOut', {});",
      'await host.runHook(name, payload);',
      'await host.runHook(`dynamic.${name}`, payload);',
      '',
    ].join('\n'),
  });
  assert.deepEqual(found(root, 'R7'), []);
});

test('R7 reads a hook name in every spelling the language allows, and only in code', (t) => {
  const root = makeProject(t, {
    'docs/EXTENSION_CONTRACT.md': '- `hooks.listed`\n',
    'src/events/listed.js': "host.runHook('listed', {});\n",
    'src/events/backtick.js': 'host.runHook(`unlistedBacktick`, {});\n',
    'src/events/spaced.js': "host.runHook  (  'unlistedSpaced'  , {});\n",
    'src/events/lines.js': 'host.runHook(\n  "unlistedLines",\n  {},\n);\n',
    // The forwarder's first argument may hold brackets of its own, and the call may span lines.
    'src/commands/forwarded.js': "runWorkRoleHook(getClient(interaction), 'unlistedForwarded', {});\n",
    'src/commands/nested.js': 'runWorkRoleHook(pick(first(a, b), [1, 2]), `unlistedNested`, {});\n',
    'src/commands/multiline.js': "runWorkRoleHook(\n  interaction.client,\n  'unlistedMultiline',\n  { member },\n);\n",
    'src/systems/work/injected.js': 'await invoke(`workRole.unlistedInjected`, {});\n',
    // Not code: a trailing comment, a string, a name built at run time.
    'src/events/comment.js': "host.runHook('listed', {}); // host.runHook('unlistedInComment')\n",
    'src/events/string.js': 'const text = "host.runHook(\'unlistedInString\')";\n',
    'src/events/dynamic.js': 'host.runHook(`dynamic.${name}`, {});\n',
  });
  assert.deepEqual(found(root, 'R7'), [
    'src/commands/forwarded.js -> workRole.unlistedForwarded',
    'src/commands/multiline.js -> workRole.unlistedMultiline',
    'src/commands/nested.js -> workRole.unlistedNested',
    'src/events/backtick.js -> unlistedBacktick',
    'src/events/lines.js -> unlistedLines',
    'src/events/spaced.js -> unlistedSpaced',
    'src/systems/work/injected.js -> workRole.unlistedInjected',
  ]);
});

// -------------------------------------------------------------------------------------------
// R8: adapters
// -------------------------------------------------------------------------------------------

const CONTRACTS = '../systems/games/board/core/contracts';

test('R8 refuses a registered adapter that is more than a one-line forward and production code that loads the legacy root', (t) => {
  const root = makeProject(t, {
    'src/systems/games/board/core/contracts.js': 'module.exports = { ok: true };\n',
    'src/systems/economy/coinService.js': STUB,
    // Accepted: the one-line form, the three-line command-line form, and Windows line endings.
    'src/games/contracts.js': forward(CONTRACTS),
    'src/games/cli.js': cliForward(CONTRACTS),
    'src/games/crlf.js': forward(CONTRACTS, '\r\n'),
    // Refused: more than a forward, a target that is gone, extra code in a registered services adapter.
    'src/games/bad.js': `const x = ${load(CONTRACTS)};\nmodule.exports = x;\n`,
    'src/games/dangling.js': forward('../systems/games/board/core/gone'),
    'src/services/coinService.js': `${forward('../systems/economy/coinService')}console.log('extra');\n`,
    // Production code must load the implementation, not the legacy path.
    'src/systems/games/board/engines/go.js': loads('../../../../games/contracts'),
    'src/index.js': loads('./games/contracts'),
    // Tests and unregistered files may do what they like.
    'test/legacy.test.js': loads('../src/games/contracts'),
    'src/utils/forward.js': `${forward('./other')}console.log('not an adapter');\n`,
    'src/utils/other.js': STUB,
  });
  assert.deepEqual(found(root, 'R8'), [
    'src/games/bad.js -> format',
    'src/games/dangling.js -> missing-target',
    'src/index.js -> src/games/contracts.js',
    'src/services/coinService.js -> format',
    'src/systems/games/board/engines/go.js -> src/games/contracts.js',
  ]);
  assertBlocks(root, 'R8', /R8 new violation: src\/games\/bad\.js:1 is a registered adapter but is not a one-line forward/u);
  assertBlocks(root, 'R8', /R8 new violation: src\/index\.js:1 loads the legacy adapter src\/games\/contracts\.js/u);
});

test('R8 accepts the three-line command-line form and a deleted registered adapter', (t) => {
  const root = makeProject(t, {
    'src/systems/games/board/core/contracts.js': 'module.exports = { ok: true };\n',
    'src/games/cli.js': cliForward(CONTRACTS),
  });
  assert.deepEqual(failuresOf(root, 'R8'), []);
});

// -------------------------------------------------------------------------------------------
// R9: frozen services
// -------------------------------------------------------------------------------------------

test('R9 refuses a new file in src/services and lets recorded files stay', (t) => {
  const root = makeProject(t, {
    'scripts/boundary-baseline.json': baselineJson([entry('R9-001', 'src/services/existing.js', 'src/services')]),
    'src/services/existing.js': STUB,
    'src/services/brandNew.js': STUB,
    'src/systems/economy/fine.js': STUB,
  });
  const failures = failuresOf(root, 'R9');
  assert.equal(failures.length, 1);
  assert.match(failures[0], /R9 new violation: src\/services\/brandNew\.js is a file in src\/services, which accepts no new files/u);
});

// -------------------------------------------------------------------------------------------
// R10: public export
// -------------------------------------------------------------------------------------------

function manifestJson(paths) {
  return `${JSON.stringify({ version: 1, paths }, null, 2)}\n`;
}

test('R10 refuses src and test files outside the public export and paths the export refuses', (t) => {
  const root = makeProject(t, {
    'public-export/manifest.json': manifestJson([
      'src/commands',
      'test/ok.test.js',
      'src/systems/games/board/storage/sqliteBoardStore.js',
      'src/games/storage/boardSchema.js',
    ]),
    'src/commands/a.js': STUB,
    'test/ok.test.js': STUB,
    // The board storage sources keep their exception to the "storage" rule.
    'src/systems/games/board/storage/sqliteBoardStore.js': STUB,
    'src/games/storage/boardSchema.js': STUB,
    // Not exported, or a path the export refuses.
    'test/forgotten.test.js': STUB,
    'src/utils/forgotten.js': STUB,
    'src/data/x.js': STUB,
    'src/foo/storage/y.js': STUB,
    'src/foo/private/z.js': STUB,
    // Files an operating system or an editor leaves behind are not part of the project.
    'src/utils/.DS_Store': '',
    'test/Thumbs.db': '',
  });
  assert.deepEqual(found(root, 'R10'), [
    'src/data/x.js -> not-exported',
    'src/data/x.js -> protected-path',
    'src/foo/private/z.js -> not-exported',
    'src/foo/private/z.js -> protected-path',
    'src/foo/storage/y.js -> not-exported',
    'src/foo/storage/y.js -> protected-path',
    'src/utils/forgotten.js -> not-exported',
    'test/forgotten.test.js -> not-exported',
  ]);
  assertBlocks(root, 'R10', /R10 new violation: test\/forgotten\.test\.js is not in the public export/u);
  assertBlocks(root, 'R10', /R10 new violation: src\/foo\/storage\/y\.js has a path the public export refuses/u);
});

test('R10 passes when every src and test file is exported', (t) => {
  const root = makeProject(t, {
    'public-export/manifest.json': manifestJson(['src', 'test']),
    'src/commands/a.js': STUB,
    'test/a.test.js': STUB,
  });
  assert.deepEqual(failuresOf(root, 'R10'), []);
});

test('R10 lets a test of the private live-test tools stay out of the export, and nothing else', (t) => {
  const toolRequire = (request) => `const C = ${load(request)};\n`;
  // Written against tools/live-test: as a require, as consecutive arguments (even over lines), or as a
  // path in a string or in a template.
  const exemptFiles = {
    'test/liveTestCleanup.test.js': toolRequire('../tools/live-test/constants'),
    'test/liveTestBoundary.test.js': "const root = path.join(projectRoot, 'tools', 'live-test');\n",
    'test/liveTestJoin.test.js': "const root = path.join(\n  projectRoot,\n  'tools' ,\n  'live-test',\n);\n",
    'test/liveTestTemplate.test.js': 'const root = `${base}/tools/live-test/cleanup.js`;\n',
    'test/liveTestString.test.js': "const root = 'tools/live-test/cleanup.js';\n",
    'test/support/liveTestFixtures.js': toolRequire('../../tools/live-test/constants'),
  };
  // Still refused: the name alone, the tool alone, a comment (whole-line, trailing or block), a sentence
  // that mentions it, literals that are not arguments side by side, a name that is neither
  // test/liveTest*.test.js nor test/support/liveTest*.js, an ordinary test, and a file outside test.
  const refusedFiles = {
    'test/liveTestOther.test.js': STUB,
    'test/ordinary.test.js': toolRequire('../tools/live-test/constants'),
    'test/liveTestComment.test.js': `// Covers tools/live-test.\n${STUB}`,
    'test/liveTestTrailing.test.js': 'const x = 1; // tools/live-test\n',
    'test/liveTestBlock.test.js': '/* tools/live-test */ const x = 1;\n',
    'test/liveTestProse.test.js': "const note = 'see tools/live-test for the details';\n",
    'test/liveTestApart.test.js': "const a = 'tools'; const b = 'live-test';\n",
    'test/liveTestHelper.js': toolRequire('./tools/live-test/constants'),
    'test/support/other.js': toolRequire('../../tools/live-test/constants'),
    'test/forgotten.test.js': STUB,
    'src/utils/liveTestTool.js': toolRequire('../../tools/live-test/constants'),
  };
  const root = makeProject(t, {
    'public-export/manifest.json': manifestJson(['src/commands', 'test/ok.test.js']),
    'src/commands/a.js': STUB,
    'test/ok.test.js': STUB,
    ...exemptFiles,
    ...refusedFiles,
  });
  // A livetest* name outside the exemption is also a path the export refuses.
  assert.deepEqual(found(root, 'R10'), [
    'src/utils/liveTestTool.js -> not-exported',
    'src/utils/liveTestTool.js -> protected-path',
    'test/forgotten.test.js -> not-exported',
    'test/liveTestApart.test.js -> not-exported',
    'test/liveTestApart.test.js -> protected-path',
    'test/liveTestBlock.test.js -> not-exported',
    'test/liveTestBlock.test.js -> protected-path',
    'test/liveTestComment.test.js -> not-exported',
    'test/liveTestComment.test.js -> protected-path',
    'test/liveTestHelper.js -> not-exported',
    'test/liveTestHelper.js -> protected-path',
    'test/liveTestOther.test.js -> not-exported',
    'test/liveTestOther.test.js -> protected-path',
    'test/liveTestProse.test.js -> not-exported',
    'test/liveTestProse.test.js -> protected-path',
    'test/liveTestTrailing.test.js -> not-exported',
    'test/liveTestTrailing.test.js -> protected-path',
    'test/ordinary.test.js -> not-exported',
    'test/support/other.js -> not-exported',
  ]);
  assertBlocks(root, 'R10', /R10 new violation: test\/forgotten\.test\.js is not in the public export/u);
  assertBlocks(root, 'R10', /R10 new violation: test\/ordinary\.test\.js is not in the public export/u);
  assertBlocks(root, 'R10', /R10 new violation: test\/liveTestOther\.test\.js has a path the public export refuses/u);
  const exempt = makeProject(t, {
    'public-export/manifest.json': manifestJson(['src/commands']),
    'src/commands/a.js': STUB,
    ...exemptFiles,
  });
  assert.deepEqual(failuresOf(exempt, 'R10'), []);
  // The exemption only stops R10 from reporting these files; the public export itself still refuses
  // them, so they cannot be exported by a manifest mistake.
  for (const file of Object.keys(exemptFiles)) {
    assert.throws(() => assertAllowedPath(file), /refuses protected file/u, file);
  }
});

test('R10 refuses exported code outside test that names the private live-test tools', (t) => {
  // The public copy has no tools/live-test. Exported code that runs there names it in none of the ways
  // a private-tool test does; a comment or a sentence about it is fine, and so is a test (the rule above).
  const files = {
    'public-export/manifest.json': manifestJson(['src/commands', 'scripts/owner.js', 'scripts/joined.js',
      'scripts/string.js', 'scripts/prose.js', 'scripts/comment.js', 'test/ok.test.js']),
    'src/commands/a.js': STUB,
    'test/ok.test.js': "const fixture = ['tools', 'live-test'];\n",
    'scripts/owner.js': "const launcher = path.join(__dirname, '..', 'tools', 'live-test', 'launcher.js');\n",
    'scripts/joined.js': "const root = path.join(\n  base,\n  'tools' ,\n  'live-test',\n);\n",
    'scripts/string.js': "const launcher = 'tools/live-test/launcher.js';\n",
    'scripts/prose.js': "const note = 'see tools/live-test for the details';\n",
    'scripts/comment.js': `// The private tools/live-test passes its own launcher.\n${STUB}`,
  };
  const root = makeProject(t, files);
  assert.deepEqual(found(root, 'R10'), [
    'scripts/joined.js -> private-tool-path',
    'scripts/owner.js -> private-tool-path',
    'scripts/string.js -> private-tool-path',
  ]);
  assertBlocks(root, 'R10', /R10 new violation: scripts\/owner\.js names the private tools\/live-test/u);
});

test('R10 does not mind the bot runtime data in src/data, but still refuses code there', (t) => {
  // The bot keeps its JSON stores in src/data, next to the temporary and backup copies the stores and the
  // upgrade scripts leave; git ignores all of it and the export never ships it.
  const runtimeData = {
    'src/data/.gitkeep': '',
    'src/data/guildConfig.json': '{}\n',
    'src/data/guildConfig.json.123.456.tmp': '{}\n',
    'src/data/calendarEvents.json.legacy-v1.bak': '{}\n',
    'src/data/nested/state.json': '{}\n',
    // The last extension decides: a backup copy of a code file is data.
    'src/data/engine.wasm.bak': '',
  };
  const manifest = { 'public-export/manifest.json': manifestJson(['src/commands']) };
  const clean = makeProject(t, { ...manifest, 'src/commands/a.js': STUB, ...runtimeData });
  assert.deepEqual(failuresOf(clean, 'R10'), []);
  // Code: JavaScript and TypeScript in every module flavour, a native addon and a WebAssembly module.
  const codeFiles = [
    'src/data/x.js',
    'src/data/x.mjs',
    'src/data/nested/y.cjs',
    'src/data/w.jsx',
    'src/data/z.ts',
    'src/data/t.tsx',
    'src/data/m.mts',
    'src/data/c.cts',
    'src/data/addon.node',
    'src/data/nested/engine.wasm',
  ];
  const code = makeProject(t, {
    ...manifest,
    'src/commands/a.js': STUB,
    ...runtimeData,
    ...Object.fromEntries(codeFiles.map((file) => [file, STUB])),
    // Only src/data holds runtime data.
    'test/data/state.json': '{}\n',
  });
  assert.deepEqual(found(code, 'R10'), [
    ...codeFiles.flatMap((file) => [`${file} -> not-exported`, `${file} -> protected-path`]),
    'test/data/state.json -> not-exported',
    'test/data/state.json -> protected-path',
  ].sort());
  assertBlocks(code, 'R10', /R10 new violation: src\/data\/x\.js is not in the public export/u);
  assertBlocks(code, 'R10', /R10 new violation: src\/data\/addon\.node is not in the public export/u);
});

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const needsGit = { skip: hasGit ? false : 'git is not installed' };

// A project that is also a git work tree; `track` lists the files that are staged, every other file
// stays untracked. git runs without the variables a git hook or `git rebase -x` hands down, so it can
// only touch this project.
function makeRepositoryProject(t, files, track) {
  const root = makeProject(t, files);
  for (const args of [['init', '-q'], ['add', '-f', '--', ...track]]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, env: gitEnvironment() });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

const IGNORED_PROJECT_FILES = {
  '.gitignore': 'src/cache/\n**/data/*\n',
  'public-export/manifest.json': manifestJson(['src/commands']),
  'src/commands/a.js': STUB,
  'src/cache/build.js': STUB,
  'src/untracked.js': STUB,
  'src/data/state.json': '{}\n',
  'src/data/x.js': STUB,
};
const IGNORED_PROJECT_TRACKED = ['.gitignore', 'public-export/manifest.json', 'src/commands/a.js'];
const IGNORED_PROJECT_FINDINGS = [
  'src/data/x.js -> not-exported',
  'src/data/x.js -> protected-path',
  'src/untracked.js -> not-exported',
];

test('R10 leaves out the files git ignores, but not code in src/data', needsGit, (t) => {
  const root = makeRepositoryProject(t, IGNORED_PROJECT_FILES, IGNORED_PROJECT_TRACKED);
  assert.deepEqual(found(root, 'R10'), IGNORED_PROJECT_FINDINGS);
});

test('R10 reads a git work tree without the variables a git hook hands down, and touches no outer index', needsGit, (t) => {
  // A repository with one staged file stands in for the work tree a hook, or git rebase -x, runs in.
  const outer = makeRepositoryProject(t, { 'outer.txt': 'outer\n' }, ['outer.txt']);
  const outerGit = path.join(outer, '.git');
  const indexOf = () => fs.readFileSync(path.join(outerGit, 'index')).toString('hex');
  const before = indexOf();
  const handedDown = { GIT_DIR: outerGit, GIT_INDEX_FILE: path.join(outerGit, 'index'), GIT_COMMON_DIR: outerGit };
  const saved = Object.fromEntries(Object.keys(handedDown).map((name) => [name, process.env[name]]));
  Object.assign(process.env, handedDown);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const root = makeRepositoryProject(t, IGNORED_PROJECT_FILES, IGNORED_PROJECT_TRACKED);
  assert.deepEqual(found(root, 'R10'), IGNORED_PROJECT_FINDINGS);
  assert.equal(indexOf(), before);
});

test('R10 reports a git work tree it cannot read instead of passing', (t) => {
  const root = makeProject(t, {
    'public-export/manifest.json': manifestJson(['src/commands']),
    'src/commands/a.js': STUB,
  });
  // An empty .git directory is not a repository; git must not look above the temporary directory either.
  fs.mkdirSync(path.join(root, '.git'));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  t.after(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });
  assertBlocks(root, 'R10', /R10 the public export plan could not be built: Public export could not ask git which files are ignored/u);
  assert.equal(collectViolations({ root, rules: ['R10'] }).errors.length, 1);
});

test('R10 reports a public export plan that cannot be built instead of passing', (t) => {
  const missing = makeProject(t, { 'src/commands/a.js': STUB });
  assertBlocks(missing, 'R10', /R10 the public export plan could not be built/u);
  const refused = makeProject(t, {
    'public-export/manifest.json': manifestJson(['src/data']),
    'src/data/x.js': STUB,
  });
  assertBlocks(refused, 'R10', /R10 the public export plan could not be built: Public export refuses protected path: src\/data/u);
});

// -------------------------------------------------------------------------------------------
// The ratchet
// -------------------------------------------------------------------------------------------

const ONCE = loads('../services/coinDatabase');
const TWICE = loads('../services/coinDatabase', '../services/coinDatabase');

function ratchetProject(t, source, entries) {
  return makeProject(t, {
    'scripts/boundary-baseline.json': baselineJson(entries),
    'src/services/coinDatabase.js': STUB,
    'src/commands/a.js': source,
  });
}

test('a recorded violation passes, an unrecorded one fails', (t) => {
  const recorded = entry('R1-001', 'src/commands/a.js', 'src/services/coinDatabase.js', { disposition: 'cleanup' });
  assert.deepEqual(failuresOf(ratchetProject(t, ONCE, [recorded]), 'R1'), []);
  const failures = failuresOf(ratchetProject(t, ONCE, []), 'R1');
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^R1 new violation: src\/commands\/a\.js:1 loads the storage engine src\/services\/coinDatabase\.js \(1 time\)\. Fix the code; the baseline only shrinks\.$/u);
});

test('a stale baseline entry fails once its violation is gone', (t) => {
  const recorded = entry('R1-001', 'src/commands/a.js', 'src/services/coinDatabase.js', { disposition: 'cleanup' });
  const failures = failuresOf(ratchetProject(t, STUB, [recorded]), 'R1');
  assert.deepEqual(failures, [
    'R1 R1-001 is stale: src/commands/a.js -> src/services/coinDatabase.js no longer violates the rule. Delete the entry from scripts/boundary-baseline.json.',
  ]);
});

test('a recorded violation that occurs more often than recorded fails, and so does one that occurs less often', (t) => {
  const once = entry('R1-001', 'src/commands/a.js', 'src/services/coinDatabase.js');
  const grew = failuresOf(ratchetProject(t, TWICE, [once]), 'R1');
  assert.equal(grew.length, 1);
  assert.match(grew[0], /^R1 R1-001 grew: src\/commands\/a\.js:1,2 loads the storage engine src\/services\/coinDatabase\.js \(2 times; the baseline records 1\)\. Fix the new use\.$/u);
  const twice = entry('R1-001', 'src/commands/a.js', 'src/services/coinDatabase.js', { count: 2 });
  const shrank = failuresOf(ratchetProject(t, ONCE, [twice]), 'R1');
  assert.equal(shrank.length, 1);
  assert.match(shrank[0], /^R1 R1-001 shrank: src\/commands\/a\.js -> src\/services\/coinDatabase\.js occurs 1 time; the baseline records 2\. Lower its count in scripts\/boundary-baseline\.json\.$/u);
  assert.deepEqual(failuresOf(ratchetProject(t, TWICE, [twice]), 'R1'), []);
});

test('only the rules that run are compared with the baseline', (t) => {
  const otherRule = entry('R6-001', 'src/services/x.js', 'coin_jobs');
  const root = ratchetProject(t, STUB, [otherRule]);
  assert.deepEqual(failuresOf(root, 'R1'), []);
  assert.match(failuresOf(root, 'R6')[0], /^R6 R6-001 is stale/u);
});

test('the baseline is checked before it is trusted', (t) => {
  const good = entry('R1-001', 'src/commands/a.js', 'src/services/coinDatabase.js');
  const cases = [
    ['an id that appears twice', [good, { ...good, target: 'other' }], /the id R1-001 appears twice/u],
    ['a violation recorded twice', [good, { ...good, id: 'R1-002' }], /R1-002 repeats R1 src\/commands\/a\.js -> src\/services\/coinDatabase\.js/u],
    ['an unknown rule', [{ ...good, rule: 'R11' }], /has an unknown rule/u],
    ['an id that does not start with its rule', [{ ...good, id: 'R2-001' }], /needs an id like R6-001 that starts with its rule/u],
    ['an id without three digits', [{ ...good, id: 'R1-1' }], /needs an id like R6-001/u],
    ['an id that is not text', [{ ...good, id: 7 }], /needs an id like R6-001/u],
    ['an unknown disposition', [{ ...good, disposition: 'soon' }], /needs a disposition such as cleanup, pending-decision or unscheduled/u],
    ['a missing disposition', [{ ...good, disposition: undefined }], /needs a disposition/u],
    ['an unknown field', [{ ...good, owner: 'me' }], /has the unknown field "owner"/u],
    ['a count of zero', [{ ...good, count: 0 }], /needs a count of at least 1/u],
    ['an absolute file path', [{ ...good, file: '/etc/passwd' }], /needs a relative, slash-separated file/u],
    ['a file path that leaves the project', [{ ...good, file: '../x.js' }], /needs a relative, slash-separated file/u],
    ['an empty note', [{ ...good, note: '' }], /has an empty note/u],
    ['an entry that is not an object', ['R1-001'], /is not an object/u],
  ];
  for (const [label, entries, pattern] of cases) {
    const root = makeProject(t, { 'scripts/boundary-baseline.json': baselineJson(entries) });
    const failures = failuresOf(root, 'R9');
    assert.equal(failures.length, 1, label);
    assert.match(failures[0], /is not valid/u, label);
    assert.match(failures[0], pattern, label);
  }
  for (const [label, content, pattern] of [
    ['text that is not JSON', 'not json', /could not be read/u],
    ['a different version', '{"version":2,"entries":[]}', /version 1 and an entries array/u],
    ['no entries array', '{"version":1}', /version 1 and an entries array/u],
  ]) {
    const root = makeProject(t, { 'scripts/boundary-baseline.json': content });
    const failures = failuresOf(root, 'R9');
    assert.equal(failures.length, 1, label);
    assert.match(failures[0], pattern, label);
  }
  const missing = makeProject(t, {});
  fs.rmSync(path.join(missing, 'scripts', 'boundary-baseline.json'));
  assert.match(failuresOf(missing, 'R9')[0], /could not be read: ENOENT/u);
});

test('a rule name that does not exist is refused', (t) => {
  const root = makeProject(t, {});
  assert.throws(() => findBoundaryFailures({ projectRoot: root, rules: ['R11'] }), /Unknown boundary rule: R11/u);
});

// -------------------------------------------------------------------------------------------
// Command line and report
// -------------------------------------------------------------------------------------------

function runChecker(args) {
  return spawnSync(process.execPath, [checkerPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
}

test('the command line passes on the real project and prints the report on request', () => {
  const plain = runChecker([]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^Boundary check passed: 10 rules, \d+ recorded exceptions\.$/mu);
  const entries = loadBaseline(path.join(projectRoot, 'scripts', 'boundary-baseline.json'));
  const report = runChecker(['--report']);
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.startsWith(`${formatReport(entries)}\n`));
  assert.match(report.stdout, new RegExp(`^Boundary baseline: ${entries.length} recorded exceptions\\.$`, 'mu'));
});

test('the command line fails on a project with a new violation and on bad options', (t) => {
  const root = makeProject(t, {
    'src/services/coinDatabase.js': STUB,
    'src/commands/a.js': ONCE,
  });
  const failed = runChecker(['--root', root, '--rule', 'R1']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Boundary check failed:\n- R1 new violation: src\/commands\/a\.js:1 loads the storage engine/u);
  const onlyOtherRule = runChecker(['--root', root, '--rule', 'R2']);
  assert.equal(onlyOtherRule.status, 0, onlyOtherRule.stderr);
  assert.match(onlyOtherRule.stdout, /Boundary check passed: 1 rule, 0 recorded exceptions\./u);
  const elsewhere = path.join(root, 'elsewhere.json');
  fs.writeFileSync(elsewhere, baselineJson([entry('R1-001', 'src/commands/a.js', 'src/services/coinDatabase.js')]));
  assert.equal(runChecker(['--root', root, '--rule', 'R1', '--baseline', elsewhere]).status, 0);
  const unreadable = runChecker(['--root', root, '--rule', 'R1', '--baseline', path.join(root, 'missing.json'), '--report']);
  assert.equal(unreadable.status, 1);
  assert.equal(unreadable.stdout, '');
  assert.match(unreadable.stderr, /could not be read: ENOENT/u);
  const unknown = runChecker(['--nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --nope/u);
  const unknownRule = runChecker(['--rule', 'R11']);
  assert.equal(unknownRule.status, 1);
  assert.match(unknownRule.stderr, /Unknown boundary rule: R11/u);
});

test('the report counts the entries by rule and by their expected resolution', () => {
  const entries = [
    entry('R6-001', 'a.js', 'x', { disposition: 'cleanup' }),
    entry('R6-002', 'a.js', 'y', { disposition: 'cleanup' }),
    entry('R3-001', 'b.js', 'z', { disposition: 'unscheduled' }),
    entry('R9-001', 'c.js', 'src/services', { disposition: 'pending-decision' }),
  ];
  assert.equal(formatReport(entries), [
    'Boundary baseline: 4 recorded exceptions.',
    'By rule:',
    '  R1: 0',
    '  R2: 0',
    '  R3: 1',
    '  R4: 0',
    '  R5: 0',
    '  R6: 2',
    '  R7: 0',
    '  R8: 0',
    '  R9: 1',
    '  R10: 0',
    'By expected resolution:',
    '  cleanup: 2 (R6: 2)',
    '  unscheduled: 1 (R3: 1)',
    '  pending-decision: 1 (R9: 1)',
  ].join('\n'));
});
