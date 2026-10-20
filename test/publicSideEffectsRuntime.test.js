'use strict';

// Runtime failure semantics of the public side-effect ledgers: a ledger that fails
// or is quarantined makes its purpose unavailable, never terminal; reaction-fence failures
// quarantine at once; and the escalations that test-control would hide end the process
// with a distinct exit code.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, StatementSync } = require('node:sqlite');

const { makeRealTempDir } = require('./support/realTempDir');
const root = makeRealTempDir('xiaoji-public-effect-runtime-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const {
  deadLetterFeatureOutbox,
  enqueueFeatureOutboxWithApi,
  expireFeatureOutbox,
  retryFeatureOutbox,
} = require('../src/services/featurePlatformService');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const {
  closeFence,
  configureChainReactionFence,
  inactiveReactionAuthority,
  noteInactiveReactionAuthority,
  proveReactionSourceWithApi,
} = require('../src/systems/safety/chainReactionFence');
const { STATEMENT_SQL } = require('../src/systems/safety/ledgerStore');
const {
  LEDGER_ESCALATION_EXIT_CODE,
  describeLedgerFailure,
  formatLedgerFailure,
  reportLedgerEscalations,
  settleLedgerShutdown,
  shutdownExitCode,
} = require('../src/systems/safety/ledgerEscalation');
const {
  PREPARE_RETRY_AFTER_MS,
  normalizeBinding,
  pathsFor,
} = require('../src/systems/safety/sideEffectLedger');
const { initializePublicLedgers, ledgerIdFor, openPublicLedgers } = require('./fixtures/publicLedgers');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const {
  PublicSideEffectRuntime,
  PURPOSES,
  QUEUE_LIMIT,
  buildPublicOperation,
  operationIdFor,
} = require('../src/systems/safety/publicSideEffectRuntime');
const { WelcomeSideEffectRuntime, buildWelcomeOperation } = require('../src/systems/safety/welcomeSideEffectRuntime');
const { OwnerSafetyNotifier, buildOperation: buildOwnerNotice } = require('../src/systems/safety/ownerSafetyNotifier');
const {
  buildWorkPenaltyAnnouncementBody,
  proveWorkPenaltySourceWithApi,
} = require('../src/systems/safety/workPenaltySource');
const { sendWorkPenaltyAnnouncement } = require('../src/systems/work/workService');
const logger = require('../src/utils/logger');
const {
  MAX_REACTION_DELIVERY_ATTEMPTS,
  REACTION_OUTBOX_MAX_AGE_MS,
  UNAVAILABLE_EXPIRE_LIMIT,
  buildReactionEffect,
  dispatchChainReaction,
  dispatchImmediateChainReaction,
} = require('../src/services/chainReactionDelivery');
const {
  acceptWordChainMessage,
  describeWordChainStatus,
  getWordChainStatus,
  processWordChainReactionOutbox,
  startWordChain,
  stopWordChain,
} = require('../src/services/wordChainService');
const {
  acceptNumberChainMessage,
  describeNumberChainStatus,
  getNumberChainStatus,
  startNumberChain,
} = require('../src/services/numberChainService');
const { corpusVersion } = require('../src/services/wordChainLexicon');

const DISCORD_EPOCH = 1_420_070_400_000n;
const CUTOVER = 1_700_000_000_000;
const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const CHANNEL_ID = '10000000000000003';
const USER_ID = '10000000000000004';
const CHANNEL_TWO_ID = '10000000000000006';
const PENALTY = 'work.penalty.announce';
const WORD = 'word-chain.reaction';
const NUMBER = 'number-chain.reaction';

function snowflake(timestamp, increment = 1n) {
  return (((BigInt(timestamp) - DISCORD_EPOCH) << 22n) + increment).toString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function initializeLedgers(name) {
  return initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER });
}

function ledgerPathOf(ledgers, purposeId) {
  return ledgers[purposeId].filePath;
}

function recordingRest() {
  const calls = [];
  return {
    calls,
    options: { retries: 0 },
    put: async (route) => { calls.push(['PUT', route]); return {}; },
    post: async (route) => {
      calls.push(['POST', route]);
      return { id: snowflake(CUTOVER + 5_000, BigInt(calls.length)), channel_id: route.split('/')[2] };
    },
  };
}

// A runtime given the ledgers the way the bootstrap delivers them, and armed as index.js
// does at ready.
function createRuntime(name, { rest = recordingRest(), ledgers = initializeLedgers(name), faultInjector = null,
  clock = { value: CUTOVER + 10_000 }, egressLimiter = null, authority = createPublicEffectAuthority() } = {}) {
  const logs = [];
  const runtime = new PublicSideEffectRuntime({
    client: { rest: createSyntheticRest(rest), egressLimiter },
    botId: BOT_ID,
    env: {},
    now: () => clock.value,
    effectAuthority: authority,
    logger: { warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)), info() {} },
  });
  const delivered = openPublicLedgers(ledgers, { botId: BOT_ID, now: () => clock.value,
    faultInjectorFor: () => faultInjector });
  const preflight = runtime.preflight({ ledgers: delivered });
  runtime.arm();
  configurePublicEffectAdapter({ publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer() });
  configureChainReactionFence(runtime);
  return { authority, runtime, ledgers, delivered, logs, clock, rest, preflight };
}

function ledgerOf(state, purposeId) {
  return state.runtime.slots.get(purposeId).ledger;
}

// Makes reads of one purpose's ledger fail inside SQLite, through the statement the store
// prepared: a disk I/O error (SQLite IOERR), or a row whose stored digest no longer matches
// (the store reports LEDGER_CORRUPT). Reads of every other purpose are untouched.
function failLedgerReads(t, { purposeId, statement = 'selectOperation', kind = 'ioerr', skip = 0 }) {
  const original = StatementSync.prototype.get;
  const state = { armed: true, failures: 0 };
  let seen = 0;
  StatementSync.prototype.get = function failingGet(...args) {
    if (state.armed && this.sourceSQL === STATEMENT_SQL[statement] && args[0] === purposeId) {
      seen += 1;
      if (seen > skip) {
        state.failures += 1;
        if (kind === 'corrupt') {
          return { ...original.apply(this, args), binding_json: '{}', binding_digest: '0'.repeat(64) };
        }
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10, errstr: 'disk I/O error' });
      }
    }
    return original.apply(this, args);
  };
  const restore = () => { StatementSync.prototype.get = original; };
  t.after(restore);
  state.restore = restore;
  return state;
}

const EXPECTED_CAUSE = Object.freeze({
  corrupt: 'cause=SIDE_EFFECT_FILE_CORRUPT',
  ioerr: 'cause=SIDE_EFFECT_PERSIST_FAILED sqlite=IOERR',
});

// No log line may carry a path, a ledger ID, or any text beyond fixed codes.
function assertCodesOnly(lines) {
  for (const line of lines) {
    assert.equal(line.includes(root), false, line);
    assert.equal(/[A-Za-z]:\\|\/tmp\/|ledger\.json|witness\.json/u.test(line), false, line);
  }
}

async function freshDatabase() {
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
}

let nextPenaltyId = 1;

async function seedPenalty({ createdAt = null, appealDeadlineAt = new Date(CUTOVER + 86_400_000).toISOString() } = {}) {
  const id = nextPenaltyId;
  nextPenaltyId += 1;
  createdAt ??= new Date(CUTOVER + 1_000 + id).toISOString();
  const penalty = { id, userId: USER_ID, jobName: '測試職業', penaltyAmount: 250, reason: '合成測試',
    appealDeadlineAt, createdAt };
  await withCoinTransaction((api) => api.run(
    `INSERT INTO coin_work_penalties
      (id, guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
       daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'synthetic', ?, '2023-11-14', 1000, ?, 'active', ?, ?, ?, ?)`,
    [id, GUILD_ID, USER_ID, penalty.jobName, CHANNEL_ID, penalty.penaltyAmount, penalty.reason,
      penalty.appealDeadlineAt, createdAt, createdAt]
  ));
  return penalty;
}

// One penalty announcement through the public runtime, with a fresh DB-backed grant.
async function dispatchPenalty(state, penalty, { channelId = CHANNEL_ID, beforeAttempt = (begin) => begin() } = {}) {
  const effect = {
    purposeId: PENALTY,
    action: 'work-penalty-message.create',
    target: channelId,
    method: 'POST',
    route: `/channels/${channelId}/messages`,
    body: buildWorkPenaltyAnnouncementBody(penalty),
  };
  const proof = await withCoinTransaction((api) => proveWorkPenaltySourceWithApi(api, {
    botId: BOT_ID, guildId: GUILD_ID, penaltyId: penalty.id, createdAt: penalty.createdAt, effect,
  }));
  const grant = state.authority.createIssuer().issuePenalty(proof, effect);
  assert.ok(grant, 'the synthetic penalty must be provable');
  return state.runtime.dispatch(grant, effect, { beforeAttempt });
}

test('a full egress window defers a public effect before it claims or writes its ledger', async () => {
  await freshDatabase();
  const clock = { value: CUTOVER + 10_000 };
  const limiter = createEgressLimiter({ now: () => clock.value });
  const request = { method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'synthetic' } };
  for (let index = 0; index < 20; index += 1) limiter.admit(request);
  const rest = recordingRest();
  const state = createRuntime('egress-before-claim', { rest, clock, egressLimiter: limiter });
  const penalty = await seedPenalty();
  const result = await dispatchPenalty(state, penalty);
  assert.equal(result.kind, 'deferred');
  assert.deepEqual(rest.calls, []);
  assert.equal(Object.keys(ledgerOf(state, PENALTY).getSnapshotForTests().operations).length, 0);
  await state.runtime.stop();
});

// An active round from before the reaction ledger existed: no stored authority to verify.
async function seedLegacyRound(featureKey) {
  const createdAt = new Date(CUTOVER + 1_000).toISOString();
  await withCoinTransaction((api) => {
    if (featureKey === 'word_chain') {
      api.run(
        `INSERT INTO text_chain_sessions
          (guild_id, channel_id, status, corpus_version, current_word, last_word, last_user_id,
           revision, started_by, created_at, updated_at)
         VALUES (?, ?, 'active', ?, '地球', '地球', NULL, 0, ?, ?, ?)`,
        [GUILD_ID, CHANNEL_ID, corpusVersion, USER_ID, createdAt, createdAt]
      );
    } else {
      api.run(
        `INSERT INTO number_chain_sessions
          (guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, created_at, updated_at)
         VALUES (?, ?, 'active', 1, NULL, 0, ?, ?, ?)`,
        [GUILD_ID, CHANNEL_ID, USER_ID, createdAt, createdAt]
      );
    }
    const config = featureKey === 'word_chain' ? { corpusVersion } : { parserVersion: 'rational-v1' };
    api.run(
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [GUILD_ID, featureKey, CHANNEL_ID, JSON.stringify(config), createdAt, createdAt]
    );
  });
}

