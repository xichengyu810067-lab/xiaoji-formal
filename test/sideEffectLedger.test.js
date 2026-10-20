'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { makeRealTempDir } = require('./support/realTempDir');
const {
  BUDGET_WINDOWS,
  DEFAULT_LEASE_MS,
  MAX_BINDING_BYTES,
  MAX_LEDGER_BYTES,
  MAX_SOURCE_KEY_LENGTH,
  MAX_VOLATILE_OPERATIONS,
  MERGE_WINDOW_MS,
  OWNER_BUDGET_POLICIES,
  OWNER_MERGE_WINDOWS_MS,
  OWNER_BUDGET_TARGET_SUFFIXES,
  PREPARE_RETRY_AFTER_MS,
  STALE_CLAIM_AFTER_MS,
  commitStagedLedger,
  initializePublicPurposeLedger,
  initializeSideEffectLedger,
  openPublicPurposeLedger,
  openRegisteredLedger,
  openSideEffectLedger,
  pathsFor,
} = require('../src/systems/safety/sideEffectLedger');

const NOTIFICATION_IDENTITY = Object.freeze({
  botId: '777777777777777777',
  ownerId: '444444444444444444',
});

// SQLite keeps the ledger open (and undeletable on Windows) until close(), and per-test
// after hooks run in registration order, so roots are removed once every test is done.
const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function fixture(t, { clock = { value: 1_000 } } = {}) {
  const root = makeRealTempDir('xiaoji-side-effect-ledger-');
  const filePath = path.join(root, 'ledger.json');
  const initialized = initializeSideEffectLedger({
    filePath,
    ledgerId: 'synthetic-ledger-v1',
    initializationId: 'synthetic-offline-initialization',
    notificationIdentity: NOTIFICATION_IDENTITY,
    now: () => clock.value,
  });
  roots.push(root);
  return { root, filePath, initialized, clock };
}

