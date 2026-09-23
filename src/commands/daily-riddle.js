const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isGuildApproved } = require('../services/auditService');
const { corpusVersion } = require('../services/dailyRiddleCorpus');
const { FEATURE_KEY, getDailyRiddleEvent } = require('../services/dailyRiddleService');
const { getGuildFeatureSetting, setGuildFeatureSetting } = require('../services/featurePlatformService');
const { getTaipeiDateKey } = require('../utils/taipeiClock');
const { ensureModerationAccess, handleCommandError, replyEphemeral } = require('../utils/moderation');
const { isBotOwner } = require('../utils/ownerOnly');

const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
];

const REQUIRED_BOT_PERMISSION_NAMES = [
  'View Channel',
  'Send Messages',
  'Create Public Threads',
  'Send Messages in Threads',
  'Read Message History',
];

async function ensureGuildAccess(interaction, permissionChannel = null) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
    botPermissions: permissionChannel ? REQUIRED_BOT_PERMISSIONS : [],
    botPermissionNames: permissionChannel ? REQUIRED_BOT_PERMISSION_NAMES : [],
    permissionChannel,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('daily-riddle')
    .setDescription('管理小吉每日猜謎')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('啟用每日猜謎並設定父頻道')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('發布題目的文字或公告頻道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('disable').setDescription('停用新的每日猜謎活動'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看每日猜謎設定與今天的狀態')),

  async execute(interaction) {
    try {
      if (!interaction.guildId || !interaction.guild || !interaction.inGuild()) {
        await replyEphemeral(interaction, '每日猜謎只能在伺服器內設定。');
        return;
      }
      if (!isBotOwner(interaction.user.id) && !isGuildApproved(interaction.guildId)) {
        await replyEphemeral(interaction, '此伺服器尚未通過小吉擁有者審核，暫時不能設定每日猜謎。');
        return;
      }

      const action = interaction.options.getSubcommand();
      if (action === 'enable') {
        const channel = interaction.options.getChannel('channel', true);
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
          await replyEphemeral(interaction, '請選擇伺服器文字頻道或公告頻道。');
          return;
        }
        const access = await ensureGuildAccess(interaction, channel);
        if (!access.ok) return;
        await setGuildFeatureSetting(interaction.guildId, FEATURE_KEY, {
          enabled: true,
          channelId: channel.id,
          config: { corpusVersion },
        });
        await replyEphemeral(
          interaction,
          `每日猜謎已啟用，將在台北時間 10:00 於 <#${channel.id}> 發布，21:30 公布答案並結算。`
        );
        return;
      }

      const access = await ensureGuildAccess(interaction);
      if (!access.ok) return;
      const setting = await getGuildFeatureSetting(interaction.guildId, FEATURE_KEY);
      if (action === 'disable') {
        await setGuildFeatureSetting(interaction.guildId, FEATURE_KEY, { enabled: false });
        await replyEphemeral(interaction, '每日猜謎已停用；已發布的活動仍會依規則完成結算。');
        return;
      }

      const event = await getDailyRiddleEvent(interaction.guildId, getTaipeiDateKey());
      const channelLabel = setting.channelId ? `<#${setting.channelId}>` : '尚未設定';
      await replyEphemeral(
        interaction,
        `每日猜謎：${setting.enabled ? '已啟用' : '已停用'}\n父頻道：${channelLabel}\n今日活動：${event?.status || '尚未建立'}`
      );
    } catch (error) {
      await handleCommandError(interaction, error, '每日猜謎設定失敗，請稍後再試。');
    }
  },
};
