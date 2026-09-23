const { SlashCommandBuilder } = require('discord.js');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { formatQuotaForOwner, getGuildQuota } = require('../services/quotaService');

function getTargetGuildId(interaction) {
  return interaction.options.getString('guild-id') || interaction.guildId;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('quota')
    .setDescription('查看指定伺服器額度')
    .addStringOption((option) =>
      option.setName('guild-id').setDescription('Discord guild ID；未填則使用目前伺服器').setMinLength(17).setMaxLength(20)
    ),

  async execute(interaction) {
    if (!(await ensureBotOwner(interaction))) {
      return;
    }

    const guildId = getTargetGuildId(interaction);

    if (!guildId) {
      await interaction.reply({ content: '請提供 guild-id。', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `\`\`\`\n${formatQuotaForOwner(guildId, getGuildQuota(guildId))}\n\`\`\``,
      ephemeral: true,
    });
  },
};