// Direct writer for tampering scenarios; it matches the store's exclusive WAL settings.
function withDirectConnection(filePath, work) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.prepare('PRAGMA journal_mode = WAL').get();
    return work(db);
  } finally {
    db.close();
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function binding(id, overrides = {}) {
  return {
    operationId: `operation-${id}`,
    sourceKey: 'discord.message:guild:111111111111111111:channel:222222222222222222',
    sourceEventId: `333333333333333${String(id).padStart(3, '0')}`,
    hostPurpose: 'discord.message',
    scope: 'guild:111111111111111111:channel:222222222222222222',
    action: 'owner-safety-notification',
    target: '444444444444444444',
    budgetClass: 'owner-notice',
    mergeKey: `merge-${id}`,
    payload: { schemaVersion: 1, code: `FIXED_${id}`, message: `固定訊息 ${id}` },
    ...overrides,
  };
}

test('side-effect ledger binds operation identity, rejects mutation, and fences stale generations', (t) => {
  const { filePath, initialized, clock } = fixture(t);
  const ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());

  const request = binding('001');
  const first = ledger.claim(request, { leaseMs: 100 });
  assert.equal(first.kind, 'claimed');
  assert.equal(ledger.claim(request).kind, 'replay');
  assert.throws(() => ledger.claim({ ...request, target: '555555555555555555' }),
    (error) => error.code === 'SIDE_EFFECT_BINDING_CONFLICT');

  clock.value += 101;
  const reclaimed = ledger.claim(request, { leaseMs: 100 });
  assert.equal(reclaimed.operation.generation, 2);
  assert.throws(() => ledger.beginDispatch(request, 1),
    (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED');
  ledger.renew(request.operationId, 2, { leaseMs: 100 });
  ledger.beginDispatch(request, 2);
  ledger.finish(request.operationId, 2, 'confirmed', 'synthetic_confirmed');
  assert.equal(ledger.getOperation(request.operationId).status, 'confirmed');
});

test('finish settles only an attempt that may have reached the network; never sent is recordNotSent alone', (t) => {
  const { filePath, initialized, clock } = fixture(t);
  const ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const request = binding('011');
  const claimed = ledger.claim(request);
  ledger.beginDispatch(request, claimed.operation.generation);
  // 'final' and 'not_sent' would claim that an attempt was certainly never sent.
  for (const outcome of ['final', 'not_sent', 'constructor', 'toString', undefined]) {
    assert.throws(() => ledger.finish(request.operationId, claimed.operation.generation, outcome, 'synthetic_code'),
      (error) => error.code === 'SIDE_EFFECT_OUTCOME_INVALID', String(outcome));
  }
  assert.equal(ledger.getOperation(request.operationId).status, 'attempted');
  assert.equal(ledger.finish(request.operationId, claimed.operation.generation, 'rejected', 'synthetic_rejected').status,
    'rejected');
  assert.equal(ledger.failed, false);
});

test('attempted state, charged budgets, and clock high-water survive restart; merge suppression stays in memory', (t) => {
  const { filePath, initialized, clock } = fixture(t);
  let ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  const first = binding('101', { mergeKey: 'shared-merge' });
  const claimed = ledger.claim(first);
  ledger.beginDispatch(first, claimed.operation.generation);
  ledger.close();

  clock.value = 500;
  ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  assert.equal(ledger.getOperation(first.operationId).status, 'unknown');
  assert.equal(ledger.claim(first).kind, 'replay');
  const merged = ledger.claim(binding('102', { mergeKey: 'shared-merge' }));
  assert.equal(merged.operation.status, 'suppressed_merge');
  const budget = ledger.claim(binding('103', { mergeKey: 'different-merge' }));
  assert.equal(budget.operation.status, 'suppressed_budget');
  ledger.close();

  clock.value = 1_000 + 10 * 60_000 + 1;
  ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  // Format 2 never writes merge or budget suppression, so after restart the never-sent 102
  // may be claimed once its window has passed, and 104 then merges into 102's new window.
  assert.equal(ledger.claim(binding('102', { mergeKey: 'shared-merge' })).kind, 'claimed');
  assert.equal(ledger.claim(binding('104', { mergeKey: 'shared-merge' })).operation.status, 'suppressed_merge');
  ledger.close();
});

test('preparation may release once before dispatch but attempted and unknown reservations never refund', (t) => {
  const { filePath, initialized, clock } = fixture(t);
  const ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const request = binding('201');
  const first = ledger.claim(request);
  ledger.releasePreparation(request.operationId, first.operation.generation);
  // A released preparation waits before it may be claimed again.
  assert.equal(ledger.claim(request).kind, 'replay');
  clock.value += PREPARE_RETRY_AFTER_MS;
  const second = ledger.claim(request);
  assert.equal(second.operation.generation, 2);
  ledger.releasePreparation(request.operationId, second.operation.generation);
  assert.equal(ledger.getOperation(request.operationId).status, 'final');
  assert.equal(ledger.claim(request).kind, 'replay');

  clock.value += 1;
  const attempted = binding('202');
  const next = ledger.claim(attempted);
  ledger.beginDispatch(attempted, next.operation.generation);
  ledger.finish(attempted.operationId, next.operation.generation, 'unknown', 'synthetic_unknown');
  assert.equal(ledger.getOperation(attempted.operationId).budgetCharged, true);

  clock.value += 1;
  const unavailable = binding('203');
  const finalized = ledger.finalizeUnattempted(unavailable, 'synthetic_unavailable');
  assert.equal(finalized.operation.status, 'final');
  assert.equal(finalized.operation.budgetCharged, false);
  assert.equal(ledger.claim(unavailable).kind, 'replay');
});

test('rolling owner budget enforces one per minute, six per hour, and twenty-four per day', (t) => {
  const { filePath, initialized, clock } = fixture(t, { clock: { value: 10_000 } });
  const ledger = openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());

  for (let index = 0; index < 6; index += 1) {
    const claimed = ledger.claim(binding(`5${String(index).padStart(2, '0')}`));
    assert.equal(claimed.kind, 'claimed');
    clock.value += 60_000;
  }
  assert.equal(ledger.claim(binding('506')).operation.status, 'suppressed_budget');

  for (let hour = 1; hour < 4; hour += 1) {
    clock.value = 10_000 + hour * 3_600_000;
    for (let index = 0; index < 6; index += 1) {
      const id = 600 + hour * 10 + index;
      assert.equal(ledger.claim(binding(String(id))).kind, 'claimed');
      clock.value += 60_000;
    }
  }
  clock.value = 10_000 + 4 * 3_600_000;
  assert.equal(ledger.claim(binding('700')).operation.status, 'suppressed_budget');
  clock.value = 10_000 + 24 * 3_600_000;
  assert.equal(ledger.claim(binding('701')).kind, 'claimed');
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const OWNER_ID = NOTIFICATION_IDENTITY.ownerId;
const OWNER_EVENT_CLASSES = Object.freeze(['owner-member-leave', 'owner-guild-join', 'owner-outage', 'owner-security']);

// A binding charged to `budgetClass`, with the target that class requires: the Owner ID, plus the class's
// suffix when it has one.
function classBinding(id, budgetClass, overrides = {}) {
  return binding(id, {
    budgetClass,
    target: `${OWNER_ID}${OWNER_BUDGET_TARGET_SUFFIXES[budgetClass] ?? ''}`,
    ...overrides,
  });
}

function openOwnerLedger({ filePath, initialized, clock }) {
  return openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
}

test('the Owner budget classes are frozen policies with their own windows and the old class is unchanged', () => {
  assert.equal(OWNER_BUDGET_POLICIES['owner-notice'], BUDGET_WINDOWS);
  assert.deepEqual(OWNER_BUDGET_POLICIES, {
    'owner-notice': [
      { windowMs: 60_000, maximum: 1 }, { windowMs: HOUR_MS, maximum: 6 }, { windowMs: DAY_MS, maximum: 24 },
    ],
    'owner-member-leave': [
      { windowMs: 60_000, maximum: 2 }, { windowMs: HOUR_MS, maximum: 12 }, { windowMs: DAY_MS, maximum: 48 },
    ],
    'owner-guild-join': [
      { windowMs: 60_000, maximum: 1 }, { windowMs: HOUR_MS, maximum: 6 }, { windowMs: DAY_MS, maximum: 24 },
    ],
    'owner-outage': [
      { windowMs: 60_000, maximum: 1 }, { windowMs: HOUR_MS, maximum: 2 }, { windowMs: DAY_MS, maximum: 4 },
    ],
    'owner-security': [
      { windowMs: 60_000, maximum: 3 }, { windowMs: HOUR_MS, maximum: 20 }, { windowMs: DAY_MS, maximum: 60 },
    ],
  });
  assert.equal(Object.isFrozen(OWNER_BUDGET_POLICIES), true);
  for (const windows of Object.values(OWNER_BUDGET_POLICIES)) {
    assert.equal(Object.isFrozen(windows), true);
    assert.equal(windows.every((window) => Object.isFrozen(window)), true);
  }
  assert.deepEqual(OWNER_BUDGET_TARGET_SUFFIXES, {
    'owner-member-leave': ':member-leave',
    'owner-guild-join': ':guild-join',
    'owner-outage': ':outage',
    'owner-security': ':security',
  });
});

test('each Owner event budget class enforces its own minute, hour and day windows', (t) => {
  for (const budgetClass of OWNER_EVENT_CLASSES) {
    const [perMinute, perHour, perDay] = OWNER_BUDGET_POLICIES[budgetClass].map((window) => window.maximum);
    const clock = { value: 10_000 };
    const { filePath, initialized } = fixture(t, { clock });
    const ledger = openOwnerLedger({ filePath, initialized, clock });
    t.after(() => ledger.close());
    const start = clock.value;
    let serial = 0;
    const attempt = () => {
      const result = ledger.claim(classBinding(`${budgetClass.slice(6)}-${serial += 1}`, budgetClass));
      return result.kind === 'claimed' ? 'claimed' : result.operation.status;
    };
    const label = (text) => `${budgetClass}: ${text}`;

    // One more attempt than the minute allows, at every minute boundary for a day and an hour: the
    // minute, hour and day windows all bind in turn. The expected answer of each attempt is worked out
    // independently, from the windows alone, over the times of the attempts that were let through.
    const allowedAt = [];
    const outcomes = [];
    for (let minute = 0; minute <= 25 * 60; minute += 1) {
      clock.value = start + minute * 60_000;
      for (let index = 0; index <= perMinute; index += 1) {
        const expected = OWNER_BUDGET_POLICIES[budgetClass].every(({ windowMs, maximum }) =>
          allowedAt.filter((at) => clock.value - at < windowMs).length + 1 <= maximum) ? 'claimed' : 'suppressed_budget';
        const actual = attempt();
        assert.equal(actual, expected, label(`minute ${minute}, attempt ${index}`));
        if (actual === 'claimed') allowedAt.push(clock.value);
        outcomes.push([clock.value - start, actual]);
      }
    }
    // The model is not the code under test: its numbers are the ones the policy states.
    const allowedBefore = (limitMs) => outcomes.filter(([at, status]) => at < limitMs && status === 'claimed').length;
    assert.equal(allowedBefore(60_000), perMinute, label('first minute'));
    assert.equal(allowedBefore(HOUR_MS), perHour, label('first hour'));
    assert.equal(allowedBefore(DAY_MS), perDay, label('first day'));
    assert.ok(allowedBefore(25 * HOUR_MS + 1) > perDay, label('allowed again once the first day leaves the window'));
  }
});

test('Owner budget classes do not spend one another, whichever is spent first', (t) => {
  const clock = { value: 10_000 };
  const { filePath, initialized } = fixture(t, { clock });
  const ledger = openOwnerLedger({ filePath, initialized, clock });
  t.after(() => ledger.close());
  let serial = 0;
  const status = (budgetClass) => {
    const result = ledger.claim(classBinding(`${budgetClass}-spend-${serial += 1}`, budgetClass));
    return result.kind === 'claimed' ? 'claimed' : result.operation.status;
  };

  // The minute of owner-member-leave (2) is spent: the shared budget and the others are whole.
  assert.equal(status('owner-member-leave'), 'claimed');
  assert.equal(status('owner-member-leave'), 'claimed');
  assert.equal(status('owner-member-leave'), 'suppressed_budget');
  assert.equal(status('owner-notice'), 'claimed');
  assert.equal(status('owner-notice'), 'suppressed_budget');
  assert.equal(status('owner-guild-join'), 'claimed');
  assert.equal(status('owner-guild-join'), 'suppressed_budget');
  assert.equal(status('owner-outage'), 'claimed');
  assert.equal(status('owner-outage'), 'suppressed_budget');
  // The security alerts have a minute of three of their own, which none of the above spent.
  for (let index = 0; index < 3; index += 1) assert.equal(status('owner-security'), 'claimed');
  assert.equal(status('owner-security'), 'suppressed_budget');

  // The other way round, in the next minute: the shared budget spent first leaves the leave budget whole.
  clock.value += 60_000;
  assert.equal(status('owner-notice'), 'claimed');
  assert.equal(status('owner-notice'), 'suppressed_budget');
  assert.equal(status('owner-member-leave'), 'claimed');
  assert.equal(status('owner-member-leave'), 'claimed');
  assert.equal(status('owner-member-leave'), 'suppressed_budget');
});

test('durable charges of an Owner budget class survive a restart and are counted for that class alone', (t) => {
  const clock = { value: 10_000 };
  const { filePath, initialized } = fixture(t, { clock });
  let ledger = openOwnerLedger({ filePath, initialized, clock });
  t.after(() => ledger.close());
  let serial = 0;
  const nextBinding = (budgetClass) => classBinding(`${budgetClass}-durable-${serial += 1}`, budgetClass);
  const dispatch = (budgetClass) => {
    const request = nextBinding(budgetClass);
    const claimed = ledger.claim(request);
    assert.equal(claimed.kind, 'claimed', request.operationId);
    ledger.beginDispatch(request, claimed.operation.generation);
    ledger.finish(request.operationId, claimed.operation.generation, 'confirmed', 'synthetic_confirmed');
  };
  const status = (budgetClass) => {
    const result = ledger.claim(nextBinding(budgetClass));
    return result.kind === 'claimed' ? 'claimed' : result.operation.status;
  };

  // owner-outage: four a day, two an hour.
  const start = clock.value;
  dispatch('owner-outage');
  clock.value = start + 60_000;
  dispatch('owner-outage');
  clock.value = start + HOUR_MS;
  dispatch('owner-outage');
  clock.value = start + HOUR_MS + 60_000;
  dispatch('owner-outage');
  // Three hours in: a whole minute of owner-member-leave, then the shared budget's one, in that minute.
  clock.value = start + 3 * HOUR_MS;
  dispatch('owner-member-leave');
  dispatch('owner-member-leave');
  dispatch('owner-notice');
  ledger.close();

  // A new process: nothing is in memory, and every charge above is still counted, each for its own class.
  ledger = openOwnerLedger({ filePath, initialized, clock });
  assert.equal(status('owner-outage'), 'suppressed_budget');
  assert.equal(status('owner-member-leave'), 'suppressed_budget');
  assert.equal(status('owner-notice'), 'suppressed_budget');
  assert.equal(status('owner-guild-join'), 'claimed');
  clock.value += 60_000;
  assert.equal(status('owner-member-leave'), 'claimed');
  assert.equal(status('owner-outage'), 'suppressed_budget');
  // The day of the first outage notice is over: one place is free again.
  clock.value = start + DAY_MS;
  assert.equal(status('owner-outage'), 'claimed');
  assert.equal(status('owner-outage'), 'suppressed_budget');
});

test('a security alert is held back for an hour by its merge key, every other class for ten minutes', (t) => {
  assert.equal(MERGE_WINDOW_MS, 10 * 60_000);
  assert.deepEqual(OWNER_MERGE_WINDOWS_MS, { 'owner-security': HOUR_MS });
  assert.equal(Object.isFrozen(OWNER_MERGE_WINDOWS_MS), true);
  const clock = { value: 10_000 };
  const { filePath, initialized } = fixture(t, { clock });
  const ledger = openOwnerLedger({ filePath, initialized, clock });
  t.after(() => ledger.close());
  let start = clock.value;
  const status = (id, budgetClass, mergeKey) => {
    const result = ledger.claim(classBinding(id, budgetClass, { mergeKey }));
    return result.kind === 'claimed' ? 'claimed' : result.operation.status;
  };
  for (const [budgetClass, windowMs] of [['owner-security', HOUR_MS], ['owner-member-leave', 10 * 60_000]]) {
    start = clock.value;
    assert.equal(status(`${budgetClass}-first`, budgetClass, `window-${budgetClass}`), 'claimed');
    // Another budget slot is used for each probe, so the merge window is what decides.
    clock.value = start + 10 * 60_000 - 1;
    assert.equal(status(`${budgetClass}-inside-ten`, budgetClass, `window-${budgetClass}`), 'suppressed_merge', budgetClass);
    clock.value = start + 10 * 60_000 + 1;
    const afterTen = status(`${budgetClass}-after-ten`, budgetClass, `window-${budgetClass}`);
    assert.equal(afterTen, windowMs === HOUR_MS ? 'suppressed_merge' : 'claimed', budgetClass);
  }
  // The window of the security alert ends after an hour, and it is that guild-and-kind key alone: another key
  // is not held by it.
  clock.value += 3 * HOUR_MS;
  start = clock.value;
  assert.equal(status('security-hour-first', 'owner-security', 'window-hour'), 'claimed');
  clock.value = start + 30 * 60_000;
  assert.equal(status('security-other-key', 'owner-security', 'window-other'), 'claimed');
  assert.equal(status('security-same-key', 'owner-security', 'window-hour'), 'suppressed_merge');
  clock.value = start + HOUR_MS + 1;
  assert.equal(status('security-after-hour', 'owner-security', 'window-hour'), 'claimed');
});

test('the hour of a security alert holds across a restart, once the notice was recorded as attempted', (t) => {
  const clock = { value: 10_000 };
  const { filePath, initialized } = fixture(t, { clock });
  let ledger = openOwnerLedger({ filePath, initialized, clock });
  t.after(() => ledger.close());
  const start = clock.value;
  const request = classBinding('security-durable', 'owner-security', { mergeKey: 'durable-security' });
  const claimed = ledger.claim(request);
  ledger.beginDispatch(request, claimed.operation.generation);
  ledger.finish(request.operationId, claimed.operation.generation, 'confirmed', 'synthetic_confirmed');
  ledger.close();

  clock.value = start + 45 * 60_000;
  ledger = openOwnerLedger({ filePath, initialized, clock });
  const again = ledger.claim(classBinding('security-durable-again', 'owner-security', { mergeKey: 'durable-security' }));
  assert.equal(again.kind, 'suppressed');
  assert.equal(again.operation.status, 'suppressed_merge');
  clock.value = start + HOUR_MS + 1;
  assert.equal(ledger.claim(classBinding('security-durable-later', 'owner-security',
    { mergeKey: 'durable-security' })).kind, 'claimed');
});

test('beginDispatch of an Owner event notice is fenced like any other and records its class and target', (t) => {
  const clock = { value: 10_000 };
  const { filePath, initialized } = fixture(t, { clock });
  const ledger = openOwnerLedger({ filePath, initialized, clock });
  t.after(() => ledger.close());
  const request = classBinding('guild-join-fenced', 'owner-guild-join');
  const claimed = ledger.claim(request, { leaseMs: 100 });
  assert.equal(claimed.kind, 'claimed');
  assert.equal(claimed.operation.budgetCharged, true);
  assert.throws(() => ledger.beginDispatch(request, claimed.operation.generation + 1),
    (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED');
  // A binding that does not fit its class cannot begin the claim either.
  assert.throws(() => ledger.beginDispatch({ ...request, target: OWNER_ID }, claimed.operation.generation),
    (error) => error.code === 'SIDE_EFFECT_BINDING_INVALID');
  clock.value += 101;
  assert.throws(() => ledger.beginDispatch(request, claimed.operation.generation),
    (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED');

  const reclaimed = ledger.claim(request, { leaseMs: 100 });
  assert.equal(reclaimed.kind, 'claimed');
  const begun = ledger.beginDispatch(request, reclaimed.operation.generation);
  assert.equal(begun.budgetClass, 'owner-guild-join');
  assert.equal(begun.target, `${OWNER_ID}:guild-join`);
  assert.equal(begun.budgetCharged, true);
  // The reservation became the durable charge; it is counted once, not twice and not for another class.
  assert.equal(ledger.claim(classBinding('guild-join-second', 'owner-guild-join')).operation.status,
    'suppressed_budget');
  assert.equal(ledger.claim(classBinding('notice-after-join', 'owner-notice')).kind, 'claimed');
});

// The budget part of the begin fence cannot be made to refuse through the API of one ledger (the comment in
// beginDispatch says why), so no behavioural test can tell a fence that skips a class from one that does
// not. This keeps the mistake that would make it skip one: a budget decision that names a class. Classes
// are looked up in OWNER_BUDGET_POLICIES, and the only class a comparison may name is 'none'.
test('the ledger decides about budgets for every class but none, and never names a class in a comparison', () => {
  const source = fs.readFileSync(require.resolve('../src/systems/safety/sideEffectLedger'), 'utf8');
  const named = [...source.matchAll(/budgetClass\s*[!=]==\s*'([^']+)'/gu)].map((match) => match[1]);
  assert.ok(named.length >= 3, 'the comparisons this guard is about are still there');
  assert.deepEqual([...new Set(named)], ['none']);
  assert.match(source, /budgeted = binding\.budgetClass !== 'none'/u);
  assert.match(source, /binding\.budgetClass !== 'none' && \(!claim\.budgetCharged \|\|/u);
});

test('an unknown budget class, or a target that does not fit its class, is refused before anything is recorded', (t) => {
  const clock = { value: 10_000 };
  const { filePath, initialized } = fixture(t, { clock });
  const ledger = openOwnerLedger({ filePath, initialized, clock });
  t.after(() => ledger.close());
  const refused = (id, overrides) => {
    const request = binding(id, overrides);
    for (const call of [() => ledger.claim(request), () => ledger.verifyBinding(request),
      () => ledger.suppress(request), () => ledger.finalizeUnattempted(request)]) {
      assert.throws(call, (error) => error.code === 'SIDE_EFFECT_BINDING_INVALID', JSON.stringify(overrides));
    }
    assert.equal(ledger.getOperation(request.operationId), null);
  };
  for (const budgetClass of ['owner-other', 'OWNER-NOTICE', 'owner_notice', 'constructor', '__proto__', 'toString']) {
    refused(`class-${budgetClass}`, { budgetClass });
  }
  // A class that is not owner-notice needs its own suffix on the Owner ID; owner-notice may carry none.
  refused('leave-plain', { budgetClass: 'owner-member-leave', target: OWNER_ID });
  refused('leave-bare', { budgetClass: 'owner-member-leave', target: ':member-leave' });
  refused('leave-as-join', { budgetClass: 'owner-member-leave', target: `${OWNER_ID}:guild-join` });
  refused('join-as-outage', { budgetClass: 'owner-guild-join', target: `${OWNER_ID}:outage` });
  refused('notice-as-leave', { budgetClass: 'owner-notice', target: `${OWNER_ID}:member-leave` });
  refused('notice-as-outage', { budgetClass: 'owner-notice', target: `${OWNER_ID}:outage` });
  refused('notice-as-security', { budgetClass: 'owner-notice', target: `${OWNER_ID}:security` });
  refused('security-plain', { budgetClass: 'owner-security', target: OWNER_ID });
  refused('security-as-leave', { budgetClass: 'owner-security', target: `${OWNER_ID}:member-leave` });
  refused('leave-as-security', { budgetClass: 'owner-member-leave', target: `${OWNER_ID}:security` });
  // A binding without a budget is not held to a suffix, and every class with its suffix is accepted.
  assert.equal(ledger.claim(binding('plain-none', { budgetClass: 'none' })).kind, 'claimed');
  assert.equal(ledger.claim(classBinding('fits-notice', 'owner-notice')).kind, 'claimed');
  for (const budgetClass of OWNER_EVENT_CLASSES) {
    assert.equal(ledger.claim(classBinding(`fits-${budgetClass}`, budgetClass)).kind, 'claimed', budgetClass);
  }
});

test('ledger fails closed for missing, corrupt, unknown, linked, retained-temp, and known rollback states', (t) => {
  const { root, filePath, initialized } = fixture(t);
  const initialBytes = fs.readFileSync(filePath);
  let ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY });
  ledger.claim(binding('301'));
  ledger.close();
  fs.writeFileSync(filePath, initialBytes);
  assert.throws(() => openSideEffectLedger({ filePath,
    expectedReceiptSha256: initialized.receiptSha256, expectedIdentity: NOTIFICATION_IDENTITY }),
  (error) => error.code === 'SIDE_EFFECT_ROLLBACK_DETECTED');

  const cases = [
    ['missing', (paths) => fs.unlinkSync(paths.ledgerPath), 'SIDE_EFFECT_FILE_INVALID'],
    ['corrupt', (paths) => fs.writeFileSync(paths.ledgerPath, '{'), 'SIDE_EFFECT_FILE_CORRUPT'],
    ['unknown', (paths) => withDirectConnection(paths.ledgerPath, (db) => db.exec('PRAGMA user_version = 99')),
      'SIDE_EFFECT_FORMAT_UNKNOWN'],
    // A ledger from the earlier schema revision 2 is reported as outdated, not corrupt.
    ['outdated', (paths) => withDirectConnection(paths.ledgerPath, (db) => db.exec('PRAGMA user_version = 2')),
      'SIDE_EFFECT_FORMAT_OUTDATED'],
    // The store never uses rollback journals, so a retained one means a foreign writer.
    ['temp', (paths) => fs.writeFileSync(paths.journalPath, 'retained'), 'SIDE_EFFECT_TEMP_PRESENT'],
  ];
  for (const [name, mutate, code] of cases) {
    const child = path.join(root, name);
    fs.mkdirSync(child);
    const childPath = path.join(child, 'ledger.json');
    const childInit = initializeSideEffectLedger({ filePath: childPath,
      ledgerId: `synthetic-${name}`, initializationId: `init-${name}`,
      notificationIdentity: NOTIFICATION_IDENTITY });
    mutate(childInit);
    assert.throws(() => openSideEffectLedger({ filePath: childPath,
      expectedReceiptSha256: childInit.receiptSha256,
      expectedIdentity: NOTIFICATION_IDENTITY }), (error) => error.code === code);
  }

  const linkedRoot = path.join(root, 'linked');
  fs.mkdirSync(linkedRoot);
  const linkedPath = path.join(linkedRoot, 'ledger.json');
  const linkedInit = initializeSideEffectLedger({ filePath: linkedPath,
    ledgerId: 'synthetic-linked', initializationId: 'init-linked',
    notificationIdentity: NOTIFICATION_IDENTITY });
  fs.linkSync(linkedPath, path.join(linkedRoot, 'second-link.json'));
  assert.throws(() => openSideEffectLedger({ filePath: linkedPath,
    expectedReceiptSha256: linkedInit.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY }), (error) => error.code === 'SIDE_EFFECT_FILE_INVALID');
});

test('ledger enforces conservative fixed caps and refuses compaction without permanent proof', (t) => {
  // Format 2 drops the operation and distinct-source caps; growth is bounded by the
  // 512 MiB soft limit of the SQLite store instead.
  assert.equal(MAX_LEDGER_BYTES, 512 * 1024 * 1024);
  assert.equal(MAX_BINDING_BYTES, 4 * 1024);
  assert.equal(MAX_SOURCE_KEY_LENGTH, 1_024);
  assert.deepEqual(BUDGET_WINDOWS, [
    { windowMs: 60_000, maximum: 1 },
    { windowMs: 3_600_000, maximum: 6 },
    { windowMs: 86_400_000, maximum: 24 },
  ]);
  const { filePath, initialized } = fixture(t);
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY });
  t.after(() => ledger.close());
  assert.throws(() => ledger.claim(binding('401', { sourceKey: 'x'.repeat(1_025) })),
    (error) => error.code === 'SIDE_EFFECT_BINDING_INVALID');
  assert.throws(() => ledger.claim(binding('402', { payload: { message: 'x'.repeat(4_097) } })),
    (error) => error.code === 'SIDE_EFFECT_BINDING_TOO_LARGE');
  assert.throws(() => ledger.closeSource('source', null),
    (error) => error.code === 'SIDE_EFFECT_SOURCE_PROOF_REQUIRED');
  assert.throws(() => ledger.closeSource('source', { permanent: true, trustedDigest: 'a'.repeat(64) }),
    (error) => error.code === 'SIDE_EFFECT_COMPACTION_UNAVAILABLE');
});

test('distinct sources are no longer capped and a rejected binding writes nothing', (t) => {
  const { filePath, initialized } = fixture(t);
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => 2_000 });
  t.after(() => ledger.close());
  // Format 1 refused distinct source 1025; format 2 has no source cap.
  for (let index = 0; index <= 1_024; index += 1) {
    const request = binding(`source-${index}`, { sourceKey: `retained-source-${index}`, budgetClass: 'none' });
    assert.equal(ledger.claim(request).kind, 'claimed');
  }
  const before = ledger.getStoreStatsForTests();
  assert.throws(() => ledger.claim(binding('source-7', { sourceKey: 'retained-source-7', budgetClass: 'none',
    target: '555555555555555555' })), (error) => error.code === 'SIDE_EFFECT_BINDING_CONFLICT');
  assert.deepEqual(ledger.getStoreStatsForTests(), before);
  assert.equal(ledger.getOperation('operation-source-7').status, 'claimed');
});

test('restart rejects a tampered ledger without changing the file or deleting history', (t) => {
  const { filePath, initialized } = fixture(t);
  const open = () => openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY });
  let ledger = open();
  const kept = binding('kept', { budgetClass: 'none' });
  const claimed = ledger.claim(kept);
  ledger.beginDispatch(kept, claimed.operation.generation);
  ledger.finish(kept.operationId, claimed.operation.generation, 'confirmed', 'synthetic_confirmed');
  ledger.close();

  withDirectConnection(filePath, (db) => db.exec('CREATE TABLE intruder (value TEXT)'));
  const before = sha256File(filePath);
  assert.throws(open, (error) => error.code === 'SIDE_EFFECT_FILE_CORRUPT');
  assert.equal(sha256File(filePath), before);
  // A failed open releases its lock, so the same rejection repeats instead of LEDGER_IN_USE.
  assert.throws(open, (error) => error.code === 'SIDE_EFFECT_FILE_CORRUPT');
  assert.equal(fs.existsSync(pathsFor(filePath).lockPath), false);

  withDirectConnection(filePath, (db) => db.exec('DROP TABLE intruder'));
  ledger = open();
  t.after(() => ledger.close());
  assert.equal(ledger.getOperation(kept.operationId).status, 'confirmed');
});

