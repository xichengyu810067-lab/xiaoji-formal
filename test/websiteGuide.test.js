const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const commandCatalog = require('../website/commandCatalog');
const { PUBLIC_SYSTEM_CATALOG } = require('../website/publicFeatureCatalog');
const guideSearch = require('../website/guideSearch');
const theme = require('../website/theme');
const {
  GROUP_FALLBACK_CATEGORY,
  HOMEPAGE_HIGHLIGHTS,
  UNMENTIONED_COMMAND_CATEGORY,
  buildGuideModel,
  findWebsiteGuideIssues,
  renderWebsitePages,
  synchronizeWebsitePages,
} = require('../scripts/render-website-guide');
const { buildPublicExportPlan } = require('../scripts/create-public-export');

const websiteRoot = path.join(__dirname, '..', 'website');
const read = (file) => fs.readFileSync(path.join(websiteRoot, file), 'utf8');

function copyPages(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-guide-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['guide.html', 'index.html']) fs.copyFileSync(path.join(websiteRoot, file), path.join(root, file));
  return root;
}

test('the guide and homepage are the current output of npm run site:render', () => {
  assert.deepEqual(findWebsiteGuideIssues(), []);
});

test('a stale page is reported and synchronizing fixes it', (t) => {
  t.mock.method(console, 'log', () => {});
  const root = copyPages(t);
  const guide = path.join(root, 'guide.html');
  fs.writeFileSync(guide, fs.readFileSync(guide, 'utf8').replace('天氣查詢', '舊的天氣'), 'utf8');
  assert.deepEqual(findWebsiteGuideIssues({ websiteRoot: root }), [
    'website/guide.html is out of date with the public catalogs; run npm run site:render.',
  ]);
  synchronizeWebsitePages({ websiteRoot: root });
  assert.deepEqual(findWebsiteGuideIssues({ websiteRoot: root }), []);
  assert.equal(fs.readFileSync(guide, 'utf8'), read('guide.html'));
});

test('a page without its generated markers is reported instead of rewritten', (t) => {
  const root = copyPages(t);
  const index = path.join(root, 'index.html');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/<!-- generated:home-highlights:(start|end) -->/gu, ''), 'utf8');
  assert.deepEqual(findWebsiteGuideIssues({ websiteRoot: root }), [
    'website/index.html is missing the generated:home-highlights markers.',
  ]);
});

test('every public feature and every /help line is on the guide, and nothing owner-only is', () => {
  const page = read('guide.html');
  const model = buildGuideModel();
  for (const system of PUBLIC_SYSTEM_CATALOG) {
    for (const feature of system.features) assert.ok(page.includes(`>${feature.name}</strong>`), feature.name);
  }
  const usages = model.commandGroups.flatMap((group) => group.entries.map((entry) => entry.usage));
  for (const usage of usages) assert.ok(page.includes(`<code class="guide-usage">${usage}</code>`), usage);

  for (const command of commandCatalog.COMMAND_CATALOG) {
    for (const subcommand of commandCatalog.listSubcommands(command, 'owner')) {
      assert.ok(!usages.some((usage) => usage.startsWith(`/${command.name} `) && usage.split(' ')[1].split('/').includes(subcommand)),
        `${command.name} ${subcommand} is owner-only`);
    }
    if (command.audience === 'owner' || !command.listInHelp) {
      assert.ok(!usages.some((usage) => usage.split(' ')[0] === `/${command.name}`), `/${command.name} is not listed in /help`);
    }
  }
});

test('categories and audiences come from the catalogs', () => {
  const model = buildGuideModel();
  const systems = PUBLIC_SYSTEM_CATALOG.map((system) => system.name);
  assert.deepEqual(model.categories, systems);
  for (const category of [...Object.values(GROUP_FALLBACK_CATEGORY), ...Object.values(UNMENTIONED_COMMAND_CATEGORY)]) {
    assert.ok(systems.includes(category), category);
  }
  for (const highlight of HOMEPAGE_HIGHLIGHTS) assert.ok(systems.includes(highlight.system), highlight.system);

  const entries = model.commandGroups.flatMap((group) => group.entries);
  for (const entry of entries) {
    assert.ok(entry.categories.length > 0, entry.usage);
    assert.ok(entry.categories.every((category) => systems.includes(category)), entry.usage);
    assert.ok(['public', 'admin'].includes(entry.audience), entry.usage);
    assert.ok(!entry.text.includes('需管理權限'), 'the badge carries the admin marker');
  }
  assert.deepEqual(entries.find((entry) => entry.usage === '/weather').categories, ['實用工具']);

  const features = model.featureSystems.flatMap((system) => system.features);
  const audiencesOf = (name) => features.find((feature) => feature.name === name).audiences;
  assert.deepEqual(audiencesOf('天氣查詢'), ['public']);
  assert.deepEqual(audiencesOf('每日議題'), ['admin']);
  assert.deepEqual(audiencesOf('文字接龍'), ['public', 'admin']);
  assert.deepEqual(audiencesOf('@小吉聊天'), ['public']);
});

test('the rendered markup escapes catalog text', () => {
  const systems = [{ name: '實用工具', features: [{ name: '<b>測試</b>', purpose: 'a & b', howTo: '使用 /ping。', limitation: '"引號"' }] }];
  const pages = renderWebsitePages({ systems: [...systems, ...PUBLIC_SYSTEM_CATALOG.filter((system) => system.name !== '實用工具')] });
  const guide = pages.find((page) => page.file === 'guide.html').rendered;
  assert.ok(guide.includes('&lt;b&gt;測試&lt;/b&gt;'));
  assert.ok(guide.includes('a &amp; b'));
  assert.ok(guide.includes('&quot;引號&quot;'));
});

