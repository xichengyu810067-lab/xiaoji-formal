'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync, StatementSync } = require('node:sqlite');
const { makeRealTempDir } = require('./support/realTempDir');
const { STATEMENT_SQL } = require('../src/systems/safety/ledgerStore');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const {
  captureDiscordEventContext,
  getHostOperationContext,
  runWithBackgroundContext,
  runWithHostOperationContext,
} = require('../src/platform/hostOperationContext');
const { installEgressGuard, setEgressSafetyEventHandler } = require('../src/platform/egressGuard');
const { rewriteLinks } = require('../src/platform/linkPolicy');
const {
  SAFETY_EVENT_CODES, SECURITY_ALERT_KINDS, emitSafetyEvent, notifiesOwner, reportSecurityAlert, safetyEventCategory,
  sanitizeGuildName,
  setSafetyEventHandler,
} = require('../src/platform/safetyEventCatalog');
const {
  CONVERSATION_SAFETY_EVENT_CODES,
  emitConversationSafetyEvent,
} = require('../src/systems/conversation/safetyEvents');
const {
  GUARD_FILE_NAME,
  createOwnerDmStartGuard,
  writeGuardFile,
} = require('../src/systems/safety/ownerDmStartGuard');
const {
  CATEGORY_BUDGETS,
  CATEGORY_BUDGET_CLASSES,
  DM_PREPARATION_ACTION,
  EVENT_NOTICE_PREFIXES,
  MAX_DM_PREPARATION_FAILURES,
  NOTICE_PREFIXES,
  OUTAGE_KIND_TEXT,
  OWNER_EVENT_ACTION,
  OwnerSafetyNotifier,
  PRE_ARM_QUEUE_LIMIT,
  QUEUE_LIMIT,
  SECURITY_ALERT_TEXT,
  WORKER_CONCURRENCY,
  buildChannelBinding,
  buildFixedNotice,
  buildLedgerAlertOperation,
  buildOperation,
  buildPreparationOperation,
  ownerEventIdentity,
  validateChannelBinding,
  validateCreatedDm,
} = require('../src/systems/safety/ownerSafetyNotifier');
const {
  MAX_VOLATILE_OPERATIONS,
  OWNER_BUDGET_POLICIES,
  initializeSideEffectLedger,
  openSideEffectLedger,
  pathsFor,
} = require('../src/systems/safety/sideEffectLedger');

const BOT_ID = '777777777777777777';
const OWNER_ID = '444444444444444444';
const CHANNEL_ID = '888888888888888888';
const IDENTITY = Object.freeze({ botId: BOT_ID, ownerId: OWNER_ID });
const CONTEXT = Object.freeze({
  sourceEventId: '333333333333333333',
  actorId: '555555555555555555',
  guildId: '111111111111111111',
  channelId: '222222222222222222',
  hostPurpose: 'discord.message',
  scope: 'guild:111111111111111111:channel:222222222222222222',
});

// The heading of the notices of the sample events below (the 'critical' family: the archive code and the ledger codes).
const FIXED_NOTICE_PREFIX = NOTICE_PREFIXES.critical;

// Any event that is still an Owner notice. The AI guard and AI output codes, and the AI refusals (which are
// reported as security alerts), are not (notifiesOwner), so the samples are the archive code and ledger codes.
function event(code = SAFETY_EVENT_CODES.ARCHIVE_UNAVAILABLE) {
  return Object.freeze({ code, at: 123, actorId: null, guildId: null, channelId: null, messageId: null });
}

// Codes that are an Owner DM whatever else the catalogue makes routine. Tests of what happens to a notice use them.
const OWNER_NOTICE_CODES = Object.freeze(['LEDGER_SAMPLE_NOTICE', 'LEDGER_SAMPLE_NOTICE_B',
  'LEDGER_SAMPLE_NOTICE_C', SAFETY_EVENT_CODES.ARCHIVE_UNAVAILABLE]);

function noticeEvent(index = 0) {
  return event(OWNER_NOTICE_CODES[index % OWNER_NOTICE_CODES.length]);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digestStable(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

// Rewrites one stored result directly in the SQLite ledger, as a writer with file access
// could; the immutability trigger is lifted and restored around the edit.
function rewriteStoredResult(filePath, action, mutate, { updateDigest = true } = {}) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.prepare('PRAGMA journal_mode = WAL').get();
    const row = db.prepare('SELECT operation_id, binding_json, result_json FROM operations').all()
      .find((item) => JSON.parse(item.binding_json).action === action);
    const result = JSON.parse(row.result_json);
    mutate(result);
    const resultJson = JSON.stringify(stableValue(result));
    const guard = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'operations_terminal_once'").get().sql;
    db.exec('DROP TRIGGER operations_terminal_once');
    if (updateDigest) {
      db.prepare('UPDATE operations SET result_json = ?, result_digest = ? WHERE operation_id = ?')
        .run(resultJson, digestStable(result), row.operation_id);
    } else {
      db.prepare('UPDATE operations SET result_json = ? WHERE operation_id = ?').run(resultJson, row.operation_id);
    }
    db.exec(guard);
  } finally {
    db.close();
  }
}

// Captures the in-memory operations a ledger handle holds just before it is closed.
function captureOnClose(ledger) {
  const captured = { operations: null };
  const close = ledger.close.bind(ledger);
  ledger.close = (options) => {
    captured.operations = Object.values(ledger.getSnapshotForTests().operations);
    close(options);
  };
  return captured;
}

function successfulPost(calls, inspect = () => {}) {
  return async (route, options) => {
    calls.push({ route, options });
    inspect(route, options);
    if (route === '/users/@me/channels') {
      return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
    }
    if (route === `/channels/${CHANNEL_ID}/messages`) return { id: '999999999999999999' };
    throw new Error(`Unexpected synthetic route: ${route}`);
  };
}

// Stands in for the bootstrap and index.js: every preflight() without an explicit map is
// given a freshly opened Owner ledger (or none when `enabled` is false, or when it cannot
// be opened), and the notifier is armed afterwards as at ready. Every opened ledger is kept
// in `delivered` so the test can close it at the end, as the bootstrap does at shutdown (a
// notifier never closes a ledger it refused).
function deliverOnPreflight(notifier, openLedger, { enabled = true, armed = true, delivered = [] } = {}) {
  const preflight = notifier.preflight.bind(notifier);
  notifier.preflight = (context = {}) => {
    let ledgers = context.ledgers;
    if (ledgers === undefined) {
      ledgers = new Map();
      if (enabled) {
        try {
          const ledger = openLedger();
          delivered.push(ledger);
          ledgers.set('owner-safety', ledger);
        } catch {}
      }
    }
    const result = preflight({ ...context, ledgers });
    if (armed) notifier.arm();
    return result;
  };
  return notifier;
}

function fixture(t, { post, faultInjector = null, context = CONTEXT,
  clock = { value: 1_000 }, dispatchTimeoutMs = 200, enabled = true, armed = true,
  ledgerFactory = null, retries = 0, ownerDmGate = null } = {}) {
  const root = makeRealTempDir('xiaoji-owner-safety-');
  const filePath = path.join(root, 'ledger.json');
  const initialized = initializeSideEffectLedger({
    filePath,
    ledgerId: 'owner-safety-synthetic',
    initializationId: 'owner-safety-offline-init',
    notificationIdentity: IDENTITY,
    now: () => clock.value,
  });
  const calls = [];
  const logs = [];
  let handler = null;
  let restored = 0;
  const client = {
    rest: createSyntheticRest({ post: post || successfulPost(calls) }, { retries }),
  };
  const notifier = new OwnerSafetyNotifier({
    client,
    ownerId: OWNER_ID,
    botId: BOT_ID,
    logger: { warn(message) { logs.push(message); } },
    env: {},
    now: () => clock.value,
    getContext: () => context,
    installHandler(callback) {
      handler = callback;
      return () => { restored += 1; handler = null; };
    },
    dispatchTimeoutMs,
    ownerDmGate,
  });
  const openLedger = ledgerFactory
    ? () => ledgerFactory({ filePath })
    : () => openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
      expectedIdentity: IDENTITY, now: () => clock.value, faultInjector });
  const delivered = [];
  deliverOnPreflight(notifier, openLedger, { enabled, armed, delivered });
  notifier.install();
  t.after(async () => {
    await notifier.stop();
    for (const ledger of delivered) if (!ledger.closed) ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, filePath, initialized, notifier, client, calls, logs, clock, delivered,
    emit: (value) => handler?.(value),
    getRestored: () => restored,
  };
}

function reopen(state, overrides = {}) {
  let handler = null;
  const calls = [];
  const context = overrides.context || CONTEXT;
  const client = {
    rest: createSyntheticRest({ post: overrides.post || successfulPost(calls) }),
  };
  const notifier = new OwnerSafetyNotifier({
    client,
    ownerId: OWNER_ID,
    botId: BOT_ID,
    logger: { warn(message) { overrides.logs?.push(message); } },
    env: {},
    now: () => state.clock.value,
    getContext: () => context,
    installHandler(callback) { handler = callback; return () => { handler = null; }; },
    dispatchTimeoutMs: overrides.dispatchTimeoutMs || 200,
  });
  deliverOnPreflight(notifier, () => openSideEffectLedger({ filePath: state.filePath,
    expectedReceiptSha256: state.initialized.receiptSha256, expectedIdentity: IDENTITY, now: () => state.clock.value }),
  { delivered: state.delivered });
  notifier.install();
  return { notifier, calls, emit: (value) => handler?.(value) };
}

test('host context accepts only stable Discord message or interaction identities', () => {
  assert.deepEqual(captureDiscordEventContext('messageCreate', [{
    id: CONTEXT.sourceEventId,
    author: { id: CONTEXT.actorId },
    guildId: CONTEXT.guildId,
    channelId: CONTEXT.channelId,
  }]), CONTEXT);
  assert.equal(captureDiscordEventContext('messageCreate', [{
    id: 'not-stable', author: { id: CONTEXT.actorId }, guildId: CONTEXT.guildId,
    channelId: CONTEXT.channelId,
  }]), null);
  assert.deepEqual(captureDiscordEventContext('interactionCreate', [{
    id: '666666666666666666', user: { id: CONTEXT.actorId }, guildId: null,
    channelId: CONTEXT.channelId,
  }]), {
    sourceEventId: '666666666666666666', actorId: CONTEXT.actorId,
    channelId: CONTEXT.channelId, guildId: null,
    hostPurpose: 'discord.interaction', scope: `dm:channel:${CONTEXT.channelId}`,
  });
});

test('preparation and notice are two durable operations with one synthetic POST each', async (t) => {
  let state;
  const calls = [];
  state = fixture(t, {
    post: successfulPost(calls, (route) => {
      const operations = Object.values(state.notifier.ledger.getSnapshotForTests().operations);
      if (route === '/users/@me/channels') {
        assert.equal(operations.length, 1);
        assert.equal(operations[0].action, 'dm-channel.prepare');
        assert.equal(operations[0].status, 'attempted');
      } else {
        assert.equal(operations.find((item) => item.action === 'dm-channel.prepare').status, 'confirmed');
        assert.equal(operations.find((item) => item.action === 'owner-safety-notification').status, 'attempted');
      }
    }),
  });
  assert.deepEqual(state.notifier.preflight(), { enabled: true, code: 'OWNER_SAFETY_READY' });
  assert.equal(state.emit(event()), true);
  assert.equal(state.emit(event()), false);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(calls.map((call) => call.route), [
    '/users/@me/channels', `/channels/${CHANNEL_ID}/messages`,
  ]);
  const message = calls[1].options.body;
  assert.match(message.content, new RegExp(`^${FIXED_NOTICE_PREFIX}`));
  assert.doesNotMatch(message.content, /333333|555555|111111|222222|https?:|\\|\//u);
  assert.deepEqual(message.allowed_mentions,
    { parse: [], users: [], roles: [], replied_user: false });
  const operations = Object.values(state.notifier.ledger.getSnapshotForTests().operations);
  assert.equal(operations.length, 2);
  assert.equal(operations.find((item) => item.action === 'dm-channel.prepare').budgetCharged, false);
  assert.equal(operations.find((item) => item.action === 'owner-safety-notification').budgetCharged, true);
  assert.ok(operations.every((item) => item.status === 'confirmed'));
});

test('cold restart uses the persisted channel binding and sends no preparation request', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  state.emit(event());
  await state.notifier.waitForIdleForTests();
  const preparation = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .find((operation) => operation.action === 'dm-channel.prepare');
  assert.equal(preparation.result.channelType, 1);
  assert.equal(preparation.result.recipientId, OWNER_ID);
  assert.equal(preparation.result.recipientCount, 1);
  await state.notifier.stop();
  state.clock.value += 10 * 60_000 + 1;

  const secondContext = { ...CONTEXT, sourceEventId: '333333333333333334' };
  const replay = reopen(state, { context: secondContext });
  assert.equal(replay.notifier.preflight().enabled, true);
  assert.equal(replay.emit(event('LEDGER_SAMPLE_NOTICE')), true);
  await replay.notifier.waitForIdleForTests();
  assert.deepEqual(replay.calls.map((call) => call.route), [`/channels/${CHANNEL_ID}/messages`]);
  await replay.notifier.stop();
});

test('cold restart rejects a confirmed binding that lacks original DM evidence', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  state.emit(event());
  await state.notifier.waitForIdleForTests();
  await state.notifier.stop();

  rewriteStoredResult(state.filePath, 'dm-channel.prepare', (result) => {
    delete result.channelType;
    delete result.recipientId;
    delete result.recipientCount;
  });

  const replay = reopen(state);
  assert.deepEqual(replay.notifier.preflight(), {
    enabled: false,
    code: 'OWNER_SAFETY_LEDGER_UNAVAILABLE',
  });
  assert.equal(replay.emit(event()), false);
  assert.equal(replay.calls.length, 0);
  await replay.notifier.stop();
});

test('expired non-attempted claims recover with a new generation before any POST', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const preparation = buildPreparationOperation(BOT_ID, OWNER_ID);
  const stalePreparation = state.notifier.ledger.claim(preparation, { leaseMs: 1 }).operation.generation;
  state.clock.value += 2;
  assert.equal(state.emit(event()), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(state.calls.length, 2);
  // Generations come from one counter per ledger handle, so the recovery's is simply newer.
  assert.ok(state.notifier.ledger.getOperation(preparation.operationId).generation > stalePreparation);

  state.clock.value += 10 * 60_000 + 1;
  const nextContext = { ...CONTEXT, sourceEventId: '333333333333333398' };
  const notice = buildOperation(event('LEDGER_SAMPLE_NOTICE'), nextContext, OWNER_ID);
  const staleNotice = state.notifier.ledger.claim(notice, { leaseMs: 1 }).operation.generation;
  state.clock.value += 2;
  state.notifier.getContext = () => nextContext;
  assert.equal(state.emit(event('LEDGER_SAMPLE_NOTICE')), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(state.calls.length, 3);
  assert.ok(state.notifier.ledger.getOperation(notice.operationId).generation > staleNotice);
  assert.equal(state.notifier.ledger.getOperation(notice.operationId).status, 'confirmed');
});

test('wrong owner, group DM, and extra recipient responses become unknown and never send', async (t) => {
  const invalid = [
    { id: CHANNEL_ID, type: 1, recipients: [{ id: '666666666666666666' }] },
    { id: CHANNEL_ID, type: 3, recipients: [{ id: OWNER_ID }] },
    { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }, { id: '666666666666666666' }] },
  ];
  for (const [index, response] of invalid.entries()) {
    let calls = 0;
    const state = fixture(t, {
      context: { ...CONTEXT, sourceEventId: `33333333333333335${index}` },
      post: async (route) => {
        calls += 1;
        assert.equal(route, '/users/@me/channels');
        return response;
      },
    });
    state.notifier.preflight();
    state.emit(event());
    await state.notifier.waitForIdleForTests();
    assert.equal(calls, 1);
    const operations = Object.values(state.notifier.ledger.getSnapshotForTests().operations);
    assert.equal(operations.length, 2);
    assert.equal(operations.find((item) => item.action === 'dm-channel.prepare').status, 'unknown');
    const notice = operations.find((item) => item.action === 'owner-safety-notification');
    assert.equal(notice.status, 'final');
    assert.equal(notice.budgetCharged, false);
  }
});

test('unknown preparation and preparation finish fault never prepare or send after restart', async (t) => {
  for (const scenario of ['request-failure', 'finish-failure']) {
    let failFinish = scenario === 'finish-failure';
    let calls = 0;
    const state = fixture(t, {
      post: async () => {
        calls += 1;
        if (scenario === 'request-failure') throw new Error('synthetic reset');
        return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
      },
      faultInjector({ label, phase }) {
        if (failFinish && label === 'finish' && phase === 'before-ledger-write') {
          failFinish = false;
          throw new Error('synthetic finish fault');
        }
      },
    });
    state.notifier.preflight();
    state.emit(event());
    await state.notifier.waitForIdleForTests();
    assert.equal(calls, 1);
    await state.notifier.stop();

    const replay = reopen(state, { post: async () => { calls += 1; } });
    const ready = replay.notifier.preflight();
    assert.equal(ready.enabled, true);
    assert.equal(replay.emit(event()), false);
    await replay.notifier.waitForIdleForTests();
    assert.equal(calls, 1);
    await replay.notifier.stop();
  }
});

// A durable outcome of the DM preparation is final: it is never tried again, so no notice of this
// Owner ledger can be sent, in this process or any later one, until the ledger is reinitialized
// (safety-ledger status reports it). Each process says so once.
test('a DM preparation that reached Discord and ended unknown or rejected blocks every notice, said once per process',
  async (t) => {
    for (const [expected, failure] of [
      ['unknown', () => new Error('synthetic reset')],
      ['rejected', () => Object.assign(new Error('Missing Access'), { status: 403, code: 50001 })],
    ]) {
      const line = `[OWNER_SAFETY] code=OWNER_SAFETY_DM_PREPARATION_BLOCKED state=${expected}`;
      for (const code of OWNER_NOTICE_CODES) assert.equal(notifiesOwner(code), true, code);
      const preparationId = buildPreparationOperation(BOT_ID, OWNER_ID).operationId;
      // What the queueing step found for the DM preparation, notice by notice: a notice dropped right
      // after that lookup was dropped for it (each one comes from a new event, an hour apart, so neither
      // the catalogue, the budget, nor an earlier operation of its own stops it).
      const watchPreparation = (ledger) => {
        const seen = [];
        const getOperation = ledger.getOperation.bind(ledger);
        ledger.getOperation = (operationId) => {
          const found = getOperation(operationId);
          if (operationId === preparationId) seen.push(found?.status ?? null);
          return found;
        };
        return seen;
      };
      let posts = 0;
      const state = fixture(t, { post: async () => { posts += 1; throw failure(); } });
      state.notifier.preflight();
      assert.equal(state.emit(noticeEvent()), true);
      await state.notifier.waitForIdleForTests();
      const preparation = durableOperations(state.notifier).find((operation) => operation.action === DM_PREPARATION_ACTION);
      assert.equal(preparation.status, expected);
      assert.deepEqual(state.logs.filter((text) => text.includes('DM_PREPARATION_BLOCKED')), [line]);
      // Every later notice is dropped at that step, before any request, without another line.
      const seen = watchPreparation(state.notifier.ledger);
      assert.equal(await emitLater(state, 60 * 60_000), false);
      assert.deepEqual(seen, [expected]);
      assert.equal(await emitLater(state, 60 * 60_000), false);
      assert.deepEqual(seen, [expected, expected]);
      assert.equal(posts, 1);
      assert.deepEqual(state.logs.filter((text) => text.includes('DM_PREPARATION_BLOCKED')), [line]);
      await state.notifier.stop();

      // The next start says it once, at its preflight, and still sends nothing.
      const logs = [];
      const replay = reopen(state, { logs, post: async () => { posts += 1; } });
      assert.equal(replay.notifier.preflight().enabled, true);
      assert.deepEqual(logs, [line]);
      const replaySeen = watchPreparation(replay.notifier.ledger);
      assert.equal(replay.emit(noticeEvent(1)), false);
      assert.deepEqual(replaySeen, [expected]);
      await replay.notifier.waitForIdleForTests();
      assert.deepEqual([posts, logs], [1, [line]]);
      await replay.notifier.stop();
    }
  });

