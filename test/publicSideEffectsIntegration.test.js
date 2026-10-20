'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REST } = require('@discordjs/rest');
const { restFrom } = require('./fixtures/syntheticRest');
const logger = require('../src/utils/logger');
const { createTestControlEgress } = require('../src/platform/testControlEgress');
const { createReporter } = require('../src/platform/testControlPolicy');

const { makeRealTempDir } = require('./support/realTempDir');
const root = makeRealTempDir('xiaoji-public-effect-integration-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const {
  initializeCoinDatabase,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');
const {
  dispatchImmediateChainReaction,
} = require('../src/services/chainReactionDelivery');
const {
  startWordChain,
  acceptWordChainMessage,
  processWordChainReactionOutbox,
  stopWordChain,
} = require('../src/services/wordChainService');
const {
  startNumberChain,
  acceptNumberChainMessage,
  processNumberChainReactionOutbox,
  stopNumberChain,
  MAX_TARGET,
} = require('../src/services/numberChainService');
const { corpusVersion } = require('../src/services/wordChainLexicon');
const {
  processWorkPenaltyAnnouncements,
  sendWorkPenaltyAnnouncement,
} = require('../src/systems/work/workService');
const {
  MAX_LEDGER_BYTES,
  MAX_REACTION_FENCES,
  openPublicPurposeLedger,
  pathsFor,
} = require('../src/systems/safety/sideEffectLedger');
const {
  PublicSideEffectRuntime,
  QUEUE_LIMIT,
  WORKER_CONCURRENCY,
} = require('../src/systems/safety/publicSideEffectRuntime');
const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
const {
  claimFeatureOutbox,
  enqueueFeatureOutbox,
  setGuildFeatureSetting,
} = require('../src/services/featurePlatformService');
const {
  buildWorkPenaltyAnnouncementBody,
  proveWorkPenaltySourceWithApi,
} = require('../src/systems/safety/workPenaltySource');

const DISCORD_EPOCH = 1_420_070_400_000n;
const CUTOVER = 1_700_000_000_000;
const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const CHANNEL_ID = '10000000000000003';
const USER_ID = '10000000000000004';
const USER_TWO_ID = '10000000000000005';
const CHANNEL_TWO_ID = '10000000000000006';

function snowflake(timestamp, increment = 1n) {
  return (((BigInt(timestamp) - DISCORD_EPOCH) << 22n) + increment).toString();
}

function response(status, body = {}, headers = {}) {
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function managedRest(makeRequest, timeout = 10) {
  return new REST({ retries: 0, timeout, makeRequest }).setToken('synthetic-token');
}

function initializeLedgers(name) {
  return initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER });
}

// A runtime given the ledgers the way the bootstrap delivers them, and armed as at ready.
// faultPurpose/faultLabel make one write of one purpose's ledger fail.
function createRuntime(name, rest, { ledgers = initializeLedgers(name), faultPurpose = null, faultLabel = null,
  dispatchTimeoutMs = undefined, clock = null } = {}) {
  const authority = createPublicEffectAuthority();
  const now = clock ? () => clock.value : () => CUTOVER + 10_000;
  const delivered = openPublicLedgers(ledgers, {
    botId: BOT_ID,
    now,
    faultInjectorFor: (purposeId) => (purposeId === faultPurpose
      ? ({ label, phase }) => {
        if (label === faultLabel && phase === 'before-ledger-write') throw new Error('synthetic ledger persist failure');
      }
      : null),
  });
  const runtime = new PublicSideEffectRuntime({
    client: { rest: restFrom(rest) },
    botId: BOT_ID,
    env: {},
    now,
    effectAuthority: authority,
    ...(dispatchTimeoutMs === undefined ? {} : { dispatchTimeoutMs }),
  });
  const preflight = runtime.preflight({ ledgers: delivered });
  assert.deepEqual(preflight.disabled, []);
  runtime.arm();
  configurePublicEffectAdapter({ publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer() });
  configureChainReactionFence(runtime);
  return { authority, runtime, ledgers };
}

async function freshDatabase() {
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
}

