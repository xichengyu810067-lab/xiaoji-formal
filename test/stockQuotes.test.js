'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DISCLAIMER, MarketDataError, TWELVE_LIMITS, createMarketData, formatQuote } = require('../src/systems/stocks/marketData');
const { buildStockChartSvg, renderStockChartPng } = require('../src/systems/stocks/stockChart');
const { configureMemoryStoreForTests, createInMemoryMemoryStore } = require('../src/systems/conversation/preferenceMemory');
const { MAX_WATCHLIST, addToWatchlist, listWatchlist, removeFromWatchlist } = require('../src/systems/stocks/watchlist');

const NOW = Date.parse('2026-11-12T05:00:00Z');

// A network stand-in that answers by host and path, and remembers what was asked.
function fakeNetwork(routes) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    requests.push({ url: target, headers: options.headers || {} });
    const route = routes.find(([match]) => target.href.includes(match));
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (typeof route[1] === 'function' ? route[1](target) : route[1]) };
  };
  return { fetchImpl, requests };
}

const MIS = {
  msgArray: [{
    c: '2330', n: '台積電', ex: 'tse', z: '2340.0000', y: '2395.0000', o: '2385.0000', h: '2395.0000', l: '2330.0000',
    v: '28991', tlong: '1794465000000', a: '2340_2345_', b: '2335_2330_',
  }],
};
const MIS_NO_TRADE = { msgArray: [{ c: '6488', n: '環球晶', ex: 'otc', z: '-', y: '635.0000', a: '623_624_', b: '622_621_', v: '0' }] };
const NAMES_TWSE = [{ Code: '2330', Name: '台積電' }, { Code: '0050', Name: '元大台灣50' }];
const NAMES_TPEX = [{ SecuritiesCompanyCode: '6488', CompanyName: '環球晶' }];
const TWELVE_QUOTE = {
  symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', open: '357.8', high: '359.3', low: '355.9',
  close: '356.0', volume: '732797', previous_close: '355.6', change: '0.4', percent_change: '0.11', last_quote_at: 1794504960,
};

function taiwan() {
  return fakeNetwork([
    ['getStockInfo.jsp', (url) => (url.searchParams.get('ex_ch').includes('6488') ? MIS_NO_TRADE : MIS)],
    ['STOCK_DAY_ALL', NAMES_TWSE],
    ['tpex_mainboard_quotes', NAMES_TPEX],
    ['exchangeReport/STOCK_DAY', { stat: 'OK', data: [['115/11/11', '1', '1', '1', '1', '1', '2,395.00', '0', '1', ''], ['115/11/12', '1', '1', '1', '1', '1', '2,340.00', '0', '1', '']] }],
    ['tradingStock', { tables: [{ data: [['115/11/12', '1', '1', '1', '1', '1', '622.00', '0', '1']] }] }],
  ]);
}

test('Taiwan symbols and names resolve without a key, listed and OTC alike', async () => {
  const network = taiwan();
  const market = createMarketData({ fetchImpl: network.fetchImpl, now: () => NOW, apiKey: () => '' });
  assert.deepEqual(await market.resolve('2330'), { market: 'TW', symbol: '2330' });
  assert.deepEqual(await market.resolve('台積電'), { market: 'TW', symbol: '2330' });
  assert.deepEqual(await market.resolve('環球晶'), { market: 'TW', symbol: '6488' });
  assert.deepEqual(await market.resolve('00631L'), { market: 'TW', symbol: '00631L' });
  assert.deepEqual(await market.resolve('aapl'), { market: 'US', symbol: 'AAPL' });
  assert.deepEqual(await market.resolve('蘋果'), { market: 'US', symbol: 'AAPL' });
  assert.deepEqual(await market.resolve('比特幣'), { market: 'CRYPTO', symbol: 'BTC/USD' });
  await assert.rejects(market.resolve('完全不存在的公司名'), (error) => error instanceof MarketDataError && error.code === 'not_found');
});

