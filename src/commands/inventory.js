const { SlashCommandBuilder } = require('discord.js');
const { getInventory } = require('../services/coinService');
const { replyCoinError } = require('../utils/coinPresentation');
const { clipText, fitListText, omittedLine } = require('../utils/replyLengthGuard');

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

      // The backpack holds every kind of item the member owns, so a long name or many items can pass one message:
      // names are shortened, and the last items are left out with a line that says how many.
      await interaction.reply({
        content: fitListText({
          header: `**${interaction.user.username} 的背包**`,
          items,
          render: (item, { textLimit }) => {
            const acquiredAt = Math.floor(new Date(item.acquiredAt).getTime() / 1000);
            return `#${item.itemId} **${clipText(item.itemName, textLimit)}** x${item.quantity}｜取得時間 <t:${acquiredAt}:R>`;
          },
          note: (count) => omittedLine(count, { unit: '種商品' }),
        }),
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
