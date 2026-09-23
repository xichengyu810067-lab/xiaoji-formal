const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { setGuildWelcomeChannel } = require('../utils/guildConfig');
const {
  ensureModerationAccess,
  handleCommandError,
  replyEphemeral,
} = require('../utils/moderation');
const { getClientExtensionHost } = require('../extensions/extensionHost');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-welcome')
    .setDescription('設定新人歡迎頻道')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('要發送新人歡迎訊息的頻道')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild() || !interaction.guild) {
        await replyEphemeral(interaction, '這個設定只能在伺服器內使用。');
        return;
      }

      const selectedChannel = interaction.options.getChannel('channel', true);
      const channel = await interaction.guild.channels.fetch(selectedChannel.id).catch(() => null);

      if (!channel) {
        await replyEphemeral(interaction, '找不到這個頻道，請重新選擇。');
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageGuild,
        userPermissionName: 'Manage Server',
        botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        botPermissionNames: ['View Channel', 'Send Messages'],
        permissionChannel: channel,
      });

      if (!access.ok) {
        return;
      }

      if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
        await replyEphemeral(interaction, '請選擇小吉可以傳送訊息的文字頻道。');
        return;
      }

      setGuildWelcomeChannel(interaction.guildId, channel.id);
      await interaction.reply({ content: `新人歡迎頻道已設定為 ${channel}。`, ephemeral: true });
      await getClientExtensionHost(interaction.client).runHook('publicCommandCompleted', {
        interaction,
        action: '/set-welcome',
        target: `${channel} (${channel.id})`,
        reason: '設定新人歡迎頻道',
      });
    } catch (error) {
      await handleCommandError(interaction, error, '設定新人歡迎頻道失敗，請稍後再試。');
    }
  },
};