test('unknown or final message outcomes never resend after restart', async (t) => {
  for (const scenario of ['request-failure', 'finish-failure']) {
    let failFinish = scenario === 'finish-failure';
    let calls = 0;
    const state = fixture(t, {
      post: async (route) => {
        calls += 1;
        if (route === '/users/@me/channels') {
          return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
        }
        if (scenario === 'request-failure') throw new Error('synthetic timeout');
        return { id: '999999999999999999' };
      },
      faultInjector({ label, phase }) {
        if (failFinish && label === 'finish' && phase === 'before-ledger-write' && calls === 2) {
          failFinish = false;
          throw new Error('synthetic finish fault');
        }
      },
    });
    state.notifier.preflight();
    state.emit(event());
    await state.notifier.waitForIdleForTests();
    assert.equal(calls, 2);
    await state.notifier.stop();

    const replay = reopen(state, { post: async () => { calls += 1; } });
    const ready = replay.notifier.preflight();
    assert.equal(ready.enabled, true);
    assert.equal(replay.emit(event()), false);
    await replay.notifier.waitForIdleForTests();
    assert.equal(calls, 2);
    await replay.notifier.stop();
  }
});

test('one unknown notice stays charged but does not block a later qualified notice', async (t) => {
  let messageCalls = 0;
  const state = fixture(t, {
    post: async (route) => {
      if (route === '/users/@me/channels') {
        return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
      }
      messageCalls += 1;
      if (messageCalls === 1) throw new Error('synthetic unknown');
      return { id: '999999999999999999' };
    },
  });
  state.notifier.preflight();
  state.emit(event());
  await state.notifier.waitForIdleForTests();
  state.clock.value += 10 * 60_000 + 1;
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333333399' });
  assert.equal(state.emit(event('LEDGER_SAMPLE_NOTICE')), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(messageCalls, 2);
  const notices = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.action === 'owner-safety-notification');
  assert.deepEqual(notices.map((operation) => operation.status).sort(), ['confirmed', 'unknown']);
  assert.ok(notices.every((operation) => operation.budgetCharged === true));
});

test('discord.js retries never send an Owner notice twice', async (t) => {
  // REST retries above 0 make discord.js retry a 5xx itself; the protected channel lets the
  // notice reach the network once.
  let messageCalls = 0;
  const state = fixture(t, {
    retries: 3,
    post: async (route) => {
      if (route === '/users/@me/channels') return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
      messageCalls += 1;
      throw Object.assign(new Error('synthetic 503'), { status: 503 });
    },
  });
  state.notifier.preflight();
  state.emit(event());
  await state.notifier.waitForIdleForTests();
  assert.equal(messageCalls, 1);
  const notices = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.action === 'owner-safety-notification');
  assert.deepEqual(notices.map((operation) => operation.status), ['unknown']);
});

test('a REST that cannot carry the protected channel turns the notifier off and is never escalated', async (t) => {
  const state = fixture(t);
  await state.notifier.stop();
  const ledger = openSideEffectLedger({ filePath: state.filePath, expectedReceiptSha256: state.initialized.receiptSha256,
    expectedIdentity: IDENTITY, now: () => state.clock.value });
  const told = [];
  let posts = 0;
  const notifier = new OwnerSafetyNotifier({
    client: { rest: { options: { retries: 0 }, post: async () => { posts += 1; } } },
    ownerId: OWNER_ID, botId: BOT_ID, logger: { warn() {} }, env: {}, installHandler: () => () => {},
    onPurposeDisabled: (purposeId, code) => told.push([purposeId, code]),
  });
  // OWNER_SAFETY_DISABLED, like a notifier that cannot take any ledger: exit code 3 stays for
  // faults of the Owner ledger itself.
  assert.deepEqual(notifier.preflight({ ledgers: new Map([['owner-safety', ledger]]) }),
    { enabled: false, code: 'OWNER_SAFETY_DISABLED' });
  assert.deepEqual(notifier.getLedgerEscalations(), []);
  assert.deepEqual(told, [['owner-safety', 'OWNER_SAFETY_DISABLED']]);
  assert.equal(posts, 0);
  await notifier.stop();
  assert.equal(ledger.closed, false);
  ledger.close();
});

// The operations of the Owner ledger that are durable rows (a decision kept only in memory
// is not).
function durableOperations(notifier) {
  return Object.values(notifier.ledger.getSnapshotForTests().operations).filter((operation) => operation.durable);
}

// Makes the next request to `fullRoute` fail above the network, as test-control or an egress
// rule would; nothing reaches the transport for it. Answers how many were refused.
function refuseNextRequest(state, fullRoute, code) {
  const request = state.client.rest.request.bind(state.client.rest);
  const refused = { count: 0 };
  state.client.rest.request = async (options) => {
    if (options.fullRoute === fullRoute && refused.count === 0) {
      refused.count += 1;
      throw Object.assign(new Error('synthetic refusal'), { code });
    }
    return request(options);
  };
  return refused;
}

// Refuses the first `refusals` DM preparations above the network, as test-control or an egress
// rule would. Answers how many were refused.
function refuseDmPreparations(state, refusals) {
  const request = state.client.rest.request.bind(state.client.rest);
  const refused = { count: 0 };
  state.client.rest.request = async (options) => {
    if (options.fullRoute === '/users/@me/channels' && refused.count < refusals) {
      refused.count += 1;
      throw Object.assign(new Error('synthetic refusal'), { code: 'TEST_DM_DENIED' });
    }
    return request(options);
  };
  return refused;
}

// One more AI safety notice, waitMs later, from its own source event.
let retrySource = 0;
async function emitLater(state, waitMs) {
  state.clock.value += waitMs;
  retrySource += 1;
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: `3333333333333334${String(retrySource).padStart(2, '0')}` });
  // Never the first code (noticeEvent()), and no code twice in a row of three: a notice that ended
  // unsent opens a 10-minute merge window for its own kind.
  const queued = state.emit(noticeEvent(1 + (retrySource % (OWNER_NOTICE_CODES.length - 1))));
  await state.notifier.waitForIdleForTests();
  return queued;
}

const PREPARATION_STOPPED = '[OWNER_SAFETY] code=OWNER_SAFETY_DM_PREPARATION_STOPPED failures=3';

test('a DM preparation refused before the network is tried again after 1 and then 5 minutes, and then sends',
  async (t) => {
    const calls = [];
    const state = fixture(t, { post: successfulPost(calls) });
    const refused = refuseDmPreparations(state, 2);
    state.notifier.preflight();
    assert.equal(state.emit(noticeEvent()), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(refused.count, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(durableOperations(state.notifier), []);
    // Each failure has its own bounded retry wait. These rejected preparations never
    // produce a durable notification row.
    assert.equal(await emitLater(state, 60_001), true);
    assert.equal(refused.count, 2);
    assert.deepEqual(calls, []);
    assert.equal(await emitLater(state, 5 * 60_000 + 1), true);
    assert.deepEqual(calls.map((call) => call.route), ['/users/@me/channels', `/channels/${CHANNEL_ID}/messages`]);
    assert.deepEqual(durableOperations(state.notifier).map((operation) => [operation.action, operation.status]).sort(),
      [['dm-channel.prepare', 'confirmed'], ['owner-safety-notification', 'confirmed']]);
    assert.equal(state.logs.includes(PREPARATION_STOPPED), false);
  });

test('the third DM preparation refused before the network stops Owner DMs until the next start, with one log line',
  async (t) => {
    assert.equal(MAX_DM_PREPARATION_FAILURES, 3);
    const calls = [];
    const state = fixture(t, { post: successfulPost(calls) });
    const refused = refuseDmPreparations(state, Infinity);
    state.notifier.preflight();
    assert.equal(state.emit(noticeEvent()), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(await emitLater(state, 60_001), true);
    assert.equal(state.logs.includes(PREPARATION_STOPPED), false, 'not after the second failure');
    assert.equal(await emitLater(state, 5 * 60_000 + 1), true);
    assert.equal(refused.count, 3);
    assert.deepEqual(state.logs.filter((line) => line.includes('OWNER_SAFETY_DM_PREPARATION_STOPPED')), [PREPARATION_STOPPED]);
    const preparation = state.notifier.ledger.getOperation(buildPreparationOperation(BOT_ID, OWNER_ID).operationId);
    assert.deepEqual([preparation.durable, preparation.status, preparation.prepareFailures], [false, 'final', 3]);
    // Every later notice of this process is dropped before any request, with no further line.
    assert.equal(await emitLater(state, 30 * 60_000 + 1), false);
    assert.equal(await emitLater(state, 60 * 60_000 + 1), false);
    assert.equal(state.notifier.notifyLedgerEvent({ category: 'runtime', key: 'a'.repeat(64), mergeScope: 'welcome',
      content: '小吉安全帳本通知：固定內容' }), false);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual([refused.count, calls], [3, []]);
    assert.deepEqual(state.logs.filter((line) => line.includes('OWNER_SAFETY_DM_PREPARATION_STOPPED')), [PREPARATION_STOPPED]);
    assert.deepEqual(durableOperations(state.notifier), []);

    // The next start prepares the DM channel again.
    await state.notifier.stop();
    state.clock.value += 60_001;
    const restarted = reopen(state, { context: { ...CONTEXT, sourceEventId: '333333333333333500' } });
    assert.equal(restarted.notifier.preflight().enabled, true);
    assert.equal(restarted.emit(noticeEvent()), true);
    await restarted.notifier.waitForIdleForTests();
    assert.deepEqual(restarted.calls.map((call) => call.route), ['/users/@me/channels', `/channels/${CHANNEL_ID}/messages`]);
    await restarted.notifier.stop();
  });

// The settled preparation is a decision in memory: when the ledger's in-memory map is full it may
// be forgotten (oldest settled decisions go first), and the preparation is tried three more times.
// The line is still written once per process.
test('a preparation stopped twice in one process (its first stop forgotten for capacity) is logged once', async (t) => {
  const calls = [];
  const state = fixture(t, { post: successfulPost(calls) });
  const refused = refuseDmPreparations(state, Infinity);
  state.notifier.preflight();
  assert.equal(state.emit(noticeEvent()), true);
  await state.notifier.waitForIdleForTests();
  await emitLater(state, 60_001);
  await emitLater(state, 5 * 60_000 + 1);
  assert.equal(refused.count, 3);
  const preparationId = buildPreparationOperation(BOT_ID, OWNER_ID).operationId;
  assert.equal(state.notifier.ledger.getOperation(preparationId).status, 'final');
  // Fill the in-memory map with other settled decisions until the stopped preparation is forgotten.
  for (let index = 0; index < MAX_VOLATILE_OPERATIONS; index += 1) {
    const binding = buildOperation(noticeEvent(), { ...CONTEXT, sourceEventId: String(400000000000000000n + BigInt(index)) },
      OWNER_ID);
    state.notifier.ledger.finalizeUnattempted(binding, 'capacity_filler');
  }
  assert.equal(state.notifier.ledger.getOperation(preparationId), null);
  // Three more refused preparations settle it again.
  assert.equal(await emitLater(state, 60 * 60_000 + 1), true);
  assert.equal(await emitLater(state, 60_001), true);
  assert.equal(await emitLater(state, 5 * 60_000 + 1), true);
  assert.equal(refused.count, 6);
  assert.equal(state.notifier.ledger.getOperation(preparationId).status, 'final');
  assert.deepEqual(state.logs.filter((line) => line.includes('OWNER_SAFETY_DM_PREPARATION_STOPPED')), [PREPARATION_STOPPED]);
  assert.deepEqual(calls, []);
});

// The fourth start after three that failed: the real guard, on its own data root. succeed()
// stands for ten minutes after ready.
function heldStartGuard(t) {
  const root = makeRealTempDir('xiaoji-owner-safety-guard-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeGuardFile(path.join(root, GUARD_FILE_NAME), 3, 1);
  const timers = [];
  const guard = createOwnerDmStartGuard({ env: { XIAOJI_DATA_ROOT: root }, coinDbPath: path.join(root, 'xiaoji.sqlite'),
    logger: { info() {}, warn() {} }, setTimer: (callback) => { timers.push(callback); return { unref() {} }; } });
  guard.begin();
  assert.equal(guard.allowsOwnerDm(), false);
  return { guard, succeed: () => { guard.noteReady(); timers[0](); assert.equal(guard.allowsOwnerDm(), true); } };
}

const GUARD_LINE = (kind, skipped, category = null) =>
  `[OWNER_SAFETY] code=OWNER_DM_GUARD_BLOCKED kind=${kind}${category ? ` category=${category}` : ''} skipped=${skipped}`;

test('while the start guard holds Owner DMs back, notices are dropped without touching the ledger and never sent later',
  async (t) => {
    const held = heldStartGuard(t);
    const calls = [];
    const state = fixture(t, { post: successfulPost(calls), ownerDmGate: held.guard });
    state.notifier.preflight();
    assert.equal(state.emit(noticeEvent()), false);
    const ledgerNotice = { category: 'startup', key: 'b'.repeat(64), mergeScope: 'boot', content: '小吉安全帳本通知（本次啟動）' };
    assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice), false);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(calls, [], 'no DM channel is prepared and nothing is sent');
    assert.deepEqual(state.logs, [GUARD_LINE('safety-event', 0, 'critical'), GUARD_LINE('ledger-notice', 0)]);
    // Nothing reached the ledger: no claim, no decision, no merge window, nothing durable.
    assert.deepEqual(state.notifier.ledger.getSnapshotForTests().operations, {});
    assert.equal(state.notifier.getStatsForTests().queueLength, 0);
    // More within the minute are counted, not logged; the next line says how many were left out.
    for (let index = 0; index < 5; index += 1) {
      state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(333333333333333700n + BigInt(index)) });
      assert.equal(state.emit(noticeEvent()), false);
    }
    assert.equal(state.logs.length, 2);
    state.clock.value += 60_000;
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333333800' });
    assert.equal(state.emit(noticeEvent()), false);
    assert.deepEqual(state.logs.at(-1), GUARD_LINE('safety-event', 5, 'critical'));

    // Ten minutes after ready the start succeeded: new notices are sent again at once.
    held.succeed();
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333333600' });
    assert.equal(state.emit(noticeEvent()), true);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(calls.map((call) => call.route), ['/users/@me/channels', `/channels/${CHANNEL_ID}/messages`]);
    assert.equal(calls[1].options.body.content.includes('已合併'), false, 'nothing held back is counted into it');
    // What was held back is never sent: the same event and the same ledger notice again.
    state.clock.value += 10 * 60_000 + 1;
    state.notifier.getContext = () => CONTEXT;
    assert.equal(state.emit(noticeEvent()), false);
    assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice), false);
    await state.notifier.waitForIdleForTests();
    assert.equal(calls.length, 2);
    assert.deepEqual(durableOperations(state.notifier).map((operation) => [operation.action, operation.status]).sort(),
      [['dm-channel.prepare', 'confirmed'], ['owner-safety-notification', 'confirmed']]);
  });

test('fifty audit events held back by the start guard leave the notice budget whole: the first audit notice after goes out',
  async (t) => {
    const held = heldStartGuard(t);
    const calls = [];
    const state = fixture(t, { post: successfulPost(calls), ownerDmGate: held.guard });
    state.notifier.preflight();
    const audit = (index) => {
      state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(333333333333340000n + BigInt(index)),
        scope: `guild:${String(111111111111111111n + BigInt(index % 10))}` });
      return state.emit(Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: state.clock.value }));
    };
    // Ten bursts of five, a minute and a second apart: one line per burst, with what it left out.
    for (let burst = 0; burst < 10; burst += 1) {
      if (burst) state.clock.value += 61_000;
      for (let index = 0; index < 5; index += 1) assert.equal(audit(burst * 5 + index), false);
    }
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(calls, []);
    const heldLines = [...state.logs];

    // The start succeeds a second later; the first audit notice, in a guild just held back, is sent:
    // neither the intake budget (six an hour) nor a merge window was used by what was held back.
    held.succeed();
    state.clock.value += 1_000;
    assert.equal(audit(49), false, 'the very same event stays held back');
    assert.equal(audit(50), true, 'the first audit notice after the DMs resume is accepted');
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(calls.map((call) => call.route), ['/users/@me/channels', `/channels/${CHANNEL_ID}/messages`],
      'and sent');
    assert.match(calls[1].options.body.content, /AUDIT_GUILD_JOINED/u);
    assert.equal(calls[1].options.body.content.includes('已合併'), false);
    // Nothing held back reached the ledger, and the lines were held to one a minute.
    assert.deepEqual(durableOperations(state.notifier).map((operation) => operation.action).sort(),
      ['dm-channel.prepare', 'owner-safety-notification']);
    assert.equal(Object.keys(state.notifier.ledger.getSnapshotForTests().operations).length, 2);
    assert.deepEqual(heldLines, [GUARD_LINE('safety-event', 0, 'audit'),
      ...Array.from({ length: 9 }, () => GUARD_LINE('safety-event', 4, 'audit'))]);
  });

test('a start guard that cannot answer holds the notice back', async (t) => {
  const calls = [];
  const state = fixture(t, { post: successfulPost(calls),
    ownerDmGate: { allowsOwnerDm() { throw new Error('synthetic gate failure'); } } });
  state.notifier.preflight();
  assert.equal(state.emit(noticeEvent()), false);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual([calls, state.logs], [[], [GUARD_LINE('safety-event', 0, 'critical')]]);
  assert.equal(state.notifier.isReady(), true, 'the notifier itself stays usable');
});

