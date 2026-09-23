const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const commandPath = path.join(process.cwd(), 'src', 'commands', 'economy.js');
const moderationPath = path.join(process.cwd(), 'src', 'utils', 'moderation.js');
const coinServicePath = path.join(process.cwd(), 'src', 'services', 'coinService.js');
const bankServicePath = path.join(process.cwd(), 'src', 'services', 'bankService.js');
const workServicePath = path.join(process.cwd(), 'src', 'services', 'workService.js');

function createInteraction({ guildId = 'guild-1', targetUser }) {
  let lastReply;

  return {
    interaction: {
      inGuild: () => true,
      guildId,
      user: { id: 'caller-1', username: 'tester', globalName: '測試者' },
      guild: {
        name: '單元測試伺服器',
        id: guildId,
      },
      options: {
        getSubcommand: () => 'user',
        getUser: () => targetUser,
      },
      reply: async (payload) => {
        lastReply = payload;
      },
    },
    getReply: () => lastReply,
  };
}

function withMockedEconomyCommand(callback) {
  const restoreFns = [];

  const patch = (modulePath, updates) => {
    const resolved = require.resolve(modulePath);
    const moduleExports = require.cache[resolved]?.exports || require(resolved);
    if (!moduleExports) {
      throw new Error(`Failed to load module for patching: ${modulePath}`);
    }
    const original = {};

    for (const [key, value] of Object.entries(updates)) {
      original[key] = moduleExports[key];
      moduleExports[key] = value;
    }

    restoreFns.push(() => {
      for (const [key, value] of Object.entries(original)) {
        moduleExports[key] = value;
      }
    });
  };

  patch(moderationPath, {
    ensureModerationAccess: async () => ({ ok: true }),
  });
  patch(coinServicePath, {
    getPurchaseHistory: async () => [],
    getInventory: async () => [],
  });
  patch(bankServicePath, {
    getBalanceSummary: async () => ({
      userId: 'member-123',
      walletBalance: 100,
      bankBalance: 200,
      fixedPrincipal: 300,
      fixedExpectedInterest: 10,
      fixedClaimable: 20,
      totalAssets: 630,
    }),
    listFixedDeposits: async () => [],
  });
  patch(workServicePath, {
    getWorkStatus: async () => ({
      activeJob: null,
    }),
    getPayrollHistory: async () => [],
  });

  delete require.cache[require.resolve(commandPath)];
  try {
    const command = require(commandPath);
    return callback(command);
  } finally {
    restoreFns.forEach((restore) => restore());
    delete require.cache[require.resolve(commandPath)];
  }
}

test('economy user report should not include raw user ID', async () => {
  const targetUser = {
    id: 'member-123',
    username: 'member',
    globalName: '目標使用者',
  };
  const { interaction, getReply } = createInteraction({ targetUser });

  await withMockedEconomyCommand(async (command) => {
    await command.execute(interaction);
  });

  const reply = getReply();
  assert.ok(reply);
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.content.includes(targetUser.id), false);
  assert.equal(reply.content.includes('目標使用者 經濟資料'), true);
});
