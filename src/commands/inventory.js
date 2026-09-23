const { SlashCommandBuilder } = require('discord.js');
const { getInventory } = require('../services/coinService');
const { replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder().setName('inventory').setDescription('查看自己的吉幣背包'),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '背包只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const items = await getInventory(interaction.guildId, interaction.user.id);

      if (items.length === 0) {
        await interaction.reply({ content: '你的背包目前是空的。', ephemeral: true });
        return;
      }

      const lines = items.map((item) => {
        const acquiredAt = Math.floor(new Date(item.acquiredAt).getTime() / 1000);
        return `#${item.itemId} **${item.itemName}** x${item.quantity}｜取得時間 <t:${acquiredAt}:R>`;
      });

      await interaction.reply({
        content: [`**${interaction.user.username} 的背包**`, ...lines].join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
