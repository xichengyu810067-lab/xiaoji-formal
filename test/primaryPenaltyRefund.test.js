const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-refund-'));
process.env.COIN_DB_PATH = path.join(directory, 'synthetic.sqlite');

const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinTransaction } =
  require('../src/services/coinDatabase');
const { getWalletPlayerWithApi, setDebtWithApi } = require('../src/services/coinWalletService');
const { refundPrimaryPenaltyWithApi } = require('../src/systems/economy/workSystem');

test('approved primary penalty refund credits wallet without reducing existing debt', async (t) => {
  t.after(() => {
    resetCoinDatabaseForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  const outcome = await withCoinTransaction((api) => {
    getWalletPlayerWithApi(api, 'guild-a', 'user-a');
    setDebtWithApi(api, 'user-a', 100);
    const refund = refundPrimaryPenaltyWithApi(api, {
      cycle: { cycle_id: 'cycle-a', source_guild_id: 'guild-a' },
      penalty: { id: 7, user_id: 'user-a' },
      appealId: 3, reviewerId: 'owner-a', amount: 40,
      timestamp: '2026-09-25T10:00:00.000Z',
    });
    return { refund, player: getWalletPlayerWithApi(api, 'guild-a', 'user-a', { ensure: false }) };
  });
  assert.equal(outcome.player.balance, 40);
  assert.equal(outcome.player.totalEarned, 40);
  assert.equal(outcome.player.debtAmount, 100);
  assert.equal(outcome.refund.debtOffset, 0);
});
