const { Events, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const { authorizeEvent } = require('../platform/testControlIngress');
const { SAFETY_EVENT_CODES, emitSafetyEvent } = require('../platform/safetyEventCatalog');
const { resolveBotMember } = require('../utils/botMember');

// A bot-add entry of the audit log names the one who invited the bot only when it is the entry of this
// very join. Discord writes it moments before it sends the guild, so a genuine one is seconds old; an
// older one belongs to an earlier add of the bot (a reconnect sends the guild again) and names nobody
// for this join.
const INVITER_ENTRY_MAX_AGE_MS = 2 * 60 * 1000;

// The ID of the member who added the bot, or null when it cannot be told. Never throws: the notice of
// a join does not wait for, and does not depend on, finding the inviter.
async function findInviterId(guild) {
  // The bot's whole member is needed for its permissions: a partial one (no roles) is fetched instead
  // of used.
  const botMember = await resolveBotMember(guild);
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog)) return null;
  try {
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd });
    const botAddLog = auditLogs?.entries?.first?.();
    if (!botAddLog || botAddLog.target?.id !== botMember.id) return null;
    const createdAt = Number(botAddLog.createdTimestamp);
    if (!Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > INVITER_ENTRY_MAX_AGE_MS) return null;
    const executorId = botAddLog.executor?.id;
    return typeof executorId === 'string' && executorId ? executorId : null;
  } catch (error) {
    logger.warn(`Failed to fetch audit logs for guild ${guild.id}: ${error?.message || error}`);
    return null;
  }
}

// What the notice says of the join. A value Discord did not give is left out, and the notice words it as
// unknown (safetyEventCatalog.js normalizes what is given).
function joinFacts(guild, inviterId) {
  const notice = {};
  if (Number.isSafeInteger(guild.memberCount) && guild.memberCount >= 0) notice.memberCount = guild.memberCount;
  if (Number.isSafeInteger(guild.joinedTimestamp) && guild.joinedTimestamp >= 0) notice.joinedAtMs = guild.joinedTimestamp;
  if (inviterId) notice.inviterId = inviterId;
  return notice;
}

// The bot joined a guild: the Owner is told once, by a notice of fixed text (ownerSafetyNotifier.js). No
// guild is held back, left or recorded for it.
module.exports = {
  name: Events.GuildCreate,

  async execute(guild) {
    if (!authorizeEvent(guild?.client, 'guildCreate', { guildId: guild?.id })) return;
    logger.info(`Joined new guild: ${guild.name} (${guild.id})`);

    let inviterId = null;
    try {
      inviterId = await findInviterId(guild);
    } catch (error) {
      logger.warn(`Failed to look for the inviter of guild ${guild.id}: ${error?.message || error}`);
    }

    try {
      emitSafetyEvent(SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED, {
        actorId: guild.client?.user?.id, guildId: guild.id, guildName: guild.name,
        notice: joinFacts(guild, inviterId),
      });
    } catch (error) {
      logger.warn(`Failed to report the join of guild ${guild.id}: ${error?.message || error}`);
    }
  },
};
