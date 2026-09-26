const test = require('node:test');
const assert = require('node:assert/strict');

const { createRewardCoordinator, makeRewardKey } = require('../src/coordinators/rewardCoordinator');

function receiptFor(input, id = 1) {
  return {
    id, transactionId: id, rewardKey: makeRewardKey(input), operationId: input.operationId,
    kind: input.kind, canonicalSourceId: input.canonicalSourceId,
    rewardKind: input.rewardKind, userId: input.userId, amount: input.amount,
  };
}

const workReward = Object.freeze({
  kind: 'work-settlement', canonicalSourceId: 'primary:cycle-1', rewardKind: 'salary',
  userId: '10001', sourceGuildId: '20001', amount: 75,
  operationId: 'work-settlement:primary:cycle-1', actorUserId: '30001',
  metadata: { source: 'primary-cycle' },
});

test('transaction reward is synchronous, keeps the work operation ID, and uses only the bound coin API', () => {
  const api = { transaction: 'active' };
  const receipts = new Map();
  let credits = 0;
  let topLevelCalls = 0;
  let readbackCalls = 0;
  const coordinator = createRewardCoordinator({
    async grantRewardOnceV2() { topLevelCalls += 1; throw new Error('separate transaction forbidden'); },
    async getRewardReceiptV2() { readbackCalls += 1; throw new Error('separate read forbidden'); },
    grantRewardOnceV2WithApi(passedApi, input) {
      assert.equal(passedApi, api);
      assert.equal(input.operationId, workReward.operationId);
      assert.equal(input.actorUserId, workReward.actorUserId);
      assert.deepEqual(input.metadata, workReward.metadata);
      const key = makeRewardKey(input);
      if (receipts.has(key)) return { alreadyGranted: true, receipt: receipts.get(key), balance: credits };
      credits += input.amount;
      const receipt = receiptFor(input);
      receipts.set(key, receipt);
      return { alreadyGranted: false, receipt, balance: credits };
    },
  });

  const first = coordinator.grantInTransaction(api, workReward);
  assert.equal(typeof first.then, 'undefined');
  assert.equal(first.alreadyGranted, false);
  assert.equal(first.receipt.operationId, workReward.operationId);
  assert.equal(first.receipt.rewardKey, first.rewardKey);
  const second = coordinator.grantInTransaction(api, { ...workReward, sourceGuildId: '20002' });
  assert.equal(second.alreadyGranted, true);
  assert.equal(second.rewardKey, first.rewardKey);
  assert.equal(credits, 75);
  assert.equal(topLevelCalls, 0);
  assert.equal(readbackCalls, 0);
});