test('a DM preparation still waiting when the notifier stops is never sent and leaves no row', async (t) => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const prepared = [];
  const state = fixture(t, {
    post: async (route, { body }) => {
      if (route === '/users/@me/channels') {
        prepared.push(body.marker || 'notifier');
        if (body.marker === 'ordinary') await blocker;
        return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
      }
      return { id: '999999999999999999' };
    },
  });
  // The preparation's request is seen as it enters the REST, before discord.js queues it.
  let issued;
  const issuedPromise = new Promise((resolve) => { issued = resolve; });
  const request = state.client.rest.request.bind(state.client.rest);
  state.client.rest.request = (options) => {
    if (options.fullRoute === '/users/@me/channels' && !options.body?.marker) issued();
    return request(options);
  };
  state.notifier.preflight();
  // An ordinary request holds the route's queue; the preparation waits behind it.
  const ordinary = state.client.rest.post('/users/@me/channels', { body: { recipient_id: OWNER_ID, marker: 'ordinary' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(state.emit(event()), true);
  await issuedPromise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stopping = state.notifier.stop();
  release();
  await ordinary;
  await stopping;
  assert.deepEqual(prepared, ['ordinary']);
  const reopened = openSideEffectLedger({ filePath: state.filePath, expectedReceiptSha256: state.initialized.receiptSha256,
    expectedIdentity: IDENTITY, now: () => state.clock.value });
  try {
    assert.deepEqual(reopened.getSnapshotForTests().operations, {});
  } finally {
    reopened.close();
  }
});

test('an Owner notice refused before the network writes nothing and gives its budget back', async (t) => {
  const calls = [];
  const state = fixture(t, { post: successfulPost(calls) });
  refuseNextRequest(state, `/channels/${CHANNEL_ID}/messages`, 'TEST_CHANNEL_EGRESS_DENIED');
  state.notifier.preflight();
  assert.equal(state.emit(event()), true);
  await state.notifier.waitForIdleForTests();
  const notices = () => Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.action === 'owner-safety-notification');
  assert.deepEqual(notices().map((operation) => [operation.durable, operation.status, operation.resultCode,
    operation.budgetCharged]), [[false, 'final', 'refused_before_dispatch', false]]);
  // Nothing of the budget (one notice a minute) was spent: the next notice is sent at once.
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333333397' });
  assert.equal(state.emit(event('LEDGER_SAMPLE_NOTICE')), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`).length, 1);
});

test('Discord\'s refusal of an Owner notice is recorded rejected and never sent again', async (t) => {
  let messageCalls = 0;
  const state = fixture(t, {
    post: async (route) => {
      if (route === '/users/@me/channels') return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
      messageCalls += 1;
      throw Object.assign(new Error('Cannot send messages to this user'), { status: 403, code: 50007 });
    },
  });
  state.notifier.preflight();
  assert.equal(state.emit(event()), true);
  await state.notifier.waitForIdleForTests();
  const [notice] = durableOperations(state.notifier).filter((operation) => operation.action === 'owner-safety-notification');
  assert.deepEqual([notice.status, notice.resultCode, notice.result],
    ['rejected', 'message_rejected_permission', { httpStatus: 403, discordCode: 50007 }]);
  assert.equal(state.emit(event()), false);
  await state.notifier.waitForIdleForTests();
  assert.equal(messageCalls, 1);
});

test('channel response and persisted binding validators reject semantic tampering', () => {
  const evidence = validateCreatedDm({ id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] }, OWNER_ID);
  assert.deepEqual(evidence, {
    channelId: CHANNEL_ID,
    channelType: 1,
    recipientId: OWNER_ID,
    recipientCount: 1,
  });
  assert.equal(validateCreatedDm({ id: CHANNEL_ID, type: 3, recipients: [{ id: OWNER_ID }] }, OWNER_ID), null);
  const operation = { ...buildPreparationOperation(BOT_ID, OWNER_ID), bindingDigest: 'a'.repeat(64) };
  const valid = buildChannelBinding(operation, evidence, BOT_ID, OWNER_ID);
  assert.equal(validateChannelBinding(valid, operation, BOT_ID, OWNER_ID), CHANNEL_ID);
  assert.equal(validateChannelBinding({ ...valid, ownerId: '666666666666666666' }, operation, BOT_ID, OWNER_ID), null);
  assert.equal(validateChannelBinding({ ...valid, channelType: 3 }, operation, BOT_ID, OWNER_ID), null);
  assert.equal(validateChannelBinding({ ...valid, recipientId: '666666666666666666' }, operation, BOT_ID, OWNER_ID), null);
  assert.equal(validateChannelBinding({ ...valid, recipientCount: 2 }, operation, BOT_ID, OWNER_ID), null);
  assert.equal(validateChannelBinding({ ...valid, extra: true }, operation, BOT_ID, OWNER_ID), null);
  assert.equal(validateChannelBinding({ ...valid, bindingProof: 'b'.repeat(64) }, operation, BOT_ID, OWNER_ID), null);
});

test('identity mismatch, disabled switch, missing ledger, and missing context fail closed only for notifications', async (t) => {
  const disabled = fixture(t, { enabled: false });
  assert.deepEqual(disabled.notifier.preflight(), { enabled: false, code: 'OWNER_SAFETY_DISABLED' });
  assert.equal(disabled.emit(event()), false);

  const missingContext = fixture(t, { context: null });
  assert.equal(missingContext.notifier.preflight().enabled, true);
  assert.equal(missingContext.emit(event()), false);
  assert.ok(missingContext.logs.some((line) => line.includes('OWNER_SAFETY_SOURCE_UNAVAILABLE')));

  const root = makeRealTempDir('xiaoji-owner-missing-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let restored = false;
  const notifier = new OwnerSafetyNotifier({
    client: { rest: createSyntheticRest({ post: async () => assert.fail('must not post') }) },
    ownerId: OWNER_ID,
    botId: BOT_ID,
    logger: { warn() {} },
    // The variables of the retired environment-configured ledger are ignored.
    env: {
      XIAOJI_OWNER_SAFETY_DM_ENABLED: 'true',
      XIAOJI_SIDE_EFFECT_LEDGER_PATH: path.join(root, 'missing.json'),
      XIAOJI_SIDE_EFFECT_LEDGER_PROVENANCE_SHA256: 'a'.repeat(64),
    },
    installHandler() { return () => { restored = true; }; },
  });
  notifier.install();
  assert.deepEqual(notifier.preflight(), { enabled: false, code: 'OWNER_SAFETY_DISABLED' });
  assert.deepEqual(notifier.preflight({ ledgers: new Map() }), { enabled: false, code: 'OWNER_SAFETY_DISABLED' });
  assert.deepEqual(fs.readdirSync(root), []);
  await notifier.stop();
  assert.equal(restored, true);
});

test('source capacity rejection disables Owner notification before any delivery POST', async (t) => {
  const capacityError = () => Object.assign(new Error('synthetic source capacity'), {
    code: 'SIDE_EFFECT_CAPACITY_EXCEEDED',
  });
  const state = fixture(t, {
    ledgerFactory: ({ filePath }) => ({
      purposeId: 'owner-safety',
      provenance: { notificationIdentity: { botId: BOT_ID, ownerId: OWNER_ID } },
      locations: pathsFor(filePath),
      identityCounters: { bootEpoch: 1, beginSeq: 0, chainHead: 'synthetic' },
      observedNow: () => 1_000,
      getOperation: () => null,
      claim() { throw capacityError(); },
      finalizeUnattempted() { throw capacityError(); },
      close() {},
    }),
  });
  assert.deepEqual(state.notifier.preflight(), { enabled: true, code: 'OWNER_SAFETY_READY' });
  assert.equal(state.emit(event()), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(state.calls.length, 0);
  assert.equal(state.notifier.getStatsForTests().disabled, true);
  assert.ok(state.logs.some((line) => line.includes('OWNER_SAFETY_FINAL_PERSIST_FAILED')));
});

test('queue is fixed at 128, worker concurrency is one, and overflow stays memory-only', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  state.notifier.kickDrain = () => {};
  for (let index = 0; index < QUEUE_LIMIT; index += 1) state.notifier.queue.push({ synthetic: index });
  assert.equal(state.emit(event()), false);
  assert.equal(WORKER_CONCURRENCY, 1);
  assert.equal(state.notifier.getStatsForTests().queueLength, QUEUE_LIMIT);
  const operations = Object.values(state.notifier.ledger.getSnapshotForTests().operations);
  assert.equal(operations.length, 0);
  state.notifier.queue.length = 0;
});

test('shutdown finalizes queued notices without charging budget, posting, or a durable write', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  state.notifier.kickDrain = () => {};
  assert.equal(state.emit(event()), true);
  const captured = captureOnClose(state.notifier.ledger);
  await state.notifier.stop();
  assert.equal(state.calls.length, 0);
  const [operation] = captured.operations;
  assert.equal(operation.status, 'final');
  assert.equal(operation.resultCode, 'shutdown_before_dispatch');
  assert.equal(operation.budgetCharged, false);
  assert.equal(operation.durable, false);
  const ledger = openSideEffectLedger({
    filePath: state.filePath,
    expectedReceiptSha256: state.initialized.receiptSha256,
    expectedIdentity: IDENTITY,
  });
  // Format 2 keeps pre-dispatch decisions in memory only, so nothing reached the file.
  assert.deepEqual(ledger.getSnapshotForTests().operations, {});
  ledger.close();
});

test('shutdown during an in-flight preparation persists proof but starts no message POST', async (t) => {
  let finishPreparation;
  let markPreparationStarted;
  const preparationStarted = new Promise((resolve) => { markPreparationStarted = resolve; });
  const routes = [];
  const state = fixture(t, {
    dispatchTimeoutMs: 1_000,
    post: async (route) => {
      routes.push(route);
      if (route !== '/users/@me/channels') assert.fail('message POST started after shutdown');
      markPreparationStarted();
      return new Promise((resolve) => { finishPreparation = resolve; });
    },
  });
  state.notifier.preflight();
  assert.equal(state.emit(event()), true);
  await preparationStarted;
  const captured = captureOnClose(state.notifier.ledger);
  const stopping = state.notifier.stop();
  finishPreparation({ id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] });
  await stopping;
  assert.deepEqual(routes, ['/users/@me/channels']);
  const finalized = captured.operations.find((operation) => operation.action === 'owner-safety-notification');
  assert.equal(finalized.status, 'final');
  assert.equal(finalized.resultCode, 'shutdown_before_dispatch');
  assert.equal(finalized.budgetCharged, false);

  const ledger = openSideEffectLedger({
    filePath: state.filePath,
    expectedReceiptSha256: state.initialized.receiptSha256,
    expectedIdentity: IDENTITY,
  });
  const operations = Object.values(ledger.getSnapshotForTests().operations);
  const preparation = operations.find((operation) => operation.action === 'dm-channel.prepare');
  const notice = operations.find((operation) => operation.action === 'owner-safety-notification');
  assert.equal(preparation.status, 'confirmed');
  assert.equal(validateChannelBinding(preparation.result, preparation, BOT_ID, OWNER_ID), CHANNEL_ID);
  // The unsent notice was finalized in memory only, so no durable row exists for it.
  assert.equal(notice, undefined);
  ledger.close();
});

test('real safety hook keeps async context across await and teardown restores the prior handler', async () => {
  let received = null;
  const restore = require('../src/systems/conversation/safetyEvents')
    .setConversationSafetyEventHandler((value) => {
      received = { event: value, context: getHostOperationContext() };
    });
  await runWithHostOperationContext(CONTEXT, async () => {
    await Promise.resolve();
    emitConversationSafetyEvent(CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_URL_BLOCKED);
  });
  restore();
  assert.equal(received.event.code, CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_URL_BLOCKED);
  assert.deepEqual(received.context, CONTEXT);
});

test('result digest makes a forged persisted channel binding corrupt even with a matching anchor', (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  state.emit(event());
  return state.notifier.waitForIdleForTests().then(async () => {
    await state.notifier.stop();
    rewriteStoredResult(state.filePath, 'dm-channel.prepare', (result) => {
      result.channelId = '666666666666666666';
    }, { updateDigest: false });
    // Format 2 verifies each row's digests whenever it is read, so the forged row is
    // corrupt for every reader and the notifier fails closed on it.
    const ledger = openSideEffectLedger({
      filePath: state.filePath,
      expectedReceiptSha256: state.initialized.receiptSha256,
      expectedIdentity: IDENTITY,
    });
    try {
      assert.equal(ledger.failed, false);
      assert.throws(() => ledger.getOperation(buildPreparationOperation(BOT_ID, OWNER_ID).operationId),
        (error) => error.code === 'SIDE_EFFECT_FILE_CORRUPT');
      // The corrupt read marks the handle failed, so callers can stop using it.
      assert.equal(ledger.failed, true);
    } finally {
      ledger.close();
    }
    const replay = reopen(state);
    assert.deepEqual(replay.notifier.preflight(), {
      enabled: false,
      code: 'OWNER_SAFETY_LEDGER_UNAVAILABLE',
    });
    await replay.notifier.stop();
  });
});

test('an Owner ledger that fails or is quarantined stops notices at once, before any POST', async (t) => {
  const quarantined = fixture(t);
  assert.equal(quarantined.notifier.preflight().enabled, true);
  quarantined.notifier.ledger.quarantine('SYNTHETIC_REVIEW');
  assert.equal(quarantined.emit(event()), false);
  await quarantined.notifier.waitForIdleForTests();
  assert.equal(quarantined.calls.length, 0);
  assert.ok(quarantined.logs.includes('[OWNER_SAFETY] code=OWNER_SAFETY_LEDGER_QUARANTINED'), quarantined.logs.join('\n'));

  // A read that failed elsewhere leaves only the store marked failed.
  const failing = fixture(t);
  assert.equal(failing.notifier.preflight().enabled, true);
  const original = StatementSync.prototype.get;
  StatementSync.prototype.get = function failingGet(...args) {
    if (this.sourceSQL === STATEMENT_SQL.selectOperation && args[0] === 'owner-safety') {
      throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return original.apply(this, args);
  };
  try {
    assert.throws(() => failing.notifier.ledger.getOperation('synthetic-operation'),
      (error) => error.code === 'SIDE_EFFECT_PERSIST_FAILED');
  } finally {
    StatementSync.prototype.get = original;
  }
  assert.equal(failing.emit(event()), false);
  await failing.notifier.waitForIdleForTests();
  assert.equal(failing.calls.length, 0);
  assert.ok(failing.logs.includes('[OWNER_SAFETY] code=OWNER_SAFETY_LEDGER_FAILED'), failing.logs.join('\n'));
});

test('an Owner ledger the bootstrap could not open is never delivered; a delivered one that does not fit is refused',
  async (t) => {
    const state = fixture(t);
    const database = fs.readFileSync(state.filePath);
    assert.equal(state.notifier.preflight().enabled, true);
    await state.notifier.stop();
    const open = (logs) => new OwnerSafetyNotifier({
      client: { rest: createSyntheticRest({ post: async () => { throw new Error('must not send'); } }) },
      ownerId: OWNER_ID,
      botId: BOT_ID,
      logger: { warn: (line) => logs.push(String(line)) },
      env: {},
      now: () => state.clock.value,
      installHandler: () => () => {},
    });
    const openOwner = () => openSideEffectLedger({ filePath: state.filePath,
      expectedReceiptSha256: state.initialized.receiptSha256, expectedIdentity: IDENTITY, now: () => state.clock.value });

    // The ledger goes back to its state before the last boot; the witness beside it does
    // not. The opener refuses it (in production the bootstrap reports and escalates it).
    fs.writeFileSync(state.filePath, database);
    assert.throws(openOwner, (error) => error.code === 'SIDE_EFFECT_ROLLBACK_DETECTED');
    const rollbackLogs = [];
    const rolledBack = open(rollbackLogs);
    assert.deepEqual(rolledBack.preflight({ ledgers: new Map() }), { enabled: false, code: 'OWNER_SAFETY_DISABLED' });
    assert.deepEqual(rollbackLogs, ['[OWNER_SAFETY] code=OWNER_SAFETY_DISABLED']);
    assert.deepEqual(rolledBack.getLedgerEscalations(), []);
    await rolledBack.stop();

    // A delivered ledger bound to another Owner, or of another purpose, is refused and left
    // open for the bootstrap to close.
    const fresh = fixture(t);
    await fresh.notifier.stop();
    const ledger = openSideEffectLedger({ filePath: fresh.filePath, expectedReceiptSha256: fresh.initialized.receiptSha256,
      expectedIdentity: IDENTITY, now: () => fresh.clock.value });
    // Each refusal of a delivered ledger is told to the alerts (onPurposeDisabled).
    const told = [];
    const otherOwner = new OwnerSafetyNotifier({ client: { rest: createSyntheticRest({ post: async () => {} }) },
      ownerId: '666666666666666666', botId: BOT_ID, logger: { warn() {} }, env: {}, installHandler: () => () => {},
      onPurposeDisabled: (purposeId, code) => told.push([purposeId, code]) });
    assert.deepEqual(otherOwner.preflight({ ledgers: new Map([['owner-safety', ledger]]) }),
      { enabled: false, code: 'OWNER_SAFETY_LEDGER_UNAVAILABLE' });
    // The refused Owner ledger is escalated (exit code 3); a notifier that cannot take any
    // ledger (below) is not, since the bootstrap already reported what keeps it from running.
    assert.deepEqual(otherOwner.getLedgerEscalations().map(({ purposeId, code, stage }) => [purposeId, code, stage]),
      [['owner-safety', 'OWNER_SAFETY_LEDGER_UNAVAILABLE', 'open']]);
    await otherOwner.stop();
    const sameIds = new OwnerSafetyNotifier({ client: { rest: createSyntheticRest({ post: async () => {} }) },
      ownerId: BOT_ID, botId: BOT_ID, logger: { warn() {} }, env: {}, installHandler: () => () => {},
      onPurposeDisabled: (purposeId, code) => told.push([purposeId, code]) });
    assert.deepEqual(sameIds.preflight({ ledgers: new Map([['owner-safety', ledger]]) }),
      { enabled: false, code: 'OWNER_SAFETY_DISABLED' });
    assert.deepEqual(sameIds.getLedgerEscalations(), []);
    await sameIds.stop();
    assert.deepEqual(told, [['owner-safety', 'OWNER_SAFETY_LEDGER_UNAVAILABLE'], ['owner-safety', 'OWNER_SAFETY_DISABLED']]);
    assert.equal(ledger.closed, false);
    ledger.close();
  });

test('notices accepted before arming wait unsent; disableAll ends them; a stop while running is reported once',
  async (t) => {
    const waiting = fixture(t, { armed: false });
    assert.equal(waiting.notifier.preflight().enabled, true);
    assert.equal(waiting.notifier.isReady(), false);
    assert.equal(waiting.emit(event()), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(waiting.calls, []);
    waiting.notifier.arm();
    await waiting.notifier.waitForIdleForTests();
    assert.deepEqual(waiting.calls.map((call) => call.route), ['/users/@me/channels', `/channels/${CHANNEL_ID}/messages`]);
    // quiesce() removes the hook and keeps the ledger open for stop() to close.
    const ledger = waiting.notifier.ledger;
    await waiting.notifier.quiesce();
    assert.equal(waiting.getRestored(), 1);
    assert.equal(waiting.emit(event()), undefined);
    assert.equal(ledger.closed, false);
    await waiting.notifier.stop();
    assert.equal(ledger.closed, true);

    // A bot identity that differs at ready: queued notices end without being sent.
    const refused = fixture(t, { armed: false });
    refused.notifier.preflight();
    assert.equal(refused.emit(event()), true);
    refused.notifier.disableAll('LEDGER_BOT_MISMATCH');
    refused.notifier.arm();
    await refused.notifier.waitForIdleForTests();
    assert.deepEqual(refused.calls, []);
    assert.ok(refused.logs.includes('[OWNER_SAFETY] code=LEDGER_BOT_MISMATCH'));
    const statuses = Object.values(refused.notifier.ledger.getSnapshotForTests().operations)
      .map((operation) => `${operation.status}:${operation.resultCode}`);
    assert.deepEqual(statuses, ['final:disabled_before_dispatch']);

    // A notifier stopped while running tells its listener once.
    const reported = [];
    const running = fixture(t);
    running.notifier.onPurposeDisabled = (purposeId, code) => reported.push([purposeId, code]);
    running.notifier.preflight();
    running.notifier.ledger.quarantine('SYNTHETIC_REVIEW');
    assert.equal(running.emit(event()), false);
    assert.equal(running.emit(event()), false);
    assert.deepEqual(reported, [['owner-safety', 'OWNER_SAFETY_LEDGER_QUARANTINED']]);
  });

test('with protected effects off the notifier touches no delivered ledger', async () => {
  for (const value of ['off', 'later']) {
    const used = [];
    const tripwire = new Proxy({}, { get: (_target, key) => { used.push(String(key)); return undefined; } });
    const notifier = new OwnerSafetyNotifier({ client: { rest: createSyntheticRest({ post: async () => {} }) },
      ownerId: OWNER_ID, botId: BOT_ID, logger: { warn() {} }, env: { XIAOJI_PROTECTED_EFFECTS: value },
      installHandler: () => () => {} });
    assert.deepEqual(notifier.preflight({ ledgers: new Map([['owner-safety', tripwire]]) }),
      { enabled: false, code: 'OWNER_SAFETY_PROTECTED_EFFECTS_OFF' });
    notifier.arm();
    assert.equal(notifier.isReady(), false);
    assert.equal(notifier.notifyLedgerEvent({ category: 'startup', key: 'a'.repeat(64), mergeScope: 'boot', content: 'x' }),
      false);
    await notifier.stop();
    assert.deepEqual(used, []);
  }
});

function ledgerNotice(mergeScope, content, category = 'runtime') {
  return { category, key: crypto.createHash('sha256').update(`${mergeScope}:${content}`).digest('hex'), mergeScope, content };
}

test('a ledger notice goes through the Owner ledger once per boot, merged per scope and within the notice budget',
  async (t) => {
    const state = fixture(t);
    assert.equal(state.notifier.preflight().enabled, true);
    const boot = state.notifier.ledgerBoot;
    assert.ok(Number.isSafeInteger(boot.bootEpoch) && Number.isSafeInteger(boot.sourceTimeMs));
    assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice('welcome', '小吉安全帳本通知：甲')), true);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(state.calls.map((call) => call.route), ['/users/@me/channels', `/channels/${CHANNEL_ID}/messages`]);
    assert.deepEqual(state.calls[1].options.body, { content: '小吉安全帳本通知：甲',
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } });
    const sent = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
      .find((operation) => operation.action === 'owner-ledger-alert');
    assert.equal(sent.status, 'confirmed');
    assert.equal(sent.budgetCharged, true);
    assert.equal(sent.sourceKey, `ledger-alert:bot:${BOT_ID}`);
    assert.equal(sent.sourceTimeMs, boot.sourceTimeMs);
    assert.equal(sent.target, OWNER_ID);
    // The same notice again in this boot is the same operation and is not sent again.
    assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice('welcome', '小吉安全帳本通知：甲')), false);
    // Another notice for the same scope within ten minutes is merged, never sent.
    state.clock.value += 2 * 60_000;
    assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice('welcome', '小吉安全帳本通知：乙')), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.calls.length, 2);
    // Another scope goes out; one more within the same minute is held back by the budget
    // the AI notices share.
    assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice('word-chain.reaction', '小吉安全帳本通知：丙')), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.calls.length, 3);
    assert.equal(state.emit(event()), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.calls.length, 3);
    const statuses = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
      .filter((operation) => ['owner-ledger-alert', 'owner-safety-notification'].includes(operation.action))
      .map((operation) => `${operation.action}:${operation.status}`).sort();
    assert.deepEqual(statuses, ['owner-ledger-alert:confirmed', 'owner-ledger-alert:confirmed',
      'owner-ledger-alert:suppressed_merge', 'owner-safety-notification:suppressed_budget']);
  });

test('a ledger notice binding is fixed by its boot, category, and key, and rejects anything else', async (t) => {
  const input = { botId: BOT_ID, ownerId: OWNER_ID, bootEpoch: 3, sourceTimeMs: 1_700_000_000_000,
    category: 'startup', key: 'a'.repeat(64), mergeScope: 'boot', content: '小吉安全帳本通知（本次啟動）' };
  const binding = buildLedgerAlertOperation(input);
  assert.deepEqual(buildLedgerAlertOperation({ ...input }), binding);
  assert.match(binding.operationId, /^owner-ledger-alert-v1:[a-f0-9]{64}$/u);
  assert.deepEqual([binding.sourceKey, binding.sourceEventId, binding.hostPurpose, binding.budgetClass, binding.mergeKey],
    [`ledger-alert:bot:${BOT_ID}`, 'boot:3', 'safety.ledger-alert', 'owner-notice',
      'owner-ledger-alert-v1:startup:boot:boot-3']);
  // A runtime notice merges across boots: its merge key has no boot.
  assert.equal(buildLedgerAlertOperation({ ...input, category: 'runtime', mergeScope: 'welcome' }).mergeKey,
    'owner-ledger-alert-v1:runtime:welcome');
  // Another boot or another key is another operation.
  assert.notEqual(buildLedgerAlertOperation({ ...input, bootEpoch: 4 }).operationId, binding.operationId);
  assert.notEqual(buildLedgerAlertOperation({ ...input, key: 'b'.repeat(64) }).operationId, binding.operationId);
  for (const change of [{ category: 'other' }, { key: 'not-a-digest' }, { mergeScope: 'has space' },
    { content: '' }, { content: 'x'.repeat(1_901) }, { ownerId: BOT_ID }, { bootEpoch: -1 }, { sourceTimeMs: 1.5 }]) {
    assert.equal(buildLedgerAlertOperation({ ...input, ...change }), null, JSON.stringify(Object.keys(change)));
  }
  // The notifier refuses an invalid notice without queueing anything, and refuses all of
  // them while it is not ready.
  const state = fixture(t);
  assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice('welcome', '甲')), false);
  state.notifier.preflight();
  assert.equal(state.notifier.notifyLedgerEvent({ ...ledgerNotice('welcome', '甲'), category: 'other' }), false);
  assert.ok(state.logs.some((line) => line.includes('OWNER_SAFETY_LEDGER_ALERT_INVALID')));
  assert.equal(state.notifier.getStatsForTests().queueLength, 0);
  await state.notifier.stop();
  assert.equal(state.notifier.ledgerBoot, null);
  assert.equal(state.notifier.notifyLedgerEvent(ledgerNotice('welcome', '甲')), false);
});

test('before arming duplicate Owner notices merge in memory and leave no suppressed ledger rows', async (t) => {
  const extra = 8;
  const emitAll = (state, first) => Array.from({ length: PRE_ARM_QUEUE_LIMIT + extra }, (_, index) => {
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(BigInt(first) + BigInt(index)) });
    return state.emit(event());
  });

  const state = fixture(t, { armed: false });
  state.notifier.preflight();
  assert.deepEqual(emitAll(state, '333333333333333400'),
    [true, ...Array(PRE_ARM_QUEUE_LIMIT + extra - 1).fill(false)]);
  assert.equal(state.notifier.getStatsForTests().queueLength, 1);
  assert.deepEqual(state.logs.filter((line) => line.includes('PRE_ARM_QUEUE_FULL')), []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls, []);
  // Once armed, just the accepted notice is delivered. The merged flood was rejected
  // before a claim, so it did not create suppressed ledger rows.
  state.notifier.arm();
  await state.notifier.waitForIdleForTests();
  const notices = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.action === 'owner-safety-notification');
  assert.equal(notices.length, 1);
  assert.deepEqual(notices.map((operation) => operation.status), ['confirmed']);
  assert.equal(state.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`).length, 1);

  // A bot identity that differs at ready ends the whole capped queue: nothing is sent.
  const refused = fixture(t, { armed: false });
  refused.notifier.preflight();
  emitAll(refused, '333333333333333500');
  refused.notifier.disableAll('LEDGER_BOT_MISMATCH');
  refused.notifier.arm();
  await refused.notifier.waitForIdleForTests();
  assert.deepEqual(refused.calls, []);
  assert.equal(refused.notifier.getStatsForTests().queueLength, 0);
});

