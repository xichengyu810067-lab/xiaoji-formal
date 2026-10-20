'use strict';

// What members read in the public posts of the daily riddle and the daily discussion: no internal publish or answer ID
// in the footer. The stable markers stay in the event row as an internal key; a post that was sent but not yet recorded
// is still found again by its footer, and so is one that an earlier version sent with the stable marker as its footer.
// Only fake Discord objects and a synthetic database in a temporary directory are used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-daily-public-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
} = require('../src/services/coinDatabase');
const riddleService = require('../src/services/dailyRiddleService');
const discussionService = require('../src/services/dailyDiscussionService');
const { riddles } = require('../src/services/dailyRiddleCorpus');

const LOCAL_DATE = '2026-09-30';
// Taipei 11:00 and 09:00, inside the publish window of the riddle and of the discussion.
const RIDDLE_NOW = new Date('2026-09-30T03:00:00.000Z');
const DISCUSSION_NOW = new Date('2026-09-30T01:00:00.000Z');

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// A parent channel that keeps what it was sent and hands it back as its history, newest first.
function createPublishFixture(prefix, now) {
  const sent = [];
  const history = [];
  const threadId = `${prefix}-thread`;
  const thread = { id: threadId, messages: { fetch: async () => [] }, send: async () => ({ id: `${prefix}-answer` }) };
  const parentId = `${prefix}-parent`;
  const parent = {
    id: parentId,
    messages: { fetch: async () => [...sent].reverse().concat(history) },
    async send(payload) {
      const message = {
        id: `${prefix}-announcement-${sent.length + 1}`,
        payload,
        author: { id: 'bot' },
        createdAt: now,
        embeds: payload.embeds,
        async startThread() { return thread; },
      };
      sent.push(message);
      return message;
    },
  };
  const guildId = `${prefix}-guild`;
  const guild = { id: guildId, channels: { cache: new Map([[parentId, parent], [threadId, thread]]),
    fetch: async (id) => (id === parentId ? parent : id === threadId ? thread : null) } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild]]) }, channels: { cache: new Map() } };
  return { client, sent, history, guildId, parentId };
}

const footerOf = (payload) => payload.embeds[0].toJSON().footer.text;

// ---- the public posts carry no internal ID --------------------------------------------------------------------------

test('the public daily riddle post and its answer carry a plain footer, not the internal publish or answer ID', async () => {
  const fixture = createPublishFixture('riddle-footer', RIDDLE_NOW);
  const claimed = await riddleService.claimDailyRiddleEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: RIDDLE_NOW,
  });
  const event = await riddleService.publishDailyRiddle(fixture.client, claimed.event, {
    now: RIDDLE_NOW, leaseOwner: claimed.leaseOwner,
  });

  assert.match(event.status, /^published/u);
  assert.equal(fixture.sent.length, 1);
  assert.equal(footerOf(fixture.sent[0].payload), `每日猜謎・${LOCAL_DATE}`);
  assert.doesNotMatch(JSON.stringify(fixture.sent[0].payload), /:publish:|:answer:|xiaoji-daily/u);

  const answer = riddleService.buildAnswerEmbed(event, riddles.find((riddle) => riddle.id === event.riddleId));
  assert.equal(answer.toJSON().footer.text, `每日猜謎解答・${LOCAL_DATE}`);
  assert.doesNotMatch(JSON.stringify(answer.toJSON()), /:publish:|:answer:|xiaoji-daily/u);

  // The internal keys are still kept in the event row.
  assert.match(event.publishMarker, /^xiaoji-daily-riddle:publish:/u);
  assert.match(event.answerMarker, /^xiaoji-daily-riddle:answer:/u);
});

test('the public daily discussion post carries a plain footer, not the internal publish ID', async () => {
  const fixture = createPublishFixture('discussion-footer', DISCUSSION_NOW);
  const claimed = await discussionService.claimDailyDiscussionEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: DISCUSSION_NOW,
  });
  const event = await discussionService.publishDailyDiscussion(fixture.client, claimed.event, {
    now: DISCUSSION_NOW, leaseOwner: claimed.leaseOwner,
  });

  assert.match(event.status, /^published/u);
  assert.equal(fixture.sent.length, 1);
  assert.equal(footerOf(fixture.sent[0].payload), `每日議題・${LOCAL_DATE}`);
  assert.doesNotMatch(JSON.stringify(fixture.sent[0].payload), /:publish:|xiaoji-daily/u);
  assert.match(event.publishMarker, /^xiaoji-daily-discussion:publish:/u);
});