test('transaction reward rejects a conflicting or incomplete economic receipt', () => {
  const api = {};
  let result = { receipt: receiptFor(workReward) };
  const coordinator = createRewardCoordinator({
    grantRewardOnceV2() {}, getRewardReceiptV2() {},
    grantRewardOnceV2WithApi() { return result; },
  });
  for (const changed of [
    { rewardKey: 'reward:v1:wrong' },
    { operationId: 'work-settlement:other' },
    { amount: 76 },
    { userId: '10002' },
  ]) {
    result = { receipt: { ...receiptFor(workReward), ...changed } };
    assert.throws(() => coordinator.grantInTransaction(api, workReward), { code: 'REWARD_KEY_CONFLICT' });
  }
  result = { receipt: { ...receiptFor(workReward), transactionId: null } };
  assert.throws(() => coordinator.grantInTransaction(api, workReward), { code: 'REWARD_RECEIPT_INVALID' });
  for (const field of ['id', 'transactionId']) {
    for (const invalid of ['', '1', 0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      result = { receipt: { ...receiptFor(workReward), [field]: invalid } };
      assert.throws(() => coordinator.grantInTransaction(api, workReward),
        { code: 'REWARD_RECEIPT_INVALID' });
    }
  }
  result = {};
  assert.throws(() => coordinator.grantInTransaction(api, workReward), { code: 'REWARD_RECEIPT_INVALID' });
  result = { receipt: receiptFor(workReward) };
  assert.throws(() => coordinator.grantInTransaction(api, { ...workReward, operationId: 'work-settlement:other' }),
    { code: 'REWARD_KEY_CONFLICT' });
  assert.throws(() => coordinator.grantInTransaction(api, { ...workReward, userId: 'not-a-discord-id' }),
    { code: 'REWARD_IDENTITY_INVALID' });
});

test('a game reward defaults its operation ID to the shared reward key', () => {
  const input = {
    kind: 'game', canonicalSourceId: 'discord:session-1', rewardKind: 'completion',
    userId: '10001', sourceGuildId: '20001', amount: 25,
    metadata: { game: 'number-match' },
  };
  const coordinator = createRewardCoordinator({
    grantRewardOnceV2() {}, getRewardReceiptV2() {},
    grantRewardOnceV2WithApi(_api, prepared) {
      assert.equal(prepared.operationId, makeRewardKey(input));
      assert.deepEqual(prepared.metadata, input.metadata);
      return { receipt: receiptFor(prepared), alreadyGranted: false };
    },
  });
  const result = coordinator.grantInTransaction({}, input);
  assert.equal(result.rewardKey, result.receipt.operationId);
});

test('transaction reward rejects an async port and propagates economic conflicts without readback', () => {
  let readbackCalls = 0;
  let response = Promise.resolve({ receipt: receiptFor(workReward) });
  const coordinator = createRewardCoordinator({
    grantRewardOnceV2() {},
    getRewardReceiptV2() { readbackCalls += 1; },
    grantRewardOnceV2WithApi() {
      if (response instanceof Error) throw response;
      return response;
    },
  });
  assert.throws(() => coordinator.grantInTransaction({}, workReward), { code: 'PORT_ASYNC_IN_TRANSACTION' });
  response = Object.assign(new Error('operation belongs to another reward'), { code: 'OPERATION_CONFLICT' });
  assert.throws(() => coordinator.grantInTransaction({}, workReward), { code: 'OPERATION_CONFLICT' });
  assert.equal(readbackCalls, 0);
  const asyncOnly = createRewardCoordinator({ grantRewardOnceV2() {}, getRewardReceiptV2() {} });
  assert.throws(() => asyncOnly.grantInTransaction({}, workReward), { code: 'PORT_INVALID' });
});

test('existing async reward path remains compatible and preserves an explicit operation ID', async () => {
  let saved = null;
  let grants = 0;
  const queriedOperationIds = [];
  const coordinator = createRewardCoordinator({
    async getRewardReceiptV2({ rewardKey, operationId }) {
      assert.equal(rewardKey, makeRewardKey(workReward));
      queriedOperationIds.push(operationId);
      return saved;
    },
    async grantRewardOnceV2(input) {
      grants += 1;
      assert.equal(input.operationId, workReward.operationId);
      assert.equal(input.actorUserId, workReward.actorUserId);
      assert.deepEqual(input.metadata, workReward.metadata);
      saved = receiptFor(input);
      return { alreadyGranted: false, receipt: saved };
    },
  });
  const first = await coordinator.grant(workReward);
  assert.equal(first.alreadyGranted, false);
  assert.equal(first.receipt.operationId, workReward.operationId);
  const second = await coordinator.grant({ ...workReward, sourceGuildId: '20002' });
  assert.equal(second.alreadyGranted, true);
  assert.equal(grants, 1);
  await assert.rejects(coordinator.grant({ ...workReward, operationId: 'work-settlement:other' }),
    { code: 'REWARD_KEY_CONFLICT' });
  saved = { ...receiptFor(workReward), id: '' };
  await assert.rejects(coordinator.grant(workReward), { code: 'REWARD_RECEIPT_INVALID' });
  assert.equal(grants, 1);
  assert.deepEqual(queriedOperationIds,
    [workReward.operationId, workReward.operationId, 'work-settlement:other', workReward.operationId]);
});