test('a ledger over its soft size limit refuses new work without deleting retained evidence', (t) => {
  const { filePath, initialized } = fixture(t);
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => 2_000 });
  t.after(() => ledger.close());
  const history = binding('history', { budgetClass: 'none' });
  const historyClaim = ledger.claim(history);
  ledger.beginDispatch(history, historyClaim.operation.generation);
  ledger.finish(history.operationId, historyClaim.operation.generation, 'confirmed', 'synthetic_confirmed');
  const pending = binding('pending', { budgetClass: 'none' });
  const pendingClaim = ledger.claim(pending);
  ledger.beginDispatch(pending, pendingClaim.operation.generation);
  const refused = binding('refused', { budgetClass: 'none' });
  const refusedClaim = ledger.claim(refused);

  ledger.maximumLedgerBytes = ledger.storageBytes() - 1;
  const before = ledger.getStoreStatsForTests();
  assert.throws(() => ledger.beginDispatch(refused, refusedClaim.operation.generation),
    (error) => error.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED');
  assert.equal(ledger.getStoreStatsForTests().commits, before.commits);
  assert.equal(ledger.getOperation(refused.operationId).durable, false);
  assert.equal(ledger.getOperation(history.operationId).status, 'confirmed');
  // An operation that was already attempted can always reach its terminal state.
  assert.equal(ledger.finish(pending.operationId, pendingClaim.operation.generation, 'unknown',
    'synthetic_unknown').status, 'unknown');
  assert.deepEqual(Object.values(ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.durable).map((operation) => operation.operationId).sort(),
  [history.operationId, pending.operationId].sort());
});

