// Economy tables: coin_* (except the work tables), chip_*, luxury_*, casino_loans and casino_ledger.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: coin_guild_settings, coin_players, coin_wallets, coin_guild_players,
// coin_wallet_migrations, coin_daily_checkins, coin_daily_checkins_global, coin_daily_state,
// coin_debts, coin_transactions, coin_shop_items, coin_inventory, coin_purchases,
// coin_global_shop_items, coin_global_inventory, coin_global_purchases, coin_bank_rates,
// coin_rate_history, coin_fixed_deposits, coin_admin_logs
const walletShopAndBankTablesSql = `CREATE TABLE IF NOT EXISTS coin_guild_settings (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_base_reward INTEGER NOT NULL DEFAULT 50,
  streak_three_bonus INTEGER NOT NULL DEFAULT 20,
  streak_seven_bonus INTEGER NOT NULL DEFAULT 100,
  allow_transfer INTEGER NOT NULL DEFAULT 0,
  shop_enabled INTEGER NOT NULL DEFAULT 1,
  admin_log_channel_id TEXT,
  announcement_channel_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_players (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  bank_balance INTEGER NOT NULL DEFAULT 0,
  bank_interest_accrued REAL NOT NULL DEFAULT 0,
  last_interest_date TEXT,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  last_daily_date TEXT,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS coin_wallets (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 9007199254740991),
  total_earned INTEGER NOT NULL DEFAULT 0 CHECK (total_earned >= 0 AND total_earned <= 9007199254740991),
  total_spent INTEGER NOT NULL DEFAULT 0 CHECK (total_spent >= 0 AND total_spent <= 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_guild_players (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bank_balance INTEGER NOT NULL DEFAULT 0 CHECK (bank_balance >= 0 AND bank_balance <= 9007199254740991),
  bank_interest_accrued REAL NOT NULL DEFAULT 0 CHECK (bank_interest_accrued >= 0),
  last_interest_date TEXT,
  last_daily_date TEXT,
  daily_streak INTEGER NOT NULL DEFAULT 0 CHECK (daily_streak >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS coin_wallet_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL UNIQUE,
  source_row_count INTEGER NOT NULL,
  source_distinct_user_count INTEGER NOT NULL,
  source_balance_sum INTEGER NOT NULL,
  source_total_earned_sum INTEGER NOT NULL,
  source_total_spent_sum INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  earned_amount INTEGER NOT NULL,
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS coin_daily_checkins_global (
  user_id TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  earned_amount INTEGER NOT NULL CHECK (earned_amount >= 0 AND earned_amount <= 9007199254740991),
  bonus_amount INTEGER NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0 AND bonus_amount <= 9007199254740991),
  streak INTEGER NOT NULL CHECK (streak >= 1 AND streak <= 9007199254740991),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, checkin_date),
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS coin_daily_state (
  user_id TEXT PRIMARY KEY,
  last_checkin_date TEXT NOT NULL,
  streak INTEGER NOT NULL CHECK (streak >= 1 AND streak <= 9007199254740991),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS coin_debts (
  user_id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0 AND amount <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  balance_before INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  operator_id TEXT,
  reason TEXT,
  metadata TEXT,
  wallet_scope TEXT NOT NULL DEFAULT 'guild_legacy' CHECK (wallet_scope IN ('guild_legacy', 'global')),
  wallet_revision INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'collectible',
  role_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  stock INTEGER,
  purchase_limit INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  last_used_at TEXT,
  is_used INTEGER NOT NULL DEFAULT 0,
  is_expired INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS coin_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'collectible',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_global_shop_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price >= 0 AND price <= 9007199254740991),
  type TEXT NOT NULL DEFAULT 'collectible' CHECK (type != 'role'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  stock INTEGER CHECK (stock IS NULL OR (stock >= 0 AND stock <= 9007199254740991)),
  purchase_limit INTEGER CHECK (purchase_limit IS NULL OR (purchase_limit >= 0 AND purchase_limit <= 9007199254740991)),
  created_by TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (substr(id, 1, 2) = 'g_')
);

CREATE TABLE IF NOT EXISTS coin_global_inventory (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991),
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id),
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS coin_global_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991),
  total_price INTEGER NOT NULL CHECK (total_price >= 0 AND total_price <= 9007199254740991),
  item_type TEXT NOT NULL CHECK (item_type != 'role'),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS coin_bank_rates (
  guild_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  rate REAL NOT NULL,
  previous_rate REAL,
  is_event INTEGER NOT NULL DEFAULT 0,
  event_ends_at TEXT,
  updated_by TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, rate_key)
);

CREATE TABLE IF NOT EXISTS coin_rate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  rate_type TEXT NOT NULL,
  term_days INTEGER,
  old_rate REAL NOT NULL,
  new_rate REAL NOT NULL,
  reason TEXT,
  is_event INTEGER NOT NULL DEFAULT 0,
  event_ends_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_fixed_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  principal INTEGER NOT NULL,
  term_days INTEGER NOT NULL,
  rate REAL NOT NULL,
  expected_interest INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'wallet',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  maturity_at TEXT NOT NULL,
  claimed_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS coin_admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  target_user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);`;