test.after(() => {
  configureChainReactionFence(null);
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test('a failed or quarantined ledger makes its purpose unavailable at once, whether the facade or the store failed', async (t) => {
  const state = createRuntime('ready-state');
  assert.deepEqual(state.preflight.disabled, []);
  assert.equal(state.runtime.isPurposeReady(PENALTY), true);

  // A read that failed elsewhere leaves only the store marked failed.
  const reads = failLedgerReads(t, { purposeId: PENALTY });
  assert.throws(() => ledgerOf(state, PENALTY).getOperation('synthetic-operation'),
    (error) => error.code === 'SIDE_EFFECT_PERSIST_FAILED');
  reads.restore();
  assert.equal(ledgerOf(state, PENALTY).failed, true);
  assert.equal(state.runtime.isPurposeReady(PENALTY), false);
  assert.ok(state.logs.includes(`[PUBLIC_EFFECT] purpose=${PENALTY} code=LEDGER_FAILED`), state.logs.join('\n'));

  // A quarantine through the facade is seen the same way.
  ledgerOf(state, 'audit.guild.leave').quarantine('SYNTHETIC_REVIEW');
  assert.equal(state.runtime.isPurposeReady('audit.guild.leave'), false);
  assert.ok(state.logs.includes('[PUBLIC_EFFECT] purpose=audit.guild.leave code=LEDGER_QUARANTINED'));
  assert.equal(state.runtime.isPurposeReady(WORD), true, 'other purposes are untouched');
  assert.equal(state.runtime.getCutoverSourceTimestampMs(PENALTY), null);
  await state.runtime.stop();
});

for (const kind of ['corrupt', 'ioerr']) {
  test(`a ${kind} read while verifying a dispatch is unavailable, never terminal, and names its code`, async (t) => {
    await freshDatabase();
    const penalty = await seedPenalty();
    const state = createRuntime(`dispatch-read-${kind}`);
    failLedgerReads(t, { purposeId: PENALTY, kind });
    const outcome = await dispatchPenalty(state, penalty);
    assert.equal(outcome.kind, 'unavailable');
    assert.deepEqual(state.rest.calls, []);
    assert.equal(state.runtime.isPurposeReady(PENALTY), false);
    assert.equal(state.runtime.isPurposeReady('audit.guild.leave'), true);
    assert.ok(state.logs.includes(`[PUBLIC_EFFECT] purpose=${PENALTY} code=VERIFY_FAILED ${EXPECTED_CAUSE[kind]}`),
      state.logs.join('\n'));
    // Every later dispatch of the purpose stays unavailable without touching the ledger.
    assert.equal((await dispatchPenalty(state, await seedPenalty())).kind, 'unavailable');
    assertCodesOnly(state.logs);
    await state.runtime.stop();
  });

  test(`a ${kind} read while inspecting a source is unavailable and disables only that purpose`, async (t) => {
    const state = createRuntime(`inspect-read-${kind}`);
    failLedgerReads(t, { purposeId: PENALTY, kind });
    const inspected = state.runtime.inspectSource({ purposeId: PENALTY, botId: BOT_ID,
      sourceNamespace: 'db.coin_work_penalties', guildId: GUILD_ID, penaltyId: 1,
      createdAt: new Date(CUTOVER + 1_000).toISOString(), sourceTimestampMs: CUTOVER + 1_000 });
    assert.deepEqual(inspected, { kind: 'unavailable' });
    assert.equal(state.runtime.isPurposeReady(PENALTY), false);
    assert.equal(state.runtime.isPurposeReady('audit.guild.leave'), true);
    assert.ok(state.logs.includes(`[PUBLIC_EFFECT] purpose=${PENALTY} code=INSPECT_FAILED ${EXPECTED_CAUSE[kind]}`),
      state.logs.join('\n'));
    await state.runtime.stop();
  });
}

test('only a conflicting binding is terminal, and it leaves the purpose ready', async () => {
  await freshDatabase();
  const penalty = await seedPenalty();
  const state = createRuntime('binding-conflict');
  assert.equal((await dispatchPenalty(state, penalty)).kind, 'confirmed');
  // The same announcement aimed at another channel is the same operation with another binding.
  const conflict = await dispatchPenalty(state, penalty, { channelId: CHANNEL_TWO_ID });
  assert.equal(conflict.kind, 'terminal');
  assert.equal(state.runtime.isPurposeReady(PENALTY), true);
  assert.equal(state.rest.calls.length, 1);
  await state.runtime.stop();
});

test('fence reads that fail disable the purpose and answer null; a malformed guild ID does not', async (t) => {
  const state = createRuntime('fence-reads');
  assert.equal(state.runtime.getReactionFence(WORD, 'not-a-guild'), null);
  assert.equal(state.runtime.isPurposeReady(WORD), true);

  const wordReads = failLedgerReads(t, { purposeId: WORD, statement: 'selectFence' });
  assert.equal(state.runtime.getReactionFence(WORD, GUILD_ID), null);
  wordReads.restore();
  assert.equal(state.runtime.isPurposeReady(WORD), false);
  assert.ok(state.logs.includes(`[PUBLIC_EFFECT] purpose=${WORD} code=REACTION_FENCE_READ_FAILED ${EXPECTED_CAUSE.ioerr}`),
    state.logs.join('\n'));

  failLedgerReads(t, { purposeId: NUMBER, statement: 'selectFence' });
  assert.equal(state.runtime.verifyReactionFence(NUMBER, { guildId: GUILD_ID, channelId: CHANNEL_ID,
    sessionKey: 'synthetic', generation: 1, sourceFence: 'a'.repeat(64) }), null);
  assert.equal(state.runtime.isPurposeReady(NUMBER), false);
  await state.runtime.stop();
});

for (const featureKey of ['word_chain', 'number_chain']) {
  test(`${featureKey}: a legacy round whose fence read fails still accepts the answer and adopts nothing`, async (t) => {
    await freshDatabase();
    await seedLegacyRound(featureKey);
    const purposeId = featureKey === 'word_chain' ? WORD : NUMBER;
    const state = createRuntime(`adopt-read-${featureKey}`);
    failLedgerReads(t, { purposeId, statement: 'selectFence' });
    const messageId = snowflake(CUTOVER + 2_000, 7n);
    const accepted = featureKey === 'word_chain'
      ? await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID, messageId, userId: USER_ID,
        content: '球體', now: new Date(CUTOVER + 2_000) })
      : await acceptNumberChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID, messageId, userId: USER_ID,
        content: '1', now: new Date(CUTOVER + 2_000) });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.reactionSource, null);
    assert.equal(state.runtime.isPurposeReady(purposeId), false);
    const stored = await withCoinDatabase((api) => ({
      config: JSON.parse(api.get('SELECT config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
        [GUILD_ID, featureKey]).config_json),
      reactions: Number(api.get('SELECT COUNT(*) AS count FROM feature_outbox WHERE guild_id = ? AND feature_key = ?',
        [GUILD_ID, featureKey]).count),
    }));
    assert.equal(stored.config._chainReaction, undefined);
    assert.equal(stored.reactions, 0);
    await state.runtime.stop();
  });
}

// A started round with one accepted answer whose reaction is queued in the outbox.
async function queuedReaction(name, { rest } = {}) {
  await freshDatabase();
  const state = createRuntime(name, { rest });
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date(CUTOVER + 1_000) });
  const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId: snowflake(CUTOVER + 2_000, 9n), userId: USER_ID, content: '球體', now: new Date(CUTOVER + 2_000) });
  assert.ok(accepted.reactionSource);
  return { state, source: accepted.reactionSource };
}

test('a reaction whose source proof cannot read the fence is retried later, never dead-lettered', async (t) => {
  const checks = { permissionCheck: () => true };
  // The outbox meets the failing read first, while proving the source.
  const queued = await queuedReaction('proof-read-outbox');
  const outboxReads = failLedgerReads(t, { purposeId: WORD, statement: 'selectFence' });
  const summary = await processWordChainReactionOutbox({ rest: queued.state.rest }, checks);
  outboxReads.restore();
  assert.equal(outboxReads.failures, 1);
  assert.deepEqual({ claimed: summary.claimed, retried: summary.retried, terminal: summary.terminal,
    delivered: summary.delivered }, { claimed: 1, retried: 1, terminal: 0, delivered: 0 });
  // The purpose became unavailable after the claim: the attempt is given back.
  assert.deepEqual(await reactionOutboxRows(), [['pending', 0]]);
  assert.equal(queued.state.runtime.isPurposeReady(WORD), false);
  assert.deepEqual(queued.state.rest.calls, []);
  assert.equal(await withCoinDatabase((api) => Number(api.get(
    'SELECT COUNT(*) AS count FROM feature_outbox_dead_letters WHERE guild_id = ?', [GUILD_ID]).count)), 0);
  await queued.state.runtime.stop();

  // The immediate reaction after an answer meets it the same way.
  const immediate = await queuedReaction('proof-read-immediate');
  const immediateReads = failLedgerReads(t, { purposeId: WORD, statement: 'selectFence' });
  const outcome = await dispatchImmediateChainReaction({ rest: immediate.state.rest }, 'word_chain', immediate.source, checks);
  immediateReads.restore();
  assert.equal(immediateReads.failures, 1);
  assert.equal(outcome.kind, 'unavailable');
  assert.deepEqual(immediate.state.rest.calls, []);
  await immediate.state.runtime.stop();
});

const CHAIN_CHECKS = Object.freeze({ permissionCheck: () => true });

function deadLetters() {
  return withCoinDatabase((api) => Number(api.get(
    'SELECT COUNT(*) AS count FROM feature_outbox_dead_letters WHERE guild_id = ?', [GUILD_ID]).count));
}

// Fills a purpose's queue to its limit while its worker looks busy, leaving room for `room`
// real dispatches; the returned release() removes the placeholders and resumes the worker.
function holdQueue(runtime, purposeId, room = 0) {
  const slot = runtime.slots.get(purposeId);
  slot.draining = true;
  while (slot.queue.length < QUEUE_LIMIT - room) slot.queue.push({ placeholder: true, resolve() {} });
  return () => {
    slot.queue = slot.queue.filter((task) => !task.placeholder);
    slot.draining = false;
    runtime.kickDrain(purposeId);
  };
}

async function waitForQueueLength(runtime, purposeId, length) {
  for (let turn = 0; turn < 10_000 && runtime.slots.get(purposeId).queue.length < length; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.slots.get(purposeId).queue.length, length);
}

test('a full reaction queue neither dead-letters the outbox attempt nor settles the same reaction still queued', async () => {
  const queued = await queuedReaction('reaction-queue-full');
  // The immediate reaction takes the last place in the queue, which is then full.
  const release = holdQueue(queued.state.runtime, WORD, 1);
  let immediate;
  let summary;
  try {
    immediate = dispatchImmediateChainReaction({ rest: queued.state.rest }, 'word_chain', queued.source, CHAIN_CHECKS);
    await waitForQueueLength(queued.state.runtime, WORD, QUEUE_LIMIT);
    summary = await processWordChainReactionOutbox({ rest: queued.state.rest }, CHAIN_CHECKS);
  } finally {
    release();
  }
  assert.deepEqual({ claimed: summary.claimed, retried: summary.retried, terminal: summary.terminal },
    { claimed: 1, retried: 1, terminal: 0 });
  assert.equal(await deadLetters(), 0);
  // Once the queue drains, the queued reaction is still sent, exactly once.
  assert.equal((await immediate).kind, 'confirmed');
  assert.deepEqual(queued.state.rest.calls.map(([method]) => method), ['PUT']);
  await queued.state.runtime.stop();
});

function penaltyClient(rest, { isStopping = () => false, onGuildFetch = () => {}, isSendable = () => true } = {}) {
  const channel = { id: CHANNEL_ID, isTextBased: () => true, isSendable: () => isSendable() };
  const guild = {
    systemChannelId: null,
    channels: { fetch: async (id) => (id === CHANNEL_ID ? channel : null), cache: { find: () => channel } },
  };
  return { user: { id: BOT_ID }, rest, guilds: { fetch: async (id) => {
    onGuildFetch();
    return id === GUILD_ID ? guild : null;
  } }, testControlRuntimeController: { isStopping } };
}

async function seedAnnouncedPenalty(options) {
  return { ...await seedPenalty(options), guildId: GUILD_ID, sourceChannelId: CHANNEL_ID, announcedAt: null };
}

test('a penalty whose created_at names no offset is never announced', async () => {
  await freshDatabase();
  const state = createRuntime('penalty-unzoned');
  const ledger = ledgerOf(state, PENALTY);
  const counters = ledger.identityCounters;
  for (const createdAt of ['2023-11-14T22:13:21.000', '2023-11-14 22:13:21']) {
    const penalty = await seedAnnouncedPenalty({ createdAt });
    assert.deepEqual(await sendWorkPenaltyAnnouncement(penaltyClient(state.rest), penalty),
      { kind: 'terminal', reason: 'source_invalid', announced: false, dispatched: false });
    const effect = { purposeId: PENALTY, action: 'work-penalty-message.create', target: CHANNEL_ID, method: 'POST',
      route: `/channels/${CHANNEL_ID}/messages`, body: buildWorkPenaltyAnnouncementBody(penalty) };
    assert.equal(await withCoinTransaction((api) => proveWorkPenaltySourceWithApi(api, { botId: BOT_ID,
      guildId: GUILD_ID, penaltyId: penalty.id, createdAt, effect })), null);
  }
  assert.deepEqual(state.rest.calls, []);
  assert.deepEqual(ledger.identityCounters, counters);
  assert.equal(operationCount(ledger), 0);
  await state.runtime.stop();
});

test('past its appeal deadline on the ledger clock a penalty announcement is terminal: nothing sent or written',
  async () => {
    await freshDatabase();
    const state = createRuntime('penalty-deadline');
    const ledger = ledgerOf(state, PENALTY);
    const counters = ledger.identityCounters;
    const expired = await seedAnnouncedPenalty({ appealDeadlineAt: new Date(state.clock.value).toISOString() });
    assert.deepEqual(await sendWorkPenaltyAnnouncement(penaltyClient(state.rest), expired),
      { kind: 'terminal', reason: 'appeal_deadline_passed', announced: false, dispatched: false });
    // The deadline passes while the announcement is being prepared: still nothing is sent.
    const closing = await seedAnnouncedPenalty({ appealDeadlineAt: new Date(state.clock.value + 1_000).toISOString() });
    const late = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest, {
      onGuildFetch: () => { state.clock.value += 1_000; },
    }), closing);
    assert.deepEqual([late.kind, late.dispatched], ['terminal', false]);
    assert.deepEqual(state.rest.calls, []);
    assert.deepEqual(ledger.identityCounters, counters);
    assert.equal(Object.values(ledger.getSnapshotForTests().operations).filter((operation) => operation.durable).length, 0);
    await state.runtime.stop();
  });

