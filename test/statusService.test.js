const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes, formatDuration, getBotStatus } = require('../src/services/statusService');

test('formatDuration returns compact uptime text', () => {
  assert.equal(formatDuration(90061 * 1000), '1d 1h 1m 1s');
});

test('formatBytes returns MB text', () => {
  assert.equal(formatBytes(1048576), '1.0 MB');
});

test('getBotStatus includes bot runtime fields', () => {
  const status = getBotStatus({
    guilds: { cache: { size: 3 } },
    commands: { size: 23 },
  });

  assert.equal(status.guildCount, 3);
  assert.equal(status.commandCount, 23);
  assert.equal(status.version, '1.0.0');
  assert.ok(status.startedAt instanceof Date);
  assert.ok(status.memoryUsage.heapUsed.endsWith('MB'));
});
