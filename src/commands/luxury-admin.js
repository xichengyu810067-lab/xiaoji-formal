const { SlashCommandBuilder } = require('discord.js');
const {
  createLuxuryItem,
  deleteLuxuryItem,
  editLuxuryItem,
  setLuxuryItemEnabled,
} = require('../services/luxuryService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

function formatStock(stock) {
  return stock === null || stock === undefined ? '不限' : String(stock);
}

function formatLimit(limit) {
  return limit === null || limit === undefined ? '不限' : String(limit);
}

function formatLuxuryItemLine(item) {
  return [
    `#${item.id} **${item.name}**${item.enabled ? '' : '（已下架）'}${item.deleted ? '（已刪除）' : ''}`,
    `${formatCoins(item.price)}｜庫存 ${formatStock(item.stock)}｜購買上限 ${formatLimit(item.purchaseLimit)}`,
    item.description || '沒有描述',
  ].join('\n');
}

function addEditableOptions(subcommand, { includeRequired = false } = {}) {
  return subcommand
    .addStringOption((option) =>
      option.setName('name').setDescription('商品名稱').setRequired(includeRequired).setMaxLength(80)
    )
    .addIntegerOption((option) =>
      option.setName('price').setDescription('商品價格').setRequired(includeRequired).setMinValue(1)
    )
    .addStringOption((option) => option.setName('description').setDescription('商品描述').setMaxLength(500))
    .addIntegerOption((option) => option.setName('stock').setDescription('庫存，留空代表不修改').setMinValue(0))
    .addIntegerOption((option) => option.setName('purchase-limit').setDescription('每人購買上限，留空代表不修改').setMinValue(0));
}

function buildInput(interaction, { create = false } = {}) {
  const input = {
    name: interaction.options.getString('name'),
    price: interaction.options.getInteger('price'),
    description: interaction.options.getString('description'),
    stock: interaction.options.getInteger('stock'),
    purchaseLimit: interaction.options.getInteger('purchase-limit'),
    createdBy: interaction.user.id,
    operatorId: interaction.user.id,
  };

  return create ? input : Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('luxury-admin')
    .setDescription('管理奢侈品商店街')
    .addSubcommand((subcommand) =>
      addEditableOptions(subcommand.setName('create').setDescription('新增奢侈品商品'), { includeRequired: true })
    )
    .addSubcommand((subcommand) =>
      addEditableOptions(
        subcommand
          .setName('edit')
          .setDescription('修改奢侈品商品')
          .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
      )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('上架奢侈品商品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('disable')
        .setDescription('下架奢侈品商品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('刪除奢侈品商品')
        .addStringOption((option) => option.setName('item-id').setDescription('全域商品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '奢侈品管理只能在伺服器內使用。', ephemeral: true });
        return;
      }

      if (!(await ensureBotOwner(interaction))) return;

      const subcommand = interaction.options.getSubcommand();
      let item;

      if (subcommand === 'create') {
        item = await createLuxuryItem(interaction.guildId, buildInput(interaction, { create: true }));
        await interaction.reply({
          content: ['奢侈品商品已建立。', formatLuxuryItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      const itemId = interaction.options.getString('item-id', true);

      if (subcommand === 'edit') {
        item = await editLuxuryItem(interaction.guildId, itemId, buildInput(interaction));
        await interaction.reply({
          content: ['奢侈品商品已更新。', formatLuxuryItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'enable' || subcommand === 'disable') {
        item = await setLuxuryItemEnabled(interaction.guildId, itemId, subcommand === 'enable', {
          operatorId: interaction.user.id,
        });
        await interaction.reply({
          content: [`奢侈品商品已${item.enabled ? '上架' : '下架'}。`, formatLuxuryItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'delete') {
        item = await deleteLuxuryItem(interaction.guildId, itemId, { operatorId: interaction.user.id });
        await interaction.reply({
          content: ['奢侈品商品已刪除。', formatLuxuryItemLine(item)].join('\n\n'),
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '奢侈品管理剛剛執行失敗了，請稍後再試。');
    }
  },
};
