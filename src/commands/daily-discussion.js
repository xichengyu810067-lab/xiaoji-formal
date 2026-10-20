const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { corpusVersion } = require('../services/dailyDiscussionCorpus');
const {
  FEATURE_KEY,
  getDailyDiscussionEvent,
  processDailyDiscussionTick,
} = require('../services/dailyDiscussionService');
const { getGuildFeatureSetting, setGuildFeatureSetting } = require('../services/featurePlatformService');
const { formatDailyEventStatus } = require('../utils/dailyEventStatus');
const { getTaipeiDateKey } = require('../utils/taipeiClock');
const { ensureModerationAccess, handleCommandError, replyEphemeral } = require('../utils/moderation');

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

async function resolveConfiguredChannel(interaction, channelId) {
  return interaction.guild?.channels?.cache?.get(channelId) ||
    (await interaction.guild?.channels?.fetch?.(channelId)) ||
    null;
}

// "發布 0" is wrong when the schedule already posted today's topic (or is posting it right now), so ask the event.
async function describeRunNowResult(guildId, result) {
  const counts = `結算 ${result.settled}、延後 ${result.deferred}`;
  if (result.published === 0) {
    const event = await getDailyDiscussionEvent(guildId, result.localDate || getTaipeiDateKey());
    if (event?.status === 'published' || event?.status === 'published_late') {
      return `每日議題檢查完成：今日議題已發布（排程已先處理），本次${counts}。`;
    }
    if (event?.status === 'claimed' && result.skipped > 0) {
      return `每日議題檢查完成：今日議題正在發布中，請稍後用 \`/daily-discussion status\` 查看，本次${counts}。`;
    }
  }
  return `每日議題檢查完成：發布 ${result.published}、${counts}。`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('daily-discussion')
    .setDescription('管理小吉每日議題討論')
    // Hides the command from members without Administrator. The checks in execute stay the real guard.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('啟用每日議題並設定父頻道')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('發布議題的文字或公告頻道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('disable').setDescription('停用新的每日議題活動'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看每日議題設定與今天的狀態'))
    .addSubcommand((subcommand) => subcommand.setName('run-now').setDescription('依正常日界規則立即檢查發布或結算')),

  async execute(interaction) {
    try {
      if (!interaction.guildId || !interaction.guild || !interaction.inGuild()) {
        await replyEphemeral(interaction, '每日議題只能在伺服器內設定。');
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
        await replyEphemeral(interaction, `每日議題已啟用，將在台北時間每日 00:00 於 <#${channel.id}> 發布。`);
        return;
      }

      const access = await ensureGuildAccess(interaction);
      if (!access.ok) return;
      const setting = await getGuildFeatureSetting(interaction.guildId, FEATURE_KEY);
      if (action === 'disable') {
        await setGuildFeatureSetting(interaction.guildId, FEATURE_KEY, { enabled: false });
        await replyEphemeral(interaction, '每日議題已停用；已發布的活動仍會依規則完成結算。');
        return;
      }

      if (action === 'run-now') {
        if (!setting.enabled || !setting.channelId) {
          await replyEphemeral(interaction, '請先用 `/daily-discussion enable` 設定並啟用每日議題。');
          return;
        }
        const channel = await resolveConfiguredChannel(interaction, setting.channelId);
        if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
          await replyEphemeral(interaction, '目前設定的父頻道不存在或類型不支援，請重新設定。');
          return;
        }
        const channelAccess = await ensureGuildAccess(interaction, channel);
        if (!channelAccess.ok) return;
        const result = await processDailyDiscussionTick(interaction.client, {
          now: new Date(),
          guildId: interaction.guildId,
        });
        await replyEphemeral(interaction, await describeRunNowResult(interaction.guildId, result));
        return;
      }

      const event = await getDailyDiscussionEvent(interaction.guildId, getTaipeiDateKey());
      const channelLabel = setting.channelId ? `<#${setting.channelId}>` : '尚未設定';
      await replyEphemeral(
        interaction,
        `每日議題：${setting.enabled ? '已啟用' : '已停用'}\n父頻道：${channelLabel}\n今日活動：${formatDailyEventStatus(event?.status)}`
      );
    } catch (error) {
      await handleCommandError(interaction, error, '每日議題設定失敗，請稍後再試。');
    }
  },
};
