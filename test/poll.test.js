const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retainedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-poll-test-'));
require('../src/platform/retainedDataSource').configureRetainedDataSourceRoot(retainedRoot);
const servicePath = require.resolve('../src/services/pollService');
let { createPoll, getPollCounts, handlePollButton, readPolls, restoreActivePolls, validatePollInput } = require(servicePath);

test.after(() => fs.rmSync(retainedRoot, { recursive: true, force: true }));

function fakeDiscord(messageId = 'poll-1', failEdit = false) {
  const edits = [];
  const replies = [];
  const client = {
    channels: {
      fetch: async () => ({
        messages: {
          fetch: async () => ({
            edit: async (payload) => {
              if (failEdit) throw new Error('message unavailable');
              edits.push(payload);
            },
          }),
        },
      }),
    },
  };
  const createInteraction = {
    guildId: 'guild-1', channelId: 'channel-1', user: { id: 'creator' }, client,
    deferReply: async () => {},
    editReply: async (payload) => {
      edits.push(payload);
      return { id: messageId };
    },
  };
  const voteInteraction = (userId) => ({
    customId: `poll:${messageId}:1`, user: { id: userId }, client,
    update: async (payload) => edits.push(payload),
    reply: async (payload) => replies.push(payload),
  });
  return { client, createInteraction, edits, replies, voteInteraction };
}

test('validatePollInput accepts a normal poll', () => {
  const result = validatePollInput('Lunch?', ['Rice', 'Noodles'], 10);
  assert.equal(result.ok, true);
  assert.deepEqual(result.options, ['Rice', 'Noodles']);
});

test('validatePollInput rejects duplicate options', () => {
  const result = validatePollInput('Lunch?', ['Rice', 'rice'], 10);
  assert.equal(result.ok, false);
});

test('getPollCounts counts one vote per user', () => {
  const counts = getPollCounts({
    options: ['A', 'B', 'C'],
    votes: {
      user1: 0,
      user2: 1,
      user3: 1,
    },
  });

  assert.deepEqual(counts, [1, 2, 0]);
});

test('original timer closes the latest voted poll, and repeated or late actions preserve votes', async (t) => {
  const timers = [];
  t.mock.method(global, 'setTimeout', (callback) => {
    timers.push(callback);
    return { unref() {} };
  });
  t.mock.method(global, 'clearTimeout', () => {});
  const discord = fakeDiscord();
  await createPoll(discord.createInteraction, { question: 'Lunch?', options: ['Rice', 'Noodles'], durationMinutes: 1 });
  assert.equal(timers.length, 1);
  await handlePollButton(discord.voteInteraction('voter-1'));
  assert.deepEqual(readPolls()['poll-1'].votes, { 'voter-1': 1 });

  timers[0]();
  await new Promise(setImmediate);
  const ended = readPolls()['poll-1'];
  assert.deepEqual(ended.votes, { 'voter-1': 1 });
  assert.ok(ended.endedAt);
  assert.match(discord.edits.at(-1).embeds[0].data.footer.text, /總票數：1/);
  assert.equal(discord.edits.at(-1).components[0].components[0].data.disabled, true);

  timers[0]();
  await handlePollButton(discord.voteInteraction('late-voter'));
  assert.equal(readPolls()['poll-1'].endedAt, ended.endedAt);
  assert.deepEqual(readPolls()['poll-1'].votes, { 'voter-1': 1 });
  assert.match(discord.replies.at(-1).content, /已經結束/);
});

test('restart restores the timer and keeps votes when message edit fails', async (t) => {
  const timers = [];
  t.mock.method(global, 'setTimeout', (callback) => {
    timers.push(callback);
    return { unref() {} };
  });
  t.mock.method(global, 'clearTimeout', () => {});
  const discord = fakeDiscord('poll-2', true);
  await createPoll(discord.createInteraction, { question: 'Dinner?', options: ['Rice', 'Noodles'], durationMinutes: 1 });
  await handlePollButton(discord.voteInteraction('voter-2'));

  delete require.cache[servicePath];
  ({ restoreActivePolls, readPolls } = require(servicePath));
  await restoreActivePolls(discord.client);
  assert.equal(timers.length, 2);
  timers[1]();
  await new Promise(setImmediate);
  assert.deepEqual(readPolls()['poll-2'].votes, { 'voter-2': 1 });
  assert.ok(readPolls()['poll-2'].endedAt);
});
