const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReleaseMessage, readReleaseAnnouncementConfig,
  startReleaseAnnouncementScheduler, stopReleaseAnnouncementScheduler } = require('../src/services/releaseAnnouncementService');

test('release notice contains only the public version and approved link', () => {
  const marker = 'PRIVATE_DRAFT_CANARY';
  const message = buildReleaseMessage({ tag_name: 'v1.1.2',
    html_url: 'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.1.2',
    name: marker, body: marker, published_at: '2026-09-29T00:00:00.000Z', nonce: 'public-notice' });
  const visible = JSON.stringify(message);
  assert.doesNotMatch(visible, new RegExp(marker));
  assert.match(visible, /小吉正式版本更新/);
  assert.match(visible, /v1\.1\.2/);
  assert.match(visible, /github\.com\/xichengyu810067-lab\/xiaoji-formal\/releases\/tag\/v1\.1\.2/);
  assert.deepEqual(message.allowedMentions, { parse: [] });
});

test('pending notices remain unsent until explicitly enabled', async () => {
  const config = readReleaseAnnouncementConfig({ XIAOJI_RELEASE_DISPATCH_ENABLED: 'false' });
  assert.equal(config.dispatchEnabled, false);
  const timer = { unref() {} };
  const state = startReleaseAnnouncementScheduler({}, { config,
    setIntervalFn: () => timer, clearIntervalFn: (value) => assert.equal(value, timer) });
  try {
    assert.equal(state.dispatchEnabled, false);
    assert.equal(state.run(), null);
    assert.equal(state.inFlight, null);
  } finally {
    assert.equal(await stopReleaseAnnouncementScheduler(), true);
  }
});
