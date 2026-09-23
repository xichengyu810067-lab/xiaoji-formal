const test = require('node:test');
const assert = require('node:assert/strict');
const musicCommand = require('../src/commands/music');

const SUBCOMMANDS = [
  'join',
  'test',
  'play',
  'queue',
  'status',
  'stay',
  'skip',
  'pause',
  'resume',
  'stop',
  'leave',
];

function withPrivateMusicEnv(callback) {
  const previousOwnerId = process.env.BOT_OWNER_ID;
  const previousLegacyOwnerId = process.env.OWNER_ID;
  const previousGuildId = process.env.DISCORD_GUILD_ID;
  process.env.BOT_OWNER_ID = 'owner-1';
  process.env.OWNER_ID = 'legacy-owner';
  process.env.DISCORD_GUILD_ID = 'main-guild';

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previousOwnerId === undefined) delete process.env.BOT_OWNER_ID;
      else process.env.BOT_OWNER_ID = previousOwnerId;
      if (previousLegacyOwnerId === undefined) delete process.env.OWNER_ID;
      else process.env.OWNER_ID = previousLegacyOwnerId;
      if (previousGuildId === undefined) delete process.env.DISCORD_GUILD_ID;
      else process.env.DISCORD_GUILD_ID = previousGuildId;
    });
}

test('every music subcommand denies non-owner users before reaching playback code', async () => {
  await withPrivateMusicEnv(async () => {
    for (const subcommand of SUBCOMMANDS) {
      const replies = [];
      let getSubcommandCalled = false;
      const interaction = {
        commandName: 'music',
        user: { id: 'not-owner', tag: 'member#0001' },
        options: {
          getSubcommand: () => {
            getSubcommandCalled = true;
            return subcommand;
          },
        },
        reply: async (payload) => replies.push(payload),
      };

      await musicCommand.execute(interaction);

      assert.equal(getSubcommandCalled, false, `${subcommand} must be owner-gated before dispatch`);
      assert.deepEqual(replies, [{ content: '你沒有權限使用這個指令。', ephemeral: true }]);
    }
  });
});

test('music rejects OWNER_ID fallback when BOT_OWNER_ID is missing', async () => {
  await withPrivateMusicEnv(async () => {
    delete process.env.BOT_OWNER_ID;
    process.env.OWNER_ID = 'legacy-owner';
    const replies = [];
    let getSubcommandCalled = false;

    await musicCommand.execute({
      commandName: 'music',
      user: { id: 'legacy-owner', tag: 'legacy#0001' },
      guildId: 'main-guild',
      inGuild: () => true,
      options: {
        getSubcommand: () => {
          getSubcommandCalled = true;
          return 'queue';
        },
      },
      reply: async (payload) => replies.push(payload),
    });

    assert.equal(getSubcommandCalled, false);
    assert.deepEqual(replies, [{ content: '你沒有權限使用這個指令。', ephemeral: true }]);
  });
});

test('music command denies the owner outside the configured private test guild', async () => {
  await withPrivateMusicEnv(async () => {
    const replies = [];
    let getSubcommandCalled = false;

    await musicCommand.execute({
      commandName: 'music',
      user: { id: 'owner-1', tag: 'owner#0001' },
      guildId: 'another-guild',
      inGuild: () => true,
      options: {
        getSubcommand: () => {
          getSubcommandCalled = true;
          return 'queue';
        },
      },
      reply: async (payload) => replies.push(payload),
    });

    assert.equal(getSubcommandCalled, false);
    assert.deepEqual(replies, [{ content: musicCommand.PRIVATE_EXPERIMENT_DENIED_MESSAGE, ephemeral: true }]);
  });
});

test('music command remains reachable only for the exact BOT_OWNER_ID in the configured test guild', async () => {
  await withPrivateMusicEnv(async () => {
    const replies = [];

    await musicCommand.execute({
      commandName: 'music',
      user: { id: 'owner-1', tag: 'owner#0001' },
      guildId: 'main-guild',
      inGuild: () => true,
      options: { getSubcommand: () => 'queue' },
      reply: async (payload) => replies.push(payload),
    });

    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.match(replies[0].content, /目前沒有正在播放的音樂/);
  });
});
