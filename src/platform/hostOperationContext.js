'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const SNOWFLAKE = /^\d{17,20}$/u;
// Background job names are fixed code constants such as `work.payroll` or `poll.end`.
const BACKGROUND_JOB = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const MAX_BACKGROUND_JOB_LENGTH = 64;

function snowflake(value) {
  const normalized = String(value || '').trim();
  return SNOWFLAKE.test(normalized) ? normalized : null;
}

function captureDiscordEventContext(eventName, args = [], { publicEffectAuthority = null, now = Date.now } = {}) {
  const subject = args[0];
  if (!subject || typeof subject !== 'object') return null;

  if (eventName === 'messageCreate') {
    const sourceEventId = snowflake(subject.id);
    const actorId = snowflake(subject.author?.id);
    const channelId = snowflake(subject.channelId);
    const guildId = subject.guildId == null ? null : snowflake(subject.guildId);
    if (!sourceEventId || !actorId || !channelId || (subject.guildId != null && !guildId)) return null;
    const publicEffectEventGrant = publicEffectAuthority?.captureMessageCreate({
      botId: subject.client?.user?.id,
      guildId,
      channelId,
      messageId: sourceEventId,
      authorId: actorId,
      createdTimestamp: subject.createdTimestamp,
    }) || null;
    return Object.freeze({
      sourceEventId,
      actorId,
      channelId,
      guildId,
      hostPurpose: 'discord.message',
      scope: guildId ? `guild:${guildId}:channel:${channelId}` : `dm:channel:${channelId}`,
      ...(publicEffectEventGrant ? { publicEffectEventGrant } : {}),
    });
  }

  if (eventName === 'interactionCreate') {
    const sourceEventId = snowflake(subject.id);
    const actorId = snowflake(subject.user?.id);
    const channelId = snowflake(subject.channelId);
    const guildId = subject.guildId == null ? null : snowflake(subject.guildId);
    if (!sourceEventId || !actorId || !channelId || (subject.guildId != null && !guildId)) return null;
    return Object.freeze({
      sourceEventId,
      actorId,
      channelId,
      guildId,
      hostPurpose: 'discord.interaction',
      scope: guildId ? `guild:${guildId}:channel:${channelId}` : `dm:channel:${channelId}`,
    });
  }

  if (eventName === 'guildMemberAdd') {
    const eventGrant = publicEffectAuthority?.captureGuildMemberAdd({
      botId: subject.client?.user?.id,
      guildId: subject.guild?.id,
      memberId: subject.id,
      joinedTimestamp: subject.joinedTimestamp,
    });
    const captured = publicEffectAuthority?.inspectEvent(eventGrant);
    if (!captured) return null;
    return Object.freeze({
      sourceEventId: captured.sourceEventId,
      actorId: captured.memberId,
      guildId: captured.guildId,
      memberId: captured.memberId,
      joinedTimestamp: captured.joinedTimestamp,
      hostPurpose: captured.hostPurpose,
      scope: captured.scope,
      publicEffectEventGrant: eventGrant,
    });
  }

  if (eventName === 'guildCreate') {
    // The notice of a join (and nothing else here) needs only the guild and the bot, so a guild whose
    // join time Discord did not give still has a context. Its source event then carries the moment this
    // event was seen instead, as the leave of a member does.
    const guildId = snowflake(subject.id);
    const botId = snowflake(subject.client?.user?.id);
    if (!guildId || !botId) return null;
    const joinedTimestamp = Number(subject.joinedTimestamp ?? subject.joinedAt?.getTime?.());
    const joinKnown = Number.isSafeInteger(joinedTimestamp) && joinedTimestamp >= 0;
    let seenAtMs;
    try { seenAtMs = now(); } catch { seenAtMs = Number.NaN; }
    if (!joinKnown && !(Number.isSafeInteger(seenAtMs) && seenAtMs >= 0)) return null;
    const trustedGuildJoinGrant = joinKnown ? publicEffectAuthority?.captureGuildJoin({
      sourceNamespace: 'discord.guildCreate', botId, guildId, joinedTimestamp,
    }) || null : null;
    return Object.freeze({
      sourceEventId: `${guildId}.${joinKnown ? joinedTimestamp : seenAtMs}`,
      guildId,
      actorId: botId,
      hostPurpose: 'discord.guildCreate',
      scope: `guild:${guildId}`,
      ...(trustedGuildJoinGrant ? { trustedGuildJoinGrant } : {}),
    });
  }

  if (eventName === 'guildMemberRemove') {
    // The member may be partial (the client keeps GuildMember partials so that a member that was not
    // cached still arrives), which is why nothing but the IDs is read. The event has no ID of its own
    // that is a snowflake, so the source event is the guild, the member and the moment of the leave:
    // one source event per leave, never shared by two leaves of the same member. The actor is the bot,
    // as for guildCreate: the member who left is the subject, not the one who acts, and a source key
    // per member would leave one watermark row behind for every member who ever left.
    const guildId = snowflake(subject.guild?.id);
    const memberId = snowflake(subject.id ?? subject.user?.id);
    const botId = snowflake(subject.client?.user?.id);
    let leftAtMs;
    try { leftAtMs = now(); } catch { leftAtMs = Number.NaN; }
    if (!guildId || !memberId || !botId || !Number.isSafeInteger(leftAtMs) || leftAtMs < 0) return null;
    return Object.freeze({
      sourceEventId: `${guildId}.${memberId}.${leftAtMs}`,
      guildId,
      actorId: botId,
      hostPurpose: 'discord.guildMemberRemove',
      scope: `guild:${guildId}`,
    });
  }

  if (eventName === 'clientReady') {
    const botId = snowflake(subject.user?.id);
    if (!botId || !subject.guilds?.cache?.values) return null;
    return Object.freeze({
      sourceEventId: botId,
      actorId: botId,
      hostPurpose: 'discord.ready',
      scope: `bot:${botId}`,
    });
  }

  return null;
}

function runWithHostOperationContext(context, operation) {
  if (typeof operation !== 'function') throw new TypeError('Host operation callback is required.');
  return storage.run(context || null, operation);
}

function createBackgroundContext(job) {
  if (typeof job !== 'string' || job.length > MAX_BACKGROUND_JOB_LENGTH || !BACKGROUND_JOB.test(job)) {
    throw new TypeError('Background job name is invalid.');
  }
  // Read once when the run starts, so every later reader of this run (for example the
  // source time of an owner notice) sees the same value.
  const startedAtMs = Date.now();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    throw new TypeError('Background job start time is invalid.');
  }
  return Object.freeze({
    sourceEventId: crypto.randomUUID(),
    hostPurpose: `background.${job}`,
    scope: `background:${job}`,
    startedAtMs,
  });
}

// Runs one execution of a scheduled or deferred job in its own context: a fresh
// sourceEventId for every run, hostPurpose `background.<job>`, the run's start time in
// startedAtMs, and no Discord actor or grant of any kind. Wrap the timer callback
// itself, not the code that creates the timer, so two runs of the same job never share
// a sourceEventId. A timer created inside an event handler (ready included) inherits
// that event's context unless its callback is wrapped like this or the timer is created
// in an empty context.
function runWithBackgroundContext(job, fn) {
  if (typeof fn !== 'function') throw new TypeError('Background job callback is required.');
  return storage.run(createBackgroundContext(job), fn);
}

function getHostOperationContext() {
  const context = storage.getStore();
  return context ? Object.freeze({ ...context }) : null;
}

module.exports = {
  captureDiscordEventContext,
  getHostOperationContext,
  runWithBackgroundContext,
  runWithHostOperationContext,
};
