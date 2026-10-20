const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retainedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-poll-test-')));
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
    // Each fake poll is made by its own member, so the per-member limit does not get in the way.
    guildId: 'guild-1', channelId: 'channel-1', user: { id: `creator-${messageId}` }, client,
    deferReply: async () => {},
    editReply: async (payload) => {
      edits.push(payload);
      return { id: messageId };
    },
    reply: async (payload) => replies.push(payload),
  };
  // A button press carries the guild and the message the button sits on, as Discord sends them.
  const voteInteraction = (userId, overrides = {}) => ({
    customId: `poll:${messageId}:1`, guildId: 'guild-1', message: { id: messageId }, user: { id: userId }, client,
    update: async (payload) => edits.push(payload),
    reply: async (payload) => replies.push(payload),
    ...overrides,
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

test('every scheduled poll close runs as its own background job, never in the creating interaction', async (t) => {
  const { getHostOperationContext, runWithHostOperationContext } = require('../src/platform/hostOperationContext');
  const timers = [];
  t.mock.method(global, 'setTimeout', (callback) => {
    timers.push(callback);
    return { unref() {} };
  });
  t.mock.method(global, 'clearTimeout', () => {});
  const interactionContext = Object.freeze({ sourceEventId: '10000000000000030', hostPurpose: 'discord.interaction',
    publicEffectEventGrant: Object.freeze({ kind: 'synthetic-grant' }) });
  const closeContexts = [];
  const recordClose = (discord) => {
    const fetchChannel = discord.client.channels.fetch;
    discord.client.channels.fetch = async (...args) => {
      closeContexts.push(getHostOperationContext());
      return fetchChannel(...args);
    };
    return discord;
  };

  // A close fired later by its timer.
  const timed = recordClose(fakeDiscord('poll-3'));
  await runWithHostOperationContext(interactionContext, () =>
    createPoll(timed.createInteraction, { question: 'Tea?', options: ['Green', 'Black'], durationMinutes: 1 }));
  timers.at(-1)();
  await new Promise(setImmediate);

  // A close that is already due when polls are restored.
  const due = recordClose(fakeDiscord('poll-4'));
  await createPoll(due.createInteraction, { question: 'Coffee?', options: ['Hot', 'Iced'], durationMinutes: 1 });
  const dueAt = readPolls()['poll-4'].endsAt;
  t.mock.method(Date, 'now', () => dueAt + 1);
  await runWithHostOperationContext(interactionContext, () => restoreActivePolls(due.client));
  await new Promise(setImmediate);

  assert.equal(closeContexts.length, 2);
  for (const context of closeContexts) {
    assert.deepEqual(Object.keys(context).sort(), ['hostPurpose', 'scope', 'sourceEventId', 'startedAtMs']);
    assert.equal(context.hostPurpose, 'background.poll.end');
    assert.equal(context.scope, 'background:poll.end');
    assert.ok(Number.isSafeInteger(context.startedAtMs));
  }
  assert.notEqual(closeContexts[0].sourceEventId, closeContexts[1].sourceEventId);
  // The restored close started while the clock read just past the poll's end.
  assert.equal(closeContexts[1].startedAtMs, dueAt + 1);
  assert.ok(readPolls()['poll-3'].endedAt);
  assert.ok(readPolls()['poll-4'].endedAt);
});

const { retainedDataFile } = require('../src/platform/retainedDataSource');
const DAY = 86_400_000;

function captureTimers(t) {
  const timers = [];
  t.mock.method(global, 'setTimeout', (callback) => {
    timers.push(callback);
    return { unref() {} };
  });
  t.mock.method(global, 'clearTimeout', () => {});
  return timers;
}

test('a button is refused unless it sits on the poll message of the same server', async (t) => {
  captureTimers(t);
  const discord = fakeDiscord('poll-scope-1');
  await createPoll(discord.createInteraction, { question: 'Scope?', options: ['A', 'B'], durationMinutes: 5 });

  await handlePollButton(discord.voteInteraction('other-server-voter', { guildId: 'guild-2' }));
  await handlePollButton(discord.voteInteraction('other-message-voter', { message: { id: 'poll-scope-other' } }));
  await handlePollButton(discord.voteInteraction('no-message-voter', { message: undefined }));
  assert.deepEqual(readPolls()['poll-scope-1'].votes, {});
  assert.equal(discord.replies.length, 3);
  for (const reply of discord.replies) {
    assert.equal(reply.ephemeral, true);
    assert.match(reply.content, /找不到這個投票/u);
  }

  await handlePollButton(discord.voteInteraction('member'));
  assert.deepEqual(readPolls()['poll-scope-1'].votes, { member: 1 });
});

test('a failed write leaves the earlier poll file whole and no temporary file behind', async (t) => {
  captureTimers(t);
  const discord = fakeDiscord('poll-atomic-1');
  await createPoll(discord.createInteraction, { question: 'Atomic?', options: ['A', 'B'], durationMinutes: 5 });
  await handlePollButton(discord.voteInteraction('voter-before'));
  const pollsPath = retainedDataFile('polls.json');
  const before = fs.readFileSync(pollsPath, 'utf8');

  // The disk fails after a part of the new content went out.
  const realWrite = fs.writeFileSync;
  const failingWrite = t.mock.method(fs, 'writeFileSync', (target, data, ...rest) => {
    realWrite(target, String(data).slice(0, 20), ...rest);
    throw new Error('disk gone');
  });
  await assert.rejects(() => handlePollButton(discord.voteInteraction('voter-after')), /disk gone/u);
  failingWrite.mock.restore();

  assert.equal(fs.readFileSync(pollsPath, 'utf8'), before);
  assert.deepEqual(readPolls()['poll-atomic-1'].votes, { 'voter-before': 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(pollsPath)).filter((name) => name.endsWith('.tmp')), []);
});

test('a server cannot have more than 20 polls open at once, and a closed poll frees a place', async (t) => {
  const timers = captureTimers(t);
  const open = async (messageId, guildId) => {
    const discord = fakeDiscord(messageId);
    discord.createInteraction.guildId = guildId;
    await createPoll(discord.createInteraction, { question: 'Cap?', options: ['A', 'B'], durationMinutes: 5 });
    return discord;
  };
  for (let index = 0; index < 20; index += 1) await open(`cap-${index}`, 'guild-cap');

  const refused = await open('cap-refused', 'guild-cap');
  assert.equal(readPolls()['cap-refused'], undefined);
  assert.equal(refused.edits.length, 0, 'no poll message is created');
  assert.equal(refused.replies.length, 1);
  assert.equal(refused.replies[0].ephemeral, true);
  assert.match(refused.replies[0].content, /20/u);

  // Another server is not affected.
  await open('cap-other-server', 'guild-cap-other');
  assert.ok(readPolls()['cap-other-server']);

  // The timers were armed in creation order: the first one closes the first poll.
  timers[0]();
  await new Promise(setImmediate);
  assert.ok(readPolls()['cap-0'].endedAt);
  await open('cap-again', 'guild-cap');
  assert.ok(readPolls()['cap-again']);
});

test('polls that are being created at the same moment still stay within the limit', async (t) => {
  captureTimers(t);
  const attempts = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
    const discord = fakeDiscord(`race-${index}`);
    discord.createInteraction.guildId = 'guild-race';
    discord.createInteraction.deferReply = () => new Promise(setImmediate);
    await createPoll(discord.createInteraction, { question: 'Race?', options: ['A', 'B'], durationMinutes: 5 });
    return discord;
  }));

  assert.equal(Object.values(readPolls()).filter((poll) => poll.guildId === 'guild-race').length, 20);
  assert.equal(attempts.filter((discord) => discord.replies.length === 1).length, 5);
});