test('a Taiwan quote reads the exchange data; without a trade it uses the best bid', async () => {
  const network = taiwan();
  const market = createMarketData({ fetchImpl: network.fetchImpl, now: () => NOW, apiKey: () => '' });
  const quote = await market.quote('台積電');
  assert.deepEqual([quote.name, quote.symbol, quote.exchange, quote.price, quote.change], ['台積電', '2330', '上市', 2340, -55]);
  assert.match(formatQuote(quote), /台積電（2330）\*\* 台股上市\n價格：2,340 TWD　▼ 55（2.3%）/u);
  const otc = await market.quote('6488');
  assert.deepEqual([otc.exchange, otc.price], ['上櫃', 622]);
  // The second ask of the same symbol is answered from the cache.
  const asked = network.requests.length;
  await market.quote('2330');
  assert.equal(network.requests.length, asked);
});

test('history comes from the exchange of the stock', async () => {
  const network = taiwan();
  const market = createMarketData({ fetchImpl: network.fetchImpl, now: () => NOW, apiKey: () => '' });
  const listed = await market.history('2330');
  assert.deepEqual(listed.points.slice(-2), [{ date: '2026-11-11', close: 2395 }, { date: '2026-11-12', close: 2340 }]);
  const otc = await market.history('6488');
  assert.equal(otc.points.at(-1).close, 622);
  assert.ok(network.requests.some((request) => request.url.href.includes('tradingStock')));
});

test('US stocks and crypto need the Twelve Data key, send it in a header, and keep to the free plan limits', async () => {
  const noKey = createMarketData({ fetchImpl: fakeNetwork([]).fetchImpl, now: () => NOW, apiKey: () => '' });
  await assert.rejects(noKey.quote('AAPL'), (error) => error.code === 'not_configured');

  const network = fakeNetwork([['api.twelvedata.com/quote', TWELVE_QUOTE]]);
  let now = NOW;
  const market = createMarketData({ fetchImpl: network.fetchImpl, now: () => now, apiKey: () => 'secret-key' });
  const quote = await market.quote('AAPL');
  assert.deepEqual([quote.name, quote.price, quote.market], ['Apple Inc.', 356, 'US']);
  assert.equal(network.requests[0].headers.Authorization, 'apikey secret-key');
  assert.equal(network.requests[0].url.href.includes('secret-key'), false, 'the key is never in the address');

  for (let index = 1; index < TWELVE_LIMITS.perMinute; index += 1) await market.quote(`AB${String.fromCharCode(65 + index)}`);
  await assert.rejects(market.quote('ZZZ'), (error) => error.code === 'rate_limited');
  now += 61_000;
  await market.quote('ZZZ');
});

test('the chart is a line of the closes with the name, drawn to a PNG', () => {
  const history = {
    quote: { name: '台積電', symbol: '2330', currency: 'TWD' },
    points: [{ date: '2026-11-11', close: 2395 }, { date: '2026-11-12', close: 2340 }],
  };
  const svg = buildStockChartSvg(history);
  assert.match(svg, /台積電（2330）近一個月收盤走勢/u);
  assert.match(svg, /#1f9d55/u, 'a fall is green, as Taiwan shows it');
  const png = renderStockChartPng(history);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(renderStockChartPng({ quote: history.quote, points: [] }), null);
});

test('a watchlist holds up to ten symbols per member', async (t) => {
  configureMemoryStoreForTests(createInMemoryMemoryStore());
  t.after(() => configureMemoryStoreForTests(null));
  for (let index = 0; index < MAX_WATCHLIST; index += 1) {
    assert.deepEqual(await addToWatchlist('u1', `${2300 + index}`), { added: true });
  }
  assert.deepEqual(await addToWatchlist('u1', '9999'), { added: false, reason: 'full' });
  assert.deepEqual(await addToWatchlist('u1', '2300'), { added: false, reason: 'exists' });
  assert.equal((await listWatchlist('u2')).length, 0, 'another member has their own list');
  assert.equal(await removeFromWatchlist('u1', '2300'), true);
  assert.equal((await listWatchlist('u1')).length, MAX_WATCHLIST - 1);
});

test('every answer carries the reminder that it is no investment advice', () => {
  assert.match(DISCLAIMER, /不構成投資建議/u);
});
