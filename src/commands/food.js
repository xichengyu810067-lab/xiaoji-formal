const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  FoodGuideError,
  addSpot,
  askNearby,
  askRecipe,
  listSpots,
  removeSpot,
} = require('../systems/food/foodGuide');
const { isGuildQuotaExhaustedError, isProviderRateLimitError, QUOTA_EXHAUSTED_MESSAGE } = require('../systems/conversation/provider');
const { sanitizeUserFacingOutput } = require('../systems/conversation/userFacingOutputPolicy');
const logger = require('../utils/logger');

// /food (src/systems/food/foodGuide.js): recipes, nearby food and the server's own food map.
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });

function errorText(error) {
  if (error instanceof FoodGuideError) return error.message;
  if (isGuildQuotaExhaustedError(error)) return QUOTA_EXHAUSTED_MESSAGE;
  if (isProviderRateLimitError(error)) return '小吉有點累了，請稍後再試。';
  logger.warn(`[FOOD] code=FOOD_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
  return '美食功能暫時無法使用，請稍後再試。';
}

function chunks(text, max = 1900) {
  const parts = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    if (current && current.length + line.length + 1 > max) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line.slice(0, max);
  }
  if (current) parts.push(current);
  return parts;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('food')
    .setDescription('食譜查詢、附近美食推薦；伺服器美食地圖測試中，限授權伺服器')
    .addSubcommand((subcommand) => subcommand.setName('recipe').setDescription('查詢食譜')
      .addStringOption((option) => option.setName('dish').setDescription('菜名或手邊的食材，例如 番茄炒蛋、雞腿 洋蔥').setRequired(true).setMaxLength(200)))
    .addSubcommand((subcommand) => subcommand.setName('nearby').setDescription('推薦某個地區的美食')
      .addStringOption((option) => option.setName('area').setDescription('地區，例如 台中逢甲、台北車站').setRequired(true).setMaxLength(40))
      .addStringOption((option) => option.setName('kind').setDescription('想吃什麼，例如 拉麵、早午餐').setMaxLength(30)))
    .addSubcommand((subcommand) => subcommand.setName('add').setDescription('把推薦的店加入伺服器美食地圖（測試中，限授權伺服器）')
      .addStringOption((option) => option.setName('name').setDescription('店名').setRequired(true).setMaxLength(60))
      .addStringOption((option) => option.setName('area').setDescription('地區或地址').setRequired(true).setMaxLength(40))
      .addStringOption((option) => option.setName('kind').setDescription('類型，例如 拉麵、甜點').setMaxLength(30))
      .addStringOption((option) => option.setName('note').setDescription('推薦理由').setMaxLength(200)))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('查看伺服器美食地圖（測試中，限授權伺服器）')
      .addStringOption((option) => option.setName('area').setDescription('只看這個地區').setMaxLength(40))
      .addStringOption((option) => option.setName('kind').setDescription('只看這個類型').setMaxLength(30)))
    .addSubcommand((subcommand) => subcommand.setName('remove').setDescription('從伺服器美食地圖移除一家店（測試中，限授權伺服器）')
      .addIntegerOption((option) => option.setName('id').setDescription('/food list 裡的編號').setRequired(true).setMinValue(1))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId ?? null;
    const personal = subcommand === 'remove';
    await interaction.deferReply({ ephemeral: personal });
    const context = { actorId: interaction.user?.id, guildId, channelId: interaction.channelId };
    const answer = async (text) => {
      const [first, ...rest] = chunks(sanitizeUserFacingOutput(text, { context }));
      await interaction.editReply({ content: first, allowedMentions: NO_MENTIONS });
      for (const part of rest) await interaction.followUp({ content: part, allowedMentions: NO_MENTIONS, ephemeral: personal });
    };

    try {
      if (subcommand === 'recipe') {
        await answer(await askRecipe(interaction.options.getString('dish', true), { guildId }));
        return;
      }
      if (subcommand === 'nearby') {
        const text = await askNearby({
          area: interaction.options.getString('area', true),
          kind: interaction.options.getString('kind') || '',
        }, { guildId });
        await answer(`${text}\n-# 店名可以直接到地圖 App 搜尋；營業資訊以店家公告為準。`);
        return;
      }
      if (subcommand === 'add') {
        const spot = await addSpot({
          guildId,
          userId: interaction.user.id,
          name: interaction.options.getString('name', true),
          area: interaction.options.getString('area', true),
          kind: interaction.options.getString('kind') || '',
          note: interaction.options.getString('note') || '',
        });
        await answer(`已把「${spot.name}」（${spot.area}）加入伺服器美食地圖，編號 ${spot.id}。`);
        return;
      }
      if (subcommand === 'list') {
        const spots = await listSpots({
          guildId, area: interaction.options.getString('area') || '', kind: interaction.options.getString('kind') || '',
        });
        if (!spots.length) {
          await answer('美食地圖還沒有符合的店，用 /food add 推薦一家吧！');
          return;
        }
        await answer(['**伺服器美食地圖**', ...spots.map((spot) =>
          `${spot.id}. **${spot.name}**｜${spot.area}${spot.kind ? `｜${spot.kind}` : ''}${spot.note ? `\n   ${spot.note}` : ''}`)].join('\n'));
        return;
      }
      // remove
      const result = await removeSpot({
        guildId,
        userId: interaction.user.id,
        id: interaction.options.getInteger('id', true),
        canManage: Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)),
      });
      await answer(result.removed ? '已從美食地圖移除。'
        : result.reason === 'forbidden' ? '只有推薦這家店的人或伺服器管理員可以移除。' : '找不到這個編號，請先用 /food list 查看。');
    } catch (error) {
      await answer(errorText(error));
    }
  },
};
