const { SlashCommandBuilder } = require('discord.js');
const {
  getLuxuryInventory,
  getLuxuryPurchaseHistory,
  listLuxuryItems,
  purchaseLuxuryItem,
} = require('../services/luxuryService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

function formatStock(stock) {
  return stock === null || stock === undefined ? '不限' : String(stock);
}

function formatLimit(limit) {
  return limit === null || limit === undefined ? '不限' : String(limit);
}

function formatLuxuryItemLine(item) {
  const enabled = item.enabled ? '' : '（已下架）';
  return [
    `#${item.id} **${item.name}**${enabled}`,
    `${formatCoins(item.price)}｜庫存 ${formatStock(item.stock)}｜購買上限 ${formatLimit(item.purchaseLimit)}`,
    item.description || '沒有描述',
  ].join('\n');
}

function formatInventoryLine(item) {
  return `#${item.itemId} **${item.itemName}** x${item.quantity}`;
}

function formatPurchaseLine(purchase) {
  const timestamp = Math.floor(new Date(purchase.createdAt).getTime() / 1000);
  return `#${purchase.id} ${purchase.itemName} x${purchase.quantity}｜單價 ${formatCoins(purchase.unitPrice)}｜總價 ${formatCoins(purchase.totalPrice)}｜<t:${timestamp}:R>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('luxury')
    .setDescription('奢侈品商店街')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('查看奢侈品商店街商品')
        .addIntegerOption((option) => option.setName('page').setDescription('頁數').setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('buy')
        .setDescription('使用吉幣購買奢侈品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
        .addIntegerOption((option) => option.setName('quantity').setDescription('購買數量').setMinValue(1).setMaxValue(99))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('inventory')
        .setDescription('查看自己的奢侈品庫存')
        .addIntegerOption((option) => option.setName('page').setDescription('頁數').setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的奢侈品購買紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '奢侈品商店街只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'list') {
        const result = await listLuxuryItems(interaction.guildId, {
          page: interaction.options.getInteger('page') || 1,
        });
        await interaction.reply({
          content: result.items.length
            ? [`**奢侈品商店街｜第 ${result.page} 頁**`, ...result.items.map(formatLuxuryItemLine)].join('\n\n')
            : '目前沒有上架中的奢侈品。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'buy') {
        const result = await purchaseLuxuryItem(
          interaction.guildId,
          interaction.user.id,
          interaction.options.getString('item-id', true),
          interaction.options.getInteger('quantity') || 1
        );
        await interaction.reply({
          content: [
            '**奢侈品商店街｜購買完成**',
            `商品：${result.item.name} x${result.quantity}`,
            `總價：${formatCoins(result.totalPrice)}`,
            `吉幣餘額：${formatCoins(result.after)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'inventory') {
        const result = await getLuxuryInventory(interaction.guildId, interaction.user.id, {
          page: interaction.options.getInteger('page') || 1,
        });
        await interaction.reply({
          content: result.items.length
            ? [`**${interaction.user.username} 的奢侈品庫存｜第 ${result.page} 頁**`, ...result.items.map(formatInventoryLine)].join('\n')
            : '你目前沒有奢侈品庫存。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const purchases = await getLuxuryPurchaseHistory(interaction.guildId, interaction.user.id, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: purchases.length ? ['**奢侈品商店街｜購買紀錄**', ...purchases.map(formatPurchaseLine)].join('\n') : '目前沒有奢侈品購買紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '奢侈品商店街剛剛執行失敗了，請稍後再試。');
    }
  },
};
