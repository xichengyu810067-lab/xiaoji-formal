const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isGuildApproved } = require('../services/auditService');
const { getWordChainStatus, startWordChain, stopWordChain, validateWord } = require('../services/wordChainService');
const { isBotOwner } = require('../utils/ownerOnly');
const { ensureModerationAccess, handleCommandError, replyEphemeral } = require('../utils/moderation');

function getTargetChannel(interaction) {
  return interaction.options.getChannel('channel') || interaction.channel;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('word-chain')
    .setDescription('管理小吉文字接龍')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('在指定頻道開始文字接龍')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('接龍頻道，預設為目前頻道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addStringOption((option) => option.setName('seed').setDescription('起始詞，可省略').setMaxLength(6))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('stop')
        .setDescription('停止指定頻道的文字接龍')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('接龍頻道，預設為目前頻道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('查看指定頻道的文字接龍狀態')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('接龍頻道，預設為目前頻道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    ),

  async execute(interaction) {
    try {
      if (!interaction.guildId || !interaction.guild || !interaction.inGuild()) {
        await replyEphemeral(interaction, '文字接龍只能在伺服器內管理。');
        return;
      }
      if (!isBotOwner(interaction.user.id) && !isGuildApproved(interaction.guildId)) {
        await replyEphemeral(interaction, '此伺服器尚未通過小吉擁有者審核，暫時不能管理文字接龍。');
        return;
      }
      const channel = getTargetChannel(interaction);
      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        await replyEphemeral(interaction, '請選擇小吉可以傳送訊息的伺服器文字頻道。');
        return;
      }
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageGuild,
        userPermissionName: 'Manage Server',
        botPermissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        botPermissionNames: ['View Channel', 'Send Messages', 'Add Reactions', 'Read Message History'],
        permissionChannel: channel,
      });
      if (!access.ok) return;

      const action = interaction.options.getSubcommand();
      if (action === 'status') {
        const session = await getWordChainStatus(interaction.guildId, channel.id);
        await replyEphemeral(
          interaction,
          session
            ? `文字接龍進行中：目前詞為「${session.currentWord}」，已接 ${session.revision} 次。`
            : '這個頻道目前沒有進行中的文字接龍。'
        );
        return;
      }
      if (action === 'start') {
        const seed = interaction.options.getString('seed');
        if (seed && !validateWord(seed).ok) {
          await replyEphemeral(interaction, validateWord(seed).message);
          return;
        }
        const result = await startWordChain({ guildId: interaction.guildId, channelId: channel.id, actorId: interaction.user.id, seed: seed || undefined });
        await interaction.reply({
          content: result.alreadyActive
            ? `這個頻道的文字接龍已在進行中，目前詞為「${result.session.currentWord}」。`
            : `文字接龍開始！起始詞是「${result.session.currentWord}」，請從「${result.session.currentWord.at(-1)}」字接詞。`,
          ephemeral: true,
        });
        return;
      }

      const result = await stopWordChain({ guildId: interaction.guildId, channelId: channel.id, actorId: interaction.user.id });
      await replyEphemeral(interaction, result.stopped ? '這個頻道的文字接龍已停止。' : '這個頻道目前沒有進行中的文字接龍。');
    } catch (error) {
      if (error?.code === 'CHAIN_CHANNEL_CONFLICT') {
        await replyEphemeral(interaction, '這個頻道已有進行中的數字接龍，請先停止它再開始文字接龍。');
        return;
      }
      await handleCommandError(interaction, error, '文字接龍設定失敗，請稍後再試。');
    }
  },
};