// Part of schemaSql: casino_loans, casino_ledger
const casinoLoanTablesSql = `CREATE TABLE IF NOT EXISTS casino_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  principal_amount INTEGER NOT NULL DEFAULT 0,
  current_debt_amount INTEGER NOT NULL DEFAULT 0,
  interest_rate REAL NOT NULL DEFAULT 0.03,
  relief_count INTEGER NOT NULL DEFAULT 0,
  relief_updated_by TEXT,
  relief_updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_interest_date TEXT NOT NULL,
  repaid_at TEXT
);

CREATE TABLE IF NOT EXISTS casino_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'chip',
  amount INTEGER NOT NULL,
  balance_before INTEGER,
  balance_after INTEGER,
  debt_before INTEGER,
  debt_after INTEGER,
  game_id INTEGER,
  loan_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);`;

// Part of schemaSql: chip_accounts, chip_ledger, luxury_items, luxury_price_history,
// luxury_inventory, luxury_purchases, luxury_pawn_records, luxury_pawn_redemptions,
// luxury_global_items, luxury_global_price_history, luxury_global_inventory,
// luxury_global_purchases, luxury_global_pawn_records, luxury_global_pawn_redemptions
const chipAndLuxuryTablesSql = `CREATE TABLE IF NOT EXISTS chip_accounts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS chip_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  coin_amount INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  operator_id TEXT,
  reason TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  stock INTEGER,
  purchase_limit INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  price INTEGER NOT NULL,
  changed_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS luxury_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_pawn_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  remaining_quantity INTEGER NOT NULL,
  pawn_unit_price INTEGER NOT NULL,
  payout_amount INTEGER NOT NULL,
  redeemed_quantity INTEGER NOT NULL DEFAULT 0,
  redeemed_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS luxury_pawn_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pawn_record_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  redeem_unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_global_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price > 0 AND price <= 9007199254740991),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  stock INTEGER CHECK (stock IS NULL OR (stock >= 0 AND stock <= 9007199254740991)),
  purchase_limit INTEGER CHECK (purchase_limit IS NULL OR (purchase_limit >= 0 AND purchase_limit <= 9007199254740991)),
  created_by TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (substr(id, 1, 2) = 'l_')
);

CREATE TABLE IF NOT EXISTS luxury_global_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0 AND price <= 9007199254740991),
  changed_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_global_inventory (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991),
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id),
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS luxury_global_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0 AND unit_price <= 9007199254740991),
  total_price INTEGER NOT NULL CHECK (total_price > 0 AND total_price <= 9007199254740991),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS luxury_global_pawn_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  pawn_unit_price INTEGER NOT NULL CHECK (pawn_unit_price > 0),
  payout_amount INTEGER NOT NULL CHECK (payout_amount >= 0),
  redeemed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_quantity >= 0),
  redeemed_amount INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_amount >= 0),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  redeemed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);

CREATE TABLE IF NOT EXISTS luxury_global_pawn_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pawn_record_id INTEGER NOT NULL,
  source_guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  redeem_unit_price INTEGER NOT NULL CHECK (redeem_unit_price > 0),
  total_price INTEGER NOT NULL CHECK (total_price > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);`;

