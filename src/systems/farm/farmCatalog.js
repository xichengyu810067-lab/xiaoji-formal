'use strict';

// What the farm and the kitchen offer: crops, recipes, land prices and the limits that keep the coins they pay in
// check. Every number here is a rule of the game; the state and the coin moves are in farmRules and farmService.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// key, name, seed price, growth time, harvest count, sale price of one.
const CROPS = Object.freeze([
  ['cabbage', '小白菜', 5, 10 * MINUTE_MS, 2, 4],
  ['radish', '蘿蔔', 10, 30 * MINUTE_MS, 2, 8],
  ['tomato', '番茄', 20, HOUR_MS, 3, 9],
  ['corn', '玉米', 30, 2 * HOUR_MS, 3, 14],
  ['rice', '稻米', 40, 4 * HOUR_MS, 4, 14],
  ['strawberry', '草莓', 60, 6 * HOUR_MS, 4, 21],
  ['pumpkin', '南瓜', 80, 8 * HOUR_MS, 2, 56],
].map(([key, name, seedPrice, growMs, yieldCount, salePrice]) => Object.freeze({
  key, name, seedPrice, growMs, yieldCount, salePrice,
})));

// A dish eaten gives one farm buff. speed: crops planted while it lasts grow `percent` faster. bounty: the next
// `plots` plots harvested give one crop more each.
const RECIPES = Object.freeze([
  ['cabbage-salad', '涼拌白菜', { cabbage: 3 }, 16, { kind: 'speed', percent: 10, durationMs: HOUR_MS }],
  ['radish-soup', '蘿蔔湯', { radish: 2, cabbage: 1 }, 30, { kind: 'speed', percent: 10, durationMs: 2 * HOUR_MS }],
  ['tomato-veggie-soup', '番茄蔬菜湯', { tomato: 2, radish: 1, cabbage: 1 }, 40,
    { kind: 'speed', percent: 15, durationMs: 2 * HOUR_MS }],
  ['corn-chowder', '玉米濃湯', { corn: 2, tomato: 1 }, 50, { kind: 'speed', percent: 15, durationMs: 3 * HOUR_MS }],
  ['tomato-fried-rice', '番茄炒飯', { rice: 2, tomato: 1, corn: 1 }, 70, { kind: 'bounty', plots: 2 }],
  ['strawberry-daifuku', '草莓大福', { rice: 1, strawberry: 2 }, 75, { kind: 'bounty', plots: 3 }],
  ['pumpkin-porridge', '南瓜粥', { pumpkin: 1, rice: 2 }, 115, { kind: 'speed', percent: 20, durationMs: 4 * HOUR_MS }],
  ['harvest-platter', '豐收拼盤',
    { cabbage: 1, radish: 1, tomato: 1, corn: 1, rice: 1, strawberry: 1, pumpkin: 1 }, 160,
    { kind: 'bounty', plots: 5 }],
].map(([key, name, ingredients, salePrice, buff]) => Object.freeze({
  key, name, ingredients: Object.freeze({ ...ingredients }), salePrice, buff: Object.freeze({ ...buff }),
})));

const FARM_RULES = Object.freeze({
  startingPlots: 4,
  maxPlots: 8,
  // The price of the 5th, 6th, 7th and 8th plot.
  expansionPrices: Object.freeze([500, 1000, 2000, 4000]),
  // The first watering of a growing crop takes this share off the time it still needs.
  waterBoostPercent: 10,
  // A crop not watered for this long dies, and its plot lies fallow for fallowMs.
  witherAfterMs: 14 * DAY_MS,
  fallowMs: 14 * DAY_MS,
  fertilizerPrice: 500,
  // A plot takes at most this many bags; after the last one its next harvest turns it to wasteland.
  maxFertilizerPerPlot: 5,
  reclaimPrice: 3000,
  // Crops and dishes sold by one player in one Taiwan day pay at most this many coins together.
  dailySaleCap: 500,
  // Dishes one player may give away in one Taiwan day.
  dailyGiftCap: 5,
  // The most of one thing a player may keep, so no count can grow without end.
  maxItemQuantity: 9999,
  maxActionQuantity: 99,
});

const CROP_BY_KEY = new Map(CROPS.map((crop) => [crop.key, crop]));
const RECIPE_BY_KEY = new Map(RECIPES.map((recipe) => [recipe.key, recipe]));

function getCrop(key) {
  return CROP_BY_KEY.get(String(key || '')) || null;
}

function getRecipe(key) {
  return RECIPE_BY_KEY.get(String(key || '')) || null;
}

const CROP_CHOICES = Object.freeze(CROPS.map((crop) => Object.freeze({ name: crop.name, value: crop.key })));
const RECIPE_CHOICES = Object.freeze(RECIPES.map((recipe) => Object.freeze({ name: recipe.name, value: recipe.key })));

module.exports = {
  CROPS,
  CROP_CHOICES,
  DAY_MS,
  FARM_RULES,
  HOUR_MS,
  MINUTE_MS,
  RECIPES,
  RECIPE_CHOICES,
  getCrop,
  getRecipe,
};