test('a catalogued background audit event has a fresh source and reaches the Owner notifier', async (t) => {
  const state = fixture(t, { context: null });
  state.notifier.getContext = getHostOperationContext;
  state.notifier.preflight();
  const first = await runWithBackgroundContext('audit.auto-leave', () => {
    const context = getHostOperationContext();
    assert.match(context.sourceEventId, /^[0-9a-f-]{36}$/iu);
    emitSafetyEvent(SAFETY_EVENT_CODES.AUDIT_AUTO_LEFT, { guildName: '@everyone **https://evil.example/**' });
    return context.sourceEventId;
  });
  await state.notifier.waitForIdleForTests();
  const content = state.calls.find((call) => call.route === `/channels/${CHANNEL_ID}/messages`)?.options.body.content;
  assert.match(content, /AUDIT_AUTO_LEFT/u);
  assert.equal(content.includes('evil.example'), false);
  const second = await runWithBackgroundContext('audit.auto-leave', () => getHostOperationContext().sourceEventId);
  assert.notEqual(first, second);
});

test('a thousand same-scope AI safety events are merged before any ledger claim', async (t) => {
  const state = fixture(t, { armed: false });
  state.notifier.preflight();
  const accepted = Array.from({ length: 1_000 }, (_, index) => {
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(BigInt('333333333333334000') + BigInt(index)) });
    return state.emit(event());
  });
  assert.equal(accepted.filter(Boolean).length, 1);
  assert.equal(state.notifier.getStatsForTests().queueLength, 1);
  assert.deepEqual(durableOperations(state.notifier), []);
});

test('a fifty-guild audit flood shares one intake budget and reports its merged count later', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const auditEvent = Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: state.clock.value });
  const accepted = Array.from({ length: 50 }, (_, index) => {
    const guildId = String(BigInt('111111111111111111') + BigInt(index));
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(BigInt('333333333333335000') + BigInt(index)),
      scope: `guild:${guildId}` });
    return state.emit(auditEvent);
  });
  assert.equal(accepted.filter(Boolean).length, 1);
  await state.notifier.waitForIdleForTests();
  state.clock.value += 10 * 60_000 + 1;
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333336000', scope: 'guild:111111111111111999' });
  assert.equal(state.emit({ ...auditEvent, at: state.clock.value }), true);
  await state.notifier.waitForIdleForTests();
  const messages = state.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`);
  assert.equal(messages.length, 2);
  assert.match(messages[1].options.body.content, /49 則同類事件已合併/u);
});

test('a guild name written like a link still reaches the Owner through the egress guard, the link replaced',
  async (t) => {
    // The egress guard refuses a protected send it would have to rewrite (PROTECTED_REWRITE_BLOCKED, never
    // retried), so the notice must leave the notifier already clean by the guard's own link rules.
    for (const guildName of ['www.example.com', 'discord.gg/abc', 'Fun https://x.y/z', 'discord.com/invite/abc',
      'free-nitro.com/claim', 'Gift EVIL.COM', 'paypa1-secure.top/login?x=1', 'bit.ly/abc 官方群', '領獎中心.com/x',
      'Free https://🎁.ws/nitro', 'https://ⓔⓥⓘⓛ.com/claim']) {
      const state = fixture(t);
      installEgressGuard(state.client.rest, { approvedReleaseTag: 'v1.1.2' });
      const egressEvents = [];
      const restoreEgress = setEgressSafetyEventHandler((egressEvent) => egressEvents.push(egressEvent.code));
      try {
        state.notifier.preflight();
        state.notifier.getContext = () => ({ ...CONTEXT, hostPurpose: 'discord.guildCreate', scope: `guild:${CONTEXT.guildId}` });
        assert.equal(state.emit(Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: state.clock.value,
          guildId: CONTEXT.guildId, guildName })), true, guildName);
        await state.notifier.waitForIdleForTests();
      } finally {
        restoreEgress();
      }
      assert.deepEqual(egressEvents, [], guildName);
      const content = state.calls.find((call) => call.route === `/channels/${CHANNEL_ID}/messages` &&
        call.options.body.content.includes('AUDIT_GUILD_JOINED'))?.options.body.content;
      assert.ok(content, guildName);
      assert.equal(rewriteLinks(content, {
        approve: () => null, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true,
      }).rewritten, false, guildName);
      assert.doesNotMatch(content, /example\.com|discord\.(?:gg|com)\/|x\.y\/z|free-nitro|evil\.com|paypa1|bit\.ly|領獎中心|\.ws|ⓔ/iu,
        guildName);
    }
  });

test('routine egress clean-ups are not Owner notices, so a flood of them leaves the budget to a new guild',
  async (t) => {
    const state = fixture(t);
    state.notifier.preflight();
    // A member's words echoed with a link or mention in them: the guard cleans the text and sends it.
    const routine = [];
    for (let index = 0; index < 50; index += 1) {
      state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(BigInt('333333333333337000') + BigInt(index)) });
      routine.push(state.emit(Object.freeze({ code: 'EGRESS_LINK_REWRITTEN', at: state.clock.value })));
      routine.push(state.emit(Object.freeze({ code: 'EGRESS_MENTION_STRIPPED', at: state.clock.value })));
    }
    await state.notifier.waitForIdleForTests();
    // In the same minute the bot joins a guild: that notice is the one the Owner needs.
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333338000',
      hostPurpose: 'discord.guildCreate', scope: `guild:${CONTEXT.guildId}` });
    assert.equal(state.emit(Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: state.clock.value,
      guildId: CONTEXT.guildId, guildName: '測試伺服器' })), true);
    await state.notifier.waitForIdleForTests();
    const messages = state.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`)
      .map((call) => call.options.body.content);
    assert.equal(messages.filter((content) => content.includes('AUDIT_GUILD_JOINED')).length, 1);
    assert.deepEqual(routine.filter(Boolean), []);
    assert.equal(messages.length, 1);
    assert.equal(messages[0], `${NOTICE_PREFIXES.audit}AUDIT_GUILD_JOINED；伺服器 ID：${CONTEXT.guildId}；伺服器：「測試伺服器」`);
    const notices = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
      .filter((operation) => operation.action === 'owner-safety-notification');
    assert.deepEqual(notices.map((operation) => operation.status), ['confirmed']);
  });

test('AI reply clean-ups are no Owner notice of their own: fifty make one output-guard alert and leave the budget alone',
  async (t) => {
    const { sanitizeUserFacingOutput } = require('../src/systems/conversation/userFacingOutputPolicy');
    const { setConversationSafetyEventHandler } = require('../src/systems/conversation/safetyEvents');
    const state = fixture(t);
    state.notifier.preflight();
    // The real path: the reply clean-up reports its events to the conversation hook, which is the notifier.
    const accepted = [];
    const restore = setConversationSafetyEventHandler((value) => { accepted.push(state.emit(value)); });
    t.after(restore);
    for (let index = 0; index < 50; index += 1) {
      state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(BigInt('333333333333339000') + BigInt(index)) });
      assert.equal(sanitizeUserFacingOutput(`請看 https://evil.example/${index} @everyone`, { context: CONTEXT }),
        '請看 [連結已移除] [提及已移除]');
    }
    await state.notifier.waitForIdleForTests();
    assert.equal(accepted.length, 100);
    assert.deepEqual(accepted.filter(Boolean), []);
    // The clean-ups are reported as security alerts of kind output-guard: one notice for the guild, the rest counted.
    // In the same minute the bot joins a guild: that notice still goes out.
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333339900',
      hostPurpose: 'discord.guildCreate', scope: `guild:${CONTEXT.guildId}` });
    assert.equal(state.emit(Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: state.clock.value,
      guildId: CONTEXT.guildId, guildName: '測試伺服器' })), true);
    await state.notifier.waitForIdleForTests();
    const messages = state.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`)
      .map((call) => call.options.body.content);
    assert.deepEqual(messages, [
      alertText('未知群組', 'output-guard'),
      `${NOTICE_PREFIXES.audit}AUDIT_GUILD_JOINED；伺服器 ID：${CONTEXT.guildId}；伺服器：「測試伺服器」`,
    ]);
    const notices = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
      .filter((operation) => operation.action === 'owner-safety-notification');
    assert.deepEqual(notices.map((operation) => operation.status), ['confirmed']);
  });

// A refused AI request is reported as a security alert (OWNER_EVENT_SECURITY_ALERT); the two codes it used to
// send are routine now, so a flood of them reaches the Owner not at all and leaves the budget alone.
test('refused AI requests and injection blocks are no Owner notice of their own and leave the budget to a new guild',
  async (t) => {
    const state = fixture(t);
    state.notifier.preflight();
    const accepted = [];
    for (let index = 0; index < 50; index += 1) {
      state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(BigInt('333333333333336000') + BigInt(index)) });
      accepted.push(state.emit(Object.freeze({ code: index % 2 === 0 ? 'AI_REQUEST_REFUSED' : 'AI_PROMPT_INJECTION_BLOCKED',
        at: state.clock.value, guildId: CONTEXT.guildId, actorId: CONTEXT.actorId })));
    }
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(accepted.filter(Boolean), []);
    state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333336900',
      hostPurpose: 'discord.guildCreate', scope: `guild:${CONTEXT.guildId}` });
    assert.equal(state.emit(Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: state.clock.value,
      guildId: CONTEXT.guildId, guildName: '測試伺服器' })), true);
    await state.notifier.waitForIdleForTests();
    const messages = state.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`)
      .map((call) => call.options.body.content);
    assert.deepEqual(messages, [
      `${NOTICE_PREFIXES.audit}AUDIT_GUILD_JOINED；伺服器 ID：${CONTEXT.guildId}；伺服器：「測試伺服器」`,
    ]);
  });

test('the catalogue decides which safety events reach the Owner, and each kind has its own fixed heading', () => {
  const routine = ['EGRESS_LINK_REWRITTEN', 'EGRESS_MENTION_STRIPPED', 'AI_OUTPUT_URL_BLOCKED', 'AI_OUTPUT_MENTION_BLOCKED',
    'AI_GUARD_USER_BUSY', 'AI_GUARD_DUPLICATE', 'AI_GUARD_GLOBAL_BUSY', 'AI_GUARD_TIMEOUT', 'AI_GUARD_USER_RATE',
    'AI_REQUEST_REFUSED', 'AI_PROMPT_INJECTION_BLOCKED', 'EGRESS_PROTECTED_REWRITE_BLOCKED', 'EGRESS_LEAVE_NOT_OWNER',
    'EGRESS_NOT_PRIVATE_GUILD', 'EGRESS_FORWARD_BLOCKED', 'EGRESS_ANYTHING_ELSE'];
  for (const code of routine) {
    assert.equal(notifiesOwner(code), false, code);
  }
  for (const code of [...Object.values(SAFETY_EVENT_CODES), ...Object.values(CONVERSATION_SAFETY_EVENT_CODES),
    ...routine, 'LEDGER_FAILED']) {
    assert.equal(notifiesOwner(code), !routine.includes(code), code);
  }
  assert.equal(notifiesOwner('NOT_A_CODE'), false);
  assert.ok(buildFixedNotice('AI_REQUEST_REFUSED').startsWith(NOTICE_PREFIXES.ai));
  assert.ok(buildFixedNotice('EGRESS_LEAVE_NOT_OWNER').startsWith(NOTICE_PREFIXES.egress));
  assert.ok(buildFixedNotice('AUDIT_AUTO_LEFT').startsWith(NOTICE_PREFIXES.audit));
  assert.ok(buildFixedNotice('ARCHIVE_UNAVAILABLE').startsWith(NOTICE_PREFIXES.critical));
  assert.equal(new Set(Object.values(NOTICE_PREFIXES)).size, 4);
  // Only the heading of an AI event speaks of an AI operation.
  assert.deepEqual(Object.keys(NOTICE_PREFIXES).filter((kind) => NOTICE_PREFIXES[kind].includes('AI')), ['ai']);
  // Only an audit notice names its guild ID, and only a well-formed one.
  assert.ok(buildFixedNotice('AUDIT_AUTO_LEFT', { guildId: CONTEXT.guildId }).endsWith(`；伺服器 ID：${CONTEXT.guildId}`));
  assert.equal(buildFixedNotice('AUDIT_AUTO_LEFT', { guildId: 'not-an-id' }).includes('伺服器 ID'), false);
  assert.equal(buildFixedNotice('AI_REQUEST_REFUSED', { guildId: CONTEXT.guildId }).includes(CONTEXT.guildId), false);
});