test('a channel lost during the final check only delays a penalty announcement, without counting a failure',
  async () => {
    await freshDatabase();
    const state = createRuntime('penalty-deferred');
    const penalty = await seedAnnouncedPenalty();
    // The channel is there when it is picked and gone at the final check, three times in a row: more
    // than the two counted failures that would settle a preparation, yet it is only delayed each time.
    for (let round = 0; round < 3; round += 1) {
      let looks = 0;
      const outcome = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest, {
        isSendable: () => { looks += 1; return looks === 1; },
      }), penalty);
      assert.equal(outcome.kind, 'deferred', `round ${round}`);
      state.clock.value += PREPARE_RETRY_AFTER_MS;
    }
    assert.deepEqual(state.rest.calls, []);
    const sent = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest), penalty);
    assert.deepEqual([sent.kind, sent.announced], ['confirmed', true]);
    assert.equal(state.rest.calls.length, 1);
    await state.runtime.stop();
  });

test('a test-control stop leaves a penalty announcement unavailable, never terminal', async () => {
  await freshDatabase();
  const state = createRuntime('penalty-stopping');
  const penalty = await seedAnnouncedPenalty();
  assert.deepEqual(await sendWorkPenaltyAnnouncement(penaltyClient(state.rest, { isStopping: () => true }), penalty),
    { kind: 'unavailable', announced: false, dispatched: false });
  // The stop begins during the final check.
  let calls = 0;
  const during = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest, { isStopping: () => {
    calls += 1;
    return calls > 1;
  } }), penalty);
  assert.equal(during.kind, 'unavailable');
  assert.deepEqual(state.rest.calls, []);
  assert.equal(state.runtime.isPurposeReady(PENALTY), true);
  await state.runtime.stop();
  // After the restart the announcement goes out once.
  const restarted = createRuntime('penalty-stopping-restart', { ledgers: state.ledgers });
  const sent = await sendWorkPenaltyAnnouncement(penaltyClient(restarted.rest), penalty);
  assert.deepEqual([sent.kind, sent.announced], ['confirmed', true]);
  assert.equal(restarted.rest.calls.length, 1);
  await restarted.runtime.stop();
});

test('a full penalty queue keeps the announcement for a later run instead of settling it', async () => {
  await freshDatabase();
  const state = createRuntime('penalty-queue-full');
  const penalty = { ...await seedPenalty(), guildId: GUILD_ID, sourceChannelId: CHANNEL_ID, announcedAt: null };
  const release = holdQueue(state.runtime, PENALTY);
  let held;
  try {
    held = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest), penalty);
  } finally {
    release();
  }
  assert.deepEqual(held, { kind: 'retryable_before_attempt', announced: false, dispatched: false });
  assert.deepEqual(state.rest.calls, []);
  const sent = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest), penalty);
  assert.deepEqual({ kind: sent.kind, announced: sent.announced }, { kind: 'confirmed', announced: true });
  assert.equal(state.rest.calls.length, 1);
  await state.runtime.stop();
});

// The attempt count and status of the guild's ✅ outbox events.
function reactionOutboxRows() {
  return withCoinDatabase((api) => api.all(
    "SELECT status, attempt_count FROM feature_outbox WHERE guild_id = ? AND event_type = 'discord_reaction' ORDER BY id",
    [GUILD_ID]).map((row) => [row.status, Number(row.attempt_count)]));
}

test('a test-control stop leaves a chain reaction unavailable for a later retry, never dead-lettered', async () => {
  // Stopping already when the reaction is considered: nothing is claimed, counted, or sent.
  const before = await queuedReaction('stopping-before');
  const stopping = { rest: before.state.rest, testControlRuntimeController: { isStopping: () => true } };
  assert.equal((await dispatchImmediateChainReaction(stopping, 'word_chain', before.source, CHAIN_CHECKS)).kind,
    'unavailable');
  const beforeSummary = await processWordChainReactionOutbox(stopping, CHAIN_CHECKS);
  assert.deepEqual(beforeSummary, { claimed: 0, delivered: 0, retried: 0, terminal: 0, unavailable: true });
  assert.deepEqual(await reactionOutboxRows(), [['pending', 0]]);
  assert.equal(await deadLetters(), 0);
  assert.deepEqual(before.state.rest.calls, []);
  await before.state.runtime.stop();

  // The stop begins during the final authorization of the attempt: the claim is given back
  // without counting.
  const during = await queuedReaction('stopping-during');
  let checked = 0;
  const late = { rest: during.state.rest, testControlRuntimeController: { isStopping: () => { checked += 1; return checked > 2; } } };
  const duringSummary = await processWordChainReactionOutbox(late, CHAIN_CHECKS);
  assert.deepEqual({ claimed: duringSummary.claimed, retried: duringSummary.retried, terminal: duringSummary.terminal },
    { claimed: 1, retried: 1, terminal: 0 });
  assert.equal(checked, 3);
  assert.deepEqual(await reactionOutboxRows(), [['pending', 0]]);
  assert.equal(await deadLetters(), 0);
  assert.deepEqual(during.state.rest.calls, []);
  assert.equal(during.state.runtime.isPurposeReady(WORD), true);
  await during.state.runtime.stop();
});

// The stored health of a feature, or null when nothing was ever recorded for it.
function featureHealthStatus(featureKey) {
  return withCoinDatabase((api) => api.get(
    'SELECT status FROM feature_health WHERE feature_key = ?', [featureKey])?.status ?? null);
}

test('an unavailable ✅ purpose neither claims, counts, nor dead-letters; only a day-old event expires', async () => {
  const queued = await queuedReaction('outbox-unavailable');
  // Disabled in this process: nothing is claimed at all, however often the outbox runs while
  // the event is less than a day old on the wall clock.
  queued.state.runtime.disablePurpose(WORD, { code: 'SYNTHETIC_DISABLED' });
  const withinADay = { ...CHAIN_CHECKS, now: () => new Date(CUTOVER + 62_000) };
  for (let round = 0; round < MAX_REACTION_DELIVERY_ATTEMPTS + 2; round += 1) {
    assert.deepEqual(await processWordChainReactionOutbox({ rest: queued.state.rest }, withinADay),
      { claimed: 0, delivered: 0, retried: 0, terminal: 0, unavailable: true });
  }
  assert.deepEqual(await reactionOutboxRows(), [['pending', 0]]);
  assert.equal(await deadLetters(), 0);
  await assert.rejects(retryFeatureOutbox(1, { workerId: 'synthetic-worker', uncounted: 'yes' }),
    (error) => error.code === 'INVALID_RETRY_COUNT');
  await queued.state.runtime.stop();

  // After a restart within a day of the message the ✅ is still sent, once.
  const restarted = createRuntime('outbox-unavailable-restart', { ledgers: queued.state.ledgers,
    clock: { value: CUTOVER + 2_000 + REACTION_OUTBOX_MAX_AGE_MS } });
  assert.equal((await processWordChainReactionOutbox({ rest: restarted.rest }, CHAIN_CHECKS)).delivered, 1);
  assert.deepEqual(restarted.rest.calls.map(([method]) => method), ['PUT']);
  await restarted.runtime.stop();

  // A ✅ whose message is more than a day old on the ledger clock is closed as expired.
  const old = await queuedReaction('outbox-expired');
  await old.state.runtime.stop();
  const later = createRuntime('outbox-expired-restart', { ledgers: old.state.ledgers,
    clock: { value: CUTOVER + 2_000 + REACTION_OUTBOX_MAX_AGE_MS + 1 } });
  const expired = await processWordChainReactionOutbox({ rest: later.rest }, CHAIN_CHECKS);
  assert.deepEqual(expired, { claimed: 1, delivered: 0, retried: 0, terminal: 1, expired: 1 });
  assert.deepEqual(later.rest.calls, []);
  assert.equal(await withCoinDatabase((api) => api.get(
    'SELECT dead_letter_reason AS reason FROM feature_outbox_dead_letters WHERE guild_id = ?', [GUILD_ID]).reason), 'expired');
  // An event that only aged out says nothing about the feature: it is not marked broken.
  assert.equal(await featureHealthStatus('word_chain'), null);
  await later.runtime.stop();
});

test('a ✅ its source no longer proves is closed without marking the feature broken; an unknown result still is',
  async () => {
    // The round was stopped after the answer, so its source no longer proves the ✅: a
    // terminal computed from the source, which says nothing about the feature.
    const gone = await queuedReaction('outbox-source-gone');
    await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, now: new Date(CUTOVER + 3_000) });
    assert.deepEqual(await dispatchChainReaction({ rest: gone.state.rest }, 'word_chain', gone.source, CHAIN_CHECKS),
      { kind: 'terminal', basis: 'computed', reason: 'source_unproven' });
    const closed = await processWordChainReactionOutbox({ rest: gone.state.rest }, CHAIN_CHECKS);
    assert.deepEqual([closed.claimed, closed.terminal, closed.delivered], [1, 1, 0]);
    assert.deepEqual(gone.state.rest.calls, []);
    assert.deepEqual(await deadLetterReasons(), ['reaction_source_unproven']);
    assert.equal(await featureHealthStatus('word_chain'), null);
    await gone.state.runtime.stop();

    // A ✅ whose request failed after it began has an unknown result: that still marks the
    // feature broken.
    const failing = await queuedReaction('outbox-unknown');
    failing.state.rest.put = async (route) => {
      failing.state.rest.calls.push(['PUT', route]);
      throw new Error('synthetic network failure');
    };
    const unknown = await processWordChainReactionOutbox({ rest: failing.state.rest }, CHAIN_CHECKS);
    assert.deepEqual([unknown.claimed, unknown.terminal], [1, 1]);
    assert.equal(failing.state.rest.calls.length, 1);
    assert.equal(await withCoinDatabase((api) => api.get(
      'SELECT dead_letter_reason AS reason FROM feature_outbox_dead_letters WHERE guild_id = ?', [GUILD_ID]).reason),
    'reaction_unknown');
    assert.equal(await featureHealthStatus('word_chain'), 'broken');
    await failing.state.runtime.stop();
  });

// The dead-letter reasons of the guild's ✅ events, oldest first.
function deadLetterReasons() {
  return withCoinDatabase((api) => api.all(
    'SELECT dead_letter_reason AS reason FROM feature_outbox_dead_letters WHERE guild_id = ? ORDER BY id', [GUILD_ID])
    .map((row) => row.reason));
}

test('a ✅ that the scope of one guild no longer allows is closed by its reason; the feature stays healthy', async () => {
  // A channel the bot may not react in: every ✅ of it ends there, the card stays.
  const refused = await queuedReaction('scope-refused');
  const notAllowed = { permissionCheck: () => false };
  assert.deepEqual(await dispatchChainReaction({ rest: refused.state.rest }, 'word_chain', refused.source, notAllowed),
    { kind: 'terminal', basis: 'volatile', reason: 'scope_unavailable' });
  const closed = await processWordChainReactionOutbox({ rest: refused.state.rest }, notAllowed);
  assert.deepEqual([closed.claimed, closed.terminal, closed.delivered], [1, 1, 0]);
  assert.deepEqual(refused.state.rest.calls, []);
  assert.deepEqual(await deadLetterReasons(), ['reaction_scope_unavailable']);
  assert.equal(await featureHealthStatus('word_chain'), null);
  await refused.state.runtime.stop();

  // The bot is no longer in the guild (the default permission check finds no guild).
  const gone = await queuedReaction('scope-bot-gone');
  const leftGuild = { rest: gone.state.rest, guilds: { cache: new Map() } };
  await processWordChainReactionOutbox(leftGuild);
  assert.deepEqual(gone.state.rest.calls, []);
  assert.deepEqual(await deadLetterReasons(), ['reaction_scope_unavailable']);
  assert.equal(await featureHealthStatus('word_chain'), null);
  await gone.state.runtime.stop();

  // The scope is revoked at the final authorization (allowed when the dispatch began, not
  // when it was about to send). A later dispatch of the same event meets that decision and
  // names the same reason.
  const revoked = await queuedReaction('scope-revoked-final');
  let permissionChecks = 0;
  const revokedLater = { permissionCheck: () => { permissionChecks += 1; return permissionChecks === 1; } };
  assert.deepEqual(await dispatchChainReaction({ rest: revoked.state.rest }, 'word_chain', revoked.source, revokedLater),
    { kind: 'terminal', basis: 'volatile', reason: 'scope_revoked' });
  assert.equal(permissionChecks, 2);
  await processWordChainReactionOutbox({ rest: revoked.state.rest }, CHAIN_CHECKS);
  assert.deepEqual(revoked.state.rest.calls, []);
  assert.deepEqual(await deadLetterReasons(), ['reaction_scope_revoked']);
  assert.equal(await featureHealthStatus('word_chain'), null);
  await revoked.state.runtime.stop();

  // The source is revoked at the final authorization: the round's fence closed after the
  // dispatch began.
  const changed = await queuedReaction('source-revoked-final');
  let permissions = 0;
  const fenceClosedLater = { permissionCheck: () => {
    permissions += 1;
    if (permissions === 2) closeFence({ featureKey: 'word_chain', guildId: GUILD_ID, channelId: CHANNEL_ID });
    return true;
  } };
  const summary = await processWordChainReactionOutbox({ rest: changed.state.rest }, fenceClosedLater);
  assert.deepEqual([summary.claimed, summary.terminal, permissions], [1, 1, 2]);
  assert.deepEqual(changed.state.rest.calls, []);
  assert.deepEqual(await deadLetterReasons(), ['reaction_source_revoked']);
  assert.equal(await featureHealthStatus('word_chain'), null);
  await changed.state.runtime.stop();
});

