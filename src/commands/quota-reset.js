const { SlashCommandBuilder } = require('discord.js');
const { formatQuotaForOwner, resetGuildQuota } = require('../services/quotaService');
const { ensureBotOwner } = require('../utils/ownerOnly');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('quota-reset')
    .setDescription('重設指定伺服器額度使用量')
    .addStringOption((option) =>
      option
        .setName('guild-id')
        .setDescription('Discord guild ID')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20)
    )
    .addBooleanOption((option) => option.setName('clear-limit').setDescription('是否移除這個伺服器的額度限制')),

  async execute(interaction) {
    if (!(await ensureBotOwner(interaction))) {
      return;
    }

    const guildId = interaction.options.getString('guild-id', true);
    const clearLimit = interaction.options.getBoolean('clear-limit') || false;
    const quota = resetGuildQuota(guildId, { clearLimit });

    await interaction.reply({
      content: clearLimit
        ? `已移除 ${guildId} 的額度限制。`
        : `額度使用量已重設。\n\`\`\`\n${formatQuotaForOwner(guildId, quota)}\n\`\`\``,
      ephemeral: true,
    });
  },
};
