const { SlashCommandBuilder } = require('discord.js');
const farmService = require('../systems/farm/farmService');
const { FARM_RULES, RECIPE_CHOICES } = require('../systems/farm/farmCatalog');
const { FarmError } = require('../systems/farm/farmRules');
const { replyFarmError, requireGuild, saleNotice, witheredNotice } = require('../systems/farm/discord/farmDiscord');
const { buffText, collectionText, pantryText, recipesText } = require('../systems/farm/discord/farmPresenter');
const { replyEphemeral } = require('../utils/moderation');

const dishOption = (option, description, required) => option
  .setName('dish').setDescription(description).setRequired(required).addChoices(...RECIPE_CHOICES);

const data = new SlashCommandBuilder()
  .setName('kitchen')
  .setDescription('小吉廚房：用農場作物做料理、出售、品嚐或送人')
  .setDMPermission(false)
  .addSubcommand((subcommand) => subcommand.setName('recipes').setDescription('查看食譜、賣價與吃掉的加成'))
  .addSubcommand((subcommand) => subcommand
    .setName('cook')
    .setDescription('用倉庫的作物做料理')
    .addStringOption((option) => option
      .setName('recipe').setDescription('要做的料理').setRequired(true).addChoices(...RECIPE_CHOICES))
    .addIntegerOption((option) => option
      .setName('quantity').setDescription('份數；未填時做 1 份').setMinValue(1).setMaxValue(FARM_RULES.maxActionQuantity)))
  .addSubcommand((subcommand) => subcommand.setName('pantry').setDescription('查看你的料理、作物與目前加成'))
  .addSubcommand((subcommand) => subcommand
    .setName('eat')
    .setDescription('吃一道料理，得到農場加成；收到的禮物會先吃')
    .addStringOption((option) => dishOption(option, '要吃的料理', true)))
  .addSubcommand((subcommand) => subcommand
    .setName('gift')
    .setDescription(`把自己做的料理送給別人（每天最多 ${FARM_RULES.dailyGiftCap} 道，收到的只能吃）`)
    .addUserOption((option) => option.setName('user').setDescription('收禮的人').setRequired(true))
    .addStringOption((option) => dishOption(option, '要送的料理', true))
    .addIntegerOption((option) => option
      .setName('quantity').setDescription('份數；未填時送 1 份').setMinValue(1).setMaxValue(FARM_RULES.dailyGiftCap)))
  .addSubcommand((subcommand) => subcommand
    .setName('sell')
    .setDescription('把自己做的料理賣給小吉；未指定料理時全部出售')
    .addStringOption((option) => dishOption(option, '要賣的料理', false))
    .addIntegerOption((option) => option
      .setName('quantity').setDescription('出售數量；未填時賣掉這道料理全部')
      .setMinValue(1).setMaxValue(FARM_RULES.maxActionQuantity)))
  .addSubcommand((subcommand) => subcommand.setName('collection').setDescription('查看你的料理圖鑑'));

function privateReply(interaction, lines) {
  return replyEphemeral(interaction, { content: lines.filter(Boolean).join('\n'), allowedMentions: { parse: [] } });
}

module.exports = {
  data,

  async execute(interaction) {
    const action = interaction.options.getSubcommand();
    try {
      if (action === 'recipes') return privateReply(interaction, [recipesText()]);
      requireGuild(interaction);
      const { guildId } = interaction;
      const userId = interaction.user.id;
      if (action === 'pantry') {
        const result = await farmService.viewFarm(guildId, userId);
        return privateReply(interaction, [witheredNotice(result), pantryText(result.state, result.time)]);
      }
      if (action === 'collection') {
        const result = await farmService.viewFarm(guildId, userId);
        return privateReply(interaction, [collectionText(result.state)]);
      }
      if (action === 'cook') {
        const result = await farmService.cook(guildId, userId, {
          recipe: interaction.options.getString('recipe', true), quantity: interaction.options.getInteger('quantity') ?? 1,
        });
        return privateReply(interaction, [
          witheredNotice(result),
          `🍳 做好了 ${result.quantity} 份${result.recipe.name}！`,
          result.firstTime ? `📖 第一次做出${result.recipe.name}，已記入料理圖鑑。` : null,
          `可以用 /kitchen sell 賣掉（每份 ${result.recipe.salePrice} 吉幣）、/kitchen eat 吃掉，或 /kitchen gift 送人。`,
        ]);
      }
      if (action === 'eat') {
        const result = await farmService.eat(guildId, userId, { recipe: interaction.options.getString('dish', true) });
        return privateReply(interaction, [
          witheredNotice(result),
          `😋 吃了${result.source === 'gift' ? '別人送的' : '自己做的'}${result.recipe.name}：${buffText(result.recipe.buff)}。`,
        ]);
      }
      if (action === 'gift') {
        const receiver = interaction.options.getUser('user', true);
        if (receiver.bot) throw new FarmError('FARM_GIFT_BOT', '料理只能送給真人成員。');
        const result = await farmService.gift(guildId, userId, {
          receiverId: receiver.id, recipe: interaction.options.getString('dish', true),
          quantity: interaction.options.getInteger('quantity') ?? 1,
        });
        await interaction.reply({
          content: `🎁 ${interaction.user} 送給 ${receiver} ${result.quantity} 份${result.recipe.name}！`
            + `收到的料理可以用 /kitchen eat 吃掉，得到農場加成（不能轉賣）。`,
          allowedMentions: { users: [receiver.id] },
        });
        return { ok: true, giftsLeft: result.giftsLeft };
      }
      if (action === 'sell') {
        const result = await farmService.sell(guildId, userId, {
          kind: 'dish', key: interaction.options.getString('dish'), quantity: interaction.options.getInteger('quantity'),
        });
        return privateReply(interaction, [witheredNotice(result), saleNotice(result)]);
      }
      return replyEphemeral(interaction, '找不到這個廚房子指令。');
    } catch (error) {
      return replyFarmError(interaction, error);
    }
  },
};