async function seedPenalty({ createdAt = new Date(CUTOVER + 1_000).toISOString() } = {}) {
  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_work_penalties
        (guild_id, user_id, job_id, job_name, task_id, source_type, source_id, source_channel_id,
         penalty_date, daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
       VALUES (?, ?, 1, '測試職業', NULL, 'synthetic', NULL, ?, '2023-11-14', 1000, 250,
               'active', '合成測試', ?, ?, ?)`,
      [GUILD_ID, USER_ID, CHANNEL_ID, new Date(CUTOVER + 86_400_000).toISOString(), createdAt, createdAt]
    );
    const row = api.get('SELECT * FROM coin_work_penalties WHERE id = last_insert_rowid()');
    return {
      id: Number(row.id),
      guildId: row.guild_id,
      userId: row.user_id,
      jobId: Number(row.job_id),
      jobName: row.job_name,
      sourceChannelId: row.source_channel_id,
      penaltyAmount: Number(row.penalty_amount),
      status: row.status,
      reason: row.reason,
      announcedAt: row.announced_at || null,
      appealDeadlineAt: row.appeal_deadline_at,
      createdAt: row.created_at,
    };
  });
}

async function seedActiveChain(featureKey, { channelId = CHANNEL_ID, enabled = true,
  createdAt = new Date(CUTOVER + 1_000).toISOString() } = {}) {
  return withCoinTransaction((api) => {
    if (featureKey === 'word_chain') {
      api.run(
        `INSERT INTO text_chain_sessions
          (guild_id, channel_id, status, corpus_version, current_word, last_word, last_user_id,
           revision, started_by, created_at, updated_at)
         VALUES (?, ?, 'active', ?, '地球', '地球', NULL, 0, ?, ?, ?)`,
        [GUILD_ID, channelId, corpusVersion, USER_ID, createdAt, createdAt]
      );
    } else {
      api.run(
        `INSERT INTO number_chain_sessions
          (guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, created_at, updated_at)
         VALUES (?, ?, 'active', 100, NULL, 0, ?, ?, ?)`,
        [GUILD_ID, channelId, USER_ID, createdAt, createdAt]
      );
    }
    const session = api.get(`SELECT * FROM ${featureKey === 'word_chain' ? 'text_chain_sessions' : 'number_chain_sessions'}
      WHERE id = last_insert_rowid()`);
    const config = featureKey === 'word_chain' ? { corpusVersion } : { parserVersion: 1 };
    api.run(
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [GUILD_ID, featureKey, enabled ? 1 : 0, enabled ? channelId : null,
        JSON.stringify(config), createdAt, createdAt]
    );
    return session;
  });
}

function penaltyClient(rest) {
  const channel = {
    id: CHANNEL_ID,
    isTextBased: () => true,
    isSendable: () => true,
  };
  const guild = {
    channels: {
      fetch: async (id) => id === CHANNEL_ID ? channel : null,
      cache: { find: () => channel },
    },
  };
  return {
    user: { id: BOT_ID },
    rest,
    guilds: { fetch: async (id) => id === GUILD_ID ? guild : null },
    testControlRuntimeController: { isStopping: () => false },
  };
}

async function prepareReaction(featureKey, messageTimestamp = CUTOVER + 2_000) {
  const messageId = snowflake(messageTimestamp, featureKey === 'word_chain' ? 31n : 32n);
  if (featureKey === 'word_chain') {
    await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
      seed: '地球', now: new Date(CUTOVER + 1_000) });
    const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId, userId: USER_ID, content: '球體', now: new Date(messageTimestamp) });
    return accepted.reactionSource;
  }
  await startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 1_000) });
  const accepted = await acceptNumberChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId, userId: USER_ID, content: '1', now: new Date(messageTimestamp) });
  return accepted.reactionSource;
}

async function invokePurpose(purpose, rest, runtimeState, prepared = null) {
  if (purpose === 'penalty') {
    const penalty = prepared || await seedPenalty();
    const result = await sendWorkPenaltyAnnouncement(penaltyClient(rest), penalty);
    return { result, prepared: penalty };
  }
  const source = prepared || await prepareReaction(purpose);
  const result = await dispatchImmediateChainReaction({ rest }, purpose, source,
    { permissionCheck: () => true });
  return { result, prepared: source };
}

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('all three callers use managed REST once; an unknown or rejected attempt never redispatches after restart',
  async (t) => {
  const failures = [
    ['429', async () => response(429, { message: 'limited', retry_after: 0.001 }, {
      'retry-after': '0.001',
      'x-ratelimit-scope': 'user',
    })],
    ['5xx', async () => response(503, { message: 'unavailable' })],
    ['reset', async () => { const error = new Error('synthetic reset'); error.code = 'ECONNRESET'; throw error; }],
    ['timeout', async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('synthetic abort');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })],
    ['lost-response', async () => { throw new Error('synthetic response lost after acceptance'); }],
  ];
  for (const purpose of ['penalty', 'word_chain', 'number_chain']) {
    for (const [failureName, makeFailure] of failures) {
      await t.test(`${purpose}:${failureName}`, async () => {
        await freshDatabase();
        let firstCalls = 0;
        const firstRest = managedRest(async (...args) => {
          firstCalls += 1;
          return makeFailure(...args);
        }, 5);
        const first = createRuntime(`managed-${purpose}-${failureName}`, firstRest);
        // A 429 reached Discord and was refused: rejected, terminal. The others may have
        // taken effect: unknown.
        const settled = failureName === '429' ? 'terminal' : 'unknown';
        let prepared;
        try {
          const invoked = await invokePurpose(purpose, firstRest, first);
          prepared = invoked.prepared;
          assert.equal(invoked.result.kind, settled);
          assert.equal(firstCalls, 1);
        } finally {
          await first.runtime.stop();
        }

        let replayCalls = 0;
        const replayRest = managedRest(async () => {
          replayCalls += 1;
          return purpose === 'penalty'
            ? response(200, { id: snowflake(CUTOVER + 4_000), channel_id: CHANNEL_ID })
            : response(204);
        });
        const replay = createRuntime(`managed-replay-${purpose}-${failureName}`, replayRest, { ledgers: first.ledgers });
        try {
          const invoked = await invokePurpose(purpose, replayRest, replay, prepared);
          assert.equal(invoked.result.kind, settled);
          assert.equal(replayCalls, 0);
        } finally {
          await replay.runtime.stop();
        }
      });
    }
  }
});

test('a REST that retries inside discord.js still reaches the transport once for a public effect', async () => {
  // discord.js itself retries a 5xx and a reset when REST retries is above 0. The protected
  // channel lets an attempt reach the network once, so the runtime no longer needs retries 0.
  const answers = [
    ['5xx', async () => response(503, { message: 'unavailable' })],
    ['reset', async () => { throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }); }],
  ];
  for (const [name, answer] of answers) {
    for (const spendGlobal of [false, true]) {
      await freshDatabase();
      let calls = 0;
      let rest = null;
      rest = new REST({ retries: 3, timeout: 50, makeRequest: async (...args) => {
        calls += 1;
        // The REST's global window spent as the answer comes back: discord.js's own retry
        // meets that known limit too, which must not turn the answer into a 429.
        if (spendGlobal) {
          rest.globalRemaining = 0;
          rest.globalReset = Date.now() + 300;
        }
        return answer(...args);
      } }).setToken('synthetic-token');
      const label = `${name}${spendGlobal ? ' with the global limit spent' : ''}`;
      const state = createRuntime(`retrying-rest-${name}-${spendGlobal ? 'spent' : 'free'}`, rest);
      try {
        const { result } = await invokePurpose('penalty', rest, state);
        assert.equal(result.kind, 'unknown', label);
        assert.equal(calls, 1, label);
        assert.deepEqual(durableOperations(state, 'work.penalty.announce').map((operation) =>
          [operation.status, operation.resultCode]), [['unknown', 'effect_unknown']], label);
      } finally {
        await state.runtime.stop();
      }
    }
  }
});

// The rows of a purpose's ledger that are durable (a claim held only in memory is not).
function durableOperations(state, purposeId) {
  return Object.values(state.runtime.slots.get(purposeId).ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.durable);
}

test('a public effect still queued behind another request at its deadline is never sent, writes nothing, and is sent later once',
  async () => {
    await freshDatabase();
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    const sent = [];
    const rest = managedRest(async (_url, init) => {
      const ordinary = JSON.parse(init.body).content === 'ordinary';
      sent.push(ordinary ? 'ordinary' : 'penalty');
      if (ordinary) await blocker;
      return response(200, { id: snowflake(CUTOVER + 4_000, 51n), channel_id: CHANNEL_ID });
    }, 5_000);
    const clock = { value: CUTOVER + 10_000 };
    const state = createRuntime('queued-past-deadline', rest, { dispatchTimeoutMs: 100, clock });
    try {
      // An ordinary request holds the channel's bucket; the penalty notice waits behind it.
      const ordinary = rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'ordinary' } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const first = await invokePurpose('penalty', rest, state);
      // Not sent: nothing durable, the claim released for a later try.
      assert.equal(first.result.kind, 'retryable_before_attempt');
      assert.deepEqual(durableOperations(state, 'work.penalty.announce'), []);
      release();
      await ordinary;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(sent, ['ordinary']);
      // After the retry wait the same operation is sent, once, and recorded once.
      clock.value += 30_001;
      const second = await invokePurpose('penalty', rest, state, first.prepared);
      assert.equal(second.result.kind, 'confirmed');
      assert.deepEqual(sent, ['ordinary', 'penalty']);
      assert.deepEqual(durableOperations(state, 'work.penalty.announce').map((operation) => operation.status),
        ['confirmed']);
    } finally {
      await state.runtime.stop();
    }
  });

test('a known rate limit past the deadline writes nothing and waits for its reset without counting', async () => {
  await freshDatabase();
  const sent = [];
  // Every answer spends the channel's bucket for 500 ms, longer than the 100 ms deadline.
  const rest = managedRest(async (_url, init) => {
    sent.push(JSON.parse(init.body).content === 'ordinary' ? 'ordinary' : 'penalty');
    return response(200, { id: snowflake(CUTOVER + 4_000, 52n), channel_id: CHANNEL_ID }, {
      'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.5',
      'x-ratelimit-bucket': 'synthetic-channel-bucket',
    });
  }, 5_000);
  const clock = { value: CUTOVER + 10_000 };
  const state = createRuntime('rate-limited-before-sending', rest, { clock, dispatchTimeoutMs: 100 });
  try {
    // Two ordinary messages: the first names the bucket, the second spends it.
    await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'ordinary' } });
    await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'ordinary' } });
    const first = await invokePurpose('penalty', rest, state);
    assert.equal(first.result.kind, 'retryable_before_attempt');
    assert.deepEqual(sent, ['ordinary', 'ordinary']);
    assert.deepEqual(durableOperations(state, 'work.penalty.announce'), []);
    const released = Object.values(state.runtime.slots.get('work.penalty.announce').ledger.getSnapshotForTests()
      .operations)[0];
    // Released without counting, until the bucket's reset on the ledger clock.
    assert.deepEqual([released.status, released.resultCode, released.prepareFailures],
      ['prepare_failed', 'rate_limited', 0]);
    assert.ok(released.retryNotBeforeMs > clock.value && released.retryNotBeforeMs <= clock.value + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    clock.value += 1_000;
    const second = await invokePurpose('penalty', rest, state, first.prepared);
    assert.equal(second.result.kind, 'confirmed');
    assert.deepEqual(sent, ['ordinary', 'ordinary', 'penalty']);
  } finally {
    await state.runtime.stop();
  }
});

test('a burst over the global limit of 50 requests a second never gives up a protected effect', async (t) => {
  // discord.js counts every request of the REST against 50 a second (the default, kept here)
  // and holds the ones over it before the network. Fifty ordinary requests spend the second;
  // the state discord.js keeps for it is then pinned for `forMs`, so that a slow machine
  // cannot see the second end before the notices meet it.
  const spendTheSecond = async (rest, forMs) => {
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      rest.get(`/users/${10_000_000_000_000_100n + BigInt(index)}`)));
    rest.globalRemaining = 0;
    rest.globalReset = Date.now() + forMs;
  };
  // The spent second ends, as discord.js sees it.
  const endTheSecond = (rest) => {
    rest.globalReset = -1;
  };
  const seedPenalties = (count) => withCoinTransaction((api) => {
    for (let index = 0; index < count; index += 1) {
      const createdAt = new Date(CUTOVER + 1_000 + index).toISOString();
      api.run(
        `INSERT INTO coin_work_penalties
          (guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
           daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
         VALUES (?, ?, 1, '測試職業', 'synthetic', ?, '2023-11-14', 1000, 250, 'active',
                 '合成測試', ?, ?, ?)`,
        [GUILD_ID, USER_ID, CHANNEL_ID, new Date(CUTOVER + 86_400_000).toISOString(), createdAt, createdAt]
      );
    }
  });
  const answering = (sent) => managedRest(async (url, init) => {
    if (init.method !== 'POST') return response(200, { id: '10000000000000099' });
    sent.push(url);
    return response(200, { id: snowflake(CUTOVER + 5_000, BigInt(sent.length)), channel_id: CHANNEL_ID });
  }, 1_000);
  const run = (rest) => processWorkPenaltyAnnouncements(penaltyClient(rest),
    { guildId: GUILD_ID, limit: 10 });
  const unknownRows = (state) => durableOperations(state, 'work.penalty.announce')
    .filter((operation) => operation.status === 'unknown').length;

  await t.test('a wait that ends before the deadline is waited out: every notice is sent in the same run', async () => {
    await freshDatabase();
    await seedPenalties(10);
    const sent = [];
    const rest = answering(sent);
    const state = createRuntime('global-limit-waited', rest);
    try {
      await spendTheSecond(rest, 400);
      const summary = await run(rest);
      assert.equal(summary.announced, 10);
      assert.equal(sent.length, 10);
      assert.equal(unknownRows(state), 0);
    } finally {
      await state.runtime.stop();
    }
  });

  await t.test('past a short deadline: not sent, nothing written, and each sent once later', async () => {
    await freshDatabase();
    await seedPenalties(10);
    const sent = [];
    const rest = answering(sent);
    const clock = { value: CUTOVER + 10_000 };
    const state = createRuntime('global-limit-deferred', rest, { dispatchTimeoutMs: 100, clock });
    try {
      await spendTheSecond(rest, 3_000);
      const first = await run(rest);
      // Every notice met the spent second: none was sent, nothing was written, none is unknown.
      assert.equal(first.announced, 0, JSON.stringify(first));
      assert.deepEqual(sent, []);
      assert.equal(unknownRows(state), 0);
      assert.deepEqual(durableOperations(state, 'work.penalty.announce'), []);
      // The second ends, and the ledger clock passes the wait the released notices met.
      endTheSecond(rest);
      clock.value += 5_000;
      let { announced } = first;
      for (let round = 0; round < 5 && announced < 10; round += 1) announced += (await run(rest)).announced;
      assert.equal(announced, 10);
      assert.equal(sent.length, 10);
      assert.deepEqual(durableOperations(state, 'work.penalty.announce').map((operation) => operation.status),
        Array(10).fill('confirmed'));
    } finally {
      await state.runtime.stop();
    }
  });
});

test('Discord\'s refusal is recorded rejected under its reason and never sent again', async () => {
  await freshDatabase();
  let sends = 0;
  const rest = managedRest(async () => {
    sends += 1;
    return response(403, { code: 50013, message: 'Missing Permissions' });
  });
  const state = createRuntime('rejected-permission', rest);
  const warnings = [];
  const warn = logger.warn;
  logger.warn = (message) => { warnings.push(String(message)); };
  try {
    const first = await invokePurpose('penalty', rest, state);
    assert.deepEqual([first.result.kind, sends], ['terminal', 1]);
    // One fixed line: the penalty and the result code, nothing of Discord's answer.
    assert.deepEqual(warnings, [
      `工作扣薪公告被 Discord 拒絕，不會重送：penalty=${first.prepared.id} code=effect_rejected_permission`]);
    const [row] = durableOperations(state, 'work.penalty.announce');
    assert.deepEqual([row.status, row.resultCode, row.result], ['rejected', 'effect_rejected_permission',
      { httpStatus: 403, discordCode: 50013 }]);
    // Replayed, it stays terminal and nothing is sent.
    const replay = await invokePurpose('penalty', rest, state, first.prepared);
    assert.deepEqual([replay.result.kind, sends], ['terminal', 1]);
  } finally {
    logger.warn = warn;
    await state.runtime.stop();
  }
});

test('a public effect refused above the network twice is settled in memory only, with nothing sent or written',
  async () => {
    await freshDatabase();
    let sends = 0;
    const rest = managedRest(async () => {
      sends += 1;
      return response(200, { id: snowflake(CUTOVER + 4_000, 55n), channel_id: CHANNEL_ID });
    });
    // test-control refuses the channel before the request reaches the queue.
    createTestControlEgress(Object.freeze({
      expectedApplicationId: BOT_ID,
      reporter: createReporter({ warn() {} }),
      allowsChannel: () => false,
      allowsGuild: () => true,
      allowsActor: () => true,
    })).install(rest);
    const clock = { value: CUTOVER + 10_000 };
    const state = createRuntime('refused-twice', rest, { clock });
    const entries = () => Object.values(state.runtime.slots.get('work.penalty.announce').ledger.getSnapshotForTests()
      .operations);
    try {
      const first = await invokePurpose('penalty', rest, state);
      assert.equal(first.result.kind, 'retryable_before_attempt');
      assert.deepEqual(entries().map((entry) => [entry.durable, entry.status, entry.prepareFailures]),
        [[false, 'prepare_failed', 1]]);
      // After the retry wait it is tried once more and refused again: settled, in memory.
      clock.value += 30_001;
      await invokePurpose('penalty', rest, state, first.prepared);
      assert.deepEqual(entries().map((entry) => [entry.durable, entry.status, entry.prepareFailures]),
        [[false, 'final', 2]]);
      const settled = await invokePurpose('penalty', rest, state, first.prepared);
      assert.equal(settled.result.kind, 'terminal');
      assert.equal(sends, 0);
      assert.deepEqual(durableOperations(state, 'work.penalty.announce'), []);
    } finally {
      await state.runtime.stop();
    }
  });

test('a final authorization that outlasts the claim lease is still sent once: the lease starts again first',
  async () => {
    await freshDatabase();
    let sends = 0;
    const rest = managedRest(async () => {
      sends += 1;
      return response(204);
    });
    const clock = { value: CUTOVER + 10_000 };
    const state = createRuntime('long-final-authorization', rest, { clock });
    try {
      const source = await prepareReaction('word_chain');
      const result = await dispatchImmediateChainReaction({ rest }, 'word_chain', source, {
        permissionCheck: () => true,
        // The final authorization takes longer than the 30 s claim lease, on the ledger clock.
        beforeFinalAuthorization: async () => { clock.value += 31_000; },
      });
      assert.equal(result.kind, 'confirmed');
      assert.equal(sends, 1);
      assert.deepEqual(durableOperations(state, 'word-chain.reaction').map((operation) => operation.status),
        ['confirmed']);
    } finally {
      await state.runtime.stop();
    }
  });

test('the ✅ of a message Discord no longer has is rejected not_found', async () => {
  await freshDatabase();
  let sends = 0;
  const rest = managedRest(async () => {
    sends += 1;
    return response(404, { code: 10008, message: 'Unknown Message' });
  });
  const state = createRuntime('rejected-not-found', rest);
  try {
    const first = await invokePurpose('word_chain', rest, state);
    assert.deepEqual([first.result.kind, first.result.basis, first.result.reason, sends],
      ['terminal', 'durable', 'effect_rejected_not_found', 1]);
    // Replayed from its row, the answer keeps its reason, and nothing is sent.
    const replay = await invokePurpose('word_chain', rest, state, first.prepared);
    assert.deepEqual([replay.result.kind, replay.result.basis, replay.result.reason, sends],
      ['terminal', 'durable', 'effect_rejected_not_found', 1]);
  } finally {
    await state.runtime.stop();
  }
});

test('a ledger begin that fails at the network entry sends nothing and stops the purpose', async () => {
  await freshDatabase();
  let sends = 0;
  const rest = managedRest(async () => {
    sends += 1;
    return response(200, { id: snowflake(CUTOVER + 4_000, 53n), channel_id: CHANNEL_ID });
  });
  const state = createRuntime('begin-fault-at-entry', rest,
    { faultPurpose: 'work.penalty.announce', faultLabel: 'begin-dispatch' });
  try {
    const { result } = await invokePurpose('penalty', rest, state);
    assert.equal(result.kind, 'unavailable');
    assert.equal(sends, 0);
    assert.equal(state.runtime.isPurposeReady('work.penalty.announce'), false);
  } finally {
    await state.runtime.stop();
  }
});

test('a stop that begins while the attempt waits in the queue keeps it from the network and writes nothing',
  async () => {
    await freshDatabase();
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    const sent = [];
    const rest = managedRest(async (_url, init) => {
      const ordinary = JSON.parse(init.body).content === 'ordinary';
      sent.push(ordinary ? 'ordinary' : 'penalty');
      if (ordinary) await blocker;
      return response(200, { id: snowflake(CUTOVER + 4_000, 54n), channel_id: CHANNEL_ID });
    }, 5_000);
    // The penalty's request is seen as it enters the REST, before discord.js queues it.
    let issued;
    const issuedPromise = new Promise((resolve) => { issued = resolve; });
    const request = rest.request.bind(rest);
    rest.request = (options) => {
      if (options.body?.content !== 'ordinary') issued();
      return request(options);
    };
    const state = createRuntime('stop-while-queued', rest, { dispatchTimeoutMs: 5_000 });
    const ordinary = rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'ordinary' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dispatching = invokePurpose('penalty', rest, state);
    await issuedPromise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopping = state.runtime.stop();
    release();
    await ordinary;
    const { result } = await dispatching;
    await stopping;
    assert.equal(result.kind, 'unavailable');
    assert.deepEqual(sent, ['ordinary']);
    const reopened = openPublicLedgers(state.ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
    try {
      assert.deepEqual(Object.keys(reopened.get('work.penalty.announce').getSnapshotForTests().operations), []);
    } finally {
      for (const ledger of reopened.values()) ledger.close();
    }
  });

test('penalty caller repairs a confirmed DB result after one local failure without resending or overwriting conflict', async () => {
  await freshDatabase();
  const penalty = await seedPenalty();
  await withCoinTransaction((api) => api.run(
    `CREATE TRIGGER fail_penalty_announcement
       BEFORE UPDATE OF announced_at ON coin_work_penalties
       WHEN NEW.announced_at IS NOT NULL AND OLD.announced_at IS NULL
       BEGIN SELECT RAISE(ABORT, 'synthetic repair failure'); END`
  ));
  let sends = 0;
  const rest = managedRest(async () => {
    sends += 1;
    return response(200, { id: snowflake(CUTOVER + 3_000, 41n), channel_id: CHANNEL_ID });
  });
  const first = createRuntime('penalty-repair', rest);
  await assert.rejects(sendWorkPenaltyAnnouncement(penaltyClient(rest), penalty), /synthetic repair failure/u);
  assert.equal(sends, 1);
  assert.equal(await withCoinDatabase((api) => api.get(
    'SELECT announced_at FROM coin_work_penalties WHERE id = ?', [penalty.id]
  ).announced_at), null);
  await withCoinTransaction((api) => api.run('DROP TRIGGER fail_penalty_announcement'));
  await first.runtime.stop();

  let replaySends = 0;
  const replayRest = managedRest(async () => { replaySends += 1; return response(500); });
  const replay = createRuntime('penalty-repair-restart', replayRest, { ledgers: first.ledgers });
  const repaired = await sendWorkPenaltyAnnouncement(penaltyClient(replayRest), penalty);
  assert.equal(repaired.kind, 'confirmed');
  assert.equal(repaired.announced, true);
  assert.equal(replaySends, 0);
  const durable = await withCoinDatabase((api) => api.get(
    `SELECT announced_at, announcement_channel_id, announcement_message_id
       FROM coin_work_penalties WHERE id = ?`, [penalty.id]
  ));
  assert.equal(durable.announcement_channel_id, CHANNEL_ID);
  assert.equal(durable.announcement_message_id, snowflake(CUTOVER + 3_000, 41n));

  await withCoinTransaction((api) => api.run(
    `UPDATE coin_work_penalties
        SET announced_at = '2099-01-01T00:00:00.000Z', announcement_channel_id = ?, announcement_message_id = ?
      WHERE id = ?`,
    ['10000000000000009', '10000000000000008', penalty.id]
  ));
  const conflict = await sendWorkPenaltyAnnouncement(penaltyClient(replayRest), penalty);
  assert.equal(conflict.kind, 'confirmed');
  assert.equal(conflict.announced, false);
  assert.equal(replaySends, 0);
  const unchanged = await withCoinDatabase((api) => api.get(
    `SELECT announced_at, announcement_channel_id, announcement_message_id
       FROM coin_work_penalties WHERE id = ?`, [penalty.id]
  ));
  assert.deepEqual(unchanged, {
    announced_at: '2099-01-01T00:00:00.000Z',
    announcement_channel_id: '10000000000000009',
    announcement_message_id: '10000000000000008',
  });
  await replay.runtime.stop();
});

test('confirmed REST with ledger finish failure stays unknown and never writes penalty announcement fields', async () => {
  await freshDatabase();
  const penalty = await seedPenalty();
  let sends = 0;
  const rest = managedRest(async () => {
    sends += 1;
    return response(200, { id: snowflake(CUTOVER + 3_000, 42n), channel_id: CHANNEL_ID });
  });
  const state = createRuntime('penalty-finish-fault', rest,
    { faultPurpose: 'work.penalty.announce', faultLabel: 'finish' });
  const result = await sendWorkPenaltyAnnouncement(penaltyClient(rest), penalty);
  assert.equal(result.kind, 'unknown');
  assert.equal(result.announced, false);
  assert.equal(sends, 1);
  const row = await withCoinDatabase((api) => api.get(
    `SELECT announced_at, announcement_channel_id, announcement_message_id
       FROM coin_work_penalties WHERE id = ?`, [penalty.id]
  ));
  assert.deepEqual(row, { announced_at: null, announcement_channel_id: null, announcement_message_id: null });
  await state.runtime.stop();
});

test('a valid DB-backed grant is one-use and still cannot dispatch without final authorization', async () => {
  await freshDatabase();
  const penalty = await seedPenalty();
  let sends = 0;
  const rest = { options: { retries: 0 }, put: async () => {}, post: async () => { sends += 1; return {}; } };
  const state = createRuntime('valid-grant-final-auth', rest);
  const effect = {
    purposeId: 'work.penalty.announce',
    action: 'work-penalty-message.create',
    target: CHANNEL_ID,
    method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`,
    body: buildWorkPenaltyAnnouncementBody(penalty),
  };
  let expiredApi;
  const proof = await withCoinTransaction((api) => {
    expiredApi = api;
    assert.equal(proveWorkPenaltySourceWithApi(api, {
      botId: BOT_ID,
      guildId: '10000000000000009',
      penaltyId: penalty.id,
      createdAt: penalty.createdAt,
      effect,
    }), null);
    return proveWorkPenaltySourceWithApi(api, {
      botId: BOT_ID,
      guildId: GUILD_ID,
      penaltyId: penalty.id,
      createdAt: penalty.createdAt,
      effect,
    });
  });
  assert.equal(proveWorkPenaltySourceWithApi(expiredApi, {
    botId: BOT_ID,
    guildId: GUILD_ID,
    penaltyId: penalty.id,
    createdAt: penalty.createdAt,
    effect,
  }), null);
  const issuer = state.authority.createIssuer();
  const grant = issuer.issuePenalty(proof, effect);
  assert.ok(grant);
  assert.equal(issuer.issuePenalty(proof, effect), null);
  const result = await state.runtime.dispatch(grant, effect);
  assert.equal(result.kind, 'terminal');
  assert.equal(sends, 0);
  await state.runtime.stop();
});