// Part of schemaSql: idx_coin_wallets_balance, idx_coin_guild_players_guild,
// idx_coin_transactions_user, coin_players_v19_archive_no_insert,
// coin_players_v19_archive_no_update, coin_players_v19_archive_no_delete,
// idx_coin_shop_items_guild, idx_coin_inventory_user, idx_coin_daily_global_date,
// idx_coin_global_shop_visible, idx_coin_global_inventory_user, idx_coin_global_purchases_user,
// idx_coin_admin_logs_guild
const walletShopAndArchiveIndexesSql = `CREATE INDEX IF NOT EXISTS idx_coin_wallets_balance
  ON coin_wallets (balance DESC, total_earned DESC);

CREATE INDEX IF NOT EXISTS idx_coin_guild_players_guild
  ON coin_guild_players (guild_id, user_id);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user
  ON coin_transactions (guild_id, user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS coin_players_v19_archive_no_insert
BEFORE INSERT ON coin_players
BEGIN
  SELECT RAISE(ABORT, 'coin_players is a read-only v19 archive');
END;

CREATE TRIGGER IF NOT EXISTS coin_players_v19_archive_no_update
BEFORE UPDATE ON coin_players
BEGIN
  SELECT RAISE(ABORT, 'coin_players is a read-only v19 archive');
END;

CREATE TRIGGER IF NOT EXISTS coin_players_v19_archive_no_delete
BEFORE DELETE ON coin_players
BEGIN
  SELECT RAISE(ABORT, 'coin_players is a read-only v19 archive');
END;

CREATE INDEX IF NOT EXISTS idx_coin_shop_items_guild
  ON coin_shop_items (guild_id, enabled, deleted, id);

CREATE INDEX IF NOT EXISTS idx_coin_inventory_user
  ON coin_inventory (guild_id, user_id, acquired_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_daily_global_date
  ON coin_daily_checkins_global (checkin_date DESC, user_id);

CREATE INDEX IF NOT EXISTS idx_coin_global_shop_visible
  ON coin_global_shop_items (enabled, deleted, created_at, id);

CREATE INDEX IF NOT EXISTS idx_coin_global_inventory_user
  ON coin_global_inventory (user_id, updated_at DESC, item_id);

CREATE INDEX IF NOT EXISTS idx_coin_global_purchases_user
  ON coin_global_purchases (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_admin_logs_guild
  ON coin_admin_logs (guild_id, created_at DESC);`;

// Part of schemaSql: idx_coin_fixed_deposits_user, idx_coin_rate_history_guild
const bankIndexesSql = `CREATE INDEX IF NOT EXISTS idx_coin_fixed_deposits_user
  ON coin_fixed_deposits (guild_id, user_id, status, maturity_at);

CREATE INDEX IF NOT EXISTS idx_coin_rate_history_guild
  ON coin_rate_history (guild_id, created_at DESC, id DESC);`;

// Part of schemaSql: idx_casino_loans_user, idx_casino_ledger_user
const casinoLoanIndexesSql = `CREATE INDEX IF NOT EXISTS idx_casino_loans_user
  ON casino_loans (guild_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_casino_ledger_user
  ON casino_ledger (guild_id, user_id, created_at DESC, id DESC);`;

