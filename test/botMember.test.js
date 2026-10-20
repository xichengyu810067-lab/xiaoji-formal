'use strict';

// The bot's own member of a guild (src/utils/botMember.js). The client keeps GuildMember partials, and
// with that setting discord.js answers `guild.members.me` with a partial member (no roles) when the bot is
// not cached, instead of null. Everything that needs the bot's permissions takes the member from here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Client, ClientUser, GatewayIntentBits, PermissionFlagsBits, Partials } = require('discord.js');
const { cachedBotMember, resolveBotMember } = require('../src/utils/botMember');
const { ensureModerationAccess } = require('../src/utils/moderation');
const { selectReleaseChannel } = require('../src/services/releaseAnnouncementService');
const { hasReactionPermission } = require('../src/services/chainReactionDelivery');
const { validateDelivery } = require('../src/systems/schedule/delivery/reminderDelivery');
const logger = require('../src/utils/logger');

const BOT_ID = '10000000000000501';
const OWNER_ID = '10000000000000502';
const GUILD_ID = '10000000000000503';
const CHANNEL_ID = '10000000000000504';
const USER_ID = '10000000000000505';
const INVITER_ID = '10000000000000506';

const WHOLE = Object.freeze({ id: BOT_ID, partial: false, tag: 'whole' });
const PARTIAL = Object.freeze({ id: BOT_ID, partial: true, tag: 'partial' });

// A guild whose bot member in the cache is `me`, and whose fetchMe answers `fetched`.
function guildWith({ me = null, fetched = WHOLE, failFetch = false } = {}) {
  const calls = { fetchMe: 0 };
  return {
    calls,
    guild: {
      id: GUILD_ID,
      members: {
        me,
        async fetchMe() {
          calls.fetchMe += 1;
          if (failFetch) throw new Error('synthetic failure');
          return fetched;
        },
      },
    },
  };
}

// A channel that grants what it is asked for only to the members whose tag is `allowedTag` (or one of
// them, for a list), and writes down whom it was asked about.
function channelFor(allowedTag, extra = {}) {
  const allowed = Array.isArray(allowedTag) ? allowedTag : [allowedTag];
  const asked = [];
  return {
    asked,
    channel: {
      id: CHANNEL_ID,
      guildId: GUILD_ID,
      type: ChannelType.GuildText,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor(member) {
        asked.push(member?.tag ?? member);
        const granted = allowed.includes(member?.tag);
        return { has: () => granted };
      },
      ...extra,
    },
  };
}

test('resolveBotMember: none in the cache is fetched, a partial one is fetched, a whole one is used as it is', async () => {
  const none = guildWith({ me: null });
  assert.equal(await resolveBotMember(none.guild), WHOLE);
  assert.equal(none.calls.fetchMe, 1);

  const partial = guildWith({ me: PARTIAL });
  assert.equal(await resolveBotMember(partial.guild), WHOLE);
  assert.equal(partial.calls.fetchMe, 1);

  const whole = guildWith({ me: WHOLE, fetched: { id: BOT_ID, tag: 'other' } });
  assert.equal(await resolveBotMember(whole.guild), WHOLE);
  assert.equal(whole.calls.fetchMe, 0, 'a whole member in the cache is not fetched again');
});

test('resolveBotMember: what cannot be had is null, and it never throws', async () => {
  assert.equal(await resolveBotMember(guildWith({ me: null, failFetch: true }).guild), null);
  assert.equal(await resolveBotMember(guildWith({ me: PARTIAL, failFetch: true }).guild), null);
  // A fetch that answers with a partial member is no answer either.
  assert.equal(await resolveBotMember(guildWith({ me: null, fetched: PARTIAL }).guild), null);
  assert.equal(await resolveBotMember(guildWith({ me: null, fetched: null }).guild), null);
  assert.equal(await resolveBotMember({ members: { me: null } }), null);
  assert.equal(await resolveBotMember({ id: GUILD_ID }), null);
  assert.equal(await resolveBotMember(null), null);
  const hostile = { get members() { throw new Error('synthetic getter'); } };
  assert.equal(await resolveBotMember(hostile), null);
  assert.equal(cachedBotMember(hostile), null);
});