test('a ✅ Discord refuses for its guild, for a message that is gone, or with a rate limit closes without marking the feature broken',
  async () => {
    const refusals = [
      ['permission', { status: 403, code: 50013 }, 'reaction_effect_rejected_permission'],
      ['not-found', { status: 404, code: 10008 }, 'reaction_effect_rejected_not_found'],
      ['rate-limited', { status: 429 }, 'reaction_effect_rate_limited'],
    ];
    for (const [name, refusal, reason] of refusals) {
      const rest = recordingRest();
      rest.put = async (route) => {
        rest.calls.push(['PUT', route]);
        throw Object.assign(new Error('synthetic refusal'), refusal);
      };
      const queued = await queuedReaction(`refused-${name}`, { rest });
      try {
        const summary = await processWordChainReactionOutbox({ rest }, CHAIN_CHECKS);
        assert.deepEqual([summary.claimed, summary.terminal, summary.delivered], [1, 1, 0], name);
        assert.equal(rest.calls.length, 1, name);
        assert.deepEqual(await deadLetterReasons(), [reason], name);
        assert.equal(await featureHealthStatus('word_chain'), null, name);
      } finally {
        await queued.state.runtime.stop();
      }
    }
    // Any other refusal (a 400: the request itself is wrong) still marks the feature broken.
    const rest = recordingRest();
    rest.put = async () => { throw Object.assign(new Error('Invalid Form Body'), { status: 400, code: 50035 }); };
    const queued = await queuedReaction('refused-invalid', { rest });
    try {
      await processWordChainReactionOutbox({ rest }, CHAIN_CHECKS);
      assert.deepEqual(await deadLetterReasons(), ['reaction_terminal']);
      assert.notEqual(await featureHealthStatus('word_chain'), null);
    } finally {
      await queued.state.runtime.stop();
    }
  });

test('while the ✅ purpose is unavailable, day-old events expire on the wall clock, a bounded number per run', async () => {
  const queued = await queuedReaction('outbox-wall-clock');
  const wallClock = CUTOVER + 2_000 + REACTION_OUTBOX_MAX_AGE_MS + 60_000;
  const enqueue = (api, dedupeKey, createdAt) => enqueueFeatureOutboxWithApi(api, { guildId: GUILD_ID,
    featureKey: 'word_chain', eventType: 'discord_reaction', dedupeKey, payload: {},
    availableAt: new Date(createdAt), now: new Date(createdAt) });
  await withCoinTransaction((api) => {
    // Thirty more events that are more than a day old, and one that is not yet.
    for (let index = 0; index < 30; index += 1) enqueue(api, `synthetic-old-${index}`, CUTOVER + 3_000 + index);
    enqueue(api, 'synthetic-recent', wallClock - REACTION_OUTBOX_MAX_AGE_MS + 1);
    // A claim abandoned long ago (its lease ran out) is closed like a pending event.
    api.run(`UPDATE feature_outbox SET status = 'processing', claimed_by = 'synthetic-gone', claimed_at = ?,
      lease_until = ? WHERE dedupe_key = 'synthetic-old-0'`,
    [new Date(CUTOVER + 4_000).toISOString(), new Date(CUTOVER + 64_000).toISOString()]);
  });
  queued.state.runtime.disablePurpose(WORD, { code: 'SYNTHETIC_DISABLED' });
  const atWallClock = { ...CHAIN_CHECKS, now: () => new Date(wallClock) };
  const quiet = { claimed: 0, delivered: 0, retried: 0, terminal: 0, unavailable: true };
  assert.deepEqual(await processWordChainReactionOutbox({ rest: queued.state.rest }, atWallClock),
    { ...quiet, expired: UNAVAILABLE_EXPIRE_LIMIT });
  assert.deepEqual(await processWordChainReactionOutbox({ rest: queued.state.rest }, atWallClock),
    { ...quiet, expired: 31 - UNAVAILABLE_EXPIRE_LIMIT });
  assert.deepEqual(await processWordChainReactionOutbox({ rest: queued.state.rest }, atWallClock), quiet);
  const remaining = () => withCoinDatabase((api) => api.all(
    'SELECT dedupe_key AS key FROM feature_outbox WHERE guild_id = ? ORDER BY id', [GUILD_ID]).map((row) => row.key));
  assert.deepEqual(await remaining(), ['synthetic-recent']);
  assert.equal(await deadLetters(), 31);
  assert.deepEqual(await withCoinDatabase((api) => api.all(
    'SELECT DISTINCT dead_letter_reason AS reason FROM feature_outbox_dead_letters WHERE guild_id = ?', [GUILD_ID])
    .map((row) => row.reason)), ['expired']);
  // Nothing was sent, and the feature is not marked broken.
  assert.deepEqual(queued.state.rest.calls, []);
  assert.equal(await featureHealthStatus('word_chain'), null);
  // A test-control stop writes nothing, however old the events are.
  const stopping = { rest: queued.state.rest, testControlRuntimeController: { isStopping: () => true } };
  assert.deepEqual(await processWordChainReactionOutbox(stopping,
    { ...CHAIN_CHECKS, now: () => new Date(wallClock + 10 * REACTION_OUTBOX_MAX_AGE_MS) }), quiet);
  assert.deepEqual(await remaining(), ['synthetic-recent']);
  // Both options are checked before anything is read or written.
  await assert.rejects(expireFeatureOutbox({ featureKey: 'word_chain', eventType: 'discord_reaction',
    createdBefore: new Date(wallClock), limit: 0 }), (error) => error.code === 'INVALID_EXPIRE_LIMIT');
  await assert.rejects(deadLetterFeatureOutbox(1, { workerId: 'synthetic-worker', reason: 'expired',
    affectsHealth: 'no' }), (error) => error.code === 'INVALID_DEAD_LETTER_HEALTH');
  await queued.state.runtime.stop();
});

test('an expired ✅ that its ledger already confirmed is marked delivered, not dead-lettered', async () => {
  const queued = await queuedReaction('outbox-confirmed-expired');
  // The ✅ was added and recorded, but the process ended before the outbox row was updated.
  assert.equal((await dispatchChainReaction({ rest: queued.state.rest }, 'word_chain', queued.source,
    CHAIN_CHECKS)).kind, 'confirmed');
  assert.deepEqual(queued.state.rest.calls.map(([method]) => method), ['PUT']);
  assert.deepEqual(await reactionOutboxRows(), [['pending', 0]]);
  await queued.state.runtime.stop();
  // A day later the zero-write look at the ledger finds the ✅: delivered, nothing sent again.
  const later = createRuntime('outbox-confirmed-expired-restart', { ledgers: queued.state.ledgers,
    clock: { value: CUTOVER + 2_000 + REACTION_OUTBOX_MAX_AGE_MS + 1 } });
  assert.deepEqual(await processWordChainReactionOutbox({ rest: later.rest }, CHAIN_CHECKS),
    { claimed: 1, delivered: 1, retried: 0, terminal: 0 });
  assert.deepEqual(later.rest.calls, []);
  assert.deepEqual(await reactionOutboxRows(), [['delivered', 1]]);
  assert.equal(await deadLetters(), 0);
  await later.runtime.stop();

  // When the look itself finds the purpose unavailable, the claim is given back uncounted.
  const unavailableLook = await queuedReaction('outbox-unavailable-look');
  await unavailableLook.state.runtime.stop();
  configurePublicEffectAdapter({ publicEffectRuntime: {
    botId: BOT_ID,
    isPurposeReady: () => true,
    getObservedNow: () => CUTOVER + 2_000 + REACTION_OUTBOX_MAX_AGE_MS + 1,
    inspectSource: () => Object.freeze({ kind: 'unavailable' }),
  } });
  assert.deepEqual(await processWordChainReactionOutbox({ rest: unavailableLook.state.rest }, CHAIN_CHECKS),
    { claimed: 1, delivered: 0, retried: 1, terminal: 0 });
  assert.deepEqual(await reactionOutboxRows(), [['pending', 0]]);
  assert.equal(await deadLetters(), 0);
  assert.deepEqual(unavailableLook.state.rest.calls, []);
  configurePublicEffectAdapter({});
});

test('the shutdown exit code is recorded at once and keeps a failure that was already set', () => {
  const escalating = { getLedgerEscalations: () => [
    { purposeId: WORD, code: 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED', stage: 'close', reason: null },
  ] };
  const quiet = { getLedgerEscalations: () => [] };
  const reported = [];
  const log = { error: (line) => reported.push(line) };
  const clean = {};
  assert.equal(settleLedgerShutdown({ sources: [escalating], logger: log, processRef: clean, exitCode: 0 }),
    LEDGER_ESCALATION_EXIT_CODE);
  assert.equal(clean.exitCode, LEDGER_ESCALATION_EXIT_CODE);
  // An uncaught exception set 1 before the stop request arrived: it is kept.
  const crashed = { exitCode: 1 };
  assert.equal(settleLedgerShutdown({ sources: [escalating], logger: log, processRef: crashed, exitCode: 0 }), 1);
  assert.equal(crashed.exitCode, 1);
  const failedStart = {};
  assert.equal(settleLedgerShutdown({ sources: [escalating], logger: log, processRef: failedStart, exitCode: 1 }), 1);
  assert.equal(failedStart.exitCode, 1);
  const calm = {};
  assert.equal(settleLedgerShutdown({ sources: [quiet], logger: log, processRef: calm, exitCode: 0 }), 0);
  assert.equal(calm.exitCode, 0);
  assert.equal(reported.length, 3);

  // index.js records it right after the ledgers stop (protectedEffects.stop() quiesces and
  // stops every runtime and never rejects; the record sits in its finally), before any
  // later step can throw, and exits with whatever process.exitCode then holds.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const start = source.indexOf('async function shutdown(');
  const shutdown = source.slice(start, source.indexOf('\n}\n', start));
  const stopped = shutdown.indexOf('await protectedEffects.stop();');
  const settled = shutdown.indexOf('settleLedgerShutdown({');
  assert.ok(stopped > 0 && settled > stopped, shutdown);
  assert.ok(settled < shutdown.indexOf('await boardRuntime.stopLifecycle();'), shutdown);
  assert.match(shutdown, /try \{\s*await protectedEffects\.stop\(\);\s*\} finally \{\s*(?:\/\/[^\n]*\s*)*settleLedgerShutdown\(\{/u);
  assert.match(shutdown.slice(settled), new RegExp('^settleLedgerShutdown\\(\\{\\s*sources: \\[publicSideEffectRuntime, ' +
    'welcomeSideEffectRuntime, ownerSafetyNotifier, protectedEffects,\\s*' +
    'coinDatabaseEscalations\\],\\s*logger, processRef: process, exitCode,\\s*\\}\\);', 'u'));
  // The coin database alone is reported once more right before the exit (a write during the
  // later steps can still escalate); the module reports each escalation only once. Both sit in
  // the finally of the later steps, so a step that throws cannot keep the process alive, and a
  // failed step turns an otherwise clean exit into 1.
  const last = shutdown.lastIndexOf('settleLedgerShutdown({');
  assert.ok(last > shutdown.indexOf('await boardRuntime.stopLifecycle();'), shutdown);
  assert.match(shutdown.slice(last), /^settleLedgerShutdown\(\{ sources: \[coinDatabaseEscalations\], logger, processRef: process \}\);/u);
  // (The records of who was welcomed and of the leave notices are written first thing in that finally.)
  assert.match(shutdown, new RegExp('\\} finally \\{\\s*flushMemberRecords\\(\\);\\s*(?://[^\\n]*\\s*)*try \\{\\s*settleLedgerShutdown\\(\\{ sources: ' +
    '\\[coinDatabaseEscalations\\], logger, processRef: process \\}\\);\\s*\\} finally \\{\\s*' +
    'if \\(stepFailed && !process\\.exitCode\\) process\\.exitCode = 1;\\s*process\\.exit\\(process\\.exitCode\\);' +
    '\\s*\\}\\s*\\}\\s*$', 'u'));
});

test('a reaction-fence close that fails quarantines the ledger at once, before stop', async (t) => {
  await freshDatabase();
  const state = createRuntime('fence-close-read');
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date(CUTOVER + 1_000) });
  const marker = pathsFor(ledgerPathOf(state.ledgers, WORD)).retainedLockPath;
  assert.equal(fs.existsSync(marker), false);

  // The close cannot even read the fence: a plain I/O error, not a failed write.
  const reads = failLedgerReads(t, { purposeId: WORD, statement: 'selectFence' });
  const stopped = await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 2_000) });
  reads.restore();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.reactionRevoked, true);
  assert.equal(state.runtime.isPurposeReady(WORD), false);
  assert.equal(fs.existsSync(marker), true, 'the marker is written when the close fails, not at stop');
  assert.ok(state.logs.includes(`[PUBLIC_EFFECT] purpose=${WORD} code=REACTION_FENCE_CLOSE_FAILED ${EXPECTED_CAUSE.ioerr}`),
    state.logs.join('\n'));
  assert.deepEqual(state.runtime.getLedgerEscalations(), []);
  await state.runtime.stop();

  // After a restart the quarantined ledger cannot be opened, so it is never delivered.
  const restarted = createRuntime('fence-close-read-restart', { ledgers: state.ledgers });
  assert.equal(restarted.delivered.failures.get(WORD)?.code, 'SIDE_EFFECT_LEDGER_QUARANTINED');
  assert.ok(restarted.preflight.disabled.includes(WORD));
  assert.ok(restarted.logs.includes(`[PUBLIC_EFFECT] purpose=${WORD} code=LEDGER_NOT_DELIVERED`),
    restarted.logs.join('\n'));
  await restarted.runtime.stop();
});

