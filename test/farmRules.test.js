'use strict';

// The farm and kitchen rules on plain states: growth, watering, withering and fallow land, fertilizer and wasteland,
// land prices, the daily sale and gift caps, cooking, eating and gifts. No database, no clock, no Discord.

const assert = require('node:assert/strict');
const test = require('node:test');

const { DAY_MS, FARM_RULES, HOUR_MS, MINUTE_MS, getCrop } = require('../src/systems/farm/farmCatalog');
const rules = require('../src/systems/farm/farmRules');
const { buildFarmPanel, parsePanelCustomId } = require('../src/systems/farm/discord/farmPresenter');

// 2026-11-13 10:00 in Taipei.
const T0 = Date.UTC(2026, 10, 13, 2, 0, 0);

function fresh() {
  return rules.settleFarm(rules.createFarmState(), T0).state;
}

function withCrops(crops, state = fresh()) {
  return { ...state, crops: { ...crops } };
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof rules.FarmError, `expected a FarmError, got ${error}`);
    return error.code;
  }
  assert.fail('expected the rule to refuse');
}

test('種滿空地：每格扣一份種子錢，照作物的成長時間成熟', () => {
  const { state, cost, plots } = rules.plantCrop(fresh(), 'tomato', null, T0);
  assert.deepEqual(plots, [0, 1, 2, 3]);
  assert.equal(cost, 4 * getCrop('tomato').seedPrice);
  assert.ok(state.plots.every((plot) => plot.crop === 'tomato' && plot.readyAt === T0 + HOUR_MS));
  assert.equal(codeOf(() => rules.plantCrop(state, 'corn', null, T0)), 'FARM_NO_EMPTY_PLOT');
  assert.equal(codeOf(() => rules.plantCrop(state, 'corn', 2, T0)), 'FARM_PLOT_BUSY');
  assert.equal(codeOf(() => rules.plantCrop(state, 'corn', 9, T0)), 'FARM_PLOT_NOT_FOUND');
  assert.equal(codeOf(() => rules.plantCrop(fresh(), 'durian', 1, T0)), 'FARM_UNKNOWN_CROP');
});

test('澆水：整塊田一起澆，每批成長中的作物只有第一次澆水少 10% 剩餘時間', () => {
  let { state } = rules.plantCrop(fresh(), 'pumpkin', 1, T0);
  const first = rules.waterFarm(state, T0 + 2 * HOUR_MS);
  assert.deepEqual(first.boosted, [0]);
  // 6 hours were left; 10% of them is 36 minutes.
  assert.equal(first.state.plots[0].readyAt, T0 + 8 * HOUR_MS - 36 * MINUTE_MS);
  const second = rules.waterFarm(first.state, T0 + 3 * HOUR_MS);
  assert.deepEqual(second.boosted, []);
  assert.equal(second.state.plots[0].readyAt, first.state.plots[0].readyAt);
  assert.equal(second.state.plots[0].wateredAt, T0 + 3 * HOUR_MS);
  assert.equal(codeOf(() => rules.waterFarm(fresh(), T0)), 'FARM_NOTHING_TO_WATER');
  state = rules.plantCrop(fresh(), 'cabbage', 1, T0).state;
  assert.deepEqual(rules.waterFarm(state, T0 + HOUR_MS).boosted, [], 'a ripe crop is not sped up');
});

