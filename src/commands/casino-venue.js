const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  VenueItemType,
  VenueOrderItemStatus,
  addVenueMenuItem,
  cancelVenueOrderItem,
  completeVenueOrderItem,
  createVenueOrder,
  deleteVenueMenuItem,
  getVenueRecipe,
  listVenueHistory,
  listVenueMenu,
  reassignVenueOrderItem,
  reassignVenueWaiter,
  serveVenueOrder,
  splitSteps,
} = require('../services/venueService');
const { formatChips, replyCoinError } = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');

const itemTypeChoices = [
  { name: '餐點', value: VenueItemType.MEAL },
  { name: '飲料', value: VenueItemType.DRINK },
];

const itemTypeLabels = {
  [VenueItemType.MEAL]: '餐點',
  [VenueItemType.DRINK]: '飲料',
};

const statusLabels = {
  [VenueOrderItemStatus.PENDING]: '待製作',
  [VenueOrderItemStatus.COMPLETED]: '已完成',
  [VenueOrderItemStatus.CANCELLED]: '已取消',
};

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F>`;
}

function formatSteps(steps) {
  const parts = splitSteps(steps);

  if (!parts.length) {
    return '沒有製作步驟。';
  }

  return parts.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

function formatMenuItem(item) {
  return `#${item.id}｜${itemTypeLabels[item.itemType]}｜${item.name}`;
}

function formatOrderItemLine(item) {
  const maker = item.makerIsNpc ? '小吉場館人員' : `<@${item.makerUserId}>`;
  return [
    `項目 #${item.id}`,
    itemTypeLabels[item.itemType],
    item.itemName,
    `狀態：${statusLabels[item.status] || item.status}`,
    `製作者：${maker}`,
  ].join('｜');
}

function formatOrderWaiterLine(order) {
  const waiter = order.waiterUserId ? `<@${order.waiterUserId}>` : '未指派';
  return [`服務生：${waiter}`, `小費：${formatChips(order.tipAmount)}`, `小費狀態：${order.tipStatus}`].join('｜');
}

function formatHistoryItem(item) {
  const maker = item.makerIsNpc ? '小吉場館人員' : item.makerUserId ? `<@${item.makerUserId}>` : '未指派';
  return [
    `#${item.id}`,
    itemTypeLabels[item.itemType] || item.itemType,
    item.itemName,
    statusLabels[item.status] || item.status,
    `製作者：${maker}`,
    `建立：${formatTimestamp(item.createdAt)}`,
  ].join('｜');
}

