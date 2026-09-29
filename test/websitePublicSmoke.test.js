const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_FEATURE_CATALOG, createStatusLoader } = require('../website/statusData');
const { PUBLIC_SYSTEM_CATALOG } = require('../website/publicFeatureCatalog');

test('official pages link to the public release and retain the feature list', () => {
  const homepage = fs.readFileSync(path.join(__dirname, '../website/index.html'), 'utf8');
  const statusPage = fs.readFileSync(path.join(__dirname, '../website/status.html'), 'utf8');
  assert.match(homepage, /https:\/\/github\.com\/xichengyu810067-lab\/xiaoji-formal\/releases/);
  assert.match(homepage, /data-metric="version"/);
  assert.match(statusPage, /逐項即時狀態/);
  assert.ok(PUBLIC_FEATURE_CATALOG.some((item) => item.key === 'sudoku'));
  assert.ok(PUBLIC_SYSTEM_CATALOG.some((system) =>
    system.features.some((feature) => feature.name === '文字接龍')));
});

test('unavailable status reports an unknown result without hiding the public catalog', async () => {
  let result = '讀取中';
  const loader = createStatusLoader({ fetchImpl: async () => ({ ok: false }),
    urlProvider: () => '/public/status',
    renderSuccess: () => { result = '正常'; },
    renderFailure: () => { result = '狀態未知'; },
    setLoading: () => {},
    setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
  });
  assert.deepEqual(await loader.refresh(), { ok: false });
  assert.equal(result, '狀態未知');
  assert.ok(PUBLIC_FEATURE_CATALOG.length > 0);
});