test('14 天沒澆水作物枯死，那格休耕 14 天；成熟沒收的作物一樣會枯死', () => {
  const planted = rules.plantCrop(fresh(), 'cabbage', 1, T0).state;
  const before = rules.settleFarm(planted, T0 + FARM_RULES.witherAfterMs - 1);
  assert.deepEqual(before.withered, []);
  assert.equal(rules.plotStatus(before.state.plots[0], T0 + FARM_RULES.witherAfterMs - 1), 'ready');
  const after = rules.settleFarm(planted, T0 + 20 * DAY_MS);
  assert.deepEqual(after.withered, [0]);
  const plot = after.state.plots[0];
  assert.equal(plot.crop, null);
  assert.equal(plot.fallowUntil, T0 + 28 * DAY_MS);
  assert.equal(rules.plotStatus(plot, T0 + 20 * DAY_MS), 'fallow');
  assert.equal(codeOf(() => rules.plantCrop(after.state, 'cabbage', 1, T0 + 20 * DAY_MS)), 'FARM_PLOT_BUSY');
  const later = rules.settleFarm(after.state, T0 + 28 * DAY_MS);
  assert.equal(rules.plotStatus(later.state.plots[0], T0 + 28 * DAY_MS), 'empty');
  // Watering in time keeps the crop.
  const kept = rules.waterFarm(planted, T0 + 13 * DAY_MS).state;
  assert.deepEqual(rules.settleFarm(kept, T0 + 20 * DAY_MS).withered, []);
});

test('化肥：休耕地解除休耕、成長中立刻成熟；第 5 包後收割就荒廢，重新開墾後歸零', () => {
  const withered = rules.settleFarm(rules.plantCrop(fresh(), 'corn', 1, T0).state, T0 + 15 * DAY_MS);
  let now = T0 + 15 * DAY_MS;
  let result = rules.fertilizePlot(withered.state, 1, now);
  assert.equal(result.effect, 'fallow-cleared');
  assert.equal(result.cost, FARM_RULES.fertilizerPrice);
  let { state } = result;
  assert.equal(rules.plotStatus(state.plots[0], now), 'empty');
  for (let bag = 2; bag <= FARM_RULES.maxFertilizerPerPlot; bag += 1) {
    state = rules.plantCrop(state, 'corn', 1, now).state;
    result = rules.fertilizePlot(state, 1, now);
    assert.equal(result.effect, 'ripened');
    assert.equal(result.fertilizer, bag);
    state = result.state;
    if (bag < FARM_RULES.maxFertilizerPerPlot) state = rules.harvestFarm(state, now).state;
  }
  assert.equal(result.doomed, true);
  assert.equal(codeOf(() => rules.fertilizePlot(state, 1, now)), 'FARM_FERTILIZER_LIMIT');
  const harvest = rules.harvestFarm(state, now);
  assert.deepEqual(harvest.wasted, [0]);
  assert.equal(rules.plotStatus(harvest.state.plots[0], now), 'wasted');
  assert.equal(codeOf(() => rules.plantCrop(harvest.state, 'corn', 1, now)), 'FARM_PLOT_BUSY');
  assert.equal(codeOf(() => rules.fertilizePlot(harvest.state, 1, now)), 'FARM_PLOT_WASTED');
  assert.equal(codeOf(() => rules.reclaimPlot(harvest.state, 2)), 'FARM_PLOT_NOT_WASTED');
  const reclaimed = rules.reclaimPlot(harvest.state, 1);
  assert.equal(reclaimed.cost, FARM_RULES.reclaimPrice);
  assert.equal(reclaimed.state.plots[0].fertilizer, 0);
  assert.equal(rules.plotStatus(reclaimed.state.plots[0], now), 'empty');
  now += 1;
  assert.equal(codeOf(() => rules.fertilizePlot(reclaimed.state, 1, now)), 'FARM_NOTHING_TO_FERTILIZE');
});

test('擴充土地：第 5～8 格依序 500、1000、2000、4000 吉幣，最多 8 格', () => {
  let state = fresh();
  const costs = [];
  while (state.plots.length < FARM_RULES.maxPlots) {
    const result = rules.expandFarm(state);
    costs.push(result.cost);
    state = result.state;
  }
  assert.deepEqual(costs, [500, 1000, 2000, 4000]);
  assert.equal(codeOf(() => rules.expandFarm(state)), 'FARM_MAX_PLOTS');
});

