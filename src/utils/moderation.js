const { PermissionFlagsBits } = require('discord.js');
const logger = require('./logger');

const DISCORD_BULK_DELETE_TOO_OLD = 50034;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_UNKNOWN_BAN = 10026;

async function replyEphemeral(interaction, content) {
  const payload = typeof content === 'string' ? { content, ephemeral: true } : { ...content, ephemeral: true };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

async function fetchBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

function hasAllPermissions(permissions, requiredPermissions) {
  return requiredPermissions.every((permission) => permissions?.has(permission));
}

async function ensureModerationAccess(
  interaction,
  {
    userPermission = PermissionFlagsBits.Administrator,
    userPermissionName = 'Administrator',
    botPermissions = [],
    botPermissionNames = [],
    permissionChannel = null,
  }
) {
  if (!interaction.inGuild() || !interaction.guild) {
    await replyEphemeral(interaction, '這個指令只能在伺服器內使用。');
    return { ok: false };
  }

  const { isBotOwner } = require('./ownerOnly');
  const executorMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const memberPermissions = interaction.memberPermissions || executorMember?.permissions;
  const canUse = isBotOwner(interaction.user.id)
    || memberPermissions?.has(userPermission)
    || memberPermissions?.has(PermissionFlagsBits.Administrator);

  if (!canUse) {
    logger.warn(`[PERMISSION_BLOCK] User denied access to /${interaction.commandName}`);
    await replyEphemeral(interaction, `你需要 ${userPermissionName} 權限才能使用 /${interaction.commandName}。`);
    return { ok: false };
  }

  const botMember = await fetchBotMember(interaction.guild);
  const botPermissionSource = permissionChannel?.permissionsFor?.(botMember) || botMember.permissions;
  if (botPermissions.length > 0 && !hasAllPermissions(botPermissionSource, botPermissions)) {
    await replyEphemeral(interaction, `小吉需要 ${botPermissionNames.join(', ')} 權限才能執行 /${interaction.commandName}。`);
    return { ok: false };
  }
  return { ok: true, botMember, executorMember };
}

function getFriendlyDiscordError(error, fallbackMessage) {
  if (error?.code === DISCORD_MISSING_PERMISSIONS) return '小吉缺少執行此操作所需的 Discord 權限。';
  if (error?.code === DISCORD_BULK_DELETE_TOO_OLD) return 'Discord 不允許批次刪除超過 14 天前的訊息。';
  if (error?.code === DISCORD_UNKNOWN_BAN) return '找不到這個使用者的封鎖紀錄。';
  return fallbackMessage;
}

async function handleCommandError(interaction, error, fallbackMessage = '執行失敗，請稍後再試。') {
  logger.warn(`/${interaction.commandName} failed: ${error?.code || 'unknown'} ${error?.message || ''}`);
  await replyEphemeral(interaction, getFriendlyDiscordError(error, fallbackMessage));
}

module.exports = {
  DISCORD_BULK_DELETE_TOO_OLD,
  ensureModerationAccess,
  getFriendlyDiscordError,
  handleCommandError,
  replyEphemeral,
};