test('a plain fence-open refusal fails only that start and never quarantines the ledger', async () => {
  await freshDatabase();
  const state = createRuntime('fence-open-capacity');
  const ledger = ledgerOf(state, WORD);
  const limit = ledger.maximumLedgerBytes;
  ledger.maximumLedgerBytes = ledger.storageBytes() - 1;
  await assert.rejects(startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date(CUTOVER + 1_000) }), (error) => error.code === 'REACTION_FENCE_OPEN_FAILED');
  assert.equal(state.runtime.isPurposeReady(WORD), true);
  assert.ok(state.logs.includes(`[PUBLIC_EFFECT] purpose=${WORD} code=REACTION_FENCE_OPEN_REJECTED ` +
    'cause=SIDE_EFFECT_CAPACITY_EXCEEDED reason=soft-limit'), state.logs.join('\n'));
  const marker = pathsFor(ledgerPathOf(state.ledgers, WORD)).retainedLockPath;
  assert.equal(fs.existsSync(marker), false);

  ledger.maximumLedgerBytes = limit;
  const started = await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date(CUTOVER + 2_000) });
  assert.equal(started.alreadyActive, false);
  assert.equal(state.runtime.getReactionFence(WORD, GUILD_ID).open, true);
  await state.runtime.stop();
  assert.equal(fs.existsSync(marker), false, 'a plain refusal leaves no marker at stop either');
});

test('a quarantine marker that cannot be written keeps the purpose off and is escalated at runtime and close', async () => {
  await freshDatabase();
  const state = createRuntime('quarantine-write-fails', {
    faultInjector: ({ label, phase }) => {
      if (label === 'close-reaction-fence' && phase === 'before-ledger-write') throw new Error('synthetic fence write');
      if (label === 'quarantine') throw new Error('synthetic marker write');
    },
  });
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date(CUTOVER + 1_000) });
  await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, now: new Date(CUTOVER + 2_000) });
  const marker = pathsFor(ledgerPathOf(state.ledgers, WORD)).retainedLockPath;
  assert.equal(fs.existsSync(marker), false);
  assert.equal(state.runtime.isPurposeReady(WORD), false);
  assert.ok(state.logs.some((line) => line.startsWith(`[PUBLIC_EFFECT] purpose=${WORD} code=QUARANTINE_PERSIST_FAILED ` +
    'cause=SIDE_EFFECT_QUARANTINE_PERSIST_FAILED')), state.logs.join('\n'));
  assert.deepEqual(state.runtime.getLedgerEscalations(), [
    { purposeId: WORD, code: 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED', stage: 'runtime', reason: null },
  ]);

  // close() tries once more and fails, so the next start would not be blocked.
  await state.runtime.stop();
  assert.equal(fs.existsSync(marker), false);
  const escalations = state.runtime.getLedgerEscalations();
  assert.deepEqual(escalations.map(({ stage }) => stage), ['runtime', 'close']);

  const reported = [];
  const count = reportLedgerEscalations([state.runtime, null, { getLedgerEscalations: () => { throw new Error('x'); } }],
    { error: (line) => reported.push(line) });
  assert.equal(count, 2);
  assert.deepEqual(reported, [
    `[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=${WORD} cause=SIDE_EFFECT_QUARANTINE_PERSIST_FAILED stage=runtime`,
    `[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=${WORD} cause=SIDE_EFFECT_QUARANTINE_PERSIST_FAILED stage=close`,
  ]);
  assert.equal(shutdownExitCode(0, count), LEDGER_ESCALATION_EXIT_CODE);
  assert.equal(shutdownExitCode(1, count), 1);
  assert.equal(shutdownExitCode(0, 0), 0);
  assertCodesOnly([...state.logs, ...reported]);
});

test('a purpose whose ledger was not delivered stays off, and a delivered ledger that does not fit is refused', async () => {
  const ledgers = initializeLedgers('delivery');
  const penaltyPath = ledgerPathOf(ledgers, PENALTY);
  const before = fs.readFileSync(penaltyPath);
  const first = createRuntime('delivery-first', { ledgers });
  assert.deepEqual(first.preflight.disabled, []);
  await first.runtime.stop();

  // The penalty ledger goes back to its state before the last boot; the witnesses do not.
  // The opener (the bootstrap in production) refuses it, so it is never delivered.
  fs.writeFileSync(penaltyPath, before);
  const second = createRuntime('delivery-second', { ledgers });
  assert.equal(second.delivered.failures.get(PENALTY)?.code, 'SIDE_EFFECT_ROLLBACK_DETECTED');
  assert.deepEqual(second.preflight.disabled, [PENALTY]);
  assert.ok(second.logs.includes(`[PUBLIC_EFFECT] purpose=${PENALTY} code=LEDGER_NOT_DELIVERED`));
  // The runtime escalates nothing for it: the bootstrap's report does (ledgerAlerts.js).
  assert.deepEqual(second.runtime.getLedgerEscalations(), []);
  await second.runtime.stop();

  // A delivered ledger of another purpose, one already failed, or one sharing a reserved
  // path is refused, and left open for the bootstrap to close.
  const fresh = initializeLedgers('delivery-fit');
  const delivered = openPublicLedgers(fresh, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
  const swapped = new Map(delivered);
  swapped.set(PENALTY, delivered.get(WORD));
  const told = [];
  const onPurposeDisabled = (purposeId, code) => told.push([purposeId, code]);
  const runtime = new PublicSideEffectRuntime({ client: { rest: createSyntheticRest(recordingRest()) }, botId: BOT_ID, env: {},
    now: () => CUTOVER + 10_000, effectAuthority: createPublicEffectAuthority(),
    logger: { warn() {}, error() {}, info() {} }, onPurposeDisabled });
  const reserved = [{ filePath: ledgerPathOf(fresh, NUMBER) }];
  const refused = runtime.preflight({ ledgers: swapped, reservedDescriptors: reserved });
  assert.deepEqual([...refused.disabled].sort(), [PENALTY, NUMBER].sort());
  // Each refused delivered ledger is told to the alerts; a purpose with none delivered is not.
  assert.deepEqual(told.sort(), [[NUMBER, 'PUBLIC_EFFECT_LEDGER_UNAVAILABLE'], [PENALTY, 'PUBLIC_EFFECT_LEDGER_UNAVAILABLE']]
    .sort());
  await runtime.stop();
  // A runtime that cannot take any ledger (no effect authority) tells every delivered one.
  told.length = 0;
  const unauthorized = new PublicSideEffectRuntime({ client: { rest: createSyntheticRest(recordingRest()) }, botId: BOT_ID, env: {},
    now: () => CUTOVER + 10_000, logger: { warn() {}, error() {}, info() {} }, onPurposeDisabled });
  const partial = new Map([[WORD, delivered.get(NUMBER)], [NUMBER, delivered.get(NUMBER)]]);
  assert.deepEqual(unauthorized.preflight({ ledgers: partial }).enabled, []);
  assert.deepEqual(told.sort(), [[NUMBER, 'PUBLIC_EFFECT_LEDGER_DISABLED'], [WORD, 'PUBLIC_EFFECT_LEDGER_DISABLED']].sort());
  await unauthorized.stop();
  // stop() closes only the ledgers the runtime took; a refused one stays for the bootstrap.
  assert.equal(delivered.get(WORD).closed, true);
  assert.equal(delivered.get(NUMBER).closed, false);
  for (const ledger of delivered.values()) ledger.close();
});

test('a released preparation is dispatched again only after its wait, and a second failure is terminal', async () => {
  await freshDatabase();
  const state = createRuntime('prepare-retry');
  let attempts = 0;
  const failing = () => { attempts += 1; throw new Error('SYNTHETIC_PREPARE_FAILURE'); };
  const penalty = await seedPenalty();
  assert.equal((await dispatchPenalty(state, penalty, { beforeAttempt: failing })).kind, 'retryable_before_attempt');
  // Within the wait the event is not claimed again.
  assert.equal((await dispatchPenalty(state, penalty, { beforeAttempt: failing })).kind, 'retryable_before_attempt');
  assert.equal(attempts, 1);
  state.clock.value += PREPARE_RETRY_AFTER_MS;
  const sent = await dispatchPenalty(state, penalty, { beforeAttempt: (begin) => { attempts += 1; begin(); } });
  assert.equal(sent.kind, 'confirmed');
  assert.equal(attempts, 2);
  assert.equal(state.rest.calls.length, 1);

  const twice = await seedPenalty();
  assert.equal((await dispatchPenalty(state, twice, { beforeAttempt: failing })).kind, 'retryable_before_attempt');
  state.clock.value += PREPARE_RETRY_AFTER_MS;
  assert.equal((await dispatchPenalty(state, twice, { beforeAttempt: failing })).kind, 'retryable_before_attempt');
  state.clock.value += PREPARE_RETRY_AFTER_MS;
  assert.equal((await dispatchPenalty(state, twice, { beforeAttempt: failing })).kind, 'terminal');
  assert.equal(attempts, 4);
  assert.equal(state.runtime.isPurposeReady(PENALTY), true);
  await state.runtime.stop();
});

test('a begin refused for capacity stays retryable, is never settled as terminal, and keeps the purpose ready', async () => {
  await freshDatabase();
  const state = createRuntime('begin-capacity');
  const ledger = ledgerOf(state, PENALTY);
  const limit = ledger.maximumLedgerBytes;
  ledger.maximumLedgerBytes = ledger.storageBytes() - 1;
  const penalty = await seedPenalty();
  // The first refusal runs the relief prune; the next two fall inside the relief interval,
  // so they are refused at once (throttled). None of them counts as a preparation failure.
  const operationId = operationIdFor(penaltySource(penalty));
  for (let round = 0; round < 3; round += 1) {
    const outcome = await dispatchPenalty(state, penalty);
    assert.equal(outcome.kind, 'retryable_before_attempt', `round ${round}`);
    assert.equal(state.runtime.isPurposeReady(PENALTY), true, `round ${round}`);
    const view = ledger.getOperation(operationId);
    assert.deepEqual([view.status, view.resultCode, view.prepareFailures], ['prepare_failed', 'capacity_exceeded', 0]);
    state.clock.value += PREPARE_RETRY_AFTER_MS;
  }
  assert.deepEqual(state.rest.calls, []);
  ledger.maximumLedgerBytes = limit;
  assert.equal((await dispatchPenalty(state, penalty)).kind, 'confirmed');
  assert.equal(state.rest.calls.length, 1);
  await state.runtime.stop();
});

test('a purpose that stops or is disabled before begin is unavailable, never terminal', async () => {
  await freshDatabase();
  const state = createRuntime('disabled-before-begin');
  const outcome = await dispatchPenalty(state, await seedPenalty(), {
    beforeAttempt: (begin) => {
      state.runtime.disablePurpose(PENALTY, { code: 'SYNTHETIC_DISABLED' });
      begin();
    },
  });
  assert.equal(outcome.kind, 'unavailable');
  assert.deepEqual(state.rest.calls, []);
  await state.runtime.stop();
});

// The penalty record the work service builds for an inspection.
function penaltySource(penalty) {
  return { purposeId: PENALTY, sourceNamespace: 'db.coin_work_penalties', botId: BOT_ID, guildId: GUILD_ID,
    penaltyId: penalty.id, createdAt: penalty.createdAt, sourceTimestampMs: Date.parse(penalty.createdAt) };
}

function operationCount(ledger) {
  return Object.keys(ledger.getSnapshotForTests().operations).length;
}

// The binding a dispatch forms for each trusted source, through the real proof and grant.
async function penaltyBinding(state, penalty) {
  const effect = { purposeId: PENALTY, action: 'work-penalty-message.create', target: CHANNEL_ID, method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`, body: buildWorkPenaltyAnnouncementBody(penalty) };
  const proof = await withCoinTransaction((api) => proveWorkPenaltySourceWithApi(api, {
    botId: BOT_ID, guildId: GUILD_ID, penaltyId: penalty.id, createdAt: penalty.createdAt, effect }));
  return buildPublicOperation(state.authority.consumeEffect(state.authority.createIssuer().issuePenalty(proof, effect),
    effect), effect);
}

async function reactionBinding(state, source) {
  const effect = buildReactionEffect('word_chain', source.channelId, source.messageId);
  const proof = await withCoinDatabase((api) => proveReactionSourceWithApi(api, { featureKey: 'word_chain', ...source }));
  return buildPublicOperation(state.authority.consumeEffect(
    state.authority.createIssuer().issueStoredChainReaction(proof, effect), effect), effect);
}

function welcomeBinding(authority, joinedTimestamp) {
  const eventGrant = authority.captureGuildMemberAdd({ botId: BOT_ID, guildId: GUILD_ID, memberId: USER_ID,
    joinedTimestamp });
  const effect = { purposeId: 'welcome', action: 'welcome-message.create', target: CHANNEL_ID, method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`, body: { content: `歡迎 <@${USER_ID}> 加入伺服器！小吉在這裡向你打招呼～`,
      allowed_mentions: { parse: [], users: [USER_ID], roles: [], replied_user: false } } };
  return buildWelcomeOperation(authority.consumeEffect(authority.issueEffect(eventGrant, effect), effect));
}

test('every purpose forms the same binding from the same source, also after a restart', async () => {
  const queued = await queuedReaction('binding-first');
  const penalty = await seedPenalty();
  const build = async (state) => ({
    penalty: await penaltyBinding(state, penalty),
    reaction: await reactionBinding(state, queued.source),
    welcome: welcomeBinding(state.authority, CUTOVER + 4_000),
  });
  const first = await build(queued.state);
  await queued.state.runtime.stop();
  const restarted = createRuntime('binding-restart', { ledgers: queued.state.ledgers });
  const second = await build(restarted);
  for (const key of Object.keys(first)) {
    assert.equal(normalizeBinding(second[key]).bindingDigest, normalizeBinding(first[key]).bindingDigest, key);
  }
  // Each binding carries its source's own event time, under a per-guild source key.
  assert.deepEqual([first.penalty.sourceKey, first.penalty.sourceTimeMs],
    [`${PENALTY}:guild:${GUILD_ID}`, Date.parse(penalty.createdAt)]);
  assert.deepEqual([first.reaction.sourceKey, first.reaction.sourceTimeMs], [`${WORD}:guild:${GUILD_ID}`, CUTOVER + 2_000]);
  assert.deepEqual([first.welcome.sourceKey, first.welcome.sourceTimeMs], [`welcome:guild:${GUILD_ID}`, CUTOVER + 4_000]);
  // The Owner notice takes the source event's snowflake time.
  const context = { sourceEventId: snowflake(CUTOVER + 6_000, 3n), actorId: USER_ID,
    hostPurpose: 'discord.messageCreate', scope: `guild:${GUILD_ID}:channel:${CHANNEL_ID}` };
  const notice = buildOwnerNotice({ code: 'AI_GUARD_TIMEOUT' }, context, '10000000000000009');
  assert.equal(notice.sourceTimeMs, CUTOVER + 6_000);
  assert.equal(normalizeBinding(buildOwnerNotice({ code: 'AI_GUARD_TIMEOUT' }, { ...context }, '10000000000000009'))
    .bindingDigest, normalizeBinding(notice).bindingDigest);
  await restarted.runtime.stop();
});

test('a penalty and a ✅ at or before the cutover are terminal from the source itself, with no REST and no write',
  async () => {
    await freshDatabase();
    const state = createRuntime('cutover-sources');
    // The round's reaction fence is opened first; that is the only step either ledger takes.
    await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
      now: new Date(CUTOVER - 5_000) });
    const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId: snowflake(CUTOVER, 9n), userId: USER_ID, content: '球體', now: new Date(CUTOVER) });
    const ledgers = [ledgerOf(state, PENALTY), ledgerOf(state, WORD)];
    const before = ledgers.map((ledger) => ledger.identityCounters);
    const penalty = { ...await seedPenalty({ createdAt: new Date(CUTOVER).toISOString() }), guildId: GUILD_ID,
      sourceChannelId: CHANNEL_ID, announcedAt: null };
    const inspected = state.runtime.inspectSource(penaltySource(penalty));
    assert.deepEqual([inspected.kind, inspected.basis, inspected.reason], ['terminal', 'computed', 'before_cutover']);
    const held = await sendWorkPenaltyAnnouncement(penaltyClient(state.rest), penalty);
    assert.equal(held.kind, 'terminal');
    assert.equal((await dispatchChainReaction({ rest: state.rest }, 'word_chain', accepted.reactionSource,
      CHAIN_CHECKS)).kind, 'terminal');
    assert.deepEqual(state.rest.calls, []);
    assert.deepEqual(ledgers.map((ledger) => ledger.identityCounters), before);
    assert.deepEqual(ledgers.map(operationCount), [0, 0]);
    await state.runtime.stop();
  });