// ---- a post that was sent but not recorded is found again -----------------------------------------------------------

test('a daily riddle post that was sent but not recorded is found again by its footer, and sent once', async () => {
  const fixture = createPublishFixture('riddle-retry', RIDDLE_NOW);
  const claimed = await riddleService.claimDailyRiddleEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: RIDDLE_NOW,
  });
  const options = { now: RIDDLE_NOW, leaseOwner: claimed.leaseOwner };

  await assert.rejects(
    riddleService.publishDailyRiddle(fixture.client, claimed.event, {
      ...options, afterPublishSend: async () => { throw new Error('synthetic crash after the post was sent'); },
    }),
    /synthetic crash/u,
  );
  assert.equal(fixture.sent.length, 1);

  const event = await riddleService.publishDailyRiddle(fixture.client, claimed.event, options);
  assert.equal(fixture.sent.length, 1, 'the retry must not post the question a second time');
  assert.equal(event.announcementMessageId, fixture.sent[0].id);
  assert.match(event.status, /^published/u);
});

test('a daily riddle post that an earlier version sent with the stable marker as its footer is still found', async () => {
  const fixture = createPublishFixture('riddle-legacy', RIDDLE_NOW);
  const claimed = await riddleService.claimDailyRiddleEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: RIDDLE_NOW,
  });
  fixture.history.push({
    id: 'riddle-legacy-old-post',
    author: { id: 'bot' },
    createdAt: RIDDLE_NOW,
    embeds: [{ data: { footer: { text: claimed.event.publishMarker } } }],
    async startThread() { return { id: 'riddle-legacy-thread' }; },
  });

  const event = await riddleService.publishDailyRiddle(fixture.client, claimed.event, {
    now: RIDDLE_NOW, leaseOwner: claimed.leaseOwner,
  });

  assert.equal(fixture.sent.length, 0, 'the old post must be reused, not posted again');
  assert.equal(event.announcementMessageId, 'riddle-legacy-old-post');
});

test('a daily discussion post that was sent but not recorded is found again by its footer, and sent once', async () => {
  const fixture = createPublishFixture('discussion-retry', DISCUSSION_NOW);
  const claimed = await discussionService.claimDailyDiscussionEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: DISCUSSION_NOW,
  });
  const options = { now: DISCUSSION_NOW, leaseOwner: claimed.leaseOwner };

  await assert.rejects(
    discussionService.publishDailyDiscussion(fixture.client, claimed.event, {
      ...options, afterPublishSend: async () => { throw new Error('synthetic crash after the post was sent'); },
    }),
    /synthetic crash/u,
  );
  assert.equal(fixture.sent.length, 1);

  const event = await discussionService.publishDailyDiscussion(fixture.client, claimed.event, options);
  assert.equal(fixture.sent.length, 1, 'the retry must not post the topic a second time');
  assert.equal(event.announcementMessageId, fixture.sent[0].id);
});

test('a daily discussion post that an earlier version sent with the stable marker as its footer is still found', async () => {
  const fixture = createPublishFixture('discussion-legacy', DISCUSSION_NOW);
  const claimed = await discussionService.claimDailyDiscussionEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: DISCUSSION_NOW,
  });
  fixture.history.push({
    id: 'discussion-legacy-old-post',
    author: { id: 'bot' },
    createdAt: DISCUSSION_NOW,
    embeds: [{ data: { footer: { text: claimed.event.publishMarker } } }],
    async startThread() { return { id: 'discussion-legacy-thread' }; },
  });

  const event = await discussionService.publishDailyDiscussion(fixture.client, claimed.event, {
    now: DISCUSSION_NOW, leaseOwner: claimed.leaseOwner,
  });

  assert.equal(fixture.sent.length, 0, 'the old post must be reused, not posted again');
  assert.equal(event.announcementMessageId, 'discussion-legacy-old-post');
});