test('出售：作物與料理每天合計最多 500 吉幣，超過的留到隔天；台灣日期換日後重算', () => {
  const state = withCrops({ pumpkin: 10, cabbage: 3 });
  const first = rules.sellGoods(state, { kind: 'crop' }, T0);
  // Pumpkins first: 8 of them are 448 coins, and 13 cabbages could fill 52 more but only 3 are held.
  assert.deepEqual(first.sold.map((entry) => [entry.key, entry.quantity]), [['pumpkin', 8], ['cabbage', 3]]);
  assert.equal(first.total, 460);
  assert.equal(first.unsold, 2);
  assert.equal(first.capLeft, 40);
  assert.equal(codeOf(() => rules.sellGoods(first.state, { kind: 'crop', key: 'pumpkin' }, T0)), 'FARM_SALE_CAP');
  const dishes = { ...first.state, dishes: { 'radish-soup': 2 } };
  const dish = rules.sellGoods(dishes, { kind: 'dish', key: 'radish-soup', quantity: 2 }, T0);
  assert.equal(dish.total, 30, 'only one soup fits the 40 coins left');
  // Midnight in Taipei: 2026-11-14 00:00 is 16:00 UTC on the 13th.
  const nextDay = rules.settleFarm(dish.state, Date.UTC(2026, 10, 13, 16, 0, 0)).state;
  assert.equal(nextDay.daily.sold, 0);
  assert.equal(rules.sellGoods(nextDay, { kind: 'crop' }, Date.UTC(2026, 10, 13, 16, 0, 0)).total, 112);
  assert.equal(codeOf(() => rules.sellGoods(fresh(), { kind: 'crop' }, T0)), 'FARM_NOTHING_TO_SELL');
  assert.equal(codeOf(() => rules.sellGoods(withCrops({ corn: 1 }), { kind: 'crop', key: 'corn', quantity: 2 }, T0)),
    'FARM_NOT_ENOUGH_ITEMS');
});

test('下廚：材料不夠就不做；第一次做出記入圖鑑', () => {
  const state = withCrops({ rice: 5, strawberry: 4 });
  assert.equal(codeOf(() => rules.cookDish(state, 'strawberry-daifuku', 3, T0)), 'FARM_MISSING_INGREDIENTS');
  const cooked = rules.cookDish(state, 'strawberry-daifuku', 2, T0);
  assert.equal(cooked.firstTime, true);
  assert.deepEqual(cooked.state.crops, { rice: 3 });
  assert.deepEqual(cooked.state.dishes, { 'strawberry-daifuku': 2 });
  assert.deepEqual(cooked.state.collection['strawberry-daifuku'], { firstAt: T0, count: 2 });
  const again = rules.cookDish(withCrops({ rice: 1, strawberry: 2 }, cooked.state), 'strawberry-daifuku', 1, T0 + 1);
  assert.equal(again.firstTime, false);
  assert.deepEqual(again.state.collection['strawberry-daifuku'], { firstAt: T0, count: 3 });
});

test('吃料理：收到的禮物先吃；加速加成讓之後種的作物變快，豐收加成讓收成多 1 個', () => {
  const state = { ...fresh(), dishes: { 'cabbage-salad': 1, 'tomato-fried-rice': 1 }, gifts: { 'cabbage-salad': 1 } };
  const ate = rules.eatDish(state, 'cabbage-salad', T0);
  assert.equal(ate.source, 'gift');
  assert.deepEqual(ate.state.gifts, {});
  assert.deepEqual(ate.state.buffs.speed, { percent: 10, until: T0 + HOUR_MS });
  const planted = rules.plantCrop(ate.state, 'pumpkin', 1, T0);
  assert.equal(planted.growMs, 8 * HOUR_MS * 0.9);
  const expired = rules.settleFarm(ate.state, T0 + HOUR_MS).state;
  assert.equal(expired.buffs.speed, null);

  const bounty = rules.eatDish(state, 'tomato-fried-rice', T0).state;
  assert.equal(bounty.buffs.bounty, 2);
  let farm = rules.plantCrop(bounty, 'cabbage', null, T0).state;
  const harvest = rules.harvestFarm(farm, T0 + 10 * MINUTE_MS);
  assert.deepEqual(harvest.harvested.map((entry) => entry.count), [3, 3, 2, 2]);
  assert.equal(harvest.state.buffs.bounty, 0);
  farm = harvest.state;
  assert.equal(codeOf(() => rules.eatDish(farm, 'harvest-platter', T0)), 'FARM_NO_DISH');
});