async function ensureAdmin(interaction) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino-venue')
    .setDescription('小吉賭場餐廳與吧檯服務')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('menu')
        .setDescription('查看餐廳與吧檯菜單')
        .addStringOption((option) => option.setName('type').setDescription('類型').addChoices(...itemTypeChoices))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add-menu')
        .setDescription('新增餐點或飲料菜單')
        .addStringOption((option) =>
          option.setName('type').setDescription('類型').setRequired(true).addChoices(...itemTypeChoices)
        )
        .addStringOption((option) => option.setName('name').setDescription('名稱').setRequired(true).setMaxLength(80))
        .addStringOption((option) =>
          option.setName('steps').setDescription('製作方式，可用換行或分號分隔').setRequired(true).setMaxLength(1000)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete-menu')
        .setDescription('管理員刪除菜單項目')
        .addIntegerOption((option) => option.setName('item-id').setDescription('菜單項目 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('order')
        .setDescription('點餐，一次最多一個餐點加一杯飲料')
        .addUserOption((option) => option.setName('waiter').setDescription('指定服務生').setRequired(true))
        .addIntegerOption((option) => option.setName('tip').setDescription('服務生小費（籌碼）').setRequired(true).setMinValue(1))
        .addIntegerOption((option) => option.setName('meal').setDescription('餐點菜單 ID').setMinValue(1))
        .addIntegerOption((option) => option.setName('drink').setDescription('飲料菜單 ID').setMinValue(1))
        .addUserOption((option) => option.setName('chef').setDescription('指定廚師'))
        .addUserOption((option) => option.setName('bartender').setDescription('指定調酒師'))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('recipe')
        .setDescription('被指派的製作者查詢製作方式')
        .addIntegerOption((option) => option.setName('order-item-id').setDescription('訂單項目 ID').setRequired(true).setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('make')
        .setDescription('被指派的製作者提交製作過程')
        .addIntegerOption((option) => option.setName('order-item-id').setDescription('訂單項目 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) =>
          option.setName('steps').setDescription('你實際手打的製作過程').setRequired(true).setMaxLength(1000)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('serve')
        .setDescription('被指派的服務生送達訂單並領取小費')
        .addIntegerOption((option) => option.setName('order-id').setDescription('訂單 ID').setRequired(true).setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reassign')
        .setDescription('管理員重新指派製作者')
        .addIntegerOption((option) => option.setName('order-item-id').setDescription('訂單項目 ID').setRequired(true).setMinValue(1))
        .addUserOption((option) => option.setName('user').setDescription('新的製作者').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reassign-waiter')
        .setDescription('管理員重新指派服務生')
        .addIntegerOption((option) => option.setName('order-id').setDescription('訂單 ID').setRequired(true).setMinValue(1))
        .addUserOption((option) => option.setName('user').setDescription('新的服務生').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cancel')
        .setDescription('管理員取消待製作項目')
        .addIntegerOption((option) => option.setName('order-item-id').setDescription('訂單項目 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看近期餐廳與吧檯訂單')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '場館服務只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (subcommand === 'menu') {
        const type = interaction.options.getString('type');
        const rows = await listVenueMenu(guildId, { itemType: type });
        await interaction.reply({
          content: rows.length
            ? ['**小吉賭場｜餐廳與吧檯菜單**', ...rows.map(formatMenuItem)].join('\n')
            : '目前沒有可用菜單項目。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'add-menu') {
        const item = await addVenueMenuItem(guildId, {
          itemType: interaction.options.getString('type', true),
          name: interaction.options.getString('name', true),
          steps: interaction.options.getString('steps', true),
          createdBy: interaction.user.id,
        });
        await interaction.reply({
          content: [`已新增菜單：${formatMenuItem(item)}`, '**製作方式**', formatSteps(item.steps)].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'delete-menu') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }

        const item = await deleteVenueMenuItem(guildId, interaction.options.getInteger('item-id', true), {
          operatorId: interaction.user.id,
          reason: interaction.options.getString('reason') || '管理員刪除菜單項目',
        });
        await interaction.reply({ content: `已刪除菜單：#${item.id} ${item.name}`, ephemeral: true });
        return;
      }

      if (subcommand === 'order') {
        const result = await createVenueOrder(guildId, interaction.user.id, {
          mealId: interaction.options.getInteger('meal'),
          drinkId: interaction.options.getInteger('drink'),
          chefId: interaction.options.getUser('chef')?.id || null,
          bartenderId: interaction.options.getUser('bartender')?.id || null,
          waiterId: interaction.options.getUser('waiter', true).id,
          tipAmount: interaction.options.getInteger('tip', true),
          channelId: interaction.channelId,
        });
        const makerIds = [...new Set(result.items.filter((item) => !item.makerIsNpc).map((item) => item.makerUserId))];
        const mentionIds = [...new Set([interaction.user.id, result.order.waiterUserId, ...makerIds].filter(Boolean))];
        await interaction.reply({
          content: [
            `**小吉賭場｜訂單 #${result.order.id}**`,
            `${interaction.user} 已送出餐廳/吧檯訂單。`,
            formatOrderWaiterLine(result.order),
            ...result.items.map(formatOrderItemLine),
            makerIds.length ? '被指派的製作者請使用 `/casino-venue recipe` 查詢做法，再用 `/casino-venue make` 提交製作過程。' : '目前由小吉場館人員完成。',
            `服務生請在餐點/酒水完成後使用 \`/casino-venue serve order-id:${result.order.id}\` 送達。`,
          ].join('\n'),
          allowedMentions: { users: mentionIds },
        });
        return;
      }

      if (subcommand === 'recipe') {
        const item = await getVenueRecipe(guildId, interaction.user.id, interaction.options.getInteger('order-item-id', true));
        await interaction.reply({
          content: [`**${item.itemName}｜製作方式**`, formatSteps(item.standardSteps)].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'make') {
        const result = await completeVenueOrderItem(guildId, interaction.user.id, interaction.options.getInteger('order-item-id', true), {
          steps: interaction.options.getString('steps', true),
        });
        await interaction.reply({
          content: [
            `**小吉賭場｜${result.item.itemName} 已完成**`,
            `製作者：${interaction.user}`,
            `訂單項目：#${result.item.id}`,
            '**製作過程**',
            formatSteps(result.item.actualSteps),
          ].join('\n'),
          allowedMentions: { users: [interaction.user.id, result.order.customerId] },
        });
        return;
      }

      if (subcommand === 'serve') {
        const result = await serveVenueOrder(guildId, interaction.user.id, interaction.options.getInteger('order-id', true));
        await interaction.reply({
          content: [
            `**小吉賭場｜訂單 #${result.order.id} 已送達**`,
            `服務生：${interaction.user}`,
            `客人：<@${result.order.customerId}>`,
            `小費：${formatChips(result.order.tipAmount)}`,
          ].join('\n'),
          allowedMentions: { users: [interaction.user.id, result.order.customerId] },
        });
        return;
      }

      if (subcommand === 'reassign') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }

        const target = interaction.options.getUser('user', true);
        const item = await reassignVenueOrderItem(guildId, interaction.options.getInteger('order-item-id', true), target.id, {
          operatorId: interaction.user.id,
          reason: interaction.options.getString('reason') || '管理員重新指派',
        });
        await interaction.reply({
          content: [`已重新指派訂單項目 #${item.id}｜${item.itemName}`, `新的製作者：${target}`].join('\n'),
          allowedMentions: { users: [target.id] },
        });
        return;
      }

      if (subcommand === 'reassign-waiter') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }

        const target = interaction.options.getUser('user', true);
        const order = await reassignVenueWaiter(guildId, interaction.options.getInteger('order-id', true), target.id, {
          operatorId: interaction.user.id,
          reason: interaction.options.getString('reason') || '管理員重新指派服務生',
        });
        await interaction.reply({
          content: [`已重新指派訂單 #${order.id} 的服務生。`, `新的服務生：${target}`, `小費：${formatChips(order.tipAmount)}`].join('\n'),
          allowedMentions: { users: [target.id] },
        });
        return;
      }

      if (subcommand === 'cancel') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }

        const item = await cancelVenueOrderItem(guildId, interaction.options.getInteger('order-item-id', true), {
          operatorId: interaction.user.id,
          reason: interaction.options.getString('reason') || '管理員取消',
        });
        await interaction.reply({ content: `已取消訂單項目 #${item.id}｜${item.itemName}`, ephemeral: true });
        return;
      }

      if (subcommand === 'history') {
        const rows = await listVenueHistory(guildId, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length
            ? ['**小吉賭場｜近期餐廳與吧檯訂單**', ...rows.map(formatHistoryItem)].join('\n')
            : '目前沒有餐廳與吧檯訂單紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '小吉場館服務剛剛執行失敗了，請稍後再試。');
    }
  },
};
