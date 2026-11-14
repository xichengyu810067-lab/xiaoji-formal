'use strict';

// A member's /stock watchlist: up to 10 symbols, kept in the same Turso database as 小吉's memory (preferenceMemory.js).
// Without that database the watchlist is not available. Only the member reads or changes their own list.

const { getMemoryStore, withStoreTimeout } = require('../conversation/preferenceMemory');

const MAX_WATCHLIST = 10;

function store() {
  return getMemoryStore();
}

function isWatchlistAvailable() {
  return Boolean(store());
}

async function listWatchlist(userId) {
  const memory = store();
  if (!memory) return null;
  return withStoreTimeout(() => memory.listWatchlist(userId));
}

// { added: true } or { added: false, reason: 'full' | 'exists' }.
async function addToWatchlist(userId, symbol, now = Date.now()) {
  const memory = store();
  if (!memory) return { added: false, reason: 'unavailable' };
  return withStoreTimeout(async () => {
    const current = await memory.listWatchlist(userId);
    if (current.includes(symbol)) return { added: false, reason: 'exists' };
    if (current.length >= MAX_WATCHLIST) return { added: false, reason: 'full' };
    await memory.addToWatchlist(userId, symbol, now);
    return { added: true };
  });
}

async function removeFromWatchlist(userId, symbol) {
  const memory = store();
  if (!memory) return false;
  return withStoreTimeout(() => memory.removeFromWatchlist(userId, symbol));
}

module.exports = {
  MAX_WATCHLIST,
  addToWatchlist,
  isWatchlistAvailable,
  listWatchlist,
  removeFromWatchlist,
};