test('送禮：只能送自己做的料理，每天最多送出 5 道；收到的料理只能吃不能賣', () => {
  const giver = { ...fresh(), dishes: { 'corn-chowder': 7 }, gifts: { 'pumpkin-porridge': 1 } };
  const receiver = fresh();
  const result = rules.giftDish(giver, receiver, 'corn-chowder', 4, T0);
  assert.deepEqual(result.receiver.gifts, { 'corn-chowder': 4 });
  assert.deepEqual(result.receiver.dishes, {});
  assert.equal(result.giftsLeft, 1);
  assert.equal(codeOf(() => rules.giftDish(result.giver, result.receiver, 'corn-chowder', 2, T0)), 'FARM_GIFT_CAP');
  assert.equal(codeOf(() => rules.giftDish(giver, receiver, 'pumpkin-porridge', 1, T0)), 'FARM_NOT_ENOUGH_ITEMS');
  assert.equal(codeOf(() => rules.sellGoods(result.receiver, { kind: 'dish' }, T0)), 'FARM_NOTHING_TO_SELL');
});

test('存檔檢查：壞掉或不認得的欄位直接丟掉，不會變出作物或料理', () => {
  const state = rules.normalizeFarmState({
    version: 1,
    plots: [{ crop: 'gold', plantedAt: 1, readyAt: 2, wateredAt: 1, fertilizer: 99 }, null],
    crops: { cabbage: 3, gold: 5, radish: -1, tomato: 1.5 },
    dishes: { 'harvest-platter': 1e9 },
    buffs: { speed: { percent: 100, until: 1 }, bounty: 1e6 },
    daily: { date: '2026-11-13', sold: 'x', gifted: 0 },
  });
  assert.equal(state.plots.length, FARM_RULES.startingPlots);
  assert.equal(state.plots[0].crop, null);
  assert.equal(state.plots[0].fertilizer, FARM_RULES.maxFertilizerPerPlot);
  assert.deepEqual(state.crops, { cabbage: 3 });
  assert.deepEqual(state.dishes, { 'harvest-platter': FARM_RULES.maxItemQuantity });
  assert.equal(state.buffs.speed, null);
  assert.equal(state.buffs.bounty, FARM_RULES.maxActionQuantity);
  assert.deepEqual(state.daily, { date: null, sold: 0, gifted: 0 });
  assert.deepEqual(rules.normalizeFarmState({ version: 2 }), rules.createFarmState());
});

test('農場面板：按鈕只屬於面板主人，文字不超過 Discord 上限', () => {
  let state = rules.plantCrop(fresh(), 'cabbage', null, T0).state;
  for (let index = 0; index < 4; index += 1) state = rules.expandFarm(state).state;
  state = { ...state, crops: Object.fromEntries(['cabbage', 'radish', 'tomato', 'corn', 'rice', 'strawberry', 'pumpkin']
    .map((key) => [key, FARM_RULES.maxItemQuantity])) };
  const panel = buildFarmPanel({ userId: '760000000000000002', state, now: T0, notices: ['測試'] });
  assert.ok(panel.content.length <= 2000);
  const ids = panel.components[0].components.map((button) => button.data.custom_id);
  assert.deepEqual(ids.map(parsePanelCustomId), ['water', 'harvest', 'sell', 'refresh']
    .map((action) => ({ action, ownerId: '760000000000000002' })));
  assert.equal(parsePanelCustomId('farm|1|water|abc'), null);
  assert.equal(parsePanelCustomId('farm|1|burn|760000000000000002'), null);
});