// Part of schemaSql: idx_chip_ledger_user, idx_luxury_items_guild, idx_luxury_inventory_user,
// idx_luxury_price_history_item, idx_luxury_pawn_records_user, idx_luxury_global_items_visible,
// idx_luxury_global_inventory_user, idx_luxury_global_purchases_user, idx_luxury_global_pawn_user
const chipAndLuxuryIndexesSql = `CREATE INDEX IF NOT EXISTS idx_chip_ledger_user
  ON chip_ledger (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_luxury_items_guild
  ON luxury_items (guild_id, enabled, deleted, id);

CREATE INDEX IF NOT EXISTS idx_luxury_inventory_user
  ON luxury_inventory (guild_id, user_id, item_id);

CREATE INDEX IF NOT EXISTS idx_luxury_price_history_item
  ON luxury_price_history (guild_id, item_id, price DESC);

CREATE INDEX IF NOT EXISTS idx_luxury_pawn_records_user
  ON luxury_pawn_records (guild_id, user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_luxury_global_items_visible
  ON luxury_global_items (enabled, deleted, created_at, id);

CREATE INDEX IF NOT EXISTS idx_luxury_global_inventory_user
  ON luxury_global_inventory (user_id, updated_at DESC, item_id);

CREATE INDEX IF NOT EXISTS idx_luxury_global_purchases_user
  ON luxury_global_purchases (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_luxury_global_pawn_user
  ON luxury_global_pawn_records (user_id, status, created_at DESC, id DESC);`;

// Part of globalEconomyV22Sql: coin_bank_accounts_global, coin_bank_rates_global,
// coin_rate_history_global, chip_accounts_global
const globalBankAndChipTablesV22Sql = `CREATE TABLE IF NOT EXISTS coin_bank_accounts_global (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 9007199254740991),
  interest_accrued REAL NOT NULL DEFAULT 0 CHECK (interest_accrued >= 0),
  last_interest_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);
CREATE TABLE IF NOT EXISTS coin_bank_rates_global (
  rate_key TEXT PRIMARY KEY,
  rate REAL NOT NULL CHECK (rate >= 0),
  previous_rate REAL,
  is_event INTEGER NOT NULL DEFAULT 0 CHECK (is_event IN (0, 1)),
  event_ends_at TEXT,
  updated_by TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_rate_history_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  old_rate REAL NOT NULL,
  new_rate REAL NOT NULL,
  reason TEXT,
  is_event INTEGER NOT NULL DEFAULT 0,
  event_ends_at TEXT,
  source_guild_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chip_accounts_global (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id)
);`;

// Part of globalEconomyV22Sql: coin_operation_receipts, coin_owner_campaigns,
// coin_owner_campaign_audiences, coin_owner_campaign_recipients,
// coin_owner_campaign_audience_members, coin_owner_campaign_history_reviews,
// coin_owner_campaign_history_classifications
const operationAndCampaignTablesV22Sql = `CREATE TABLE IF NOT EXISTS coin_operation_receipts (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_guild_id TEXT,
  payload_hash TEXT NOT NULL,
  transaction_id INTEGER,
  reward_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_owner_campaigns (
  campaign_id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_owner_campaign_audiences (
  campaign_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type IN ('member', 'role')),
  role_id TEXT NOT NULL DEFAULT '',
  audience_hash TEXT NOT NULL,
  snapshot_count INTEGER NOT NULL CHECK (snapshot_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, source_guild_id, audience_type, role_id),
  FOREIGN KEY (campaign_id) REFERENCES coin_owner_campaigns(campaign_id)
);
CREATE TABLE IF NOT EXISTS coin_owner_campaign_recipients (
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_source_guild_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, user_id),
  FOREIGN KEY (campaign_id) REFERENCES coin_owner_campaigns(campaign_id)
);
CREATE TABLE IF NOT EXISTS coin_owner_campaign_audience_members (
  campaign_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  audience_type TEXT NOT NULL,
  role_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, source_guild_id, audience_type, role_id, user_id),
  FOREIGN KEY (campaign_id, source_guild_id, audience_type, role_id)
    REFERENCES coin_owner_campaign_audiences(campaign_id, source_guild_id, audience_type, role_id)
);
CREATE TABLE IF NOT EXISTS coin_owner_campaign_history_reviews (
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prior_grant INTEGER NOT NULL CHECK (prior_grant IN (0, 1)),
  source_sha256 TEXT NOT NULL,
  review_batch_sha256 TEXT NOT NULL,
  review_id TEXT NOT NULL,
  review_reason TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, user_id),
  FOREIGN KEY (campaign_id, user_id)
    REFERENCES coin_owner_campaign_recipients(campaign_id, user_id)
);
CREATE TABLE IF NOT EXISTS coin_owner_campaign_history_classifications (
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('transaction', 'legacy_grant', 'admin_log')),
  record_id INTEGER NOT NULL,
  row_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  evidence_reference TEXT NOT NULL,
  review_reason TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, user_id, record_type, record_id),
  FOREIGN KEY (campaign_id, user_id)
    REFERENCES coin_owner_campaign_recipients(campaign_id, user_id)
);`;

