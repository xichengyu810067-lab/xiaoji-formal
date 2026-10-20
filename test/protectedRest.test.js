'use strict';

// The protected channel of client.rest (src/platform/protectedRest.js), on a real
// @discordjs/rest REST whose makeRequest is synthetic: nothing here reaches the network.

const assert = require('node:assert/strict');
const test = require('node:test');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord.js');
const { createTestControlEgress } = require('../src/platform/testControlEgress');
const { createReporter } = require('../src/platform/testControlPolicy');
const { getHostOperationContext } = require('../src/platform/hostOperationContext');
const {
  RESPONSE_RESERVE_MS,
  currentProtectedAttempt,
  installProtectedRest,
  outcomeCode,
  outcomeResult,
  responseReserveFor,
  runOutsideProtectedAttempt,
} = require('../src/platform/protectedRest');

const CHANNEL_ID = '100000000000000001';
const OWNER_ID = '100000000000000002';
const MESSAGES = Routes.channelMessages(CHANNEL_ID);
const POST_MESSAGE = Object.freeze({ method: 'POST', fullRoute: MESSAGES, body: { content: 'synthetic' } });

function response(status, body = { message: 'synthetic' }, headers = {}) {
  if (status === 204) return new Response(null, { status, headers });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function abortError() {
  return Object.assign(new Error('synthetic abort'), { name: 'AbortError' });
}

// Waits for the abort of the request's own signal; never answers otherwise.
function never(init, onAbort = () => {}) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      onAbort();
      reject(abortError());
    }, { once: true });
  });
}

function createRest(makeRequest, options = {}) {
  return new REST({ retries: 0, timeout: 5_000, makeRequest, ...options }).setToken('synthetic-token');
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function counting(handler) {
  const state = { calls: 0 };
  state.makeRequest = async (url, init) => {
    state.calls += 1;
    return handler(url, init, state.calls);
  };
  return state;
}

test('a protected attempt reaches the transport at most once, whatever REST retries says', async () => {
  const scenarios = [
    ['503', () => response(503), { kind: 'unknown', reason: 'server_error', httpStatus: 503 }],
    ['429', () => response(429, { message: 'rate limited', retry_after: 0.001 }, { 'retry-after': '0.001' }),
      { kind: 'rejected', reason: 'rate_limited', httpStatus: 429 }],
    ['reset', () => { throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }); },
      { kind: 'unknown', reason: 'network', httpStatus: null }],
    ['timeout', (_url, init) => never(init), { kind: 'unknown', reason: 'timeout', httpStatus: null }],
  ];
  for (const retries of [0, 3]) {
    for (const [name, handler, expected] of scenarios) {
      const lower = counting(handler);
      let entries = 0;
      const rest = createRest(lower.makeRequest, { retries, timeout: 20 });
      const outcome = await installProtectedRest(rest).send(POST_MESSAGE, {
        deadlineMs: 2_000, onNetworkEntry: () => { entries += 1; } });
      const label = `retries=${retries} ${name}`;
      assert.equal(lower.calls, 1, label);
      assert.equal(entries, 1, label);
      assert.deepEqual({ kind: outcome.kind, reason: outcome.reason, httpStatus: outcome.httpStatus }, expected, label);
      assert.equal(outcome.entered, true, label);
    }
  }
});

test('with REST retries, a known limit met by a retry inside discord.js never turns a 5xx, a reset, or a timeout into a 429',
  async () => {
    const scenarios = [
      ['503', () => response(503), 'server_error', 503],
      ['reset', () => { throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }); }, 'network', null],
      ['timeout', (_url, init) => never(init), 'timeout', null],
    ];
    for (const [name, answerWith, reason, httpStatus] of scenarios) {
      let rest = null;
      const lower = counting(async (url, init) => {
        // The REST's global window is spent as the first answer comes back, so the retry
        // discord.js makes after it meets a known limit and asks the rate-limit filter.
        rest.globalRemaining = 0;
        rest.globalReset = Date.now() + 300;
        return answerWith(url, init);
      });
      rest = createRest(lower.makeRequest, { retries: 3, timeout: 20 });
      const channel = installProtectedRest(rest);
      const filter = rest.options.rejectOnRateLimit;
      let asked = 0;
      rest.options.rejectOnRateLimit = async (data) => {
        asked += 1;
        return filter(data);
      };
      const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 2_000 });
      assert.deepEqual([outcome.kind, outcome.reason, outcome.httpStatus, outcome.entered],
        ['unknown', reason, httpStatus, true], name);
      assert.equal(lower.calls, 1, name);
      assert.ok(asked >= 1, `${name}: the retry met the known limit`);
    }
  });

