'use strict';

// Quotes and price history for /stock and for 小吉's chat (the stock_quote tool):
// - Taiwan stocks and ETFs (listed and OTC): the public data of the Taiwan Stock Exchange and the Taipei Exchange,
//   no key: quotes from mis.twse.com.tw, daily history from twse.com.tw and tpex.org.tw, names from their open APIs;
// - US stocks and ETFs, and crypto: Twelve Data with TWELVE_DATA_API_KEY (the free plan allows 8 requests a minute and
//   800 a day, which this module keeps to; without the key these markets are unavailable).
// Only the symbol is ever sent. Answers are cached (quotes 30 to 60 seconds, history an hour, names half a day), so a
// busy channel does not repeat the same request. This is market data for reference, never investment advice.

const TWSE_MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const TWSE_DAY = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY';
const TPEX_DAY = 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock';
const TWSE_NAMES = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX_NAMES = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
const TWELVE_DATA = 'https://api.twelvedata.com';
const REQUEST_TIMEOUT_MS = 10_000;
const TWELVE_LIMITS = Object.freeze({ perMinute: 8, perDay: 800 });
const CACHE_MS = Object.freeze({ twQuote: 30_000, usQuote: 60_000, history: 60 * 60 * 1000, names: 12 * 60 * 60 * 1000 });

// Common names that are not in the Taiwan name lists.
const US_NAMES = Object.freeze({
  蘋果: 'AAPL', 特斯拉: 'TSLA', 輝達: 'NVDA', 微軟: 'MSFT', 谷歌: 'GOOGL', 字母: 'GOOGL', 亞馬遜: 'AMZN', 臉書: 'META',
  網飛: 'NFLX', 超微: 'AMD', 英特爾: 'INTC', 博通: 'AVGO', 美光: 'MU', 波克夏: 'BRK.B', 可口可樂: 'KO', 麥當勞: 'MCD',
  標普500: 'SPY', 那斯達克: 'QQQ', 台積電ADR: 'TSM',
});
const CRYPTO_NAMES = Object.freeze({
  BTC: 'BTC/USD', 比特幣: 'BTC/USD', ETH: 'ETH/USD', 以太幣: 'ETH/USD', 以太坊: 'ETH/USD', SOL: 'SOL/USD',
  XRP: 'XRP/USD', 瑞波幣: 'XRP/USD', DOGE: 'DOGE/USD', 狗狗幣: 'DOGE/USD', BNB: 'BNB/USD', 幣安幣: 'BNB/USD',
  ADA: 'ADA/USD', 艾達幣: 'ADA/USD', USDT: 'USDT/USD', 泰達幣: 'USDT/USD',
});

class MarketDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
  }
}

