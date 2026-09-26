const CasinoLedgerType = Object.freeze({
  GAME_WIN: 'game_win',
  GAME_LOSS: 'game_loss',
  GAME_PUSH: 'game_push',
  LOAN_BORROW: 'loan_borrow',
  LOAN_REPAY: 'loan_repay',
  LOAN_INTEREST: 'loan_interest',
  LOAN_RELIEF: 'loan_relief',
  LOAN_FORCED_COLLECTION: 'loan_forced_collection',
  BLACKJACK_REFUND: 'blackjack_refund',
});

function insertCasinoLedger(api, entry) {
  api.run(
    `INSERT INTO casino_ledger
      (guild_id, user_id, entry_type, currency, amount, balance_before, balance_after, debt_before, debt_after, game_id, loan_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.guildId,
      entry.userId,
      entry.entryType,
      entry.currency || 'chip',
      entry.amount,
      entry.balanceBefore ?? null,
      entry.balanceAfter ?? null,
      entry.debtBefore ?? null,
      entry.debtAfter ?? null,
      entry.gameId ?? null,
      entry.loanId ?? null,
      JSON.stringify(entry.details || {}),
      entry.createdAt || new Date().toISOString(),
    ]
  );
}

module.exports = { CasinoLedgerType, insertCasinoLedger };