test('after retention prunes a guild\'s newer ✅, an older answer of that guild is terminal and nothing grows', async () => {
  await freshDatabase();
  const clock = { value: CUTOVER + 10_000 };
  const first = createRuntime('watermark-first', { clock });
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date(CUTOVER + 1_000) });
  const older = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId: snowflake(CUTOVER + 2_000, 9n), userId: USER_ID, content: '球體', now: new Date(CUTOVER + 2_000) });
  const newer = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId: snowflake(CUTOVER + 3_000, 10n), userId: USER_TWO_ID, content: '體育', now: new Date(CUTOVER + 3_000) });
  assert.equal((await dispatchImmediateChainReaction({ rest: first.rest }, 'word_chain', newer.reactionSource,
    CHAIN_CHECKS)).kind, 'confirmed');
  await first.runtime.stop();

  // 31 days later the next start prunes that row and keeps its source time as the guild's watermark.
  clock.value += 31 * 24 * 60 * 60 * 1_000;
  const second = createRuntime('watermark-second', { ledgers: first.ledgers, clock });
  const ledger = ledgerOf(second, WORD);
  assert.equal(operationCount(ledger), 0);
  const counters = ledger.identityCounters;
  for (let round = 0; round < 2; round += 1) {
    const outcome = await dispatchChainReaction({ rest: second.rest }, 'word_chain', older.reactionSource, CHAIN_CHECKS);
    assert.deepEqual([outcome.kind, outcome.basis, outcome.reason], ['terminal', 'computed', 'source_watermark']);
  }
  assert.deepEqual(second.rest.calls, []);
  assert.equal(operationCount(ledger), 0);
  assert.deepEqual(ledger.identityCounters, counters);
  await second.runtime.stop();
});

test('a begin that meets a source just made terminal by retention ends as computed terminal, never a failure',
  async () => {
    await freshDatabase();
    const state = createRuntime('begin-source-terminal');
    const ledger = ledgerOf(state, PENALTY);
    const older = await seedPenalty();
    const newer = await seedPenalty();
    assert.equal((await dispatchPenalty(state, newer)).kind, 'confirmed');
    // Eight days later the accelerated retention (seven days) may prune that row; the older
    // penalty is still claimed normally, because no watermark covers it yet.
    state.clock.value += 8 * 24 * 60 * 60 * 1_000;
    const limit = ledger.maximumLedgerBytes;
    // The ledger is full at the begin, which is written at the network entry: its relief
    // prune raises the guild's watermark over the claimed source, and the retried begin finds
    // the source terminal.
    let outcome;
    try {
      outcome = await dispatchPenalty(state, older, { beforeAttempt: (begin) => {
        ledger.maximumLedgerBytes = 1;
        begin();
      } });
    } finally {
      ledger.maximumLedgerBytes = limit;
    }
    assert.deepEqual(outcome, { kind: 'terminal', basis: 'computed', reason: 'source_watermark', operation: null });
    assert.equal(state.rest.calls.length, 1);
    assert.equal(ledger.failed, false);
    assert.equal(state.runtime.isPurposeReady(PENALTY), true);
    // The claim ended under the source's own code; no preparation failure was counted.
    const view = ledger.getOperation(operationIdFor(penaltySource(older)));
    assert.deepEqual([view.status, view.resultCode, view.prepareFailures], ['final', 'source_watermark', 0]);
    const inspected = state.runtime.inspectSource(penaltySource(older));
    assert.deepEqual([inspected.kind, inspected.basis, inspected.reason], ['terminal', 'computed', 'source_watermark']);
    await state.runtime.stop();
  });

test('with protected effects off, the three runtimes open, read, and write no ledger at all',
  async () => {
    await freshDatabase();
    initializeLedgers('kill-switch');
    for (const value of ['off', 'later']) {
      const env = { XIAOJI_PROTECTED_EFFECTS: value };
      const rest = recordingRest();
      // No protected channel is put on a REST of a runtime that stays off.
      const transports = [];
      const transport = () => {
        const made = createSyntheticRest(rest);
        transports.push([made, made.options.makeRequest, made.options.rejectOnRateLimit]);
        return made;
      };
      const logs = [];
      const authority = createPublicEffectAuthority();
      // Delivered ledgers that record any use: none may be touched.
      const used = [];
      const tripwires = new Map([...Object.keys(PURPOSES), 'welcome', 'owner-safety'].map((purposeId) => [purposeId,
        new Proxy({}, { get: (_target, key) => { used.push(String(key)); return undefined; } })]));
      const runtime = new PublicSideEffectRuntime({ client: { rest: transport() }, botId: BOT_ID, env, now: () => CUTOVER + 10_000,
        effectAuthority: authority, logger: { warn: (line) => logs.push(String(line)), error() {}, info() {} } });
      configurePublicEffectAdapter({ publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer() });
      configureChainReactionFence(runtime);
      // Every file access under the test root and every SQLite statement run is recorded.
      const touched = [];
      const names = ['openSync', 'readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'existsSync', 'realpathSync',
        'writeFileSync', 'renameSync', 'mkdirSync'];
      const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
      const nativeRealpath = fs.realpathSync.native;
      for (const name of names) {
        fs[name] = function spy(target, ...rest) {
          if (String(target).startsWith(root)) touched.push([name, String(target)]);
          return originals[name].call(this, target, ...rest);
        };
      }
      fs.realpathSync.native = nativeRealpath;
      const statement = { get: StatementSync.prototype.get, all: StatementSync.prototype.all, run: StatementSync.prototype.run };
      let statements = 0;
      for (const method of Object.keys(statement)) {
        StatementSync.prototype[method] = function counted(...args) {
          statements += 1;
          return statement[method].apply(this, args);
        };
      }
      const metadata = { version: 1, ledgerId: ledgerIdFor(WORD, 'kill-switch'), generation: 1,
        session: { id: 1, createdAt: new Date(CUTOVER).toISOString() }, channelId: CHANNEL_ID,
        sourceFence: 'a'.repeat(64), completion: null, revoked: false };
      let preflight;
      try {
        preflight = runtime.preflight({ ledgers: tripwires });
        runtime.arm();
        for (const purposeId of Object.keys(PURPOSES)) {
          assert.equal(runtime.isPurposeReady(purposeId), false, purposeId);
          assert.equal(runtime.getLedgerIdentity(purposeId), null, purposeId);
          assert.equal(runtime.getCutoverSourceTimestampMs(purposeId), null, purposeId);
        }
        for (const featureKey of ['word_chain', 'number_chain']) {
          assert.equal(inactiveReactionAuthority({ featureKey, guildId: GUILD_ID, channelId: CHANNEL_ID, sessionId: 1,
            sessionCreatedAt: metadata.session.createdAt, metadata }), null);
          assert.equal(noteInactiveReactionAuthority({ featureKey, guildId: GUILD_ID, metadata: null }), null);
        }
        // The welcome runtime and the Owner notifier take no ledger either, even one handed to them.
        const welcome = new WelcomeSideEffectRuntime({ client: { rest: transport() }, botId: BOT_ID, env,
          effectAuthority: authority, logger: { warn() {} } });
        assert.deepEqual(welcome.preflight({ ledgers: tripwires }), { enabled: false, code: 'WELCOME_PROTECTED_EFFECTS_OFF' });
        welcome.arm();
        assert.equal(welcome.isReady(), false);
        const notifier = new OwnerSafetyNotifier({ client: { rest: transport() }, ownerId: '10000000000000009', botId: BOT_ID, env,
          logger: { warn() {} }, installHandler: () => () => {} });
        assert.deepEqual(notifier.preflight({ ledgers: tripwires }),
          { enabled: false, code: 'OWNER_SAFETY_PROTECTED_EFFECTS_OFF' });
        notifier.arm();
        assert.equal(notifier.isReady(), false);
        await welcome.stop();
        await notifier.stop();
      } finally {
        Object.assign(fs, originals);
        fs.realpathSync.native = nativeRealpath;
        Object.assign(StatementSync.prototype, statement);
      }
      assert.deepEqual(preflight, { enabled: [], disabled: Object.keys(PURPOSES) });
      assert.deepEqual(used, []);
      assert.deepEqual(touched, []);
      assert.equal(statements, 0);
      assert.equal(logs.filter((line) => line.endsWith('code=PROTECTED_EFFECTS_OFF')).length, Object.keys(PURPOSES).length);
      assert.deepEqual(rest.calls, []);
      assert.equal(transports.length, 3);
      for (const [made, makeRequest, rejectOnRateLimit] of transports) {
        assert.equal(made.options.makeRequest, makeRequest);
        assert.equal(made.options.rejectOnRateLimit, rejectOnRateLimit);
      }
      await runtime.stop();
    }
    configureChainReactionFence(null);
  });

