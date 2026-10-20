'use strict';

// The shared route shape checks (src/platform/discordRoute.js). isCanonicalRoute moved here from the
// test-control egress unchanged; test/testControlEgress.test.js still checks it through that egress.
// routeSegments is what a route template is matched against.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isCanonicalRoute, routeSegments } = require('../src/platform/discordRoute');

const CHANNEL = '100000000000000001';
const OTHER = '100000000000000002';
const MESSAGE = '100000000000000003';
const BACKSLASH = String.fromCharCode(92);

const CANONICAL = Object.freeze([
  `/channels/${CHANNEL}/messages`,
  `/channels/${CHANNEL}/messages?limit=5`,
  `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9C%85/@me`,
  `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%23%EF%B8%8F%E2%83%A3/@me`,
  `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/custom_name:${OTHER}/@me`,
  '/users/%40me',
  '/users/@me/channels',
  '/gateway/bot',
  `/webhooks/${OTHER}/synthetic-token/messages/@original`,
]);

const NOT_CANONICAL = Object.freeze([
  `/channels/${CHANNEL}/../${OTHER}/messages`,
  `/channels/${CHANNEL}/./messages`,
  `/channels/${CHANNEL}/%2e%2e/${OTHER}/messages`,
  `/channels/${CHANNEL}/.%2E/${OTHER}/messages`,
  `/channels/${CHANNEL}%2F..%2F${OTHER}/messages`,
  `/channels/${CHANNEL}/messages%2fx`,
  // An encoded "." inside a segment is refused too, although no dot segment comes of it.
  `/channels/${CHANNEL}/messages%2Ejson`,
  `/channels/${CHANNEL}/a%252eb/messages`,
  `/channels/${CHANNEL}${BACKSLASH}..${BACKSLASH}${OTHER}/messages`,
  `/channels/${CHANNEL}%5C..%5C${OTHER}/messages`,
  `/channels/${CHANNEL}/%252e%252e/${OTHER}/messages`,
  `/channels/${CHANNEL}/%25%32%65%25%32%65/${OTHER}/messages`,
  `/channels/${CHANNEL}/%c0%ae%c0%ae/${OTHER}/messages`,
  `/channels/${CHANNEL}/%u002e%u002e/${OTHER}/messages`,
  `/channels/${CHANNEL}/%f8%80%80%80%ae%f8%80%80%80%ae/${OTHER}/messages`,
  `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/#/@me`,
  `/channels/${CHANNEL}/.\t./${OTHER}/messages`,
  `/channels/${CHANNEL}/messages?x=1#/../${OTHER}`,
]);

test('canonical routes pass and every rewritable form is refused', () => {
  for (const route of CANONICAL) assert.equal(isCanonicalRoute(route), true, route);
  for (const route of NOT_CANONICAL) assert.equal(isCanonicalRoute(route), false, JSON.stringify(route));
});

test('the test-control egress uses the shared check instead of its own copy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'testControlEgress.js'), 'utf8');
  assert.match(source, /require\('\.\/discordRoute'\)/u);
  assert.doesNotMatch(source, /function isCanonicalRoute|ROUTE_CANONICAL_BASE/u);
});

test('routeSegments decodes each segment once, lower-cases it and drops the query', () => {
  assert.deepEqual(routeSegments(`/channels/${CHANNEL}/messages`), ['channels', CHANNEL, 'messages']);
  assert.deepEqual(routeSegments('/users/%40me/channels'), ['users', '@me', 'channels']);
  assert.deepEqual(routeSegments('/Users/@Me/Guilds/1'), ['users', '@me', 'guilds', '1']);
  assert.deepEqual(routeSegments(`/guilds/${OTHER}/members?limit=5&after=0`), ['guilds', OTHER, 'members']);
  assert.deepEqual(routeSegments(`/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9C%85/@me`),
    ['channels', CHANNEL, 'messages', MESSAGE, 'reactions', '✅', '@me']);
  assert.deepEqual(routeSegments(`/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%23%EF%B8%8F%E2%83%A3/@me`),
    ['channels', CHANNEL, 'messages', MESSAGE, 'reactions', '#️⃣', '@me']);
  assert.deepEqual(routeSegments('/webhooks/1/Token-With-Case/messages/@original'),
    ['webhooks', '1', 'token-with-case', 'messages', '@original']);
  // One decoding layer only: a second one stays encoded and so names no known segment.
  assert.deepEqual(routeSegments('/users/%2540me'), ['users', '%40me']);
});

test('routeSegments refuses empty segments, non-canonical routes and broken encodings', () => {
  for (const route of [
    '', '/', 'channels/1/messages', `//channels/${CHANNEL}/messages`, `/channels//messages`,
    `/channels/${CHANNEL}/messages/`, `/channels/${CHANNEL}/messages/?limit=1`, '/users/%C3', '/users/%E2%9C',
    ...NOT_CANONICAL,
  ]) {
    assert.equal(routeSegments(route), null, JSON.stringify(route));
  }
  for (const value of [undefined, null, 7, ['/users/@me'], { toString: () => '/users/@me' }]) {
    assert.equal(routeSegments(value), null, String(value));
  }
});
