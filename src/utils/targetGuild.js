// Which guild an owner command works in.
//
// The owner commands are deployed to the owner guild only (see deploy-commands.js), so the guild a command is
// run in is usually not the guild its data belongs to. Those commands take an optional guild-id option. Without
// it they use the guild they were run in; with it they use that guild, provided the bot is in it.
//
// The commands that write also have to know that the target belongs to the guild they write under, or running
// them in the owner guild would file another guild's player there. That is checkTargetMember.
//
// Whether the guild's coin system is on is the economy's business and is checked where the data is read or written.

const { RESTJSONErrorCodes } = require('discord.js');
const logger = require('./logger');

const GUILD_ID_OPTION = 'guild-id';
const GUILD_ID_MIN_LENGTH = 17;
const GUILD_ID_MAX_LENGTH = 20;
const GUILD_ID_PATTERN = /^\d{17,20}$/;

const INVALID_GUILD_ID_MESSAGE = `${GUILD_ID_OPTION} 格式不正確：必須是 ${GUILD_ID_MIN_LENGTH} 到 ${GUILD_ID_MAX_LENGTH} 位數字的伺服器 ID，沒有執行任何操作。`;

// Adds the optional guild-id string option to a command or subcommand builder. `description` must say what
// the guild is used for and that leaving it blank means the guild the command was run in.
function addGuildIdOption(builder, description) {
  return builder.addStringOption((option) =>
    option
      .setName(GUILD_ID_OPTION)
      .setDescription(description)
      .setMinLength(GUILD_ID_MIN_LENGTH)
      .setMaxLength(GUILD_ID_MAX_LENGTH)
  );
}

// Returns { ok: true, guildId, specified } or { ok: false, message }.
// - guild-id not given: the guild the command was run in (null outside a guild), specified: false.
// - guild-id given: it must be 17 to 20 digits and a guild the bot is in; specified: true. The bot's own guild
//   list is read from the client cache, so no Discord request is made.
// An invalid value is never echoed back; the message for a guild the bot is not in names the digits only.
function resolveTargetGuild(interaction) {
  const raw = interaction.options.getString(GUILD_ID_OPTION);

  if (raw === null || raw === undefined) {
    return { ok: true, guildId: interaction.guildId || null, specified: false };
  }

  const guildId = String(raw).trim();

  if (!GUILD_ID_PATTERN.test(guildId)) {
    return { ok: false, message: INVALID_GUILD_ID_MESSAGE };
  }

  if (!interaction.client?.guilds?.cache?.has(guildId)) {
    return { ok: false, message: `小吉不在伺服器 ${guildId}，沒有執行任何操作。` };
  }

  return { ok: true, guildId, specified: true };
}

// The guild object for an id: from the bot's own guild list, or, for the guild the command ran in, from the
// interaction.
function findGuild(interaction, guildId) {
  const known = interaction.client?.guilds?.cache?.get?.(guildId);

  if (known) {
    return known;
  }

  return interaction.guild?.id === guildId ? interaction.guild : null;
}

// A member counts only when it is that user, in that guild.
function isMemberOf(member, guildId, userId) {
  return Boolean(member) && member.id === userId && member.guild?.id === guildId;
}

function notAMemberMessage(guildId) {
  return `目標不在伺服器 ${guildId}，沒有執行任何操作；請用 guild-id 指定對方所在的伺服器。`;
}

// Whether the user is a member of the guild. Returns { ok: true } or { ok: false, message }.
// The members the bot already holds are looked at first. Only when the user is not among them is Discord asked,
// once and never again. Anything that is not a clear yes is a no, so a refusal never depends on Discord being
// reachable: a user Discord does not know in that guild, a request that failed, a guild the bot cannot reach,
// an answer about somebody else or about another guild.
async function checkTargetMember(interaction, guildId, userId) {
  const members = findGuild(interaction, guildId)?.members;

  if (members && userId) {
    if (isMemberOf(members.cache?.get?.(userId), guildId, userId)) {
      return { ok: true };
    }

    if (typeof members.fetch === 'function') {
      try {
        if (isMemberOf(await members.fetch(userId), guildId, userId)) {
          return { ok: true };
        }
      } catch (error) {
        // A user who is simply not in the guild is the expected answer and not worth a log line.
        if (error?.code !== RESTJSONErrorCodes.UnknownMember) {
          logger.warn(`Member lookup failed in guild ${guildId} for user ${userId}; treated as not a member: ${error?.message || error}`);
        }
      }
    }
  }

  return { ok: false, message: notAMemberMessage(guildId) };
}

module.exports = {
  GUILD_ID_MAX_LENGTH,
  GUILD_ID_MIN_LENGTH,
  GUILD_ID_OPTION,
  GUILD_ID_PATTERN,
  INVALID_GUILD_ID_MESSAGE,
  addGuildIdOption,
  checkTargetMember,
  notAMemberMessage,
  resolveTargetGuild,
};
