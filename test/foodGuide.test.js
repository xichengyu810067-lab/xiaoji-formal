'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { configureMemoryStoreForTests, createInMemoryMemoryStore } = require('../src/systems/conversation/preferenceMemory');
const {
  FoodGuideError,
  MAX_SPOTS_PER_GUILD,
  NOT_AUTHORIZED_TEXT,
  isFoodMapAuthorized,
  NEARBY_SYSTEM,
  addSpot,
  askNearby,
  askRecipe,
  listSpots,
  removeSpot,
} = require('../src/systems/food/foodGuide');

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const UNLISTED_GUILD = '900000000000000003';
// The food map is a trial feature: only the servers listed here may use it.
process.env.XIAOJI_FOOD_MAP_GUILD_IDS = `${GUILD}, ${OTHER_GUILD}`;

function useStore(t) {
  configureMemoryStoreForTests(createInMemoryMemoryStore());
  t.after(() => configureMemoryStoreForTests(null));
}

test('a recipe question is answered from the model, and only the dish is sent', async () => {
  const calls = [];
  const text = await askRecipe('番茄炒蛋', {
    complete: async (request) => { calls.push(request); return { text: '材料：番茄 2 顆、蛋 3 顆。\n1. 番茄切塊。' }; },
  });
  assert.match(text, /番茄 2 顆/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /番茄炒蛋/u);
  await assert.rejects(askRecipe('   ', { complete: async () => ({ text: 'x' }) }), FoodGuideError);
});

test('a model answer that leaks what 小吉 must not tell is not sent', async () => {
  await assert.rejects(
    askRecipe('蛋餅', { complete: async () => ({ text: '小吉是用 Claude 做的，蛋餅要先煎皮。' }) }),
    (error) => error instanceof FoodGuideError && error.code === 'unavailable');
});

test('nearby food searches the web and names places without links', async () => {
  const runs = [];
  const text = await askNearby({ area: '台中逢甲', kind: '拉麵' }, {
    client: {},
    run: async (request) => { runs.push(request); return { text: '1. 某某拉麵｜台中市西屯區文華路｜濃厚豚骨。', refused: false }; },
  });
  assert.match(text, /某某拉麵/u);
  assert.deepEqual(runs[0].tools.map((tool) => tool.name), ['web_search']);
  assert.match(runs[0].input, /地區：台中逢甲\n想吃：拉麵/u);
  assert.match(NEARBY_SYSTEM, /不要貼網址/u);
  await assert.rejects(askNearby({ area: '台北' }, { client: null }), (error) => error.code === 'unavailable');
});

test('the food map keeps places per server; only the one who added a place or a manager removes it', async (t) => {
  useStore(t);
  const spot = await addSpot({ guildId: GUILD, userId: 'u1', name: '阿明牛肉麵', area: '台北中山', kind: '麵食', note: '湯頭很濃' });
  await addSpot({ guildId: GUILD, userId: 'u2', name: '小花甜點', area: '台中', kind: '甜點' });
  await addSpot({ guildId: OTHER_GUILD, userId: 'u1', name: '別的伺服器的店', area: '台北' });
  assert.deepEqual((await listSpots({ guildId: GUILD })).map((entry) => entry.name), ['小花甜點', '阿明牛肉麵']);
  assert.deepEqual((await listSpots({ guildId: GUILD, area: '台北' })).map((entry) => entry.name), ['阿明牛肉麵']);
  assert.deepEqual((await listSpots({ guildId: GUILD, kind: '甜點' })).map((entry) => entry.name), ['小花甜點']);

  assert.deepEqual(await removeSpot({ guildId: GUILD, userId: 'u2', id: spot.id }), { removed: false, reason: 'forbidden' });
  assert.equal((await removeSpot({ guildId: GUILD, userId: 'u2', id: spot.id, canManage: true })).removed, true);
  assert.deepEqual(await removeSpot({ guildId: GUILD, userId: 'u1', id: spot.id }), { removed: false, reason: 'missing' });
  await assert.rejects(addSpot({ guildId: null, userId: 'u1', name: 'x', area: 'y' }), FoodGuideError);
  await assert.rejects(addSpot({ guildId: GUILD, userId: 'u1', name: '', area: 'y' }), FoodGuideError);
});

test('a server food map holds at most 300 places', async (t) => {
  useStore(t);
  for (let index = 0; index < MAX_SPOTS_PER_GUILD; index += 1) {
    await addSpot({ guildId: GUILD, userId: 'u1', name: `店 ${index}`, area: '台北' });
  }
  await assert.rejects(addSpot({ guildId: GUILD, userId: 'u1', name: '多一家', area: '台北' }), (error) => error.code === 'full');
});

test('the food map works only in the authorized servers and tells the others it is a trial', async (t) => {
  useStore(t);
  assert.equal(isFoodMapAuthorized(GUILD), true);
  assert.equal(isFoodMapAuthorized(UNLISTED_GUILD), false);
  assert.equal(isFoodMapAuthorized(GUILD, { XIAOJI_FOOD_MAP_GUILD_IDS: '' }), false);
  assert.equal(isFoodMapAuthorized(GUILD, { XIAOJI_FOOD_MAP_GUILD_IDS: 'not-an-id' }), false);
  const trial = (error) => error.code === 'not_authorized' && error.message === NOT_AUTHORIZED_TEXT;
  await assert.rejects(addSpot({ guildId: UNLISTED_GUILD, userId: 'u1', name: '店', area: '台北' }), trial);
  await assert.rejects(listSpots({ guildId: UNLISTED_GUILD }), trial);
  await assert.rejects(removeSpot({ guildId: UNLISTED_GUILD, userId: 'u1', id: 1 }), trial);
  assert.match(NOT_AUTHORIZED_TEXT, /只有授權的伺服器可以使用/);
});
