'use strict';

// The farm's Discord side: the private farm panel (opened by /farm view and /board start), its buttons, and the
// sentences that say what an action did. Every answer is private to the farmer, except a gift, which the receiver
// should see.

const farmService = require('../farmService');
const { FARM_RULES, getCrop } = require('../farmCatalog');
const { FarmError } = require('../farmRules');
const { buildFarmPanel, formatDuration, parsePanelCustomId } = require('./farmPresenter');
const { replyCoinError } = require('../../../utils/coinPresentation');
const { replyEphemeral } = require('../../../utils/moderation');

function plotList(indexes) {
  return indexes.map((index) => `第 ${index + 1} 格`).join('、');
}

function witheredNotice(result) {
  if (!result?.withered?.length) return null;
  return `🥀 ${plotList(result.withered)}的作物超過 14 天沒澆水，已經枯死，那格地要休耕 14 天（化肥可以立刻解除）。`;
}

function plantNotice(result) {
  const speed = result.speedPercent ? `（加成快 ${result.speedPercent}%）` : '';
  return `🌱 在${plotList(result.plots)}種下${result.crop.name}，花了 ${result.cost} 吉幣，`
    + `${formatDuration(result.growMs)}後成熟${speed}。錢包剩 ${result.balance} 吉幣。`;
}

function waterNotice(result) {
  const boost = result.boosted.length
    ? `${plotList(result.boosted)}的作物剩餘時間少了 ${FARM_RULES.waterBoostPercent}%。`
    : '這批作物都澆過了，這次只重新計算 14 天的枯死期限。';
  return `💧 澆了 ${result.watered} 格作物。${boost}`;
}

function harvestNotice(result) {
  const parts = result.harvested.map((entry) => `${getCrop(entry.crop).name} x${entry.count}${entry.bonus ? '（豐收 +1）' : ''}`);
  const lines = [`🧺 收成：${parts.join('、')}。`];
  if (result.wasted.length) lines.push(`⚠️ ${plotList(result.wasted)}用滿 ${FARM_RULES.maxFertilizerPerPlot} 包化肥，收割後已經荒廢。`);
  if (result.skipped.length) lines.push(`${plotList(result.skipped)}的作物倉庫放不下，先留在田裡。`);
  return lines.join('\n');
}

function saleNotice(result) {
  const parts = result.sold.map((entry) => `${entry.name} x${entry.quantity}`).join('、');
  const lines = [`💰 賣出 ${parts}，得到 ${result.total} 吉幣。今天還能賣 ${result.capLeft} 吉幣。`];
  if (result.debtOffset > 0) lines.push(`其中 ${result.debtOffset} 吉幣先拿去抵還欠款。`);
  if (result.unsold > 0) lines.push(`還有 ${result.unsold} 個超過今天的出售額度，留到明天再賣。`);
  lines.push(`錢包：${result.balance} 吉幣。`);
  return lines.join('\n');
}

function fertilizeNotice(result) {
  const effect = result.effect === 'fallow-cleared' ? '休耕解除，可以播種了' : '作物立刻成熟了';
  const doom = result.doomed
    ? `這格地已經用滿 ${FARM_RULES.maxFertilizerPerPlot} 包化肥，下一次收割後就會荒廢。`
    : `這格地用了 ${result.fertilizer}/${FARM_RULES.maxFertilizerPerPlot} 包化肥。`;
  return `🧪 第 ${result.plot + 1} 格施了化肥（${result.cost} 吉幣）：${effect}。${doom}錢包剩 ${result.balance} 吉幣。`;
}

async function replyFarmError(interaction, error) {
  if (error instanceof FarmError) {
    const payload = { content: error.message, allowedMentions: { parse: [] } };
    if (interaction.deferred && !interaction.replied) await interaction.editReply(payload);
    else await replyEphemeral(interaction, payload);
    return { ok: false, code: error.code };
  }
  await replyCoinError(interaction, error, '農場資料暫時讀不到，請稍後再試。');
  return { ok: false, code: error?.code || 'FARM_FAILED' };
}

function requireGuild(interaction) {
  if (!interaction.inGuild?.() || !interaction.guildId) {
    throw new FarmError('FARM_GUILD_ONLY', '農場與廚房只能在伺服器裡使用。');
  }
}

// Answers with the farm panel; notices go above the plots.
async function sendFarmPanel(interaction, result, notices = []) {
  const panel = buildFarmPanel({ userId: interaction.user.id, state: result.state, now: result.time,
    notices: [witheredNotice(result), ...notices] });
  if (interaction.deferred && !interaction.replied) return interaction.editReply(panel);
  return replyEphemeral(interaction, panel);
}

async function openFarmPanel(interaction) {
  try {
    requireGuild(interaction);
    const result = await farmService.viewFarm(interaction.guildId, interaction.user.id);
    await sendFarmPanel(interaction, result);
    return { ok: true };
  } catch (error) {
    return replyFarmError(interaction, error);
  }
}

const PANEL_HANDLERS = Object.freeze({
  water: async (guildId, userId) => {
    const result = await farmService.water(guildId, userId);
    return { result, notice: waterNotice(result) };
  },
  harvest: async (guildId, userId) => {
    const result = await farmService.harvest(guildId, userId);
    return { result, notice: harvestNotice(result) };
  },
  sell: async (guildId, userId) => {
    const result = await farmService.sell(guildId, userId, { kind: 'crop' });
    return { result, notice: saleNotice(result) };
  },
  refresh: async (guildId, userId) => ({ result: await farmService.viewFarm(guildId, userId), notice: null }),
});

// A button of the farm panel. Only the farmer whose panel it is may use it; the panel is updated in place, and a
// refused action is answered privately, leaving the panel as it was.
async function handleFarmComponent(interaction) {
  const parsed = parsePanelCustomId(interaction.customId);
  if (!parsed) {
    await replyEphemeral(interaction, '這個農場按鈕已經過期，請用 /farm view 重新打開農場。');
    return { ok: false, code: 'FARM_STALE_CONTROL' };
  }
  if (parsed.ownerId !== interaction.user.id) {
    await replyEphemeral(interaction, '只有這個農場的主人可以使用這些按鈕，請用 /farm view 打開你自己的農場。');
    return { ok: false, code: 'FARM_NOT_OWNER' };
  }
  try {
    requireGuild(interaction);
    const { result, notice } = await PANEL_HANDLERS[parsed.action](interaction.guildId, interaction.user.id);
    const panel = buildFarmPanel({ userId: interaction.user.id, state: result.state, now: result.time,
      notices: [witheredNotice(result), notice] });
    await interaction.update(panel);
    return { ok: true, action: parsed.action };
  } catch (error) {
    return replyFarmError(interaction, error);
  }
}

module.exports = {
  fertilizeNotice,
  handleFarmComponent,
  harvestNotice,
  openFarmPanel,
  plantNotice,
  replyFarmError,
  requireGuild,
  saleNotice,
  sendFarmPanel,
  waterNotice,
  witheredNotice,
};
