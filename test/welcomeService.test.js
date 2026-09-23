const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
  canSendWelcome,
  formatWelcomeMessage,
  handleGuildMemberWelcome,
} = require('../src/services/welcomeService');

function createPermissions(allowedPermissions) {
  const allowed = new Set(allowedPermissions);
  return {
    has: (permission) => allowed.has(permission),
  };
}

function createMember({
  channel = null,
  systemChannel = null,
  fallbackChannels = [],
  bot = false,
  allowedPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
} = {}) {
  const botMember = { id: 'bot-1' };
  const sent = [];
  const welcomeChannel =
    channel ||
    {
      id: 'welcome-1',
      type: ChannelType.GuildText,
      rawPosition: 10,
      isTextBased: () => true,
      permissionsFor: () => createPermissions(allowedPermissions),
      send: async (payload) => {
        sent.push(payload);
      },
    };

  return {
    member: {
      id: 'user-1',
      user: { bot },
      toString: () => '<@user-1>',
      guild: {
        id: 'guild-1',
        members: {
          me: botMember,
          fetchMe: async () => botMember,
        },
        channels: {
          cache: new Map([[welcomeChannel.id, welcomeChannel], ...fallbackChannels.map((item) => [item.id, item])]),
          fetch: async (channelId) => {
            if (channelId) return channelId === welcomeChannel.id ? welcomeChannel : null;
            return new Map([[welcomeChannel.id, welcomeChannel], ...fallbackChannels.map((item) => [item.id, item])]);
          },
        },
        systemChannel,
      },
    },
    sent,
    welcomeChannel,
    botMember,
  };
}

test('formatWelcomeMessage mentions the new member', () => {
  assert.equal(
    formatWelcomeMessage({ toString: () => '<@user-1>' }),
    '歡迎 <@user-1> 加入伺服器！小吉在這裡向你打招呼～'
  );
});

test('canSendWelcome requires text channel and send permissions', () => {
  const { welcomeChannel, botMember } = createMember();
  assert.equal(canSendWelcome(welcomeChannel, botMember), true);

  const missingSend = {
    ...welcomeChannel,
    permissionsFor: () => createPermissions([PermissionFlagsBits.ViewChannel]),
  };
  assert.equal(canSendWelcome(missingSend, botMember), false);
});

test('handleGuildMemberWelcome falls back to first sendable text channel without configuration', async () => {
  const { member, sent } = createMember();

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: null } });

  assert.equal(result, true);
  assert.equal(sent.length, 1);
});

test('handleGuildMemberWelcome sends configured welcome message', async () => {
  const { member, sent } = createMember();

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'welcome-1' } });

  assert.equal(result, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /歡迎 <@user-1> 加入伺服器/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['user-1'], roles: [], repliedUser: false });
});

function createTextChannel(id, { allowed = true, position = 0, failSend = false } = {}) {
  const sent = [];
  return {
    id,
    type: ChannelType.GuildText,
    rawPosition: position,
    isTextBased: () => true,
    permissionsFor: () =>
      createPermissions(
        allowed ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] : [PermissionFlagsBits.ViewChannel]
      ),
    send: async (payload) => {
      if (failSend) throw new Error('send failed');
      sent.push(payload);
    },
    sent,
  };
}

test('deleted configured channel falls back to guild system channel', async () => {
  const systemChannel = createTextChannel('system-1');
  const { member } = createMember({ systemChannel });

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'deleted-1' } });
  assert.equal(result, true);
  assert.equal(systemChannel.sent.length, 1);
});

test('missing permission and send failure fall through in deterministic channel order', async () => {
  const deniedSystem = createTextChannel('system-1', { allowed: false });
  const later = createTextChannel('later-1', { position: 20 });
  const first = createTextChannel('first-1', { position: 1 });
  const configured = createTextChannel('welcome-1', { failSend: true, position: 30 });
  const { member } = createMember({
    channel: configured,
    systemChannel: deniedSystem,
    fallbackChannels: [later, first],
  });

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'welcome-1' } });
  assert.equal(result, true);
  assert.equal(first.sent.length, 1);
  assert.equal(later.sent.length, 0);
});

test('restored configured channel remains the first choice after restart-style config load', async () => {
  const systemChannel = createTextChannel('system-1');
  const { member, sent } = createMember({ systemChannel });
  const restoredConfig = JSON.parse(JSON.stringify({ welcomeChannelId: 'welcome-1' }));

  const result = await handleGuildMemberWelcome(member, { config: restoredConfig });
  assert.equal(result, true);
  assert.equal(sent.length, 1);
  assert.equal(systemChannel.sent.length, 0);
});

test('welcome fails closed when no fallback channel has send permission', async () => {
  const denied = createTextChannel('denied-1', { allowed: false });
  const { member } = createMember({ channel: denied });

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'welcome-1' } });
  assert.equal(result, false);
  assert.equal(denied.sent.length, 0);
});

test('handleGuildMemberWelcome ignores bot members', async () => {
  const { member, sent } = createMember({ bot: true });

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'welcome-1' } });

  assert.equal(result, false);
  assert.equal(sent.length, 0);
});