test('actual reaction caller orders final DB proof and begin before REST, and stop wins both sides of begin', async () => {
  await freshDatabase();
  let lowerCalls = 0;
  let finalAuthorizationActive = false;
  const rest = managedRest(async () => {
    assert.equal(finalAuthorizationActive, false, 'network must start after the DB queue callback');
    lowerCalls += 1;
    return response(204);
  });
  const first = createRuntime('caller-stop-before-begin', rest);
  const source = await prepareReaction('word_chain');
  let releaseBefore;
  let enteredBefore;
  const enteredBeforePromise = new Promise((resolve) => { enteredBefore = resolve; });
  const beforeGate = new Promise((resolve) => { releaseBefore = resolve; });
  const stopFirstDispatch = dispatchImmediateChainReaction({ rest }, 'word_chain', source, {
    permissionCheck: () => true,
    beforeFinalAuthorization: async () => {
      finalAuthorizationActive = true;
      enteredBefore();
      await beforeGate;
      finalAuthorizationActive = false;
    },
  });
  await enteredBeforePromise;
  const stopFirst = first.runtime.stop();
  releaseBefore();
  const stopFirstOutcome = await stopFirstDispatch;
  await stopFirst;
  // Stopping says nothing about the event itself: unavailable (retried later), never terminal.
  assert.equal(stopFirstOutcome.kind, 'unavailable');
  assert.equal(lowerCalls, 0);

  const secondRest = managedRest(async () => { lowerCalls += 1; return response(204); });
  const second = createRuntime('caller-stop-after-begin', secondRest);
  await freshDatabase();
  configurePublicEffectAdapter({ publicEffectRuntime: second.runtime,
    publicEffectIssuer: second.authority.createIssuer() });
  configureChainReactionFence(second.runtime);
  const secondSource = await prepareReaction('number_chain', CUTOVER + 3_000);
  let releaseAfter;
  let enteredAfter;
  const enteredAfterPromise = new Promise((resolve) => { enteredAfter = resolve; });
  const afterGate = new Promise((resolve) => { releaseAfter = resolve; });
  const attemptFirstDispatch = dispatchImmediateChainReaction({ rest: secondRest }, 'number_chain', secondSource, {
    permissionCheck: () => true,
    afterBegin: async () => {
      enteredAfter();
      await afterGate;
    },
  });
  await enteredAfterPromise;
  const attemptFirst = second.runtime.stop();
  releaseAfter();
  const attemptFirstOutcome = await attemptFirstDispatch;
  await attemptFirst;
  // begin() writes nothing; the ledger begin waits for the network entry. A stop in between
  // leaves no row, and the event is unavailable (retried later), as before the begin.
  assert.equal(attemptFirstOutcome.kind, 'unavailable');
  assert.equal(lowerCalls, 0);
  const reopened = openPublicLedgers(second.ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
  try {
    assert.deepEqual(Object.keys(reopened.get('number-chain.reaction').getSnapshotForTests().operations), []);
  } finally {
    for (const ledger of reopened.values()) ledger.close();
  }
});

test('chain generation changes are monotonic and stale channels or ordinary config writes cannot reopen authority', async () => {
  await freshDatabase();
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  const state = createRuntime('chain-generations', rest);
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 1_000) });
  const firstFence = state.runtime.getReactionFence('word-chain.reaction', GUILD_ID);
  await setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    config: { custom: 'preserved' },
    now: new Date(CUTOVER + 1_100),
  });
  assert.deepEqual(state.runtime.getReactionFence('word-chain.reaction', GUILD_ID), firstFence);

  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_TWO_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 2_000) });
  const secondFence = state.runtime.getReactionFence('word-chain.reaction', GUILD_ID);
  assert.ok(secondFence.generation > firstFence.generation);
  assert.equal(secondFence.channelId, CHANNEL_TWO_ID);
  const staleStop = await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 2_100) });
  assert.equal(staleStop.stopped, false);
  assert.deepEqual(state.runtime.getReactionFence('word-chain.reaction', GUILD_ID), secondFence);

  await setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    enabled: false,
    channelId: null,
    now: new Date(CUTOVER + 2_200),
  });
  assert.equal(state.runtime.getReactionFence('word-chain.reaction', GUILD_ID).open, false);
  await setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    config: { custom: 'changed while disabled' },
    now: new Date(CUTOVER + 2_300),
  });
  assert.equal(state.runtime.getReactionFence('word-chain.reaction', GUILD_ID).open, false);
  await setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    enabled: true,
    channelId: CHANNEL_TWO_ID,
    now: new Date(CUTOVER + 2_400),
  });
  const thirdFence = state.runtime.getReactionFence('word-chain.reaction', GUILD_ID);
  assert.ok(thirdFence.generation > secondFence.generation);
  assert.equal(thirdFence.open, true);

  await withCoinTransaction((api) => api.run(
    "UPDATE feature_guild_settings SET config_json = '{broken' WHERE guild_id = ? AND feature_key = 'word_chain'",
    [GUILD_ID]
  ));
  await assert.rejects(setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    config: { ordinary: true },
    now: new Date(CUTOVER + 2_500),
  }), (error) => error.code === 'CORRUPT_DATA');
  await setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    enabled: false,
    now: new Date(CUTOVER + 2_600),
  });
  assert.equal(state.runtime.getReactionFence('word-chain.reaction', GUILD_ID).open, false);
  await state.runtime.stop();
});