test('a write drops polls that ended more than 7 days ago and keeps the others', async (t) => {
  captureTimers(t);
  const now = Date.now();
  const base = {
    guildId: 'guild-clean', channelId: 'channel-1', question: 'Old?', options: ['A', 'B'], votes: {},
    createdBy: 'creator', createdAt: now - 20 * DAY,
  };
  const pollsPath = retainedDataFile('polls.json');
  fs.writeFileSync(pollsPath, `${JSON.stringify({
    ...readPolls(),
    'clean-old': { ...base, messageId: 'clean-old', endsAt: now - 9 * DAY, endedAt: now - 8 * DAY },
    'clean-recent': { ...base, messageId: 'clean-recent', endsAt: now - 7 * DAY, endedAt: now - 6 * DAY },
    'clean-unended': { ...base, messageId: 'clean-unended', endsAt: now - 9 * DAY, endedAt: null },
  }, null, 2)}\n`, 'utf8');

  const discord = fakeDiscord('clean-new');
  discord.createInteraction.guildId = 'guild-clean';
  await createPoll(discord.createInteraction, { question: 'New?', options: ['A', 'B'], durationMinutes: 5 });

  const stored = readPolls();
  assert.equal(stored['clean-old'], undefined);
  assert.ok(stored['clean-recent']);
  assert.ok(stored['clean-unended'], 'a poll that was never closed is left for the restore to close');
  assert.ok(stored['clean-new']);
});

// One member opening polls: each poll gets its own message id and may be in another server.
function memberPollOpener(memberId) {
  return async (messageId, guildId = 'guild-member-cap', overrides = {}) => {
    const discord = fakeDiscord(messageId);
    discord.createInteraction.guildId = guildId;
    discord.createInteraction.user = { id: memberId };
    Object.assign(discord.createInteraction, overrides);
    await createPoll(discord.createInteraction, { question: 'Mine?', options: ['A', 'B'], durationMinutes: 1440 });
    return discord;
  };
}

