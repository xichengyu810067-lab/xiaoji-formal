const { SlashCommandBuilder } = require('discord.js');
const { getShopItem, purchaseItem } = require('../services/coinService');
const { formatCoins, formatShopItemLine, replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('buy')
    .setDescription('使用吉幣購買商店商品')
    .addStringOption((option) =>
      option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38)
    )
    .addIntegerOption((option) => option.setName('quantity').setDescription('購買數量').setMinValue(1).setMaxValue(99)),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '購買只能在伺服器內使用。', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const itemId = interaction.options.getString('item-id', true);
      const quantity = interaction.options.getInteger('quantity') || 1;
      const item = await getShopItem(interaction.guildId, itemId);

      if (!item) {
        await interaction.editReply('找不到這個商品，或商品目前不可購買。');
        return;
      }

      const purchase = await purchaseItem(interaction.guildId, interaction.user.id, itemId, quantity);

      await interaction.editReply(
        [
          `購買成功：${purchase.item.name} x${purchase.quantity}`,
          `花費：${formatCoins(purchase.totalPrice)}`,
          `最新餘額：${formatCoins(purchase.after)}`,
          '',
          formatShopItemLine(purchase.item),
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
