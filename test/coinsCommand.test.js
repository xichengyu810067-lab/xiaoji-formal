const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const commandPath = path.join(process.cwd(), 'src', 'commands', 'coins.js');
const coinServicePath = path.join(process.cwd(), 'src', 'services', 'coinService.js');

function createInteraction({ guildId = 'guild-test', user, target, guildMembers }) {
  let lastReply;
  const interaction = {
    inGuild: () => true,
    guildId,
    user: user || { id: 'caller-1', username: 'caller', globalName: '主呼叫者' },
    options: {
      getUser: () => target || null,
    },
    guild: {
      members: guildMembers,
    },
    reply: async (payload) => {
      lastReply = payload;
    },
  };

  return { interaction, getReply: () => lastReply };
}

function withMockedCoinService(mockGetPlayerBalance, callback) {
  const resolvedServicePath = require.resolve(coinServicePath);
  const serviceModule = require.cache[resolvedServicePath];
  if (!serviceModule) {
    require(coinServicePath);
  }

  const loadedServiceModule = require.cache[resolvedServicePath];
  const originalGetPlayerBalance = loadedServiceModule.exports.getPlayerBalance;
  loadedServiceModule.exports.getPlayerBalance = mockGetPlayerBalance;

  delete require.cache[require.resolve(commandPath)];
  const coinsCommand = require(commandPath);

  try {
    return callback(coinsCommand);
  } finally {
    loadedServiceModule.exports.getPlayerBalance = originalGetPlayerBalance;
    delete require.cache[require.resolve(commandPath)];
  }
}

function createMembers({ cacheMember, fetchMember }) {
  return {
    cache: {
      get: (id) => (id === cacheMember?.id ? cacheMember : null),
    },
    fetch: async (id) => {
      if (!fetchMember) {
        throw new Error('fetch not implemented');
      }
      if (id === fetchMember.id) {
        return fetchMember;
      }
      throw new Error('not found');
    },
  };
}

const playerSnapshot = {
  balance: 1234,
  dailyStreak: 2,
  totalEarned: 100,
  totalSpent: 56,
};

test('coins command prefers guild member displayName from cache', async () => {
  let capturedGuildId;
  let capturedUserId;
  const target = { id: 'member-1', username: 'fallbackUser' };
  const members = createMembers({ cacheMember: { id: 'member-1', displayName: '練習角色' } });
  const { interaction, getReply } = createInteraction({ target, guildMembers: members });

  await withMockedCoinService(async (guildId, userId) => {
    capturedGuildId = guildId;
    capturedUserId = userId;
    return playerSnapshot;
  }, async (coinsCommand) => {
    await coinsCommand.execute(interaction);
  });

  const reply = getReply();
  assert.ok(reply.content.includes('練習角色 的吉幣資料'));
  assert.equal(capturedGuildId, 'guild-test');
  assert.equal(capturedUserId, 'member-1');
  assert.equal(reply.content.includes('member-1'), false);
});

test('coins command falls back to guild members.fetch displayName when cache misses', async () => {
  const target = { id: 'member-2', username: 'fallback-user' };
  const members = createMembers({ fetchMember: { id: 'member-2', displayName: '抓取暱稱' } });
  const { interaction, getReply } = createInteraction({ target, guildMembers: members });

  await withMockedCoinService(async () => playerSnapshot, async (coinsCommand) => {
    await coinsCommand.execute(interaction);
  });

  const reply = getReply();
  assert.equal(reply.content.includes('抓取暱稱 的吉幣資料'), true);
  assert.equal(reply.content.includes('member-2'), false);
});

test('coins command uses globalName/username fallback when guild member missing', async () => {
  const target = { id: 'member-3', username: 'user-name', globalName: '全域名稱' };
  const members = createMembers({ cacheMember: null, fetchMember: null });
  const { interaction, getReply } = createInteraction({ target, guildMembers: members });

  await withMockedCoinService(async () => playerSnapshot, async (coinsCommand) => {
    await coinsCommand.execute(interaction);
  });

  const reply = getReply();
  assert.equal(reply.content.includes('全域名稱 的吉幣資料'), true);
  assert.equal(reply.content.includes('member-3'), false);
});