test('a guild name cannot pose as the guild ID field or reorder the notice around it', () => {
  const realId = CONTEXT.guildId;
  const fakeId = '999999999999999999';
  const names = [
    `X；伺服器 ID：${fakeId}`,
    `X${String.fromCodePoint(0x202e)}；伺服器 ID：${fakeId}`,
    `${String.fromCodePoint(0x2067)}X${String.fromCodePoint(0x2069, 0x200b)};伺服器 ID:${fakeId}${String.fromCodePoint(0x202c)}`,
    `X」；伺服器 ID：${fakeId}「`,
  ];
  for (const guildName of names) {
    for (const code of [SAFETY_EVENT_CODES.AUDIT_AUTO_LEFT, SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED]) {
      const content = buildFixedNotice(code, { guildName, guildId: realId, suppressed: 2 });
      const label = JSON.stringify([code, guildName]);
      // No format or bidirectional control character is left to reorder what the Owner reads.
      assert.doesNotMatch(content, /\p{Cf}/u, label);
      // One guild ID field, the real one, before the guild name; the name comes last, quoted.
      assert.equal(content.split('伺服器 ID：').length, 2, label);
      assert.ok(content.startsWith(`${NOTICE_PREFIXES.audit}${code}；伺服器 ID：${realId}；`), label);
      assert.ok(content.indexOf(`伺服器 ID：${realId}`) < content.indexOf('伺服器：「'), label);
      assert.match(content, /；伺服器：「[^「」]*」$/u, label);
      assert.equal(content.includes(`ID：${fakeId}`), false, label);
    }
  }
  assert.equal(buildFixedNotice(SAFETY_EVENT_CODES.AUDIT_AUTO_LEFT, { guildName: '測試伺服器', guildId: realId, suppressed: 2 }),
    `${NOTICE_PREFIXES.audit}AUDIT_AUTO_LEFT；伺服器 ID：${realId}；另有 2 則同類事件已合併；伺服器：「測試伺服器」`);
  // An invisible character cannot split a mention or a link past the clean-up.
  assert.equal(sanitizeGuildName(`@every${String.fromCodePoint(0x200b)}one ht${String.fromCodePoint(0x2060)}tps://evil.example/x`), '');
});

test('a notice whose operation was recorded with other content is dropped alone; the notifier keeps sending',
  async (t) => {
    // The ready context names the bot as its source event on every start, so a notice recorded by an
    // earlier start (or an earlier version, with other wording) is the same operation with other content.
    // The ledger refuses it (SIDE_EFFECT_BINDING_CONFLICT) without failing; only that notice is dropped.
    const readyContext = Object.freeze({ sourceEventId: BOT_ID, actorId: BOT_ID, hostPurpose: 'discord.ready',
      scope: `bot:${BOT_ID}` });
    const state = fixture(t, { context: readyContext });
    const reported = [];
    state.notifier.onPurposeDisabled = (purposeId, code) => reported.push([purposeId, code]);
    assert.equal(state.notifier.preflight().enabled, true);
    const notice = (guildName) => Object.freeze({ code: 'LEDGER_SAMPLE_NOTICE_B', at: state.clock.value, guildName });
    assert.equal(state.emit(notice('甲')), true);
    await state.notifier.waitForIdleForTests();
    state.clock.value += 10 * 60_000 + 1;
    assert.equal(state.emit(notice('乙')), false);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.notifier.getStatsForTests().disabled, false);
    assert.equal(state.notifier.isReady(), true);
    assert.deepEqual(reported, []);
    assert.deepEqual(state.logs, ['[OWNER_SAFETY] code=OWNER_SAFETY_NOTICE_CONFLICT']);
    // A later notice of another source is still sent.
    state.notifier.getContext = () => CONTEXT;
    assert.equal(state.emit(event()), true);
    await state.notifier.waitForIdleForTests();
    const messages = state.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`)
      .map((call) => call.options.body.content);
    assert.equal(messages.length, 2);
    assert.ok(messages[0].includes('甲'));
    assert.ok(messages[1].startsWith(FIXED_NOTICE_PREFIX));
    assert.equal(messages.some((content) => content.includes('乙')), false);
  });

test('audit notices for different guilds of one background run are separate operations; other IDs are unchanged',
  async (t) => {
    const runContext = Object.freeze({ sourceEventId: '0b6f3c1e-1d2a-4c55-9e7a-2f1d3b4c5a6e',
      hostPurpose: 'background.audit.auto-leave', scope: 'background:audit.auto-leave', startedAtMs: 1_000 });
    const left = (guildId) => Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_AUTO_LEFT, at: 1_000, guildId,
      guildName: '同名伺服器' });
    const first = buildOperation(left('111111111111111111'), runContext, OWNER_ID);
    const second = buildOperation(left('111111111111111112'), runContext, OWNER_ID);
    assert.notEqual(first.operationId, second.operationId);
    assert.equal(first.mergeKey, second.mergeKey);
    const seedId = (sourceKey, sourceEventId, code) =>
      `owner-safety-v1:${digestStable({ version: 1, sourceKey, sourceEventId, code })}`;
    // A guild join already names its guild in its source event: its operation ID is the one an earlier
    // version recorded, so a notice it sent is still found and not sent again.
    const joinContext = Object.freeze({ sourceEventId: `${CONTEXT.guildId}.1700000000000`, guildId: CONTEXT.guildId,
      actorId: BOT_ID, hostPurpose: 'discord.guildCreate', scope: `guild:${CONTEXT.guildId}` });
    const joined = buildOperation(Object.freeze({ code: SAFETY_EVENT_CODES.AUDIT_GUILD_JOINED, at: 1_000,
      guildId: CONTEXT.guildId, guildName: '測試伺服器' }), joinContext, OWNER_ID);
    assert.equal(joined.operationId, seedId(`discord.guildCreate:guild:${CONTEXT.guildId}:actor:${BOT_ID}`,
      joinContext.sourceEventId, 'AUDIT_GUILD_JOINED'));
    // Codes other than the audit ones keep their operation ID, whatever guild they name.
    const refused = buildOperation(Object.freeze({ code: SAFETY_EVENT_CODES.ARCHIVE_UNAVAILABLE, at: 1_000,
      guildId: '111111111111111999' }), CONTEXT, OWNER_ID);
    assert.equal(refused.operationId, seedId(`${CONTEXT.hostPurpose}:${CONTEXT.scope}:actor:${CONTEXT.actorId}`,
      CONTEXT.sourceEventId, 'ARCHIVE_UNAVAILABLE'));

    // One run leaves two guilds; the first notice is refused before the network, which gives its
    // intake back. The second guild's notice is its own operation: no conflict, the notifier stays on.
    const state = fixture(t, { context: runContext });
    refuseNextRequest(state, `/channels/${CHANNEL_ID}/messages`, 'TEST_CHANNEL_EGRESS_DENIED');
    state.notifier.preflight();
    assert.equal(state.emit(left('111111111111111111')), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.emit(left('111111111111111112')), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.notifier.getStatsForTests().disabled, false);
    assert.deepEqual(state.logs, []);
    const notices = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
      .filter((operation) => operation.action === 'owner-safety-notification');
    assert.equal(new Set(notices.map((operation) => operation.operationId)).size, 2);
  });

test('any other ledger error while queueing a notice still stops the notifier', async (t) => {
  const failWith = (state, action, code) => {
    const ledger = state.notifier.ledger;
    const verifyBinding = ledger.verifyBinding.bind(ledger);
    ledger.verifyBinding = (binding) => {
      if (binding.action === action) throw Object.assign(new Error('synthetic ledger error'), { code });
      return verifyBinding(binding);
    };
  };
  // A ledger fault on the notice's own operation.
  const faulted = fixture(t);
  const faultReports = [];
  faulted.notifier.onPurposeDisabled = (purposeId, code) => faultReports.push([purposeId, code]);
  faulted.notifier.preflight();
  assert.equal(faulted.emit(event()), true);
  await faulted.notifier.waitForIdleForTests();
  faulted.clock.value += 10 * 60_000 + 1;
  failWith(faulted, 'owner-safety-notification', 'SIDE_EFFECT_PERSIST_FAILED');
  assert.equal(faulted.emit(event()), false);
  assert.equal(faulted.notifier.getStatsForTests().disabled, true);
  assert.deepEqual(faultReports, [['owner-safety', 'OWNER_SAFETY_LEDGER_FAILED']]);
  assert.ok(faulted.logs.includes('[OWNER_SAFETY] code=OWNER_SAFETY_LEDGER_FAILED cause=SIDE_EFFECT_PERSIST_FAILED'),
    faulted.logs.join('\n'));

  // A conflict on the Owner DM preparation is not one notice's: every later notice needs it.
  const preparation = fixture(t);
  const preparationReports = [];
  preparation.notifier.onPurposeDisabled = (purposeId, code) => preparationReports.push([purposeId, code]);
  preparation.notifier.preflight();
  assert.equal(preparation.emit(event()), true);
  await preparation.notifier.waitForIdleForTests();
  preparation.clock.value += 10 * 60_000 + 1;
  failWith(preparation, 'dm-channel.prepare', 'SIDE_EFFECT_BINDING_CONFLICT');
  preparation.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333339000' });
  assert.equal(preparation.emit(event()), false);
  assert.equal(preparation.notifier.getStatsForTests().disabled, true);
  assert.deepEqual(preparationReports, [['owner-safety', 'OWNER_SAFETY_LEDGER_FAILED']]);
  assert.equal(preparation.calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`).length, 1);
});

// The Owner events: a member left, a guild was joined, the bot recovered from an outage. Each is its own
// event with fixed text and a notice budget of its own.
const MEMBER_LEFT = SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT;
const GUILD_JOINED = SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED;
const RECOVERED = SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED;
const SECURITY_ALERT = SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT;
const EVENT_MEMBER_ID = '555555555555555555';
const EVENT_INVITER_ID = '666666666666666666';
const BUDGET_LINE = (category, skipped) =>
  `[OWNER_SAFETY] code=OWNER_NOTICE_BUDGET_EXCEEDED category=${category} skipped=${skipped}`;

// The event the catalogue builds for `code`, as the notifier is handed it, without delivering it.
function catalogueEvent(code, context = {}) {
  let built = null;
  const restore = setSafetyEventHandler((value) => { built = value; });
  try {
    emitSafetyEvent(code, context);
  } finally {
    restore();
  }
  return built;
}

// Hands the notifier one event from a source of its own and answers whether it took it.
let ownerEventSource = 0;
function sendOwnerEvent(state, code, context = {}) {
  ownerEventSource += 1;
  state.notifier.getContext = () => ({
    sourceEventId: String(333333333333600000n + BigInt(ownerEventSource)),
    actorId: BOT_ID,
    guildId: context.guildId ?? null,
    hostPurpose: 'discord.ownerEvent',
    scope: `guild:${context.guildId ?? 'none'}`,
  });
  return state.emit(catalogueEvent(code, { at: state.clock.value, ...context }));
}

function sentTexts(calls) {
  return calls.filter((call) => call.route === `/channels/${CHANNEL_ID}/messages`)
    .map((call) => call.options.body.content);
}

function leftEvent(index, state, extra = {}) {
  return {
    guildId: CONTEXT.guildId,
    guildName: '測試伺服器',
    notice: {
      subjectId: String(555555555555555000n + BigInt(index)), subjectName: `成員${index}`,
      leftAtMs: state.clock.value, memberCount: 10, ...extra,
    },
  };
}

test('the catalogue gives the owner events categories of their own and reads only the notice fields it knows', () => {
  assert.equal(safetyEventCategory(MEMBER_LEFT), 'member-leave');
  assert.equal(safetyEventCategory(GUILD_JOINED), 'guild-join');
  assert.equal(safetyEventCategory(RECOVERED), 'recovery');
  for (const code of [MEMBER_LEFT, GUILD_JOINED, RECOVERED, SECURITY_ALERT]) {
    assert.equal(notifiesOwner(code), true, code);
    assert.equal(code.startsWith('AUDIT_'), false, code);
  }
  // The old events keep their categories.
  assert.equal(safetyEventCategory('AUDIT_GUILD_JOINED'), 'audit');
  assert.equal(safetyEventCategory('AUDIT_AUTO_LEFT'), 'audit');
  assert.equal(safetyEventCategory('AI_REQUEST_REFUSED'), 'ai-egress');
  assert.equal(safetyEventCategory(SECURITY_ALERT), 'security-alert');
  assert.equal(safetyEventCategory('EGRESS_LEAVE_NOT_OWNER'), 'ai-egress');

  // Every code of the catalogue (and the pattern families) has a category listed here; the ones that fall to
  // `critical` are only the archive code and the ledger codes.
  const codes = [...Object.values(SAFETY_EVENT_CODES), 'EGRESS_LEAVE_NOT_OWNER', 'LEDGER_FAILED', 'LEDGER_BOOTSTRAP_FAILED'];
  const byCategory = (category) => codes.filter((code) => safetyEventCategory(code) === category).sort();
  assert.deepEqual(byCategory('critical'), ['ARCHIVE_UNAVAILABLE', 'LEDGER_BOOTSTRAP_FAILED', 'LEDGER_FAILED']);
  assert.deepEqual(byCategory('member-leave'), [MEMBER_LEFT]);
  assert.deepEqual(byCategory('guild-join'), [GUILD_JOINED]);
  assert.deepEqual(byCategory('recovery'), [RECOVERED]);
  assert.deepEqual(byCategory('security-alert'), [SECURITY_ALERT]);
  assert.deepEqual(byCategory('audit'), ['AUDIT_AUTO_LEFT', 'AUDIT_GUILD_JOINED']);

  const event = catalogueEvent(MEMBER_LEFT, {
    at: 5, guildId: CONTEXT.guildId, guildName: '測試伺服器',
    notice: {
      subjectId: EVENT_MEMBER_ID, subjectName: '小明', subjectUsername: 'xiaoming', joinedAtMs: 1_699_000_000_000,
      leftAtMs: 1_700_000_000_000, memberCount: 42, inviterId: EVENT_INVITER_ID, outageStartedAtMs: 7,
      outageEndedAtMs: 9, outageKind: 'crash', alertKind: 'flood', content: '任意文字', text: 'x', extra: { a: 1 },
    },
  });
  assert.equal(event.category, 'member-leave');
  assert.deepEqual(event.notice, {
    subjectId: EVENT_MEMBER_ID, subjectName: '小明', subjectUsername: 'xiaoming', joinedAtMs: 1_699_000_000_000,
    leftAtMs: 1_700_000_000_000, memberCount: 42, inviterId: EVENT_INVITER_ID, outageStartedAtMs: 7,
    outageEndedAtMs: 9, outageKind: 'crash', alertKind: 'flood',
  });
  assert.equal(Object.isFrozen(event.notice), true);

  // A field that does not fit is null (a name: empty); nothing is converted into a valid one.
  const invalid = catalogueEvent(RECOVERED, {
    notice: {
      subjectId: '123', inviterId: 555555555555555555, subjectName: 42, subjectUsername: { toString: () => 'x' },
      joinedAtMs: -1, leftAtMs: 1.5, memberCount: '12', outageStartedAtMs: '1700000000000',
      outageEndedAtMs: Number.MAX_SAFE_INTEGER, outageKind: 'explode', alertKind: 'explode',
    },
  });
  assert.deepEqual(invalid.notice, {
    subjectId: null, subjectName: '', subjectUsername: '', joinedAtMs: null, leftAtMs: null, memberCount: null,
    inviterId: null, outageStartedAtMs: null, outageEndedAtMs: null, outageKind: null, alertKind: null,
  });
  assert.deepEqual(catalogueEvent(GUILD_JOINED).notice, invalid.notice);
  assert.deepEqual(catalogueEvent(GUILD_JOINED, { notice: 'text' }).notice, invalid.notice);
  for (const kind of ['crash', 'connection', 'restore']) {
    assert.equal(catalogueEvent(RECOVERED, { notice: { outageKind: kind } }).notice.outageKind, kind);
  }

  // The other codes carry no notice, whatever a producer attaches.
  const refused = catalogueEvent('AI_REQUEST_REFUSED', { notice: { subjectId: EVENT_MEMBER_ID } });
  assert.equal(Object.hasOwn(refused, 'notice'), false);
  assert.equal(Object.hasOwn(catalogueEvent('AUDIT_GUILD_JOINED', { notice: {} }), 'notice'), false);
});

test('every catalogue category has an explicit budget and ledger class, and the owner events use the ledger policies', () => {
  const codes = [...Object.values(SAFETY_EVENT_CODES), 'EGRESS_LEAVE_NOT_OWNER', 'EGRESS_PROTECTED_REWRITE_BLOCKED',
    'LEDGER_FAILED'];
  const categories = [...new Set(codes.map(safetyEventCategory))].sort();
  assert.deepEqual(categories, ['ai-egress', 'audit', 'critical', 'guild-join', 'member-leave', 'recovery', 'security-alert']);
  assert.deepEqual(Object.keys(CATEGORY_BUDGETS).sort(), categories);
  assert.deepEqual(Object.keys(CATEGORY_BUDGET_CLASSES).sort(), categories);
  assert.deepEqual(CATEGORY_BUDGET_CLASSES, {
    'ai-egress': 'owner-notice',
    audit: 'owner-notice',
    critical: 'owner-notice',
    'member-leave': 'owner-member-leave',
    'guild-join': 'owner-guild-join',
    recovery: 'owner-outage',
    'security-alert': 'owner-security',
  });
  // The numbers of the three events are the ledger's own, not a copy.
  assert.equal(CATEGORY_BUDGETS['member-leave'], OWNER_BUDGET_POLICIES['owner-member-leave']);
  assert.equal(CATEGORY_BUDGETS['guild-join'], OWNER_BUDGET_POLICIES['owner-guild-join']);
  assert.equal(CATEGORY_BUDGETS.recovery, OWNER_BUDGET_POLICIES['owner-outage']);
  assert.equal(CATEGORY_BUDGETS['security-alert'], OWNER_BUDGET_POLICIES['owner-security']);
  // The old categories keep the memory numbers they had: the minute and the hour of the shared budget.
  for (const category of ['ai-egress', 'audit', 'critical']) {
    assert.deepEqual(CATEGORY_BUDGETS[category], [{ windowMs: 60_000, maximum: 1 }, { windowMs: 3_600_000, maximum: 6 }]);
  }
  // Memory is never looser than the ledger: every window of a category is one of its class's windows.
  for (const category of categories) {
    const policy = OWNER_BUDGET_POLICIES[CATEGORY_BUDGET_CLASSES[category]];
    assert.ok(policy, category);
    for (const window of CATEGORY_BUDGETS[category]) {
      assert.ok(policy.some(({ windowMs, maximum }) => windowMs === window.windowMs && maximum === window.maximum),
        `${category}: ${JSON.stringify(window)}`);
    }
  }
});