test('a REST that cannot carry the protected channel keeps every purpose off; each delivered ledger is told',
  async () => {
    await freshDatabase();
    const ledgers = initializeLedgers('plain-rest');
    const delivered = openPublicLedgers(ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
    const told = [];
    const rest = recordingRest();
    const runtime = new PublicSideEffectRuntime({ client: { rest }, botId: BOT_ID, env: {},
      now: () => CUTOVER + 10_000, effectAuthority: createPublicEffectAuthority(),
      logger: { warn() {}, error() {}, info() {} }, onPurposeDisabled: (purposeId, code) => told.push([purposeId, code]) });
    assert.deepEqual(runtime.preflight({ ledgers: delivered }), { enabled: [], disabled: Object.keys(PURPOSES) });
    assert.deepEqual(told.sort(), Object.keys(PURPOSES).map((purposeId) => [purposeId, 'PUBLIC_EFFECT_LEDGER_DISABLED']).sort());
    assert.deepEqual(runtime.getLedgerEscalations(), []);
    assert.deepEqual(rest.calls, []);
    await runtime.stop();
    for (const ledger of delivered.values()) {
      assert.equal(ledger.closed, false);
      ledger.close();
    }
  });

test('until armed every purpose is unavailable; a disable while running is reported once; quiesce keeps the ledgers',
  async () => {
    await freshDatabase();
    const ledgers = initializeLedgers('arming');
    const reported = [];
    const authority = createPublicEffectAuthority();
    const rest = recordingRest();
    const runtime = new PublicSideEffectRuntime({ client: { rest: createSyntheticRest(rest) }, botId: BOT_ID, env: {}, now: () => CUTOVER + 10_000,
      effectAuthority: authority, logger: { warn() {}, error() {}, info() {} },
      onPurposeDisabled: (purposeId, code) => { reported.push([purposeId, code]); throw new Error('ignored'); } });
    const delivered = openPublicLedgers(ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
    assert.deepEqual(runtime.preflight({ ledgers: delivered }).disabled, []);
    configurePublicEffectAdapter({ publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer() });
    configureChainReactionFence(runtime);
    const state = { authority, runtime };
    // Before arm(): unavailable, never terminal; nothing is claimed or sent.
    for (const purposeId of Object.keys(PURPOSES)) assert.equal(runtime.isPurposeReady(purposeId), false, purposeId);
    assert.equal(runtime.getCutoverSourceTimestampMs(WORD), null);
    const penalty = await seedPenalty();
    assert.equal((await dispatchPenalty(state, penalty)).kind, 'unavailable');
    assert.equal(Object.keys(delivered.get(PENALTY).getSnapshotForTests().operations).length, 0);
    assert.deepEqual(rest.calls, []);
    runtime.arm();
    assert.equal((await dispatchPenalty(state, penalty)).kind, 'confirmed');
    assert.equal(rest.calls.length, 1);
    // A purpose stopped while running is reported once, whatever the listener does.
    runtime.disablePurpose(WORD, { code: 'SYNTHETIC_DISABLED' });
    runtime.disablePurpose(WORD, { code: 'SYNTHETIC_DISABLED_AGAIN' });
    assert.deepEqual(reported, [[WORD, 'SYNTHETIC_DISABLED']]);
    // quiesce() stops the work but keeps the ledgers open; arming again has no effect.
    await runtime.quiesce();
    runtime.arm();
    assert.equal(runtime.isPurposeReady(PENALTY), false);
    assert.equal(delivered.get(PENALTY).closed, false);
    // A disable during the stop is not reported; stop() closes what the runtime took.
    runtime.disablePurpose(NUMBER, { code: 'SYNTHETIC_LATE' });
    await runtime.stop();
    assert.equal(delivered.get(PENALTY).closed, true);
    assert.deepEqual(reported, [[WORD, 'SYNTHETIC_DISABLED']]);
  });

test('a bot identity that differs at ready turns every purpose off without reporting each one', async () => {
  await freshDatabase();
  const reported = [];
  const state = createRuntime('disable-all');
  state.runtime.onPurposeDisabled = (purposeId, code) => reported.push([purposeId, code]);
  state.runtime.disableAll('LEDGER_BOT_MISMATCH');
  for (const purposeId of Object.keys(PURPOSES)) assert.equal(state.runtime.isPurposeReady(purposeId), false, purposeId);
  assert.equal((await dispatchPenalty(state, await seedPenalty())).kind, 'unavailable');
  assert.deepEqual(reported, []);
  assert.deepEqual(state.rest.calls, []);
  assert.equal(state.logs.filter((line) => line.endsWith('code=LEDGER_BOT_MISMATCH')).length, Object.keys(PURPOSES).length);
  // The ledgers stay open until the stop closes them; nothing was quarantined.
  assert.equal(state.delivered.get(PENALTY).closed, false);
  await state.runtime.stop();
  assert.equal(state.delivered.get(PENALTY).closed, true);
  assert.equal(fs.existsSync(pathsFor(ledgerPathOf(state.ledgers, PENALTY)).retainedLockPath), false);
});

test('the ledger identity comes from the read-only ledger ID, not the test snapshot', async () => {
  const state = createRuntime('identity');
  const ledger = ledgerOf(state, WORD);
  ledger.getSnapshotForTests = () => { throw new Error('the test-only snapshot must not be used'); };
  assert.deepEqual(state.runtime.getLedgerIdentity(WORD), { ledgerId: ledgerIdFor(WORD, 'identity') });
  await state.runtime.stop();
  assert.equal(state.runtime.getLedgerIdentity(WORD), null);
});

test('ledger failures are described by fixed codes only', () => {
  const sqlite = Object.assign(new Error('disk I/O error at C:\\secret\\ledger.json'), { code: 'ERR_SQLITE_ERROR', errcode: 522 });
  const store = Object.assign(new Error('The ledger at C:\\secret failed.'), { code: 'LEDGER_ROLLBACK',
    detail: { reason: 'gap', role: 'C:\\secret' }, cause: sqlite });
  const facade = Object.assign(new Error('Rollback at C:\\secret'), { code: 'SIDE_EFFECT_ROLLBACK_DETECTED', cause: store });
  assert.deepEqual(describeLedgerFailure(facade), { code: 'SIDE_EFFECT_ROLLBACK_DETECTED', sqlite: 'IOERR', reason: 'gap' });
  assert.equal(formatLedgerFailure(facade), 'cause=SIDE_EFFECT_ROLLBACK_DETECTED sqlite=IOERR reason=gap');
  assert.equal(formatLedgerFailure(new Error('PUBLIC_EFFECT_PURPOSE_INVALID')), 'cause=PUBLIC_EFFECT_PURPOSE_INVALID');
  assert.equal(formatLedgerFailure(new Error('C:\\secret\\ledger.json is gone')), 'cause=UNEXPECTED_ERROR');
  assert.equal(formatLedgerFailure(Object.assign(new Error('x'), { code: 'ENOENT', detail: { reason: 'Not A Token!' } })),
    'cause=ENOENT');
  assert.equal(formatLedgerFailure(undefined), 'cause=UNEXPECTED_ERROR');
});

const USER_TWO_ID = '10000000000000005';
const INACTIVE_HINT = '✅ 未啟用，請在同頻道重新 /board start';
const CHAIN_GAMES = Object.freeze({
  word_chain: Object.freeze({
    purposeId: WORD,
    start: (at) => startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
      now: new Date(at) }),
    answer: (messageId, userId, content, at) => acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId, userId, content, now: new Date(at) }),
    status: () => getWordChainStatus(GUILD_ID, CHANNEL_ID),
    describe: describeWordChainStatus,
    answers: ['球體', '體育', '育兒', '兒童', '童年'],
  }),
  number_chain: Object.freeze({
    purposeId: NUMBER,
    start: (at) => startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, now: new Date(at) }),
    answer: (messageId, userId, content, at) => acceptNumberChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId, userId, content, now: new Date(at) }),
    status: () => getNumberChainStatus(GUILD_ID, CHANNEL_ID),
    describe: describeNumberChainStatus,
    answers: ['1', '2', '3', '4', '5'],
  }),
});

function captureWarnings() {
  const lines = [];
  const original = logger.warn;
  logger.warn = (message) => { lines.push(String(message)); };
  return { lines, restore: () => { logger.warn = original; } };
}

for (const [featureKey, game] of Object.entries(CHAIN_GAMES)) {
  test(`${featureKey}: a stored ✅ authority that no longer verifies is warned once per guild and shown in its status`, async (t) => {
    await freshDatabase();
    const first = createRuntime(`inactive-${featureKey}-first`);
    await game.start(CUTOVER + 1_000);
    const healthy = await game.status();
    assert.equal(healthy.reactionInactive, false);
    assert.equal(game.describe(healthy).includes(INACTIVE_HINT), false);
    await first.runtime.stop();

    // The reaction ledger was re-initialized: a new ledger ID no stored authority matches.
    const second = createRuntime(`inactive-${featureKey}-second`);
    const warnings = captureWarnings();
    t.after(warnings.restore);
    let at = CUTOVER + 2_000;
    let answerIndex = 0;
    const answer = async () => {
      at += 1_000;
      const userId = answerIndex % 2 === 0 ? USER_ID : USER_TWO_ID;
      const content = game.answers[answerIndex];
      answerIndex += 1;
      const accepted = await game.answer(snowflake(at, BigInt(answerIndex)), userId, content, at);
      assert.equal(accepted.ok, true, accepted.message);
      return accepted;
    };
    assert.equal((await answer()).reactionSource, null);
    assert.equal((await answer()).reactionSource, null);
    const inactiveLine = `[CHAIN_REACTION] purpose=${game.purposeId} code=CHAIN_REACTION_AUTHORITY_INACTIVE`;
    assert.deepEqual(warnings.lines.filter((line) => line.startsWith('[CHAIN_REACTION]')),
      [`${inactiveLine} reason=LEDGER_CHANGED`]);
    assert.equal(warnings.lines.some((line) => game.answers.some((content) => line.includes(content))), false);
    const changed = await game.status();
    assert.equal(changed.reactionInactive, true);
    assert.ok(game.describe(changed).includes(INACTIVE_HINT), game.describe(changed));

    // Running start again in the same channel restores the authority.
    assert.equal((await game.start(at + 1)).alreadyActive, true);
    assert.equal((await game.status()).reactionInactive, false);
    assert.ok((await answer()).reactionSource);

    // A newer fence generation (for example written while its witness write failed).
    second.runtime.openReactionFence(game.purposeId, { guildId: GUILD_ID, channelId: CHANNEL_ID,
      sessionKey: 'synthetic-newer-session' });
    assert.equal((await answer()).reactionSource, null);
    assert.deepEqual(warnings.lines.filter((line) => line.startsWith('[CHAIN_REACTION]')),
      [`${inactiveLine} reason=LEDGER_CHANGED`, `${inactiveLine} reason=FENCE_CHANGED`]);
    assert.ok(game.describe(await game.status()).includes(INACTIVE_HINT));

    // Without a usable reaction purpose there is nothing an administrator could fix by start.
    configureChainReactionFence(null);
    const unavailable = await game.status();
    assert.equal(unavailable.reactionInactive, false);
    assert.equal(game.describe(unavailable).includes(INACTIVE_HINT), false);
    assert.equal((await answer()).reactionSource, null);
    assert.equal(warnings.lines.filter((line) => line.startsWith('[CHAIN_REACTION]')).length, 2);
    await second.runtime.stop();
  });
}

// ---------------------------------------------------------------------------------------------
// The caps of the two purposes that count their own attempts: automatic leaves (dormant: the bot no
// longer reviews servers, so nothing issues a grant for one) and DM channel preparations.
// ---------------------------------------------------------------------------------------------

// A runtime whose authority also answers for the records a test hands it. No grant of the bot's own
// issuers reaches an automatic leave any more, so the record is given to the runtime directly: what is
// tested is the runtime's own cap, counted from the rows of the purpose's ledger (a restart keeps it).
function runtimeWithRecords(name, { rest, clock, ledgers }) {
  const records = new WeakMap();
  const real = createPublicEffectAuthority();
  const authority = Object.freeze({
    ...real,
    consumeEffect: (grant, effect) => records.get(grant) ?? real.consumeEffect(grant, effect),
  });
  const state = createRuntime(name, { rest, clock, authority, ...(ledgers ? { ledgers } : {}) });
  const dispatch = ({ record, effect }, beforeAttempt = (begin) => begin()) => {
    const grant = Object.freeze({ kind: 'trusted-public-effect' });
    records.set(grant, record);
    return state.runtime.dispatch(grant, effect, { beforeAttempt });
  };
  return { state, dispatch };
}