test('a protected request queued past its deadline is never sent, and leaves nothing unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    const lower = counting(async (_url, _init, call) => {
      if (call === 1) await blocker;
      return response(200, { id: '1' });
    });
    const rest = createRest(lower.makeRequest);
    const channel = installProtectedRest(rest);
    const first = rest.post(MESSAGES, { body: { content: 'ordinary' } });
    await tick(5);
    let entries = 0;
    const started = performance.now();
    const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 30, onNetworkEntry: () => { entries += 1; } });
    assert.ok(performance.now() - started < 1_000);
    assert.deepEqual([outcome.kind, outcome.reason, outcome.entered], ['not_sent', 'deadline', false]);
    release();
    assert.deepEqual(await first, { id: '1' });
    await tick(20);
    assert.equal(lower.calls, 1);
    assert.equal(entries, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a wait that ignores the abort signal ends at the gate: the late request is refused there', async () => {
  const lower = counting(async () => response(200, { id: '1' }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  // Stands for every wait above the gate that does not watch the signal (a wrapper, the
  // sublimit queue, a rate-limit sleep): the request moves on only after the deadline.
  const original = rest.request.bind(rest);
  let resumed = 0;
  rest.request = async (options) => {
    await tick(60);
    resumed += 1;
    return original(options);
  };
  let entries = 0;
  const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 15, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([outcome.kind, outcome.reason], ['not_sent', 'deadline']);
  await tick(120);
  assert.equal(resumed, 1);
  assert.equal(lower.calls, 0);
  assert.equal(entries, 0);
});

test('a request whose signal was aborted before it joined the queue is refused by the gate', async () => {
  // @sapphire/async-queue ignores a signal that is already aborted when the request joins
  // the queue, so discord.js calls makeRequest for it anyway; the gate refuses it.
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const lower = counting(async (_url, _init, call) => {
    if (call === 1) await blocker;
    return response(200, { id: '1' });
  });
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  const first = rest.post(MESSAGES, { body: { content: 'ordinary' } });
  await tick(5);
  // The deadline passes while resolveRequest has not yet reached the queue.
  const original = rest.request.bind(rest);
  rest.request = async (options) => {
    await tick(30);
    return original(options);
  };
  const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 10 });
  assert.deepEqual([outcome.kind, outcome.reason], ['not_sent', 'deadline']);
  await tick(40);
  release();
  await first;
  await tick(20);
  assert.equal(lower.calls, 1);
});