test('missing metadata, legacy source fences, and fake completion markers cannot authorize a reaction', async () => {
  await freshDatabase();
  let calls = 0;
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => { calls += 1; return {}; } };
  const state = createRuntime('chain-tamper', rest);
  const source = await prepareReaction('word_chain');
  const legacy = await dispatchImmediateChainReaction({ rest }, 'word_chain',
    { ...source, sourceFence: 'a'.repeat(64) }, { permissionCheck: () => true });
  assert.equal(legacy.kind, 'terminal');
  assert.equal(calls, 0);

  let preservedMetadata;
  await withCoinTransaction((api) => {
    const row = api.get(
      "SELECT config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
      [GUILD_ID]
    );
    const config = JSON.parse(row.config_json);
    preservedMetadata = config._chainReaction;
    delete config._chainReaction;
    api.run("UPDATE feature_guild_settings SET config_json = ? WHERE guild_id = ? AND feature_key = 'word_chain'",
      [JSON.stringify(config), GUILD_ID]);
  });
  const missing = await dispatchImmediateChainReaction({ rest }, 'word_chain', source,
    { permissionCheck: () => true });
  assert.equal(missing.kind, 'terminal');

  await withCoinTransaction((api) => {
    const entry = api.get('SELECT id, session_id FROM text_chain_entries WHERE message_id = ?', [source.messageId]);
    api.run("UPDATE text_chain_sessions SET status = 'completed', revision = revision + 1 WHERE id = ?", [entry.session_id]);
    const fake = { ...preservedMetadata, completion: {
      messageId: source.messageId,
      entryId: Number(entry.id) + 999,
      finalRevision: 999,
    } };
    api.run("UPDATE feature_guild_settings SET enabled = 0, channel_id = NULL, config_json = ? WHERE guild_id = ? AND feature_key = 'word_chain'",
      [JSON.stringify({ corpusVersion: 'v1', _chainReaction: fake }), GUILD_ID]);
  });
  const fakeCompletion = await dispatchImmediateChainReaction({ rest }, 'word_chain', source,
    { permissionCheck: () => true });
  assert.equal(fakeCompletion.kind, 'terminal');
  assert.equal(calls, 0);
  await state.runtime.stop();
});