test('one member cannot have more than 3 polls open at once, in any server, and a closed poll frees a place', async (t) => {
  const timers = captureTimers(t);
  const open = memberPollOpener('member-limit');
  await open('member-1', 'guild-member-a');
  await open('member-2', 'guild-member-a');
  await open('member-3', 'guild-member-b');
  assert.equal(Object.values(readPolls()).filter((poll) => poll.createdBy === 'member-limit').length, 3);

  const refused = await open('member-4', 'guild-member-c');
  assert.equal(readPolls()['member-4'], undefined);
  assert.equal(refused.edits.length, 0, 'no poll message is created');
  assert.equal(refused.replies.length, 1);
  assert.equal(refused.replies[0].ephemeral, true);
  assert.match(refused.replies[0].content, /3 個/u);
  assert.match(refused.replies[0].content, /結束/u);

  // Another member can still open one in the same server.
  const other = await memberPollOpener('member-other')('member-other-1', 'guild-member-a');
  assert.equal(other.replies.length, 0);
  assert.ok(readPolls()['member-other-1']);

  // The timers were armed in creation order: the first one closes the member's first poll.
  timers[0]();
  await new Promise(setImmediate);
  assert.ok(readPolls()['member-1'].endedAt);
  await open('member-5', 'guild-member-c');
  assert.ok(readPolls()['member-5']);
});

test('polls one member creates at the same moment still stay within 3', async (t) => {
  captureTimers(t);
  const open = memberPollOpener('member-burst');
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) => open(
    `burst-${index}`, 'guild-member-burst', { deferReply: () => new Promise(setImmediate) },
  )));

  assert.equal(Object.values(readPolls()).filter((poll) => poll.createdBy === 'member-burst').length, 3);
  assert.equal(attempts.filter((discord) => discord.replies.length === 1).length, 7);
});

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

function pretendPlatform(t, platform) {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', REAL_PLATFORM));
}

// A poll with one vote on file, and the file text and temporary file listing to compare afterwards.
async function pollWithOneVote(messageId) {
  const discord = fakeDiscord(messageId);
  await createPoll(discord.createInteraction, { question: 'Locked?', options: ['A', 'B'], durationMinutes: 5 });
  await handlePollButton(discord.voteInteraction('voter-before'));
  const pollsPath = retainedDataFile('polls.json');
  const temporaryFiles = () => fs.readdirSync(path.dirname(pollsPath)).filter((name) => name.endsWith('.tmp'));
  return { discord, pollsPath, before: fs.readFileSync(pollsPath, 'utf8'), temporaryFiles };
}

function failingRenames(t, { failures, code }) {
  const realRename = fs.renameSync;
  const state = { calls: 0, delays: [] };
  t.mock.method(fs, 'renameSync', (from, to) => {
    state.calls += 1;
    if (state.calls <= failures) throw Object.assign(new Error('file is locked'), { code });
    return realRename(from, to);
  });
  // The waits are recorded instead of slept.
  t.mock.method(Atomics, 'wait', (_array, _index, _value, milliseconds) => {
    state.delays.push(milliseconds);
    return 'timed-out';
  });
  return state;
}

test('a vote survives a scanner holding the poll file for a moment on Windows', async (t) => {
  captureTimers(t);
  const { discord, pollsPath, temporaryFiles } = await pollWithOneVote('poll-locked-1');
  pretendPlatform(t, 'win32');
  const renames = failingRenames(t, { failures: 3, code: 'EPERM' });

  await handlePollButton(discord.voteInteraction('voter-after'));

  assert.equal(renames.calls, 4);
  assert.deepEqual(renames.delays, [25, 50, 100]);
  assert.deepEqual(readPolls()['poll-locked-1'].votes, { 'voter-before': 1, 'voter-after': 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(pollsPath, 'utf8'))['poll-locked-1'].votes,
    { 'voter-before': 1, 'voter-after': 1 });
  assert.deepEqual(temporaryFiles(), []);
});

test('a poll file that stays locked fails after bounded retries and leaves the file whole', async (t) => {
  captureTimers(t);
  const { discord, pollsPath, before, temporaryFiles } = await pollWithOneVote('poll-locked-2');
  pretendPlatform(t, 'win32');
  const renames = failingRenames(t, { failures: Infinity, code: 'EBUSY' });

  await assert.rejects(() => handlePollButton(discord.voteInteraction('voter-after')), { code: 'EBUSY' });

  assert.equal(renames.calls, 8);
  assert.deepEqual(renames.delays, [25, 50, 100, 200, 400, 800, 1000]);
  assert.equal(fs.readFileSync(pollsPath, 'utf8'), before);
  assert.deepEqual(temporaryFiles(), []);
});

for (const [name, platform, code] of [
  ['a write failure that is not a lock', 'win32', 'ENOSPC'],
  ['a lock code off Windows', 'linux', 'EPERM'],
]) {
  test(`${name} is not retried`, async (t) => {
    captureTimers(t);
    const { discord, pollsPath, before, temporaryFiles } = await pollWithOneVote(`poll-locked-${code}`);
    pretendPlatform(t, platform);
    const renames = failingRenames(t, { failures: Infinity, code });

    await assert.rejects(() => handlePollButton(discord.voteInteraction('voter-after')), { code });

    assert.equal(renames.calls, 1);
    assert.deepEqual(renames.delays, []);
    assert.equal(fs.readFileSync(pollsPath, 'utf8'), before);
    assert.deepEqual(temporaryFiles(), []);
  });
}
