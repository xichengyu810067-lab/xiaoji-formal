'use strict';

// Documents and the website must follow the command catalog: docs/COMMANDS.md is generated from
// it, the README command section and the website feature list are checked against it. The document
// and README checks live in scripts/command-doc-checks.js so `npm run check` runs the same code.
// The website check there reads every page and script under website/ for command mentions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkProject } = require('../scripts/check-project');
const {
  extractWebsiteText,
  findCommandDocsIssues,
  findMentions,
  findReadmeCommandSection,
  findReadmeIssues,
  findRemovedMentions,
  findStaleMentions,
  findWebsiteIssues,
  listWebsiteTextFiles,
} = require('../scripts/command-doc-checks');
const { buildPublicExportPlan } = require('../scripts/create-public-export');
const { renderCommandDocs, synchronizeCommandDocs } = require('../scripts/render-command-docs');
const commandCatalog = require('../website/commandCatalog');
const { PUBLIC_SYSTEM_CATALOG } = require('../website/publicFeatureCatalog');

const { COMMAND_ALIASES, COMMAND_AUDIENCES, COMMAND_CATALOG, COMMAND_GROUPS, REMOVED_COMMANDS } = commandCatalog;
const ROOT = path.join(__dirname, '..');
const REGENERATE = 'node scripts/render-command-docs.js';
const FEATURE_TEXT_FIELDS = ['name', 'purpose', 'howTo', 'limitation'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const readText = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/gu, '\n');
const isHelpListed = (entry) => entry.listInHelp && entry.audience !== 'owner';
// Written without src/loadCommands.js and without the catalog helpers, so neither is its own oracle.
const audienceOf = (entry, subcommand) => (Object.hasOwn(entry.subcommandAudiences || {}, subcommand)
  ? entry.subcommandAudiences[subcommand]
  : entry.audience);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-command-docs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeTemporary(t, name, content) {
  const target = path.join(temporaryDirectory(t), name);
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function findFeatureIssues(systems, catalog = commandCatalog) {
  const issues = [];
  for (const system of systems) {
    for (const feature of system.features) {
      for (const field of FEATURE_TEXT_FIELDS) {
        for (const issue of findStaleMentions(feature[field] || '', catalog)) {
          issues.push(`${feature.name} (${field}): ${issue}`);
        }
      }
    }
  }
  return issues;
}

function documentedUsages(markdown) {
  return [...markdown.matchAll(/^- `(\/[^`]+)` - (.+)$/gmu)].map((match) => ({ usage: match[1], text: match[2] }));
}

// Runs the project check and returns the failure text, or null when it passes.
function checkFailure(options) {
  try {
    checkProject(options);
    return null;
  } catch (error) {
    return error.message;
  }
}

test('docs/COMMANDS.md is the current output of scripts/render-command-docs.js', () => {
  assert.equal(readText('docs/COMMANDS.md'), renderCommandDocs(), `docs/COMMANDS.md is out of date; run: ${REGENERATE}`);
  assert.deepEqual(findCommandDocsIssues(), []);
});

test('synchronizing writes exactly the rendered document and can be repeated', (t) => {
  t.mock.method(console, 'log', () => {});
  const target = path.join(temporaryDirectory(t), 'COMMANDS.md');

  assert.equal(synchronizeCommandDocs({ docsPath: target }), renderCommandDocs());
  assert.equal(fs.readFileSync(target, 'utf8'), renderCommandDocs());
  synchronizeCommandDocs({ docsPath: target });
  assert.equal(fs.readFileSync(target, 'utf8'), renderCommandDocs());
  assert.ok(renderCommandDocs().endsWith('\n') && !renderCommandDocs().endsWith('\n\n'));
});

test('the document check compares without writing and names the first difference', (t) => {
  const fresh = renderCommandDocs();
  const lines = fresh.split('\n');
  const pingAt = lines.findIndex((line) => line.startsWith('- `/ping`'));
  assert.ok(pingAt > 0);

  const current = writeTemporary(t, 'COMMANDS.md', fresh);
  assert.deepEqual(findCommandDocsIssues({ docsPath: current }), []);
  const crlf = writeTemporary(t, 'COMMANDS.md', fresh.replaceAll('\n', '\r\n'));
  assert.deepEqual(findCommandDocsIssues({ docsPath: crlf }), [], 'a CRLF checkout is still current');

  const stale = [...lines.slice(0, pingAt), '- `/ping` - 舊的說明', ...lines.slice(pingAt + 1)].join('\n');
  const stalePath = writeTemporary(t, 'COMMANDS.md', stale);
  assert.deepEqual(findCommandDocsIssues({ docsPath: stalePath }), [
    `docs/COMMANDS.md is out of date: line ${pingAt + 1} should be "- \`/ping\` - 確認小吉目前在線" but is "- \`/ping\` - 舊的說明". Run: ${REGENERATE}`,
  ]);
  assert.equal(fs.readFileSync(stalePath, 'utf8'), stale, 'checking never rewrites the document');

  const truncated = writeTemporary(t, 'COMMANDS.md', lines.slice(0, 6).join('\n'));
  assert.match(findCommandDocsIssues({ docsPath: truncated })[0], /^docs\/COMMANDS\.md is out of date: line 7 should be .+ but is \(end of file\)\. Run: /u);

  const missing = path.join(temporaryDirectory(t), 'missing.md');
  assert.match(findCommandDocsIssues({ docsPath: missing })[0], /^docs\/COMMANDS\.md cannot be read \(ENOENT\)\. Run: node scripts\/render-command-docs\.js$/u);
  assert.equal(fs.existsSync(missing), false, 'a missing document is reported, not created');

  assert.match(findCommandDocsIssues({ docsPath: current, catalog: {} })[0], /^docs\/COMMANDS\.md could not be compared with the command catalog: /u);
});

test('the document check follows the catalog it is given', (t) => {
  const current = writeTemporary(t, 'COMMANDS.md', renderCommandDocs());
  const catalog = clone({ COMMAND_ALIASES, COMMAND_AUDIENCES, COMMAND_CATALOG, COMMAND_GROUPS, REMOVED_COMMANDS });
  catalog.COMMAND_CATALOG.find((entry) => entry.name === 'ping').description = '另一段說明';
  assert.equal(findCommandDocsIssues({ docsPath: current, catalog }).length, 1);
  catalog.COMMAND_CATALOG.find((entry) => entry.name === 'ping').description = commandCatalog.getCommand('ping').description;
  assert.deepEqual(findCommandDocsIssues({ docsPath: current, catalog }), []);
});

test('the command document lists what /help lists, with member and admin subcommands apart', () => {
  const documented = documentedUsages(readText('docs/COMMANDS.md'));
  const usages = documented.map(({ usage }) => usage);
  const expected = [];
  for (const entry of COMMAND_CATALOG.filter(isHelpListed)) {
    if (entry.subcommands.length === 0) {
      expected.push({ usage: `/${entry.name}`, admin: entry.audience === 'admin' });
      continue;
    }
    for (const audience of ['public', 'admin']) {
      const subcommands = entry.subcommands.filter((subcommand) => audienceOf(entry, subcommand) === audience);
      if (subcommands.length > 0) expected.push({ usage: `/${entry.name} ${subcommands.join('/')}`, admin: audience === 'admin' });
    }
  }
  assert.ok(expected.length >= 30, `only ${expected.length} help lines were expected`);
  assert.deepEqual([...usages].sort(), expected.map(({ usage }) => usage).sort());
  for (const { usage, admin } of expected) {
    const { text } = documented.find((item) => item.usage === usage);
    assert.equal(text.endsWith('；需管理權限'), admin, `${usage} admin marker`);
  }

  const document = readText('docs/COMMANDS.md');
  for (const name of ['server', 'board']) assert.ok(usages.some((usage) => usage === `/${name}` || usage.startsWith(`/${name} `)), `/${name} is documented`);
  assert.ok(document.includes('活動設定沿用各指令既有的 Discord 權限檢查'));
  assert.ok(document.includes('額外 Discord role 副作用由可選擴充決定'));
});

test('the command document never shows owner-only paths or removed commands', () => {
  const document = readText('docs/COMMANDS.md');
  const usages = documentedUsages(document).map(({ usage }) => usage);
  for (const entry of COMMAND_CATALOG) {
    if (entry.audience === 'owner') {
      assert.equal(usages.some((usage) => usage === `/${entry.name}` || usage.startsWith(`/${entry.name} `)), false, `/${entry.name} is owner-only`);
      continue;
    }
    const line = usages.filter((usage) => usage.startsWith(`/${entry.name} `)).join(' ');
    for (const subcommand of entry.subcommands.filter((candidate) => audienceOf(entry, candidate) === 'owner')) {
      assert.equal(line.split(/[ /]/u).includes(subcommand), false, `/${entry.name} ${subcommand} is owner-only`);
    }
  }
  assert.deepEqual(findStaleMentions(document), []);
  assert.equal(document.includes('/games'), false);
  // A removed path must not appear as a usage line or inside a usage list (the "list/buy/purchases"
  // of /shop is a different path than the removed /buy), and not as a mention in prose either.
  for (const removed of REMOVED_COMMANDS) {
    const [command, ...rest] = removed.split(' ');
    const subcommand = rest.join(' ');
    if (subcommand === '') {
      assert.equal(usages.some((usage) => usage === `/${command}` || usage.startsWith(`/${command} `)), false, `/${removed} is removed`);
    } else {
      const listed = usages
        .filter((usage) => usage.startsWith(`/${command} `))
        .flatMap((usage) => usage.slice(command.length + 2).split('/'));
      assert.equal(listed.includes(subcommand), false, `/${removed} is removed`);
    }
    // Removed paths are made of [a-z0-9_-] and single spaces only, so they need no regex escaping.
    const prose = new RegExp(`(?<![A-Za-z0-9_./:-])/${removed}(?![A-Za-z0-9_-])`, 'u');
    assert.equal(prose.test(document), false, `/${removed} is mentioned`);
  }
});

test('the README command section lists the live commands and no removed path', () => {
  const readme = readText('README.md');
  assert.deepEqual(findReadmeIssues(readme), []);
  const mentioned = new Set(findMentions(findReadmeCommandSection(readme)).map((mention) => mention.command));
  assert.ok(mentioned.has('server'));
  assert.ok(mentioned.has('board'));
  assert.deepEqual(findRemovedMentions(readme), []);
});

test('the README check catches a missing command, a removed command and a missing section', () => {
  const readme = readText('README.md');
  const withoutServer = readme.replace('`/server`、', '');
  assert.notEqual(withoutServer, readme);
  assert.deepEqual(findReadmeIssues(withoutServer), ['公開指令 section does not list /server']);

  const oldCommand = readme.replace('`/board start`', '`/games menu`');
  assert.deepEqual(findReadmeIssues(oldCommand), ['公開指令 section: /games menu: /games was removed']);

  const setupMention = `${readme}\n舊流程請見 /casino dice。\n`;
  assert.deepEqual(findReadmeIssues(setupMention), ['outside the 公開指令 section: /casino dice: /casino dice was removed']);

  assert.deepEqual(findReadmeIssues('# 小吉\n\n沒有指令段落。\n'), ['README.md has no "公開指令" section']);
  assert.equal(findReadmeCommandSection('## 公開指令\n- `/ping`\n'), '- `/ping`\n', 'the heading may start the file');
  assert.equal(findReadmeCommandSection('# 小吉\n\n## 公開指令\n- `/ping`\n\n## 其他\n- `/games`\n'), '- `/ping`\n');
});

test('the README check requires every command the given catalog lists in help', () => {
  const readme = readText('README.md');
  const catalog = clone({ COMMAND_ALIASES, COMMAND_AUDIENCES, COMMAND_CATALOG, COMMAND_GROUPS, REMOVED_COMMANDS });
  catalog.COMMAND_CATALOG.push({
    name: 'brand-new', description: '新指令', group: 'general', audience: 'public', listInHelp: true, subcommands: [], subcommandAudiences: {},
  });
  catalog.COMMAND_CATALOG.push({
    name: 'owner-tool', description: '擁有者工具', group: 'general', audience: 'owner', listInHelp: false, subcommands: [], subcommandAudiences: {},
  });
  assert.deepEqual(findReadmeIssues(readme, catalog), ['公開指令 section does not list /brand-new']);
});

test('npm run check passes with the real README and command document', () => {
  assert.equal(checkFailure(), null);
});

test('npm run check fails with a clear message when docs/COMMANDS.md is out of date', (t) => {
  const stale = readText('docs/COMMANDS.md').replace('- `/ping` - 確認小吉目前在線', '- `/ping` - 確認小吉目前在線（舊）');
  assert.notEqual(stale, readText('docs/COMMANDS.md'));
  const staleDocs = writeTemporary(t, 'COMMANDS.md', stale);
  const failure = checkFailure({ commandDocsPath: staleDocs });
  assert.match(failure, /^docs\/COMMANDS\.md is out of date: line \d+ should be "- `\/ping` - 確認小吉目前在線" but is "- `\/ping` - 確認小吉目前在線（舊）"\. Run: node scripts\/render-command-docs\.js$/u);
  assert.equal(fs.readFileSync(staleDocs, 'utf8'), stale, 'the check does not rewrite the document');

  const missingDocs = path.join(temporaryDirectory(t), 'COMMANDS.md');
  assert.match(checkFailure({ commandDocsPath: missingDocs }), /^docs\/COMMANDS\.md cannot be read \(ENOENT\)\. Run: node scripts\/render-command-docs\.js$/u);
  assert.equal(fs.existsSync(missingDocs), false);
});

test('npm run check fails with a clear message when the README command section drifts', (t) => {
  const readme = readText('README.md');
  const check = (text) => checkFailure({ readmePath: writeTemporary(t, 'README.md', text) });

  assert.equal(check(readme), null, 'an unchanged copy of the README passes');
  assert.equal(check(readme.replaceAll('\n', '\r\n')), null, 'a CRLF copy passes too');
  assert.equal(
    check(readme.replace('`/server`、', '')),
    'README.md does not match the command catalog:\n- 公開指令 section does not list /server',
  );
  assert.equal(
    check(readme.replace('`/board start`', '`/games menu`')),
    'README.md does not match the command catalog:\n- 公開指令 section: /games menu: /games was removed',
  );
  assert.equal(
    check(`${readme}\n舊流程請見 /word-chain start。\n`),
    'README.md does not match the command catalog:\n- outside the 公開指令 section: /word-chain start: /word-chain start was removed',
  );
  assert.equal(
    check('# 小吉\n\n沒有指令段落。\n'),
    'README.md does not match the command catalog:\n- README.md has no "公開指令" section',
  );
  assert.match(
    checkFailure({ readmePath: path.join(temporaryDirectory(t), 'README.md') }),
    /^README\.md could not be checked against the command catalog: ENOENT/u,
  );
});

test('npm run check reports both document problems together and still checks the catalog', (t) => {
  const readme = readText('README.md');
  const failure = checkFailure({
    readmePath: writeTemporary(t, 'README.md', readme.replace('`/server`、', '')),
    commandDocsPath: writeTemporary(t, 'COMMANDS.md', 'old\n'),
  });
  assert.ok(failure.includes('docs/COMMANDS.md is out of date: line 1 should be "# 公開指令" but is "old"'));
  assert.ok(failure.includes('- 公開指令 section does not list /server'));

  const catalog = clone({ COMMAND_ALIASES, COMMAND_AUDIENCES, COMMAND_CATALOG, COMMAND_GROUPS, REMOVED_COMMANDS });
  catalog.COMMAND_CATALOG.find((entry) => entry.name === 'ping').description = '另一段說明';
  const drifted = checkFailure({ commandCatalog: catalog });
  assert.ok(drifted.includes('Command catalog validation failed'));
  assert.ok(drifted.includes('docs/COMMANDS.md is out of date'), 'the document is compared with the catalog that was given');
});

test('other documents mention only live commands', () => {
  for (const file of ['docs/USER_GUIDE.md', 'docs/COMMANDS.md']) {
    assert.deepEqual(findStaleMentions(readText(file)), [], file);
  }
});

test('website feature text names only live commands and subcommands', () => {
  assert.ok(PUBLIC_SYSTEM_CATALOG.length > 0);
  const mentions = PUBLIC_SYSTEM_CATALOG.flatMap((system) => system.features
    .flatMap((feature) => FEATURE_TEXT_FIELDS.flatMap((field) => findMentions(feature[field] || ''))));
  assert.ok(mentions.length >= 30, `only ${mentions.length} command mentions were scanned`);
  assert.ok(mentions.some((mention) => mention.command === 'board' && mention.subcommands.includes('start')));
  assert.deepEqual(findFeatureIssues(PUBLIC_SYSTEM_CATALOG), []);
});

test('the website check catches removed and unknown commands in howTo and limitation', () => {
  const system = (howTo, limitation = '') => [{ name: '測試', features: [{ name: '功能', purpose: '', howTo, limitation }] }];
  assert.deepEqual(findFeatureIssues(system('使用 /board start 開局，再用 /casino loan-status 查看。', '/ping 只確認回應。')), []);
  assert.deepEqual(findFeatureIssues(system('使用 /games menu 開局。')), ['功能 (howTo): /games menu: /games was removed']);
  assert.deepEqual(findFeatureIssues(system('使用 /casino dice 下注。')), ['功能 (howTo): /casino dice: /casino dice was removed']);
  assert.deepEqual(findFeatureIssues(system('', '改用 /word-chain start。')), ['功能 (limitation): /word-chain start: /word-chain start was removed']);
  assert.deepEqual(findFeatureIssues(system('使用 /nothing-here。')), ['功能 (howTo): /nothing-here: /nothing-here is not in the catalog']);
  assert.deepEqual(findFeatureIssues(system('使用 /remind later。')), ['功能 (howTo): /remind later: /remind has no subcommand later']);
});

test('the mention scanner reads prose, lists and options but skips paths and links', () => {
  const found = (text) => findMentions(text).map((mention) => [mention.command, ...mention.subcommands].join(' '));
  assert.deepEqual(found('`/remind add/list/delete`、/board join/leave/stop'), ['remind add list delete', 'board join leave stop']);
  assert.deepEqual(found('先用 `/work admin-remind force`，再看 /weather city'), ['work admin-remind', 'weather city']);
  assert.deepEqual(found('見 docs/COMMANDS.md、https://example.com/games/play 與 <專案外路徑>/games.json、./games、C:\\games'), []);
  assert.deepEqual(found('(/ping)、「/server」與 /help，'), ['ping', 'server', 'help']);
  assert.deepEqual(findStaleMentions('/weather city、/work admin-remind force、/economy overview、/shop buy、/coin-admin history'), []);
  assert.deepEqual(findStaleMentions('/remind add/list/bogus'), ['/remind add/list/bogus: /remind has no subcommand bogus']);
  assert.deepEqual(findRemovedMentions('/games menu 與 /casino dice 與 /nothing 與 /remind bogus'), [
    '/games menu: /games was removed',
    '/casino dice: /casino dice was removed',
  ]);
  // The merged entries are removed, while the paths that replaced them are live.
  assert.deepEqual(findRemovedMentions('/buy、/economy leaderboard、/quota-list、/quota-reset 與 /quota-set'), [
    '/buy: /buy was removed',
    '/economy leaderboard: /economy leaderboard was removed',
    '/quota-list: /quota-list was removed',
    '/quota-reset: /quota-reset was removed',
    '/quota-set: /quota-set was removed',
  ]);
  assert.deepEqual(findStaleMentions('買東西用 /shop list/buy/purchases，排行榜用 /leaderboard，管理用 /coin-admin history/enable/disable'), []);
});

test('the website check reads every page and script under website/ and passes on the real site', () => {
  const files = listWebsiteTextFiles();
  for (const required of [
    'siteSupport.js',
    'games/gameClient.js',
    'games/number-match/index.html',
    'games/sudoku/index.html',
    'games/tetris/index.html',
    'index.html',
    'status.html',
    'policies.html',
    'app.js',
    'status.js',
    'publicFeatureCatalog.js',
  ]) {
    assert.ok(files.includes(required), `${required} must be scanned`);
  }
  assert.equal(files.some((file) => file.startsWith('assets/')), false, 'images are not text files');

  // These show /board start or /board status to people, so the extractor must reach those words.
  for (const file of [
    'siteSupport.js', 'games/gameClient.js', 'games/number-match/index.html', 'games/sudoku/index.html', 'games/tetris/index.html',
  ]) {
    const pieces = extractWebsiteText(fs.readFileSync(path.join(ROOT, 'website', file), 'utf8'), path.extname(file));
    assert.ok(pieces.flatMap((piece) => findMentions(piece)).some((mention) => mention.command === 'board'), `${file} names /board`);
  }
  assert.deepEqual(findWebsiteIssues(), []);
});

test('the website check catches removed and unknown commands in pages and scripts, and nothing else', (t) => {
  const root = temporaryDirectory(t);
  const write = (relativePath, content) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  write('siteSupport.js', "const help = '舊的購買指令是 /buy，請改用 /shop buy。';\nconst api = '/api/status';\n// 註解裡的 /games 不會顯示\n");
  write('games/gameClient.js', 'const message = `請使用 /economy leaderboard 或 <code>/quota-list</code>`;\n');
  write('games/tetris/index.html', [
    '<!doctype html><title>測試 /games</title><body>',
    '<p>請使用 <code>/board start</code> 或 /nothing-here</p><a href="/games/tetris/">連結</a>',
    '<script>const x = "請用 /buy";</script><style>.a { content: "/buy"; }</style><!-- /buy --></body>',
  ].join(''));
  write('notes.txt', '/buy');
  write('assets/logo.css', '.a { content: "/buy"; }');

  assert.deepEqual(listWebsiteTextFiles(root), ['games/gameClient.js', 'games/tetris/index.html', 'siteSupport.js']);
  assert.deepEqual(findWebsiteIssues({ websiteRoot: root }), [
    'website/games/gameClient.js: /economy leaderboard: /economy leaderboard was removed',
    'website/games/gameClient.js: /quota-list: /quota-list was removed',
    'website/games/tetris/index.html: /games: /games was removed',
    'website/games/tetris/index.html: /nothing-here: /nothing-here is not in the catalog',
    'website/siteSupport.js: /buy: /buy was removed',
  ]);

  write('games/tetris/index.html', '<p>請用 <code>/board start</code> 開局。</p>');
  write('games/gameClient.js', "const message = '請用 /leaderboard 或 /shop buy';\n");
  write('siteSupport.js', "const help = '請用 /coin-admin history';\n");
  assert.deepEqual(findWebsiteIssues({ websiteRoot: root }), []);
});

test('the website check skips tool folders and build output, at any depth', (t) => {
  const root = temporaryDirectory(t);
  const stale = "const text = '請用 /buy 購買';\n";
  const write = (relativePath, content = stale) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  // Folders that are not page content: every dot folder, dist and node_modules, however deep.
  for (const skipped of [
    '.vite/deps/chunk.js', '.wrangler/tmp/worker.js', '.output/public/app.js', '.git/hooks/pre-commit.js', '.cache/page.html',
    'dist/app.js', 'dist/assets/index.js', 'node_modules/package/index.js', 'games/dist/client.js', 'games/.vite/chunk.js',
    '.hidden/nested/dist/page.html',
  ]) {
    write(skipped);
  }
  // Names that only look similar are still site content.
  for (const scanned of ['distribution/page.js', 'dist-tools/page.js', 'games/vite/page.js', 'output/page.js', 'wrangler/page.js']) {
    write(scanned);
  }
  write('index.html', '<p>請用 /shop buy 購買</p>');

  assert.deepEqual(listWebsiteTextFiles(root), [
    'dist-tools/page.js', 'distribution/page.js', 'games/vite/page.js', 'index.html', 'output/page.js', 'wrangler/page.js',
  ]);
  assert.deepEqual(findWebsiteIssues({ websiteRoot: root }), [
    'website/dist-tools/page.js: /buy: /buy was removed',
    'website/distribution/page.js: /buy: /buy was removed',
    'website/games/vite/page.js: /buy: /buy was removed',
    'website/output/page.js: /buy: /buy was removed',
    'website/wrangler/page.js: /buy: /buy was removed',
  ]);

  // Only folder names inside the website count: a website folder that sits under a dot folder is scanned.
  const hiddenRoot = path.join(root, '.site', 'website');
  fs.mkdirSync(hiddenRoot, { recursive: true });
  fs.writeFileSync(path.join(hiddenRoot, 'page.js'), stale, 'utf8');
  assert.deepEqual(listWebsiteTextFiles(hiddenRoot), ['page.js']);
  assert.deepEqual(findWebsiteIssues({ websiteRoot: hiddenRoot }), ['website/page.js: /buy: /buy was removed']);
});

test('the website text extractor keeps what people read and drops code', () => {
  const pieces = (source, extension) => extractWebsiteText(source, extension);
  assert.deepEqual(pieces('<p>使用&nbsp;/board&nbsp;start&#x3002;</p>', '.html').map((piece) => piece.trim()), ['使用 /board start。']);
  assert.ok(pieces('<img alt="用 /buy 購買" src="/buy.png"><a href="/buy" aria-label="買">買</a>', '.html').includes('用 /buy 購買'));
  assert.equal(pieces('<a href="/buy" class="/buy" id="/buy">買</a>', '.html').some((piece) => piece.includes('/buy')), false);
  assert.deepEqual(pieces("const a = '/api/status'; const b = \"/buy\"; const c = '中文 /buy';", '.js'), ['中文 /buy']);
  assert.deepEqual(pieces('const a = `買 <b>/buy</b>`;', '.js'), ['買  /buy ']);
  assert.deepEqual(pieces('body { content: "/buy"; }', '.css'), []);
});

test('npm run check fails with a clear message when website text names a removed command', (t) => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, 'siteSupport.js'), "const text = '請用 /buy 購買';\n", 'utf8');
  assert.equal(
    checkFailure({ websiteRoot: root }),
    'Website text names commands that do not exist or were removed:\n- website/siteSupport.js: /buy: /buy was removed',
  );
  assert.match(
    checkFailure({ websiteRoot: path.join(root, 'missing') }),
    /^Website text could not be checked against the command catalog: ENOENT/u,
  );
  fs.writeFileSync(path.join(root, 'siteSupport.js'), "const text = '請用 /shop buy 購買';\n", 'utf8');
  assert.equal(checkFailure({ websiteRoot: root }), null);
});

test('the public export ships the generator, the document checks and the tests that guard the documents', () => {
  const files = buildPublicExportPlan();
  for (const file of [
    'scripts/render-command-docs.js',
    'scripts/command-doc-checks.js',
    'scripts/check-project.js',
    'test/commandDocs.test.js',
    'test/subcommandAccess.test.js',
    'test/leaderboardCommand.test.js',
    'docs/COMMANDS.md',
    'README.md',
  ]) {
    assert.ok(files.includes(file), `${file} must be in the public export`);
  }
});