test('each owner event has its own heading and a text of fixed fields in a fixed order', () => {
  assert.deepEqual(EVENT_NOTICE_PREFIXES, {
    OWNER_EVENT_MEMBER_LEFT: '小吉成員退出通知。固定代碼：',
    OWNER_EVENT_GUILD_JOINED: '小吉新伺服器加入通知。固定代碼：',
    OWNER_EVENT_RECOVERED: '小吉恢復營運通知。固定代碼：',
    OWNER_EVENT_SECURITY_ALERT: '小吉遭受攻擊',
  });
  const headings = Object.values(EVENT_NOTICE_PREFIXES);
  assert.equal(new Set([...headings, ...Object.values(NOTICE_PREFIXES)]).size, 8);
  assert.deepEqual(headings.filter((heading) => heading.includes('AI')), []);
  assert.deepEqual(Object.keys(NOTICE_PREFIXES), ['ai', 'egress', 'audit', 'critical']);

  const member = {
    subjectId: EVENT_MEMBER_ID, subjectName: '小明', subjectUsername: 'xiaoming', joinedAtMs: 1_699_000_000_000,
    leftAtMs: 1_700_000_000_000, memberCount: 42,
  };
  assert.equal(buildFixedNotice(MEMBER_LEFT, { guildId: CONTEXT.guildId, guildName: '測試伺服器', notice: member }),
    `小吉成員退出通知。固定代碼：OWNER_EVENT_MEMBER_LEFT；伺服器 ID：${CONTEXT.guildId}；成員 ID：${EVENT_MEMBER_ID}；` +
    '退出時間：<t:1700000000:F>；加入時間：<t:1699000000:F>；成員數：42；' +
    '伺服器：「測試伺服器」；成員名稱：「小明」；成員帳號：「xiaoming」');
  assert.equal(buildFixedNotice(MEMBER_LEFT, { guildId: CONTEXT.guildId, guildName: '測試伺服器', suppressed: 3,
    notice: { ...member, subjectName: '', subjectUsername: '' } }),
  `小吉成員退出通知。固定代碼：OWNER_EVENT_MEMBER_LEFT；伺服器 ID：${CONTEXT.guildId}；成員 ID：${EVENT_MEMBER_ID}；` +
    '退出時間：<t:1700000000:F>；加入時間：<t:1699000000:F>；成員數：42；另有 3 則同類事件已合併；伺服器：「測試伺服器」');
  assert.equal(buildFixedNotice(GUILD_JOINED, { guildId: CONTEXT.guildId, guildName: '新伺服器',
    notice: { inviterId: EVENT_INVITER_ID, joinedAtMs: 1_700_000_000_000, memberCount: 7 } }),
  `小吉新伺服器加入通知。固定代碼：OWNER_EVENT_GUILD_JOINED；伺服器 ID：${CONTEXT.guildId}；` +
    `邀請者 ID：${EVENT_INVITER_ID}；加入時間：<t:1700000000:F>；成員數：7；伺服器：「新伺服器」`);
  for (const [kind, text] of Object.entries(OUTAGE_KIND_TEXT)) {
    assert.equal(buildFixedNotice(RECOVERED, { notice: { outageStartedAtMs: 1_700_000_000_000,
      outageEndedAtMs: 1_700_000_600_999, outageKind: kind } }),
    `小吉恢復營運通知。固定代碼：OWNER_EVENT_RECOVERED；停運開始：<t:1700000000:F>；恢復時間：<t:1700000600:F>；類型：${text}`);
  }
  assert.deepEqual(Object.keys(OUTAGE_KIND_TEXT), ['crash', 'connection', 'restore']);

  // What is missing, or does not fit, is the fixed word for unknown; no guild ID without a guild.
  assert.equal(buildFixedNotice(MEMBER_LEFT),
    '小吉成員退出通知。固定代碼：OWNER_EVENT_MEMBER_LEFT；成員 ID：未知；退出時間：未知；加入時間：未知；成員數：未知');
  assert.equal(buildFixedNotice(GUILD_JOINED, { guildId: 'not-an-id', notice: { inviterId: '<@555555555555555555>' } }),
    '小吉新伺服器加入通知。固定代碼：OWNER_EVENT_GUILD_JOINED；邀請者 ID：未知；加入時間：未知；成員數：未知');
  assert.equal(buildFixedNotice(RECOVERED, { notice: { outageKind: '<@everyone>' } }),
    '小吉恢復營運通知。固定代碼：OWNER_EVENT_RECOVERED；停運開始：未知；恢復時間：未知；類型：未知');
  // An ID is digits only, never a mention.
  assert.doesNotMatch(buildFixedNotice(MEMBER_LEFT, { guildId: CONTEXT.guildId, notice: member }), /<@|<#/u);
  // The old events keep their text.
  assert.equal(buildFixedNotice('AUDIT_GUILD_JOINED', { guildId: CONTEXT.guildId, guildName: '測試伺服器' }),
    `${NOTICE_PREFIXES.audit}AUDIT_GUILD_JOINED；伺服器 ID：${CONTEXT.guildId}；伺服器：「測試伺服器」`);
});

test('a name, an account name or a guild name cannot pose as a field, a mention, a time or a link of an owner notice', () => {
  const fakeId = '999999999999999999';
  const hostile = [
    `甲；成員 ID：${fakeId}`,
    `甲${String.fromCodePoint(0x202e)}；成員 ID：${fakeId}`,
    `${String.fromCodePoint(0x2067)}甲${String.fromCodePoint(0x2069, 0x200b)};成員 ID:${fakeId}${String.fromCodePoint(0x202c)}`,
    '甲」；退出時間：<t:1:F>「',
    '@everyone @here',
    '@@everyoneeveryone @he@hererere',
    `<@${fakeId}> <@!${fakeId}> <@&${fakeId}> <#${fakeId}>`,
    `<@<@${fakeId}>${fakeId}>`,
    'https://evil.example/claim http://evil.example',
    'discord.gg/abc discord.com/invite/abc evil.com/x',
    '<t:1700000000:F> <t:1:R>',
    'x'.repeat(150),
    '😀'.repeat(120),
    `a${'😀'.repeat(80)}`,
    '龍'.repeat(150),
    '**bold** __under__ `code` ~~strike~~ ||spoiler|| > quote [a](https://evil.example)',
  ];
  const noNames = { guildId: CONTEXT.guildId, suppressed: 2 };
  const plain = {
    subjectId: EVENT_MEMBER_ID, joinedAtMs: 1_699_000_000_000, leftAtMs: 1_700_000_000_000, memberCount: 42,
    inviterId: EVENT_INVITER_ID,
  };
  const options = { approve: () => null, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true };
  const fixedHead = {
    [MEMBER_LEFT]: buildFixedNotice(MEMBER_LEFT, { ...noNames, notice: plain }),
    [GUILD_JOINED]: buildFixedNotice(GUILD_JOINED, { ...noNames, notice: plain }),
  };
  const names = /^(?:；伺服器：「[^「」]*」)?(?:；成員名稱：「[^「」]*」)?(?:；成員帳號：「[^「」]*」)?$/u;
  for (const name of hostile) {
    for (const code of [MEMBER_LEFT, GUILD_JOINED]) {
      const label = JSON.stringify([code, name]);
      const content = buildFixedNotice(code, { ...noNames, guildName: name,
        notice: { ...plain, subjectName: name, subjectUsername: name } });
      // The fixed fields, in full and in their order, come first; then only the quoted names.
      assert.ok(content.startsWith(fixedHead[code]), label);
      assert.match(content.slice(fixedHead[code].length), names, label);
      // Nothing is left to reorder, mention, time-stamp or link anything.
      assert.doesNotMatch(content, /\p{Cf}/u, label);
      // The digits of a fake ID may stay inside a quoted name, but no fixed field is repeated or taken over.
      for (const [, field] of fixedHead[code].matchAll(/；([^：；「」]+)：/gu)) {
        assert.equal(content.split(`；${field}：`).length, 2, `${label} ${field}`);
      }
      assert.equal(content.includes(`ID：${fakeId}`), false, label);
      // No tag Discord would render survives: no mention, channel, custom emoji or timestamp beyond the
      // fixed time fields (a name's `<@` or `<t` without its closing `>` is only text).
      assert.doesNotMatch(content, /@everyone|@here|<@!?&?\d+>|<#\d+>|<a?:\w+:\d+>/iu, label);
      assert.equal((content.match(/<t:\d+(?::[A-Za-z])?>/gu) || []).length, code === MEMBER_LEFT ? 2 : 1, label);
      // Every `>` is the end of a fixed time field: a name has none.
      assert.equal((content.match(/>/gu) || []).length, code === MEMBER_LEFT ? 2 : 1, label);
      assert.equal(rewriteLinks(content, options).rewritten, false, label);
      assert.doesNotMatch(content, /evil|discord\.(?:gg|com)|abc/iu, label);
      assert.ok(content.length < 1_900, label);
    }
  }
  // A name over the cut is cut to 100 characters, and a cut never leaves half of a surrogate pair.
  const cut = buildFixedNotice(MEMBER_LEFT, { notice: { subjectName: 'x'.repeat(150) } });
  assert.ok(cut.endsWith(`成員名稱：「${'x'.repeat(100)}」`));
  const emoji = buildFixedNotice(MEMBER_LEFT, { notice: { subjectName: `a${'😀'.repeat(80)}` } });
  assert.doesNotMatch(emoji, /[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  assert.equal(sanitizeGuildName('@@everyoneeveryone'), '');
  assert.equal(sanitizeGuildName('@he@hererere'), 're');
});

test('owner events are bound under their own action, budget class, target suffix and merge keys', () => {
  const context = Object.freeze({ sourceEventId: '333333333333700001', actorId: BOT_ID,
    hostPurpose: 'discord.ownerEvent', scope: `guild:${CONTEXT.guildId}` });
  const left = (memberId, leftAtMs) => catalogueEvent(MEMBER_LEFT, { at: 1_000, guildId: CONTEXT.guildId,
    notice: { subjectId: memberId, leftAtMs } });
  const first = buildOperation(left(EVENT_MEMBER_ID, 1_700_000_000_000), context, OWNER_ID);
  assert.deepEqual([first.action, first.budgetClass, first.target],
    [OWNER_EVENT_ACTION, 'owner-member-leave', `${OWNER_ID}:member-leave`]);
  assert.equal(OWNER_EVENT_ACTION, 'owner-event-notification');
  assert.match(first.operationId, /^owner-event-v1:[a-f0-9]{64}$/u);
  assert.equal(first.mergeKey, `owner-leave-v1:${CONTEXT.guildId}:${EVENT_MEMBER_ID}`);
  assert.equal(first.payload.content.startsWith(EVENT_NOTICE_PREFIXES[MEMBER_LEFT]), true);
  assert.deepEqual(first.payload.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  // The same member again is the same merge key; another member or another time is its own operation.
  const again = buildOperation(left(EVENT_MEMBER_ID, 1_700_000_100_000), context, OWNER_ID);
  const other = buildOperation(left(EVENT_INVITER_ID, 1_700_000_000_000), context, OWNER_ID);
  assert.equal(again.mergeKey, first.mergeKey);
  assert.notEqual(again.operationId, first.operationId);
  assert.notEqual(other.mergeKey, first.mergeKey);
  assert.notEqual(other.operationId, first.operationId);
  // The same event, from the same source, is the same operation.
  assert.equal(buildOperation(left(EVENT_MEMBER_ID, 1_700_000_000_000), context, OWNER_ID).operationId, first.operationId);

  const joined = buildOperation(catalogueEvent(GUILD_JOINED, { at: 1_000, guildId: CONTEXT.guildId, guildName: '新伺服器',
    notice: { joinedAtMs: 1_700_000_000_000 } }), context, OWNER_ID);
  assert.deepEqual([joined.action, joined.budgetClass, joined.target, joined.mergeKey],
    [OWNER_EVENT_ACTION, 'owner-guild-join', `${OWNER_ID}:guild-join`, `owner-join-v1:${CONTEXT.guildId}`]);
  assert.match(joined.operationId, /^owner-event-v1:/u);

  const recovered = buildOperation(catalogueEvent(RECOVERED, { at: 1_000,
    notice: { outageStartedAtMs: 1_700_000_000_123, outageEndedAtMs: 1_700_000_600_000, outageKind: 'crash' } }),
  context, OWNER_ID);
  assert.deepEqual([recovered.action, recovered.budgetClass, recovered.target, recovered.mergeKey],
    [OWNER_EVENT_ACTION, 'owner-outage', `${OWNER_ID}:outage`, 'owner-recovery-v1:1700000000123']);
  assert.match(recovered.operationId, /^owner-event-v1:/u);
  assert.equal(new Set([first.operationId, joined.operationId, recovered.operationId]).size, 3);

  // Events without the facts still bind, together under `unknown` rather than each on its own.
  const bare = buildOperation(catalogueEvent(MEMBER_LEFT, { at: 1_000 }), context, OWNER_ID);
  assert.equal(bare.mergeKey, 'owner-leave-v1:unknown:unknown');

  // The safety events keep their action, class, target and operation ID.
  const safety = buildOperation(event(SAFETY_EVENT_CODES.ARCHIVE_UNAVAILABLE), CONTEXT, OWNER_ID);
  assert.deepEqual([safety.action, safety.budgetClass, safety.target], ['owner-safety-notification', 'owner-notice', OWNER_ID]);
  assert.match(safety.operationId, /^owner-safety-v1:/u);
  for (const code of ['AUDIT_GUILD_JOINED', 'ARCHIVE_UNAVAILABLE', 'EGRESS_LEAVE_NOT_OWNER']) {
    const operation = buildOperation(event(code), CONTEXT, OWNER_ID);
    assert.deepEqual([operation.action, operation.budgetClass, operation.target],
      ['owner-safety-notification', 'owner-notice', OWNER_ID], code);
  }
  // The ledger alert is the shared class too.
  const alert = buildLedgerAlertOperation({ botId: BOT_ID, ownerId: OWNER_ID, bootEpoch: 1, sourceTimeMs: 1,
    category: 'startup', key: 'a'.repeat(64), mergeScope: 'boot', content: '小吉安全帳本通知（本次啟動）' });
  assert.deepEqual([alert.budgetClass, alert.target], ['owner-notice', OWNER_ID]);
});

test('members leaving in one minute are reported up to the budget, one member twice is one notice, the rest are counted',
  async (t) => {
    const state = fixture(t);
    state.notifier.preflight();
    const leave = (index) => sendOwnerEvent(state, MEMBER_LEFT, leftEvent(index, state));
    assert.equal(leave(1), true);
    // The same member again within ten minutes is merged: counted, and not a budget line.
    assert.equal(leave(1), false);
    assert.deepEqual(state.logs, []);
    assert.equal(leave(2), true);
    // Over two a minute: one line for the category, the rest of the minute only counted.
    assert.equal(leave(3), false);
    assert.deepEqual(state.logs, [BUDGET_LINE('member-leave', 0)]);
    assert.equal(leave(4), false);
    assert.equal(state.logs.length, 1);
    await state.notifier.waitForIdleForTests();
    const first = sentTexts(state.calls);
    assert.equal(first.length, 2);
    assert.ok(first[0].includes(`成員 ID：${String(555555555555555000n + 1n)}`));
    assert.ok(first[1].includes(`成員 ID：${String(555555555555555000n + 2n)}`));
    // What was left out is carried by the next notice of the category: here the repeat of member 1.
    assert.equal(first[0].includes('已合併'), false);
    assert.match(first[1], /；成員數：10；另有 1 則同類事件已合併；伺服器：「測試伺服器」；成員名稱：「成員2」$/u);

    // A minute later two more go out; the first of them says how many were left out (members 3 and 4).
    state.clock.value += 61_000;
    assert.equal(leave(5), true);
    assert.equal(leave(6), true);
    assert.equal(leave(7), false);
    assert.deepEqual(state.logs, [BUDGET_LINE('member-leave', 0), BUDGET_LINE('member-leave', 1)]);
    await state.notifier.waitForIdleForTests();
    const second = sentTexts(state.calls).slice(2);
    assert.equal(second.length, 2);
    assert.match(second[0], /；成員數：10；另有 2 則同類事件已合併；伺服器：「測試伺服器」；成員名稱：「成員5」$/u);
    assert.equal(second[1].includes('已合併'), false);
    // Each is a row of its own kind, and nothing of the shared safety budget was spent.
    const rows = durableOperations(state.notifier).filter((operation) => operation.action === OWNER_EVENT_ACTION);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((operation) => operation.budgetClass === 'owner-member-leave' &&
      operation.target === `${OWNER_ID}:member-leave` && operation.status === 'confirmed'));
    assert.equal(durableOperations(state.notifier).filter((operation) => operation.action === 'owner-safety-notification')
      .length, 0);
  });

test('member leaves, guild joins, outage recoveries and the shared notice budget never spend one another', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const join = (index) => sendOwnerEvent(state, GUILD_JOINED, {
    guildId: String(111111111111111000n + BigInt(index)), guildName: `伺服器${index}`,
    notice: { inviterId: EVENT_INVITER_ID, joinedAtMs: state.clock.value, memberCount: 3 },
  });
  const recover = (index) => sendOwnerEvent(state, RECOVERED, {
    notice: { outageStartedAtMs: 500 + index, outageEndedAtMs: 900 + index, outageKind: 'connection' },
  });
  const classCounts = () => {
    const counts = {};
    for (const operation of durableOperations(state.notifier)) {
      if (operation.budgetClass === 'none') continue;
      counts[operation.budgetClass] = (counts[operation.budgetClass] || 0) + 1;
    }
    return counts;
  };

  // A flood of members leaving: two are reported. The shared budget, the guild join and the recovery are whole.
  const leaves = Array.from({ length: 40 }, (_, index) => sendOwnerEvent(state, MEMBER_LEFT, leftEvent(index + 1, state)));
  assert.equal(leaves.filter(Boolean).length, 2);
  assert.equal(sendOwnerEvent(state, 'LEDGER_SAMPLE_NOTICE'), true);
  assert.equal(join(1), true);
  assert.equal(recover(1), true);
  // Each is now spent for the minute.
  assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(100, state)), false);
  assert.equal(sendOwnerEvent(state, 'LEDGER_SAMPLE_NOTICE_B'), false);
  assert.equal(join(2), false);
  assert.equal(recover(2), false);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 5);
  assert.deepEqual(classCounts(), { 'owner-member-leave': 2, 'owner-notice': 1, 'owner-guild-join': 1, 'owner-outage': 1 });

  // The next minute, the other way round: a flood of safety events (one gets through) leaves two member
  // leaves, a guild join and, being the second this hour, a recovery.
  state.clock.value += 61_000;
  const safety = OWNER_NOTICE_CODES.map((code) => sendOwnerEvent(state, code));
  assert.equal(safety.filter(Boolean).length, 1);
  assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(200, state)), true);
  assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(201, state)), true);
  assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(202, state)), false);
  assert.equal(join(3), true);
  assert.equal(recover(3), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 10);
  assert.deepEqual(classCounts(), { 'owner-member-leave': 4, 'owner-notice': 2, 'owner-guild-join': 2, 'owner-outage': 2 });
  assert.equal(durableOperations(state.notifier).filter((operation) => operation.action === 'owner-safety-notification')
    .length, 2);
  assert.equal(state.logs.some((line) => line.includes('OWNER_SAFETY_LEDGER_FAILED')), false);
});

