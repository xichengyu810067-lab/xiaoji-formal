const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  getAllPurchaseHistory,
  getPurchaseHistory,
  listShopItems,
  purchaseItem,
} = require('../services/coinService');
const {
  formatCoins,
  formatItemType,
  formatShopItemLine,
  formatUser,
  replyCoinError,
} = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');
const { clipText, fitListText, omittedLine } = require('../utils/replyLengthGuard');

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

// textLimit is how many characters the item name may take when a long list has to be shortened.
function formatPurchaseLine(purchase, { textLimit = Infinity } = {}) {
  return [
    `#${purchase.id}`,
    `<@${purchase.userId}>`,
    `${clipText(purchase.itemName, textLimit)} x${purchase.quantity}`,
    formatCoins(purchase.totalPrice),
    formatItemType(purchase.itemType),
    purchase.status,
    purchase.expiresAt ? `期限 ${formatTimestamp(purchase.expiresAt)}` : '期限 無',
    formatTimestamp(purchase.createdAt),
  ].join('｜');
}

// A list of purchases is one message: long item names are shortened, and rows that still do not fit are left out with
// a line that says how many.
function purchaseListText(header, purchases, hint = '') {
  return fitListText({
    header,
    items: purchases,
    render: (purchase, { textLimit }) => formatPurchaseLine(purchase, { textLimit }),
    note: (count) => omittedLine(count, { unit: '筆購買紀錄', hint }),
  });
}

async function ensureAdmin(interaction) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('吉幣商店與購買紀錄')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('查看目前伺服器的吉幣商店')
        .addIntegerOption((option) => option.setName('page').setDescription('頁數').setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('buy')
        .setDescription('使用吉幣購買商店商品')
        .addStringOption((option) =>
          option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38)
        )
        .addIntegerOption((option) => option.setName('quantity').setDescription('購買數量').setMinValue(1).setMaxValue(99))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('purchases')
        .setDescription('查看自己的購買紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('purchases-user')
        .setDescription('管理員查看指定使用者購買紀錄')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('purchases-all')
        .setDescription('管理員查看全伺服器購買紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '商店只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'purchases-user' || subcommand === 'purchases-all') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }
      }

      if (subcommand === 'list') {
        const page = interaction.options.getInteger('page') || 1;
        const result = await listShopItems(interaction.guildId, { page, limit: 10 });

        if (result.items.length === 0) {
          await interaction.reply({ content: '目前商店沒有可購買的商品。', ephemeral: true });
          return;
        }

        // A page of long names and descriptions is shortened to fit one message, and an item that still does not
        // fit is left out with a line that says how many.
        await interaction.reply({
          content: fitListText({
            header: `**吉幣商店｜第 ${result.page} 頁**`,
            items: result.items,
            render: (item, { textLimit }) => formatShopItemLine(item, { textLimit }),
            separator: '\n\n',
            note: (count) => omittedLine(count, { unit: '筆商品' }),
          }),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'buy') {
        await interaction.deferReply({ ephemeral: true });
        const itemId = interaction.options.getString('item-id', true);
        const quantity = interaction.options.getInteger('quantity') || 1;
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
        return;
      }

      if (subcommand === 'purchases') {
        const limit = interaction.options.getInteger('limit') || 10;
        const purchases = await getPurchaseHistory(interaction.guildId, interaction.user.id, { limit });

        await interaction.reply({
          content: purchases.length
            ? purchaseListText(`**${interaction.user.username} 的購買紀錄**`, purchases)
            : '你目前沒有購買紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'purchases-user') {
        const user = interaction.options.getUser('user', true);
        const limit = interaction.options.getInteger('limit') || 10;
        const purchases = await getAllPurchaseHistory(interaction.guildId, { userId: user.id, limit });

        await interaction.reply({
          content: purchases.length
            ? purchaseListText(`**${formatUser(user)} 的購買紀錄**`, purchases)
            : `${formatUser(user)} 目前沒有購買紀錄。`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'purchases-all') {
        const limit = interaction.options.getInteger('limit') || 10;
        const purchases = await getAllPurchaseHistory(interaction.guildId, { limit });

        await interaction.reply({
          content: purchases.length
            ? purchaseListText('**全伺服器購買紀錄**', purchases, '可用 /shop purchases-user 查看指定成員')
            : '目前沒有購買紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
