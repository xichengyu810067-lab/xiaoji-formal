const { SlashCommandBuilder } = require('discord.js');
const { setGuildQuota, formatQuotaForOwner } = require('../services/quotaService');
const { ensureBotOwner } = require('../utils/ownerOnly');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('quota-set')
    .setDescription('設定指定伺服器額度')
    .addStringOption((option) =>
      option
        .setName('guild-id')
        .setDescription('Discord guild ID')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20)
    )
    .addIntegerOption((option) =>
      option.setName('limit').setDescription('可用額度；0 代表暫停使用').setRequired(true).setMinValue(0)
    )
    .addIntegerOption((option) =>
      option.setName('used').setDescription('目前已使用額度；未填則保留原值').setMinValue(0)
    ),

  async execute(interaction) {
    if (!(await ensureBotOwner(interaction))) {
      return;
    }

    const guildId = interaction.options.getString('guild-id', true);
    const limit = interaction.options.getInteger('limit', true);
    const used = interaction.options.getInteger('used');
    const quota = setGuildQuota(guildId, limit, used);

    await interaction.reply({
      content: `額度已更新。\n\`\`\`\n${formatQuotaForOwner(guildId, quota)}\n\`\`\``,
      ephemeral: true,
    });
  },
};
