'use strict';

// Prints the facts that docs/ARCHITECTURE.md cites, so the guide is recounted instead of read from the code again.
//
//   node scripts/architecture-facts.js [section] [--json] [--markdown]
//
//   counts     the structural numbers: commands, events, systems, adapters, tables, ledger purposes, rules, tests
//   services   every file of src/services with its exact numbers and the bands table 3.1 of the guide uses
//              (--markdown prints them as rows of that table)
//   tables     every table the code creates, with its family and the files that own it
//   baseline   the exceptions of scripts/boundary-baseline.json; `baseline R6` lists one rule
//   bands      the band limits, worded as the guide words them
//   doc        checks the guide against the code and exits with 1 when something in it is out of date
//   all        counts, services, tables and baseline
//
// It only reads files: nothing is written and nothing goes over the network. The ledger purposes are read by
// loading src/systems/safety/ledgerLayout.js, which only defines them.

const fs = require('node:fs');
const path = require('node:path');
const boundaries = require('./check-boundaries');

const PROJECT_ROOT = path.join(__dirname, '..');
const DOCUMENT = 'docs/ARCHITECTURE.md';
const BASELINE = 'scripts/boundary-baseline.json';

// A value falls into the first band whose limit is above it. The guide states the same limits (see describeBands).
const BANDS = Object.freeze({
  size: Object.freeze([['小', 300], ['中', 900], ['大', 2000], ['特大', Infinity]]),
  fanIn: Object.freeze([['少', 4], ['中', 10], ['多', Infinity]]),
  fanOut: Object.freeze([['少', 2], ['中', 4], ['多', Infinity]]),
});

const ADAPTER_LABEL = '轉接';
const NO_SYSTEM_LABEL = '（未歸屬）';
const SYSTEM_LABELS = Object.freeze({ rewardLedger: '（獎勵帳本）' });

function bandOf(value, bands) {
  return bands.find(([, limit]) => value < limit)[0];
}

function describeLimits(bands, { unit, first }) {
  let from = 0;
  return bands.map(([label, limit]) => {
    const text = limit === Infinity ? `${from}${unit}以上` : (from === 0 && first ? `${first} ${limit}` : `${from}–${limit - 1}${unit}`);
    from = limit;
    return `${label} = ${text}`;
  }).join('；');
}

// The lines of the guide that state the limits. The guide has to hold each of them as written here.
function describeBands() {
  return [
    `規模：${describeLimits(BANDS.size, { unit: ' 行', first: '行數 <' })}`,
    `被載入：${describeLimits(BANDS.fanIn, { unit: ' 個' })}`,
    `載入其他 services：${describeLimits(BANDS.fanOut, { unit: ' 個' })}`,
  ];
}

function readText(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/gu, '\n');
}

// The .js files below `directory`, as sorted, slash-separated paths relative to `root`.
function listJs(root, directory) {
  const found = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(child);
    }
  };
  if (fs.existsSync(path.join(root, directory))) visit(directory);
  return found.sort();
}

function loadBaselineEntries(root) {
  return boundaries.loadBaseline(path.join(root, BASELINE));
}

function collectTables(root = PROJECT_ROOT) {
  const project = boundaries.createProject(root);
  const created = new Map();
  for (const file of project.sourceFiles) {
    for (const { name, creates } of boundaries.sqlReferences(project.readSource(file).sql)) {
      if (creates && !created.has(name)) created.set(name, file);
    }
  }
  const families = boundaries.TABLE_FAMILIES.map((family) => ({ name: family.name, owners: [...family.owners], tables: [] }));
  const unowned = [];
  for (const [table, createdIn] of [...created].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const family = boundaries.familyOf(table);
    const slot = family ? families.find((candidate) => candidate.name === family.name) : null;
    (slot ? slot.tables : unowned).push({ table, createdIn });
  }
  return { total: created.size, families, unowned };
}

function collectBaseline(root = PROJECT_ROOT) {
  const entries = loadBaselineEntries(root);
  const byRule = {};
  for (const rule of Object.keys(boundaries.RULES)) {
    const own = entries.filter((entry) => entry.rule === rule);
    byRule[rule] = { entries: own.length, occurrences: own.reduce((sum, entry) => sum + entry.count, 0) };
  }
  return { total: entries.length, byRule, entries };
}

