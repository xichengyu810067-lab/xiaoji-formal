'use strict';

// The rules of one player's farm and kitchen, on a plain state object and a time in milliseconds. Nothing here reads
// a clock, a database or Discord: farmService loads the state, applies one of these and writes it back in the same
// coin transaction as the coins it moves. Every function works on its own copy and returns it.

const { CROPS, FARM_RULES, RECIPES, getCrop, getRecipe } = require('./farmCatalog');
const { getTaipeiDateKey } = require('../../utils/taipeiClock');

const STATE_VERSION = 1;

class FarmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FarmError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new FarmError(code, message, details);
}

function requireNow(now) {
  const value = Number(now);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now must be a time in milliseconds.');
  return value;
}

function emptyPlot() {
  return { crop: null, plantedAt: null, readyAt: null, wateredAt: null, boosted: false, fallowUntil: null,
    fertilizer: 0, wasted: false };
}

function createFarmState() {
  return {
    version: STATE_VERSION,
    plots: Array.from({ length: FARM_RULES.startingPlots }, emptyPlot),
    crops: {},
    dishes: {},
    gifts: {},
    buffs: { speed: null, bounty: 0 },
    daily: { date: null, sold: 0, gifted: 0 },
    collection: {},
  };
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTime(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function readCounts(value, isKnown) {
  const counts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  for (const [key, count] of Object.entries(value)) {
    if (isKnown(key) && isCount(count) && count > 0) counts[key] = Math.min(count, FARM_RULES.maxItemQuantity);
  }
  return counts;
}

// A stored state, checked field by field; anything that does not fit is dropped rather than trusted, so a broken row
// can never turn into crops, dishes or coins that were not earned.
function normalizeFarmState(raw) {
  const base = createFarmState();
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return base;
  const plots = Array.isArray(raw.plots) ? raw.plots.slice(0, FARM_RULES.maxPlots).map((plot) => {
    const clean = emptyPlot();
    if (!plot || typeof plot !== 'object') return clean;
    if (getCrop(plot.crop) && isTime(plot.plantedAt) && isTime(plot.readyAt) && isTime(plot.wateredAt) &&
        plot.plantedAt !== null && plot.readyAt !== null && plot.wateredAt !== null) {
      Object.assign(clean, { crop: plot.crop, plantedAt: plot.plantedAt, readyAt: plot.readyAt,
        wateredAt: plot.wateredAt, boosted: plot.boosted === true });
    }
    if (isTime(plot.fallowUntil)) clean.fallowUntil = plot.fallowUntil;
    if (isCount(plot.fertilizer)) clean.fertilizer = Math.min(plot.fertilizer, FARM_RULES.maxFertilizerPerPlot);
    clean.wasted = plot.wasted === true;
    return clean;
  }) : [];
  while (plots.length < FARM_RULES.startingPlots) plots.push(emptyPlot());
  base.plots = plots;
  base.crops = readCounts(raw.crops, (key) => Boolean(getCrop(key)));
  base.dishes = readCounts(raw.dishes, (key) => Boolean(getRecipe(key)));
  base.gifts = readCounts(raw.gifts, (key) => Boolean(getRecipe(key)));
  const speed = raw.buffs?.speed;
  base.buffs.speed = speed && isCount(speed.percent) && speed.percent > 0 && speed.percent < 100 &&
    Number.isSafeInteger(speed.until) ? { percent: speed.percent, until: speed.until } : null;
  base.buffs.bounty = isCount(raw.buffs?.bounty) ? Math.min(raw.buffs.bounty, FARM_RULES.maxActionQuantity) : 0;
  if (raw.daily && typeof raw.daily.date === 'string' && isCount(raw.daily.sold) && isCount(raw.daily.gifted)) {
    base.daily = { date: raw.daily.date, sold: raw.daily.sold, gifted: raw.daily.gifted };
  }
  if (raw.collection && typeof raw.collection === 'object') {
    for (const [key, entry] of Object.entries(raw.collection)) {
      if (getRecipe(key) && entry && isTime(entry.firstAt) && entry.firstAt !== null && isCount(entry.count)) {
        base.collection[key] = { firstAt: entry.firstAt, count: entry.count };
      }
    }
  }
  return base;
}

function clone(state) {
  return normalizeFarmState(JSON.parse(JSON.stringify(state)));
}

function plotStatus(plot, now) {
  if (plot.wasted) return 'wasted';
  if (plot.fallowUntil !== null && plot.fallowUntil > now) return 'fallow';
  if (!plot.crop) return 'empty';
  return plot.readyAt <= now ? 'ready' : 'growing';
}

// Crops not watered for witherAfterMs die at that moment and leave their plot fallow for fallowMs from then. A plot
// whose fallow time is over is plain empty land again.
function settleFarm(state, now) {
  const time = requireNow(now);
  const next = clone(state);
  const withered = [];
  next.plots.forEach((plot, index) => {
    if (plot.crop && !plot.wasted && time >= plot.wateredAt + FARM_RULES.witherAfterMs) {
      const diedAt = plot.wateredAt + FARM_RULES.witherAfterMs;
      Object.assign(plot, { crop: null, plantedAt: null, readyAt: null, wateredAt: null, boosted: false,
        fallowUntil: diedAt + FARM_RULES.fallowMs });
      withered.push(index);
    }
    if (plot.fallowUntil !== null && plot.fallowUntil <= time) plot.fallowUntil = null;
  });
  if (next.buffs.speed && next.buffs.speed.until <= time) next.buffs.speed = null;
  const today = getTaipeiDateKey(new Date(time));
  if (next.daily.date !== today) next.daily = { date: today, sold: 0, gifted: 0 };
  return { state: next, withered };
}

function requireQuantity(value, label = '數量') {
  const quantity = value === null || value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > FARM_RULES.maxActionQuantity) {
    fail('FARM_INVALID_QUANTITY', `${label}要是 1 到 ${FARM_RULES.maxActionQuantity} 的整數。`);
  }
  return quantity;
}

function requirePlotIndex(state, plotNumber) {
  const number = Number(plotNumber);
  if (!Number.isSafeInteger(number) || number < 1 || number > state.plots.length) {
    fail('FARM_PLOT_NOT_FOUND', `你的農場只有第 1 到第 ${state.plots.length} 格地。`);
  }
  return number - 1;
}

function addCount(counts, key, amount) {
  const next = (counts[key] || 0) + amount;
  if (next > FARM_RULES.maxItemQuantity) {
    fail('FARM_STORAGE_FULL', `同一種東西最多只能放 ${FARM_RULES.maxItemQuantity} 個，先賣掉或用掉一些吧。`);
  }
  if (next <= 0) delete counts[key];
  else counts[key] = next;
}

function takeCount(counts, key, amount) {
  const have = counts[key] || 0;
  if (have < amount) return false;
  if (have === amount) delete counts[key];
  else counts[key] = have - amount;
  return true;
}

// Plants one crop in the plot named, or in every empty plot when none is named. Returns what the seeds cost; the
// caller charges it in the same transaction.
function plantCrop(state, cropKey, plotNumber, now) {
  const time = requireNow(now);
  const crop = getCrop(cropKey);
  if (!crop) fail('FARM_UNKNOWN_CROP', '小吉的種子行沒有這種作物。');
  const next = clone(state);
  let targets;
  if (plotNumber === null || plotNumber === undefined) {
    targets = next.plots.map((plot, index) => (plotStatus(plot, time) === 'empty' ? index : -1)).filter((i) => i >= 0);
    if (!targets.length) fail('FARM_NO_EMPTY_PLOT', '現在沒有空地可以種，先收成或等休耕結束吧。');
  } else {
    const index = requirePlotIndex(next, plotNumber);
    const status = plotStatus(next.plots[index], time);
    if (status !== 'empty') fail('FARM_PLOT_BUSY', `第 ${index + 1} 格地現在${PLOT_STATUS_TEXT[status]}，不能播種。`);
    targets = [index];
  }
  const speed = next.buffs.speed && next.buffs.speed.until > time ? next.buffs.speed.percent : 0;
  const growMs = Math.max(1000, Math.floor(crop.growMs * (100 - speed) / 100));
  for (const index of targets) {
    Object.assign(next.plots[index], { crop: crop.key, plantedAt: time, readyAt: time + growMs, wateredAt: time,
      boosted: false, fallowUntil: null });
  }
  return { state: next, crop, plots: targets, cost: crop.seedPrice * targets.length, growMs, speedPercent: speed };
}

// Waters the whole farm: every crop's wither clock starts again, and every growing crop not yet watered since it was
// planted needs waterBoostPercent less of the time it still has to grow.
function waterFarm(state, now) {
  const time = requireNow(now);
  const next = clone(state);
  let watered = 0;
  const boosted = [];
  next.plots.forEach((plot, index) => {
    if (!plot.crop || plot.wasted) return;
    watered += 1;
    plot.wateredAt = time;
    if (!plot.boosted && plot.readyAt > time) {
      const remaining = plot.readyAt - time;
      plot.readyAt = time + Math.ceil(remaining * (100 - FARM_RULES.waterBoostPercent) / 100);
      plot.boosted = true;
      boosted.push(index);
    }
  });
  if (!watered) fail('FARM_NOTHING_TO_WATER', '田裡現在沒有作物需要澆水。');
  return { state: next, watered, boosted };
}

// Harvests every ripe plot. A bounty buff adds one crop to each plot it covers; a plot that has taken its last bag of
// fertilizer turns to wasteland once harvested. A plot whose crop has no room left in storage stays ripe.
function harvestFarm(state, now) {
  const time = requireNow(now);
  const next = clone(state);
  const harvested = [];
  const wasted = [];
  const skipped = [];
  next.plots.forEach((plot, index) => {
    if (plotStatus(plot, time) !== 'ready') return;
    const crop = getCrop(plot.crop);
    const bonus = next.buffs.bounty > 0 ? 1 : 0;
    const count = crop.yieldCount + bonus;
    if ((next.crops[crop.key] || 0) + count > FARM_RULES.maxItemQuantity) {
      skipped.push(index);
      return;
    }
    addCount(next.crops, crop.key, count);
    next.buffs.bounty -= bonus;
    harvested.push({ plot: index, crop: crop.key, count, bonus });
    Object.assign(plot, { crop: null, plantedAt: null, readyAt: null, wateredAt: null, boosted: false });
    if (plot.fertilizer >= FARM_RULES.maxFertilizerPerPlot) {
      plot.wasted = true;
      wasted.push(index);
    }
  });
  if (!harvested.length) {
    if (skipped.length) fail('FARM_STORAGE_FULL', `倉庫放不下了：同一種作物最多 ${FARM_RULES.maxItemQuantity} 個，先賣掉或下廚用掉一些吧。`);
    fail('FARM_NOTHING_RIPE', '現在沒有成熟的作物可以收成。');
  }
  return { state: next, harvested, wasted, skipped };
}

// One bag on one plot: a fallow plot is ready to plant again (this comes first), a growing crop ripens at once. Both
// count toward the plot's bags.
function fertilizePlot(state, plotNumber, now) {
  const time = requireNow(now);
  const next = clone(state);
  const index = requirePlotIndex(next, plotNumber);
  const plot = next.plots[index];
  const status = plotStatus(plot, time);
  if (status === 'wasted') fail('FARM_PLOT_WASTED', `第 ${index + 1} 格地已經荒廢，要先用 /farm reclaim 重新開墾。`);
  if (plot.fertilizer >= FARM_RULES.maxFertilizerPerPlot) {
    fail('FARM_FERTILIZER_LIMIT', `第 ${index + 1} 格地已經用滿 ${FARM_RULES.maxFertilizerPerPlot} 包化肥，不能再施肥。`);
  }
  let effect;
  if (status === 'fallow') {
    plot.fallowUntil = null;
    effect = 'fallow-cleared';
  } else if (status === 'growing') {
    plot.readyAt = time;
    effect = 'ripened';
  } else {
    fail('FARM_NOTHING_TO_FERTILIZE', `第 ${index + 1} 格地${PLOT_STATUS_TEXT[status]}，化肥只能用在休耕或成長中的地。`);
  }
  plot.fertilizer += 1;
  return { state: next, plot: index, effect, fertilizer: plot.fertilizer,
    doomed: plot.fertilizer >= FARM_RULES.maxFertilizerPerPlot, cost: FARM_RULES.fertilizerPrice };
}

function expandFarm(state) {
  const next = clone(state);
  if (next.plots.length >= FARM_RULES.maxPlots) fail('FARM_MAX_PLOTS', `農場最多 ${FARM_RULES.maxPlots} 格地，已經擴充到底了。`);
  const cost = FARM_RULES.expansionPrices[next.plots.length - FARM_RULES.startingPlots];
  next.plots.push(emptyPlot());
  return { state: next, plot: next.plots.length - 1, cost };
}

function reclaimPlot(state, plotNumber) {
  const next = clone(state);
  const index = requirePlotIndex(next, plotNumber);
  if (!next.plots[index].wasted) fail('FARM_PLOT_NOT_WASTED', `第 ${index + 1} 格地沒有荒廢，不需要重新開墾。`);
  next.plots[index] = emptyPlot();
  return { state: next, plot: index, cost: FARM_RULES.reclaimPrice };
}

function saleCapLeft(state) {
  return Math.max(0, FARM_RULES.dailySaleCap - state.daily.sold);
}

// Sells crops (kind 'crop') or own dishes (kind 'dish'): one key and a quantity, or everything of that kind when no
// key is given. Sales stop at the day's cap; what does not fit stays for tomorrow. Dearest first, so a near-full cap
// is filled with what is worth most.
function sellGoods(state, { kind, key = null, quantity = null }, now) {
  const time = requireNow(now);
  const next = clone(state);
  const counts = kind === 'crop' ? next.crops : next.dishes;
  const lookup = kind === 'crop' ? getCrop : getRecipe;
  let wanted;
  if (key) {
    const entry = lookup(key);
    if (!entry) fail('FARM_UNKNOWN_ITEM', '沒有這種東西可以賣。');
    const have = counts[entry.key] || 0;
    const amount = quantity === null || quantity === undefined ? have : requireQuantity(quantity, '出售數量');
    if (!have) fail('FARM_NOTHING_TO_SELL', `你沒有${entry.name}可以賣。`);
    if (amount > have) fail('FARM_NOT_ENOUGH_ITEMS', `你只有 ${have} 個${entry.name}。`);
    wanted = [[entry, amount]];
  } else {
    wanted = Object.entries(counts).map(([itemKey, have]) => [lookup(itemKey), have])
      .sort((left, right) => right[0].salePrice - left[0].salePrice);
    if (!wanted.length) fail('FARM_NOTHING_TO_SELL', kind === 'crop' ? '倉庫裡沒有作物可以賣。' : '你沒有自己做的料理可以賣。');
  }
  let left = saleCapLeft(next);
  const sold = [];
  for (const [entry, amount] of wanted) {
    const fits = Math.min(amount, Math.floor(left / entry.salePrice));
    if (fits <= 0) continue;
    takeCount(counts, entry.key, fits);
    left -= fits * entry.salePrice;
    sold.push({ key: entry.key, name: entry.name, quantity: fits, amount: fits * entry.salePrice });
  }
  if (!sold.length) {
    fail('FARM_SALE_CAP', `今天的出售額度只剩 ${saleCapLeft(next)} 吉幣，不夠賣這些東西；台灣時間午夜後重新計算。`,
      { capLeft: saleCapLeft(next) });
  }
  const total = sold.reduce((sum, entry) => sum + entry.amount, 0);
  next.daily.sold += total;
  const unsold = wanted.reduce((sum, [, amount]) => sum + amount, 0) - sold.reduce((sum, entry) => sum + entry.quantity, 0);
  return { state: next, sold, total, unsold, capLeft: saleCapLeft(next), time };
}

function cookDish(state, recipeKey, quantity, now) {
  const time = requireNow(now);
  const recipe = getRecipe(recipeKey);
  if (!recipe) fail('FARM_UNKNOWN_RECIPE', '小吉的食譜裡沒有這道料理。');
  const count = requireQuantity(quantity, '料理份數');
  const next = clone(state);
  const missing = Object.entries(recipe.ingredients)
    .filter(([cropKey, need]) => (next.crops[cropKey] || 0) < need * count)
    .map(([cropKey, need]) => `${getCrop(cropKey).name}（需要 ${need * count}，你有 ${next.crops[cropKey] || 0}）`);
  if (missing.length) fail('FARM_MISSING_INGREDIENTS', `做 ${count} 份${recipe.name}材料不夠：${missing.join('、')}。`);
  for (const [cropKey, need] of Object.entries(recipe.ingredients)) takeCount(next.crops, cropKey, need * count);
  addCount(next.dishes, recipe.key, count);
  const firstTime = !next.collection[recipe.key];
  next.collection[recipe.key] = { firstAt: firstTime ? time : next.collection[recipe.key].firstAt,
    count: Math.min((next.collection[recipe.key]?.count || 0) + count, Number.MAX_SAFE_INTEGER) };
  return { state: next, recipe, quantity: count, firstTime };
}

// Eats one dish, a gift first (gifts can only be eaten), and applies its buff: a speed buff replaces the one before,
// bounty plots add up.
function eatDish(state, recipeKey, now) {
  const time = requireNow(now);
  const recipe = getRecipe(recipeKey);
  if (!recipe) fail('FARM_UNKNOWN_RECIPE', '小吉的食譜裡沒有這道料理。');
  const next = clone(state);
  let source = 'gift';
  if (!takeCount(next.gifts, recipe.key, 1)) {
    source = 'own';
    if (!takeCount(next.dishes, recipe.key, 1)) fail('FARM_NO_DISH', `你沒有${recipe.name}可以吃。`);
  }
  if (recipe.buff.kind === 'speed') {
    next.buffs.speed = { percent: recipe.buff.percent, until: time + recipe.buff.durationMs };
  } else {
    next.buffs.bounty = Math.min(next.buffs.bounty + recipe.buff.plots, FARM_RULES.maxActionQuantity);
  }
  return { state: next, recipe, source };
}

// Moves own dishes from the giver to the receiver's gifts. Both states must be settled to the same time.
function giftDish(giverState, receiverState, recipeKey, quantity, now) {
  requireNow(now);
  const recipe = getRecipe(recipeKey);
  if (!recipe) fail('FARM_UNKNOWN_RECIPE', '小吉的食譜裡沒有這道料理。');
  const count = requireQuantity(quantity, '送出份數');
  const giver = clone(giverState);
  const receiver = clone(receiverState);
  const left = FARM_RULES.dailyGiftCap - giver.daily.gifted;
  if (count > left) {
    fail('FARM_GIFT_CAP', `每天最多送出 ${FARM_RULES.dailyGiftCap} 道料理，今天還能送 ${Math.max(0, left)} 道。`);
  }
  const have = giver.dishes[recipe.key] || 0;
  if (have < count) {
    fail('FARM_NOT_ENOUGH_ITEMS', `你自己做的${recipe.name}只有 ${have} 份；收到的禮物只能自己吃，不能再送出。`);
  }
  takeCount(giver.dishes, recipe.key, count);
  addCount(receiver.gifts, recipe.key, count);
  giver.daily.gifted += count;
  return { giver, receiver, recipe, quantity: count, giftsLeft: FARM_RULES.dailyGiftCap - giver.daily.gifted };
}

const PLOT_STATUS_TEXT = Object.freeze({
  empty: '是空地',
  growing: '還在成長',
  ready: '已經成熟',
  fallow: '正在休耕',
  wasted: '已經荒廢',
});

module.exports = {
  CROPS,
  FarmError,
  PLOT_STATUS_TEXT,
  RECIPES,
  STATE_VERSION,
  cookDish,
  createFarmState,
  eatDish,
  expandFarm,
  fertilizePlot,
  giftDish,
  harvestFarm,
  normalizeFarmState,
  plantCrop,
  plotStatus,
  reclaimPlot,
  saleCapLeft,
  sellGoods,
  settleFarm,
  waterFarm,
};
