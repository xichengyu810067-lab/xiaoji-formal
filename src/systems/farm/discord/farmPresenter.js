'use strict';

// What the farm and the kitchen show in Discord: the farm panel with its buttons, and the kitchen's lists. Only text
// and components; the commands and the button handler decide when to send them.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { CROPS, FARM_RULES, RECIPES, getCrop, getRecipe } = require('../farmCatalog');
const { plotStatus } = require('../farmRules');

const CUSTOM_ID_PREFIX = 'farm|1|';
const PANEL_ACTIONS = Object.freeze(['water', 'harvest', 'sell', 'refresh']);

function stamp(ms, style = 'R') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分鐘` : `${hours} 小時`;
}

function countsLine(counts, lookup, empty) {
  const parts = Object.entries(counts).map(([key, count]) => `${lookup(key).name} x${count}`);
  return parts.length ? parts.join('、') : empty;
}

function plotLine(plot, index, now) {
  const status = plotStatus(plot, now);
  const fertilizer = plot.fertilizer > 0
    ? `｜化肥 ${plot.fertilizer}/${FARM_RULES.maxFertilizerPerPlot}${plot.fertilizer >= FARM_RULES.maxFertilizerPerPlot && !plot.wasted ? '（下次收割後荒廢）' : ''}`
    : '';
  const head = `第 ${index + 1} 格`;
  if (status === 'wasted') return `${head}｜荒廢，可用 /farm reclaim 花 ${FARM_RULES.reclaimPrice} 吉幣重新開墾`;
  if (status === 'fallow') return `${head}｜休耕中，${stamp(plot.fallowUntil)}可再播種（化肥可立刻解除）${fertilizer}`;
  if (status === 'empty') return `${head}｜空地${fertilizer}`;
  const crop = getCrop(plot.crop);
  if (status === 'ready') return `${head}｜${crop.name}成熟了，可以收成${fertilizer}`;
  return `${head}｜${crop.name}成長中，${stamp(plot.readyAt)}成熟${plot.boosted ? '（已澆水加速）' : '（澆水可加速）'}${fertilizer}`;
}

function buffLines(state, now) {
  const lines = [];
  if (state.buffs.speed && state.buffs.speed.until > now) {
    lines.push(`成長加速 ${state.buffs.speed.percent}%：${stamp(state.buffs.speed.until)}前種下的作物都適用`);
  }
  if (state.buffs.bounty > 0) lines.push(`豐收：接下來 ${state.buffs.bounty} 格收成各多 1 個`);
  return lines;
}

function witherLine(state) {
  const watered = state.plots.filter((plot) => plot.crop && !plot.wasted).map((plot) => plot.wateredAt);
  if (!watered.length) return null;
  return `記得澆水：最久沒澆的作物會在 ${stamp(Math.min(...watered) + FARM_RULES.witherAfterMs)}枯死`;
}

// The buttons stay usable whatever the farm holds; one that has nothing to do answers why privately.
function panelButtons(userId) {
  const button = (action, label, style) => new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}${action}|${userId}`)
    .setLabel(label)
    .setStyle(style);
  return [new ActionRowBuilder().addComponents(
    button('water', '澆水', ButtonStyle.Primary),
    button('harvest', '全部收成', ButtonStyle.Success),
    button('sell', '全部出售', ButtonStyle.Secondary),
    button('refresh', '重新整理', ButtonStyle.Secondary),
  )];
}

// The farm panel: notice lines first (what the last action did), then the plots, the barn and the day's sales.
function buildFarmPanel({ userId, state, now, notices = [] }) {
  const lines = [...notices.filter(Boolean)];
  if (lines.length) lines.push('');
  lines.push(`**<@${userId}> 的小吉農場**（${state.plots.length}/${FARM_RULES.maxPlots} 格）`);
  state.plots.forEach((plot, index) => lines.push(plotLine(plot, index, now)));
  lines.push('', `倉庫：${countsLine(state.crops, getCrop, '空的')}`);
  for (const line of buffLines(state, now)) lines.push(line);
  const wither = witherLine(state);
  if (wither) lines.push(wither);
  lines.push(`今天已出售 ${state.daily.sold}/${FARM_RULES.dailySaleCap} 吉幣`);
  lines.push('播種用 /farm plant，下廚用 /kitchen cook；作物種類與價格見 /farm shop。');
  return {
    content: lines.join('\n'),
    components: panelButtons(userId),
    allowedMentions: { parse: [] },
  };
}