// Owner ledger operations without a budget class, for the in-memory capacity tests.
function unsent(id, overrides = {}) {
  return binding(id, { budgetClass: 'none', mergeKey: `memory-${id}`, ...overrides });
}

function rememberedCount(ledger) {
  return Object.values(ledger.getSnapshotForTests().operations).filter((operation) => !operation.durable).length;
}

test('a full memory evicts the oldest settled decisions first, then the oldest preparation failures', (t) => {
  const { filePath, initialized } = fixture(t);
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => 2_000 });
  t.after(() => ledger.close());
  ledger.finalizeUnattempted(unsent('settled-0'));
  ledger.suppress(unsent('settled-1'), 'queue_full');
  for (let index = 0; index < MAX_VOLATILE_OPERATIONS - 2; index += 1) {
    const request = unsent(`failed-${index}`);
    const claimed = ledger.claim(request);
    ledger.releasePreparation(request.operationId, claimed.operation.generation);
  }
  assert.equal(rememberedCount(ledger), MAX_VOLATILE_OPERATIONS);
  const claim = (id) => assert.equal(ledger.claim(unsent(id)).kind, 'claimed');

  claim('extra-0');
  assert.equal(ledger.getOperation('operation-settled-0'), null);
  assert.equal(ledger.getOperation('operation-settled-1').status, 'suppressed_queue');
  assert.equal(ledger.getOperation('operation-failed-0').status, 'prepare_failed');
  claim('extra-1');
  assert.equal(ledger.getOperation('operation-settled-1'), null);
  assert.equal(ledger.getOperation('operation-failed-0').status, 'prepare_failed');
  // No settled decision is left, so the oldest preparation failures go next.
  claim('extra-2');
  assert.equal(ledger.getOperation('operation-failed-0'), null);
  assert.equal(ledger.getOperation('operation-failed-1').status, 'prepare_failed');
  claim('extra-3');
  assert.equal(ledger.getOperation('operation-failed-1'), null);
  assert.equal(rememberedCount(ledger), MAX_VOLATILE_OPERATIONS);
  // A forgotten preparation failure only means the operation may be claimed again later.
  assert.equal(ledger.claim(unsent('failed-0')).kind, 'claimed');
});