test('an owner event budget holds its daily number in memory and across a restart', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const base = state.clock.value;
  const recover = (offset, target = state) => sendOwnerEvent(target, RECOVERED, {
    notice: { outageStartedAtMs: 1_000 + offset, outageEndedAtMs: 1_500 + offset, outageKind: 'crash' },
  });
  // Four outages in a day, two an hour; each is sent before the clock moves on.
  assert.equal(recover(0), true);
  await state.notifier.waitForIdleForTests();
  state.clock.value = base + 60_000;
  assert.equal(recover(1), true);
  await state.notifier.waitForIdleForTests();
  state.clock.value = base + 3_600_000;
  assert.equal(recover(2), true);
  await state.notifier.waitForIdleForTests();
  state.clock.value = base + 3_660_000;
  assert.equal(recover(3), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 4);

  // Two hours on, the hour is clear and the day is not: refused by the process's own memory, with its line.
  state.clock.value = base + 7_262_000;
  assert.equal(recover(4), false);
  assert.deepEqual(state.logs, [BUDGET_LINE('recovery', 0)]);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 4);
  await state.notifier.stop();

  // A new process knows nothing of that, and the ledger still counts the four: the notice is taken in and
  // ends unsent.
  const restarted = reopen(state, { context: { ...CONTEXT, sourceEventId: '333333333333800001', actorId: BOT_ID } });
  assert.equal(restarted.notifier.preflight().enabled, true);
  assert.equal(restarted.emit(catalogueEvent(RECOVERED, { at: state.clock.value,
    notice: { outageStartedAtMs: 7_000_000, outageEndedAtMs: 7_100_000, outageKind: 'crash' } })), true);
  await restarted.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(restarted.calls), []);
  await restarted.notifier.stop();

  // The first outage of the day is a day old: one place is free again, and one only.
  state.clock.value = base + 86_400_000;
  const later = reopen(state, { context: { ...CONTEXT, sourceEventId: '333333333333800002', actorId: BOT_ID } });
  assert.equal(later.notifier.preflight().enabled, true);
  assert.equal(later.emit(catalogueEvent(RECOVERED, { at: state.clock.value,
    notice: { outageStartedAtMs: base + 86_000_000, outageEndedAtMs: base + 86_100_000, outageKind: 'restore' } })), true);
  await later.notifier.waitForIdleForTests();
  const texts = sentTexts(later.calls);
  assert.equal(texts.length, 1);
  assert.ok(texts[0].endsWith(`類型：${OUTAGE_KIND_TEXT.restore}`));
  await later.notifier.stop();
});

test('a notice the ledger budget refuses after a restart is logged and counted into the next notice of its category',
  async (t) => {
    const state = fixture(t);
    state.notifier.preflight();
    const base = state.clock.value;
    const recover = (target, offset) => sendOwnerEvent(target, RECOVERED, {
      notice: { outageStartedAtMs: 1_000 + offset, outageEndedAtMs: 1_500 + offset, outageKind: 'crash' },
    });
    // The day's four outage notices, each sent before the clock moves on.
    for (const [at, offset] of [[0, 0], [60_000, 1], [3_600_000, 2], [3_660_000, 3]]) {
      state.clock.value = base + at;
      assert.equal(recover(state, offset), true);
      await state.notifier.waitForIdleForTests();
    }
    assert.equal(sentTexts(state.calls).length, 4);
    await state.notifier.stop();

    // A new process: its memory knows nothing of those four, so it takes the next events in, and only the
    // ledger refuses them. That is no silent drop: one log line, and the count goes to the next notice.
    const logs = [];
    state.clock.value = base + 7_262_000;
    const restarted = reopen(state, { logs });
    const after = { notifier: restarted.notifier, emit: restarted.emit, clock: state.clock };
    assert.equal(restarted.notifier.preflight().enabled, true);
    assert.equal(recover(after, 10), true);
    await restarted.notifier.waitForIdleForTests();
    assert.deepEqual(sentTexts(restarted.calls), []);
    assert.deepEqual(logs, [BUDGET_LINE('recovery', 0)]);

    // A minute later the next one is taken in carrying the one left out, and the ledger refuses it as well:
    // both are put back into the count, once each. Within that minute another is refused by the memory
    // gate, counted too, and the line is held to one a minute.
    state.clock.value += 61_000;
    assert.equal(recover(after, 11), true);
    await restarted.notifier.waitForIdleForTests();
    assert.deepEqual(sentTexts(restarted.calls), []);
    assert.deepEqual(logs, [BUDGET_LINE('recovery', 0), BUDGET_LINE('recovery', 0)]);
    assert.equal(recover(after, 12), false);
    assert.equal(logs.length, 2);

    // A day after the first notice one place is free again: this one says that three were left out.
    state.clock.value = base + 86_400_000;
    assert.equal(recover(after, 13), true);
    await restarted.notifier.waitForIdleForTests();
    const texts = sentTexts(restarted.calls);
    assert.equal(texts.length, 1);
    assert.ok(texts[0].endsWith(`類型：${OUTAGE_KIND_TEXT.crash}；另有 3 則同類事件已合併`), texts[0]);
    assert.equal(logs.length, 2);
    // The count was taken by that notice; the next one starts from zero.
    state.clock.value += 61_000;
    assert.equal(recover(after, 14), true);
    await restarted.notifier.waitForIdleForTests();
    const next = sentTexts(restarted.calls);
    assert.equal(next.length, 2);
    assert.equal(next[1].includes('已合併'), false);
    await restarted.notifier.stop();
  });

test('what the ledger merges is not a budget refusal: no line, no count', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const leave = (index) => sendOwnerEvent(state, MEMBER_LEFT, leftEvent(index, state));
  assert.equal(leave(1), true);
  await state.notifier.waitForIdleForTests();
  await state.notifier.stop();

  // Restarted inside the ten minutes: the ledger remembers the first notice's merge window, the memory
  // does not. The same member's repeat is taken in and merged by the ledger, which is no refusal.
  const logs = [];
  state.clock.value += 5 * 60_000;
  const restarted = reopen(state, { logs });
  const after = { notifier: restarted.notifier, emit: restarted.emit, clock: state.clock };
  assert.equal(restarted.notifier.preflight().enabled, true);
  assert.equal(sendOwnerEvent(after, MEMBER_LEFT, leftEvent(1, state, { leftAtMs: state.clock.value })), true);
  await restarted.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(restarted.calls), []);
  assert.deepEqual(logs, []);
  // Another member, in the same minute: sent, and its text carries nothing from the merged repeat.
  assert.equal(sendOwnerEvent(after, MEMBER_LEFT, leftEvent(2, state)), true);
  await restarted.notifier.waitForIdleForTests();
  const texts = sentTexts(restarted.calls);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].includes('已合併'), false);
  await restarted.notifier.stop();
});

test('the minute budget of member leaves is held by the ledger across a restart, apart from the shared budget', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const leave = (index, target = state) => sendOwnerEvent(target, MEMBER_LEFT, leftEvent(index, state));
  assert.equal(leave(1), true);
  assert.equal(leave(2), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 2);
  await state.notifier.stop();

  // Same minute, new process: the third is taken in by the empty memory and refused by the ledger; the
  // shared budget's own notice goes out.
  const restarted = reopen(state, { context: { ...CONTEXT, sourceEventId: '333333333333810001', actorId: BOT_ID } });
  assert.equal(restarted.notifier.preflight().enabled, true);
  assert.equal(restarted.emit(catalogueEvent(MEMBER_LEFT, leftEvent(3, state))), true);
  assert.equal(restarted.emit(catalogueEvent('LEDGER_SAMPLE_NOTICE', { at: state.clock.value })), true);
  await restarted.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(restarted.calls), [`${NOTICE_PREFIXES.critical}LEDGER_SAMPLE_NOTICE`]);
  await restarted.notifier.stop();

  // A minute later the member's notice is sent.
  state.clock.value += 60_000;
  const next = reopen(state, { context: { ...CONTEXT, sourceEventId: '333333333333810002', actorId: BOT_ID } });
  assert.equal(next.notifier.preflight().enabled, true);
  assert.equal(next.emit(catalogueEvent(MEMBER_LEFT, leftEvent(4, state))), true);
  await next.notifier.waitForIdleForTests();
  assert.equal(sentTexts(next.calls).length, 1);
  assert.ok(sentTexts(next.calls)[0].includes('成員4'));
  await next.notifier.stop();
});

test('while the start guard holds Owner DMs back an owner event is dropped, with its own category in the line',
  async (t) => {
    const held = heldStartGuard(t);
    const calls = [];
    const state = fixture(t, { post: successfulPost(calls), ownerDmGate: held.guard });
    state.notifier.preflight();
    assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(1, state)), false);
    assert.equal(sendOwnerEvent(state, GUILD_JOINED, { guildId: CONTEXT.guildId, guildName: '新伺服器' }), false);
    assert.equal(sendOwnerEvent(state, RECOVERED, { notice: { outageKind: 'crash' } }), false);
    // Within the minute, one more of each is counted, not logged.
    assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(2, state)), false);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(calls, []);
    assert.deepEqual(state.logs, [GUARD_LINE('safety-event', 0, 'member-leave'),
      GUARD_LINE('safety-event', 0, 'guild-join'), GUARD_LINE('safety-event', 0, 'recovery')]);
    assert.deepEqual(state.notifier.ledger.getSnapshotForTests().operations, {});

    // Once the start succeeds the next member's notice is sent and the budget was not touched.
    held.succeed();
    assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(3, state)), true);
    assert.equal(sendOwnerEvent(state, MEMBER_LEFT, leftEvent(4, state)), true);
    await state.notifier.waitForIdleForTests();
    const texts = sentTexts(calls);
    assert.equal(texts.length, 2);
    assert.equal(texts.some((text) => text.includes('已合併')), false);
  });

test('the longest owner notice still fits the ledger binding and a Discord message, and passes the egress guard',
  async (t) => {
    const names = ['龍'.repeat(100), `${'a.com '.repeat(16)}`, '甲.乙 '.repeat(20), `https://${'x'.repeat(40)}.example/${'y'.repeat(40)}`];
    for (const name of names) {
      const state = fixture(t);
      installEgressGuard(state.client.rest, { approvedReleaseTag: 'v1.1.2' });
      const egressEvents = [];
      const restoreEgress = setEgressSafetyEventHandler((egressEvent) => egressEvents.push(egressEvent.code));
      try {
        state.notifier.preflight();
        assert.equal(sendOwnerEvent(state, MEMBER_LEFT, {
          guildId: CONTEXT.guildId, guildName: name,
          notice: { subjectId: EVENT_MEMBER_ID, subjectName: name, subjectUsername: name, joinedAtMs: 1_699_000_000_000,
            leftAtMs: 1_700_000_000_000, memberCount: 123_456 },
        }), true, name);
        await state.notifier.waitForIdleForTests();
      } finally {
        restoreEgress();
      }
      assert.deepEqual(egressEvents, [], name);
      assert.equal(state.logs.length, 0, state.logs.join('\n'));
      const [content] = sentTexts(state.calls);
      assert.ok(content, name);
      assert.ok(content.length < 1_900, name);
      assert.equal(rewriteLinks(content, { approve: () => null, maskedLink: 'label-and-marker', bareInvites: true,
        bareDomains: true }).rewritten, false, name);
    }
  });

test('names written like links reach the Owner through the egress guard with the link replaced, for every owner event',
  async (t) => {
    for (const name of ['www.example.com', 'discord.gg/abc', 'Fun https://x.y/z', 'bit.ly/abc 官方群', '領獎中心.com/x',
      'Free https://🎁.ws/nitro', 'https://ⓔⓥⓘⓛ.com/claim']) {
      const state = fixture(t);
      installEgressGuard(state.client.rest, { approvedReleaseTag: 'v1.1.2' });
      const egressEvents = [];
      const restoreEgress = setEgressSafetyEventHandler((egressEvent) => egressEvents.push(egressEvent.code));
      try {
        state.notifier.preflight();
        assert.equal(sendOwnerEvent(state, MEMBER_LEFT, { guildId: CONTEXT.guildId, guildName: name,
          notice: { subjectId: EVENT_MEMBER_ID, subjectName: name, subjectUsername: name, leftAtMs: 1_700_000_000_000 } }),
        true, name);
        state.clock.value += 61_000;
        assert.equal(sendOwnerEvent(state, GUILD_JOINED, { guildId: CONTEXT.guildId, guildName: name,
          notice: { inviterId: EVENT_INVITER_ID, joinedAtMs: 1_700_000_000_000 } }), true, name);
        await state.notifier.waitForIdleForTests();
      } finally {
        restoreEgress();
      }
      assert.deepEqual(egressEvents, [], name);
      const texts = sentTexts(state.calls);
      assert.equal(texts.length, 2, name);
      for (const content of texts) {
        assert.equal(rewriteLinks(content, { approve: () => null, maskedLink: 'label-and-marker', bareInvites: true,
          bareDomains: true }).rewritten, false, name);
        assert.doesNotMatch(content, /example\.com|discord\.gg\/|x\.y\/z|bit\.ly|領獎中心|\.ws|ⓔ/iu, name);
      }
    }
  });

// ---------------------------------------------------------------------------------------------------------
// Security alerts: 【place】小吉遭受攻擊(label), one DM per guild and kind an hour, a budget of their own.
// ---------------------------------------------------------------------------------------------------------

const GUILD_A = CONTEXT.guildId;
const GUILD_B = '111111111111111222';
const ALERT_KIND_LABELS = Object.freeze({
  'prompt-injection': '提示詞注入',
  'dev-info': '套取開發資訊',
  'personal-data': '索取個資或跨群資料',
  flood: '洗版',
  'output-guard': '輸出護欄觸發',
  'egress-block': '出口護欄阻擋',
  'permission-denied': '權限被拒',
  'link-risk': '釣魚或惡意連結',
});
const alertText = (place, kind, count = 0) =>
  `【${place}】小吉遭受攻擊(${ALERT_KIND_LABELS[kind]})${count ? `（過去一小時共 ${count} 次）` : ''}`;

// The alert the catalogue builds for `kind`, as the notifier is handed it, without delivering it.
function securityAlertEvent(kind, place = {}) {
  let built = null;
  const restore = setSafetyEventHandler((value) => { built = value; });
  try {
    reportSecurityAlert(kind, {
      guildId: 'guildId' in place ? place.guildId : GUILD_A,
      guildName: place.guildName ?? '',
      actorId: CONTEXT.actorId, channelId: CONTEXT.channelId, messageId: CONTEXT.sourceEventId,
    });
  } finally {
    restore();
  }
  return built;
}

let alertSource = 0;
function sendAlert(state, kind, place = {}) {
  alertSource += 1;
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(333333333333700000n + BigInt(alertSource)) });
  return state.emit(securityAlertEvent(kind, place));
}

const CHANNEL_MESSAGES = `/channels/${CHANNEL_ID}/messages`;

test('the labels of security alerts are the kinds of the catalogue, one fixed label each', () => {
  assert.deepEqual(Object.keys(SECURITY_ALERT_TEXT).sort(), [...SECURITY_ALERT_KINDS].sort());
  assert.deepEqual(SECURITY_ALERT_TEXT, ALERT_KIND_LABELS);
  assert.equal(new Set(Object.values(SECURITY_ALERT_TEXT)).size, SECURITY_ALERT_KINDS.length);
  assert.equal(Object.isFrozen(SECURITY_ALERT_KINDS), true);
  assert.throws(() => reportSecurityAlert('not-a-kind', { guildId: GUILD_A }), TypeError);
  assert.throws(() => reportSecurityAlert(undefined), TypeError);
  assert.throws(() => reportSecurityAlert('constructor'), TypeError);
  assert.throws(() => reportSecurityAlert('toString'), TypeError);
  // The event carries the kind and where it happened; the notice has no other field, and a producer cannot hand
  // in text: reportSecurityAlert takes no such field and the catalogue drops any it is given.
  const built = securityAlertEvent('flood', { guildName: '甲群' });
  assert.equal(built.code, SECURITY_ALERT);
  assert.equal(built.category, 'security-alert');
  assert.equal(built.notice.alertKind, 'flood');
  assert.equal(Object.values(built.notice).filter((value) => value !== null && value !== '').length, 1);
  const smuggled = catalogueEvent(SECURITY_ALERT, { notice: { alertKind: 'flood', subjectName: '偽造', text: '偽造文字' } });
  assert.equal(Object.hasOwn(smuggled.notice, 'text'), false);
  // Whatever else the notice holds, the alert's own text names the place and the label only.
  assert.equal(buildFixedNotice(SECURITY_ALERT, { guildId: GUILD_A, guildName: '甲群', notice: smuggled.notice }),
    alertText('甲群', 'flood'));
  assert.equal(catalogueEvent(SECURITY_ALERT, { notice: { alertKind: 'made-up' } }).notice.alertKind, null);
});

test('every OWNER_EVENT_* code has a merge key prefix of its own, and a code the identity does not know is an error', () => {
  const codes = Object.values(SAFETY_EVENT_CODES).filter((code) => code.startsWith('OWNER_EVENT_'));
  assert.ok(codes.length >= 4);
  const prefixes = codes.map((code) => ownerEventIdentity(catalogueEvent(code, {
    guildId: GUILD_A, notice: { alertKind: 'flood', subjectId: EVENT_MEMBER_ID },
  })).mergeKey.split(':')[0]);
  assert.equal(new Set(prefixes).size, codes.length, prefixes.join(','));
  assert.ok(prefixes.every((prefix) => /^owner-[a-z]+-v1$/u.test(prefix)), prefixes.join(','));
  // The recovery is no longer what an unknown code falls back to.
  assert.throws(() => ownerEventIdentity({ code: 'OWNER_EVENT_NOT_LISTED', guildId: GUILD_A, notice: {} }), TypeError);
  assert.throws(() => ownerEventIdentity({ code: 'ARCHIVE_UNAVAILABLE', notice: {} }), TypeError);
  assert.throws(() => ownerEventIdentity({ code: SECURITY_ALERT, guildId: GUILD_A, notice: { alertKind: 'made-up' } }), TypeError);
  // Every code with an event heading has a notice that can be built.
  for (const code of codes) {
    assert.ok(Object.hasOwn(EVENT_NOTICE_PREFIXES, code), code);
    assert.doesNotThrow(() => buildFixedNotice(code, { guildId: GUILD_A, guildName: '甲', notice: { alertKind: 'flood' } }), code);
  }
  assert.throws(() => buildFixedNotice(SECURITY_ALERT, { guildId: GUILD_A, notice: { alertKind: 'made-up' } }), TypeError);
  assert.throws(() => buildFixedNotice(SECURITY_ALERT, { guildId: GUILD_A }), TypeError);
});

