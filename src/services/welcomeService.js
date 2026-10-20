const { ChannelType, PermissionFlagsBits, Routes } = require('discord.js');
const { getHostOperationContext } = require('../platform/hostOperationContext');
const { getGuildConfig, setGuildWelcomeChannel } = require('../utils/guildConfig');
const { resolveBotMember } = require('../utils/botMember');
const logger = require('../utils/logger');

// Members can join in a burst. The channels of a welcome come from the channel cache that the
// Guilds intent keeps in sync; Discord is asked only when that cache lacks what a welcome needs,
// and the joins that arrive while that one request is in flight wait for its answer instead of
// sending their own. After it ends, the same request waits out a cooldown: the guild's channel
// list one minute whatever its answer; a configured channel one minute when Discord says it is
// unknown, and a few seconds otherwise (an answer, a passing failure, or no answer in time). A
// join that finds the request on cooldown uses the cache as it is. A request that is not answered
// by its deadline ends as a passing failure, so no join waits on it longer than that.
const WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS = 60_000;
const WELCOME_CHANNEL_RETRY_COOLDOWN_MS = 5_000;
const WELCOME_CHANNEL_LOOKUP_DEADLINE_MS = 15_000;
// Discord's answer for a channel that does not exist.
const UNKNOWN_CHANNEL_CODE = 10003;

function isUnknownChannel(error) {
  return error?.status === 404 || error?.code === UNKNOWN_CHANNEL_CODE;
}

function createWelcomeChannelLookup({ now = () => performance.now(),
  deadlineMs = WELCOME_CHANNEL_LOOKUP_DEADLINE_MS } = {}) {
  const lookups = new Map();

  function sweep(at) {
    for (const [key, entry] of lookups) {
      if (!entry.pending && at >= entry.until) lookups.delete(key);
    }
  }

  function withDeadline(request) {
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Welcome channel lookup timed out'),
        { code: 'WELCOME_CHANNEL_LOOKUP_TIMEOUT' })), deadlineMs);
      timer.unref?.();
    });
    return Promise.race([new Promise((resolve) => resolve(request())), deadline])
      .finally(() => clearTimeout(timer));
  }

  // request() for this key, unless it is running (the call gets the same answer) or on cooldown
  // (the call gets { throttled: true, error }, with the error that started the cooldown, null
  // after an answer, and sends nothing). Never rejects: an answer is { value }, a failure or a
  // missed deadline { error }. cooldownFor(error) is the cooldown after it, from its end.
  function run(key, request, cooldownFor) {
    const current = lookups.get(key);
    if (current?.pending) return current.pending;
    const at = now();
    if (current && at < current.until) return Promise.resolve(Object.freeze({ throttled: true, error: current.error }));
    sweep(at);
    const entry = { pending: null, until: Infinity, error: null };
    lookups.set(key, entry);
    entry.pending = withDeadline(request)
      .then((value) => Object.freeze({ value }), (error) => Object.freeze({ error }))
      .then((outcome) => {
        entry.error = outcome.error ?? null;
        entry.until = now() + cooldownFor(entry.error);
        entry.pending = null;
        return outcome;
      });
    return entry.pending;
  }

  return Object.freeze({ run });
}

const channelListCooldown = () => WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS;
const configuredChannelCooldown = (error) => (isUnknownChannel(error)
  ? WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS : WELCOME_CHANNEL_RETRY_COOLDOWN_MS);

// One lookup per client (normally one per process), so its cooldowns follow that connection.
const channelLookups = new WeakMap();
const detachedChannelLookup = createWelcomeChannelLookup();

function channelLookupFor(client) {
  if (!client || typeof client !== 'object') return detachedChannelLookup;
  let lookup = channelLookups.get(client);
  if (!lookup) {
    lookup = createWelcomeChannelLookup();
    channelLookups.set(client, lookup);
  }
  return lookup;
}

function regularTextChannelsOf(channels) {
  return [...(channels?.values?.() || [])]
    .filter((channel) => channel?.type === ChannelType.GuildText)
    .sort((left, right) => (left.rawPosition ?? left.position ?? 0) - (right.rawPosition ?? right.position ?? 0));
}

// The configured channel from the cache. One the cache does not have is asked of Discord through
// the lookup; unknown is true only when Discord said the channel does not exist.
async function findConfiguredChannel(guild, channelId, lookup) {
  const cached = guild.channels.cache?.get?.(channelId);
  if (cached) return { channel: cached, unknown: false };
  const outcome = await lookup.run(`channel:${guild.id}:${channelId}`, () => guild.channels.fetch(channelId),
    configuredChannelCooldown);
  if (outcome.value) return { channel: outcome.value, unknown: false };
  return { channel: null, unknown: isUnknownChannel(outcome.error) };
}

// The regular text channels for the fallback, from the cache while it holds any; otherwise the
// guild's channel list is asked of Discord through the lookup (which also fills the cache).
async function regularTextChannelsFor(guild, lookup, testReporter) {
  const cached = regularTextChannelsOf(guild.channels.cache);
  if (cached.length) return cached;
  const outcome = await lookup.run(`channels:${guild.id}`, () => guild.channels.fetch(), channelListCooldown);
  if (outcome.error && !outcome.throttled && !testReporter) {
    logger.warn(`Welcome channel list fetch failed in guild ${guild.id}: ${outcome.error?.message || outcome.error}`);
  }
  return regularTextChannelsOf(outcome.value || guild.channels.cache);
}