test('completed word reaction is transactional, survives the final move, and stop closes completed authority', async () => {
  await freshDatabase();
  let calls = 0;
  const rest = managedRest(async () => { calls += 1; return response(204); });
  const state = createRuntime('completed-word', rest);
  const started = await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    seed: '一一', now: new Date(CUTOVER + 1_000) });
  const failedMessage = snowflake(CUTOVER + 2_000, 51n);
  await assert.rejects(acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId: failedMessage, userId: USER_ID, content: '一樹百穫', now: new Date(CUTOVER + 2_000),
    beforeCommit: () => { throw new Error('synthetic completion rollback'); },
  }), /synthetic completion rollback/u);
  const rolledBack = await withCoinDatabase((api) => ({
    session: api.get('SELECT status, revision FROM text_chain_sessions WHERE id = ?', [started.session.id]),
    entries: Number(api.get('SELECT COUNT(*) AS count FROM text_chain_entries WHERE message_id = ?', [failedMessage]).count),
    outbox: Number(api.get("SELECT COUNT(*) AS count FROM feature_outbox WHERE dedupe_key = ?", [`reaction:${failedMessage}`]).count),
  }));
  assert.deepEqual(rolledBack, { session: { status: 'active', revision: 0 }, entries: 0, outbox: 0 });

  const messageId = snowflake(CUTOVER + 3_000, 52n);
  const completed = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId, userId: USER_ID, content: '一樹百穫', now: new Date(CUTOVER + 3_000) });
  assert.equal(completed.completed, true);
  assert.ok(completed.reactionSource);
  const delivered = await processWordChainReactionOutbox({ rest }, {
    permissionCheck: () => true,
  });
  assert.equal(delivered.delivered, 1);
  assert.equal(calls, 1);
  const stopped = await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 4_000) });
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.reactionRevoked, true);
  assert.equal(state.runtime.getReactionFence('word-chain.reaction', GUILD_ID).open, false);
  await state.runtime.stop();
});

test('DB rollback after fence close cannot restore reaction authority, including after restart', async () => {
  await freshDatabase();
  let calls = 0;
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => { calls += 1; return {}; } };
  const first = createRuntime('stop-db-rollback', rest);
  const source = await prepareReaction('word_chain');
  await withCoinTransaction((api) => api.run(
    `CREATE TRIGGER fail_word_stop
       BEFORE UPDATE ON feature_guild_settings
       WHEN OLD.feature_key = 'word_chain'
       BEGIN SELECT RAISE(ABORT, 'synthetic stop rollback'); END`
  ));
  await assert.rejects(stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 3_000) }), /synthetic stop rollback/u);
  const dbState = await withCoinDatabase((api) => ({
    session: api.get("SELECT status FROM text_chain_sessions WHERE guild_id = ? ORDER BY id DESC LIMIT 1", [GUILD_ID]).status,
    enabled: Number(api.get("SELECT enabled FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'", [GUILD_ID]).enabled),
  }));
  assert.deepEqual(dbState, { session: 'active', enabled: 1 });
  const rejected = await dispatchImmediateChainReaction({ rest }, 'word_chain', source,
    { permissionCheck: () => true });
  assert.equal(rejected.kind, 'terminal');
  assert.equal(calls, 0);
  await withCoinTransaction((api) => api.run('DROP TRIGGER fail_word_stop'));
  await first.runtime.stop();

  const second = createRuntime('stop-db-rollback-restart', rest, { ledgers: first.ledgers });
  const replay = await dispatchImmediateChainReaction({ rest }, 'word_chain', source,
    { permissionCheck: () => true });
  assert.equal(replay.kind, 'terminal');
  assert.equal(calls, 0);
  await second.runtime.stop();
});

test('fence persistence failure disables only its purpose, still disables DB state, and retains the lock across restart', async () => {
  await freshDatabase();
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  const first = createRuntime('fence-persist-fault', rest,
    { faultPurpose: 'word-chain.reaction', faultLabel: 'close-reaction-fence' });
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 1_000) });
  const stopped = await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 2_000) });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.reactionRevoked, true);
  assert.equal(first.runtime.isPurposeReady('word-chain.reaction'), false);
  assert.equal(first.runtime.isPurposeReady('number-chain.reaction'), true);
  const setting = await withCoinDatabase((api) => api.get(
    "SELECT enabled FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'", [GUILD_ID]
  ));
  assert.equal(Number(setting.enabled), 0);
  const ledgerPath = first.ledgers['word-chain.reaction'].filePath;
  const lockPath = pathsFor(ledgerPath).lockPath;
  // The failed fence write quarantined the ledger at once, so a crash before stop() keeps it.
  assert.equal(fs.existsSync(lockPath), true);
  await first.runtime.stop();
  assert.equal(fs.existsSync(lockPath), true);

  // After a restart the quarantined ledger cannot be opened, so it is never delivered.
  const delivered = openPublicLedgers(first.ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
  assert.equal(delivered.failures.get('word-chain.reaction')?.code, 'SIDE_EFFECT_LEDGER_QUARANTINED');
  const authority = createPublicEffectAuthority();
  const second = new PublicSideEffectRuntime({ client: { rest: restFrom(rest) }, botId: BOT_ID, env: {},
    now: () => CUTOVER + 10_000, effectAuthority: authority });
  const preflight = second.preflight({ ledgers: delivered });
  assert.ok(preflight.disabled.includes('word-chain.reaction'));
  assert.ok(preflight.enabled.includes('number-chain.reaction'));
  assert.ok(preflight.enabled.includes('work.penalty.announce'));
  assert.equal(fs.existsSync(lockPath), true);
  await second.stop();
});

test('fence open persistence failures cannot leave start or generic enable paths active', async () => {
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };

  for (const [featureKey, start] of [
    ['word_chain', (channelId) => startWordChain({ guildId: GUILD_ID, channelId, actorId: USER_ID,
      seed: '地球', now: new Date(CUTOVER + 2_000) })],
    ['number_chain', (channelId) => startNumberChain({ guildId: GUILD_ID, channelId, actorId: USER_ID,
      target: 100, now: new Date(CUTOVER + 2_000) })],
  ]) {
    await freshDatabase();
    const purposeId = featureKey === 'word_chain' ? 'word-chain.reaction' : 'number-chain.reaction';
    const state = createRuntime(`open-fault-disabled-${featureKey}`, rest,
      { faultPurpose: purposeId, faultLabel: 'open-reaction-fence' });
    await assert.rejects(start(CHANNEL_ID), (error) => error.code === 'REACTION_FENCE_OPEN_FAILED');
    const setting = await withCoinDatabase((api) => api.get(
      'SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
      [GUILD_ID, featureKey]
    ));
    assert.equal(Number(setting.enabled), 0);
    assert.equal(setting.channel_id, null);
    assert.equal(JSON.parse(setting.config_json)._chainReaction, undefined);
    assert.equal(state.runtime.isPurposeReady(purposeId), false);
    await state.runtime.stop();
  }

  await freshDatabase();
  await seedActiveChain('word_chain', { channelId: CHANNEL_ID, enabled: true });
  const switchState = createRuntime('open-fault-enabled-switch', rest,
    { faultPurpose: 'word-chain.reaction', faultLabel: 'open-reaction-fence' });
  await assert.rejects(startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_TWO_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 3_000) }), (error) => error.code === 'REACTION_FENCE_OPEN_FAILED');
  const switched = await withCoinDatabase((api) => api.get(
    "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
    [GUILD_ID]
  ));
  assert.deepEqual(switched, { enabled: 0, channel_id: null });
  await switchState.runtime.stop();

  await freshDatabase();
  await seedActiveChain('word_chain', { channelId: CHANNEL_ID, enabled: false });
  const settingState = createRuntime('open-fault-generic-setting', rest,
    { faultPurpose: 'word-chain.reaction', faultLabel: 'open-reaction-fence' });
  await assert.rejects(setGuildFeatureSetting(GUILD_ID, 'word_chain', {
    enabled: true, channelId: CHANNEL_ID, now: new Date(CUTOVER + 4_000),
  }), (error) => error.code === 'REACTION_FENCE_OPEN_FAILED');
  const generic = await withCoinDatabase((api) => api.get(
    "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
    [GUILD_ID]
  ));
  assert.deepEqual(generic, { enabled: 0, channel_id: null });
  await settingState.runtime.stop();
});

test('restarting an in-progress word chain whose fence cannot open disables it but keeps the round for a later resume', async () => {
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  await freshDatabase();
  const seeded = await seedActiveChain('word_chain', { channelId: CHANNEL_ID, enabled: true });
  const roundBefore = await withCoinDatabase((api) => api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [seeded.id]));

  const failing = createRuntime('same-channel-open-fault', rest,
    { faultPurpose: 'word-chain.reaction', faultLabel: 'open-reaction-fence' });
  let failure = null;
  await assert.rejects(startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_TWO_ID,
    seed: '地球', now: new Date(CUTOVER + 2_000) }), (error) => {
    failure = error;
    return error.code === 'REACTION_FENCE_OPEN_FAILED';
  });
  const paused = await withCoinDatabase((api) => ({
    round: api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [seeded.id]),
    rounds: Number(api.get('SELECT COUNT(*) AS count FROM text_chain_sessions WHERE guild_id = ?', [GUILD_ID]).count),
    setting: api.get(
      "SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
      [GUILD_ID]
    ),
  }));
  assert.deepEqual(paused.round, roundBefore);
  assert.equal(paused.round.status, 'active');
  assert.equal(paused.rounds, 1);
  assert.deepEqual({ enabled: Number(paused.setting.enabled), channelId: paused.setting.channel_id },
    { enabled: 0, channelId: null });
  assert.equal(JSON.parse(paused.setting.config_json)._chainReaction, undefined);
  assert.equal(failing.runtime.isPurposeReady('word-chain.reaction'), false);
  assert.match(failure.message, /進度已保留/u);
  await failing.runtime.stop();

  // With a working fence the same command resumes the very same round instead of starting a new one.
  const recovered = createRuntime('same-channel-open-recovered', rest);
  const resumed = await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_TWO_ID,
    seed: '地球', now: new Date(CUTOVER + 3_000) });
  assert.equal(resumed.alreadyActive, true);
  assert.equal(resumed.session.id, seeded.id);
  assert.equal(resumed.session.status, 'active');
  assert.equal(resumed.session.revision, 0);
  const resumedState = await withCoinDatabase((api) => ({
    rounds: Number(api.get('SELECT COUNT(*) AS count FROM text_chain_sessions WHERE guild_id = ?', [GUILD_ID]).count),
    setting: api.get(
      "SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
      [GUILD_ID]
    ),
  }));
  assert.equal(resumedState.rounds, 1);
  assert.deepEqual({ enabled: Number(resumedState.setting.enabled), channelId: resumedState.setting.channel_id },
    { enabled: 1, channelId: CHANNEL_ID });
  assert.equal(JSON.parse(resumedState.setting.config_json)._chainReaction.channelId, CHANNEL_ID);
  await recovered.runtime.stop();
});

