const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const commandPath = path.join(__dirname, '..', 'src', 'commands', 'coins.js');
const coinServicePath = path.join(__dirname, '..', 'src', 'services', 'coinService.js');

// /coins answers about the caller only: the interaction offers no user option at all, so a command that still asked
// for one would throw here.
function createInteraction({ guildId = 'guild-test', user, guildMembers }) {
  let lastReply;
  const interaction = {
    inGuild: () => true,
    guildId,
    user: user || { id: 'caller-1', username: 'caller', globalName: '主呼叫者' },
    options: {
      getUser: () => {
        throw new Error('/coins has no user option');
      },
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

// Replaces the balance lookups the command uses. getPlayerBalance is the lookup of one's own balance (it files the
// user under the guild); readPlayerBalance is the read-only lookup of somebody else's, which /coins must never use.
function withMockedCoinService({ getPlayerBalance, readPlayerBalance }, callback) {
  const resolvedServicePath = require.resolve(coinServicePath);
  const serviceModule = require.cache[resolvedServicePath];
  if (!serviceModule) {
    require(coinServicePath);
  }

  const loadedServiceModule = require.cache[resolvedServicePath];
  const originalGetPlayerBalance = loadedServiceModule.exports.getPlayerBalance;
  const originalReadPlayerBalance = loadedServiceModule.exports.readPlayerBalance;
  loadedServiceModule.exports.getPlayerBalance = getPlayerBalance;
  loadedServiceModule.exports.readPlayerBalance = readPlayerBalance || (async () => {
    throw new Error('/coins must not read somebody else\'s balance');
  });

  delete require.cache[require.resolve(commandPath)];
  const coinsCommand = require(commandPath);

  try {
    return callback(coinsCommand);
  } finally {
    loadedServiceModule.exports.getPlayerBalance = originalGetPlayerBalance;
    loadedServiceModule.exports.readPlayerBalance = originalReadPlayerBalance;
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

test('coins command has no user option and describes itself as the caller\'s own balance', () => {
  const command = require(commandPath);
  const json = command.data.toJSON();
  assert.deepEqual(json.options || [], []);
  assert.equal(json.description, '查詢自己的吉幣餘額');
});

test('coins command prefers guild member displayName from cache', async () => {
  let capturedGuildId;
  let capturedUserId;
  const user = { id: 'member-1', username: 'fallbackUser' };
  const members = createMembers({ cacheMember: { id: 'member-1', displayName: '練習角色' } });
  const { interaction, getReply } = createInteraction({ user, guildMembers: members });

  await withMockedCoinService({
    getPlayerBalance: async (guildId, userId) => {
      capturedGuildId = guildId;
      capturedUserId = userId;
      return playerSnapshot;
    },
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
  const user = { id: 'member-2', username: 'fallback-user' };
  const members = createMembers({ fetchMember: { id: 'member-2', displayName: '抓取暱稱' } });
  const { interaction, getReply } = createInteraction({ user, guildMembers: members });

  await withMockedCoinService({ getPlayerBalance: async () => playerSnapshot }, async (coinsCommand) => {
    await coinsCommand.execute(interaction);
  });

  const reply = getReply();
  assert.equal(reply.content.includes('抓取暱稱 的吉幣資料'), true);
  assert.equal(reply.content.includes('member-2'), false);
});

test('coins command uses globalName/username fallback when guild member missing', async () => {
  const user = { id: 'member-3', username: 'user-name', globalName: '全域名稱' };
  const members = createMembers({ cacheMember: null, fetchMember: null });
  const { interaction, getReply } = createInteraction({ user, guildMembers: members });

  await withMockedCoinService({ getPlayerBalance: async () => playerSnapshot }, async (coinsCommand) => {
    await coinsCommand.execute(interaction);
  });

  const reply = getReply();
  assert.equal(reply.content.includes('全域名稱 的吉幣資料'), true);
  assert.equal(reply.content.includes('member-3'), false);
});

test('coins command only ever uses the lookup of one\'s own balance', async () => {
  const caller = { id: 'caller-9', username: 'self-user', globalName: '自己' };
  const members = createMembers({ cacheMember: { id: 'caller-9', displayName: '自己' } });
  const { interaction, getReply } = createInteraction({ user: caller, guildMembers: members });
  const own = [];

  await withMockedCoinService({
    getPlayerBalance: async (guildId, userId) => {
      own.push([guildId, userId]);
      return playerSnapshot;
    },
    readPlayerBalance: async () => {
      throw new Error('/coins must not read somebody else\'s balance');
    },
  }, async (coinsCommand) => {
    await coinsCommand.execute(interaction);
  });

  assert.deepEqual(own, [['guild-test', 'caller-9']]);
  assert.equal(getReply().content.includes('自己 的吉幣資料'), true);
});