function createMarketData({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  apiKey = () => String(process.env.TWELVE_DATA_API_KEY || '').trim(),
} = {}) {
  const cache = new Map();
  let twelveCalls = [];

  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  }

  async function getJson(url, headers = {}) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
    } catch {
      throw new MarketDataError('provider_unavailable', '報價資料暫時無法取得，請稍後再試。');
    }
    if (!response.ok) throw new MarketDataError('provider_unavailable', '報價資料暫時無法取得，請稍後再試。');
    try {
      return await response.json();
    } catch {
      throw new MarketDataError('provider_unavailable', '報價資料暫時無法取得，請稍後再試。');
    }
  }

  // ---- Taiwan --------------------------------------------------------------------------------------------------

  async function taiwanNames() {
    return cached('tw:names', CACHE_MS.names, async () => {
      const [listed, otc] = await Promise.allSettled([getJson(TWSE_NAMES), getJson(TPEX_NAMES)]);
      const names = new Map();
      for (const row of listed.status === 'fulfilled' && Array.isArray(listed.value) ? listed.value : []) {
        if (row?.Code && row?.Name) names.set(String(row.Code), { code: String(row.Code), name: String(row.Name), exchange: 'tse' });
      }
      for (const row of otc.status === 'fulfilled' && Array.isArray(otc.value) ? otc.value : []) {
        const code = row?.SecuritiesCompanyCode;
        if (code && row?.CompanyName) names.set(String(code), { code: String(code), name: String(row.CompanyName), exchange: 'otc' });
      }
      return names;
    });
  }

  function number(value) {
    const parsed = Number(String(value ?? '').replace(/,/gu, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function firstLevel(levels) {
    return number(String(levels || '').split('_')[0]);
  }

  async function taiwanQuote(code) {
    return cached(`tw:quote:${code}`, CACHE_MS.twQuote, async () => {
      const url = new URL(TWSE_MIS);
      url.searchParams.set('ex_ch', `tse_${code}.tw|otc_${code}.tw`);
      url.searchParams.set('json', '1');
      url.searchParams.set('delay', '0');
      const data = await getJson(url);
      const row = (data?.msgArray || []).find((entry) => entry?.c === code && (number(entry.z) !== null || number(entry.y) !== null));
      if (!row) throw new MarketDataError('not_found', `找不到代號「${code}」的台股報價。`);
      const previous = number(row.y);
      const price = number(row.z) ?? firstLevel(row.b) ?? firstLevel(row.a) ?? previous;
      const change = price !== null && previous !== null ? price - previous : null;
      return {
        market: 'TW',
        symbol: code,
        exchange: row.ex === 'otc' ? '上櫃' : '上市',
        name: String(row.n || code),
        currency: 'TWD',
        price,
        previousClose: previous,
        change,
        changePercent: change !== null && previous ? (change / previous) * 100 : null,
        open: number(row.o),
        high: number(row.h),
        low: number(row.l),
        volume: number(row.v),
        volumeUnit: '張',
        time: row.tlong ? Number(row.tlong) : null,
      };
    });
  }

  function rocDate(text) {
    const [year, month, day] = String(text || '').split('/').map(Number);
    return year && month && day ? `${year + 1911}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }

  function monthStarts(count) {
    const date = new Date(now() + 8 * 60 * 60 * 1000);
    const starts = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1));
      starts.push(start);
    }
    return starts;
  }

  async function taiwanHistory(code, exchange) {
    return cached(`tw:history:${code}`, CACHE_MS.history, async () => {
      const points = [];
      for (const start of monthStarts(2)) {
        const y = start.getUTCFullYear();
        const m = String(start.getUTCMonth() + 1).padStart(2, '0');
        let rows = [];
        if (exchange === '上櫃') {
          const url = new URL(TPEX_DAY);
          url.searchParams.set('code', code);
          url.searchParams.set('date', `${y}/${m}/01`);
          url.searchParams.set('response', 'json');
          const data = await getJson(url);
          rows = data?.tables?.[0]?.data || [];
        } else {
          const url = new URL(TWSE_DAY);
          url.searchParams.set('response', 'json');
          url.searchParams.set('date', `${y}${m}01`);
          url.searchParams.set('stockNo', code);
          const data = await getJson(url);
          rows = data?.stat === 'OK' ? data.data || [] : [];
        }
        for (const row of rows) {
          const date = rocDate(row[0]);
          const close = number(row[6]);
          if (date && close !== null) points.push({ date, close });
        }
      }
      return points.slice(-30);
    });
  }

  // ---- Twelve Data (US and crypto) ------------------------------------------------------------------------------

  function takeTwelveSlot() {
    const at = now();
    twelveCalls = twelveCalls.filter((time) => at - time < 24 * 60 * 60 * 1000);
    const lastMinute = twelveCalls.filter((time) => at - time < 60 * 1000).length;
    if (lastMinute >= TWELVE_LIMITS.perMinute || twelveCalls.length >= TWELVE_LIMITS.perDay) {
      throw new MarketDataError('rate_limited', '美股與加密貨幣的查詢太頻繁了，請過一分鐘再試。');
    }
    twelveCalls.push(at);
  }

  async function twelve(path, params) {
    const key = apiKey();
    if (!key) throw new MarketDataError('not_configured', '美股與加密貨幣報價尚未開啟。');
    takeTwelveSlot();
    const url = new URL(`${TWELVE_DATA}/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const data = await getJson(url, { Authorization: `apikey ${key}` });
    if (data?.status === 'error') {
      if (Number(data.code) === 404 || Number(data.code) === 400) throw new MarketDataError('not_found', `找不到「${params.symbol}」的報價。`);
      if (Number(data.code) === 429) throw new MarketDataError('rate_limited', '美股與加密貨幣的查詢太頻繁了，請過一分鐘再試。');
      throw new MarketDataError('provider_unavailable', '報價資料暫時無法取得，請稍後再試。');
    }
    return data;
  }

  async function twelveQuote(symbol, market) {
    return cached(`tw12:quote:${symbol}`, CACHE_MS.usQuote, async () => {
      const data = await twelve('quote', { symbol });
      const price = number(data.close);
      const change = number(data.change);
      return {
        market,
        symbol: String(data.symbol || symbol),
        exchange: String(data.exchange || ''),
        name: String(data.name || symbol),
        currency: String(data.currency || (market === 'CRYPTO' ? 'USD' : 'USD')),
        price,
        previousClose: number(data.previous_close),
        change,
        changePercent: number(data.percent_change),
        open: number(data.open),
        high: number(data.high),
        low: number(data.low),
        volume: number(data.volume),
        volumeUnit: market === 'CRYPTO' ? '' : '股',
        time: data.last_quote_at ? Number(data.last_quote_at) * 1000 : (data.timestamp ? Number(data.timestamp) * 1000 : null),
      };
    });
  }

  async function twelveHistory(symbol) {
    return cached(`tw12:history:${symbol}`, CACHE_MS.history, async () => {
      const data = await twelve('time_series', { symbol, interval: '1day', outputsize: '30' });
      return (data.values || []).map((row) => ({ date: String(row.datetime).slice(0, 10), close: number(row.close) }))
        .filter((point) => point.close !== null).reverse();
    });
  }

  // ---- Symbols ---------------------------------------------------------------------------------------------------

  // { market: 'TW' | 'US' | 'CRYPTO', symbol } for what a member typed ("2330", "台積電", "AAPL", "蘋果", "比特幣").
  async function resolve(input) {
    const text = String(input ?? '').normalize('NFKC').trim().replace(/\s+/gu, '');
    if (!text || text.length > 30) throw new MarketDataError('invalid_symbol', '請輸入股票代號或名稱，例如 2330、台積電、AAPL 或 BTC。');
    const upper = text.toUpperCase();
    if (CRYPTO_NAMES[upper] || CRYPTO_NAMES[text]) return { market: 'CRYPTO', symbol: CRYPTO_NAMES[upper] || CRYPTO_NAMES[text] };
    if (/^[A-Z]{2,6}\/USD$/u.test(upper)) return { market: 'CRYPTO', symbol: upper };
    if (/^\d{4,6}[A-Z]?$/u.test(upper)) return { market: 'TW', symbol: upper };
    if (US_NAMES[text]) return { market: 'US', symbol: US_NAMES[text] };
    if (/^[A-Z]{1,5}(?:\.[A-Z])?$/u.test(upper)) return { market: 'US', symbol: upper };
    const names = await taiwanNames().catch(() => new Map());
    const entries = [...names.values()];
    const match = entries.find((entry) => entry.name === text) ||
      entries.find((entry) => entry.name.startsWith(text)) ||
      entries.find((entry) => entry.name.includes(text));
    if (match) return { market: 'TW', symbol: match.code };
    throw new MarketDataError('not_found', `找不到「${text}」，請改用股票代號，例如 2330 或 AAPL。`);
  }

  return {
    resolve,
    async quote(input) {
      const target = await resolve(input);
      return target.market === 'TW' ? taiwanQuote(target.symbol) : twelveQuote(target.symbol, target.market);
    },
    // { quote, points: [{ date: 'YYYY-MM-DD', close }] } for about the last month.
    async history(input) {
      const target = await resolve(input);
      if (target.market === 'TW') {
        const quote = await taiwanQuote(target.symbol);
        return { quote, points: await taiwanHistory(target.symbol, quote.exchange) };
      }
      const [quote, points] = await Promise.all([twelveQuote(target.symbol, target.market), twelveHistory(target.symbol)]);
      return { quote, points };
    },
  };
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// One quote as text, the same for /stock and for 小吉's chat.
function formatQuote(quote) {
  const sign = quote.change > 0 ? '▲' : quote.change < 0 ? '▼' : '—';
  const change = quote.change === null ? '—'
    : `${sign} ${formatNumber(Math.abs(quote.change))}（${formatNumber(Math.abs(quote.changePercent ?? 0))}%）`;
  const place = quote.market === 'TW' ? `台股${quote.exchange}` : quote.market === 'CRYPTO' ? '加密貨幣' : `美股 ${quote.exchange}`.trim();
  const time = quote.time ? `<t:${Math.floor(quote.time / 1000)}:f>` : '—';
  return [
    `**${quote.name}（${quote.symbol}）** ${place}`,
    `價格：${formatNumber(quote.price)} ${quote.currency}　${change}`,
    `開 ${formatNumber(quote.open)}｜高 ${formatNumber(quote.high)}｜低 ${formatNumber(quote.low)}｜昨收 ${formatNumber(quote.previousClose)}`,
    ...(quote.volume !== null ? [`成交量：${formatNumber(quote.volume, 0)}${quote.volumeUnit ? ` ${quote.volumeUnit}` : ''}`] : []),
    `資料時間：${time}`,
  ].join('\n');
}

const DISCLAIMER = '-# 報價可能延遲，僅供參考，不構成投資建議。';

let shared = null;
function getMarketData() {
  shared ||= createMarketData();
  return shared;
}

function configureMarketDataForTests(instance) {
  shared = instance;
}

module.exports = {
  DISCLAIMER,
  configureMarketDataForTests,
  MarketDataError,
  TWELVE_LIMITS,
  createMarketData,
  formatQuote,
  getMarketData,
};
