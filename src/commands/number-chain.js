const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  describeNumberChainStatus,
  getNumberChainStatus,
  stopNumberChain,
} = require('../services/numberChainService');
const {
  ensureNumberChainAccess,
  replyNumberChainFailure,
  startNumberChainInChannel,
} = require('../systems/community/discord/numberChainLaunch');
const { replyEphemeral } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('number-chain')
    .setDescription('管理小吉安全數字接龍')
    // Hides the command from members without Manage Server. The check in execute stays the real guard.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // default_member_permissions does not apply in DMs, so a command that is only for servers is kept out of them.
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('stop')
        .setDescription('停止指定頻道的數字接龍')
        .addChannelOption((option) => option.setName('channel').setDescription('接龍頻道，預設為目前頻道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('查看指定頻道的數字接龍狀態')
        .addChannelOption((option) => option.setName('channel').setDescription('接龍頻道，預設為目前頻道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    ),

  async execute(interaction) {
    try {
      const access = await ensureNumberChainAccess(interaction);
      if (!access.ok) return;
      const { channel } = access;

      const action = interaction.options.getSubcommand();
      if (action === 'status') {
        const session = await getNumberChainStatus(interaction.guildId, channel.id);
        await replyEphemeral(
          interaction,
          session
            ? { content: describeNumberChainStatus(session), allowedMentions: { parse: [] } }
            : '這個頻道目前沒有進行中的數字接龍。'
        );
        return;
      }
      if (action === 'start') {
        await startNumberChainInChannel(interaction, access);
        return;
      }

      const result = await stopNumberChain({ guildId: interaction.guildId, channelId: channel.id, actorId: interaction.user.id });
      await replyEphemeral(interaction, result.stopped ? '這個頻道的數字接龍已停止。' : '這個頻道目前沒有進行中的數字接龍。');
    } catch (error) {
      await replyNumberChainFailure(interaction, error);
    }
  },
};