function leaveRequest(index) {
  const guildId = `3${String(index).padStart(16, '0')}`;
  const at = CUTOVER + 1_000 + index;
  const route = `/users/@me/guilds/${guildId}`;
  const effect = { purposeId: 'audit.guild.leave', action: 'audit-guild.leave', target: guildId, method: 'DELETE', route, body: null };
  const record = {
    ...effect,
    botId: BOT_ID,
    sourceNamespace: 'discord.guild-audit.join',
    guildId,
    joinedAt: new Date(at).toISOString(),
    joinLineageDigest: sha256(`lineage-${index}`),
    sourceTimestampMs: at,
    sourceEventId: `${guildId}.${at}`,
    scope: `guild:${guildId}`,
  };
  return { record, effect };
}

function preparationRequest(index) {
  const userId = `5${String(index).padStart(16, '0')}`;
  const effect = {
    purposeId: 'work.reminder.dm.prepare', action: 'work-reminder-dm-channel.prepare', target: userId, method: 'POST',
    route: '/users/@me/channels', body: { recipient_id: userId },
  };
  const record = {
    ...effect,
    botId: BOT_ID,
    sourceNamespace: 'discord.work-reminder-recipient',
    guildId: GUILD_ID,
    userId,
    dmOperationId: `work.reminder.dm.prepare-v1:${sha256(`preparation-${index}`)}`,
    sourceTimestampMs: CUTOVER + 1_000 + index,
    sourceEventId: `${GUILD_ID}.${userId}`,
    scope: `guild:${GUILD_ID}`,
  };
  return { record, effect };
}

function attemptsOf(state, purposeId) {
  return Object.keys(ledgerOf(state, purposeId).getSnapshotForTests().operations).length;
}

test('automatic leaves are capped at 3 an hour and 10 a day by the ledger, and a leave over the cap is deferred before anything is written', async () => {
  const calls = [];
  const rest = { ...recordingRest(), delete: async (route) => { calls.push(['DELETE', route]); } };
  const clock = { value: CUTOVER + 10_000 };
  const { state, dispatch } = runtimeWithRecords('leave-caps', { rest, clock });
  assert.equal(state.runtime.isPurposeReady('audit.guild.leave'), true);
  const HOUR = 60 * 60_000;
  let index = 0;
  const leaveNow = () => dispatch(leaveRequest(index++));

  // The first hour: three leaves go, the fourth waits, and nothing of it is written or sent.
  for (let leave = 0; leave < 3; leave += 1) assert.equal((await leaveNow()).kind, 'confirmed', `leave ${leave + 1}`);
  const fourth = await leaveNow();
  assert.deepEqual([fourth.kind, fourth.reason], ['deferred', 'auto_leave_cap']);
  assert.equal(fourth.retryNotBeforeMs, clock.value + 5 * 60_000, 'a leave released in memory waits five minutes');
  assert.equal(calls.length, 3);
  assert.equal(attemptsOf(state, 'audit.guild.leave'), 3);

  // Two more hours, three leaves each: nine in all. The cap of an hour is not the cap of a day.
  for (let hour = 1; hour <= 2; hour += 1) {
    clock.value += HOUR + 60_000;
    for (let leave = 0; leave < 3; leave += 1) assert.equal((await leaveNow()).kind, 'confirmed', `hour ${hour}`);
    index += 1;
  }
  assert.equal(calls.length, 9);

  // The tenth goes, the eleventh waits for the day cap although only one leave is within the hour.
  clock.value += HOUR + 60_000;
  assert.equal((await leaveNow()).kind, 'confirmed');
  const eleventh = await leaveNow();
  assert.deepEqual([eleventh.kind, eleventh.reason], ['deferred', 'auto_leave_cap']);
  assert.equal(calls.length, 10);

  // A day after the first leaves they no longer count, and the next one goes.
  clock.value = CUTOVER + 10_000 + 24 * HOUR + 1;
  assert.equal((await leaveNow()).kind, 'confirmed');
  assert.equal(calls.length, 11);
  await state.runtime.stop();
});

test('DM channel preparations are capped at 30 an hour by the ledger, and the next hour has room again', async () => {
  const calls = [];
  const rest = {
    ...recordingRest(),
    post: async (route, { body } = {}) => {
      calls.push(['POST', route]);
      const recipientId = String(body?.recipient_id || '');
      return { id: snowflake(CUTOVER + 5_000, BigInt(calls.length)), type: 1, recipients: [{ id: recipientId }] };
    },
  };
  const clock = { value: CUTOVER + 10_000 };
  const { state, dispatch } = runtimeWithRecords('prepare-caps', { rest, clock });
  assert.equal(state.runtime.isPurposeReady('work.reminder.dm.prepare'), true);
  let index = 0;
  const prepareNow = () => dispatch(preparationRequest(index++));

  for (let preparation = 1; preparation <= 30; preparation += 1) {
    const outcome = await prepareNow();
    assert.equal(outcome.kind, 'confirmed', `preparation ${preparation}: ${JSON.stringify(outcome.reason ?? outcome.kind)}`);
  }
  assert.equal(calls.length, 30);
  const thirtyFirst = await prepareNow();
  assert.deepEqual([thirtyFirst.kind, thirtyFirst.reason], ['deferred', 'dm_prepare_cap']);
  assert.equal(thirtyFirst.retryNotBeforeMs, clock.value + 5 * 60_000);
  assert.equal(calls.length, 30, 'nothing was sent');
  assert.equal(attemptsOf(state, 'work.reminder.dm.prepare'), 30, 'nothing was written');

  // A restart does not turn the hour into a fresh budget: the count is read from the ledger's own rows.
  await state.runtime.stop();
  clock.value += 5 * 60_000;
  const restarted = runtimeWithRecords('prepare-caps', { rest, clock, ledgers: state.ledgers });
  const again = await restarted.dispatch(preparationRequest(index++));
  assert.deepEqual([again.kind, again.reason], ['deferred', 'dm_prepare_cap']);
  assert.equal(calls.length, 30);

  // An hour after the first preparations, the window has moved on.
  clock.value = CUTOVER + 10_000 + 60 * 60_000 + 1;
  assert.equal((await restarted.dispatch(preparationRequest(index++))).kind, 'confirmed');
  assert.equal(calls.length, 31);
  await restarted.state.runtime.stop();
});

// ---------------------------------------------------------------------------------------------
// The cap is checked again where it decides: at the begin the caller makes, and once more at the network entry, in the
// same synchronous step as the ledger's begin. The purposes that count their own attempts are the DM preparation (still
// running) and the automatic leave (dormant: only the runtime's own check is reachable, with a record handed to it).
// ---------------------------------------------------------------------------------------------

const HOUR_MS = 60 * 60_000;
const COUNTED_PURPOSES = Object.freeze([
  { purposeId: 'work.reminder.dm.prepare', maximum: 30, request: preparationRequest, capReason: 'dm_prepare_cap' },
  { purposeId: 'audit.guild.leave', maximum: 3, request: leaveRequest, capReason: 'auto_leave_cap' },
]);

function countedRuntime(name, purpose) {
  const calls = [];
  const rest = {
    ...recordingRest(),
    delete: async (route) => { calls.push(['DELETE', route]); },
    post: async (route, { body } = {}) => {
      calls.push(['POST', route]);
      const recipientId = String(body?.recipient_id || '');
      return { id: snowflake(CUTOVER + 5_000, BigInt(calls.length)), type: 1, recipients: [{ id: recipientId }] };
    },
  };
  const clock = { value: CUTOVER + 10_000 };
  const { state, dispatch } = runtimeWithRecords(name, { rest, clock });
  assert.equal(state.runtime.isPurposeReady(purpose.purposeId), true);
  return { state, dispatch, calls, clock };
}

// `count` attempts, one request after the other: the cap is one attempt away.
async function fillToTheLastPlace(dispatch, purpose) {
  for (let index = 0; index < purpose.maximum - 1; index += 1) {
    const outcome = await dispatch(purpose.request(index));
    assert.equal(outcome.kind, 'confirmed', `${purpose.purposeId} request ${index + 1}`);
  }
}

test('requests queued together cannot all pass the cap: the one that meets it at its begin is deferred and writes nothing', async () => {
  for (const purpose of COUNTED_PURPOSES) {
    const { state, dispatch, calls, clock } = countedRuntime(`begin-together-${purpose.purposeId}`, purpose);
    await fillToTheLastPlace(dispatch, purpose);
    // Both are within the cap when they are queued (one place is left); one worker runs them one after the other.
    // The second one's begin() is refused by the cap itself, as a deferral the caller can read.
    let refused = null;
    const noting = (begin) => {
      try {
        begin();
      } catch (error) {
        refused = error;
        throw error;
      }
    };
    const [first, second] = await Promise.all([dispatch(purpose.request(100)), dispatch(purpose.request(101), noting)]);
    assert.equal(first.kind, 'confirmed', purpose.purposeId);
    assert.equal(second.kind, 'deferred', purpose.purposeId);
    assert.equal(refused?.deferred, true, `${purpose.purposeId}: begin() itself was refused`);
    assert.equal(second.retryNotBeforeMs, clock.value + 5 * 60_000, purpose.purposeId);
    assert.equal(calls.length, purpose.maximum, `${purpose.purposeId}: only the places of the cap were used`);
    assert.equal(ledgerOf(state, purpose.purposeId).countAttempts({ windowMs: HOUR_MS }), purpose.maximum, purpose.purposeId);
    await state.runtime.stop();
  }
});

test('a caller that wraps or swallows the error of begin() cannot turn the cap into a failure or a pass', async () => {
  for (const purpose of COUNTED_PURPOSES) {
    for (const variant of ['wraps it', 'swallows it']) {
      const { state, dispatch, calls } = countedRuntime(`begin-hidden-${purpose.purposeId}-${variant.replace(' ', '-')}`, purpose);
      await fillToTheLastPlace(dispatch, purpose);
      const hiding = (begin) => {
        try {
          begin();
        } catch (error) {
          if (variant === 'wraps it') throw new Error('synthetic wrapper', { cause: error });
        }
      };
      const [first, second] = await Promise.all([
        dispatch(purpose.request(100)),
        dispatch(purpose.request(101), hiding),
      ]);
      const label = `${purpose.purposeId}, the caller ${variant}`;
      assert.equal(first.kind, 'confirmed', label);
      assert.equal(second.kind, 'deferred', label);
      assert.equal(calls.length, purpose.maximum, label);
      assert.equal(state.runtime.isPurposeReady(purpose.purposeId), true, `${label}: the purpose stays usable`);
      await state.runtime.stop();
    }
  }
});

test('a cap that cannot be read at the begin stops the purpose, and nothing is sent', async (t) => {
  for (const purpose of COUNTED_PURPOSES) {
    const { state, dispatch, calls } = countedRuntime(`begin-unreadable-${purpose.purposeId}`, purpose);
    await fillToTheLastPlace(dispatch, purpose);
    const before = calls.length;
    // The read when the request is queued answers; the one at its begin fails inside SQLite.
    const reads = failLedgerReads(t, { purposeId: purpose.purposeId, statement: 'countAttempts', skip: 1 });
    const outcome = await dispatch(purpose.request(100));
    reads.restore();
    assert.equal(outcome.kind, 'unavailable', purpose.purposeId);
    assert.ok(reads.failures >= 1, `${purpose.purposeId}: the read at the begin was made`);
    assert.equal(state.runtime.isPurposeReady(purpose.purposeId), false, purpose.purposeId);
    assert.equal(calls.length, before, `${purpose.purposeId}: nothing was sent`);
    assert.ok(state.logs.some((line) => line.includes(`purpose=${purpose.purposeId}`)), state.logs.join('\n'));
    assertCodesOnly(state.logs);
    await state.runtime.stop();
  }
});

test('a cap filled between the final authorization and the network entry defers the request, and nothing is written for it', async () => {
  for (const purpose of COUNTED_PURPOSES) {
    const { state, dispatch, calls } = countedRuntime(`entry-filled-${purpose.purposeId}`, purpose);
    await fillToTheLastPlace(dispatch, purpose);
    const ledger = ledgerOf(state, purpose.purposeId);
    // The begin passes (one place is left); then the last place is taken by an attempt written meanwhile.
    const takeTheLastPlace = (begin) => {
      begin();
      const filler = purpose.request(500);
      const binding = buildPublicOperation(filler.record, filler.effect);
      const claimed = ledger.claim(binding);
      const attempted = ledger.beginDispatch(binding, claimed.operation.generation);
      ledger.finish(binding.operationId, attempted.generation, 'unknown', 'synthetic_filler');
    };
    const outcome = await dispatch(purpose.request(100), takeTheLastPlace);
    assert.equal(outcome.kind, 'deferred', purpose.purposeId);
    assert.equal(calls.length, purpose.maximum - 1, `${purpose.purposeId}: the deferred request was not sent`);
    assert.equal(ledger.countAttempts({ windowMs: HOUR_MS }), purpose.maximum, `${purpose.purposeId}: only the filler was written`);
    // Once the hour has moved on, the same request goes.
    state.clock.value += HOUR_MS + 1;
    assert.equal((await dispatch(purpose.request(100))).kind, 'confirmed', purpose.purposeId);
    await state.runtime.stop();
  }
});
