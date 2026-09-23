const { SlashCommandBuilder } = require('discord.js');
const { listGuildQuotas } = require('../services/quotaService');
const { ensureBotOwner } = require('../utils/ownerOnly');

function formatQuotaList(quotas) {
  if (quotas.length === 0) {
    return '目前沒有設定任何伺服器額度。';
  }

  return quotas
    .map((quota) => {
      const limit = quota.limit === null ? 'unlimited' : quota.limit;
      return `${quota.guildId}: used=${quota.used}, limit=${limit}`;
    })
    .join('\n')
    .slice(0, 1900);
}

module.exports = {
  data: new SlashCommandBuilder().setName('quota-list').setDescription('列出所有伺服器額度'),

  async execute(interaction) {
    if (!(await ensureBotOwner(interaction))) {
      return;
    }

    await interaction.reply({
      content: `\`\`\`\n${formatQuotaList(listGuildQuotas())}\n\`\`\``,
      ephemeral: true,
    });
  },
};

module.exports.formatQuotaList = formatQuotaList;