// Stores the channel /set-welcome chose for a server and returns it as stored. An empty value
// clears the setting (null). The settings file itself stays behind utils/guildConfig.
function setWelcomeChannel(guildId, channelId) {
  return setGuildWelcomeChannel(guildId, channelId).welcomeChannelId;
}

function formatWelcomeMessage(member) {
  return `歡迎 ${member} 加入伺服器！小吉在這裡向你打招呼～`;
}

// A partial member of the bot (discord.js hands one over when the bot is not cached, as the client keeps
// GuildMember partials) has no roles, so it is fetched instead of used.
async function fetchBotMember(guild) {
  return resolveBotMember(guild);
}

function canSendWelcome(channel, botMember) {
  if (!channel?.id || !channel?.isTextBased?.()) {
    return false;
  }

  const permissions = channel.permissionsFor?.(botMember);

  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions?.has(PermissionFlagsBits.SendMessages)
  );
}

async function handleGuildMemberWelcome(member, options = {}) {
  if (!member?.guild || member.user?.bot) {
    return false;
  }

  const config = options.config || getGuildConfig(member.guild.id);
  const testReporter = member.client?.testControlPolicy?.reporter;
  const botMember = await fetchBotMember(member.guild).catch(() => null);
  if (!botMember) {
    if (testReporter) testReporter.deny('TEST_WELCOME_UNAVAILABLE', 'welcome');
    else logger.warn(`Welcome skipped in guild ${member.guild.id}: bot member unavailable`);
    return false;
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (channel, source) => {
    if (channel?.id && !seen.has(channel.id)) {
      seen.add(channel.id);
      candidates.push({ channel, source });
    }
  };

  const lookup = options.channelLookup || channelLookupFor(member.client);
  if (config.welcomeChannelId) {
    const { channel: configured, unknown } = await findConfiguredChannel(member.guild, config.welcomeChannelId, lookup);
    if (!configured) {
      if (testReporter) testReporter.deny('TEST_WELCOME_UNAVAILABLE', 'welcome');
      else if (unknown) logger.warn(`Welcome channel ${config.welcomeChannelId} no longer exists in guild ${member.guild.id}; using fallback`);
      else logger.warn(`Welcome channel ${config.welcomeChannelId} could not be looked up in guild ${member.guild.id}; using fallback`);
    }
    addCandidate(configured, 'configured');
  }

  addCandidate(member.guild.systemChannel, 'system');

  for (const channel of await regularTextChannelsFor(member.guild, lookup, testReporter)) {
    addCandidate(channel, 'first-text');
  }

  let selected = null;
  for (const { channel, source } of candidates) {
    if (!canSendWelcome(channel, botMember)) {
      if (testReporter) testReporter.deny('TEST_WELCOME_UNAVAILABLE', 'welcome');
      else logger.warn(`Welcome candidate ${channel.id} (${source}) lacks permissions in guild ${member.guild.id}`);
      continue;
    }
    selected = { channel, source };
    break;
  }

  if (!selected) {
    if (testReporter) testReporter.deny('TEST_WELCOME_UNAVAILABLE', 'welcome');
    else logger.warn(`Welcome skipped in guild ${member.guild.id}: no sendable text channel`);
    return false;
  }

  const runtime = options.runtime || member.client?.welcomeSideEffectRuntime;
  const context = (options.getContext || getHostOperationContext)();
  if (!runtime || !context || context.guildId !== member.guild.id || context.memberId !== member.id ||
      context.joinedTimestamp !== member.joinedTimestamp) {
    if (testReporter) testReporter.deny('TEST_WELCOME_UNAVAILABLE', 'welcome');
    else logger.warn(`Welcome skipped in guild ${member.guild.id}: trusted join context unavailable`);
    return false;
  }
  const body = Object.freeze({
    content: formatWelcomeMessage(member),
    allowed_mentions: Object.freeze({ parse: [], users: [member.id], roles: [], replied_user: false }),
  });
  const effect = Object.freeze({
    purposeId: 'welcome',
    action: 'welcome-message.create',
    target: selected.channel.id,
    method: 'POST',
    route: Routes.channelMessages(selected.channel.id),
    body,
  });
  const grant = options.issueGrant
    ? options.issueGrant(context.publicEffectEventGrant, effect)
    : runtime.issueGrant?.(context.publicEffectEventGrant, effect);
  if (!grant || !runtime.accept(grant, effect)) {
    if (testReporter) testReporter.deny('TEST_WELCOME_UNAVAILABLE', 'welcome');
    else logger.warn(`Welcome skipped in guild ${member.guild.id}: protected dispatch unavailable`);
    return false;
  }
  if (testReporter) logger.info('[TEST_CONTROL] code=TEST_WELCOME_QUEUED operation=welcome');
  else logger.info(`[Welcome] guild=${member.guild.id} channel=${selected.channel.id} source=${selected.source} queued=true`);
  return true;
}

module.exports = {
  WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS,
  WELCOME_CHANNEL_LOOKUP_DEADLINE_MS,
  WELCOME_CHANNEL_RETRY_COOLDOWN_MS,
  canSendWelcome,
  createWelcomeChannelLookup,
  formatWelcomeMessage,
  handleGuildMemberWelcome,
  setWelcomeChannel,
};
