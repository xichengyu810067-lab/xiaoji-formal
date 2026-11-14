const { SlashCommandBuilder } = require('discord.js');
const farmService = require('../systems/farm/farmService');
const { CROP_CHOICES, FARM_RULES } = require('../systems/farm/farmCatalog');
const {
  fertilizeNotice,
  harvestNotice,
  openFarmPanel,
  plantNotice,
  replyFarmError,
  requireGuild,
  saleNotice,
  sendFarmPanel,
  waterNotice,
} = require('../systems/farm/discord/farmDiscord');
const { seedShopText } = require('../systems/farm/discord/farmPresenter');
const { replyEphemeral } = require('../utils/moderation');

const plotOption = (option, description, required) => option
  .setName('plot')
  .setDescription(description)
  .setRequired(required)
  .setMinValue(1)
  .setMaxValue(FARM_RULES.maxPlots);

const data = new SlashCommandBuilder()
  .setName('farm')
  .setDescription('小吉農場：播種、澆水、收成與出售作物')
  .setDMPermission(false)
  .addSubcommand((subcommand) => subcommand.setName('view').setDescription('打開你的農場面板'))
  .addSubcommand((subcommand) => subcommand.setName('shop').setDescription('查看種子、土地與化肥的價格與規則'))
  .addSubcommand((subcommand) => subcommand
    .setName('plant')
    .setDescription('買種子播種；未指定格子時種滿所有空地')
    .addStringOption((option) => option
      .setName('crop').setDescription('作物').setRequired(true).addChoices(...CROP_CHOICES))
    .addIntegerOption((option) => plotOption(option, '要播種的格子；未填時種滿所有空地', false)))
  .addSubcommand((subcommand) => subcommand.setName('water').setDescription('替整塊田澆水'))
  .addSubcommand((subcommand) => subcommand.setName('harvest').setDescription('收成所有成熟的作物'))
  .addSubcommand((subcommand) => subcommand
    .setName('sell')
    .setDescription('把作物賣給小吉；未指定作物時全部出售')
    .addStringOption((option) => option.setName('crop').setDescription('要賣的作物').addChoices(...CROP_CHOICES))
    .addIntegerOption((option) => option
      .setName('quantity').setDescription('出售數量；未填時賣掉這種作物全部')
      .setMinValue(1).setMaxValue(FARM_RULES.maxActionQuantity)))
  .addSubcommand((subcommand) => subcommand
    .setName('fertilize')
    .setDescription(`花 ${FARM_RULES.fertilizerPrice} 吉幣施化肥：解除休耕或讓作物立刻成熟`)
    .addIntegerOption((option) => plotOption(option, '要施肥的格子', true)))
  .addSubcommand((subcommand) => subcommand.setName('expand').setDescription('花吉幣擴充一格土地'))
  .addSubcommand((subcommand) => subcommand
    .setName('reclaim')
    .setDescription(`花 ${FARM_RULES.reclaimPrice} 吉幣重新開墾荒廢的土地`)
    .addIntegerOption((option) => plotOption(option, '要開墾的格子', true)));

module.exports = {
  data,

  async execute(interaction) {
    const action = interaction.options.getSubcommand();
    try {
      if (action === 'shop') return replyEphemeral(interaction, { content: seedShopText(), allowedMentions: { parse: [] } });
      if (action === 'view') return openFarmPanel(interaction);
      requireGuild(interaction);
      const { guildId } = interaction;
      const userId = interaction.user.id;
      if (action === 'plant') {
        const result = await farmService.plant(guildId, userId, {
          crop: interaction.options.getString('crop', true), plot: interaction.options.getInteger('plot'),
        });
        return sendFarmPanel(interaction, result, [plantNotice(result)]);
      }
      if (action === 'water') {
        const result = await farmService.water(guildId, userId);
        return sendFarmPanel(interaction, result, [waterNotice(result)]);
      }
      if (action === 'harvest') {
        const result = await farmService.harvest(guildId, userId);
        return sendFarmPanel(interaction, result, [harvestNotice(result)]);
      }
      if (action === 'sell') {
        const result = await farmService.sell(guildId, userId, {
          kind: 'crop', key: interaction.options.getString('crop'), quantity: interaction.options.getInteger('quantity'),
        });
        return sendFarmPanel(interaction, result, [saleNotice(result)]);
      }
      if (action === 'fertilize') {
        const result = await farmService.fertilize(guildId, userId, { plot: interaction.options.getInteger('plot', true) });
        return sendFarmPanel(interaction, result, [fertilizeNotice(result)]);
      }
      if (action === 'expand') {
        const result = await farmService.expand(guildId, userId);
        return sendFarmPanel(interaction, result,
          [`🚜 花 ${result.cost} 吉幣擴充了第 ${result.plot + 1} 格土地。錢包剩 ${result.balance} 吉幣。`]);
      }
      if (action === 'reclaim') {
        const result = await farmService.reclaim(guildId, userId, { plot: interaction.options.getInteger('plot', true) });
        return sendFarmPanel(interaction, result,
          [`⛏️ 花 ${result.cost} 吉幣重新開墾了第 ${result.plot + 1} 格，化肥次數歸零。錢包剩 ${result.balance} 吉幣。`]);
      }
      return replyEphemeral(interaction, '找不到這個農場子指令。');
    } catch (error) {
      return replyFarmError(interaction, error);
    }
  },
};