test('cachedBotMember: only a whole member counts, and nothing is fetched', () => {
  const partial = guildWith({ me: PARTIAL });
  assert.equal(cachedBotMember(partial.guild), null);
  assert.equal(cachedBotMember(guildWith({ me: WHOLE }).guild), WHOLE);
  assert.equal(cachedBotMember(guildWith({ me: null }).guild), null);
  assert.equal(partial.calls.fetchMe, 0);
});

test('discord.js hands over a partial member for the bot when it is not cached and the client keeps partials', async () => {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], rest: { retries: 0 },
    partials: [Partials.GuildMember],
  });
  try {
    client.user = new ClientUser(client, { id: BOT_ID, username: 'xiaoji', discriminator: '0', bot: true });
    const guild = client.guilds._add({
      id: GUILD_ID, name: 'Synthetic guild', owner_id: OWNER_ID, member_count: 2,
      roles: [{ id: GUILD_ID, name: '@everyone', position: 0, permissions: '0' }], channels: [], members: [],
    });
    // The reason for this module: `me` is not null, and it is not a member with roles.
    assert.equal(guild.members.me.partial, true);
    assert.equal(cachedBotMember(guild), null);
    let fetched = 0;
    guild.members.fetchMe = async () => {
      fetched += 1;
      return { id: BOT_ID, partial: false, tag: 'fetched' };
    };
    assert.equal((await resolveBotMember(guild)).tag, 'fetched');
    assert.equal(fetched, 1);
  } finally {
    await client.destroy();
  }
});

// ---- the places that need the bot's permissions: a partial member is fetched, never used ----------

test('a moderation command gets the fetched bot member when the cached one is partial', async () => {
  const { guild, calls } = guildWith({ me: PARTIAL });
  const sent = [];
  const interaction = {
    commandName: 'synthetic',
    inGuild: () => true,
    guild: { ...guild, members: { ...guild.members, fetch: async () => null } },
    user: { id: USER_ID },
    memberPermissions: { has: () => true },
    replied: false,
    deferred: false,
    reply: async (payload) => { sent.push(payload); },
  };
  interaction.guild.members.fetchMe = guild.members.fetchMe;
  const answer = await ensureModerationAccess(interaction, { botPermissions: [] });
  assert.equal(answer.ok, true);
  assert.equal(answer.botMember, WHOLE);
  assert.equal(calls.fetchMe, 1);
  assert.deepEqual(sent, []);

  // A bot member that cannot be had stops the command the way a failed fetch always did.
  const failing = guildWith({ me: PARTIAL, failFetch: true });
  const broken = { ...interaction, guild: { ...failing.guild, members: { ...failing.guild.members, fetch: async () => null } } };
  broken.guild.members.fetchMe = failing.guild.members.fetchMe;
  await assert.rejects(ensureModerationAccess(broken, { botPermissions: [] }), /unavailable/u);
});

test('a reminder is checked with the fetched bot member when the cached one is partial', async () => {
  const { guild, calls } = guildWith({ me: PARTIAL });
  const { channel, asked } = channelFor('whole', { send() {} });
  const userMember = { id: USER_ID, tag: 'user' };
  guild.members.fetch = async () => ({ ...userMember, tag: 'whole' });
  const client = {
    user: { id: BOT_ID, tag: 'client-user' },
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => channel },
  };
  const reminder = { deliveryGuildId: GUILD_ID, userId: USER_ID, deliveryChannelId: CHANNEL_ID };
  assert.equal(await validateDelivery(client, reminder), channel);
  assert.equal(calls.fetchMe, 1);
  // The user's permissions, then the bot's: both through whole members.
  assert.deepEqual(asked, ['whole', 'whole']);

  // The bot member cannot be had: the bot's own user is asked about, as it always was.
  const failing = guildWith({ me: PARTIAL, failFetch: true });
  failing.guild.members.fetch = guild.members.fetch;
  const second = channelFor(['whole', 'client-user'], { send() {} });
  const clientTwo = { ...client, guilds: { fetch: async () => failing.guild }, channels: { fetch: async () => second.channel } };
  assert.equal(await validateDelivery(clientTwo, reminder), second.channel);
  assert.deepEqual(second.asked, ['whole', 'client-user']);
  // And a partial member is never the one asked, even though it is in the cache.
  assert.equal(second.asked.includes('partial'), false);
});