function collectCounts(root = PROJECT_ROOT, { tables = collectTables(root) } = {}) {
  const systemNames = fs.readdirSync(path.join(root, 'src', 'systems'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const services = listJs(root, 'src/services');
  const purposes = require(path.join(root, 'src', 'systems', 'safety', 'ledgerLayout.js')).SAFETY_LEDGER_PURPOSES;
  const baseline = collectBaseline(root);
  return {
    commands: listJs(root, 'src/commands').length,
    events: listJs(root, 'src/events').length,
    coordinators: listJs(root, 'src/coordinators').length,
    systems: {
      directories: systemNames.length,
      names: systemNames,
      files: listJs(root, 'src/systems').length,
    },
    platform: listJs(root, 'src/platform').length,
    utils: listJs(root, 'src/utils').length,
    services: services.length,
    serviceAdapters: services.filter((file) => boundaries.ADAPTER_FILES.includes(file)).length,
    legacyAdapters: listJs(root, 'src/games').length,
    tables: tables.total,
    ledgerPurposes: Object.keys(purposes).length,
    rules: Object.keys(boundaries.RULES).length,
    tests: fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.js')).length,
    baseline: { total: baseline.total, byRule: baseline.byRule },
  };
}

// One row for each file of src/services: exact numbers, then the bands of table 3.1.
function collectServices(root = PROJECT_ROOT) {
  const project = boundaries.createProject(root);
  const services = listJs(root, 'src/services');
  const productionLoads = new Map(services.map((file) => [file, new Set()]));
  for (const file of project.productionFiles) {
    for (const load of project.loadsOf(file)) {
      if (load.target && load.target !== file && productionLoads.has(load.target)) productionLoads.get(load.target).add(file);
    }
  }
  // Tests and scripts load a service by a literal path; a path built at run time is not seen.
  const sideLoads = new Map(services.map((file) => [file, new Set()]));
  for (const file of [...listJs(root, 'test'), ...listJs(root, 'scripts')]) {
    for (const { request } of boundaries.loadsIn(project.readSource(file))) {
      const target = project.resolveLocal(file, request);
      if (target && sideLoads.has(target)) sideLoads.get(target).add(file);
    }
  }
  const ids = new Map(loadBaselineEntries(root).filter((entry) => entry.rule === 'R9').map((entry) => [entry.file, entry.id]));
  const rows = services.map((file) => {
    const adapter = boundaries.ADAPTER_FILES.includes(file);
    const lines = readText(root, file).split('\n').length - 1;
    const loadedBy = productionLoads.get(file).size;
    const loadedByTests = sideLoads.get(file).size;
    const loadsServices = new Set(project.loadsOf(file).map((load) => load.target)
      .filter((target) => target && target !== file && target.startsWith('src/services/'))).size;
    const inBand = bandOf(loadedBy, BANDS.fanIn);
    const outBand = bandOf(loadsServices, BANDS.fanOut);
    const level = inBand === '多' ? '高' : (inBand === '少' && outBand === '少' ? '低' : '中');
    const system = boundaries.systemOf(file);
    return {
      id: ids.get(file) || '',
      file,
      system: system ? (SYSTEM_LABELS[system] || system) : NO_SYSTEM_LABEL,
      adapter,
      lines,
      loadedBy,
      loadedByTests,
      loadsServices,
      sizeBand: adapter ? ADAPTER_LABEL : bandOf(lines, BANDS.size),
      inBand,
      testBand: bandOf(loadedByTests, BANDS.fanIn),
      outBand,
      level,
      order: adapter ? 0 : { 低: 1, 中: 2, 高: 3 }[level],
    };
  });
  return rows.sort((left, right) => left.order - right.order || (left.file < right.file ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------------------------

// The numbers the guide cites, written "<noun>（目前 N 個，重算：<section>）". Every one of them is checked here.
const CITED = Object.freeze({
  指令檔: ({ counts }) => counts.commands,
  事件檔: ({ counts }) => counts.events,
  系統目錄: ({ counts }) => counts.systems.directories,
  舊路徑轉接檔: ({ counts }) => counts.legacyAdapters,
  資料表: ({ counts }) => counts.tables,
  帳本用途: ({ counts }) => counts.ledgerPurposes,
});
const CITED_PATTERN = new RegExp(`(${Object.keys(CITED).join('|')})（目前 (\\d+) [個張條]，重算：([a-z]+)）`, 'gu');
const PATH_ROOTS = Object.freeze(['src/', 'scripts/', 'test/', 'docs/', 'website/', 'assets/', 'cloudflare/', 'public-export/', '.github/']);
// Written in the guide, but only present where the bot has run.
const RUNTIME_ONLY_PATHS = new Set(['src/data/']);

function rowCells(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

// What in the guide no longer matches the code. An empty list means it is current.
function checkDocument(root = PROJECT_ROOT) {
  const problems = [];
  const text = readText(root, DOCUMENT);

  // Full paths written in code spans.
  const seen = new Set();
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    const token = match[1];
    if (seen.has(token) || !PATH_ROOTS.some((prefix) => token.startsWith(prefix))) continue;
    seen.add(token);
    if (/[<>*{}()\s]/u.test(token) || RUNTIME_ONLY_PATHS.has(token)) continue;
    if (!fs.existsSync(path.join(root, token))) problems.push(`the path ${token} does not exist`);
  }
  // File names written without their directory.
  const known = new Set(fs.readdirSync(root).filter((name) => name.endsWith('.js')));
  for (const directory of ['src', 'scripts', 'test', 'website']) {
    for (const file of listJs(root, directory)) known.add(path.posix.basename(file));
  }
  for (const match of text.matchAll(/`([A-Za-z0-9_.-]+\.js)`/gu)) {
    if (!known.has(match[1])) problems.push(`the file ${match[1]} is not in the project`);
  }

  // The numbers it cites.
  const tables = collectTables(root);
  const facts = { counts: collectCounts(root, { tables }), tables };
  const cited = [...text.matchAll(CITED_PATTERN)];
  for (const [, noun, written, section] of cited) {
    const actual = CITED[noun](facts);
    if (Number(written) !== actual) problems.push(`${noun}: the guide says ${written}, the code has ${actual} (recount: ${section})`);
  }
  const stray = (text.match(/（目前 \d+/gu) || []).length - cited.length;
  if (stray > 0) problems.push(`${stray} number(s) written as （目前 N … are not in the form of ${Object.keys(CITED).join('、')}`);

  // The rules, and the limits of the bands.
  for (const rule of Object.keys(boundaries.RULES)) {
    if (!new RegExp(`\\b${rule}\\b`, 'u').test(text)) problems.push(`the rule ${rule} is not mentioned`);
  }
  for (const line of describeBands()) {
    if (!text.includes(line)) problems.push(`the limits of the bands are not written as: ${line}`);
  }

  // Table 3.1: one row for each file of src/services, with the bands as they are now.
  const rows = collectServices(root);
  const written = new Map();
  for (const line of text.split('\n')) {
    if (!/^\| R9-\d{3} \|/u.test(line)) continue;
    const cells = rowCells(line);
    written.set(cells[1].replace(/`/gu, ''), cells);
  }
  for (const row of rows) {
    const name = path.posix.basename(row.file);
    const cells = written.get(name);
    if (!cells) {
      problems.push(`${row.file} has no row in table 3.1`);
      continue;
    }
    const expected = [row.id, `\`${name}\``, row.system, null, row.sizeBand, row.inBand, row.testBand, row.outBand,
      row.level, String(row.order)];
    const labels = ['id', 'file', 'current system', null, 'size', 'loaded by', 'loaded by tests', 'loads services',
      'dependency', 'order'];
    expected.forEach((value, index) => {
      if (value !== null && cells[index] !== value) {
        problems.push(`table 3.1, ${name}: ${labels[index]} is ${cells[index]} in the guide and ${value} now`);
      }
    });
    written.delete(name);
  }
  for (const name of written.keys()) problems.push(`table 3.1 has a row for ${name}, which is not in src/services`);
  return problems;
}

// What `npm run check` asks of this file: that it can still collect every number the guide recounts.
function findFactsFailures({ projectRoot = PROJECT_ROOT } = {}) {
  try {
    const tables = collectTables(projectRoot);
    const counts = collectCounts(projectRoot, { tables });
    collectServices(projectRoot);
    if (counts.commands === 0 || counts.systems.directories === 0 || tables.total === 0) {
      return ['scripts/architecture-facts.js found no commands, systems or tables to count'];
    }
    return [];
  } catch (error) {
    return [`scripts/architecture-facts.js could not collect the facts the architecture guide recounts: ${error.message}`];
  }
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

function printCounts(counts) {
  const lines = [
    `commands            ${counts.commands}   (src/commands)`,
    `events              ${counts.events}   (src/events)`,
    `coordinators        ${counts.coordinators}   (src/coordinators)`,
    `system directories  ${counts.systems.directories}   (${counts.systems.names.join(', ')})`,
    `system files        ${counts.systems.files}   (src/systems)`,
    `platform files      ${counts.platform}   (src/platform)`,
    `utils files         ${counts.utils}   (src/utils)`,
    `services files      ${counts.services}   (${counts.serviceAdapters} of them one-line adapters)`,
    `legacy adapters     ${counts.legacyAdapters}   (.js files below src/games)`,
    `tables              ${counts.tables}   (created by CREATE TABLE in src)`,
    `ledger purposes     ${counts.ledgerPurposes}`,
    `rules               ${counts.rules}`,
    `test files          ${counts.tests}   (test/*.test.js)`,
    `baseline entries    ${counts.baseline.total}`,
  ];
  for (const [rule, { entries, occurrences }] of Object.entries(counts.baseline.byRule)) {
    if (entries > 0) lines.push(`  ${rule.padEnd(4)} ${String(entries).padStart(3)} entries, ${occurrences} occurrences`);
  }
  return lines.join('\n');
}

function printServices(rows, { markdown }) {
  if (markdown) {
    return rows.map((row) => `| ${row.id} | \`${path.posix.basename(row.file)}\` | ${row.system} | ？ | ${row.sizeBand} `
      + `| ${row.inBand} | ${row.testBand} | ${row.outBand} | ${row.level} | ${row.order} |`).join('\n');
  }
  const lines = rows.map((row) => [
    row.id.padEnd(7), path.posix.basename(row.file).padEnd(32), row.system.padEnd(14),
    `${row.adapter ? ADAPTER_LABEL : `${row.lines} lines`}`.padEnd(13), row.sizeBand.padEnd(3),
    `in ${String(row.loadedBy).padStart(2)} ${row.inBand}`, `tests ${String(row.loadedByTests).padStart(2)} ${row.testBand}`,
    `out ${row.loadsServices} ${row.outBand}`, `level ${row.level}`, `order ${row.order}`,
  ].join('  '));
  const perOrder = [0, 1, 2, 3].map((order) => `${order}: ${rows.filter((row) => row.order === order).length}`);
  lines.push('', `files ${rows.length}; by order ${perOrder.join(', ')}`);
  return lines.join('\n');
}

function printTables({ total, families, unowned }) {
  const lines = [`${total} tables`];
  for (const family of families) {
    lines.push('', `${family.name} (${family.tables.length})`, `  owners: ${family.owners.join(', ')}`);
    for (const { table, createdIn } of family.tables) lines.push(`  ${table}  <- ${createdIn}`);
  }
  if (unowned.length > 0) {
    lines.push('', `NO OWNER (${unowned.length})`);
    for (const { table, createdIn } of unowned) lines.push(`  ${table}  <- ${createdIn}`);
  }
  return lines.join('\n');
}

function printBaseline({ entries }, rule) {
  return entries.filter((entry) => !rule || entry.rule === rule).map((entry) => [
    entry.id, entry.file, '->', entry.target, `x${entry.count}`, entry.disposition, entry.note || '',
  ].join(' ')).join('\n');
}

function main(argv, root = PROJECT_ROOT) {
  const flags = new Set(argv.filter((argument) => argument.startsWith('--')));
  const words = argv.filter((argument) => !argument.startsWith('--'));
  const section = words[0] || 'counts';
  const json = flags.has('--json');
  const show = (value, format) => console.log(json ? JSON.stringify(value, null, 2) : format(value));
  const sections = {
    counts: () => show(collectCounts(root), printCounts),
    services: () => show(collectServices(root), (rows) => printServices(rows, { markdown: flags.has('--markdown') })),
    tables: () => show(collectTables(root), printTables),
    baseline: () => show(collectBaseline(root), (value) => printBaseline(value, words[1])),
    bands: () => show(describeBands(), (lines) => lines.join('\n')),
    doc: () => {
      const problems = checkDocument(root);
      if (problems.length === 0) {
        console.log(`${DOCUMENT} matches the code.`);
        return 0;
      }
      console.error(`${DOCUMENT} is out of date:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
      return 1;
    },
    all: () => {
      for (const name of ['counts', 'services', 'tables', 'baseline']) {
        console.log(`## ${name}`);
        sections[name]();
        console.log('');
      }
    },
  };
  if (!sections[section]) {
    console.error(`Unknown section: ${section}. Use one of ${Object.keys(sections).join(', ')}.`);
    return 1;
  }
  return sections[section]() || 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BANDS,
  checkDocument,
  collectBaseline,
  collectCounts,
  collectServices,
  collectTables,
  describeBands,
  findFactsFailures,
};