// Part of globalEconomyV22Sql: coin_global_economy_migrations
const globalEconomyMigrationsTableV22Sql = `CREATE TABLE IF NOT EXISTS coin_global_economy_migrations (
  to_version INTEGER PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  source_bank_balance_sum INTEGER NOT NULL,
  target_bank_balance_sum INTEGER NOT NULL,
  source_chip_balance_sum INTEGER NOT NULL,
  target_chip_balance_sum INTEGER NOT NULL,
  source_interest_sum REAL NOT NULL,
  target_interest_sum REAL NOT NULL,
  source_fixed_principal_sum INTEGER NOT NULL,
  target_fixed_principal_sum INTEGER NOT NULL,
  source_fixed_interest_sum INTEGER NOT NULL,
  target_fixed_interest_sum INTEGER NOT NULL,
  source_loan_principal_sum INTEGER NOT NULL,
  target_loan_principal_sum INTEGER NOT NULL,
  source_loan_debt_sum INTEGER NOT NULL,
  target_loan_debt_sum INTEGER NOT NULL,
  completed_at TEXT NOT NULL
);`;

// Part of globalEconomyV22Sql: idx_coin_fixed_deposits_global_user, idx_casino_loans_global_user,
// idx_casino_ledger_global_user, idx_chip_ledger_global_user
const globalLedgerIndexesV22Sql = `CREATE INDEX IF NOT EXISTS idx_coin_fixed_deposits_global_user
  ON coin_fixed_deposits (user_id, status, maturity_at);
CREATE INDEX IF NOT EXISTS idx_casino_loans_global_user
  ON casino_loans (user_id, status);
CREATE INDEX IF NOT EXISTS idx_casino_ledger_global_user
  ON casino_ledger (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chip_ledger_global_user
  ON chip_ledger (user_id, created_at DESC, id DESC);`;

// The v24 migration (persistent coin admin confirmations) creates this table inside its own
// transaction.
const coinAdminAddConfirmationsV24Sql = `
CREATE TABLE IF NOT EXISTS coin_admin_add_confirmations (
  operation_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('user', 'role')),
  actor_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  target_user_id TEXT,
  role_id TEXT,
  campaign_id TEXT,
  preview_token TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 9000000000),
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partial', 'completed', 'cancelled')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (mode = 'user' AND target_user_id IS NOT NULL AND role_id IS NULL
      AND campaign_id IS NULL AND preview_token IS NULL)
    OR
    (mode = 'role' AND target_user_id IS NULL AND role_id IS NOT NULL
      AND campaign_id IS NOT NULL AND preview_token IS NOT NULL)
  )
);
`;

// Created on every open, after the migrations: one global wallet revision per user.
const globalWalletRevisionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_transactions_global_wallet_revision
  ON coin_transactions (user_id, wallet_revision)
  WHERE wallet_scope = 'global';
`;

module.exports = {
  walletShopAndBankTablesSql,
  casinoLoanTablesSql,
  chipAndLuxuryTablesSql,
  walletShopAndArchiveIndexesSql,
  bankIndexesSql,
  casinoLoanIndexesSql,
  chipAndLuxuryIndexesSql,
  globalBankAndChipTablesV22Sql,
  operationAndCampaignTablesV22Sql,
  globalEconomyMigrationsTableV22Sql,
  globalLedgerIndexesV22Sql,
  coinAdminAddConfirmationsV24Sql,
  globalWalletRevisionIndexSql,
};