test('a release announcement fetches the bot member when the cached one is partial, and sends nothing without one', async () => {
  const setting = { persisted: true, enabled: true, channelId: CHANNEL_ID };
  const { guild, calls } = guildWith({ me: PARTIAL });
  const { channel, asked } = channelFor('whole');
  channel.type = ChannelType.GuildText;
  guild.channels = { cache: new Map([[CHANNEL_ID, channel]]) };
  assert.equal(await selectReleaseChannel(guild, { setting }), channel);
  assert.equal(calls.fetchMe, 1);
  assert.deepEqual(asked, ['whole']);

  const whole = guildWith({ me: WHOLE });
  whole.guild.channels = guild.channels;
  const wholeChannel = channelFor('whole');
  whole.guild.channels = { cache: new Map([[CHANNEL_ID, wholeChannel.channel]]) };
  assert.equal(await selectReleaseChannel(whole.guild, { setting }), wholeChannel.channel);
  assert.equal(whole.calls.fetchMe, 0);

  const failing = guildWith({ me: PARTIAL, failFetch: true });
  failing.guild.channels = guild.channels;
  assert.equal(await selectReleaseChannel(failing.guild, { setting }), null);
});

test('a chain reaction is not added with a partial bot member, which has no roles', () => {
  const { channel, asked } = channelFor('whole');
  const source = { guildId: GUILD_ID, channelId: CHANNEL_ID };
  const clientWith = (me) => {
    const { guild } = guildWith({ me });
    guild.channels = { cache: new Map([[CHANNEL_ID, channel]]) };
    return { guilds: { cache: new Map([[GUILD_ID, guild]]) } };
  };
  assert.equal(hasReactionPermission(clientWith(WHOLE), source), true);
  assert.equal(hasReactionPermission(clientWith(PARTIAL), source), false);
  assert.equal(hasReactionPermission(clientWith(null), source), false);
  // The partial member was never asked about the channel.
  assert.deepEqual(asked, ['whole']);
});

test('joining a guild looks for the inviter with the fetched bot member when the cached one is partial', async () => {
  const { SAFETY_EVENT_CODES, setSafetyEventHandler } = require('../src/platform/safetyEventCatalog');
  const event = require('../src/events/guildCreate');
  const joined = [];
  const restoreHandler = setSafetyEventHandler((reported) => { joined.push(reported); });
  const original = { info: logger.info, warn: logger.warn };
  logger.info = () => {};
  logger.warn = () => {};
  try {
    const fetchedMember = {
      id: BOT_ID, partial: false, permissions: { has: (flag) => flag === PermissionFlagsBits.ViewAuditLog },
    };
    const partialMember = { id: BOT_ID, partial: true, permissions: { has: () => false } };
    const audit = {
      entries: {
        first: () => ({ target: { id: BOT_ID }, executor: { id: INVITER_ID }, createdTimestamp: Date.now() - 5_000 }),
      },
    };
    const guild = {
      id: GUILD_ID,
      name: 'Synthetic guild',
      client: { user: { id: BOT_ID } },
      members: { me: partialMember, fetchMe: async () => fetchedMember },
      fetchAuditLogs: async () => audit,
    };
    await event.execute(guild);
    assert.equal(joined.length, 1);
    assert.equal(joined[0].code, SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED);
    assert.equal(joined[0].notice.inviterId, INVITER_ID);

    // With no bot member at all the join is still told, without an inviter (it used to throw).
    joined.length = 0;
    await event.execute({ ...guild, members: { me: null, fetchMe: async () => { throw new Error('synthetic'); } } });
    assert.equal(joined.length, 1);
    assert.equal(joined[0].notice.inviterId, null);
  } finally {
    restoreHandler();
    Object.assign(logger, original);
  }
});
