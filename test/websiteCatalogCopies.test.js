const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { CATALOG_FILES, CATALOG_ROOT, findWebsiteGuideIssues } = require('../scripts/render-website-guide');

// The bot loads the public catalogs from src/platform/catalogs; the status page loads the same files from website/ with
// <script> tags. The website files are byte-for-byte copies written by `npm run site:render`.
const websiteRoot = path.join(__dirname, '..', 'website');

test('every website catalog is a byte-for-byte copy of its source in src/platform/catalogs', () => {
  assert.deepEqual([...CATALOG_FILES].sort(), ['commandCatalog.js', 'gameCatalog.js', 'publicFeatureCatalog.js', 'statusData.js']);
  for (const file of CATALOG_FILES) {
    assert.ok(fs.readFileSync(path.join(websiteRoot, file)).equals(fs.readFileSync(path.join(CATALOG_ROOT, file))), file);
  }
  assert.deepEqual(findWebsiteGuideIssues(), []);
});

test('a stale or missing website copy is reported and site:render writes it again', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'xiaoji-catalog-copies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of fs.readdirSync(websiteRoot)) {
    if (file.endsWith('.html') || file.endsWith('.js')) fs.copyFileSync(path.join(websiteRoot, file), path.join(root, file));
  }
  fs.appendFileSync(path.join(root, 'gameCatalog.js'), '// edited by hand\n');
  fs.rmSync(path.join(root, 'statusData.js'));
  assert.deepEqual(findWebsiteGuideIssues({ websiteRoot: root }), [
    'website/gameCatalog.js is not a copy of src/platform/catalogs/gameCatalog.js; run npm run site:render.',
    'website/statusData.js is not a copy of src/platform/catalogs/statusData.js; run npm run site:render.',
  ]);
  const { synchronizeWebsitePages } = require('../scripts/render-website-guide');
  const log = t.mock.method(console, 'log', () => {});
  synchronizeWebsitePages({ websiteRoot: root });
  assert.equal(log.mock.callCount() >= 2, true);
  assert.deepEqual(findWebsiteGuideIssues({ websiteRoot: root }), []);
});

test('the status page loads the catalog copies as plain browser scripts, in an order that works', () => {
  const html = fs.readFileSync(path.join(websiteRoot, 'status.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"/gu)].map((match) => match[1]);
  const context = vm.createContext({});
  for (const file of scripts.filter((name) => CATALOG_FILES.includes(name))) {
    new vm.Script(fs.readFileSync(path.join(websiteRoot, file), 'utf8'), { filename: `website/${file}` }).runInContext(context);
  }
  assert.ok(scripts.indexOf('gameCatalog.js') < scripts.indexOf('statusData.js'), 'the game catalog comes first');
  assert.ok(Array.isArray(context.XiaojiGameCatalog.GAME_CATALOG));
  assert.ok(Array.isArray(context.XiaojiStatusData.PUBLIC_FEATURE_CATALOG));
  assert.ok(Array.isArray(context.XiaojiPublicFeatureCatalog.PUBLIC_SYSTEM_CATALOG));
});