test('restarting an in-progress number chain whose fence cannot open disables it but keeps the round for a later resume', async () => {
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  await freshDatabase();
  const seeded = await seedActiveChain('number_chain', { channelId: CHANNEL_ID, enabled: true });
  const roundBefore = await withCoinDatabase((api) => api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [seeded.id]));

  const failing = createRuntime('number-same-channel-open-fault', rest,
    { faultPurpose: 'number-chain.reaction', faultLabel: 'open-reaction-fence' });
  let failure = null;
  await assert.rejects(startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_TWO_ID,
    target: 100, now: new Date(CUTOVER + 2_000) }), (error) => {
    failure = error;
    return error.code === 'REACTION_FENCE_OPEN_FAILED';
  });
  const paused = await withCoinDatabase((api) => ({
    round: api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [seeded.id]),
    rounds: Number(api.get('SELECT COUNT(*) AS count FROM number_chain_sessions WHERE guild_id = ?', [GUILD_ID]).count),
    setting: api.get(
      "SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'number_chain'",
      [GUILD_ID]
    ),
  }));
  assert.deepEqual(paused.round, roundBefore);
  assert.equal(paused.round.status, 'active');
  assert.equal(paused.rounds, 1);
  assert.deepEqual({ enabled: Number(paused.setting.enabled), channelId: paused.setting.channel_id },
    { enabled: 0, channelId: null });
  assert.equal(JSON.parse(paused.setting.config_json)._chainReaction, undefined);
  assert.equal(failing.runtime.isPurposeReady('number-chain.reaction'), false);
  assert.equal(failure.sessionKept, true);
  assert.match(failure.message, /進度已保留/u);
  await failing.runtime.stop();

  // With a working fence the same command resumes the very same round; the new target is ignored, not applied.
  const recovered = createRuntime('number-same-channel-open-recovered', rest);
  const resumed = await startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_TWO_ID,
    target: 7, now: new Date(CUTOVER + 3_000) });
  assert.equal(resumed.alreadyActive, true);
  assert.equal(resumed.session.id, seeded.id);
  assert.equal(resumed.session.status, 'active');
  assert.equal(resumed.session.revision, 0);
  assert.equal(resumed.session.expectedTarget, 100);
  const resumedState = await withCoinDatabase((api) => ({
    rounds: Number(api.get('SELECT COUNT(*) AS count FROM number_chain_sessions WHERE guild_id = ?', [GUILD_ID]).count),
    setting: api.get(
      "SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'number_chain'",
      [GUILD_ID]
    ),
  }));
  assert.equal(resumedState.rounds, 1);
  assert.deepEqual({ enabled: Number(resumedState.setting.enabled), channelId: resumedState.setting.channel_id },
    { enabled: 1, channelId: CHANNEL_ID });
  assert.equal(JSON.parse(resumedState.setting.config_json)._chainReaction.channelId, CHANNEL_ID);
  await recovered.runtime.stop();
});

const CHAIN_GAMES = Object.freeze({
  word_chain: Object.freeze({
    purposeId: 'word-chain.reaction',
    start: (channelId, at) => startWordChain({ guildId: GUILD_ID, channelId, actorId: USER_ID,
      seed: '地球', now: new Date(at) }),
    answer: (messageId, userId, content, at) => acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId, userId, content, now: new Date(at) }),
    firstAnswer: '球體',
    secondAnswer: '體育',
    deliver: (rest) => processWordChainReactionOutbox({ rest },
      { permissionCheck: () => true }),
  }),
  number_chain: Object.freeze({
    purposeId: 'number-chain.reaction',
    start: (channelId, at) => startNumberChain({ guildId: GUILD_ID, channelId, actorId: USER_ID, now: new Date(at) }),
    answer: (messageId, userId, content, at) => acceptNumberChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId, userId, content, now: new Date(at) }),
    firstAnswer: '1',
    secondAnswer: '2',
    deliver: (rest) => processNumberChainReactionOutbox({ rest },
      { permissionCheck: () => true }),
  }),
});

async function readChainState(featureKey) {
  const table = featureKey === 'word_chain' ? 'text_chain_sessions' : 'number_chain_sessions';
  return withCoinDatabase((api) => {
    const setting = api.get(
      'SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
      [GUILD_ID, featureKey]
    );
    return {
      round: api.get(`SELECT id, status, revision FROM ${table} WHERE guild_id = ? ORDER BY id DESC LIMIT 1`, [GUILD_ID]),
      setting: { enabled: Number(setting.enabled), channelId: setting.channel_id },
      authority: JSON.parse(setting.config_json)._chainReaction,
      reactionRows: Number(api.get(
        "SELECT COUNT(*) AS count FROM feature_outbox WHERE guild_id = ? AND feature_key = ? AND event_type = 'discord_reaction'",
        [GUILD_ID, featureKey]
      ).count),
    };
  });
}

// A healthy round, then the next process has no usable reaction purpose when an administrator runs start again in the
// same channel (pause), then the process restarts and the startup reconcile re-enables the setting.
async function pauseThenRestart(featureKey, name) {
  const game = CHAIN_GAMES[featureKey];
  await freshDatabase();
  let puts = 0;
  const rest = managedRest(async () => { puts += 1; return response(204); });
  const first = createRuntime(name, rest);
  await game.start(CHANNEL_ID, CUTOVER + 1_000);
  const healthy = await readChainState(featureKey);
  assert.deepEqual(healthy.setting, { enabled: 1, channelId: CHANNEL_ID });
  assert.equal(healthy.authority.revoked, false);
  await first.runtime.stop();

  configureChainReactionFence(null);
  await assert.rejects(game.start(CHANNEL_ID, CUTOVER + 2_000), (error) =>
    error.code === 'REACTION_FENCE_OPEN_FAILED' && error.sessionKept === true && error.previousRoundEnded === false);
  const paused = await readChainState(featureKey);
  assert.deepEqual(paused.round, healthy.round, 'the round itself is untouched');
  assert.deepEqual(paused.setting, { enabled: 0, channelId: null });
  assert.deepEqual(paused.authority, healthy.authority, 'the reaction authority is kept, not revoked or deleted');

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const restarted = await readChainState(featureKey);
  assert.deepEqual(restarted.setting, { enabled: 1, channelId: CHANNEL_ID }, 'the reconcile re-enables the round');
  assert.deepEqual(restarted.authority, healthy.authority, 'and the kept authority survives the restart');
  assert.deepEqual(restarted.round, healthy.round);
  return { game, rest, first, healthy, puts: () => puts };
}

