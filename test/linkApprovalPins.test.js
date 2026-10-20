'use strict';

// Pins of how links are approved and rewritten today, written before the link rules move into one
// shared module. The expected values live in test/fixtures/linkApprovalCorpus.js and were produced by
// the code as it stood; moving the rules must not change one of them:
//   - the chat output policy: approvedUrl, containsUnapprovedXiaojiReleaseUrl and
//     sanitizeUserFacingOutput, with the safety events it emits;
//   - the release notice: parseStableSemver, validateReleaseUrl and buildReleaseMessage.
// Nothing here opens a network connection or starts the bot.

const test = require('node:test');
const assert = require('node:assert/strict');

const outputPolicy = require('../src/systems/conversation/userFacingOutputPolicy');
const {
  CONVERSATION_SAFETY_EVENT_CODES,
  setConversationSafetyEventHandler,
} = require('../src/systems/conversation/safetyEvents');
const release = require('../src/services/releaseAnnouncementService');
const {
  LINK_CASES,
  OTHER_REPOSITORY,
  OTHER_REPOSITORY_URL_CASES,
  RELEASE_MESSAGE_CASES,
  RELEASE_TAG_CASES,
  RELEASE_URL_CASES,
} = require('./fixtures/linkApprovalCorpus');

const { approvedUrl, containsUnapprovedXiaojiReleaseUrl, sanitizeUserFacingOutput } = outputPolicy;
const OFFICIAL_REPOSITORY = 'xichengyu810067-lab/xiaoji-formal';
const EVIL = 'https://evil.example';

// Runs sanitizeUserFacingOutput with an emitter that records the event codes and checks that every
// event carries the context it was given.
function sanitizeRecording(input) {
  const context = Object.freeze({ actorId: 'actor-a', guildId: 'guild-a', channelId: 'channel-a', messageId: 'message-a' });
  const codes = [];
  const text = sanitizeUserFacingOutput(input, {
    context,
    emit: (code, given) => {
      assert.equal(given, context);
      codes.push(code);
    },
  });
  return { text, codes };
}

