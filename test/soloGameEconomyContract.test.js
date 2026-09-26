const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-discord-solo-contract-'));
process.env.COIN_DB_PATH = path.join(temp, 'coins.sqlite');

const { initializeNewCoinDatabase, withCoinDatabase, withCoinTransaction, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { makeRewardKey: economyRewardKey } = require('../src/services/featurePlatformService');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { createSoloSessionService, makeRewardKey } = require('../src/systems/games/soloSessionService');

test('real v22 transaction commits a Discord game result and one global reward receipt', async () => {
  try {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
    const coordinator = createRuntimeRewardCoordinator();
    const service = createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction,
      grantRewardOnceV2WithApi: (api, request) => coordinator.grantInTransaction(api, request),
      clock: () => new Date('2026-09-26T00:00:00.000Z'),
      idFactory: () => 'syntheticdiscordgame', seedFactory: () => 'syntheticseed' });
    const session = await service.create({ userId: '10001', guildId: '20001', channelId: '30001',
      gameType: 'number-match', difficulty: 'easy' });
    await service.bindMessage({ sessionId: session.id, actorId: '10001', guildId: '20001',
      channelId: '30001', messageId: '40001' });
    const scope = { sessionId: session.id, actorId: '10001', guildId: '20001',
      channelId: '30001', messageId: '40001' };
    await service.apply({ ...scope, expectedRevision: 0, interactionId: 'syntheticmove1', action: { type: 'pair', first: 0, second: 1 } });
    const final = await service.apply({ ...scope, expectedRevision: 1, interactionId: 'syntheticmove2', action: { type: 'pair', first: 0, second: 1 } });
    assert.equal(final.rewardStatus, 'granted');
    assert.equal(makeRewardKey({ sessionId: session.id, userId: '10001' }), economyRewardKey({
      kind: 'game', canonicalSourceId: `discord:${session.id}`, rewardKind: 'completion', userId: '10001',
    }));
    const before = await withCoinDatabase((api) => ({
      reward: api.get('SELECT * FROM discord_game_rewards WHERE session_id = ?', [session.id]),
      count: api.get('SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = ?', [`discord:${session.id}`]).count,
    }));
    assert.equal(before.reward.status, 'granted');
    assert.equal(before.count, 1);
    const replay = await service.apply({ ...scope, expectedRevision: 1, interactionId: 'syntheticmove2', action: { type: 'pair', first: 0, second: 1 } });
    assert.equal(replay.replayed, true);
    const after = await withCoinDatabase((api) => api.get('SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = ?', [`discord:${session.id}`]).count);
    assert.equal(after, 1);
  } finally {
    resetCoinDatabaseForTests();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
