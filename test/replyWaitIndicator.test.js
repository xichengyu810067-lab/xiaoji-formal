const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LONG_WAIT_AFTER_MS,
  LONG_WAIT_TEXT,
  THINKING_DELAY_MS,
  THINKING_TEXT,
  UNANSWERED_TEXT,
  startReplyWaitIndicator,
} = require('../src/systems/conversation/replyWaitIndicator');

const NO_MENTIONS = { parse: [], users: [], roles: [], repliedUser: false };

// Manual timers: the test moves time forward.
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  let now = 0;
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { fn, due: now + ms });
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending].sort((a, b) => a[1].due - b[1].due)) {
        if (entry.due > now) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A message whose reply returns a placeholder that records its edits.
function fakeMessage({ replyFails = false, editFails = false } = {}) {
  const calls = { replies: [], edits: [] };
  const placeholderMessage = {
    async edit(payload) {
      if (editFails) throw Object.assign(new Error('gone'), { code: 10008 });
      calls.edits.push(payload);
      return placeholderMessage;
    },
  };
  return {
    calls,
    placeholderMessage,
    message: {
      async reply(payload) {
        if (replyFails) throw Object.assign(new Error('refused'), { code: 'EGRESS_RATE_LIMITED' });
        calls.replies.push(payload);
        return placeholderMessage;
      },
    },
  };
}

test('the thinking placeholder follows almost at once, without mentions', async () => {
  assert.ok(THINKING_DELAY_MS <= 2_000, 'the member sees it almost at once');
  const clock = fakeTimers();
  const { message, calls, placeholderMessage } = fakeMessage();
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  await flush();
  assert.deepEqual(calls.replies, [], 'nothing before the short delay');
  clock.advance(THINKING_DELAY_MS);
  assert.equal(await indicator.placeholder, placeholderMessage);
  assert.deepEqual(calls.replies, [{ content: THINKING_TEXT, allowedMentions: NO_MENTIONS }]);
  assert.equal(await indicator.takePlaceholder(), placeholderMessage);
});

test('a request that ends within the delay sends no placeholder (a refused flood stays silent)', async () => {
  const clock = fakeTimers();
  const { message, calls } = fakeMessage();
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS - 500);
  indicator.stop();
  await indicator.finish();
  clock.advance(LONG_WAIT_AFTER_MS * 2);
  await flush();
  assert.deepEqual(calls.replies, []);
  assert.deepEqual(calls.edits, []);
  assert.equal(await indicator.placeholder, null);
  assert.equal(clock.size, 0);
});

test('an answer within the delay is sent as a normal reply', async () => {
  const clock = fakeTimers();
  const { message, calls } = fakeMessage();
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  assert.equal(await indicator.takePlaceholder(), null);
  clock.advance(THINKING_DELAY_MS);
  await flush();
  assert.deepEqual(calls.replies, [], 'no late placeholder after the answer');
});

test('the long-wait notice comes after one minute and edits the placeholder', async () => {
  assert.equal(LONG_WAIT_AFTER_MS, 60_000);
  const clock = fakeTimers();
  const { message, calls, placeholderMessage } = fakeMessage();
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS);
  await flush();
  clock.advance(LONG_WAIT_AFTER_MS);
  await flush();
  assert.deepEqual(calls.edits, [{ content: LONG_WAIT_TEXT, allowedMentions: NO_MENTIONS }]);
  assert.equal(calls.replies.length, 1, 'the notice edits; it sends no new message');
  // The answer can still take the placeholder afterwards.
  assert.equal(await indicator.takePlaceholder(), placeholderMessage);
});

test('a placeholder taken by the answer gets no later notice', async () => {
  const clock = fakeTimers();
  const { message, calls } = fakeMessage();
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS);
  assert.ok(await indicator.takePlaceholder());
  assert.equal(clock.size, 0, 'taking the placeholder ends the long-wait timer');
  await indicator.finish();
  assert.deepEqual(calls.edits, [], 'finish leaves a taken placeholder alone');
  assert.equal(await indicator.takePlaceholder(), null, 'the placeholder is taken only once');
});

test('a request that ends with no reply says so in the placeholder', async () => {
  const clock = fakeTimers();
  const { message, calls } = fakeMessage();
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS);
  await flush();
  await indicator.finish();
  assert.deepEqual(calls.edits, [{ content: UNANSWERED_TEXT, allowedMentions: NO_MENTIONS }]);
  assert.equal(clock.size, 0);
  assert.equal(await indicator.takePlaceholder(), null, 'a finished placeholder is not taken');
  await indicator.finish();
  assert.equal(calls.edits.length, 1, 'finish edits once');
});

test('a placeholder that could not be sent is null and nothing throws', async () => {
  const clock = fakeTimers();
  const { message, calls } = fakeMessage({ replyFails: true });
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS);
  assert.equal(await indicator.placeholder, null);
  clock.advance(LONG_WAIT_AFTER_MS);
  await indicator.finish();
  assert.deepEqual(calls.edits, []);
  assert.equal(await indicator.takePlaceholder(), null);
});

test('a failed notice edit is dropped quietly', async () => {
  const clock = fakeTimers();
  const { message } = fakeMessage({ editFails: true });
  const indicator = startReplyWaitIndicator(message, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS);
  await flush();
  clock.advance(LONG_WAIT_AFTER_MS);
  await flush();
  await indicator.finish();
});

test('a message that cannot be replied to gets no placeholder', async () => {
  const clock = fakeTimers();
  const indicator = startReplyWaitIndicator({}, { timers: clock.timers });
  clock.advance(THINKING_DELAY_MS);
  assert.equal(await indicator.placeholder, null);
  await indicator.finish();
});