function parsePanelCustomId(customId) {
  const text = String(customId || '');
  if (!text.startsWith(CUSTOM_ID_PREFIX)) return null;
  const [action, ownerId, ...rest] = text.slice(CUSTOM_ID_PREFIX.length).split('|');
  if (rest.length || !PANEL_ACTIONS.includes(action) || !/^\d{1,30}$/u.test(ownerId || '')) return null;
  return { action, ownerId };
}

function seedShopText() {
  const lines = ['**小吉種子行**（種子價｜成長時間｜每格收成｜每個賣價）'];
  for (const crop of CROPS) {
    lines.push(`${crop.name}：${crop.seedPrice} 吉幣｜${formatDuration(crop.growMs)}｜${crop.yieldCount} 個｜${crop.salePrice} 吉幣`);
  }
  lines.push(
    '',
    `土地：起始 ${FARM_RULES.startingPlots} 格，/farm expand 擴充第 5～8 格分別 ${FARM_RULES.expansionPrices.join('、')} 吉幣。`,
    `澆水：/farm water 一次澆整塊田；成長中的作物每批第一次澆水，剩餘時間少 ${FARM_RULES.waterBoostPercent}%。`,
    '超過 14 天沒澆水，作物會枯死，那格地休耕 14 天。',
    `化肥：${FARM_RULES.fertilizerPrice} 吉幣一包，用在休耕的地可立刻解除休耕，用在成長中的作物可立刻成熟；`
      + `每格最多 ${FARM_RULES.maxFertilizerPerPlot} 包，用滿後那格下一次收割就會荒廢，重新開墾要 ${FARM_RULES.reclaimPrice} 吉幣。`,
    `出售：作物與料理每人每天（台灣日期）合計最多賣 ${FARM_RULES.dailySaleCap} 吉幣。`,
  );
  return lines.join('\n');
}

function buffText(buff) {
  if (buff.kind === 'speed') return `之後 ${formatDuration(buff.durationMs)}內種下的作物快 ${buff.percent}%`;
  return `接下來 ${buff.plots} 格收成各多 1 個`;
}

function ingredientsText(recipe) {
  return Object.entries(recipe.ingredients).map(([key, count]) => `${getCrop(key).name} x${count}`).join('、');
}

function recipesText() {
  const lines = ['**小吉廚房食譜**（材料｜賣價｜吃掉的加成）'];
  for (const recipe of RECIPES) {
    lines.push(`${recipe.name}：${ingredientsText(recipe)}｜${recipe.salePrice} 吉幣｜${buffText(recipe.buff)}`);
  }
  lines.push('', `料理可以賣（與作物合計每天最多 ${FARM_RULES.dailySaleCap} 吉幣）、自己吃，或每天送別人最多 ${FARM_RULES.dailyGiftCap} 道；收到的料理只能吃。`);
  return lines.join('\n');
}

function pantryText(state, now) {
  const lines = [
    '**你的廚房**',
    `自己做的料理：${countsLine(state.dishes, getRecipe, '沒有')}`,
    `收到的料理（只能吃）：${countsLine(state.gifts, getRecipe, '沒有')}`,
    `倉庫的作物：${countsLine(state.crops, getCrop, '沒有')}`,
  ];
  const buffs = buffLines(state, now);
  lines.push(buffs.length ? `目前加成：${buffs.join('；')}` : '目前加成：沒有');
  lines.push(`今天已出售 ${state.daily.sold}/${FARM_RULES.dailySaleCap} 吉幣，已送出 ${state.daily.gifted}/${FARM_RULES.dailyGiftCap} 道料理。`);
  return lines.join('\n');
}

function collectionText(state) {
  const found = RECIPES.filter((recipe) => state.collection[recipe.key]);
  const lines = [`**料理圖鑑**（${found.length}/${RECIPES.length}）`];
  for (const recipe of RECIPES) {
    const entry = state.collection[recipe.key];
    lines.push(entry
      ? `${recipe.name}：${stamp(entry.firstAt, 'D')}第一次做出，共做了 ${entry.count} 份`
      : `？？？：還沒做過（材料：${ingredientsText(recipe)}）`);
  }
  return lines.join('\n');
}

module.exports = {
  CUSTOM_ID_PREFIX,
  buffText,
  buildFarmPanel,
  collectionText,
  formatDuration,
  pantryText,
  parsePanelCustomId,
  recipesText,
  seedShopText,
  stamp,
};
