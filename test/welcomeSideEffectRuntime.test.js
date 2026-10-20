const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { StatementSync } = require('node:sqlite');
const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');
const { createTestControlEgress } = require('../src/platform/testControlEgress');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const { captureDiscordEventContext } = require('../src/platform/hostOperationContext');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { STATEMENT_SQL } = require('../src/systems/safety/ledgerStore');
const {
  initializePublicPurposeLedger,
  openPublicPurposeLedger,
} = require('../src/systems/safety/sideEffectLedger');
const {
  PRE_ARM_QUEUE_LIMIT,
  WelcomeSideEffectRuntime,
  buildWelcomeOperation,
} = require('../src/systems/safety/welcomeSideEffectRuntime');

const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const MEMBER_ID = '10000000000000003';
const CHANNEL_ID = '10000000000000004';
const OTHER_CHANNEL_ID = '10000000000000005';
const CUTOVER = 1_000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function initializeLedger(root, name = 'welcome.json') {
  const stem = name.replace(/[^A-Za-z0-9_-]/gu, '-');
  const ledgerRoot = path.join(root, `${stem}-ledger`);
  const witnessRoot = path.join(root, `${stem}-witness`);
  fs.mkdirSync(ledgerRoot);
  fs.mkdirSync(witnessRoot);
  const filePath = path.join(ledgerRoot, name);
  const continuityWitnessPath = path.join(witnessRoot, 'continuity.json');
  const initialized = initializePublicPurposeLedger({
    filePath,
    continuityWitnessPath,
    ledgerId: `welcome-v1-${sha256(filePath).slice(0, 24)}`,
    initializationId: 'synthetic-writers-stopped-fresh-source',
    purposeIdentity: {
      purposeId: 'welcome',
      botId: BOT_ID,
      sourceNamespace: 'discord.guildMemberAdd',
      cutoverJoinedTimestampMs: CUTOVER,
      freshSourceProofDigest: sha256('synthetic fresh external source proof'),
    },
    now: () => CUTOVER,
  });
  return initialized;
}

function createRest(post = async () => ({ id: 'message' })) {
  return createSyntheticRest({ post });
}

// Opens the welcome ledger the way the bootstrap does for its runtime.
function openWelcome(initialized, now = () => 2_000) {
  return openPublicPurposeLedger({
    filePath: initialized.ledgerPath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'welcome', botId: BOT_ID, sourceNamespace: 'discord.guildMemberAdd' },
    now,
  });
}

// What the bootstrap delivers: the welcome ledger, or nothing when it cannot be opened.
function delivered(initialized, now) {
  try {
    return new Map([['welcome', openWelcome(initialized, now)]]);
  } catch {
    return new Map();
  }
}

// A runtime given its ledger by the bootstrap and armed as at ready (unless armed: false).
function createRuntime(root, { rest = createRest(), name, now = () => 2_000, dispatchTimeoutMs = 200, armed = true,
  initialized = initializeLedger(root, name), onPurposeDisabled = null, env = {} } = {}) {
  const authority = createPublicEffectAuthority();
  const client = { rest };
  const runtime = new WelcomeSideEffectRuntime({
    client,
    botId: BOT_ID,
    env,
    now,
    dispatchTimeoutMs,
    effectAuthority: authority,
    onPurposeDisabled,
  });
  const ledgers = delivered(initialized, now);
  const preflight = runtime.preflight({ ledgers });
  if (armed) runtime.arm();
  return { authority, client, initialized, runtime, ledger: ledgers.get('welcome') || null, preflight };
}

function createEffect(authority, { memberId = MEMBER_ID, channelId = CHANNEL_ID, joinedTimestamp = 2_000,
  content = `歡迎 <@${memberId}> 加入伺服器！小吉在這裡向你打招呼～` } = {}) {
  const eventGrant = authority.captureGuildMemberAdd({
    botId: BOT_ID,
    guildId: GUILD_ID,
    memberId,
    joinedTimestamp,
  });
  const body = {
    content,
    allowed_mentions: { parse: [], users: [memberId], roles: [], replied_user: false },
  };
  const effect = {
    purposeId: 'welcome',
    action: 'welcome-message.create',
    target: channelId,
    method: 'POST',
    route: `/channels/${channelId}/messages`,
    body,
  };
  return { effect, grant: authority.issueEffect(eventGrant, effect), eventGrant };
}