for (const featureKey of ['word_chain', 'number_chain']) {
  test(`${featureKey}: a paused round gets its reaction back after a restart once the fence verifies`, async () => {
    const context = await pauseThenRestart(featureKey, `resume-${featureKey}`);
    const second = createRuntime(`resume-${featureKey}-restarted`, context.rest, { ledgers: context.first.ledgers });
    assert.equal(second.runtime.getReactionFence(context.game.purposeId, GUILD_ID).generation,
      context.healthy.authority.generation);

    const messageId = snowflake(CUTOVER + 3_000, 61n);
    const answer = await context.game.answer(messageId, USER_ID, context.game.firstAnswer, CUTOVER + 3_000);

    assert.equal(answer.ok, true);
    assert.ok(answer.reactionSource, 'the answer carries a reaction source');
    assert.equal((await readChainState(featureKey)).reactionRows, 1, 'and the reaction is queued');
    const delivered = await context.game.deliver(context.rest);
    assert.equal(delivered.delivered, 1);
    assert.equal(context.puts(), 1, 'and it is really sent');
    await second.runtime.stop();
  });

  test(`${featureKey}: a paused round queues no reaction after a restart while the reaction purpose is unavailable`, async () => {
    const context = await pauseThenRestart(featureKey, `unavailable-${featureKey}`);

    // Still no usable runtime: the process came back without the purpose.
    const withoutRuntime = await context.game.answer(
      snowflake(CUTOVER + 3_000, 62n), USER_ID, context.game.firstAnswer, CUTOVER + 3_000);
    assert.equal(withoutRuntime.ok, true, 'the answer itself is still accepted');
    assert.equal(withoutRuntime.reactionSource, null);

    // A runtime exists but its purpose was disabled (retained lock): same outcome.
    const disabled = createRuntime(`unavailable-${featureKey}-disabled`, context.rest, { ledgers: context.first.ledgers });
    disabled.runtime.disablePurpose(context.game.purposeId, { retainLock: true, code: 'SYNTHETIC_UNAVAILABLE' });
    assert.equal(disabled.runtime.isPurposeReady(context.game.purposeId), false);
    const withDisabledPurpose = await context.game.answer(
      snowflake(CUTOVER + 4_000, 63n), USER_TWO_ID, context.game.secondAnswer, CUTOVER + 4_000);
    assert.equal(withDisabledPurpose.ok, true);
    assert.equal(withDisabledPurpose.reactionSource, null);

    const after = await readChainState(featureKey);
    assert.equal(after.reactionRows, 0, 'no reaction row exists at all');
    assert.equal(after.round.revision, context.healthy.round.revision + 2);
    assert.deepEqual(after.authority, context.healthy.authority, 'the kept authority is not touched either');
    assert.equal(context.puts(), 0);
    await disabled.runtime.stop();
  });

  test(`${featureKey}: a paused round queues no reaction after a restart when the ledger fence no longer matches`, async () => {
    const context = await pauseThenRestart(featureKey, `closed-${featureKey}`);
    const second = createRuntime(`closed-${featureKey}-restarted`, context.rest, { ledgers: context.first.ledgers });
    assert.equal(second.runtime.closeReactionFence(context.game.purposeId, GUILD_ID).kind, 'closed');

    const answer = await context.game.answer(
      snowflake(CUTOVER + 3_000, 64n), USER_ID, context.game.firstAnswer, CUTOVER + 3_000);

    assert.equal(answer.ok, true);
    assert.equal(answer.reactionSource, null);
    assert.equal((await readChainState(featureKey)).reactionRows, 0);
    assert.equal(context.puts(), 0);
    await second.runtime.stop();
  });

  test(`${featureKey}: switching channels away from a paused round closes exactly the fence generation it kept`, async () => {
    const game = CHAIN_GAMES[featureKey];
    const table = featureKey === 'word_chain' ? 'text_chain_sessions' : 'number_chain_sessions';
    await freshDatabase();
    const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
    const state = createRuntime(`switch-paused-${featureKey}`, rest);
    await game.start(CHANNEL_ID, CUTOVER + 1_000);
    const healthy = await readChainState(featureKey);

    configureChainReactionFence(null);
    await assert.rejects(game.start(CHANNEL_ID, CUTOVER + 2_000), (error) => error.sessionKept === true);
    configureChainReactionFence(state.runtime);

    const closes = [];
    const closeReactionFence = state.runtime.closeReactionFence.bind(state.runtime);
    state.runtime.closeReactionFence = (purposeId, guildId, expected) => {
      const result = closeReactionFence(purposeId, guildId, expected);
      closes.push({ expected, kind: result.kind });
      return result;
    };
    const switched = await game.start(CHANNEL_TWO_ID, CUTOVER + 3_000);

    assert.equal(switched.alreadyActive, false);
    assert.deepEqual(closes, [{
      expected: { channelId: CHANNEL_ID, generation: healthy.authority.generation },
      kind: 'closed',
    }]);
    const fence = state.runtime.getReactionFence(game.purposeId, GUILD_ID);
    assert.equal(fence.channelId, CHANNEL_TWO_ID);
    assert.equal(fence.open, true);
    assert.ok(fence.generation > healthy.authority.generation);
    const rounds = await withCoinDatabase((api) => api.all(
      `SELECT channel_id, status FROM ${table} WHERE guild_id = ? ORDER BY id`, [GUILD_ID]
    ));
    assert.deepEqual(rounds, [
      { channel_id: CHANNEL_ID, status: 'stopped' },
      { channel_id: CHANNEL_TWO_ID, status: 'active' },
    ]);
    await state.runtime.stop();
  });
}

test('a new round or a channel switch whose fence cannot open still fails closed and retires every round it touched', async () => {
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  for (const [featureKey, table, purposeId, start] of [
    ['word_chain', 'text_chain_sessions', 'word-chain.reaction', (channelId) => startWordChain({
      guildId: GUILD_ID, channelId, actorId: USER_ID, seed: '地球', now: new Date(CUTOVER + 2_000) })],
    ['number_chain', 'number_chain_sessions', 'number-chain.reaction', (channelId) => startNumberChain({
      guildId: GUILD_ID, channelId, actorId: USER_ID, target: 100, now: new Date(CUTOVER + 2_000) })],
  ]) {
    const rounds = () => withCoinDatabase((api) => api.all(
      `SELECT channel_id, status FROM ${table} WHERE guild_id = ? ORDER BY id`, [GUILD_ID]
    ));
    const setting = () => withCoinDatabase((api) => {
      const row = api.get(
        'SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [GUILD_ID, featureKey]
      );
      return { enabled: Number(row.enabled), channel_id: row.channel_id };
    });

    await freshDatabase();
    const fresh = createRuntime(`closed-fresh-${featureKey}`, rest,
      { faultPurpose: purposeId, faultLabel: 'open-reaction-fence' });
    await assert.rejects(start(CHANNEL_ID), (error) =>
      error.code === 'REACTION_FENCE_OPEN_FAILED' && error.sessionKept === false &&
      error.previousRoundEnded === false);
    assert.deepEqual(await rounds(), [{ channel_id: CHANNEL_ID, status: 'stopped' }], `${featureKey} fresh`);
    assert.deepEqual(await setting(), { enabled: 0, channel_id: null }, `${featureKey} fresh`);
    await fresh.runtime.stop();

    await freshDatabase();
    await seedActiveChain(featureKey, { channelId: CHANNEL_ID, enabled: true });
    const switching = createRuntime(`closed-switch-${featureKey}`, rest,
      { faultPurpose: purposeId, faultLabel: 'open-reaction-fence' });
    await assert.rejects(start(CHANNEL_TWO_ID), (error) =>
      error.code === 'REACTION_FENCE_OPEN_FAILED' && error.sessionKept === false &&
      error.previousRoundEnded === true);
    assert.deepEqual(await rounds(), [
      { channel_id: CHANNEL_ID, status: 'stopped' },
      { channel_id: CHANNEL_TWO_ID, status: 'stopped' },
    ], `${featureKey} switch`);
    assert.deepEqual(await setting(), { enabled: 0, channel_id: null }, `${featureKey} switch`);
    await switching.runtime.stop();
  }
});

test('a failed DB disable after fence-open failure rejects without reporting a successful switch', async () => {
  await freshDatabase();
  await seedActiveChain('word_chain', { channelId: CHANNEL_ID, enabled: true });
  await withCoinTransaction((api) => api.run(
    `CREATE TRIGGER fail_chain_disable BEFORE UPDATE ON feature_guild_settings
       WHEN OLD.guild_id = '${GUILD_ID}' AND OLD.feature_key = 'word_chain' AND NEW.enabled = 0
       BEGIN SELECT RAISE(ABORT, 'synthetic chain disable failure'); END`
  ));
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  const state = createRuntime('open-fault-disable-write', rest,
    { faultPurpose: 'word-chain.reaction', faultLabel: 'open-reaction-fence' });
  await assert.rejects(startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_TWO_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 2_000) }), /synthetic chain disable failure/u);
  const setting = await withCoinDatabase((api) => api.get(
    "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
    [GUILD_ID]
  ));
  assert.deepEqual(setting, { enabled: 1, channel_id: CHANNEL_ID });
  assert.equal(state.runtime.isPurposeReady('word-chain.reaction'), false);
  await state.runtime.stop();
});

test('stopping completed channel A cannot disable or revoke a newer active channel B', async () => {
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  for (const featureKey of ['word_chain', 'number_chain']) {
    await freshDatabase();
    const state = createRuntime(`stale-completed-stop-${featureKey}`, rest);
    if (featureKey === 'word_chain') {
      await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
        seed: '一一', now: new Date(CUTOVER + 1_000) });
      await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
        messageId: snowflake(CUTOVER + 2_000, 71n), userId: USER_ID, content: '一樹百穫',
        now: new Date(CUTOVER + 2_000) });
      await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_TWO_ID, actorId: USER_ID,
        seed: '地球', now: new Date(CUTOVER + 3_000) });
    } else {
      const first = await startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID,
        actorId: USER_ID, target: 100, now: new Date(CUTOVER + 1_000) });
      await withCoinTransaction((api) => api.run(
        'UPDATE number_chain_sessions SET expected_target = ? WHERE id = ?', [MAX_TARGET, first.session.id]
      ));
      await acceptNumberChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
        messageId: snowflake(CUTOVER + 2_000, 72n), userId: USER_ID, content: String(MAX_TARGET),
        now: new Date(CUTOVER + 2_000) });
      await startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_TWO_ID,
        actorId: USER_ID, target: 100, now: new Date(CUTOVER + 3_000) });
    }
    const purposeId = featureKey === 'word_chain' ? 'word-chain.reaction' : 'number-chain.reaction';
    const table = featureKey === 'word_chain' ? 'text_chain_sessions' : 'number_chain_sessions';
    const before = await withCoinDatabase((api) => ({
      setting: api.get('SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
        [GUILD_ID, featureKey]),
      session: api.get(`SELECT id, status FROM ${table} WHERE guild_id = ? AND channel_id = ? ORDER BY id DESC LIMIT 1`,
        [GUILD_ID, CHANNEL_TWO_ID]),
    }));
    const fence = state.runtime.getReactionFence(purposeId, GUILD_ID);
    const stopped = featureKey === 'word_chain'
      ? await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
        now: new Date(CUTOVER + 4_000) })
      : await stopNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
        now: new Date(CUTOVER + 4_000) });
    const after = await withCoinDatabase((api) => ({
      setting: api.get('SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
        [GUILD_ID, featureKey]),
      session: api.get(`SELECT id, status FROM ${table} WHERE guild_id = ? AND channel_id = ? ORDER BY id DESC LIMIT 1`,
        [GUILD_ID, CHANNEL_TWO_ID]),
    }));
    assert.deepEqual(stopped, { stopped: false, reactionRevoked: false, session: null });
    assert.deepEqual(after, before);
    assert.deepEqual(state.runtime.getReactionFence(purposeId, GUILD_ID), fence);
    await state.runtime.stop();
  }
});

