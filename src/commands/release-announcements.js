const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { FEATURE_KEY, selectReleaseChannel } = require('../services/releaseAnnouncementService');
const { getGuildFeatureSetting, setGuildFeatureSetting } = require('../services/featurePlatformService');
const { isGuildApproved } = require('../services/auditService');
const { ensureModerationAccess, handleCommandError, replyEphemeral } = require('../utils/moderation');

const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

function channelLabel(channel) {
  const safeName = String(channel?.name || '指定頻道')
    .replace(/\d{17,20}/g, '已隱藏')
    .slice(0, 100);
  return `#${safeName}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('release-announcements')
    .setDescription('設定小吉正式 GitHub Release 公告頻道')
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName('set')
      .setDescription('明確指定正式版本公告頻道')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('伺服器文字或公告頻道')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看正式版本公告頻道設定')),

  async execute(interaction) {
    try {
      if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) {
        await replyEphemeral(interaction, '正式版本公告只能在伺服器內設定。');
        return;
      }
      if (!isGuildApproved(interaction.guildId)) {
        await replyEphemeral(interaction, '此伺服器尚未通過使用審核。');
        return;
      }
      const action = interaction.options.getSubcommand();
      if (action === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        if (channel.guildId !== interaction.guildId || channel.isThread?.() ||
            ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
          await replyEphemeral(interaction, '請選擇目前伺服器的文字頻道或公告頻道。');
          return;
        }
        const access = await ensureModerationAccess(interaction, {
          userPermission: PermissionFlagsBits.Administrator,
          userPermissionName: 'Administrator',
          botPermissions: REQUIRED_BOT_PERMISSIONS,
          botPermissionNames: ['View Channel', 'Send Messages', 'Embed Links'],
          permissionChannel: channel,
        });
        if (!access.ok) return;
        const channelPermissions = channel.permissionsFor?.(access.botMember);
        if (!REQUIRED_BOT_PERMISSIONS.every((permission) => channelPermissions?.has?.(permission))) {
          await replyEphemeral(interaction, '小吉在指定頻道缺少檢視、發送訊息或嵌入連結權限。');
          return;
        }
        await setGuildFeatureSetting(interaction.guildId, FEATURE_KEY, { enabled: true, channelId: channel.id });
        await replyEphemeral(interaction, `小吉已將正式 GitHub Release 公告發布頻道設為 ${channelLabel(channel)}。`);
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.Administrator,
        userPermissionName: 'Administrator',
      });
      if (!access.ok) return;
      const setting = await getGuildFeatureSetting(interaction.guildId, FEATURE_KEY);
      const channel = await selectReleaseChannel(interaction.guild, { setting });
      await replyEphemeral(interaction,
        setting.persisted && setting.enabled && channel
          ? `正式 GitHub Release 公告已明確啟用。\n發布頻道：${channelLabel(channel)}`
          : setting.persisted && setting.enabled
            ? '原本設定的公告頻道目前無法使用；請手動重新指定頻道。'
            : '正式 GitHub Release 公告尚未啟用；請先明確設定發布頻道。');
    } catch (error) {
      await handleCommandError(interaction, error, '正式版本公告設定失敗，請稍後再試。');
    }
  },
};