test('public-purpose receipt is explicit and Owner open cannot reuse it', (t) => {
  const root = makeRealTempDir('xiaoji-welcome-ledger-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeLedger(root);
  const receipt = JSON.parse(fs.readFileSync(initialized.receiptPath, 'utf8'));
  assert.equal(receipt.ledgerKind, 'public-purpose');
  assert.equal(receipt.purposeIdentity.purposeId, 'welcome');
  assert.equal(receipt.purposeIdentity.botId, BOT_ID);
  assert.equal(receipt.purposeIdentity.cutoverJoinedTimestampMs, CUTOVER);
  assert.throws(() => require('../src/systems/safety/sideEffectLedger').openSideEffectLedger({
    filePath: initialized.ledgerPath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: { botId: BOT_ID, ownerId: '10000000000000009' },
  }), /Owner identity|provenance/i);
});

test('plain objects and reused grants cannot authorize an effect', () => {
  const authority = createPublicEffectAuthority();
  const first = createEffect(authority);
  assert.equal(authority.consumeEffect({}, first.effect), null);
  assert.equal(createPublicEffectAuthority().consumeEffect(first.grant, first.effect), null);
  const record = authority.consumeEffect(first.grant, first.effect);
  assert.equal(record.memberId, MEMBER_ID);
  assert.equal(authority.consumeEffect(first.grant, first.effect), null);
});

test('unknown joinedTimestamp cannot create a trusted host grant', () => {
  assert.equal(createPublicEffectAuthority().captureGuildMemberAdd({
    botId: BOT_ID,
    guildId: GUILD_ID,
    memberId: MEMBER_ID,
    joinedTimestamp: null,
  }), null);
});

test('guildMemberAdd host capture binds original guild, member, and joinedTimestamp', () => {
  const publicEffectAuthority = createPublicEffectAuthority();
  const context = captureDiscordEventContext('guildMemberAdd', [{
    id: MEMBER_ID,
    joinedTimestamp: 2_000,
    guild: { id: GUILD_ID },
    client: { user: { id: BOT_ID } },
  }], { publicEffectAuthority });
  assert.equal(context.sourceEventId, `${GUILD_ID}.${MEMBER_ID}.2000`);
  assert.equal(context.scope, `guild:${GUILD_ID}`);
  assert.equal(context.joinedTimestamp, 2_000);
  assert.equal(captureDiscordEventContext('guildMemberAdd', [{
    id: MEMBER_ID,
    joinedTimestamp: null,
    guild: { id: GUILD_ID },
    client: { user: { id: BOT_ID } },
  }], { publicEffectAuthority }), null);
});

test('before-cutover joins are rejected without creating an operation', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-cutover-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let posts = 0;
  const { authority, runtime } = createRuntime(root, { rest: createRest(async () => { posts += 1; return { id: 'message' }; }) });
  const before = createEffect(authority, { joinedTimestamp: CUTOVER });
  assert.equal(runtime.accept(before.grant, before.effect), false);
  assert.deepEqual(runtime.ledger.getSnapshotForTests().operations, {});
  // The binding carries the join time, so the ledger itself answers it as terminal from the
  // cutover, with nothing claimed or written, even without the runtime's own check.
  const again = createEffect(authority, { joinedTimestamp: CUTOVER });
  const binding = buildWelcomeOperation(authority.consumeEffect(again.grant, again.effect));
  assert.equal(binding.sourceTimeMs, CUTOVER);
  const claimed = runtime.ledger.claim(binding);
  assert.deepEqual([claimed.kind, claimed.operation.status, claimed.operation.resultCode],
    ['replay', 'final', 'before_cutover']);
  assert.deepEqual(runtime.ledger.getSnapshotForTests().operations, {});
  assert.equal(posts, 0);
  await runtime.stop();
});

test('two distinct joins dispatch twice while the same join replays at most once', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-once-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const { authority, runtime } = createRuntime(root, { rest: createRest(async (route, options) => {
    calls.push({ route, options });
    return { id: String(calls.length) };
  }) });
  const one = createEffect(authority);
  const replay = createEffect(authority);
  const two = createEffect(authority, { memberId: '10000000000000006', joinedTimestamp: 2_001 });
  assert.equal(runtime.accept(one.grant, one.effect), true);
  assert.equal(runtime.accept(replay.grant, replay.effect), false);
  assert.equal(runtime.accept(two.grant, two.effect), true);
  await runtime.waitForIdleForTests();
  assert.equal(calls.length, 2);
  assert.equal(new Set(Object.values(runtime.ledger.getSnapshotForTests().operations)
    .map((operation) => operation.sourceKey)).size, 1);
  await runtime.stop();
});

test('HTTP failure is one unknown attempt with no retry or target fallback', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-failure-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const { authority, runtime } = createRuntime(root, { rest: createRest(async () => {
    calls += 1;
    const error = new Error('synthetic 503');
    error.status = 503;
    throw error;
  }) });
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.waitForIdleForTests();
  const replay = createEffect(authority);
  assert.equal(runtime.accept(replay.grant, replay.effect), false);
  assert.equal(calls, 1);
  assert.equal(Object.values(runtime.ledger.getSnapshotForTests().operations)[0].status, 'unknown');
  await runtime.stop();
});