test('the link corpus covers every rewriting step and both outcomes', () => {
  assert.ok(LINK_CASES.length >= 150);
  const inputs = LINK_CASES.map(([input]) => input);
  assert.equal(new Set(inputs).size, inputs.length, 'no input is listed twice');
  assert.ok(LINK_CASES.some(([, approved]) => approved !== null));
  assert.ok(LINK_CASES.some(([, approved]) => approved === null));
  assert.ok(LINK_CASES.some(([, , unapproved]) => unapproved));
  for (const shape of [/\]\(/u, /<https?:/u, /\bwww\./iu, /@everyone|<@/u, /%2e/iu, /@github\.com/u, /:\d+\//u, /\?/u, /#/u, /。/u]) {
    assert.ok(inputs.some((input) => shape.test(input)), String(shape));
  }
});

test('approvedUrl, the release reference check and the output rewrite give today\'s answer for every corpus entry', () => {
  for (const [input, approved, unapproved, sanitized, events] of LINK_CASES) {
    const label = JSON.stringify(input);
    assert.equal(approvedUrl(input), approved, label);
    assert.equal(containsUnapprovedXiaojiReleaseUrl(input), unapproved, label);
    const { text, codes } = sanitizeRecording(input);
    assert.equal(text, sanitized, label);
    assert.deepEqual(codes, events, label);
  }
});

test('values that are not text, and a masked label at the length limit, are handled as today', () => {
  for (const value of [undefined, null, 0, false, '']) {
    assert.equal(approvedUrl(value), null, String(value));
    assert.equal(containsUnapprovedXiaojiReleaseUrl(value), false, String(value));
    assert.deepEqual(sanitizeRecording(value), { text: '這段內容目前無法安全顯示。', codes: [] }, String(value));
  }
  assert.deepEqual(sanitizeRecording(12345), { text: '12345', codes: [] });

  const longUrl = `https://${'a'.repeat(2_100)}.example/`;
  assert.equal(approvedUrl(longUrl), null);
  assert.deepEqual(sanitizeRecording(longUrl), { text: '[連結已移除]', codes: ['AI_OUTPUT_URL_BLOCKED'] });
  const padded = `${' '.repeat(3_000)}https://discord.gg/TqkCx9kYmk${' '.repeat(3_000)}`;
  assert.equal(approvedUrl(padded), 'https://discord.gg/TqkCx9kYmk');

  // A masked label of up to 300 characters is a masked link; one more and only the URL is seen.
  const atLimit = 'x'.repeat(300);
  assert.deepEqual(sanitizeRecording(`[${atLimit}](${EVIL}/one)`), { text: atLimit, codes: ['AI_OUTPUT_URL_BLOCKED'] });
  const overLimit = 'x'.repeat(301);
  assert.deepEqual(sanitizeRecording(`[${overLimit}](${EVIL}/one)`),
    { text: `[${overLimit}]([連結已移除])`, codes: ['AI_OUTPUT_URL_BLOCKED'] });
});

test('without an emitter the rewrite reports through the conversation safety handler', () => {
  const events = [];
  const restore = setConversationSafetyEventHandler((event) => events.push(event));
  try {
    const text = sanitizeUserFacingOutput(`看 ${EVIL}/x @here`, {
      context: { actorId: 'actor-a', guildId: 'guild-a', channelId: 'channel-a', messageId: 'message-a' },
    });
    assert.equal(text, '看 [連結已移除] [提及已移除]');
  } finally {
    restore();
  }
  assert.deepEqual(events.map((event) => event.code), [
    CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_URL_BLOCKED,
    CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_MENTION_BLOCKED,
  ]);
  for (const event of events) {
    assert.deepEqual({ ...event, at: 0 }, {
      code: event.code, at: 0, actorId: 'actor-a', guildId: 'guild-a', channelId: 'channel-a', messageId: 'message-a',
    });
  }
});

test('the chat output policy keeps its exports, replacement texts and approved hosts', () => {
  assert.deepEqual(Object.keys(outputPolicy).sort(), [
    'APPROVED_USER_FACING_URLS',
    'BLOCKED_LINK_REPLACEMENT',
    'BLOCKED_MENTION_REPLACEMENT',
    'approvedUrl',
    'containsUnapprovedXiaojiReleaseUrl',
    'sanitizeUserFacingOutput',
  ]);
  assert.equal(outputPolicy.BLOCKED_LINK_REPLACEMENT, '[連結已移除]');
  assert.equal(outputPolicy.BLOCKED_MENTION_REPLACEMENT, '[提及已移除]');
  assert.ok(Object.isFrozen(outputPolicy.APPROVED_USER_FACING_URLS));
  assert.deepEqual(outputPolicy.APPROVED_USER_FACING_URLS.map((rule) => rule.hostname), [
    'github.com',
    'discord.gg',
    'opendata.cwa.gov.tw',
    'data.gov.tw',
    'xiaoji-public-status.xichengyu810067.workers.dev',
  ]);
  for (const rule of outputPolicy.APPROVED_USER_FACING_URLS) {
    assert.ok(Object.isFrozen(rule), rule.hostname);
    assert.equal(typeof rule.acceptsPath, 'function', rule.hostname);
  }
  const github = outputPolicy.APPROVED_USER_FACING_URLS[0];
  assert.equal(github.acceptsPath(`/${OFFICIAL_REPOSITORY}/releases/tag/v1.1.1`), true);
  assert.equal(github.acceptsPath(`/${OFFICIAL_REPOSITORY}/releases/tag/v1.1.2`), false);
});

test('stable release tags parse as they do today', () => {
  assert.ok(RELEASE_TAG_CASES.length >= 40);
  for (const [tag, expected] of RELEASE_TAG_CASES) {
    assert.deepEqual(release.parseStableSemver(tag), expected, JSON.stringify(tag));
  }
  for (const value of [undefined, null, 0, 123]) assert.equal(release.parseStableSemver(value), null, String(value));
});

function validateOutcome(url, repository, tag) {
  try {
    return { href: release.validateReleaseUrl(url, repository, tag) };
  } catch (error) {
    assert.ok(error instanceof release.ReleaseAnnouncementError, url);
    return { code: error.code, message: error.message };
  }
}

test('release page URLs are accepted, rewritten or refused as they are today', () => {
  assert.equal(release.DEFAULT_REPOSITORY, OFFICIAL_REPOSITORY);
  const official = release.parseRepository(release.DEFAULT_REPOSITORY);
  assert.ok(RELEASE_URL_CASES.length >= 30);
  for (const [url, tag, expected] of RELEASE_URL_CASES) {
    assert.deepEqual(validateOutcome(url, official, tag), expected, `${url} ${tag}`);
  }
  // The repository is a parameter: the same checks hold against another one.
  for (const [url, tag, expected] of OTHER_REPOSITORY_URL_CASES) {
    assert.deepEqual(validateOutcome(url, OTHER_REPOSITORY, tag), expected, `${url} ${tag}`);
  }
  assert.deepEqual(validateOutcome(undefined, official, 'v1.1.2'), { code: 'RELEASE_INVALID', message: 'Release URL is invalid.' });
});

test('the release notice is built exactly as today', () => {
  for (const [delivery, expected] of RELEASE_MESSAGE_CASES) {
    const label = `${delivery.tag_name} ${delivery.html_url} ${delivery.published_at}`;
    if (expected.message) {
      const message = release.buildReleaseMessage({ ...delivery });
      assert.deepEqual(JSON.parse(JSON.stringify(message)), expected.message, label);
      continue;
    }
    assert.throws(() => release.buildReleaseMessage({ ...delivery }), (error) => {
      assert.equal(error.name, expected.error.name, label);
      assert.equal(error.code ?? null, expected.error.code, label);
      assert.equal(error.message, expected.error.message, label);
      return true;
    }, label);
  }
});

test('the release service keeps the exports the notice and the scheduler use', () => {
  for (const name of [
    'DEFAULT_REPOSITORY', 'ReleaseAnnouncementError', 'buildReleaseMessage', 'normalizeRelease',
    'parseRepository', 'parseStableSemver', 'validateReleaseUrl',
  ]) {
    assert.ok(Object.hasOwn(release, name), name);
  }
});