test('reaction fences enforce 1024 guilds, preserve existing close, and count fence bytes toward the ledger cap', () => {
  const ledgers = initializeLedgers('fence-capacity');
  let ledger = openPublicPurposeLedger({
    ...ledgers['word-chain.reaction'],
    expectedPurposeIdentity: {
      purposeId: 'word-chain.reaction',
      botId: BOT_ID,
      sourceNamespace: 'discord.messageCreate',
    },
    now: () => CUTOVER + 10_000,
  });
  for (let index = 0; index < MAX_REACTION_FENCES; index += 1) {
    ledger.openReactionFence({
      guildId: (10_000_000_000_000_000n + BigInt(index)).toString(),
      channelId: (20_000_000_000_000_000n + BigInt(index)).toString(),
      sessionKey: `word-chain.reaction|${index}`,
    });
  }
  assert.throws(() => ledger.openReactionFence({
    guildId: '30000000000000000',
    channelId: '30000000000000001',
    sessionKey: 'word-chain.reaction|overflow',
  }), (error) => error.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED');
  assert.equal(ledger.closeReactionFence('10000000000000000').kind, 'closed');
  assert.equal(Object.keys(ledger.getSnapshotForTests().reactionFences).length, MAX_REACTION_FENCES);
  assert.ok(ledger.storageBytes() < MAX_LEDGER_BYTES);
  ledger.close();
  ledger = openPublicPurposeLedger({
    ...ledgers['word-chain.reaction'],
    expectedPurposeIdentity: {
      purposeId: 'word-chain.reaction',
      botId: BOT_ID,
      sourceNamespace: 'discord.messageCreate',
    },
    now: () => CUTOVER + 10 * 365 * 86_400_000,
  });
  assert.equal(Object.keys(ledger.getSnapshotForTests().reactionFences).length, MAX_REACTION_FENCES);
  assert.throws(() => ledger.openReactionFence({
    guildId: '30000000000000000',
    channelId: '30000000000000001',
    sessionKey: 'word-chain.reaction|still-full-after-restart',
  }), (error) => error.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED');
  ledger.close();

  const byteLedgers = initializeLedgers('fence-byte-capacity');
  const byteLedger = openPublicPurposeLedger({
    ...byteLedgers['number-chain.reaction'],
    expectedPurposeIdentity: {
      purposeId: 'number-chain.reaction',
      botId: BOT_ID,
      sourceNamespace: 'discord.messageCreate',
    },
  });
  // The SQLite store refuses a growth write once its live pages exceed the soft limit.
  byteLedger.maximumLedgerBytes = byteLedger.storageBytes() - 1;
  assert.throws(() => byteLedger.openReactionFence({
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    sessionKey: 'number-chain.reaction|byte-cap',
  }), (error) => error.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED');
  assert.equal(byteLedger.getReactionFence(GUILD_ID), null);
  byteLedger.close();
});

test('public runtime queue is bounded to 128 with one worker and no queued dispatch during stop', async () => {
  await freshDatabase();
  const rest = { options: { retries: 0 }, post: async () => { throw new Error('must not send'); }, put: async () => {} };
  const state = createRuntime('public-queue-capacity', rest);
  const records = await withCoinTransaction((api) => {
    const items = [];
    for (let index = 0; index < QUEUE_LIMIT + 2; index += 1) {
      const createdAt = new Date(CUTOVER + 1_000 + index).toISOString();
      api.run(
        `INSERT INTO coin_work_penalties
          (guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
           daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
         VALUES (?, ?, 1, '測試職業', 'synthetic', ?, '2023-11-14', 1000, 250, 'active',
                 '合成測試', ?, ?, ?)`,
        [GUILD_ID, USER_ID, CHANNEL_ID, new Date(CUTOVER + 86_400_000).toISOString(), createdAt, createdAt]
      );
      const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
      const penalty = { id, userId: USER_ID, jobName: '測試職業', penaltyAmount: 250,
        reason: '合成測試', appealDeadlineAt: new Date(CUTOVER + 86_400_000).toISOString() };
      const effect = { purposeId: 'work.penalty.announce', action: 'work-penalty-message.create',
        target: CHANNEL_ID, method: 'POST', route: `/channels/${CHANNEL_ID}/messages`,
        body: buildWorkPenaltyAnnouncementBody(penalty) };
      const proof = proveWorkPenaltySourceWithApi(api, { botId: BOT_ID, guildId: GUILD_ID,
        penaltyId: id, createdAt, effect });
      items.push({ effect, grant: state.authority.createIssuer().issuePenalty(proof, effect) });
    }
    return items;
  });
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = state.runtime.dispatch(records[0].grant, records[0].effect, {
    beforeAttempt: async (begin) => { begin(); entered(); await gate; },
  });
  await enteredPromise;
  const queued = records.slice(1).map((record) => state.runtime.dispatch(record.grant, record.effect,
    { beforeAttempt: (begin) => begin() }));
  assert.equal(state.runtime.slots.get('work.penalty.announce').queue.length, QUEUE_LIMIT);
  assert.equal(WORKER_CONCURRENCY, 1);
  // The overflow is back-pressure: retryable, and nothing is remembered that could settle it.
  assert.equal((await queued.at(-1)).kind, 'retryable_before_attempt');
  const stopping = state.runtime.stop();
  release();
  // Stopped after its begin() and before the network: nothing written, unavailable.
  assert.equal((await first).kind, 'unavailable');
  await stopping;
  const remaining = await Promise.all(queued.slice(0, -1));
  assert.ok(remaining.every((outcome) => outcome.kind === 'unavailable'));
});

test('word and number outbox claims and expired leases remain isolated despite a shared event type', async () => {
  await freshDatabase();
  const at = new Date(CUTOVER + 1_000);
  await enqueueFeatureOutbox({ guildId: GUILD_ID, featureKey: 'word_chain', eventType: 'discord_reaction',
    dedupeKey: 'word-one', payload: { synthetic: 'word' }, availableAt: at, now: at });
  await enqueueFeatureOutbox({ guildId: GUILD_ID, featureKey: 'number_chain', eventType: 'discord_reaction',
    dedupeKey: 'number-one', payload: { synthetic: 'number' }, availableAt: at, now: at });
  const word = await claimFeatureOutbox({ workerId: 'word-worker', eventType: 'discord_reaction',
    featureKey: 'word_chain', limit: 10, leaseMs: 1_000, now: at });
  const number = await claimFeatureOutbox({ workerId: 'number-worker', eventType: 'discord_reaction',
    featureKey: 'number_chain', limit: 10, leaseMs: 1_000, now: at });
  assert.deepEqual(word.map((event) => event.featureKey), ['word_chain']);
  assert.deepEqual(number.map((event) => event.featureKey), ['number_chain']);

  const later = new Date(at.getTime() + 1_001);
  const reclaimedWord = await claimFeatureOutbox({ workerId: 'word-worker-2', eventType: 'discord_reaction',
    featureKey: 'word_chain', limit: 10, leaseMs: 1_000, now: later });
  assert.deepEqual(reclaimedWord.map((event) => event.featureKey), ['word_chain']);
  const untouchedNumber = await withCoinDatabase((api) => api.get(
    "SELECT status, claimed_by FROM feature_outbox WHERE feature_key = 'number_chain' AND dedupe_key = 'number-one'"
  ));
  assert.deepEqual(untouchedNumber, { status: 'processing', claimed_by: 'number-worker' });
  const reclaimedNumber = await claimFeatureOutbox({ workerId: 'number-worker-2', eventType: 'discord_reaction',
    featureKey: 'number_chain', limit: 10, leaseMs: 1_000, now: later });
  assert.deepEqual(reclaimedNumber.map((event) => event.featureKey), ['number_chain']);
});

test('250-row penalty keyset scanning stays bounded and reaches retryable rows without starving newer work', async () => {
  await freshDatabase();
  await withCoinTransaction((api) => {
    for (let index = 0; index < 260; index += 1) {
      const createdAt = new Date(CUTOVER + 1_000 + index).toISOString();
      api.run(
        `INSERT INTO coin_work_penalties
          (guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
           daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
         VALUES (?, ?, 1, '測試職業', 'synthetic', ?, '2023-11-14', 1000, 250, 'active',
                 '合成測試', ?, ?, ?)`,
        [GUILD_ID, USER_ID, CHANNEL_ID, new Date(CUTOVER + 86_400_000).toISOString(), createdAt, createdAt]
      );
    }
  });

  let lowerCalls = 0;
  const rest = managedRest(async () => {
    lowerCalls += 1;
    if (lowerCalls <= 3) throw new Error('synthetic accepted but response lost');
    return response(200, {
      id: snowflake(CUTOVER + 10_000 + lowerCalls, BigInt(lowerCalls)),
      channel_id: CHANNEL_ID,
    });
  });
  const state = createRuntime('penalty-keyset', rest);
  const channel = { id: CHANNEL_ID, isTextBased: () => true, isSendable: () => true };
  const guild = { channels: { fetch: async () => channel, cache: { find: () => channel } } };
  let transientGuildMisses = 2;
  const client = {
    user: { id: BOT_ID },
    rest,
    guilds: { fetch: async () => transientGuildMisses-- > 0 ? null : guild },
    testControlRuntimeController: { isStopping: () => false },
  };
  let announced = 0;
  let maxChecked = 0;
  for (let round = 0; round < 40; round += 1) {
    const summary = await processWorkPenaltyAnnouncements(client, {
      guildId: GUILD_ID,
      limit: 10,
    });
    assert.ok(summary.checked <= 250);
    assert.ok(summary.dispatched <= 10);
    maxChecked = Math.max(maxChecked, summary.checked);
    announced += summary.announced;
    const persisted = await withCoinDatabase((api) => Number(api.get(
      'SELECT COUNT(*) AS count FROM coin_work_penalties WHERE announced_at IS NOT NULL'
    ).count));
    if (lowerCalls === 260 && persisted === 257) break;
  }
  assert.equal(maxChecked, 250);
  assert.equal(lowerCalls, 260);
  assert.equal(announced, 257);
  const final = await withCoinDatabase((api) => ({
    announced: Number(api.get('SELECT COUNT(*) AS count FROM coin_work_penalties WHERE announced_at IS NOT NULL').count),
    unresolved: Number(api.get("SELECT COUNT(*) AS count FROM coin_work_penalties WHERE status = 'active' AND announced_at IS NULL").count),
  }));
  assert.deepEqual(final, { announced: 257, unresolved: 3 });
  await state.runtime.stop();
});