test('after the network, no answer by the deadline is unknown and the request is aborted', async () => {
  let aborted = 0;
  const lower = counting((_url, init) => never(init, () => { aborted += 1; }));
  const rest = createRest(lower.makeRequest);
  let entries = 0;
  const outcome = await installProtectedRest(rest).send(POST_MESSAGE, {
    deadlineMs: 300, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([outcome.kind, outcome.reason, outcome.entered], ['unknown', 'timeout', true]);
  assert.equal(entries, 1);
  await tick(10);
  assert.equal(aborted, 1);
  assert.equal(lower.calls, 1);
});

test('a bucket known to be spent is not_sent with its wait, before the network', async () => {
  const lower = counting(async () => response(200, { id: '1' }, {
    'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '5',
    'x-ratelimit-bucket': 'synthetic-bucket',
  }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  // The first answer names the bucket; the second, through the new bucket, spends it.
  await rest.post(MESSAGES, { body: { content: 'first' } });
  await rest.post(MESSAGES, { body: { content: 'second' } });
  let entries = 0;
  const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 1_000, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([outcome.kind, outcome.reason, outcome.entered], ['not_sent', 'rate_limited', false]);
  assert.ok(outcome.retryAfterMs > 0 && outcome.retryAfterMs <= 5_100, String(outcome.retryAfterMs));
  assert.equal(lower.calls, 2);
  assert.equal(entries, 0);
});

test('a known rate limit that ends before the deadline is waited out; the request is sent once', async () => {
  const lower = counting(async () => response(200, { id: '1' }, {
    'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.3',
    'x-ratelimit-bucket': 'synthetic-bucket',
  }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  await rest.post(MESSAGES, { body: { content: 'first' } });
  await rest.post(MESSAGES, { body: { content: 'second' } });
  let entries = 0;
  const started = performance.now();
  const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 3_000, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([outcome.kind, entries, lower.calls], ['confirmed', 1, 3]);
  assert.ok(performance.now() - started >= 200, 'the bucket reset was waited for');
});

// The state discord.js keeps once the requests of the bot have spent the current second of
// the REST's global limit (50 a second): no request until `forMs` from now. Set here so that
// no machine speed decides whether a test meets the limit.
function spendGlobalLimit(rest, forMs) {
  rest.globalRemaining = 0;
  rest.globalReset = Date.now() + forMs;
}

test('the global limit of the REST is waited out while the kept time is left, and refused past it', async () => {
  const lower = counting(async () => response(200, { id: '1' }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  spendGlobalLimit(rest, 400);
  let entries = 0;
  // A deadline of 3 s keeps 1 s for the answer: the wait of about 450 ms ends in time.
  const waited = await channel.send(POST_MESSAGE, { deadlineMs: 3_000, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([waited.kind, entries, lower.calls], ['confirmed', 1, 1]);

  // A deadline of 600 ms keeps 200 ms: the wait of about a second does not end in time.
  const other = counting(async () => response(200, { id: '1' }));
  const otherRest = createRest(other.makeRequest);
  const otherChannel = installProtectedRest(otherRest);
  spendGlobalLimit(otherRest, 1_000);
  entries = 0;
  const started = performance.now();
  const refused = await otherChannel.send(POST_MESSAGE, { deadlineMs: 600, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([refused.kind, refused.reason, entries, other.calls], ['not_sent', 'rate_limited', 0, 0]);
  assert.ok(refused.retryAfterMs > 400 && refused.retryAfterMs <= 1_100, String(refused.retryAfterMs));
  assert.ok(performance.now() - started < 400, 'refused at once, not waited');
});

test('the time kept for the answer is a third of the deadline, at most five seconds', () => {
  assert.equal(RESPONSE_RESERVE_MS, 5_000);
  assert.deepEqual([15_000, 30_000, 120_000, 1_200, 600, 30, 2].map(responseReserveFor),
    [5_000, 5_000, 5_000, 400, 200, 10, 0]);
});

test('a request reaches the network only while the time kept for the answer is left', async () => {
  // A deadline of 600 ms keeps 200 ms for the answer: the network entry closes at 400 ms.
  const lower = counting(async () => response(200, { id: '1' }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  const request = rest.request.bind(rest);
  let holdMs = 0;
  // Holds the request above the queue for holdMs, as a long wait in discord.js would.
  rest.request = async (options) => {
    await tick(holdMs);
    return request(options);
  };
  holdMs = 250;
  const inTime = await channel.send(POST_MESSAGE, { deadlineMs: 600 });
  assert.deepEqual([inTime.kind, lower.calls], ['confirmed', 1]);
  // At about 500 ms only 100 ms would be left for the answer: not sent, so it can be sent again.
  holdMs = 500;
  const late = await channel.send(POST_MESSAGE, { deadlineMs: 600 });
  assert.deepEqual([late.kind, late.reason, late.entered], ['not_sent', 'deadline', false]);
  assert.equal(lower.calls, 1);
});

test('a known rate limit is waited out only if it ends while the kept time is left', async () => {
  // A deadline of 1.2 s keeps 400 ms for the answer: a wait may end by about 800 ms.
  const run = async (limitMs) => {
    const lower = counting(async () => response(200, { id: '1' }));
    const rest = createRest(lower.makeRequest);
    const channel = installProtectedRest(rest);
    spendGlobalLimit(rest, limitMs);
    const started = performance.now();
    const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 1_200 });
    return { outcome, calls: lower.calls, elapsed: performance.now() - started };
  };
  // A wait of about 450 ms ends in time: waited out, then sent.
  const inside = await run(400);
  assert.deepEqual([inside.outcome.kind, inside.calls], ['confirmed', 1]);
  // A wait of about a second ends before the deadline, but not while 400 ms are left for the
  // answer: refused at once, not sent, so it can be sent again.
  const outside = await run(950);
  assert.deepEqual([outside.outcome.kind, outside.outcome.reason, outside.calls], ['not_sent', 'rate_limited', 0]);
  assert.ok(outside.elapsed < 300, 'refused at once, not waited');
});

test('every answer from Discord is classified', async () => {
  const cases = [
    [() => response(200, { id: '7' }), { kind: 'confirmed', httpStatus: 200 }, (o) => assert.deepEqual(o.value, { id: '7' })],
    [() => response(204), { kind: 'confirmed', httpStatus: 204 }],
    [() => response(400, { code: 50035, message: 'Invalid Form Body' }),
      { kind: 'rejected', reason: 'client_error', httpStatus: 400, discordCode: 50035 }],
    [() => response(401, { code: 0, message: '401: Unauthorized' }),
      { kind: 'rejected', reason: 'client_error', httpStatus: 401, discordCode: 0 }],
    [() => response(403, { code: 50013, message: 'Missing Permissions' }),
      { kind: 'rejected', reason: 'permission', httpStatus: 403, discordCode: 50013 }],
    [() => response(404, { code: 10008, message: 'Unknown Message' }),
      { kind: 'rejected', reason: 'not_found', httpStatus: 404, discordCode: 10008 }],
    [() => response(429, { message: 'rate limited', retry_after: 0.001 }, { 'retry-after': '0.001' }),
      { kind: 'rejected', reason: 'rate_limited', httpStatus: 429 }],
    [() => response(500), { kind: 'unknown', reason: 'server_error', httpStatus: 500 }],
    [() => response(502), { kind: 'unknown', reason: 'server_error', httpStatus: 502 }],
    [() => response(200, '{not json'), { kind: 'unknown', reason: 'response_invalid', httpStatus: 200 }],
    [() => response(302, { message: 'moved' }), { kind: 'unknown', reason: 'unexpected_status', httpStatus: 302 }],
    [() => { throw Object.assign(new Error('synthetic refused'), { code: 'ECONNREFUSED' }); },
      { kind: 'unknown', reason: 'network', httpStatus: null }],
  ];
  for (const [handler, expected, extra] of cases) {
    const lower = counting(handler);
    const outcome = await installProtectedRest(createRest(lower.makeRequest)).send(POST_MESSAGE, { deadlineMs: 2_000 });
    const label = JSON.stringify(expected);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(outcome[key], value, `${label} ${key}`);
    assert.equal(outcome.entered, true, label);
    assert.equal(Object.isFrozen(outcome), true, label);
    assert.equal(lower.calls, 1, label);
    extra?.(outcome);
  }
});

test('an entry hook that throws sends nothing; the hook runs outside the attempt', async () => {
  const lower = counting(async () => response(200, { id: '1' }));
  const rest = createRest(lower.makeRequest);
  const failure = new Error('synthetic begin failure');
  let seen = 'unset';
  const outcome = await installProtectedRest(rest).send(POST_MESSAGE, { deadlineMs: 1_000, onNetworkEntry: () => {
    seen = currentProtectedAttempt();
    throw failure;
  } });
  assert.deepEqual([outcome.kind, outcome.reason, outcome.entered], ['not_sent', 'entry_failed', false]);
  assert.equal(outcome.entryError, failure);
  assert.equal(seen, null);
  assert.equal(lower.calls, 0);
});

test('test-control refuses protected requests before the network, installed before or after the channel', async () => {
  for (const order of ['before', 'after']) {
    const lower = counting(async () => response(200, { id: '1' }));
    const rest = createRest(lower.makeRequest);
    const reporter = createReporter({ warn() {} });
    const egress = createTestControlEgress(Object.freeze({
      expectedApplicationId: '777777777777777777',
      reporter,
      allowsChannel: () => false,
      allowsGuild: () => false,
      allowsActor: () => false,
    }));
    if (order === 'before') egress.install(rest);
    const channel = installProtectedRest(rest);
    if (order === 'after') egress.install(rest);
    let entries = 0;
    const onNetworkEntry = () => { entries += 1; };
    const dm = await channel.send({ method: 'POST', fullRoute: Routes.userChannels(),
      body: { recipient_id: OWNER_ID } }, { deadlineMs: 1_000, onNetworkEntry });
    const message = await channel.send(POST_MESSAGE, { deadlineMs: 1_000, onNetworkEntry });
    assert.deepEqual([dm.kind, dm.reason, dm.causeCode], ['not_sent', 'refused', 'TEST_DM_DENIED'], order);
    assert.deepEqual([message.kind, message.reason, message.causeCode],
      ['not_sent', 'refused', 'TEST_CHANNEL_EGRESS_DENIED'], order);
    assert.equal(lower.calls, 0, order);
    assert.equal(entries, 0, order);
    assert.equal(reporter.count('TEST_DM_DENIED', 'discord_rest'), 1, order);
    assert.equal(reporter.count('TEST_CHANNEL_EGRESS_DENIED', 'discord_rest'), 1, order);
  }
});

test('a refusal above the queue hands its code, terminal flag, and wait to the runtime', async () => {
  const lower = counting(async () => response(200, { id: '1' }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  const refusal = Object.assign(new Error('synthetic egress refusal'), { code: 'EGRESS_SYNTHETIC', terminal: true,
    retryAfterMs: 2_500 });
  rest.request = async () => { throw refusal; };
  const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 1_000 });
  assert.deepEqual([outcome.kind, outcome.reason, outcome.causeCode, outcome.terminal, outcome.retryAfterMs],
    ['not_sent', 'refused', 'EGRESS_SYNTHETIC', true, 2_500]);
  assert.equal(outcome.cause, refusal);
  // A refusal that names nothing is still not_sent, neither terminal nor timed.
  rest.request = async () => { throw new Error('Expected token to be set for this request, but none was present'); };
  const plain = await channel.send(POST_MESSAGE, { deadlineMs: 1_000 });
  assert.deepEqual([plain.kind, plain.reason, plain.causeCode, plain.terminal, 'retryAfterMs' in plain],
    ['not_sent', 'refused', null, false, false]);
  assert.equal(lower.calls, 0);
});

test('requests outside a protected attempt pass the gate untouched and keep the earlier rate-limit policy', async () => {
  // A function policy: asked once for the ordinary 429, which it rejects.
  let asked = 0;
  const limited = counting(async () => response(429, { message: 'rate limited', retry_after: 0.001 },
    { 'retry-after': '0.001', 'x-ratelimit-scope': 'user' }));
  const rest = createRest(limited.makeRequest);
  rest.options.rejectOnRateLimit = async () => { asked += 1; return true; };
  installProtectedRest(rest);
  await assert.rejects(() => rest.get(Routes.gateway()));
  assert.equal(asked, 1);
  assert.equal(limited.calls, 1);

  // A route-prefix policy: a matching route is rejected at once; any other waits and retries.
  const firstCalls = new Set();
  const flaky = counting(async (url) => {
    if (firstCalls.has(url)) return response(200, { ok: true });
    firstCalls.add(url);
    return response(429, { message: 'rate limited', retry_after: 0.001 }, { 'retry-after': '0.001' });
  });
  const listed = createRest(flaky.makeRequest);
  listed.options.rejectOnRateLimit = ['/gateway'];
  installProtectedRest(listed);
  await assert.rejects(() => listed.get(Routes.gateway()));
  assert.equal(flaky.calls, 1);
  assert.deepEqual(await listed.get(Routes.user('@me')), { ok: true });
  assert.equal(flaky.calls, 3);

  // Nothing of an attempt is visible to an ordinary request, and its answer is untouched.
  let seen = 'unset';
  const plain = createRest(async () => {
    seen = currentProtectedAttempt();
    return response(200, { id: '9' });
  });
  installProtectedRest(plain);
  assert.deepEqual(await plain.post(MESSAGES, { body: { content: 'ordinary' } }), { id: '9' });
  assert.equal(seen, null);
});

test('a protected and an ordinary request on one bucket do not take each other\'s place', async () => {
  const lower = counting(async (_url, init) => (JSON.parse(init.body).content === 'protected'
    ? response(503) : response(200, { id: '2' })));
  const rest = createRest(lower.makeRequest, { retries: 2 });
  const channel = installProtectedRest(rest);
  const [protectedOutcome, ordinary] = await Promise.all([
    channel.send({ method: 'POST', fullRoute: MESSAGES, body: { content: 'protected' } }, { deadlineMs: 1_000 }),
    rest.post(MESSAGES, { body: { content: 'ordinary' } }),
  ]);
  assert.deepEqual([protectedOutcome.kind, protectedOutcome.reason], ['unknown', 'server_error']);
  assert.deepEqual(ordinary, { id: '2' });
  assert.equal(lower.calls, 2);
});

test('the attempt is visible to a rest.request wrapper, and nowhere else', async () => {
  const rest = createRest(async () => response(200, { id: '1' }));
  const channel = installProtectedRest(rest);
  const original = rest.request.bind(rest);
  const seen = [];
  rest.request = async (options) => {
    seen.push(currentProtectedAttempt());
    seen.push(runOutsideProtectedAttempt(() => currentProtectedAttempt()));
    return original(options);
  };
  await channel.send(POST_MESSAGE, { deadlineMs: 1_000, label: 'safety.synthetic-wrapper' });
  await rest.post(MESSAGES, { body: { content: 'ordinary' } });
  assert.deepEqual(seen, [{ label: 'safety.synthetic-wrapper' }, null, null, null]);
  assert.equal(currentProtectedAttempt(), null);
});

test('the deadline timer runs as the attempt\'s background job', async () => {
  let purpose = 'unset';
  const rest = createRest((_url, init) => never(init, () => { purpose = getHostOperationContext()?.hostPurpose; }));
  const outcome = await installProtectedRest(rest).send(POST_MESSAGE, { deadlineMs: 200, label: 'safety.synthetic-timer' });
  assert.equal(outcome.reason, 'timeout');
  await tick(5);
  assert.equal(purpose, 'background.safety.synthetic-timer');
});

test('the channel is installed once per REST, cannot be removed, and refuses what it cannot carry', async () => {
  const lower = counting(async () => response(200, { id: '1' }));
  const rest = createRest(lower.makeRequest);
  const channel = installProtectedRest(rest);
  assert.equal(installProtectedRest(rest), channel);
  const gate = rest.options.makeRequest;
  assert.throws(() => { rest.options.makeRequest = lower.makeRequest; }, TypeError);
  assert.throws(() => { rest.options = { makeRequest: lower.makeRequest }; }, TypeError);
  assert.equal(rest.options.makeRequest, gate);
  // A protected request still passes the gate exactly once.
  let entries = 0;
  const outcome = await channel.send(POST_MESSAGE, { deadlineMs: 1_000, onNetworkEntry: () => { entries += 1; } });
  assert.deepEqual([outcome.kind, entries, lower.calls], ['confirmed', 1, 1]);

  for (const unsupported of [null, {}, { options: { retries: 0 }, post: async () => {} },
    { request: async () => {}, options: {} }]) {
    assert.throws(() => installProtectedRest(unsupported), (error) => error.code === 'PROTECTED_REST_UNSUPPORTED');
  }

  const invalid = [
    [{ ...POST_MESSAGE, files: [] }, { deadlineMs: 1_000 }],
    [{ ...POST_MESSAGE, signal: new AbortController().signal }, { deadlineMs: 1_000 }],
    [{ ...POST_MESSAGE, method: 'post' }, { deadlineMs: 1_000 }],
    [{ ...POST_MESSAGE, fullRoute: 'channels/1/messages' }, { deadlineMs: 1_000 }],
    [{ ...POST_MESSAGE, body: 'text' }, { deadlineMs: 1_000 }],
    [POST_MESSAGE, { deadlineMs: 0 }],
    [POST_MESSAGE, { deadlineMs: 1.5 }],
    [POST_MESSAGE, { deadlineMs: 120_001 }],
    [POST_MESSAGE, { deadlineMs: 1_000, label: 'Not A Job' }],
    [POST_MESSAGE, { deadlineMs: 1_000, onNetworkEntry: 'begin' }],
  ];
  for (const [request, options] of invalid) {
    const refused = await channel.send(request, options);
    assert.deepEqual([refused.kind, refused.reason], ['not_sent', 'invalid_request'], JSON.stringify(request));
  }
  assert.equal(lower.calls, 1);
});

test('the result code and result of each answer, as the runtimes record them', () => {
  const answers = [
    [{ kind: 'confirmed' }, 'effect_confirmed', undefined],
    [{ kind: 'rejected', reason: 'rate_limited', httpStatus: 429, discordCode: null }, 'effect_rate_limited',
      { httpStatus: 429, discordCode: null }],
    [{ kind: 'rejected', reason: 'permission', httpStatus: 403, discordCode: 50013 }, 'effect_rejected_permission',
      { httpStatus: 403, discordCode: 50013 }],
    [{ kind: 'rejected', reason: 'not_found', httpStatus: 404, discordCode: 10008 }, 'effect_rejected_not_found',
      { httpStatus: 404, discordCode: 10008 }],
    [{ kind: 'rejected', reason: 'client_error', httpStatus: 400, discordCode: 50035 }, 'effect_rejected',
      { httpStatus: 400, discordCode: 50035 }],
    [{ kind: 'unknown', reason: 'timeout' }, 'effect_timeout', undefined],
    [{ kind: 'unknown', reason: 'server_error', httpStatus: 503 }, 'effect_unknown', undefined],
    [{ kind: 'unknown', reason: 'network' }, 'effect_unknown', undefined],
  ];
  for (const [outcome, code, result] of answers) {
    assert.equal(outcomeCode('effect', outcome), code);
    assert.deepEqual(outcomeResult(outcome), result);
  }
  assert.equal(outcomeCode('dm_prepare', { kind: 'rejected', reason: 'permission' }), 'dm_prepare_rejected_permission');
});