test('when only live claims remain, a new claim fails closed and other decisions are not kept', (t) => {
  const { filePath, initialized } = fixture(t);
  const clock = { value: 2_000 };
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const claims = [];
  for (let index = 0; index < MAX_VOLATILE_OPERATIONS; index += 1) {
    const request = unsent(`live-${index}`);
    claims.push({ request, generation: ledger.claim(request).operation.generation });
  }
  const before = ledger.getStoreStatsForTests();
  assert.throws(() => ledger.claim(unsent('overflow')), (error) => error.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED');
  assert.equal(ledger.suppress(unsent('deferred'), 'queue_full').kind, 'suppressed');
  assert.equal(ledger.getOperation('operation-deferred'), null);
  assert.equal(ledger.finalizeUnattempted(unsent('unavailable')).kind, 'final');
  assert.equal(ledger.getOperation('operation-unavailable'), null);
  assert.equal(ledger.failed, false);
  assert.deepEqual(ledger.getStoreStatsForTests(), before);

  // A live claim still begins and finishes, which frees its slot for a new claim.
  const [first, stale] = claims;
  ledger.beginDispatch(first.request, first.generation);
  ledger.finish(first.request.operationId, first.generation, 'confirmed', 'synthetic_confirmed');
  assert.equal(ledger.claim(unsent('after-begin')).kind, 'claimed');

  // Claims whose lease expired long ago become evictable, oldest first. The abandoned
  // holder can no longer begin, and the operation never gets its old generation back.
  clock.value += DEFAULT_LEASE_MS + STALE_CLAIM_AFTER_MS;
  assert.equal(ledger.claim(unsent('after-stale')).kind, 'claimed');
  assert.equal(ledger.getOperation(stale.request.operationId), null);
  const reclaimed = ledger.claim(stale.request);
  assert.equal(reclaimed.kind, 'claimed');
  assert.notEqual(reclaimed.operation.generation, stale.generation);
  assert.throws(() => ledger.beginDispatch(stale.request, stale.generation),
    (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED');
  assert.equal(ledger.beginDispatch(stale.request, reclaimed.operation.generation).status, 'attempted');
});

test('repeated preparation failures inside one process never disable the purpose', (t) => {
  const { filePath, initialized } = fixture(t);
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => 2_000 });
  t.after(() => ledger.close());
  const total = MAX_VOLATILE_OPERATIONS + 64;
  for (let index = 0; index < total; index += 1) {
    const request = unsent(`retry-${index}`);
    const claimed = ledger.claim(request);
    assert.equal(claimed.kind, 'claimed');
    ledger.releasePreparation(request.operationId, claimed.operation.generation);
  }
  assert.equal(ledger.failed, false);
  assert.equal(rememberedCount(ledger), MAX_VOLATILE_OPERATIONS);
  assert.equal(ledger.getOperation('operation-retry-0'), null);
  assert.equal(ledger.getOperation(`operation-retry-${total - 1}`).status, 'prepare_failed');
  const next = unsent('after-retries');
  const claimed = ledger.claim(next);
  assert.equal(ledger.beginDispatch(next, claimed.operation.generation).status, 'attempted');
});

// Long leases keep these claims live (never evictable) for the rest of a test.
const LONG_LEASE_MS = 24 * 60 * 60 * 1_000;

// Fills memory with live claims, so the only evictable entry left is the one a test set up.
function fillWithLiveClaims(ledger, count) {
  const claims = [];
  for (let index = 0; index < count; index += 1) {
    const request = unsent(`filler-${index}`);
    claims.push({ request, generation: ledger.claim(request, { leaseMs: LONG_LEASE_MS }).operation.generation });
  }
  return claims;
}

// No holder that lost an operation may act on the claim that replaced it.
function assertStaleHoldersRejected(ledger, request, staleGenerations) {
  for (const generation of staleGenerations) {
    for (const [name, act] of [
      ['beginDispatch', () => ledger.beginDispatch(request, generation)],
      ['renew', () => ledger.renew(request.operationId, generation)],
      ['releasePreparation', () => ledger.releasePreparation(request.operationId, generation)],
      ['finalizeClaim', () => ledger.finalizeClaim(request.operationId, generation)],
    ]) {
      assert.throws(act, (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED', `${name} with generation ${generation}`);
    }
  }
}

test('a re-claimed claim that expires and is evicted never hands its generation to a later claim', (t) => {
  const { filePath, initialized } = fixture(t);
  const clock = { value: 2_000 };
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const target = unsent('reclaimed-then-evicted');
  const first = ledger.claim(target, { leaseMs: 1_000 }).operation.generation;
  clock.value += 1_001;
  // The first holder's lease expired; a re-claim replaces it.
  const second = ledger.claim(target, { leaseMs: 1_000 });
  assert.equal(second.kind, 'claimed');
  assert.notEqual(second.operation.generation, first);
  const fillers = fillWithLiveClaims(ledger, MAX_VOLATILE_OPERATIONS - 1);

  // Long after the re-claimed lease expired, it is the only evictable entry.
  clock.value = second.operation.leaseUntilMs + STALE_CLAIM_AFTER_MS;
  assert.equal(ledger.claim(unsent('evicting'), { leaseMs: LONG_LEASE_MS }).kind, 'claimed');
  assert.equal(ledger.getOperation(target.operationId), null);
  const [done] = fillers;
  ledger.beginDispatch(done.request, done.generation);
  ledger.finish(done.request.operationId, done.generation, 'confirmed', 'synthetic_confirmed');

  const fresh = ledger.claim(target);
  assert.equal(fresh.kind, 'claimed');
  assert.ok(![first, second.operation.generation].includes(fresh.operation.generation),
    `generation ${fresh.operation.generation} was handed out before`);
  assertStaleHoldersRejected(ledger, target, [first, second.operation.generation]);
  assert.equal(ledger.getOperation(target.operationId).status, 'claimed');
  assert.equal(ledger.getOperation(target.operationId).generation, fresh.operation.generation);
  assert.equal(ledger.beginDispatch(target, fresh.operation.generation).status, 'attempted');
});

test('a released preparation that is evicted never hands an expired generation to a later claim', (t) => {
  const { filePath, initialized } = fixture(t);
  const clock = { value: 2_000 };
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const target = unsent('released-then-evicted');
  const first = ledger.claim(target, { leaseMs: 1_000 }).operation.generation;
  clock.value += 1_001;
  // The first holder still believes it holds the claim; the re-claim's preparation fails.
  const second = ledger.claim(target, { leaseMs: 1_000 }).operation.generation;
  assert.equal(ledger.releasePreparation(target.operationId, second).status, 'prepare_failed');
  const fillers = fillWithLiveClaims(ledger, MAX_VOLATILE_OPERATIONS - 1);

  // No settled decision exists, so the preparation failure is evicted first.
  assert.equal(ledger.claim(unsent('evicting'), { leaseMs: LONG_LEASE_MS }).kind, 'claimed');
  assert.equal(ledger.getOperation(target.operationId), null);
  const [done] = fillers;
  ledger.beginDispatch(done.request, done.generation);
  ledger.finish(done.request.operationId, done.generation, 'confirmed', 'synthetic_confirmed');

  const fresh = ledger.claim(target);
  assert.equal(fresh.kind, 'claimed');
  assert.ok(![first, second].includes(fresh.operation.generation),
    `generation ${fresh.operation.generation} was handed out before`);
  assertStaleHoldersRejected(ledger, target, [first, second]);
  assert.equal(ledger.getOperation(target.operationId).generation, fresh.operation.generation);
  assert.equal(ledger.beginDispatch(target, fresh.operation.generation).status, 'attempted');
});

test('a released preparation is claimed again only after its wait, and the second counted failure settles it', (t) => {
  const { filePath, initialized } = fixture(t);
  const clock = { value: 2_000 };
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const request = unsent('retry-wait');
  const first = ledger.claim(request).operation.generation;
  const released = ledger.releasePreparation(request.operationId, first);
  assert.equal(released.status, 'prepare_failed');
  assert.equal(released.prepareFailures, 1);
  assert.equal(released.retryNotBeforeMs, 2_000 + PREPARE_RETRY_AFTER_MS);

  assert.equal(ledger.claim(request).kind, 'replay');
  clock.value += PREPARE_RETRY_AFTER_MS - 1;
  assert.equal(ledger.claim(request).operation.status, 'prepare_failed');
  clock.value += 1;
  const retried = ledger.claim(request);
  assert.equal(retried.kind, 'claimed');
  assert.ok(retried.operation.generation > first);
  assert.equal(retried.operation.retryNotBeforeMs, null);

  const settled = ledger.releasePreparation(request.operationId, retried.operation.generation);
  assert.equal(settled.status, 'final');
  assert.equal(settled.prepareFailures, 2);
  assert.equal(settled.retryNotBeforeMs, null);
  clock.value += 10 * PREPARE_RETRY_AFTER_MS;
  assert.equal(ledger.claim(request).operation.status, 'final');
});

test('a begin refused for capacity is retried after the wait and never counts as a preparation failure', (t) => {
  const { filePath, initialized } = fixture(t);
  const clock = { value: 2_000 };
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const request = unsent('capacity');
  ledger.maximumLedgerBytes = ledger.storageBytes() - 1;
  // Three refusals in a row: more than the two counted failures that would settle it.
  for (let round = 0; round < 3; round += 1) {
    const claimed = ledger.claim(request);
    assert.equal(claimed.kind, 'claimed', `round ${round}`);
    assert.throws(() => ledger.beginDispatch(request, claimed.operation.generation),
      (error) => error.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED');
    const released = ledger.releasePreparation(request.operationId, claimed.operation.generation);
    assert.equal(released.status, 'prepare_failed', `round ${round}`);
    assert.equal(released.prepareFailures, 0, `round ${round}`);
    assert.equal(released.resultCode, 'capacity_exceeded');
    clock.value += PREPARE_RETRY_AFTER_MS;
  }
  assert.equal(ledger.failed, false);

  // An ordinary preparation failure is still counted.
  const counted = ledger.claim(request);
  assert.equal(ledger.releasePreparation(request.operationId, counted.operation.generation).prepareFailures, 1);
  clock.value += PREPARE_RETRY_AFTER_MS;
  ledger.maximumLedgerBytes = MAX_LEDGER_BYTES;
  const last = ledger.claim(request);
  assert.equal(last.kind, 'claimed');
  assert.equal(ledger.beginDispatch(request, last.operation.generation).status, 'attempted');
});

// ---------------------------------------------------------------------------
// Durable decisions, inspection, staging, registered opens, and quarantine locations.
// ---------------------------------------------------------------------------

const PUBLIC_BOT_ID = '777777777777777777';

// A welcome ledger with its external witness, opened through the legacy facade.
function publicFixture(t, { clock = { value: 2_000_000 }, cutover = 1_000_000 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-side-effect-public-')));
  roots.push(root);
  const ledgerDirectory = path.join(root, 'ledger');
  const witnessDirectory = path.join(root, 'witness');
  fs.mkdirSync(ledgerDirectory);
  fs.mkdirSync(witnessDirectory);
  const filePath = path.join(ledgerDirectory, 'welcome.sqlite');
  const witnessPath = path.join(witnessDirectory, 'welcome.witness');
  const initialized = initializePublicPurposeLedger({
    filePath,
    continuityWitnessPath: witnessPath,
    ledgerId: 'welcome-public-fixture',
    initializationId: 'synthetic-public-fixture',
    purposeIdentity: { purposeId: 'welcome', botId: PUBLIC_BOT_ID, sourceNamespace: 'discord.guildMemberAdd',
      cutoverJoinedTimestampMs: cutover, freshSourceProofDigest: crypto.createHash('sha256').update('fresh').digest('hex') },
    now: () => clock.value,
  });
  const open = (options = {}) => openPublicPurposeLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'welcome', botId: PUBLIC_BOT_ID, sourceNamespace: 'discord.guildMemberAdd' },
    now: () => clock.value, ...options });
  return { root, filePath, witnessPath, initialized, clock, open };
}

function welcomeBinding(id, overrides = {}) {
  return {
    operationId: `welcome-${id}`,
    sourceKey: 'welcome:guild:111111111111111111',
    sourceEventId: `event.${id}`,
    hostPurpose: 'discord.guildMemberAdd',
    scope: 'guild:111111111111111111',
    action: 'welcome-message.create',
    target: '222222222222222222',
    budgetClass: 'none',
    mergeKey: `welcome-${id}`,
    payload: { content: `welcome ${id}` },
    sourceTimeMs: 1_500_000,
    ...overrides,
  };
}

function ledgerFootprint(ledger, filePaths) {
  const stats = ledger.getStoreStatsForTests();
  return { commits: stats.commits, totalChanges: stats.totalChanges, beginSeq: stats.beginSeq,
    files: filePaths.map((filePath) => sha256File(filePath)) };
}

// The fixture's ledger opened as the bootstrap opens it: from registration values.
function openRegisteredFromFixture(state, options = {}) {
  const { initialized, witnessPath } = state;
  return openRegisteredLedger({
    purposeId: 'welcome',
    kind: 'public',
    paths: { database: initialized.ledgerPath, anchor: initialized.anchorPath, witness: witnessPath,
      receipt: initialized.receiptPath },
    receiptSha256: initialized.receiptSha256,
    expected: { ledgerId: 'welcome-public-fixture', botId: PUBLIC_BOT_ID, ownerId: null, runtimeMode: 'production',
      genesisMs: 2_000_000, cutoverMs: 1_000_000, notBefore: null },
    now: () => state.clock.value,
    ...options,
  });
}

test('recordNotSent is a durable decision written before it returns, and never a second one', (t) => {
  const fixtureState = publicFixture(t);
  const { initialized, witnessPath, clock } = fixtureState;
  const witnesses = [initialized.anchorPath, witnessPath];
  let ledger = fixtureState.open();
  const before = ledgerFootprint(ledger, witnesses);
  const decided = ledger.recordNotSent(welcomeBinding('a'), 'channel_unavailable', { reason: 'missing' });
  assert.equal(decided.kind, 'recorded');
  assert.equal(decided.operation.durable, true);
  assert.equal(decided.operation.state, 'not_sent');
  assert.equal(decided.operation.status, 'final');
  assert.equal(decided.operation.resultCode, 'channel_unavailable');
  assert.deepEqual(decided.operation.result, { reason: 'missing' });
  const after = ledgerFootprint(ledger, witnesses);
  assert.equal(after.beginSeq, before.beginSeq + 1);
  // Both witnesses already carry the decision's step.
  assert.notEqual(after.files[0], before.files[0]);
  assert.notEqual(after.files[1], before.files[1]);

  // The same decision again, a source at or below the cutover, and an inspection: no write.
  assert.equal(ledger.recordNotSent(welcomeBinding('a'), 'channel_unavailable').kind, 'existing');
  const terminal = ledger.recordNotSent(welcomeBinding('old', { sourceTimeMs: 1_000_000 }), 'channel_unavailable');
  assert.equal(terminal.kind, 'terminal');
  assert.equal(terminal.operation.resultCode, 'before_cutover');
  assert.deepEqual(ledgerFootprint(ledger, witnesses), after);
  assert.throws(() => ledger.recordNotSent(welcomeBinding('a', { target: '333333333333333333' }), 'x'),
    (error) => error.code === 'SIDE_EFFECT_BINDING_CONFLICT');

  // A live claim is never overridden; an expired one is, and its holder can no longer begin.
  const claimed = ledger.claim(welcomeBinding('b'), { leaseMs: 1_000 });
  assert.throws(() => ledger.recordNotSent(welcomeBinding('b'), 'x'), (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED');
  clock.value += 1_001;
  assert.equal(ledger.recordNotSent(welcomeBinding('b'), 'lease_expired').kind, 'recorded');
  assert.throws(() => ledger.beginDispatch(welcomeBinding('b'), claimed.operation.generation),
    (error) => error.code === 'SIDE_EFFECT_FENCE_REJECTED');
  ledger.close();

  // A witness that cannot be written after the commit: the call fails, the ledger fails
  // closed, and the next open accepts the step and keeps the decision.
  let failWitness = false;
  ledger = fixtureState.open({ faultInjector: ({ label, phase }) => {
    if (failWitness && label === 'record-not-sent' && phase === 'before-continuity-witness-write') {
      throw new Error('synthetic witness failure');
    }
  } });
  failWitness = true;
  assert.throws(() => ledger.recordNotSent(welcomeBinding('c'), 'channel_unavailable'),
    (error) => error.code === 'SIDE_EFFECT_PERSIST_FAILED');
  assert.equal(ledger.failed, true);
  ledger.close();
  ledger = fixtureState.open();
  t.after(() => ledger.close());
  assert.equal(ledger.getOperation('welcome-c').state, 'not_sent');
  assert.equal(ledger.recordNotSent(welcomeBinding('c'), 'channel_unavailable').kind, 'existing');
  assert.equal(ledger.getOperation('welcome-a').state, 'not_sent');
});

test('inspect answers from the durable row, this process, or the cutover without any write', (t) => {
  const fixtureState = publicFixture(t);
  const { initialized, witnessPath } = fixtureState;
  const ledger = fixtureState.open();
  t.after(() => ledger.close());
  const sent = welcomeBinding('sent');
  const claim = ledger.claim(sent);
  ledger.beginDispatch(sent, claim.operation.generation);
  ledger.finish(sent.operationId, claim.operation.generation, 'confirmed', 'message_confirmed');
  ledger.claim(welcomeBinding('pending'));
  const footprint = ledgerFootprint(ledger, [initialized.anchorPath, witnessPath]);
  const durable = ledger.inspect({ operationId: sent.operationId });
  assert.equal(durable.kind, 'recorded');
  assert.equal(durable.basis, 'durable');
  assert.equal(durable.operation.status, 'confirmed');
  const volatile = ledger.inspect({ operationId: 'welcome-pending' });
  assert.equal(volatile.basis, 'volatile');
  assert.equal(volatile.operation.status, 'claimed');
  const computed = ledger.inspect({ operationId: 'welcome-old', sourceKey: sent.sourceKey, sourceTimeMs: 999 });
  assert.deepEqual(computed, { kind: 'terminal', basis: 'computed', reason: 'cutover', boundaryMs: 1_000_000,
    resultCode: 'before_cutover', operation: null });
  assert.deepEqual(ledger.inspect({ operationId: 'welcome-new', sourceKey: sent.sourceKey, sourceTimeMs: 1_900_000 }),
    { kind: 'absent', basis: null, operation: null });
  assert.deepEqual(ledger.inspect({ operationId: 'welcome-unknown' }), { kind: 'absent', basis: null, operation: null });
  assert.throws(() => ledger.inspect({ operationId: 'welcome-x', sourceKey: sent.sourceKey, sourceTimeMs: -1 }),
    (error) => error.code === 'SIDE_EFFECT_BINDING_INVALID');
  assert.deepEqual(ledgerFootprint(ledger, [initialized.anchorPath, witnessPath]), footprint);
});

test('countAttempts counts attempts inside a ledger-clock window, never decisions, with zero writes', (t) => {
  const fixtureState = publicFixture(t);
  const { initialized, witnessPath, clock } = fixtureState;
  const ledger = fixtureState.open();
  t.after(() => ledger.close());
  const attempt = (id) => {
    const request = welcomeBinding(id);
    const claimed = ledger.claim(request);
    ledger.beginDispatch(request, claimed.operation.generation);
    return claimed;
  };
  attempt('one');
  clock.value += 60 * 60 * 1_000;
  const second = attempt('two');
  ledger.finish('welcome-two', second.operation.generation, 'unknown', 'timeout');
  ledger.recordNotSent(welcomeBinding('decided'), 'deferred');
  const footprint = ledgerFootprint(ledger, [initialized.anchorPath, witnessPath]);
  assert.equal(ledger.countAttempts({ windowMs: 60 * 60 * 1_000 }), 1);
  assert.equal(ledger.countAttempts({ windowMs: 24 * 60 * 60 * 1_000 }), 2);
  assert.throws(() => ledger.countAttempts({ windowMs: 0 }), (error) => error.code === 'SIDE_EFFECT_BINDING_INVALID');
  assert.deepEqual(ledgerFootprint(ledger, [initialized.anchorPath, witnessPath]), footprint);
});

test('a released claim can be deferred without counting a failure and with an explicit retry time', (t) => {
  const { filePath, initialized, clock } = fixture(t);
  const ledger = openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY, now: () => clock.value });
  t.after(() => ledger.close());
  const request = unsent('deferred');
  for (let round = 0; round < 3; round += 1) {
    const claimed = ledger.claim(request);
    assert.equal(claimed.kind, 'claimed', `round ${round}`);
    const released = ledger.releasePreparation(request.operationId, claimed.operation.generation, 'deferred_cap',
      { counted: false, retryNotBeforeMs: clock.value + 3_600_000 });
    assert.equal(released.status, 'prepare_failed');
    assert.equal(released.prepareFailures, 0);
    assert.equal(released.resultCode, 'deferred_cap');
    assert.equal(released.retryNotBeforeMs, clock.value + 3_600_000);
    clock.value += 3_599_999;
    assert.equal(ledger.claim(request).kind, 'replay');
    clock.value += 1;
  }
  const claimed = ledger.claim(request);
  for (const options of [{ counted: 'no' }, { retryNotBeforeMs: -1 }, { retryNotBeforeMs: 1.5 }]) {
    assert.throws(() => ledger.releasePreparation(request.operationId, claimed.operation.generation, 'x', options),
      (error) => error.code === 'SIDE_EFFECT_BINDING_INVALID');
  }
  assert.equal(ledger.releasePreparation(request.operationId, claimed.operation.generation).prepareFailures, 1);
});

test('a quarantine is kept beside the ledger, beside its witness, and in the registration hook', async (t) => {
  const marker = (state) => pathsFor(state.filePath).retainedLockPath;
  const stamp = (state) => `${state.witnessPath}.quarantine.json`;
  const lines = [];
  const logger = { info() {}, warn: (line) => lines.push(['warn', line]), error: (line) => lines.push(['error', line]) };

  // All three places.
  const all = publicFixture(t);
  const events = [];
  const handle = openRegisteredFromFixture(all, { onQuarantine: async (event) => { events.push(event); } });
  assert.deepEqual(handle.quarantine('synthetic_review'), { kind: 'quarantined', reason: 'synthetic_review' });
  assert.equal(await handle.quarantineFlag, true);
  assert.equal(fs.existsSync(marker(all)), true);
  assert.equal(JSON.parse(fs.readFileSync(stamp(all), 'utf8')).record, 'stamp');
  assert.deepEqual(handle.quarantinePersistence, { marker: true, stamp: true, registration: true });
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], persisted: { ...events[0].persisted } }, { purposeId: 'welcome',
    ledgerId: 'welcome-public-fixture', reason: 'synthetic_review', requestedAtMs: 2_000_000,
    persisted: { marker: true, stamp: true } });
  handle.quarantine('again');
  handle.close();
  assert.equal(events.length, 1);

  // The marker alone fails: the stamp keeps the quarantine, which blocks every later open.
  const stampOnly = publicFixture(t);
  const partial = stampOnly.open({ logger, faultInjector: ({ label, target }) => {
    if (label === 'quarantine' && target === 'marker') throw new Error('synthetic marker fault');
  } });
  assert.deepEqual(partial.quarantine('synthetic_review'), { kind: 'quarantined', reason: 'synthetic_review' });
  assert.equal(partial.quarantineFailure, null);
  assert.deepEqual(partial.quarantinePersistence, { marker: false, stamp: true, registration: null });
  assert.ok(lines.some(([level, line]) => level === 'warn' && /code=SIDE_EFFECT_QUARANTINE_PARTIAL .*target=marker/u.test(line)));
  partial.close();
  assert.equal(fs.existsSync(marker(stampOnly)), false, 'the injected marker fault also covers the close() backup');
  assert.throws(() => stampOnly.open(), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');

  // Both files fail but the registration hook succeeds: the call reports the failure,
  // and the registration still keeps the purpose quarantined.
  const flagOnly = publicFixture(t);
  const flagged = openRegisteredFromFixture(flagOnly, { logger, onQuarantine: async () => {},
    faultInjector: ({ label }) => { if (label === 'quarantine') throw new Error('synthetic file fault'); } });
  assert.throws(() => flagged.quarantine('synthetic_review'),
    (error) => error.code === 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED');
  assert.equal(await flagged.quarantineFlag, true);
  assert.deepEqual(flagged.quarantinePersistence, { marker: false, stamp: false, registration: true });
  assert.ok(!lines.some(([, line]) => line.includes('LEDGER_QUARANTINE_UNPERSISTED')));
  flagged.close();

  // All three fail: logged as LEDGER_QUARANTINE_UNPERSISTED, and the handle stays disabled.
  // close() asks the registration once more; that fails as well, and nothing further is tried.
  const none = publicFixture(t);
  let hookCalls = 0;
  const lost = openRegisteredFromFixture(none, { logger,
    onQuarantine: async () => { hookCalls += 1; throw new Error('coin db down'); },
    faultInjector: ({ label }) => { if (label === 'quarantine') throw new Error('synthetic file fault'); } });
  assert.throws(() => lost.quarantine('synthetic_review'), (error) => error.code === 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED');
  assert.equal(await lost.quarantineFlag, false);
  assert.equal(lost.quarantined, true);
  assert.throws(() => lost.claim(welcomeBinding('z')), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
  const unpersisted = () => lines.filter(([level, line]) => level === 'error' &&
    line.includes('code=LEDGER_QUARANTINE_UNPERSISTED'));
  assert.equal(unpersisted().length, 1);
  assert.match(unpersisted()[0][1], / attempt=1 /u);
  assert.doesNotMatch(unpersisted()[0][1], /[\\/]/u);
  lost.close();
  assert.equal(await lost.quarantineFlag, false);
  assert.equal(hookCalls, 2);
  assert.equal(unpersisted().length, 2);
  assert.match(unpersisted()[1][1], / attempt=2 /u);
  lost.close();
  assert.equal(await lost.quarantineFlag, false);
  assert.equal(hookCalls, 2);
});

test('close() retries a failed registration flag once, asynchronously, and stops there', async (t) => {
  // The first attempt fails, the retry from close() records the flag.
  const recovering = publicFixture(t);
  const outcomes = [new Error('coin db busy'), null];
  const events = [];
  const ledger = openRegisteredFromFixture(recovering, { logger: { info() {}, warn() {}, error() {} },
    onQuarantine: async (event) => {
      events.push(event);
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
    } });
  ledger.quarantine('synthetic_review');
  assert.equal(await ledger.quarantineFlag, false);
  assert.equal(ledger.quarantinePersistence.registration, false);
  ledger.close();
  assert.equal(await ledger.quarantineFlag, true);
  assert.deepEqual(ledger.quarantinePersistence, { marker: true, stamp: true, registration: true });
  assert.equal(events.length, 2);
  assert.equal(events[1].requestedAtMs, events[0].requestedAtMs);

  // A first attempt still running when close() is called: the retry waits for it and
  // only runs if it failed.
  const pendingFixture = publicFixture(t);
  let release;
  let calls = 0;
  const pending = openRegisteredFromFixture(pendingFixture, { onQuarantine: () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  } });
  pending.quarantine('synthetic_review');
  pending.close();
  release();
  assert.equal(await pending.quarantineFlag, true);
  assert.equal(calls, 1);

  // close() of a ledger that was never quarantined asks nothing.
  const quiet = publicFixture(t);
  let quietCalls = 0;
  const untouched = openRegisteredFromFixture(quiet, { onQuarantine: async () => { quietCalls += 1; } });
  untouched.close();
  assert.equal(untouched.quarantineFlag, null);
  assert.equal(quietCalls, 0);
});

test('UNC and device paths, also with mixed separators, are refused by the facade before any file is touched',
  (t) => {
    const state = publicFixture(t);
    const mixed = process.platform === 'win32' ? ['/\\server\\share\\x.witness', '\\/server/share/x.witness'] : [];
    const touched = [];
    const originals = { lstatSync: fs.lstatSync, openSync: fs.openSync, realpathSync: fs.realpathSync };
    for (const name of Object.keys(originals)) {
      fs[name] = function spy(target, ...rest) {
        if (/server|localhost/u.test(String(target))) touched.push([name, String(target)]);
        return originals[name].call(this, target, ...rest);
      };
    }
    fs.realpathSync.native = originals.realpathSync.native;
    try {
      for (const remote of ['\\\\localhost\\c$\\x.witness', '//server/share/x.witness', ...mixed]) {
        assert.throws(() => initializePublicPurposeLedger({ filePath: path.join(state.root, 'ledger', 'other.sqlite'),
          continuityWitnessPath: remote, ledgerId: 'remote', initializationId: 'synthetic',
          purposeIdentity: { purposeId: 'welcome', botId: PUBLIC_BOT_ID, sourceNamespace: 'discord.guildMemberAdd',
            cutoverJoinedTimestampMs: 1, freshSourceProofDigest: 'a'.repeat(64) } }),
        (error) => error.code === 'SIDE_EFFECT_PATH_REMOTE', remote);
        assert.throws(() => initializeSideEffectLedger({ filePath: remote, ledgerId: 'remote', initializationId: 'x',
          notificationIdentity: NOTIFICATION_IDENTITY }), (error) => error.code === 'SIDE_EFFECT_PATH_REMOTE', remote);
        assert.throws(() => openRegisteredFromFixture(state, { paths: { database: state.initialized.ledgerPath,
          anchor: state.initialized.anchorPath, witness: remote, receipt: state.initialized.receiptPath } }),
        (error) => error.code === 'SIDE_EFFECT_PATH_REMOTE', remote);
        assert.throws(() => openSideEffectLedger({ filePath: remote, expectedReceiptSha256: 'a'.repeat(64),
          expectedIdentity: NOTIFICATION_IDENTITY }), (error) => error.code === 'SIDE_EFFECT_PATH_REMOTE', remote);
      }
    } finally {
      Object.assign(fs, originals);
    }
    assert.deepEqual(touched, []);
  });

test('a registered open checks paths, quarantine, receipt, identity, witnesses, and the last recorded state', (t) => {
  const state = publicFixture(t);
  let ledger = openRegisteredFromFixture(state);
  const counters = ledger.identityCounters;
  assert.equal(ledger.provenance.purposeIdentity.cutoverJoinedTimestampMs, 1_000_000);
  assert.equal(ledger.continuityWitness.filePath, state.witnessPath);
  ledger.close();
  const notBefore = { bootEpoch: counters.bootEpoch, beginSeq: counters.beginSeq, chainHead: counters.chainHead };
  ledger = openRegisteredFromFixture(state, { expected: { ledgerId: 'welcome-public-fixture', botId: PUBLIC_BOT_ID,
    ownerId: null, runtimeMode: 'production', genesisMs: 2_000_000, cutoverMs: 1_000_000, notBefore } });
  ledger.close();
  const expect = (overrides) => ({ ledgerId: 'welcome-public-fixture', botId: PUBLIC_BOT_ID, ownerId: null,
    runtimeMode: 'production', genesisMs: 2_000_000, cutoverMs: 1_000_000, notBefore: null, ...overrides });
  const files = [state.initialized.ledgerPath, state.initialized.anchorPath, state.witnessPath].map(sha256File);
  for (const [overrides, reason] of [[{ ledgerId: 'welcome-other' }, 'ledger-id'], [{ botId: '888888888888888888' }, 'bot'],
    [{ runtimeMode: 'test-control' }, 'runtime-mode'], [{ genesisMs: 1 }, 'genesis'], [{ cutoverMs: 2 }, 'cutover']]) {
    assert.throws(() => openRegisteredFromFixture(state, { expected: expect(overrides) }), (error) =>
      error.code === 'SIDE_EFFECT_IDENTITY_MISMATCH' && error.detail.reason === reason, reason);
  }
  assert.throws(() => openRegisteredFromFixture(state, { purposeId: 'word-chain.reaction' }),
    (error) => error.code === 'SIDE_EFFECT_IDENTITY_MISMATCH' && error.detail.reason === 'purpose');
  assert.throws(() => openRegisteredFromFixture(state, { receiptSha256: 'f'.repeat(64) }),
    (error) => error.code === 'SIDE_EFFECT_PROVENANCE_MISMATCH');
  assert.throws(() => openRegisteredFromFixture(state, { expected: expect({ notBefore: { ...notBefore,
    bootEpoch: notBefore.bootEpoch + 3 } }) }), (error) => error.code === 'SIDE_EFFECT_ROLLBACK_DETECTED' &&
    error.storeDetail.reason === 'registration-ahead');
  assert.throws(() => openRegisteredFromFixture(state, { paths: { database: state.initialized.ledgerPath,
    anchor: state.witnessPath, witness: state.witnessPath, receipt: state.initialized.receiptPath } }),
  (error) => error.code === 'SIDE_EFFECT_PATH_INVALID');
  assert.deepEqual([state.initialized.ledgerPath, state.initialized.anchorPath, state.witnessPath].map(sha256File), files);
  fs.writeFileSync(`${state.witnessPath}.quarantine.json`, '{}');
  assert.throws(() => openRegisteredFromFixture(state), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
  assert.throws(() => state.open(), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
});

test('a staged ledger is written under .creating names and committed by renaming the database last', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-side-effect-staged-')));
  roots.push(root);
  const ledgerDirectory = path.join(root, 'safety');
  const witnessDirectory = path.join(root, 'safety-witness');
  fs.mkdirSync(ledgerDirectory);
  fs.mkdirSync(witnessDirectory);
  const filePath = path.join(ledgerDirectory, 'owner-safety.sqlite');
  const witnessPath = path.join(witnessDirectory, 'owner-safety.witness');
  const staged = initializeSideEffectLedger({ filePath, continuityWitnessPath: witnessPath, ledgerId: 'owner-staged',
    initializationId: 'bootstrap:owner-staged', notificationIdentity: NOTIFICATION_IDENTITY, staging: true,
    genesisMs: 5_000, createdBy: 'bootstrap' });
  assert.deepEqual(fs.readdirSync(ledgerDirectory).sort(), ['owner-safety.sqlite.creating',
    'owner-safety.sqlite.provenance.json.creating', 'owner-safety.sqlite.witness.creating']);
  assert.deepEqual(fs.readdirSync(witnessDirectory), ['owner-safety.witness.creating']);
  const receipt = JSON.parse(fs.readFileSync(staged.staged.receiptPath, 'utf8'));
  assert.equal(receipt.ledger.filePath, filePath);
  assert.equal(receipt.continuityWitness.filePath, witnessPath);
  assert.equal(receipt.initializedAtMs, 5_000);
  assert.equal(receipt.createdBy, 'bootstrap');
  const renames = [];
  const events = [];
  const originalRename = fs.renameSync;
  const originalOpen = fs.openSync;
  fs.renameSync = (from, to) => {
    renames.push([path.basename(from), path.basename(to)]);
    events.push(`rename:${path.basename(to)}`);
    return originalRename(from, to);
  };
  // A flush opens the directory (POSIX) or, on Windows, the renamed file itself.
  fs.openSync = (target, flags, ...rest) => {
    if (flags === 'r' || flags === 'r+') events.push(`flush:${path.basename(String(target))}`);
    return originalOpen(target, flags, ...rest);
  };
  let committed;
  const phases = [];
  try {
    committed = await commitStagedLedger(staged, { faultInjector: ({ phase }) => phases.push(phase) });
  } finally {
    fs.renameSync = originalRename;
    fs.openSync = originalOpen;
  }
  assert.deepEqual(renames, [
    ['owner-safety.sqlite.witness.creating', 'owner-safety.sqlite.witness'],
    ['owner-safety.witness.creating', 'owner-safety.witness'],
    ['owner-safety.sqlite.provenance.json.creating', 'owner-safety.sqlite.provenance.json'],
    ['owner-safety.sqlite.creating', 'owner-safety.sqlite'],
  ]);
  assert.deepEqual(phases, ['before-rename-anchor', 'before-rename-witness', 'before-rename-receipt',
    'after-flush-companions', 'before-rename-database', 'after-rename-database']);
  // The external witness's rename is flushed before the database rename (the commit point).
  const witnessFlush = events.indexOf(process.platform === 'win32' ? 'flush:owner-safety.witness' : 'flush:safety-witness');
  assert.ok(witnessFlush > events.indexOf('rename:owner-safety.witness'), events.join(' '));
  assert.ok(witnessFlush < events.indexOf('rename:owner-safety.sqlite'), events.join(' '));
  assert.equal(committed.receiptSha256, staged.receiptSha256);
  assert.deepEqual(fs.readdirSync(ledgerDirectory).sort(), ['owner-safety.sqlite',
    'owner-safety.sqlite.provenance.json', 'owner-safety.sqlite.witness']);
  // The committed Owner ledger opens with its external witness through the legacy path too.
  const legacy = openSideEffectLedger({ filePath, expectedReceiptSha256: staged.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY });
  assert.equal(legacy.continuityWitness.filePath, witnessPath);
  legacy.close();
  fs.renameSync(witnessPath, `${witnessPath}.moved`);
  assert.throws(() => openSideEffectLedger({ filePath, expectedReceiptSha256: staged.receiptSha256,
    expectedIdentity: NOTIFICATION_IDENTITY }), (error) => error.storeCode === 'LEDGER_MISSING');

  // A staged database with a WAL beside it is not committed; a second commit is refused.
  const other = path.join(ledgerDirectory, 'other.sqlite');
  const otherWitness = path.join(witnessDirectory, 'other.witness');
  const second = initializeSideEffectLedger({ filePath: other, continuityWitnessPath: otherWitness, ledgerId: 'other',
    initializationId: 'bootstrap:other', notificationIdentity: NOTIFICATION_IDENTITY, staging: true });
  fs.writeFileSync(second.staged.walPath, Buffer.alloc(0));
  await assert.rejects(commitStagedLedger(second), (error) => error.code === 'SIDE_EFFECT_STAGING_INCOMPLETE');
  assert.equal(fs.existsSync(other), false);
  fs.renameSync(second.staged.walPath, `${second.staged.walPath}.moved`);
  await commitStagedLedger(second);
  await assert.rejects(commitStagedLedger(second), (error) => error.code === 'SIDE_EFFECT_STAGING_INCOMPLETE');
  await assert.rejects(commitStagedLedger({ ...second, staging: false }),
    (error) => error.code === 'SIDE_EFFECT_CONFIGURATION_INVALID');
});
