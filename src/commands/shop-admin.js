const { SlashCommandBuilder } = require('discord.js');
const {
  createShopItem,
  deleteShopItem,
  editShopItem,
  setShopItemEnabled,
  ShopItemTypes,
} = require('../services/coinService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { formatShopItemLine, replyCoinError } = require('../utils/coinPresentation');

const itemTypeChoices = [
  { name: '文字頻道使用權', value: ShopItemTypes.TEXT_CHANNEL },
  { name: '語音頻道使用權', value: ShopItemTypes.VOICE_CHANNEL },
  { name: '稱號或頭銜', value: ShopItemTypes.TITLE },
  { name: '收藏道具', value: ShopItemTypes.COLLECTIBLE },
  { name: '特殊互動道具', value: ShopItemTypes.INTERACTION },
  { name: '對戰技能道具', value: ShopItemTypes.BATTLE_ITEM },
];

function addItemEditableOptions(subcommand, { includeRequired = false } = {}) {
  const builder = subcommand
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('商品名稱')
        .setRequired(includeRequired)
        .setMaxLength(80)
    )
    .addIntegerOption((option) =>
      option
        .setName('price')
        .setDescription('商品價格')
        .setRequired(includeRequired)
        .setMinValue(0)
    )
    .addStringOption((option) =>
      option.setName('description').setDescription('商品描述').setMaxLength(500)
    )
    .addStringOption((option) =>
      option.setName('type').setDescription('商品類型').addChoices(...itemTypeChoices)
    )
    .addIntegerOption((option) => option.setName('stock').setDescription('庫存；不填代表不限').setMinValue(0))
    .addIntegerOption((option) =>
      option.setName('purchase-limit').setDescription('每人購買限制；不填代表不限').setMinValue(0)
    );

  return builder;
}

function buildItemInput(interaction, { create = false } = {}) {
  const input = {
    name: interaction.options.getString('name'),
    price: interaction.options.getInteger('price'),
    description: interaction.options.getString('description'),
    type: interaction.options.getString('type'),
    stock: interaction.options.getInteger('stock'),
    purchaseLimit: interaction.options.getInteger('purchase-limit'),
    createdBy: interaction.user.id,
    operatorId: interaction.user.id,
  };

  if (create) {
    return input;
  }

  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop-admin')
    .setDescription('管理吉幣商店商品')
    .addSubcommand((subcommand) =>
      addItemEditableOptions(subcommand.setName('create').setDescription('新增商店商品'), { includeRequired: true })
    )
    .addSubcommand((subcommand) =>
      addItemEditableOptions(
        subcommand
          .setName('edit')
          .setDescription('修改商店商品')
          .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
      )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('disable')
        .setDescription('停用商店商品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('重新啟用商店商品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('軟刪除商店商品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '商店管理只能在伺服器內使用。', ephemeral: true });
        return;
      }

      if (!(await ensureBotOwner(interaction))) return;

      const subcommand = interaction.options.getSubcommand();
      let item;

      if (subcommand === 'create') {
        item = await createShopItem(interaction.guildId, buildItemInput(interaction, { create: true }));
        await interaction.reply({
          content: [`商品已新增。`, formatShopItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      const itemId = interaction.options.getString('item-id', true);

      if (subcommand === 'edit') {
        item = await editShopItem(interaction.guildId, itemId, buildItemInput(interaction));
        await interaction.reply({
          content: [`商品已更新。`, formatShopItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'enable' || subcommand === 'disable') {
        item = await setShopItemEnabled(interaction.guildId, itemId, subcommand === 'enable', {
          operatorId: interaction.user.id,
        });
        await interaction.reply({
          content: [`商品已${item.enabled ? '啟用' : '停用'}。`, formatShopItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'delete') {
        item = await deleteShopItem(interaction.guildId, itemId, { operatorId: interaction.user.id });
        await interaction.reply({
          content: [`商品已軟刪除並停用。`, formatShopItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