test('discord.js retries never send a welcome twice', async (t) => {
  // REST retries above 0 make discord.js retry a 5xx and a reset itself; the protected
  // channel lets the welcome reach the network once.
  const cases = [
    ['5xx', () => Object.assign(new Error('synthetic 503'), { status: 503 })],
    ['reset', () => Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' })],
  ];
  for (const [name, errorFactory] of cases) {
    const root = makeRealTempDir(`xiaoji-welcome-retries-${name}-`);
    t.after(() => removeRealTempDir(root));
    let calls = 0;
    const rest = createSyntheticRest({ post: async () => { calls += 1; throw errorFactory(); } }, { retries: 3 });
    const { authority, runtime } = createRuntime(root, { rest });
    const item = createEffect(authority);
    assert.equal(runtime.accept(item.grant, item.effect), true, name);
    await runtime.waitForIdleForTests();
    assert.equal(calls, 1, name);
    assert.equal(Object.values(runtime.ledger.getSnapshotForTests().operations)[0].status, 'unknown', name);
    await runtime.stop();
  }
});

test('a REST that cannot carry the protected channel keeps welcomes off; the refusal is told, never escalated',
  async (t) => {
    const root = makeRealTempDir('xiaoji-welcome-plain-rest-');
    t.after(() => removeRealTempDir(root));
    const ledgers = delivered(initializeLedger(root, 'plain-rest.json'));
    const told = [];
    let posts = 0;
    const runtime = new WelcomeSideEffectRuntime({
      client: { rest: { options: { retries: 0 }, post: async () => { posts += 1; } } },
      botId: BOT_ID,
      env: {},
      effectAuthority: createPublicEffectAuthority(),
      onPurposeDisabled: (purposeId, code) => told.push([purposeId, code]),
    });
    assert.deepEqual(runtime.preflight({ ledgers }), { enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
    assert.deepEqual(told, [['welcome', 'WELCOME_LEDGER_DISABLED']]);
    assert.deepEqual(runtime.getLedgerEscalations(), []);
    assert.equal(posts, 0);
    await runtime.stop();
    ledgers.get('welcome').close();
  });

test('429, 5xx, timeout, and reset each reach the lower transport at most once', async (t) => {
  const cases = [
    ['429', () => Object.assign(new Error('synthetic 429'), { status: 429 })],
    ['5xx', () => Object.assign(new Error('synthetic 503'), { status: 503 })],
    ['reset', () => Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' })],
    ['timeout', null],
  ];
  for (const [name, errorFactory] of cases) {
    const root = makeRealTempDir(`xiaoji-welcome-${name}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const post = errorFactory
      ? async () => { calls += 1; throw errorFactory(); }
      : () => { calls += 1; return new Promise(() => {}); };
    const { authority, runtime } = createRuntime(root, { rest: createRest(post), dispatchTimeoutMs: 100 });
    const item = createEffect(authority);
    assert.equal(runtime.accept(item.grant, item.effect), true, name);
    await runtime.waitForIdleForTests();
    assert.equal(calls, 1, name);
    // A 429 is Discord refusing the request: rejected. The others may have taken effect.
    assert.equal(Object.values(runtime.ledger.getSnapshotForTests().operations)[0].status,
      name === '429' ? 'rejected' : 'unknown', name);
    await runtime.stop();
  }
});

// The operations of a welcome ledger that are durable rows (a decision kept only in memory
// is not).
function durableOperations(ledger) {
  return Object.values(ledger.getSnapshotForTests().operations).filter((operation) => operation.durable);
}

test('Discord\'s refusal of a welcome is recorded rejected and never sent again', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-rejected-');
  t.after(() => removeRealTempDir(root));
  let calls = 0;
  const { authority, runtime } = createRuntime(root, { rest: createRest(async () => {
    calls += 1;
    throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
  }) });
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.waitForIdleForTests();
  const [operation] = durableOperations(runtime.ledger);
  assert.deepEqual([operation.status, operation.resultCode, operation.result],
    ['rejected', 'message_rejected_permission', { httpStatus: 403, discordCode: 50013 }]);
  const replay = createEffect(authority);
  assert.equal(runtime.accept(replay.grant, replay.effect), false);
  assert.equal(calls, 1);
  await runtime.stop();
});

test('a welcome refused above the network writes nothing; its claim ends in memory', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-refused-');
  t.after(() => removeRealTempDir(root));
  let posts = 0;
  const rest = createRest(async () => { posts += 1; });
  createTestControlEgress({
    expectedApplicationId: BOT_ID,
    allowsGuild: () => true,
    allowsChannel: () => false,
    allowsActor: () => true,
    reporter: { deny() {} },
  }).install(rest);
  const { authority, runtime } = createRuntime(root, { rest });
  const join = createEffect(authority);
  assert.equal(runtime.accept(join.grant, join.effect), true);
  await runtime.waitForIdleForTests();
  assert.equal(posts, 0);
  assert.deepEqual(durableOperations(runtime.ledger), []);
  const [decision] = Object.values(runtime.ledger.getSnapshotForTests().operations);
  assert.deepEqual([decision.status, decision.resultCode], ['final', 'refused_before_dispatch']);
  await runtime.stop();
});

test('a welcome that meets a rate limit it cannot wait out writes nothing; its claim ends in memory', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-rate-limited-');
  t.after(() => removeRealTempDir(root));
  let posts = 0;
  const rest = createRest(async () => { posts += 1; return { id: 'message' }; });
  // The global window of the REST spent for 2 s, as discord.js keeps it: with a 300 ms
  // deadline (100 ms kept for the answer) the welcome cannot wait it out.
  rest.globalRemaining = 0;
  rest.globalReset = Date.now() + 2_000;
  const { authority, runtime } = createRuntime(root, { rest, dispatchTimeoutMs: 300 });
  const join = createEffect(authority);
  assert.equal(runtime.accept(join.grant, join.effect), true);
  await runtime.waitForIdleForTests();
  assert.equal(posts, 0);
  assert.deepEqual(durableOperations(runtime.ledger), []);
  const [decision] = Object.values(runtime.ledger.getSnapshotForTests().operations);
  assert.deepEqual([decision.status, decision.resultCode], ['final', 'rate_limited_before_dispatch']);
  await runtime.stop();
});

test('a welcome still queued when the runtime stops is never sent and leaves no row', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-stop-queued-');
  t.after(() => removeRealTempDir(root));
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const rest = createRest(async (_route, { body }) => {
    sent.push(body.content === 'ordinary' ? 'ordinary' : 'welcome');
    if (body.content === 'ordinary') await blocker;
    return { id: 'message' };
  });
  // The welcome's request is seen as it enters the REST, before discord.js queues it.
  let issued;
  const issuedPromise = new Promise((resolve) => { issued = resolve; });
  const request = rest.request.bind(rest);
  rest.request = (options) => {
    if (options.body?.content !== 'ordinary') issued();
    return request(options);
  };
  const { authority, runtime, initialized } = createRuntime(root, { rest, dispatchTimeoutMs: 5_000 });
  // An ordinary message holds the channel's bucket; the welcome waits behind it.
  const ordinary = rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'ordinary' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const join = createEffect(authority);
  assert.equal(runtime.accept(join.grant, join.effect), true);
  await issuedPromise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stopping = runtime.stop();
  release();
  await ordinary;
  await stopping;
  assert.deepEqual(sent, ['ordinary']);
  const reopened = openWelcome(initialized);
  try {
    assert.deepEqual(reopened.getSnapshotForTests().operations, {});
  } finally {
    reopened.close();
  }
});

test('a welcome whose ledger begin fails at the network entry is not sent, and the runtime stops', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-begin-fault-');
  t.after(() => removeRealTempDir(root));
  const initialized = initializeLedger(root, 'begin-fault.json');
  const ledger = openPublicPurposeLedger({
    filePath: initialized.ledgerPath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'welcome', botId: BOT_ID, sourceNamespace: 'discord.guildMemberAdd' },
    now: () => 2_000,
    faultInjector: ({ label, phase }) => {
      if (label === 'begin-dispatch' && phase === 'before-ledger-write') throw new Error('synthetic begin fault');
    },
  });
  let posts = 0;
  const logs = [];
  const authority = createPublicEffectAuthority();
  const runtime = new WelcomeSideEffectRuntime({
    client: { rest: createRest(async () => { posts += 1; return { id: 'message' }; }) },
    botId: BOT_ID,
    env: {},
    now: () => 2_000,
    dispatchTimeoutMs: 1_000,
    effectAuthority: authority,
    logger: { warn: (line) => logs.push(String(line)) },
  });
  assert.deepEqual(runtime.preflight({ ledgers: new Map([['welcome', ledger]]) }),
    { enabled: true, code: 'WELCOME_LEDGER_READY' });
  runtime.arm();
  const join = createEffect(authority);
  assert.equal(runtime.accept(join.grant, join.effect), true);
  await runtime.waitForIdleForTests();
  assert.equal(posts, 0);
  assert.equal(runtime.isReady(), false);
  assert.ok(logs.some((line) => line.includes('code=WELCOME_ATTEMPT_PERSIST_FAILED')), logs.join('\n'));
  await runtime.stop();
});

test('same join with changed target conflicts and never sends the changed effect', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-conflict-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const { authority, runtime } = createRuntime(root, { rest: createRest(async (route) => { calls.push(route); }) });
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.waitForIdleForTests();
  const changed = createEffect(authority, { channelId: OTHER_CHANNEL_ID });
  assert.equal(runtime.accept(changed.grant, changed.effect), false);
  assert.deepEqual(calls, [`/channels/${CHANNEL_ID}/messages`]);
  await runtime.stop();
});

test('same join with changed payload conflicts and cannot self-authorize', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-payload-conflict-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const { authority, runtime } = createRuntime(root, { rest: createRest(async () => { calls += 1; }) });
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.waitForIdleForTests();
  const changed = createEffect(authority, { content: 'changed' });
  assert.equal(runtime.accept(changed.grant, changed.effect), false);
  assert.equal(calls, 1);
  await runtime.stop();
});

test('restart converts attempted state to unknown and does not resend', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-restart-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeLedger(root);
  const authority = createPublicEffectAuthority();
  const first = createEffect(authority);
  const record = authority.consumeEffect(first.grant, first.effect);
  const binding = buildWelcomeOperation(record);
  const ledger = openPublicPurposeLedger({
    filePath: initialized.ledgerPath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'welcome', botId: BOT_ID, sourceNamespace: 'discord.guildMemberAdd' },
    now: () => 2_000,
  });
  const claimed = ledger.claim(binding);
  ledger.beginDispatch(binding, claimed.operation.generation);
  ledger.close();
  let calls = 0;
  const runtime = new WelcomeSideEffectRuntime({
    client: { rest: createRest(async () => { calls += 1; }) },
    botId: BOT_ID,
    env: {},
    now: () => 2_100,
    effectAuthority: authority,
  });
  assert.equal(runtime.preflight({ ledgers: delivered(initialized, () => 2_100) }).enabled, true);
  runtime.arm();
  const replay = createEffect(authority);
  assert.equal(runtime.accept(replay.grant, replay.effect), false);
  assert.equal(calls, 0);
  assert.equal(runtime.ledger.getOperation(binding.operationId).status, 'unknown');
  await runtime.stop();
});

test('restoring ledger and internal anchor together is rejected by the separate witness', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-full-restore-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeLedger(root);
  const initialLedger = fs.readFileSync(initialized.ledgerPath);
  const initialAnchor = fs.readFileSync(initialized.anchorPath);
  const authority = createPublicEffectAuthority();
  let calls = 0;
  const runtime = new WelcomeSideEffectRuntime({
    client: { rest: createRest(async () => { calls += 1; }) },
    botId: BOT_ID,
    effectAuthority: authority,
    env: {},
    now: () => 2_000,
  });
  assert.equal(runtime.preflight({ ledgers: delivered(initialized, () => 2_000) }).enabled, true);
  runtime.arm();
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.waitForIdleForTests();
  await runtime.stop();
  assert.equal(calls, 1);
  fs.writeFileSync(initialized.ledgerPath, initialLedger);
  fs.writeFileSync(initialized.anchorPath, initialAnchor);

  // The witness refuses the restored pair, so the ledger is never delivered.
  assert.throws(() => openWelcome(initialized, () => 2_100), (error) => error.code === 'SIDE_EFFECT_ROLLBACK_DETECTED');
  const restarted = new WelcomeSideEffectRuntime({
    client: { rest: createRest(async () => { calls += 1; }) },
    botId: BOT_ID,
    effectAuthority: createPublicEffectAuthority(),
    env: {},
    now: () => 2_100,
  });
  assert.equal(restarted.preflight({ ledgers: delivered(initialized, () => 2_100) }).enabled, false);
  assert.equal(calls, 1);
  await restarted.stop();
});

test('shutdown finalizes queued work before any external dispatch', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-stop-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const { authority, runtime } = createRuntime(root, { rest: createRest(async () => { calls += 1; }) });
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.stop();
  assert.equal(calls, 0);
});

test('queue overflow becomes a fixed terminal record without dispatch', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-queue-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const { authority, runtime } = createRuntime(root, { rest: createRest(async () => { calls += 1; }) });
  for (let index = 0; index < 129; index += 1) {
    const memberId = String(10000000000000100n + BigInt(index));
    const item = createEffect(authority, { memberId, joinedTimestamp: 3_000 + index });
    assert.equal(runtime.accept(item.grant, item.effect), index < 128);
  }
  const operations = Object.values(runtime.ledger.getSnapshotForTests().operations);
  assert.equal(operations.filter((operation) => operation.status === 'suppressed_queue').length, 1);
  assert.equal(operations.find((operation) => operation.status === 'suppressed_queue').resultCode, 'queue_full');
  await runtime.stop();
  assert.equal(calls, 0);
});

test('ledger capacity failure disables welcome without external dispatch', () => {
  let calls = 0;
  const authority = createPublicEffectAuthority();
  const runtime = new WelcomeSideEffectRuntime({
    client: { rest: createRest(async () => { calls += 1; }) },
    botId: BOT_ID,
    effectAuthority: authority,
  });
  runtime.ledger = { claim: () => { throw new Error('capacity'); } };
  runtime.disabled = false;
  runtime.cutoverJoinedTimestampMs = CUTOVER;
  const item = createEffect(authority);
  assert.equal(runtime.accept(item.grant, item.effect), false);
  assert.equal(runtime.getStatsForTests().disabled, true);
  assert.equal(calls, 0);
});

test('without a delivered ledger welcome stays off and nothing is created; old variables open nothing', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-missing-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeLedger(root);
  const before = fs.readdirSync(root).sort();
  const runtime = new WelcomeSideEffectRuntime({
    client: { rest: createRest() },
    botId: BOT_ID,
    // The variables of the retired environment-configured ledger are ignored.
    env: {
      XIAOJI_WELCOME_LEDGER_ENABLED: 'true',
      XIAOJI_WELCOME_LEDGER_PATH: initialized.ledgerPath,
      XIAOJI_WELCOME_LEDGER_PROVENANCE_SHA256: initialized.receiptSha256,
    },
    effectAuthority: createPublicEffectAuthority(),
  });
  assert.deepEqual(runtime.preflight(), { enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
  assert.deepEqual(runtime.preflight({ ledgers: new Map() }), { enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
  runtime.arm();
  assert.equal(runtime.isReady(), false);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  // Opening the ledger now still works: the runtime never held it.
  openWelcome(initialized).close();
  await runtime.stop();
});

test('welcome refuses a delivered ledger that shares a reserved path or is not its own, tells the alerts, and leaves it open',
  async (t) => {
    const root = makeRealTempDir('xiaoji-welcome-owner-overlap-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const initialized = initializeLedger(root);
    const ledger = openWelcome(initialized);
    const told = [];
    const onPurposeDisabled = (purposeId, code) => told.push([purposeId, code]);
    const runtime = new WelcomeSideEffectRuntime({
      client: { rest: createRest() },
      botId: BOT_ID,
      env: {},
      effectAuthority: createPublicEffectAuthority(),
      onPurposeDisabled,
    });
    assert.deepEqual(runtime.preflight({ ledgers: new Map([['welcome', ledger]]),
      reservedDescriptors: [{ filePath: initialized.ledgerPath }] }), { enabled: false, code: 'WELCOME_LEDGER_UNAVAILABLE' });
    const other = { ...ledger, purposeId: 'owner-safety', locations: ledger.locations, provenance: ledger.provenance };
    assert.deepEqual(runtime.preflight({ ledgers: new Map([['welcome', other]]) }),
      { enabled: false, code: 'WELCOME_LEDGER_UNAVAILABLE' });
    // No delivered ledger: the bootstrap's report already says why, so nothing is told.
    assert.deepEqual(runtime.preflight({ ledgers: new Map() }), { enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
    // A runtime that cannot take any ledger (no effect authority) refuses a delivered one too.
    const unauthorized = new WelcomeSideEffectRuntime({ client: { rest: createRest() }, botId: BOT_ID, env: {},
      onPurposeDisabled });
    assert.deepEqual(unauthorized.preflight({ ledgers: new Map([['welcome', ledger]]) }),
      { enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
    assert.deepEqual(told, [['welcome', 'WELCOME_LEDGER_UNAVAILABLE'], ['welcome', 'WELCOME_LEDGER_UNAVAILABLE'],
      ['welcome', 'WELCOME_LEDGER_DISABLED']]);
    await runtime.stop();
    // A refused welcome ledger is told, never escalated: the status page and the Owner's
    // notices still carry it.
    assert.deepEqual([runtime.getLedgerEscalations(), unauthorized.getLedgerEscalations()], [[], []]);
    await unauthorized.stop();
    assert.equal(ledger.closed, false);
    ledger.close();
  });

test('test-control channel denial reaches zero lower transport mutations', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-test-control-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let lowerMutations = 0;
  const rest = createRest(async () => { lowerMutations += 1; });
  const denied = [];
  createTestControlEgress({
    expectedApplicationId: BOT_ID,
    allowsGuild: () => true,
    allowsChannel: () => false,
    allowsActor: () => true,
    reporter: { deny: (code) => denied.push(code) },
  }).install(rest);
  const { authority, runtime } = createRuntime(root, { rest });
  const first = createEffect(authority);
  assert.equal(runtime.accept(first.grant, first.effect), true);
  await runtime.waitForIdleForTests();
  assert.equal(lowerMutations, 0);
  assert.deepEqual(denied, ['TEST_CHANNEL_EGRESS_DENIED']);
  await runtime.stop();
});

test('a welcome ledger that fails or is quarantined stops accepting joins at once', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-failed-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let posts = 0;
  const rest = createRest(async () => { posts += 1; return { id: 'message' }; });

  const quarantined = createRuntime(root, { rest, name: 'quarantined.json' });
  const quarantinedLogs = [];
  quarantined.runtime.logger = { warn: (line) => quarantinedLogs.push(String(line)) };
  quarantined.runtime.ledger.quarantine('SYNTHETIC_REVIEW');
  const join = createEffect(quarantined.authority);
  assert.equal(quarantined.runtime.accept(join.grant, join.effect), false);
  assert.deepEqual(quarantinedLogs, ['[WELCOME_SAFETY] code=WELCOME_LEDGER_QUARANTINED']);
  assert.equal(quarantined.runtime.getStatsForTests().disabled, true);
  await quarantined.runtime.stop();

  // A read that failed elsewhere leaves only the store marked failed.
  const failing = createRuntime(root, { rest, name: 'failing.json' });
  const failingLogs = [];
  failing.runtime.logger = { warn: (line) => failingLogs.push(String(line)) };
  const original = StatementSync.prototype.get;
  StatementSync.prototype.get = function failingGet(...args) {
    if (this.sourceSQL === STATEMENT_SQL.selectOperation && args[0] === 'welcome') {
      throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return original.apply(this, args);
  };
  try {
    assert.throws(() => failing.runtime.ledger.getOperation('synthetic-operation'),
      (error) => error.code === 'SIDE_EFFECT_PERSIST_FAILED');
  } finally {
    StatementSync.prototype.get = original;
  }
  const next = createEffect(failing.authority, { memberId: '10000000000000007' });
  assert.equal(failing.runtime.accept(next.grant, next.effect), false);
  assert.deepEqual(failingLogs, ['[WELCOME_SAFETY] code=WELCOME_LEDGER_FAILED']);
  await failing.runtime.stop();
  assert.equal(posts, 0);
});

test('a welcome ledger the bootstrap could not open is never delivered, and the runtime escalates nothing', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-open-codes-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeLedger(root);
  const database = fs.readFileSync(initialized.ledgerPath);
  const open = (logs) => new WelcomeSideEffectRuntime({ client: { rest: createRest() }, botId: BOT_ID, env: {},
    now: () => 2_000, effectAuthority: createPublicEffectAuthority(),
    logger: { warn: (line) => logs.push(String(line)) } });
  const first = open([]);
  assert.equal(first.preflight({ ledgers: delivered(initialized) }).enabled, true);
  await first.stop();

  // The ledger goes back to its state before the last boot; its witnesses do not. The
  // opener refuses it (the bootstrap reports the code and escalates it in production).
  fs.writeFileSync(initialized.ledgerPath, database);
  assert.throws(() => openWelcome(initialized), (error) => error.code === 'SIDE_EFFECT_ROLLBACK_DETECTED');
  const rollbackLogs = [];
  const rolledBack = open(rollbackLogs);
  assert.deepEqual(rolledBack.preflight({ ledgers: delivered(initialized) }),
    { enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
  assert.deepEqual(rollbackLogs, ['[WELCOME_SAFETY] code=WELCOME_LEDGER_DISABLED']);
  assert.deepEqual(rolledBack.getLedgerEscalations(), []);
  await rolledBack.stop();
});

test('joins accepted before arming wait unsent; arm() sends them, disableAll() ends them, quiesce keeps the ledger',
  async (t) => {
    const root = makeRealTempDir('xiaoji-welcome-arming-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const rest = createRest(async () => { calls += 1; return { id: 'message' }; });
    const waiting = createRuntime(root, { rest, name: 'waiting.json', armed: false });
    assert.equal(waiting.preflight.enabled, true);
    assert.equal(waiting.runtime.isReady(), false);
    const join = createEffect(waiting.authority);
    assert.equal(waiting.runtime.accept(join.grant, join.effect), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    waiting.runtime.arm();
    await waiting.runtime.waitForIdleForTests();
    assert.equal(calls, 1);
    // quiesce() ends the queue and keeps the ledger open for stop() to close.
    const late = createEffect(waiting.authority, { memberId: '10000000000000008', joinedTimestamp: 2_500 });
    await waiting.runtime.quiesce();
    assert.equal(waiting.runtime.accept(late.grant, late.effect), false);
    assert.equal(waiting.ledger.closed, false);
    waiting.runtime.arm();
    assert.equal(waiting.runtime.isReady(), false);
    await waiting.runtime.stop();
    assert.equal(waiting.ledger.closed, true);

    // A bot identity that differs at ready: queued joins end without being sent.
    const refused = createRuntime(root, { rest, name: 'refused.json', armed: false });
    const queued = createEffect(refused.authority, { memberId: '10000000000000009' });
    assert.equal(refused.runtime.accept(queued.grant, queued.effect), true);
    refused.runtime.disableAll('LEDGER_BOT_MISMATCH');
    refused.runtime.arm();
    await refused.runtime.waitForIdleForTests();
    assert.equal(calls, 1);
    assert.equal(refused.runtime.isReady(), false);
    const operations = Object.values(refused.ledger.getSnapshotForTests().operations);
    assert.deepEqual(operations.map((operation) => [operation.status, operation.resultCode]),
      [['final', 'disabled_before_dispatch']]);
    await refused.runtime.stop();
  });

test('a welcome runtime stopped while running is reported once; the kill switch touches no delivered ledger',
  async (t) => {
    const root = makeRealTempDir('xiaoji-welcome-reported-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reported = [];
    const state = createRuntime(root, { onPurposeDisabled: (purposeId, code) => reported.push([purposeId, code]) });
    state.ledger.quarantine('SYNTHETIC_REVIEW');
    for (const memberId of ['10000000000000011', '10000000000000012']) {
      const join = createEffect(state.authority, { memberId });
      assert.equal(state.runtime.accept(join.grant, join.effect), false);
    }
    assert.deepEqual(reported, [['welcome', 'WELCOME_LEDGER_QUARANTINED']]);
    await state.runtime.stop();

    for (const value of ['off', 'later']) {
      const used = [];
      const tripwire = new Proxy({}, { get: (_target, key) => { used.push(String(key)); return undefined; } });
      const runtime = new WelcomeSideEffectRuntime({ client: { rest: createRest() }, botId: BOT_ID,
        env: { XIAOJI_PROTECTED_EFFECTS: value }, effectAuthority: createPublicEffectAuthority() });
      assert.deepEqual(runtime.preflight({ ledgers: new Map([['welcome', tripwire]]) }),
        { enabled: false, code: 'WELCOME_PROTECTED_EFFECTS_OFF' });
      runtime.arm();
      assert.equal(runtime.isReady(), false);
      await runtime.stop();
      assert.deepEqual(used, []);
    }
  });

test('before arming at most PRE_ARM_QUEUE_LIMIT joins wait; the rest are refused, logged, and never sent', async (t) => {
  const root = makeRealTempDir('xiaoji-welcome-pre-arm-cap-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = [];
  const rest = createRest(async (_route, { body }) => { contents.push(body.content); return { id: 'message' }; });
  const extra = 8;
  const joinAll = (state, firstMember) => Array.from({ length: PRE_ARM_QUEUE_LIMIT + extra }, (_, index) => {
    const memberId = String(BigInt(firstMember) + BigInt(index));
    const item = createEffect(state.authority, { memberId, joinedTimestamp: 3_000 + index });
    return state.runtime.accept(item.grant, item.effect);
  });

  const state = createRuntime(root, { rest, name: 'capped.json', armed: false });
  const logs = [];
  state.runtime.logger = { warn: (line) => logs.push(String(line)) };
  assert.deepEqual(joinAll(state, '10000000000000100'),
    Array.from({ length: PRE_ARM_QUEUE_LIMIT + extra }, (_, index) => index < PRE_ARM_QUEUE_LIMIT));
  assert.equal(state.runtime.getStatsForTests().queueLength, PRE_ARM_QUEUE_LIMIT);
  assert.deepEqual(logs, Array(extra).fill('[WELCOME_SAFETY] code=WELCOME_PRE_ARM_QUEUE_FULL'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(contents, []);
  // Once armed, exactly the queued joins are sent, each once; the refused ones never are.
  state.runtime.arm();
  await state.runtime.waitForIdleForTests();
  assert.equal(contents.length, PRE_ARM_QUEUE_LIMIT);
  assert.equal(new Set(contents).size, PRE_ARM_QUEUE_LIMIT);
  // The dropped joins left no record at all.
  const operations = Object.values(state.ledger.getSnapshotForTests().operations);
  assert.deepEqual(operations.map((operation) => operation.status), Array(PRE_ARM_QUEUE_LIMIT).fill('confirmed'));
  await state.runtime.stop();

  // A bot identity that differs at ready ends the whole capped queue: nothing is sent.
  const refused = createRuntime(root, { rest, name: 'refused-capped.json', armed: false });
  joinAll(refused, '10000000000000300');
  refused.runtime.disableAll('LEDGER_BOT_MISMATCH');
  refused.runtime.arm();
  await refused.runtime.waitForIdleForTests();
  assert.equal(contents.length, PRE_ARM_QUEUE_LIMIT);
  assert.equal(refused.runtime.getStatsForTests().queueLength, 0);
  await refused.runtime.stop();
});