test('search matches every word, ignores case and width, and keeps a slash for commands', () => {
  const item = (text, categories = ['實用工具'], audiences = ['public']) => ({ text, categories, audiences });
  const remind = item('跨伺服器個人提醒 使用 /remind add、/remind list');
  const work = item('/work admin-remind', ['吉幣、工作與銀行'], ['admin']);
  const state = (q, cat = '', who = '') => ({ q, cat, who });

  assert.equal(guideSearch.matchesItem(remind, state('')), true);
  assert.equal(guideSearch.matchesItem(remind, state('提醒 REMIND')), true);
  assert.equal(guideSearch.matchesItem(remind, state('ｒｅｍｉｎｄ')), true);
  assert.equal(guideSearch.matchesItem(remind, state('提醒 天氣')), false);
  assert.equal(guideSearch.matchesItem(work, state('remind')), true);
  assert.equal(guideSearch.matchesItem(work, state('/remind')), false);
  assert.equal(guideSearch.matchesItem(remind, state('/remind')), true);
  assert.equal(guideSearch.matchesItem(remind, state('', '吉幣、工作與銀行')), false);
  assert.equal(guideSearch.matchesItem(work, state('', '', 'public')), false);
  assert.equal(guideSearch.matchesItem(work, state('', '', 'admin')), true);
});

test('the address bar keeps a search that can be shared', () => {
  const categories = ['實用工具'];
  assert.deepEqual(guideSearch.parseState('?q=%E5%A4%A9%E6%B0%A3&cat=%E5%AF%A6%E7%94%A8%E5%B7%A5%E5%85%B7&who=admin', categories),
    { q: '天氣', cat: '實用工具', who: 'admin' });
  assert.deepEqual(guideSearch.parseState('?cat=unknown&who=owner', categories), { q: '', cat: '', who: '' });
  assert.equal(guideSearch.parseState(`?q=${'a'.repeat(200)}`).q.length, 60);
  assert.equal(guideSearch.serializeState({ q: ' 天氣 ', cat: '', who: 'public' }), '?q=%E5%A4%A9%E6%B0%A3&who=public');
  assert.equal(guideSearch.serializeState({ q: '', cat: '', who: '' }), '');
});

test('the palette follows Taipei time unless the visitor picks one', () => {
  assert.equal(theme.themeForHour(7), 'night');
  assert.equal(theme.themeForHour(8), 'day');
  assert.equal(theme.themeForHour(17), 'day');
  assert.equal(theme.themeForHour(18), 'night');
  assert.equal(theme.taipeiHour(new Date('2026-11-13T00:30:00Z')), 8);
  assert.equal(theme.resolveTheme('auto', new Date('2026-11-13T00:30:00Z')), 'day');
  assert.equal(theme.resolveTheme('auto', new Date('2026-11-13T10:30:00Z')), 'night');
  assert.equal(theme.resolveTheme('night', new Date('2026-11-13T00:30:00Z')), 'night');
  assert.deepEqual(['auto', 'day', 'night'].map(theme.nextChoice), ['day', 'night', 'auto']);
  const blocked = { localStorage: { getItem() { throw new Error('blocked'); } } };
  assert.equal(theme.readChoice(blocked), 'auto');
});

test('pages work without JavaScript', () => {
  const css = read('styles.css');
  assert.match(css, /html\.js \.reveal \{ opacity: 0;/u, 'content is hidden for the fade-in only when JavaScript runs');
  assert.doesNotMatch(css, /^\.reveal \{ opacity: 0/mu);
  assert.match(read('guide.html'), /<form class="guide-search" data-guide-form role="search" hidden>/u);
  for (const file of ['index.html', 'guide.html', 'status.html', 'policies.html']) {
    const page = read(file);
    assert.match(page, /<script src="\.\/theme\.js"><\/script>/u, `${file} sets the palette before painting`);
    assert.ok(page.indexOf('siteSupport.js') < page.indexOf('siteChrome.js'), `${file} loads siteChrome.js after siteSupport.js`);
    assert.match(page, /data-nav-toggle/u, `${file} has the shared header`);
  }
});

test('the public export carries the guide, its generator and its tests', () => {
  const files = buildPublicExportPlan();
  for (const file of [
    'website/guide.html', 'website/guide.css', 'website/guideSearch.js', 'website/theme.js', 'website/siteChrome.js',
    'scripts/render-website-guide.js', 'docs/WEBSITE_ARCHITECTURE.md',
    'test/websiteGuide.test.js', 'test/websiteArchitecture.test.js',
  ]) assert.ok(files.includes(file), file);
});

test('the portrait layers sit on the unchanged base art and stay hidden until they can work', () => {
  const page = read('index.html');
  for (const file of ['xiaoji-hero.png', 'xiaoji-hero-eyes.png', 'xiaoji-hero-eyes-white.png', 'xiaoji-hero-eyes-mask.png', 'xiaoji-hero-smile.png']) {
    assert.ok(fs.existsSync(path.join(websiteRoot, 'assets', file)), file);
  }
  assert.match(page, /<span class="portrait-eyes" data-eye-layer hidden>/u, 'the eye layer waits for both of its images');
  assert.match(page, /class="portrait-smile" data-smile-layer src="\.\/assets\/xiaoji-hero-smile\.png"/u);
  const css = read('styles.css');
  assert.match(css, /\.portrait-smile \{ opacity: 0;/u, 'the smile only shows while 小吉 is happy');
  assert.match(css, /\.portrait-button\.is-happy \.portrait-eyes \{ opacity: 0; \}/u, 'the moving eyes never sit on the closed smile');
  assert.match(css, /mask: url\("assets\/xiaoji-hero-eyes-mask\.png"\)/u);
});