test('the first alert of a guild and kind is sent at once; the next hour only counts, and then the count is said once',
  async (t) => {
    const state = fixture(t);
    state.notifier.preflight();
    const start = state.clock.value;
    assert.equal(sendAlert(state, 'flood', { guildName: '測試伺服器' }), true);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(sentTexts(state.calls), [alertText('測試伺服器', 'flood')]);
    // The text has no ID of the actor, the channel, the message or the guild, and no code.
    assert.doesNotMatch(sentTexts(state.calls)[0], /\d{6,}|OWNER_EVENT|固定代碼/u);
    assert.deepEqual(state.calls.find((call) => call.route === CHANNEL_MESSAGES).options.body.allowed_mentions,
      { parse: [], users: [], roles: [], replied_user: false });

    // A flood of the same guild and kind within the hour: counted in memory, never queued, never a ledger call.
    const operationsBefore = Object.keys(state.notifier.ledger.getSnapshotForTests().operations).length;
    for (let index = 0; index < 59; index += 1) {
      state.clock.value = start + 1_000 + index * 50_000;
      assert.equal(sendAlert(state, 'flood', { guildName: '測試伺服器' }), false, `alert ${index}`);
    }
    await state.notifier.waitForIdleForTests();
    assert.equal(sentTexts(state.calls).length, 1);
    assert.equal(Object.keys(state.notifier.ledger.getSnapshotForTests().operations).length, operationsBefore);
    assert.deepEqual(state.logs, []);

    // One millisecond short of the hour it is still held; at the hour the next one goes out with the count:
    // the one that opened the hour and the 60 that were merged.
    state.clock.value = start + 60 * 60_000 - 1;
    assert.equal(sendAlert(state, 'flood', { guildName: '測試伺服器' }), false);
    state.clock.value = start + 60 * 60_000;
    assert.equal(sendAlert(state, 'flood', { guildName: '測試伺服器' }), true);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(sentTexts(state.calls), [alertText('測試伺服器', 'flood'), alertText('測試伺服器', 'flood', 61)]);

    // The count was spent: an hour of one alert later, the text has none.
    state.clock.value = start + 120 * 60_000;
    assert.equal(sendAlert(state, 'flood', { guildName: '測試伺服器' }), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(sentTexts(state.calls).at(-1), alertText('測試伺服器', 'flood'));
  });

test('another guild and another kind are separate alerts: none swallows another, and each counts its own', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_A, guildName: '甲群' }), true);
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_B, guildName: '乙群' }), true);
  assert.equal(sendAlert(state, 'dev-info', { guildId: GUILD_A, guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(state.calls), [alertText('甲群', 'flood'), alertText('乙群', 'flood'), alertText('甲群', 'dev-info')]);
  // Repeats are counted per guild and kind: guild A twice more, guild B once more.
  state.clock.value += 5_000;
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_A, guildName: '甲群' }), false);
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_A, guildName: '甲群' }), false);
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_B, guildName: '乙群' }), false);
  state.clock.value += 60 * 60_000;
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_B, guildName: '乙群' }), true);
  state.clock.value += 60_000;
  assert.equal(sendAlert(state, 'flood', { guildId: GUILD_A, guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(state.calls).slice(3), [alertText('乙群', 'flood', 2), alertText('甲群', 'flood', 3)]);
});

test('security alerts spend a budget of their own: 3 a minute, and no other notice is spent or held by them', async (t) => {
  assert.deepEqual(CATEGORY_BUDGETS['security-alert'], [
    { windowMs: 60_000, maximum: 3 }, { windowMs: 3_600_000, maximum: 20 }, { windowMs: 86_400_000, maximum: 60 },
  ]);
  const state = fixture(t);
  state.notifier.preflight();
  const kinds = ['flood', 'dev-info', 'prompt-injection', 'personal-data'];
  const results = kinds.map((kind) => sendAlert(state, kind, { guildName: '甲群' }));
  // The fourth is over the minute: not sent, but counted for its guild and kind.
  assert.deepEqual(results, [true, true, true, false]);
  assert.deepEqual(state.logs, [BUDGET_LINE('security-alert', 0)]);
  // The notice budget of the other categories is whole: each is still taken, in the same minute.
  assert.equal(state.emit(noticeEvent(0)), true);
  assert.equal(sendOwnerEvent(state, GUILD_JOINED, { guildId: GUILD_A, guildName: '甲群',
    notice: { inviterId: EVENT_INVITER_ID, joinedAtMs: 1_700_000_000_000 } }), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 5);
  const ledgerClasses = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.action !== 'dm-channel.prepare').map((operation) => operation.budgetClass).sort();
  assert.deepEqual(ledgerClasses, ['owner-guild-join', 'owner-notice', 'owner-security', 'owner-security', 'owner-security']);
  const targets = Object.values(state.notifier.ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.budgetClass === 'owner-security').map((operation) => operation.target);
  assert.deepEqual([...new Set(targets)], [`${OWNER_ID}:security`]);

  // A minute later the refused kind goes out, saying it happened twice (the refused one and this one).
  state.clock.value += 60_001;
  assert.equal(sendAlert(state, 'personal-data', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).at(-1), alertText('甲群', 'personal-data', 2));
});

test('a security alert and a spent shared budget do not hold one another back', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  assert.equal(state.emit(noticeEvent(0)), true);
  assert.equal(state.emit(noticeEvent(1)), false);
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 2);
});

test('a guild name cannot forge the label of an alert, mention anyone or carry a link', async (t) => {
  const hostile = [
    '】小吉遭受攻擊(權限被拒)【', '甲群】小吉遭受攻擊(洗版)【乙群', '【偽造】', '〖偽造〗', '@everyone @here <@555555555555555555>',
    'https://evil.example/claim 領獎', 'discord.gg/abc 官方群', 'bit.ly/x', '甲;乙：丙', '`code` **bold** _it_',
    `甲${String.fromCodePoint(0x202e)}】${String.fromCodePoint(0x200b)}小吉遭受攻擊(權限被拒)`,
  ];
  for (const [index, name] of hostile.entries()) {
    const state = fixture(t);
    state.notifier.preflight();
    assert.equal(sendAlert(state, 'link-risk', { guildName: name }), true, `case ${index}`);
    await state.notifier.waitForIdleForTests();
    const [content] = sentTexts(state.calls);
    const label = `case ${index}: ${JSON.stringify(content)}`;
    // Exactly one pair of brackets, around the name; exactly one label, the real one, at the end.
    assert.equal(content.split('【').length, 2, label);
    assert.equal(content.split('】').length, 2, label);
    assert.match(content, /^【[^【】]*】小吉遭受攻擊\(釣魚或惡意連結\)$/u, label);
    assert.equal(content.split('(').length, 2, label);
    assert.ok(content.endsWith('(釣魚或惡意連結)'), label);
    assert.doesNotMatch(content, /<@|@everyone|@here|evil\.example|discord\.gg|bit\.ly|\p{Cf}/u, label);
    assert.equal(rewriteLinks(content, { approve: () => null, maskedLink: 'label-and-marker', bareInvites: true,
      bareDomains: true }).rewritten, false, label);
  }
});

test('a direct message is 私訊, a guild without a usable name is 未知群組, and the client name fills a missing one',
  async (t) => {
    const state = fixture(t);
    state.client.guilds = { cache: new Map([[GUILD_B, { name: '快取群' }]]) };
    state.notifier.preflight();
    assert.equal(sendAlert(state, 'permission-denied', { guildId: null }), true);
    assert.equal(sendAlert(state, 'flood', { guildId: GUILD_A, guildName: '' }), true);
    assert.equal(sendAlert(state, 'flood', { guildId: GUILD_B, guildName: '' }), true);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(sentTexts(state.calls), [
      alertText('私訊', 'permission-denied'), alertText('未知群組', 'flood'), alertText('快取群', 'flood'),
    ]);
    // A name that is nothing but what the clean-up removes has no name either.
    state.clock.value += 61_000;
    assert.equal(sendAlert(state, 'dev-info', { guildId: GUILD_A, guildName: '【】@everyone' }), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(sentTexts(state.calls).at(-1), alertText('未知群組', 'dev-info'));
    // A direct message and a guild are separate keys even for the same kind.
    state.clock.value += 61_000;
    assert.equal(sendAlert(state, 'flood', { guildId: null }), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(sentTexts(state.calls).at(-1), alertText('私訊', 'flood'));
  });

test('after a restart the ledger still holds the hour, and what it held back is counted into the next alert', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const start = state.clock.value;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  await state.notifier.stop();

  // 45 minutes in, a new process: its memory knows nothing, so it takes the alert in; the ledger holds the
  // hour and ends it unsent.
  state.clock.value = start + 45 * 60_000;
  const restarted = reopen(state);
  assert.equal(restarted.notifier.preflight().enabled, true);
  restarted.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333700501' });
  assert.equal(restarted.emit(securityAlertEvent('flood', { guildName: '甲群' })), true);
  await restarted.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(restarted.calls), []);
  // Past the hour of the first alert (the memory keeps its own hour from the one it took in): the next one
  // goes out and says two, the one the ledger held back and itself.
  state.clock.value = start + 45 * 60_000 + 60 * 60_000;
  restarted.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333700502' });
  assert.equal(restarted.emit(securityAlertEvent('flood', { guildName: '甲群' })), true);
  await restarted.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(restarted.calls), [alertText('甲群', 'flood', 2)]);
  await restarted.notifier.stop();
});

test('an alert the start guard holds back is dropped unsent and counted nowhere: the first one after goes out at once',
  async (t) => {
    const held = heldStartGuard(t);
    const calls = [];
    const state = fixture(t, { post: successfulPost(calls), ownerDmGate: held.guard });
    state.notifier.preflight();
    const operationsBefore = Object.keys(state.notifier.ledger.getSnapshotForTests().operations).length;
    for (let index = 0; index < 10; index += 1) {
      state.clock.value += 1_000;
      assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false);
    }
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(calls, []);
    assert.equal(Object.keys(state.notifier.ledger.getSnapshotForTests().operations).length, operationsBefore);
    assert.deepEqual(state.logs, [GUARD_LINE('safety-event', 0, 'security-alert')]);

    // The dropped alerts are not remembered for the hour and not counted into the first notice after the guard.
    held.succeed();
    state.clock.value += 1_000;
    assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
    await state.notifier.waitForIdleForTests();
    assert.deepEqual(sentTexts(calls), [alertText('甲群', 'flood')]);
  });

test('an alert without a host operation context, or with a kind outside the catalogue, is not sent', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  state.notifier.getContext = () => null;
  assert.equal(state.emit(securityAlertEvent('flood', { guildName: '甲群' })), false);
  assert.deepEqual(state.logs, ['[OWNER_SAFETY] code=OWNER_SAFETY_SOURCE_UNAVAILABLE']);
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: '333333333333799999' });
  const forged = Object.freeze({ code: SECURITY_ALERT, category: 'security-alert', at: state.clock.value, guildId: GUILD_A,
    guildName: '甲群', notice: Object.freeze({ alertKind: 'made-up' }) });
  assert.equal(state.emit(forged), false);
  assert.equal(state.emit(Object.freeze({ ...forged, notice: null })), false);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(state.calls), []);
});

test('alerts raised before the notifier is armed wait unsent and merge by guild and kind', async (t) => {
  const state = fixture(t, { armed: false });
  state.notifier.preflight();
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false);
  assert.equal(sendAlert(state, 'dev-info', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(state.calls, []);
  state.notifier.arm();
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(state.calls).sort(), [alertText('甲群', 'dev-info'), alertText('甲群', 'flood')].sort());
});

// ---------------------------------------------------------------------------------------------------------
// Security alerts: an unknown place is not a direct message; what the memory gate forgets; a count that is given back
// ---------------------------------------------------------------------------------------------------------

function securityAlertAt(kind, place) {
  let built = null;
  const restore = setSafetyEventHandler((value) => { built = value; });
  try {
    reportSecurityAlert(kind, { actorId: CONTEXT.actorId, channelId: CONTEXT.channelId, messageId: CONTEXT.sourceEventId, ...place });
  } finally {
    restore();
  }
  return built;
}

function emitAlertFrom(state, event) {
  alertSource += 1;
  state.notifier.getContext = () => ({ ...CONTEXT, sourceEventId: String(333333333333800000n + BigInt(alertSource)) });
  return state.emit(event);
}

test('an alert from a place that is not known is 未知群組 and keeps its own merge key; a direct message stays 私訊', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const dm = securityAlertAt('egress-block', { guildId: null });
  const unknown = securityAlertAt('egress-block', { guildId: null, placeUnknown: true });
  assert.equal(dm.placeUnknown, false);
  assert.equal(unknown.placeUnknown, true);
  // The flag exists on security alerts only, and only the value true counts.
  assert.equal(Object.hasOwn(catalogueEvent(MEMBER_LEFT), 'placeUnknown'), false);
  assert.equal(securityAlertAt('flood', { placeUnknown: 'yes' }).placeUnknown, false);
  assert.equal(buildOperation(dm, CONTEXT, OWNER_ID).mergeKey, 'owner-security-v1:dm:egress-block');
  assert.equal(buildOperation(unknown, CONTEXT, OWNER_ID).mergeKey, 'owner-security-v1:unknown:egress-block');
  assert.equal(buildOperation(securityAlertAt('egress-block', { guildId: GUILD_A, placeUnknown: true }), CONTEXT, OWNER_ID).mergeKey,
    `owner-security-v1:${GUILD_A}:egress-block`, 'a guild ID wins over the flag');

  assert.equal(emitAlertFrom(state, dm), true);
  assert.equal(emitAlertFrom(state, unknown), true, 'the unknown place is not swallowed by the direct message');
  assert.equal(emitAlertFrom(state, securityAlertAt('egress-block', { guildId: null, placeUnknown: true })), false, 'and merges with itself');
  assert.equal(emitAlertFrom(state, securityAlertAt('egress-block', { guildId: null })), false);
  await state.notifier.waitForIdleForTests();
  assert.deepEqual(sentTexts(state.calls), [alertText('私訊', 'egress-block'), alertText('未知群組', 'egress-block')]);
  // The flag does not turn a guild with a name into an unknown one.
  assert.equal(buildFixedNotice(SECURITY_ALERT, { guildId: GUILD_A, guildName: '甲群', placeUnknown: true, notice: { alertKind: 'flood' } }),
    alertText('甲群', 'flood'));
});

test('a count taken out for a notice that is then never sent is given back to its guild and kind', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const countKey = `security-alert:owner-security-v1:${GUILD_A}:flood`;
  const held = () => state.notifier.suppressedByCategory.get(countKey)?.count;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  for (let index = 0; index < 4; index += 1) assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false);
  assert.equal(held(), 4);

  // An hour on, the next alert takes the count (it is written into its text) and then is refused before the network.
  state.clock.value += 60 * 60_000;
  const refused = refuseNextRequest(state, `/channels/${CHANNEL_ID}/messages`, 'TEST_CHANNEL_EGRESS_DENIED');
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(refused.count, 1);
  assert.deepEqual(sentTexts(state.calls), [alertText('甲群', 'flood')], 'nothing was sent for it');
  assert.equal(held(), 4, 'the four are back, so the next notice still says what it stands for');

  // The next notice of the guild and kind goes out with the whole count: the four, and itself.
  state.clock.value += 60 * 60_000;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).at(-1), alertText('甲群', 'flood', 5));
  assert.equal(held(), undefined);
});

test('a notice that is turned away at the queue gives its count back too', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const countKey = `security-alert:owner-security-v1:${GUILD_A}:flood`;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  for (let index = 0; index < 3; index += 1) sendAlert(state, 'flood', { guildName: '甲群' });
  assert.equal(state.notifier.suppressedByCategory.get(countKey)?.count, 3);
  state.clock.value += 60 * 60_000;
  // Not armed yet and the waiting queue is full (32): the alert is turned away.
  state.notifier.armed = false;
  for (let index = 0; index < 32; index += 1) state.notifier.queue.push({ binding: { operationId: `filler-${index}` }, intake: null });
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false);
  assert.deepEqual(state.logs, ['[OWNER_SAFETY] code=OWNER_SAFETY_PRE_ARM_QUEUE_FULL']);
  assert.equal(state.notifier.suppressedByCategory.get(countKey)?.count, 3, 'the three are back');
  state.notifier.queue.length = 0;
  state.notifier.armed = true;
});

test('when the memory gate forgets a guild and kind, the ledger still holds the hour: no second DM, and the count is kept',
  async (t) => {
    const state = fixture(t);
    state.notifier.preflight();
    const key = `security-alert:owner-security-v1:${GUILD_A}:flood`;
    const start = state.clock.value;
    assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
    await state.notifier.waitForIdleForTests();
    assert.ok(state.notifier.intakeAttempts.has(key));
    // More keys than the gate keeps (512): they stand behind the first one, so the oldest, the key above, is the one it drops.
    for (let index = 0; index < 520; index += 1) {
      state.notifier.intakeAttempts.set(`audit:filler-${index}`, [{ at: state.clock.value, id: `filler-${index}` }]);
    }
    state.clock.value += 1_000;
    assert.equal(sendAlert(state, 'dev-info', { guildId: GUILD_B, guildName: '乙群' }), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(state.notifier.intakeAttempts.has(key), false, 'the gate forgot the guild and kind');
    assert.ok(state.notifier.intakeAttempts.size <= 521);

    // The alert is taken in again by the empty memory, and ends at the ledger, which holds the hour: no flood of DMs.
    state.clock.value = start + 10 * 60_000;
    assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false, 'and the memory holds it again');
    assert.deepEqual(sentTexts(state.calls), [alertText('甲群', 'flood'), alertText('乙群', 'dev-info')]);

    // The hour passes: one DM, with the count of what the ledger held back.
    state.clock.value = start + 71 * 60_000;
    assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
    await state.notifier.waitForIdleForTests();
    assert.equal(sentTexts(state.calls).length, 3);
    assert.equal(sentTexts(state.calls).at(-1), alertText('甲群', 'flood', 3));
  });

test('an attacker who makes many guilds and kinds cannot wash away the hour of one, and the counts stay bounded', async (t) => {
  const state = fixture(t);
  state.notifier.preflight();
  const start = state.clock.value;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  for (let index = 0; index < 4; index += 1) assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false);

  // 600 other guilds in the same minute: the budget lets two more DMs out and refuses the rest, counting each by guild and kind.
  let admitted = 0;
  for (let index = 0; index < 600; index += 1) {
    const guildId = String(900000000000000000n + BigInt(index));
    if (sendAlert(state, 'flood', { guildId, guildName: `攻擊${index}` })) admitted += 1;
  }
  await state.notifier.waitForIdleForTests();
  assert.equal(admitted, 2);
  assert.equal(sentTexts(state.calls).length, 3, 'three DMs in the minute at most: the budget of the security alerts');
  assert.ok(state.notifier.suppressedByCategory.size <= 512, `kept ${state.notifier.suppressedByCategory.size} counts`);

  // The first guild's hour is still held, in memory and at the ledger.
  state.clock.value = start + 30 * 60_000;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), false);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 3);
  // After the hour it is one DM again (its count may have been dropped with the oldest, but it is never more than one DM).
  state.clock.value = start + 61 * 60_000;
  assert.equal(sendAlert(state, 'flood', { guildName: '甲群' }), true);
  await state.notifier.waitForIdleForTests();
  assert.equal(sentTexts(state.calls).length, 4);
  assert.equal(sentTexts(state.calls).at(-1).startsWith('【甲群】小吉遭受攻擊(洗版)'), true);
});
