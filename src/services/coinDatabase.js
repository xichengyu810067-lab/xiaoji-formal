const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const initSqlJs = require('sql.js');
const logger = require('../utils/logger');
const { deriveServerGameReward } = require('./gameRewardPolicy');

const rootPath = path.resolve(__dirname, '..', '..');
const defaultRelativeDbPath = path.join('data', 'xiaoji.sqlite');
const schemaVersion = 22;

const globalEconomyV22Sql = `
CREATE TABLE IF NOT EXISTS coin_bank_accounts_global (
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
);
CREATE TABLE IF NOT EXISTS reward_grants_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reward_key TEXT NOT NULL UNIQUE,
  operation_id TEXT UNIQUE,
  kind TEXT NOT NULL,
  canonical_source_id TEXT NOT NULL,
  reward_kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_guild_id TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  payload_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  debt_offset INTEGER NOT NULL DEFAULT 0 CHECK (debt_offset >= 0),
  net_amount INTEGER NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  transaction_id INTEGER NOT NULL,
  legacy_grant_id INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, reward_key),
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id),
  FOREIGN KEY (transaction_id) REFERENCES coin_transactions(id)
);
CREATE TABLE IF NOT EXISTS coin_operation_receipts (
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
);
CREATE TABLE IF NOT EXISTS coin_primary_jobs_global (
  user_id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  work_days INTEGER NOT NULL CHECK (work_days > 0),
  legacy_job_id INTEGER,
  source_guild_id TEXT,
  next_cycle_id TEXT UNIQUE,
  requested_at TEXT NOT NULL,
  not_before_at TEXT,
  effective_from TEXT,
  effective_until TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending_legacy', 'active', 'closed')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_primary_job_cycles (
  cycle_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  work_days INTEGER NOT NULL CHECK (work_days > 0),
  source_guild_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  salary_rule_version TEXT NOT NULL,
  salary_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'cancelled')),
  reward_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES coin_primary_jobs_global(user_id)
);
CREATE TABLE IF NOT EXISTS coin_primary_cycle_penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id INTEGER,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL,
  reason TEXT,
  applied_at TEXT,
  refunded_at TEXT,
  appeal_deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (cycle_id) REFERENCES coin_primary_job_cycles(cycle_id)
);
CREATE TABLE IF NOT EXISTS coin_primary_cycle_payroll (
  cycle_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  gross_amount INTEGER NOT NULL CHECK (gross_amount >= 0),
  paid_amount INTEGER NOT NULL CHECK (paid_amount >= 0),
  pay_ratio REAL NOT NULL CHECK (pay_ratio >= 0 AND pay_ratio <= 1),
  settlement_reason TEXT NOT NULL,
  reward_key TEXT NOT NULL UNIQUE,
  transaction_id INTEGER,
  settled_at TEXT NOT NULL,
  FOREIGN KEY (cycle_id) REFERENCES coin_primary_job_cycles(cycle_id)
);
CREATE TABLE IF NOT EXISTS coin_primary_cycle_penalty_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  penalty_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  review_by TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (penalty_id) REFERENCES coin_primary_cycle_penalties(id)
);
CREATE INDEX IF NOT EXISTS idx_primary_cycle_penalties
  ON coin_primary_cycle_penalties (cycle_id, status, id);
CREATE INDEX IF NOT EXISTS idx_primary_cycle_appeals
  ON coin_primary_cycle_penalty_appeals (penalty_id, status, id);
CREATE TABLE IF NOT EXISTS coin_work_legacy_snapshots (
  job_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  job_role_id TEXT,
  daily_salary INTEGER NOT NULL,
  work_days INTEGER NOT NULL,
  total_salary INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  pay_at TEXT NOT NULL,
  status TEXT NOT NULL,
  is_paid INTEGER NOT NULL,
  payroll_status TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  cutover_state_hash TEXT NOT NULL,
  snapshot_item_count INTEGER NOT NULL CHECK (snapshot_item_count >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_work_legacy_snapshot_items (
  job_id INTEGER NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('task', 'penalty', 'appeal', 'payroll')),
  item_id INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (job_id, item_kind, item_id),
  FOREIGN KEY (job_id) REFERENCES coin_work_legacy_snapshots(job_id)
);
CREATE TABLE IF NOT EXISTS coin_work_legacy_settlements (
  job_id INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  reward_key TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'legacy_paid', 'manual_review')),
  transaction_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, period_key, user_id)
);
CREATE TABLE IF NOT EXISTS discord_game_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  game_type TEXT NOT NULL,
  difficulty TEXT,
  seed TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0),
  score INTEGER NOT NULL DEFAULT 0,
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS discord_game_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  interaction_id TEXT NOT NULL UNIQUE,
  action_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, revision),
  FOREIGN KEY (session_id) REFERENCES discord_game_sessions(id)
);
CREATE TABLE IF NOT EXISTS discord_game_rewards (
  session_id TEXT PRIMARY KEY,
  reward_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'no_reward')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  receipt_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES discord_game_sessions(id)
);
CREATE TABLE IF NOT EXISTS coin_global_economy_migrations (
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
);
CREATE INDEX IF NOT EXISTS idx_reward_grants_v2_source
  ON reward_grants_v2 (kind, canonical_source_id, reward_kind, user_id);
CREATE INDEX IF NOT EXISTS idx_coin_fixed_deposits_global_user
  ON coin_fixed_deposits (user_id, status, maturity_at);
CREATE INDEX IF NOT EXISTS idx_casino_loans_global_user
  ON casino_loans (user_id, status);
CREATE INDEX IF NOT EXISTS idx_casino_ledger_global_user
  ON casino_ledger (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chip_ledger_global_user
  ON chip_ledger (user_id, created_at DESC, id DESC);
`;

const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coin_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_guild_settings (
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
);

CREATE TABLE IF NOT EXISTS coin_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  job_role_id TEXT,
  daily_salary INTEGER NOT NULL,
  work_days INTEGER NOT NULL,
  total_salary INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_paid INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  pay_at TEXT NOT NULL,
  actual_paid_at TEXT,
  last_contribution_at TEXT,
  last_reminder_at TEXT,
  today_task_count INTEGER NOT NULL DEFAULT 0,
  today_completed_task_count INTEGER NOT NULL DEFAULT 0,
  no_work_available_today INTEGER NOT NULL DEFAULT 0,
  payroll_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_work_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id INTEGER,
  job_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  description TEXT,
  attachment_urls TEXT,
  expected_channel_id TEXT,
  expected_channel_name TEXT,
  message_id TEXT,
  external_server_count INTEGER NOT NULL DEFAULT 0,
  external_server_ids TEXT,
  reviewed_by TEXT,
  review_reason TEXT,
  is_paid INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TEXT
);

CREATE TABLE IF NOT EXISTS coin_payroll_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  base_salary INTEGER NOT NULL,
  total_tasks INTEGER NOT NULL,
  completed_tasks INTEGER NOT NULL,
  pay_ratio REAL NOT NULL,
  paid_amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_work_penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  task_id INTEGER,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  source_channel_id TEXT,
  penalty_date TEXT NOT NULL,
  daily_salary INTEGER NOT NULL DEFAULT 0,
  penalty_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT NOT NULL,
  announced_at TEXT,
  announcement_channel_id TEXT,
  announcement_message_id TEXT,
  appeal_deadline_at TEXT NOT NULL,
  applied_at TEXT,
  refunded_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_work_penalty_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  penalty_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'chip',
  bet_amount INTEGER NOT NULL,
  payout_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'settled',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_blackjack_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  currency TEXT NOT NULL DEFAULT 'chip',
  bet_amount INTEGER NOT NULL,
  deck_json TEXT NOT NULL,
  player_hand_json TEXT NOT NULL,
  dealer_hand_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  payout_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS casino_loans (
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
);

CREATE TABLE IF NOT EXISTS casino_venue_menu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_by TEXT,
  deleted_at TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS casino_venue_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  channel_id TEXT,
  waiter_user_id TEXT,
  waiter_job_id INTEGER,
  waiter_job_name TEXT,
  waiter_assigned_at TEXT,
  waiter_due_at TEXT,
  tip_amount INTEGER NOT NULL DEFAULT 0,
  tip_status TEXT NOT NULL DEFAULT 'none',
  tip_paid_at TEXT,
  tip_refunded_at TEXT,
  served_at TEXT,
  served_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_venue_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  menu_item_id INTEGER,
  item_name TEXT NOT NULL,
  standard_steps TEXT NOT NULL,
  maker_user_id TEXT,
  maker_job_id INTEGER,
  maker_job_name TEXT,
  maker_is_npc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  actual_steps TEXT,
  service_date TEXT,
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  bonus_paid INTEGER NOT NULL DEFAULT 0,
  completion_message_id TEXT,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS chip_accounts (
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
);

CREATE TABLE IF NOT EXISTS casino_lodging_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_type TEXT NOT NULL,
  room_name TEXT NOT NULL,
  nights INTEGER NOT NULL,
  chip_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  check_in_at TEXT NOT NULL,
  check_out_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_duel_tower_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  weapon_item_id TEXT NOT NULL,
  weapon_name TEXT NOT NULL,
  wager_amount INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  opponent_name TEXT NOT NULL,
  player_power INTEGER NOT NULL,
  opponent_power INTEGER NOT NULL,
  status TEXT NOT NULL,
  payout_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_guild_settings (
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  channel_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, feature_key)
);

CREATE TABLE IF NOT EXISTS feature_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered')),
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_until TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, feature_key, event_type, dedupe_key)
);

CREATE TABLE IF NOT EXISTS feature_outbox_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_event_id INTEGER NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  dead_letter_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reward_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reward_kind TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  metadata TEXT,
  transaction_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, source_type, source_id, reward_kind)
);

CREATE TABLE IF NOT EXISTS feature_usage_daily (
  usage_date TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, feature_key, metric_key)
);

CREATE TABLE IF NOT EXISTS feature_health (
  feature_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('normal', 'maintenance', 'broken')),
  detail TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_chat_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  style TEXT NOT NULL DEFAULT 'cute' CHECK (style IN ('cute', 'mature_sister', 'ceo', 'cold', 'tsundere', 'yandere')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_romance_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  started_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  launch_token_hash TEXT NOT NULL UNIQUE,
  access_token_hash TEXT UNIQUE,
  launch_consumed_at TEXT,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game_type TEXT NOT NULL CHECK (game_type IN ('tetris', 'number-match', 'sudoku')),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'complex', 'hard')),
  seed TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'failed')),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0 AND action_count <= 500),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 20000),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0 AND reward_amount <= 1000),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS game_actions (
  session_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK (action_index >= 0 AND action_index < 500),
  action_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, action_index),
  FOREIGN KEY (session_id) REFERENCES game_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_rewards (
  session_id TEXT PRIMARY KEY NOT NULL,
  reward_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'no_reward')),
  amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES game_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_releases (
  release_id TEXT PRIMARY KEY NOT NULL,
  repository TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  version_major INTEGER NOT NULL CHECK (version_major >= 0),
  version_minor INTEGER NOT NULL CHECK (version_minor >= 0),
  version_patch INTEGER NOT NULL CHECK (version_patch >= 0),
  release_name TEXT NOT NULL,
  body_summary TEXT NOT NULL,
  html_url TEXT NOT NULL,
  metadata_digest TEXT NOT NULL CHECK (length(metadata_digest) = 64),
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository, tag_name)
);

CREATE TABLE IF NOT EXISTS release_announcement_deliveries (
  release_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'dead_letter', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  last_error TEXT,
  nonce TEXT NOT NULL UNIQUE,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (release_id, guild_id),
  FOREIGN KEY (release_id) REFERENCES github_releases(release_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS text_chain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  current_word TEXT NOT NULL,
  last_word TEXT NOT NULL,
  last_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_by TEXT NOT NULL,
  stopped_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS text_chain_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  word TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (message_id)
);

CREATE TABLE IF NOT EXISTS number_chain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  expected_target INTEGER NOT NULL CHECK (expected_target >= 1 AND expected_target <= 9007199254740991),
  last_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_by TEXT NOT NULL,
  stopped_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS number_chain_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expression TEXT NOT NULL,
  result INTEGER NOT NULL CHECK (result >= 1 AND result <= 9007199254740991),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('riddle', 'discussion')),
  local_date TEXT NOT NULL,
  riddle_id TEXT,
  parent_channel_id TEXT NOT NULL,
  announcement_message_id TEXT,
  thread_id TEXT,
  answer_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'published', 'published_late', 'settling', 'rewarding', 'settled', 'blocked', 'missed', 'failed')),
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  publish_marker TEXT NOT NULL,
  answer_marker TEXT NOT NULL,
  published_at TEXT,
  history_reconciled_at TEXT,
  settled_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  publish_lease_owner TEXT,
  publish_lease_until TEXT,
  settle_lease_owner TEXT,
  settle_lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, event_kind, local_date)
);

CREATE TABLE IF NOT EXISTS daily_event_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  UNIQUE (event_id, message_id)
);

CREATE TABLE IF NOT EXISTS daily_event_participants (
  event_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  participation_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (participation_reward_status IN ('pending', 'granted')),
  correct_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (correct_reward_status IN ('pending', 'granted', 'not_earned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_coin_wallets_balance
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
  ON coin_admin_logs (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_jobs_pay_at
  ON coin_jobs (pay_at, status, is_paid);

CREATE INDEX IF NOT EXISTS idx_coin_jobs_user
  ON coin_jobs (guild_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_coin_fixed_deposits_user
  ON coin_fixed_deposits (guild_id, user_id, status, maturity_at);

CREATE INDEX IF NOT EXISTS idx_coin_rate_history_guild
  ON coin_rate_history (guild_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_tasks_user
  ON coin_work_tasks (guild_id, user_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_coin_payroll_history_guild
  ON coin_payroll_history (guild_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalties_user
  ON coin_work_penalties (guild_id, user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalties_daily
  ON coin_work_penalties (guild_id, user_id, job_id, penalty_date, status);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalty_appeals_penalty
  ON coin_work_penalty_appeals (guild_id, penalty_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_casino_games_user
  ON casino_games (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_blackjack_sessions_user
  ON casino_blackjack_sessions (guild_id, user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_casino_loans_user
  ON casino_loans (guild_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_casino_ledger_user
  ON casino_ledger (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_venue_menu_guild
  ON casino_venue_menu (guild_id, item_type, deleted, id);

CREATE INDEX IF NOT EXISTS idx_casino_venue_orders_customer
  ON casino_venue_orders (guild_id, customer_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_venue_order_items_status
  ON casino_venue_order_items (guild_id, status, completed_at, id);

CREATE INDEX IF NOT EXISTS idx_casino_venue_order_items_maker
  ON casino_venue_order_items (guild_id, maker_user_id, item_type, service_date, id);

CREATE INDEX IF NOT EXISTS idx_chip_ledger_user
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
  ON luxury_global_pawn_records (user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_lodging_bookings_user
  ON casino_lodging_bookings (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_duel_tower_runs_user
  ON casino_duel_tower_runs (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feature_outbox_claim
  ON feature_outbox (status, available_at, lease_until, id);

CREATE INDEX IF NOT EXISTS idx_text_chain_sessions_active
  ON text_chain_sessions (guild_id, channel_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_text_chain_entries_session_word
  ON text_chain_entries (session_id, word);

CREATE INDEX IF NOT EXISTS idx_number_chain_sessions_active
  ON number_chain_sessions (guild_id, channel_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_number_chain_entries_session_result
  ON number_chain_entries (session_id, result);

CREATE INDEX IF NOT EXISTS idx_daily_events_due
  ON daily_events (status, window_end_at, guild_id, id);

CREATE INDEX IF NOT EXISTS idx_github_releases_order
  ON github_releases (version_major, version_minor, version_patch, published_at, release_id);

CREATE INDEX IF NOT EXISTS idx_release_announcement_claim
  ON release_announcement_deliveries (status, next_attempt_at, lease_until, attempt_count, release_id, guild_id);

CREATE INDEX IF NOT EXISTS idx_daily_event_messages_window
  ON daily_event_messages (event_id, created_at, message_id);

CREATE INDEX IF NOT EXISTS idx_daily_event_participants_reward
  ON daily_event_participants (event_id, eligible, correct, user_id);

CREATE INDEX IF NOT EXISTS idx_reward_grants_source
  ON reward_grants (guild_id, source_type, source_id, reward_kind);

CREATE INDEX IF NOT EXISTS idx_feature_usage_daily_feature
  ON feature_usage_daily (feature_key, usage_date DESC, metric_key);
`;

const wordChainActiveSessionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_text_chain_one_active_guild
  ON text_chain_sessions (guild_id)
  WHERE status = 'active';
`;

const numberChainActiveSessionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_number_chain_one_active_guild
  ON number_chain_sessions (guild_id)
  WHERE status = 'active';
`;

const globalWalletRevisionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_transactions_global_wallet_revision
  ON coin_transactions (user_id, wallet_revision)
  WHERE wallet_scope = 'global';
`;

let sqlModulePromise = null;
let initializationPromise = null;
let state = null;
let operationQueue = Promise.resolve();
let allowCreateOnNextOpenForTests = false;

class CoinDatabaseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CoinDatabaseError';
    this.cause = cause;
  }
}

function getCoinDatabasePath() {
  const configuredPath = String(process.env.COIN_DB_PATH || '').trim();
  const databasePath = configuredPath || defaultRelativeDbPath;

  if (path.isAbsolute(databasePath)) {
    return path.normalize(databasePath);
  }

  return path.resolve(rootPath, databasePath);
}

async function getSqlModule() {
  if (!sqlModulePromise) {
    const distPath = path.dirname(require.resolve('sql.js'));
    sqlModulePromise = initSqlJs({
      locateFile: (fileName) => path.join(distPath, fileName),
    });
  }

  return sqlModulePromise;
}

function getRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function getRow(db, sql, params = []) {
  return getRows(db, sql, params)[0] || null;
}

function runSql(db, sql, params = []) {
  if (params.length === 0) {
    db.run(sql);
    return;
  }

  db.run(sql, params);
}

function getTableNames(db) {
  return new Set(
    getRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map((row) => row.name)
  );
}

function getColumnNames(db, tableName) {
  return getRows(db, `PRAGMA table_info(${tableName})`).map((column) => column.name);
}

function getTableColumns(db, tableName) {
  return getRows(db, `PRAGMA table_info(${tableName})`).map((column) => ({
    name: column.name,
    type: String(column.type || '').trim().toUpperCase(),
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value == null ? null : String(column.dflt_value).trim(),
    primaryKeyPosition: Number(column.pk),
  }));
}

function addColumnIfMissing(db, tableName, columnName, columnDefinition) {
  const columns = getColumnNames(db, tableName);

  if (!columns.includes(columnName)) {
    runSql(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function hasUniqueIndex(db, tableName, expectedColumns) {
  const indexes = getRows(db, `PRAGMA index_list(${tableName})`).filter((index) => Number(index.unique) === 1);

  return indexes.some((index) => {
    const quotedIndexName = `"${String(index.name).replaceAll('"', '""')}"`;
    const columns = getRows(db, `PRAGMA index_info(${quotedIndexName})`).map((column) => column.name);
    return columns.length === expectedColumns.length && columns.every((column, index) => column === expectedColumns[index]);
  });
}

function getTableDefinition(db, tableName) {
  const row = getRow(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);

  if (!row?.sql) {
    throw new Error(`${tableName} is missing its table definition`);
  }

  return String(row.sql)
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
}

function verifyTableContract(db, tableName, requiredColumns, requiredChecks) {
  const actualColumns = new Map(getTableColumns(db, tableName).map((column) => [column.name, column]));

  for (const [columnName, expected] of Object.entries(requiredColumns)) {
    const actual = actualColumns.get(columnName);

    if (!actual) {
      throw new Error(`${tableName} is missing required column: ${columnName}`);
    }

    if (
      actual.type !== expected.type ||
      actual.notNull !== expected.notNull ||
      actual.defaultValue !== expected.defaultValue ||
      actual.primaryKeyPosition !== expected.primaryKeyPosition
    ) {
      throw new Error(`${tableName}.${columnName} does not match its required schema contract`);
    }
  }

  const definition = getTableDefinition(db, tableName);
  for (const check of requiredChecks) {
    if (!definition.includes(check)) {
      throw new Error(`${tableName} is missing required CHECK constraint: ${check}`);
    }
  }
}

function verifyFeaturePlatformSchema(db) {
  const text = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'TEXT',
    notNull,
    defaultValue,
    primaryKeyPosition,
  });
  const integer = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'INTEGER',
    notNull,
    defaultValue,
    primaryKeyPosition,
  });
  const tableContracts = {
    feature_guild_settings: {
      columns: {
        guild_id: text(true, null, 1),
        feature_key: text(true, null, 2),
        enabled: integer(true, '0'),
        channel_id: text(),
        config_json: text(true, "'{}'"),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: ['check(enabledin(0,1))'],
    },
    feature_outbox: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        feature_key: text(true),
        event_type: text(true),
        dedupe_key: text(true),
        payload_json: text(true),
        status: text(true, "'pending'"),
        available_at: text(true),
        attempt_count: integer(true, '0'),
        claimed_by: text(),
        claimed_at: text(),
        lease_until: text(),
        delivered_at: text(),
        last_error: text(),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: ["check(statusin('pending','processing','delivered'))"],
    },
    feature_outbox_dead_letters: {
      columns: {
        id: integer(false, null, 1),
        original_event_id: integer(true),
        guild_id: text(true),
        feature_key: text(true),
        event_type: text(true),
        dedupe_key: text(true),
        payload_json: text(true),
        attempt_count: integer(true),
        last_error: text(true),
        dead_letter_reason: text(true),
        created_at: text(true),
      },
      checks: [],
    },
    reward_grants: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        user_id: text(true),
        source_type: text(true),
        source_id: text(true),
        reward_kind: text(true),
        amount: integer(true),
        metadata: text(),
        transaction_id: integer(),
        created_at: text(true),
      },
      checks: ['check(amount>0)'],
    },
    feature_usage_daily: {
      columns: {
        usage_date: text(true, null, 1),
        feature_key: text(true, null, 2),
        metric_key: text(true, null, 3),
        usage_count: integer(true, '0'),
        updated_at: text(true),
      },
      checks: ['check(usage_count>=0)'],
    },
    feature_health: {
      columns: {
        feature_key: text(false, null, 1),
        status: text(true),
        detail: text(),
        updated_at: text(true),
      },
      checks: ["check(statusin('normal','maintenance','broken'))"],
    },
    user_chat_preferences: {
      columns: {
        user_id: text(true, null, 1),
        style: text(true, "'cute'"),
        updated_at: text(true),
      },
      checks: ["check(stylein('cute','mature_sister','ceo','cold','tsundere','yandere'))"],
    },
    user_romance_preferences: {
      columns: {
        user_id: text(true, null, 1),
        enabled: integer(true, '0'),
        started_at: text(),
        updated_at: text(true),
      },
      checks: ['check(enabledin(0,1))'],
    },
    game_sessions: {
      columns: {
        id: text(true, null, 1), launch_token_hash: text(true), access_token_hash: text(), launch_consumed_at: text(),
        user_id: text(true), guild_id: text(true), channel_id: text(true), game_type: text(true), difficulty: text(true),
        seed: text(true), state_json: text(true), status: text(true, "'active'"), action_count: integer(true, '0'),
        score: integer(true, '0'), reward_amount: integer(true, '0'), expires_at: text(true), created_at: text(true),
        updated_at: text(true), completed_at: text(),
      },
      checks: ["check(game_typein('tetris','number-match','sudoku'))", "check(difficultyin('easy','normal','complex','hard'))", "check(statusin('active','completed','expired','failed'))", 'check(action_count>=0andaction_count<=500)', 'check(score>=0andscore<=20000)', 'check(reward_amount>=0andreward_amount<=1000)'],
    },
    game_actions: {
      columns: { session_id: text(true, null, 1), action_index: integer(true, null, 2), action_hash: text(true), state_json: text(true), created_at: text(true) },
      checks: ['check(action_index>=0andaction_index<500)'],
    },
    game_rewards: {
      columns: { session_id: text(true, null, 1), reward_key: text(true), status: text(true, "'pending'"), amount: integer(true), created_at: text(true), updated_at: text(true) },
      checks: ["check(statusin('pending','granted','no_reward'))", 'check(amount>=0andamount<=1000)'],
    },
    github_releases: {
      columns: {
        release_id: text(true, null, 1), repository: text(true), tag_name: text(true),
        version_major: integer(true), version_minor: integer(true), version_patch: integer(true),
        release_name: text(true), body_summary: text(true), html_url: text(true), metadata_digest: text(true),
        published_at: text(true), discovered_at: text(true), updated_at: text(true),
      },
      checks: [
        'check(version_major>=0)', 'check(version_minor>=0)', 'check(version_patch>=0)',
        'check(length(metadata_digest)=64)',
      ],
    },
    release_announcement_deliveries: {
      columns: {
        release_id: text(true, null, 1), guild_id: text(true, null, 2), status: text(true, "'pending'"),
        attempt_count: integer(true, '0'), next_attempt_at: text(true), lease_owner: text(), lease_until: text(), last_error: text(),
        nonce: text(true), delivered_at: text(), created_at: text(true), updated_at: text(true),
      },
      checks: [
        "check(statusin('pending','processing','delivered','dead_letter','suppressed'))",
        'check(attempt_count>=0andattempt_count<=5)',
      ],
    },
    text_chain_sessions: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        channel_id: text(true),
        status: text(true, "'active'"),
        current_word: text(true),
        last_word: text(true),
        last_user_id: text(),
        revision: integer(true, '0'),
        started_by: text(true),
        stopped_by: text(),
        created_at: text(true),
        updated_at: text(true),
        stopped_at: text(),
        completed_at: text(),
      },
      checks: ["check(statusin('active','stopped','completed'))", 'check(revision>=0)'],
    },
    text_chain_entries: {
      columns: {
        id: integer(false, null, 1),
        session_id: integer(true),
        guild_id: text(true),
        channel_id: text(true),
        message_id: text(true),
        user_id: text(true),
        word: text(true),
        created_at: text(true),
      },
      checks: [],
    },
    number_chain_sessions: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        channel_id: text(true),
        status: text(true, "'active'"),
        expected_target: integer(true),
        last_user_id: text(),
        revision: integer(true, '0'),
        started_by: text(true),
        stopped_by: text(),
        created_at: text(true),
        updated_at: text(true),
        stopped_at: text(),
        completed_at: text(),
      },
      checks: ["check(statusin('active','stopped','completed'))", 'check(expected_target>=1andexpected_target<=9007199254740991)', 'check(revision>=0)'],
    },
    number_chain_entries: {
      columns: {
        id: integer(false, null, 1),
        session_id: integer(true),
        guild_id: text(true),
        channel_id: text(true),
        message_id: text(true),
        user_id: text(true),
        expression: text(true),
        result: integer(true),
        created_at: text(true),
      },
      checks: ['check(result>=1andresult<=9007199254740991)'],
    },
    daily_events: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        event_kind: text(true),
        local_date: text(true),
        riddle_id: text(),
        parent_channel_id: text(true),
        announcement_message_id: text(),
        thread_id: text(),
        answer_message_id: text(),
        status: text(true, "'claimed'"),
        window_start_at: text(true),
        window_end_at: text(true),
        publish_marker: text(true),
        answer_marker: text(true),
        published_at: text(),
        history_reconciled_at: text(),
        settled_at: text(),
        attempt_count: integer(true, '0'),
        publish_lease_owner: text(),
        publish_lease_until: text(),
        settle_lease_owner: text(),
        settle_lease_until: text(),
        last_error: text(),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: [
        "check(event_kindin('riddle','discussion'))",
        "check(statusin('claimed','published','published_late','settling','rewarding','settled','blocked','missed','failed'))",
        'check(attempt_count>=0)',
      ],
    },
    daily_event_messages: {
      columns: {
        id: integer(false, null, 1),
        event_id: integer(true),
        guild_id: text(true),
        thread_id: text(true),
        message_id: text(true),
        user_id: text(true),
        created_at: text(true),
        eligible: integer(true, '0'),
        correct: integer(true, '0'),
      },
      checks: ['check(eligiblein(0,1))', 'check(correctin(0,1))'],
    },
    daily_event_participants: {
      columns: {
        event_id: integer(true, null, 1),
        guild_id: text(true),
        user_id: text(true, null, 2),
        eligible: integer(true, '0'),
        correct: integer(true, '0'),
        participation_reward_status: text(true, "'pending'"),
        correct_reward_status: text(true, "'pending'"),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: [
        'check(eligiblein(0,1))',
        'check(correctin(0,1))',
        "check(participation_reward_statusin('pending','granted'))",
        "check(correct_reward_statusin('pending','granted','not_earned'))",
      ],
    },
  };

  for (const [tableName, contract] of Object.entries(tableContracts)) {
    verifyTableContract(db, tableName, contract.columns, contract.checks);
  }

  const preferenceColumns = getColumnNames(db, 'user_chat_preferences');
  if (JSON.stringify(preferenceColumns) !== JSON.stringify(['user_id', 'style', 'updated_at'])) {
    throw new Error('user_chat_preferences must contain only its global, non-message preference fields');
  }

  const romancePreferenceColumns = getColumnNames(db, 'user_romance_preferences');
  if (JSON.stringify(romancePreferenceColumns) !== JSON.stringify(['user_id', 'enabled', 'started_at', 'updated_at'])) {
    throw new Error('user_romance_preferences must contain only its global, non-message preference fields');
  }

  for (const [tableName, expected] of [
    ['game_sessions', ['id','launch_token_hash','access_token_hash','launch_consumed_at','user_id','guild_id','channel_id','game_type','difficulty','seed','state_json','status','action_count','score','reward_amount','expires_at','created_at','updated_at','completed_at']],
    ['game_actions', ['session_id','action_index','action_hash','state_json','created_at']],
    ['game_rewards', ['session_id','reward_key','status','amount','created_at','updated_at']],
  ]) {
    if (JSON.stringify(getColumnNames(db, tableName)) !== JSON.stringify(expected)) throw new Error(`${tableName} has an unsafe schema shape`);
  }
  for (const tableName of ['game_actions', 'game_rewards']) {
    const foreignKey = getRows(db, `PRAGMA foreign_key_list(${tableName})`).find((row) => row.table === 'game_sessions' && row.from === 'session_id' && row.to === 'id' && String(row.on_delete).toUpperCase() === 'CASCADE');
    if (!foreignKey) throw new Error(`${tableName} is missing its session foreign key`);
  }
  const releaseForeignKey = getRows(db, 'PRAGMA foreign_key_list(release_announcement_deliveries)')
    .find((row) => row.table === 'github_releases' && row.from === 'release_id' && row.to === 'release_id' && String(row.on_delete).toUpperCase() === 'CASCADE');
  if (!releaseForeignKey) throw new Error('release_announcement_deliveries is missing its release foreign key');

  for (const [tableName, columns] of [
    ['feature_guild_settings', ['guild_id', 'feature_key']],
    ['feature_outbox', ['guild_id', 'feature_key', 'event_type', 'dedupe_key']],
    ['feature_outbox_dead_letters', ['original_event_id']],
    ['reward_grants', ['guild_id', 'user_id', 'source_type', 'source_id', 'reward_kind']],
    ['feature_usage_daily', ['usage_date', 'feature_key', 'metric_key']],
    ['text_chain_entries', ['message_id']],
    ['number_chain_entries', ['message_id']],
    ['daily_events', ['guild_id', 'event_kind', 'local_date']],
    ['daily_event_messages', ['event_id', 'message_id']],
    ['daily_event_participants', ['event_id', 'user_id']],
    ['game_sessions', ['launch_token_hash']],
    ['game_sessions', ['access_token_hash']],
    ['game_actions', ['session_id', 'action_index']],
    ['game_rewards', ['reward_key']],
    ['github_releases', ['repository', 'tag_name']],
    ['release_announcement_deliveries', ['release_id', 'guild_id']],
    ['release_announcement_deliveries', ['nonce']],
  ]) {
    if (!hasUniqueIndex(db, tableName, columns)) {
      throw new Error(`${tableName} is missing its required unique key`);
    }
  }

  const activeSessionIndex = getRow(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_text_chain_one_active_guild'"
  )?.sql;
  const normalizedActiveSessionIndex = String(activeSessionIndex || '')
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
  if (!normalizedActiveSessionIndex.includes("uniqueindexidx_text_chain_one_active_guildontext_chain_sessions(guild_id)wherestatus='active'")) {
    throw new Error('text_chain_sessions is missing the one-active-session-per-guild unique index');
  }
  const activeNumberSessionIndex = getRow(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_number_chain_one_active_guild'"
  )?.sql;
  const normalizedActiveNumberSessionIndex = String(activeNumberSessionIndex || '')
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
  if (!normalizedActiveNumberSessionIndex.includes("uniqueindexidx_number_chain_one_active_guildonnumber_chain_sessions(guild_id)wherestatus='active'")) {
    throw new Error('number_chain_sessions is missing the one-active-session-per-guild unique index');
  }
}

function assertForeignKeysEnabled(db) {
  if (Number(getRow(db, 'PRAGMA foreign_keys')?.foreign_keys) !== 1) {
    throw new Error('SQLite foreign key enforcement is disabled');
  }
}

function enableForeignKeys(db) {
  runSql(db, 'PRAGMA foreign_keys = ON');
  assertForeignKeysEnabled(db);
}

function verifyForeignKeyIntegrity(db) {
  const violation = getRow(db, 'PRAGMA foreign_key_check');
  if (violation) throw new Error(`SQLite foreign key violation in ${violation.table}`);
}

function exportDatabase(db) {
  assertForeignKeysEnabled(db);
  try {
    return Buffer.from(db.export());
  } finally {
    // sql.js reopens the connection during export and resets connection-local PRAGMAs.
    enableForeignKeys(db);
  }
}

function writeDatabaseFile(dbPath, db) {
  const directory = path.dirname(dbPath);
  const tempPath = `${dbPath}.tmp`;
  const exported = exportDatabase(db);

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, exported);
    fs.renameSync(tempPath, dbPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (cleanupError) {
      logger.error(`吉幣資料庫暫存檔清理失敗：${tempPath}`, cleanupError);
    }
    throw error;
  }
}

function writeNewDatabaseFile(dbPath, db) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, exportDatabase(db), { flag: 'wx' });
}

function verifyIntegrity(db) {
  const result = getRow(db, 'PRAGMA integrity_check');
  const value = result?.integrity_check;

  if (value !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${value || 'unknown result'}`);
  }
}

function getColumnNameSet(db, tableName) {
  return new Set(getRows(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

function requireColumns(db, tableName, requiredColumns) {
  const columns = getColumnNameSet(db, tableName);
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`${tableName} is missing required columns: ${missing.join(', ')}`);
  }
}

function safeAdd(left, right, label) {
  const value = Number(left) + Number(right);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} exceeds the supported non-negative safe-integer range`);
  }
  return value;
}

function canonicalLegacyWalletSource(rows) {
  return rows.map((row) => ({
    guild_id: String(row.guild_id),
    user_id: String(row.user_id),
    balance: Number(row.balance),
    bank_balance: Number(row.bank_balance),
    bank_interest_accrued: Number(row.bank_interest_accrued),
    last_interest_date: row.last_interest_date == null ? null : String(row.last_interest_date),
    total_earned: Number(row.total_earned),
    total_spent: Number(row.total_spent),
    last_daily_date: row.last_daily_date == null ? null : String(row.last_daily_date),
    daily_streak: Number(row.daily_streak),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

function migrateGlobalWalletV20(db, currentVersion) {
  if (currentVersion >= 20) return false;

  requireColumns(db, 'coin_players', [
    'guild_id', 'user_id', 'balance', 'bank_balance', 'bank_interest_accrued', 'last_interest_date',
    'total_earned', 'total_spent', 'last_daily_date', 'daily_streak', 'created_at', 'updated_at',
  ]);
  requireColumns(db, 'coin_wallets', [
    'user_id', 'balance', 'total_earned', 'total_spent', 'revision', 'created_at', 'updated_at',
  ]);
  requireColumns(db, 'coin_guild_players', [
    'guild_id', 'user_id', 'bank_balance', 'bank_interest_accrued', 'last_interest_date',
    'last_daily_date', 'daily_streak', 'created_at', 'updated_at',
  ]);
  requireColumns(db, 'coin_wallet_migrations', [
    'from_version', 'to_version', 'source_row_count', 'source_distinct_user_count',
    'source_balance_sum', 'source_total_earned_sum', 'source_total_spent_sum', 'source_sha256', 'completed_at',
  ]);

  if (getRow(db, 'SELECT 1 AS found FROM coin_wallet_migrations WHERE to_version = 20')) {
    throw new Error('schema is below v20 but a completed v20 wallet migration already exists');
  }
  const preexistingTargetRows = Number(getRow(
    db,
    'SELECT (SELECT COUNT(*) FROM coin_wallets) + (SELECT COUNT(*) FROM coin_guild_players) AS count'
  ).count);
  if (preexistingTargetRows !== 0) {
    throw new Error('v20 wallet target tables must be empty before migration');
  }

  const sourceRows = canonicalLegacyWalletSource(getRows(
    db,
    `SELECT guild_id, user_id, balance, bank_balance, bank_interest_accrued, last_interest_date,
            total_earned, total_spent, last_daily_date, daily_streak, created_at, updated_at
     FROM coin_players
     ORDER BY user_id, guild_id`
  ));
  const wallets = new Map();
  let balanceSum = 0;
  let earnedSum = 0;
  let spentSum = 0;

  for (const row of sourceRows) {
    for (const [field, value] of [
      ['balance', row.balance], ['bank_balance', row.bank_balance], ['total_earned', row.total_earned],
      ['total_spent', row.total_spent], ['daily_streak', row.daily_streak],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`coin_players ${field} contains an invalid value for ${row.guild_id}/${row.user_id}`);
      }
    }
    if (!Number.isFinite(row.bank_interest_accrued) || row.bank_interest_accrued < 0) {
      throw new Error(`coin_players bank_interest_accrued contains an invalid value for ${row.guild_id}/${row.user_id}`);
    }
    if (!row.guild_id || !row.user_id || !row.created_at || !row.updated_at) {
      throw new Error('coin_players contains an invalid identity or timestamp');
    }

    balanceSum = safeAdd(balanceSum, row.balance, 'global balance sum');
    earnedSum = safeAdd(earnedSum, row.total_earned, 'global total-earned sum');
    spentSum = safeAdd(spentSum, row.total_spent, 'global total-spent sum');
    const current = wallets.get(row.user_id) || {
      userId: row.user_id,
      balance: 0,
      totalEarned: 0,
      totalSpent: 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    current.balance = safeAdd(current.balance, row.balance, `balance for ${row.user_id}`);
    current.totalEarned = safeAdd(current.totalEarned, row.total_earned, `total earned for ${row.user_id}`);
    current.totalSpent = safeAdd(current.totalSpent, row.total_spent, `total spent for ${row.user_id}`);
    if (row.created_at < current.createdAt) current.createdAt = row.created_at;
    if (row.updated_at > current.updatedAt) current.updatedAt = row.updated_at;
    wallets.set(row.user_id, current);
  }

  const sourceSha256 = crypto.createHash('sha256').update(JSON.stringify(sourceRows)).digest('hex');
  const transactionCountBefore = Number(getRow(db, 'SELECT COUNT(*) AS count FROM coin_transactions').count);
  const transactionIdSumBefore = Number(getRow(db, 'SELECT COALESCE(SUM(id), 0) AS total FROM coin_transactions').total);
  const linkedGrantCountBefore = Number(getRow(db, 'SELECT COUNT(*) AS count FROM reward_grants WHERE transaction_id IS NOT NULL').count);
  let transactionStarted = false;

  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    addColumnIfMissing(
      db,
      'coin_transactions',
      'wallet_scope',
      "TEXT NOT NULL DEFAULT 'guild_legacy' CHECK (wallet_scope IN ('guild_legacy', 'global'))"
    );
    addColumnIfMissing(db, 'coin_transactions', 'wallet_revision', 'INTEGER');

    for (const wallet of wallets.values()) {
      runSql(
        db,
        `INSERT INTO coin_wallets
          (user_id, balance, total_earned, total_spent, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [wallet.userId, wallet.balance, wallet.totalEarned, wallet.totalSpent, wallet.createdAt, wallet.updatedAt]
      );
    }
    for (const row of sourceRows) {
      runSql(
        db,
        `INSERT INTO coin_guild_players
          (guild_id, user_id, bank_balance, bank_interest_accrued, last_interest_date,
           last_daily_date, daily_streak, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.guild_id, row.user_id, row.bank_balance, row.bank_interest_accrued, row.last_interest_date,
          row.last_daily_date, row.daily_streak, row.created_at, row.updated_at,
        ]
      );
    }

    const timestamp = new Date().toISOString();
    runSql(
      db,
      `INSERT INTO coin_wallet_migrations
        (from_version, to_version, source_row_count, source_distinct_user_count,
         source_balance_sum, source_total_earned_sum, source_total_spent_sum, source_sha256, completed_at)
       VALUES (?, 20, ?, ?, ?, ?, ?, ?, ?)`,
      [currentVersion, sourceRows.length, wallets.size, balanceSum, earnedSum, spentSum, sourceSha256, timestamp]
    );

    const migratedCounts = getRow(
      db,
      `SELECT (SELECT COUNT(*) FROM coin_wallets) AS wallets,
              (SELECT COUNT(*) FROM coin_guild_players) AS guild_players,
              (SELECT COALESCE(SUM(balance), 0) FROM coin_wallets) AS balance_sum,
              (SELECT COALESCE(SUM(total_earned), 0) FROM coin_wallets) AS earned_sum,
              (SELECT COALESCE(SUM(total_spent), 0) FROM coin_wallets) AS spent_sum`
    );
    if (
      Number(migratedCounts.wallets) !== wallets.size ||
      Number(migratedCounts.guild_players) !== sourceRows.length ||
      Number(migratedCounts.balance_sum) !== balanceSum ||
      Number(migratedCounts.earned_sum) !== earnedSum ||
      Number(migratedCounts.spent_sum) !== spentSum
    ) {
      throw new Error('v20 wallet migration aggregate verification failed');
    }
    for (const wallet of wallets.values()) {
      const migrated = getRow(
        db,
        'SELECT balance, total_earned, total_spent FROM coin_wallets WHERE user_id = ?',
        [wallet.userId]
      );
      if (
        Number(migrated?.balance) !== wallet.balance ||
        Number(migrated?.total_earned) !== wallet.totalEarned ||
        Number(migrated?.total_spent) !== wallet.totalSpent
      ) {
        throw new Error(`v20 wallet migration verification failed for ${wallet.userId}`);
      }
    }
    if (
      Number(getRow(db, 'SELECT COUNT(*) AS count FROM coin_transactions').count) !== transactionCountBefore ||
      Number(getRow(db, 'SELECT COALESCE(SUM(id), 0) AS total FROM coin_transactions').total) !== transactionIdSumBefore ||
      Number(getRow(db, 'SELECT COUNT(*) AS count FROM reward_grants WHERE transaction_id IS NOT NULL').count) !== linkedGrantCountBefore
    ) {
      throw new Error('v20 wallet migration changed legacy transaction or reward-grant identity');
    }
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Global wallet v20 migration rollback failed', rollbackError); }
    }
    throw error;
  }
}

function verifyGlobalWalletV20Schema(db) {
  const text = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'TEXT', notNull, defaultValue, primaryKeyPosition,
  });
  const integer = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'INTEGER', notNull, defaultValue, primaryKeyPosition,
  });
  const real = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'REAL', notNull, defaultValue, primaryKeyPosition,
  });
  verifyTableContract(db, 'coin_wallets', {
    user_id: text(false, null, 1),
    balance: integer(true, '0'),
    total_earned: integer(true, '0'),
    total_spent: integer(true, '0'),
    revision: integer(true, '0'),
    created_at: text(true),
    updated_at: text(true),
  }, [
    'check(balance>=0andbalance<=9007199254740991)',
    'check(total_earned>=0andtotal_earned<=9007199254740991)',
    'check(total_spent>=0andtotal_spent<=9007199254740991)',
    'check(revision>=0andrevision<=9007199254740991)',
  ]);
  verifyTableContract(db, 'coin_guild_players', {
    guild_id: text(true, null, 1),
    user_id: text(true, null, 2),
    bank_balance: integer(true, '0'),
    bank_interest_accrued: real(true, '0'),
    last_interest_date: text(),
    last_daily_date: text(),
    daily_streak: integer(true, '0'),
    created_at: text(true),
    updated_at: text(true),
  }, [
    'check(bank_balance>=0andbank_balance<=9007199254740991)',
    'check(bank_interest_accrued>=0)',
    'check(daily_streak>=0)',
  ]);
  verifyTableContract(db, 'coin_wallet_migrations', {
    id: integer(false, null, 1),
    from_version: integer(true),
    to_version: integer(true),
    source_row_count: integer(true),
    source_distinct_user_count: integer(true),
    source_balance_sum: integer(true),
    source_total_earned_sum: integer(true),
    source_total_spent_sum: integer(true),
    source_sha256: text(true),
    completed_at: text(true),
  }, []);
  const transactionColumns = new Map(getTableColumns(db, 'coin_transactions').map((column) => [column.name, column]));
  for (const [columnName, expected] of Object.entries({
    wallet_scope: text(true, "'guild_legacy'"),
    wallet_revision: integer(),
  })) {
    const actual = transactionColumns.get(columnName);
    if (!actual || JSON.stringify(actual) !== JSON.stringify({ name: columnName, ...expected })) {
      throw new Error(`coin_transactions.${columnName} does not match its required schema contract`);
    }
  }
  if (!getTableDefinition(db, 'coin_transactions').includes("check(wallet_scopein('guild_legacy','global'))")) {
    throw new Error('coin_transactions is missing its wallet-scope CHECK constraint');
  }
  if (!hasUniqueIndex(db, 'coin_wallet_migrations', ['to_version'])) {
    throw new Error('coin_wallet_migrations is missing its migration-version unique key');
  }
  const guildPlayerForeignKey = getRows(db, 'PRAGMA foreign_key_list(coin_guild_players)')
    .find((row) => row.table === 'coin_wallets' && row.from === 'user_id' && row.to === 'user_id');
  if (!guildPlayerForeignKey) throw new Error('coin_guild_players is missing its global-wallet foreign key');
  const globalRevisionIndex = getRows(db, 'PRAGMA index_list(coin_transactions)')
    .find((index) => index.name === 'idx_coin_transactions_global_wallet_revision' && Number(index.unique) === 1 && Number(index.partial) === 1);
  if (!globalRevisionIndex) throw new Error('global wallet transaction revisions are not uniquely indexed');

  const walletRows = getRows(
    db,
    'SELECT user_id, balance, total_earned, total_spent, revision, created_at, updated_at FROM coin_wallets'
  );
  for (const wallet of walletRows) {
    if (!String(wallet.user_id || '').trim() || !String(wallet.created_at || '').trim() || !String(wallet.updated_at || '').trim()) {
      throw new Error('global wallet contains an invalid identity or timestamp');
    }
    if ([wallet.balance, wallet.total_earned, wallet.total_spent, wallet.revision].some(
      (value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0
    )) {
      throw new Error(`invalid global wallet row: ${wallet.user_id}`);
    }
  }
  const guildPlayerRows = getRows(
    db,
    `SELECT guild_id, user_id, bank_balance, bank_interest_accrued, daily_streak, created_at, updated_at
     FROM coin_guild_players`
  );
  for (const player of guildPlayerRows) {
    if (
      !String(player.guild_id || '').trim() || !String(player.user_id || '').trim() ||
      !String(player.created_at || '').trim() || !String(player.updated_at || '').trim() ||
      !Number.isSafeInteger(Number(player.bank_balance)) || Number(player.bank_balance) < 0 ||
      !Number.isFinite(Number(player.bank_interest_accrued)) || Number(player.bank_interest_accrued) < 0 ||
      !Number.isSafeInteger(Number(player.daily_streak)) || Number(player.daily_streak) < 0
    ) {
      throw new Error(`invalid guild wallet state: ${player.guild_id}/${player.user_id}`);
    }
  }
  const orphanGuildPlayer = getRow(
    db,
    `SELECT gp.guild_id, gp.user_id
     FROM coin_guild_players gp
     LEFT JOIN coin_wallets w ON w.user_id = gp.user_id
     WHERE w.user_id IS NULL
     LIMIT 1`
  );
  if (orphanGuildPlayer) {
    throw new Error(`guild wallet state has no global authority: ${orphanGuildPlayer.guild_id}/${orphanGuildPlayer.user_id}`);
  }
  const invalidScope = getRow(
    db,
    "SELECT id FROM coin_transactions WHERE wallet_scope NOT IN ('guild_legacy', 'global') LIMIT 1"
  );
  if (invalidScope) throw new Error(`invalid wallet scope on transaction ${invalidScope.id}`);
  const invalidRevision = getRow(
    db,
    `SELECT id FROM coin_transactions
     WHERE (wallet_scope = 'global' AND (
              wallet_revision IS NULL OR wallet_revision < 1 OR
              wallet_revision > 9007199254740991 OR typeof(wallet_revision) != 'integer'
            ))
        OR (wallet_scope = 'guild_legacy' AND wallet_revision IS NOT NULL)
     LIMIT 1`
  );
  if (invalidRevision) throw new Error(`invalid wallet revision on transaction ${invalidRevision.id}`);
  const brokenRevisionChain = getRow(
    db,
    `SELECT w.user_id
     FROM coin_wallets w
     LEFT JOIN coin_transactions t
       ON t.user_id = w.user_id AND t.wallet_scope = 'global'
     GROUP BY w.user_id, w.revision
     HAVING COUNT(t.id) != w.revision
        OR COALESCE(MIN(t.wallet_revision), 0) != CASE WHEN w.revision = 0 THEN 0 ELSE 1 END
        OR COALESCE(MAX(t.wallet_revision), 0) != w.revision
        OR COUNT(DISTINCT t.wallet_revision) != w.revision
     LIMIT 1`
  );
  if (brokenRevisionChain) throw new Error(`broken global wallet revision chain: ${brokenRevisionChain.user_id}`);
  const triggerCount = Number(getRow(
    db,
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'trigger' AND name IN (
       'coin_players_v19_archive_no_insert',
       'coin_players_v19_archive_no_update',
       'coin_players_v19_archive_no_delete'
     )`
  ).count);
  if (triggerCount !== 3) throw new Error('coin_players v19 archive write guards are incomplete');

  const manifests = getRows(db, 'SELECT * FROM coin_wallet_migrations WHERE to_version = 20');
  if (manifests.length !== 1) throw new Error('v20 wallet migration manifest is missing or duplicated');
  const manifest = manifests[0];
  const sourceRows = canonicalLegacyWalletSource(getRows(
    db,
    `SELECT guild_id, user_id, balance, bank_balance, bank_interest_accrued, last_interest_date,
            total_earned, total_spent, last_daily_date, daily_streak, created_at, updated_at
     FROM coin_players
     ORDER BY user_id, guild_id`
  ));
  const archiveSha256 = crypto.createHash('sha256').update(JSON.stringify(sourceRows)).digest('hex');
  const archiveUsers = new Set();
  let archiveBalanceSum = 0;
  let archiveEarnedSum = 0;
  let archiveSpentSum = 0;
  for (const row of sourceRows) {
    if (!row.guild_id || !row.user_id || !row.created_at || !row.updated_at) {
      throw new Error('coin_players archive contains an invalid identity or timestamp');
    }
    for (const [field, value] of [
      ['balance', row.balance], ['bank_balance', row.bank_balance], ['total_earned', row.total_earned],
      ['total_spent', row.total_spent], ['daily_streak', row.daily_streak],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`coin_players archive ${field} contains an invalid value`);
      }
    }
    if (!Number.isFinite(row.bank_interest_accrued) || row.bank_interest_accrued < 0) {
      throw new Error('coin_players archive bank interest contains an invalid value');
    }
    archiveUsers.add(row.user_id);
    archiveBalanceSum = safeAdd(archiveBalanceSum, row.balance, 'archived balance sum');
    archiveEarnedSum = safeAdd(archiveEarnedSum, row.total_earned, 'archived total-earned sum');
    archiveSpentSum = safeAdd(archiveSpentSum, row.total_spent, 'archived total-spent sum');
  }
  if (
    Number(manifest.source_row_count) !== sourceRows.length ||
    Number(manifest.source_distinct_user_count) !== archiveUsers.size ||
    Number(manifest.source_balance_sum) !== archiveBalanceSum ||
    Number(manifest.source_total_earned_sum) !== archiveEarnedSum ||
    Number(manifest.source_total_spent_sum) !== archiveSpentSum ||
    manifest.source_sha256 !== archiveSha256
  ) {
    throw new Error('v20 wallet migration manifest does not match the legacy archive');
  }
}

function addIsoDays(dateString, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) throw new Error(`invalid calendar date: ${dateString}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const normalized = date.toISOString().slice(0, 10);
  if (days === 0 && normalized !== dateString) throw new Error(`invalid calendar date: ${dateString}`);
  return normalized;
}

const taipeiDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function normalizeLegacyDailyTimestamp(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z)?$/.exec(text);
  if (!match || (match[4] === 'T' && match[9] !== 'Z') || (match[4] === ' ' && match[9])) {
    throw new Error('legacy daily check-in contains an invalid UTC timestamp');
  }
  const [, yearText, monthText, dayText, , hourText, minuteText, secondText, millisecondText = '0'] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const milliseconds = Number(millisecondText.padEnd(3, '0'));
  const instant = new Date(Date.UTC(...parts.slice(0, 3).map((part, index) => index === 1 ? part - 1 : part), ...parts.slice(3), milliseconds));
  if (
    instant.getUTCFullYear() !== parts[0] ||
    instant.getUTCMonth() !== parts[1] - 1 ||
    instant.getUTCDate() !== parts[2] ||
    instant.getUTCHours() !== parts[3] ||
    instant.getUTCMinutes() !== parts[4] ||
    instant.getUTCSeconds() !== parts[5]
  ) {
    throw new Error('legacy daily check-in contains an invalid UTC timestamp');
  }
  const dateParts = Object.fromEntries(
    taipeiDateFormatter.formatToParts(instant)
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => [part.type, part.value])
  );
  return {
    checkinDate: `${dateParts.year}-${dateParts.month}-${dateParts.day}`,
    instantMs: instant.getTime(),
  };
}

function migrateGlobalEconomyV21(db, currentVersion) {
  if (currentVersion >= 21) return false;

  for (const [tableName, columns] of Object.entries({
    coin_daily_checkins_global: ['user_id', 'checkin_date', 'source_guild_id', 'earned_amount', 'bonus_amount', 'streak', 'created_at'],
    coin_daily_state: ['user_id', 'last_checkin_date', 'streak', 'updated_at'],
    coin_debts: ['user_id', 'amount', 'created_at', 'updated_at'],
    coin_global_shop_items: ['id', 'name', 'price', 'type', 'stock', 'purchase_limit', 'source_guild_id'],
    coin_global_inventory: ['user_id', 'item_id', 'quantity'],
    coin_global_purchases: ['source_guild_id', 'user_id', 'item_id', 'quantity', 'total_price'],
    luxury_global_items: ['id', 'name', 'price', 'stock', 'purchase_limit', 'source_guild_id'],
    luxury_global_inventory: ['user_id', 'item_id', 'quantity'],
    luxury_global_purchases: ['source_guild_id', 'user_id', 'item_id', 'quantity', 'unit_price', 'total_price'],
    luxury_global_pawn_records: ['source_guild_id', 'user_id', 'item_id', 'quantity', 'remaining_quantity', 'payout_amount'],
  })) {
    requireColumns(db, tableName, columns);
  }

  const targetCount = Number(getRow(
    db,
    `SELECT (SELECT COUNT(*) FROM coin_daily_checkins_global) +
            (SELECT COUNT(*) FROM coin_daily_state) +
            (SELECT COUNT(*) FROM coin_debts) +
            (SELECT COUNT(*) FROM coin_global_shop_items) +
            (SELECT COUNT(*) FROM coin_global_inventory) +
            (SELECT COUNT(*) FROM coin_global_purchases) +
            (SELECT COUNT(*) FROM luxury_global_items) +
            (SELECT COUNT(*) FROM luxury_global_price_history) +
            (SELECT COUNT(*) FROM luxury_global_inventory) +
            (SELECT COUNT(*) FROM luxury_global_purchases) +
            (SELECT COUNT(*) FROM luxury_global_pawn_records) +
            (SELECT COUNT(*) FROM luxury_global_pawn_redemptions) AS count`
  ).count);
  if (targetCount !== 0) throw new Error('v21 authority targets must be empty before migration');

  const sourceRows = getRows(
    db,
    `SELECT id, guild_id, user_id, checkin_date, earned_amount, bonus_amount, created_at
     FROM coin_daily_checkins
     ORDER BY id`
  );
  const normalizedRows = sourceRows.map((row) => {
    const userId = String(row.user_id || '').trim();
    const guildId = String(row.guild_id || '').trim();
    addIsoDays(String(row.checkin_date || ''), 0);
    if (!userId || !guildId || !String(row.created_at || '').trim()) {
      throw new Error('legacy daily check-in contains an invalid identity or timestamp');
    }
    const normalizedTimestamp = normalizeLegacyDailyTimestamp(row.created_at);
    for (const value of [row.earned_amount, row.bonus_amount]) {
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
        throw new Error(`legacy daily check-in contains an invalid amount for ${userId}/${normalizedTimestamp.checkinDate}`);
      }
    }
    if (!getRow(db, 'SELECT 1 AS found FROM coin_wallets WHERE user_id = ?', [userId])) {
      throw new Error(`legacy daily check-in has no global wallet: ${userId}/${normalizedTimestamp.checkinDate}`);
    }
    return {
      id: Number(row.id),
      userId,
      guildId,
      checkinDate: normalizedTimestamp.checkinDate,
      instantMs: normalizedTimestamp.instantMs,
      earnedAmount: Number(row.earned_amount),
      bonusAmount: Number(row.bonus_amount),
      createdAt: String(row.created_at),
    };
  }).sort((left, right) =>
    left.userId.localeCompare(right.userId) ||
    left.checkinDate.localeCompare(right.checkinDate) ||
    left.instantMs - right.instantMs ||
    left.id - right.id
  );
  const distinctRows = [];
  const seen = new Set();
  for (const row of normalizedRows) {
    const key = `${row.userId}\u0000${row.checkinDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinctRows.push(row);
  }

  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    started = true;
    const duelWeaponColumn = getTableColumns(db, 'casino_duel_tower_runs')
      .find((column) => column.name === 'weapon_item_id');
    if (!duelWeaponColumn || duelWeaponColumn.type !== 'TEXT') {
      db.exec(`
        CREATE TABLE casino_duel_tower_runs_v21_rebuild (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          weapon_item_id TEXT NOT NULL,
          weapon_name TEXT NOT NULL,
          wager_amount INTEGER NOT NULL,
          floor INTEGER NOT NULL,
          opponent_name TEXT NOT NULL,
          player_power INTEGER NOT NULL,
          opponent_power INTEGER NOT NULL,
          status TEXT NOT NULL,
          payout_amount INTEGER NOT NULL DEFAULT 0,
          net_amount INTEGER NOT NULL DEFAULT 0,
          result_json TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO casino_duel_tower_runs_v21_rebuild
          (id, guild_id, user_id, weapon_item_id, weapon_name, wager_amount, floor, opponent_name,
           player_power, opponent_power, status, payout_amount, net_amount, result_json, created_at)
        SELECT id, guild_id, user_id, CAST(weapon_item_id AS TEXT), weapon_name, wager_amount, floor, opponent_name,
               player_power, opponent_power, status, payout_amount, net_amount, result_json, created_at
        FROM casino_duel_tower_runs;
        DROP TABLE casino_duel_tower_runs;
        ALTER TABLE casino_duel_tower_runs_v21_rebuild RENAME TO casino_duel_tower_runs;
      `);
    }
    const stateByUser = new Map();
    for (const row of distinctRows) {
      const previous = stateByUser.get(row.userId);
      const streak = previous && addIsoDays(previous.date, 1) === row.checkinDate ? previous.streak + 1 : 1;
      runSql(
        db,
        `INSERT INTO coin_daily_checkins_global
          (user_id, checkin_date, source_guild_id, earned_amount, bonus_amount, streak, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.userId, row.checkinDate, row.guildId, row.earnedAmount, row.bonusAmount, streak, row.createdAt]
      );
      stateByUser.set(row.userId, { date: row.checkinDate, streak, updatedAt: row.createdAt });
    }
    for (const [userId, stateRow] of stateByUser) {
      runSql(
        db,
        `INSERT INTO coin_daily_state (user_id, last_checkin_date, streak, updated_at)
         VALUES (?, ?, ?, ?)`,
        [userId, stateRow.date, stateRow.streak, stateRow.updatedAt]
      );
    }
    if (Number(getRow(db, 'SELECT COUNT(*) AS count FROM coin_daily_checkins_global').count) !== distinctRows.length) {
      throw new Error('v21 daily migration row-count verification failed');
    }
    verifyIntegrity(db);
    db.exec('COMMIT');
    started = false;
    return true;
  } catch (error) {
    if (started) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Global economy v21 migration rollback failed', rollbackError); }
    }
    throw error;
  }
}

function verifyGlobalEconomyV21Schema(db) {
  for (const [tableName, columns] of Object.entries({
    coin_daily_checkins_global: ['user_id', 'checkin_date', 'source_guild_id', 'earned_amount', 'bonus_amount', 'streak', 'created_at'],
    coin_daily_state: ['user_id', 'last_checkin_date', 'streak', 'updated_at'],
    coin_debts: ['user_id', 'amount', 'created_at', 'updated_at'],
    coin_global_shop_items: ['id', 'name', 'description', 'price', 'type', 'enabled', 'deleted', 'stock', 'purchase_limit', 'created_by', 'source_guild_id', 'created_at', 'updated_at'],
    coin_global_inventory: ['user_id', 'item_id', 'item_name', 'quantity', 'acquired_at', 'updated_at'],
    coin_global_purchases: ['id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'total_price', 'item_type', 'status', 'created_at'],
    luxury_global_items: ['id', 'name', 'description', 'price', 'enabled', 'deleted', 'stock', 'purchase_limit', 'created_by', 'source_guild_id', 'created_at', 'updated_at'],
    luxury_global_price_history: ['id', 'item_id', 'price', 'changed_by', 'reason', 'created_at'],
    luxury_global_inventory: ['user_id', 'item_id', 'item_name', 'quantity', 'acquired_at', 'updated_at'],
    luxury_global_purchases: ['id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'unit_price', 'total_price', 'created_at'],
    luxury_global_pawn_records: ['id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'remaining_quantity', 'pawn_unit_price', 'payout_amount', 'redeemed_quantity', 'redeemed_amount', 'status', 'created_at', 'updated_at', 'redeemed_at'],
    luxury_global_pawn_redemptions: ['id', 'pawn_record_id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'redeem_unit_price', 'total_price', 'created_at'],
  })) {
    requireColumns(db, tableName, columns);
  }

  const invalidDebt = getRow(db, 'SELECT user_id FROM coin_debts WHERE amount < 0 OR typeof(amount) != \'integer\' LIMIT 1');
  if (invalidDebt) throw new Error(`invalid global debt row: ${invalidDebt.user_id}`);
  const invalidItem = getRow(
    db,
    `SELECT id FROM coin_global_shop_items
     WHERE substr(id, 1, 2) != 'g_' OR type = 'role'
     UNION ALL
     SELECT id FROM luxury_global_items WHERE substr(id, 1, 2) != 'l_'
     LIMIT 1`
  );
  if (invalidItem) throw new Error(`invalid global item id or type: ${invalidItem.id}`);
  const duelWeaponColumn = getTableColumns(db, 'casino_duel_tower_runs')
    .find((column) => column.name === 'weapon_item_id');
  if (!duelWeaponColumn || duelWeaponColumn.type !== 'TEXT') {
    throw new Error('casino duel weapon id is not compatible with global item ids');
  }

  const dailyRows = getRows(
    db,
    `SELECT user_id, checkin_date, streak
     FROM coin_daily_checkins_global
     ORDER BY user_id, checkin_date`
  );
  const expectedState = new Map();
  for (const row of dailyRows) {
    addIsoDays(row.checkin_date, 0);
    const previous = expectedState.get(row.user_id);
    const streak = previous && addIsoDays(previous.date, 1) === row.checkin_date ? previous.streak + 1 : 1;
    if (Number(row.streak) !== streak) throw new Error(`invalid global daily streak: ${row.user_id}/${row.checkin_date}`);
    expectedState.set(row.user_id, { date: row.checkin_date, streak });
  }
  const stateRows = getRows(db, 'SELECT user_id, last_checkin_date, streak FROM coin_daily_state');
  if (stateRows.length !== expectedState.size) throw new Error('global daily state count does not match history');
  for (const row of stateRows) {
    const expected = expectedState.get(row.user_id);
    if (!expected || expected.date !== row.last_checkin_date || expected.streak !== Number(row.streak)) {
      throw new Error(`global daily state does not match history: ${row.user_id}`);
    }
  }
  const foreignKeyFailure = getRow(db, 'PRAGMA foreign_key_check');
  if (foreignKeyFailure) throw new Error(`global economy foreign key failure: ${foreignKeyFailure.table}`);
}

function taipeiSettlementDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 23) return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function safeSum(rows, key, label) {
  const total = rows.reduce((sum, row) => sum + Number(row[key]), 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${label} is outside supported range`);
  return total;
}

function inspectGlobalEconomyV22(db, now = new Date(), sourceSha256 = null) {
  const bankRows = getRows(db, `SELECT guild_id, user_id, bank_balance, bank_interest_accrued,
    last_interest_date, created_at, updated_at FROM coin_guild_players ORDER BY user_id, guild_id`);
  const chipRows = getRows(db, 'SELECT * FROM chip_accounts ORDER BY user_id, guild_id');
  const rateRows = getRows(db, 'SELECT * FROM coin_bank_rates ORDER BY guild_id, rate_key');
  const fixedRows = getRows(db, 'SELECT id, guild_id, user_id, principal, expected_interest, status FROM coin_fixed_deposits ORDER BY id');
  const loanRows = getRows(db, 'SELECT id, guild_id, user_id, principal_amount, current_debt_amount, status FROM casino_loans ORDER BY id');
  const rewardRows = getRows(db, 'SELECT id, guild_id, user_id, source_type, source_id, reward_kind, amount, transaction_id, created_at FROM reward_grants ORDER BY id');
  const settlementDate = taipeiSettlementDate(now);
  const conflicts = [];
  const legacyRewardConflicts = [];
  const loanConflicts = [];
  const bankByUser = new Map();
  const chipsByUser = new Map();
  for (const row of bankRows) {
    const balance = Number(row.bank_balance);
    const accrued = Number(row.bank_interest_accrued);
    if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isFinite(accrued) || accrued < 0) {
      conflicts.push({ code: 'INVALID_BANK_VALUE', userId: row.user_id, sourceGuildId: row.guild_id });
      continue;
    }
    if (balance > 0 && (!row.last_interest_date || row.last_interest_date < settlementDate)) {
      conflicts.push({ code: 'UNSETTLED_LEGACY_INTEREST', userId: row.user_id, sourceGuildId: row.guild_id });
    }
    const account = bankByUser.get(row.user_id) || {
      userId: row.user_id, balance: 0, interestAccrued: 0,
      lastInterestDate: row.last_interest_date, positiveBalanceDate: null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    account.balance += balance;
    account.interestAccrued += accrued;
    if (balance > 0 && account.positiveBalanceDate && row.last_interest_date && account.positiveBalanceDate !== row.last_interest_date) {
      conflicts.push({ code: 'MIXED_INTEREST_DATES', userId: row.user_id });
    }
    if (balance > 0) account.positiveBalanceDate = row.last_interest_date;
    if (row.last_interest_date > (account.lastInterestDate || '')) account.lastInterestDate = row.last_interest_date;
    if (row.created_at < account.createdAt) account.createdAt = row.created_at;
    if (row.updated_at > account.updatedAt) account.updatedAt = row.updated_at;
    if (!Number.isSafeInteger(account.balance) || account.balance > Number.MAX_SAFE_INTEGER || !Number.isFinite(account.interestAccrued)) {
      conflicts.push({ code: 'BANK_SUM_OVERFLOW', userId: row.user_id });
    }
    bankByUser.set(row.user_id, account);
  }
  for (const row of chipRows) {
    const amount = Number(row.balance);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      conflicts.push({ code: 'INVALID_CHIP_VALUE', userId: row.user_id, sourceGuildId: row.guild_id });
      continue;
    }
    const account = chipsByUser.get(row.user_id) || { userId: row.user_id, balance: 0, createdAt: row.created_at, updatedAt: row.updated_at };
    account.balance += amount;
    if (row.created_at < account.createdAt) account.createdAt = row.created_at;
    if (row.updated_at > account.updatedAt) account.updatedAt = row.updated_at;
    if (!Number.isSafeInteger(account.balance)) conflicts.push({ code: 'CHIP_SUM_OVERFLOW', userId: row.user_id });
    chipsByUser.set(row.user_id, account);
  }
  for (const row of rateRows) {
    if (Number(row.is_event) === 1) {
      conflicts.push({ code: 'LEGACY_RATE_EVENT', sourceGuildId: row.guild_id, rateKey: row.rate_key });
    }
  }
  const pendingGames = Number(getRow(db, "SELECT COUNT(*) AS count FROM casino_games WHERE status != 'settled'").count);
  const pendingBlackjack = Number(getRow(db, "SELECT COUNT(*) AS count FROM casino_blackjack_sessions WHERE status = 'active'").count);
  const escrowedTips = Number(getRow(db, "SELECT COUNT(*) AS count FROM casino_venue_orders WHERE tip_status = 'escrowed'").count);
  if (pendingGames || pendingBlackjack || escrowedTips) {
    conflicts.push({ code: 'UNSETTLED_GAME_OR_ESCROW', pendingGames, pendingBlackjack, escrowedTips });
  }
  const legacyRewardKeys = new Map();
  const activeLoansByUser = new Map();
  for (const row of loanRows.filter((loan) => loan.status === 'active')) {
    const loans = activeLoansByUser.get(row.user_id) || [];
    loans.push(row.id);
    activeLoansByUser.set(row.user_id, loans);
  }
  for (const [userId, loanIds] of activeLoansByUser) {
    if (loanIds.length > 1) loanConflicts.push({ code: 'MULTIPLE_ACTIVE_LOANS', userId, loanIds });
  }
  for (const row of rewardRows) {
    const key = JSON.stringify([row.user_id, row.source_type, row.source_id, row.reward_kind]);
    const prior = legacyRewardKeys.get(key);
    if (prior && (Number(prior.amount) !== Number(row.amount) || prior.guild_id !== row.guild_id)) {
      legacyRewardConflicts.push({ code: 'LEGACY_REWARD_SOURCE_COLLISION', legacyGrantIds: [prior.id, row.id] });
    }
    legacyRewardKeys.set(key, row);
  }
  const completeSourceSha256 = sourceSha256 || crypto.createHash('sha256').update(exportDatabase(db)).digest('hex');
  const blockingSettlements = conflicts.filter((conflict) =>
    ['UNSETTLED_LEGACY_INTEREST', 'UNSETTLED_GAME_OR_ESCROW'].includes(conflict.code));
  const decisionRequired = [
    ...conflicts.filter((conflict) => !blockingSettlements.includes(conflict)),
    ...loanConflicts,
    ...legacyRewardConflicts,
  ];
  return {
    fromVersion: 21, toVersion: 22, settlementDate, sourceSha256: completeSourceSha256,
    canApply: conflicts.length === 0 && decisionRequired.length === 0,
    conflicts, blockingSettlements, decisionRequired, legacyRewardConflicts, loanConflicts,
    autoMigratable: {
      bankAccountCount: bankByUser.size,
      chipAccountCount: chipsByUser.size,
      fixedContractCount: fixedRows.length,
      loanContractCount: loanRows.length,
    },
    bankAccounts: [...bankByUser.values()], chipAccounts: [...chipsByUser.values()],
    totals: {
      bankBalance: safeSum(bankRows, 'bank_balance', 'bank balance'),
      chipBalance: safeSum(chipRows, 'balance', 'chip balance'),
      interestAccrued: bankRows.reduce((sum, row) => sum + Number(row.bank_interest_accrued), 0),
      fixedPrincipal: safeSum(fixedRows.filter((row) => row.status === 'active' || row.status === 'matured'), 'principal', 'fixed principal'),
      fixedInterest: safeSum(fixedRows.filter((row) => row.status === 'active' || row.status === 'matured'), 'expected_interest', 'fixed interest'),
      loanPrincipal: safeSum(loanRows.filter((row) => row.status === 'active'), 'principal_amount', 'loan principal'),
      loanDebt: safeSum(loanRows.filter((row) => row.status === 'active'), 'current_debt_amount', 'loan debt'),
    },
  };
}

function migrateGlobalEconomyV22(db, { expectedSourceSha256 = null, requireExpectedSource = false, sourceSha256 = null } = {}) {
  const plan = inspectGlobalEconomyV22(db, new Date(), sourceSha256);
  if (requireExpectedSource && !/^[a-f0-9]{64}$/.test(String(expectedSourceSha256 || ''))) {
    throw new Error('v22 migration requires a reviewed v21 source SHA-256');
  }
  if (expectedSourceSha256 && expectedSourceSha256 !== plan.sourceSha256) {
    throw new Error('v22 source SHA-256 changed since dry run');
  }
  if (!plan.canApply) {
    const unresolved = [...plan.blockingSettlements, ...plan.decisionRequired];
    const error = new Error(`v22 migration has ${unresolved.length} unresolved conflicts`);
    error.conflicts = unresolved;
    throw error;
  }
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(globalEconomyV22Sql);
    addColumnIfMissing(db, 'coin_work_tasks', 'global_cycle_id', 'TEXT REFERENCES coin_primary_job_cycles(cycle_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coin_work_tasks_global_cycle ON coin_work_tasks (global_cycle_id, status, id)');
    addColumnIfMissing(db, 'casino_venue_orders', 'waiter_global_cycle_id', 'TEXT REFERENCES coin_primary_job_cycles(cycle_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_venue_orders_waiter_global_cycle ON casino_venue_orders (waiter_global_cycle_id, tip_status, id)');
    addColumnIfMissing(db, 'casino_venue_order_items', 'global_cycle_id', 'TEXT REFERENCES coin_primary_job_cycles(cycle_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_venue_order_items_global_cycle ON casino_venue_order_items (global_cycle_id, status, id)');
    const timestamp = new Date().toISOString();
    for (const account of plan.bankAccounts) {
      runSql(db, `INSERT INTO coin_bank_accounts_global
        (user_id, balance, interest_accrued, last_interest_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [account.userId, account.balance, account.interestAccrued,
        account.lastInterestDate, account.createdAt, account.updatedAt]);
    }
    for (const account of plan.chipAccounts) {
      runSql(db, `INSERT INTO chip_accounts_global (user_id, balance, created_at, updated_at)
        VALUES (?, ?, ?, ?)`, [account.userId, account.balance, account.createdAt, account.updatedAt]);
    }
    for (const [rateKey, rate] of Object.entries({ demand: 0.0003, fixed_7: 0.0035,
      fixed_14: 0.008, fixed_30: 0.02, fixed_90: 0.07 })) {
      runSql(db, `INSERT INTO coin_bank_rates_global (rate_key, rate, updated_by, reason, updated_at)
        VALUES (?, ?, 'system', 'v22 global default', ?)`, [rateKey, rate, timestamp]);
    }
    const targetBankBalance = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM coin_bank_accounts_global').total);
    const targetChipBalance = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM chip_accounts_global').total);
    const targetInterest = Number(getRow(db, 'SELECT COALESCE(SUM(interest_accrued), 0) AS total FROM coin_bank_accounts_global').total);
    if (targetBankBalance !== plan.totals.bankBalance || targetChipBalance !== plan.totals.chipBalance ||
      Math.abs(targetInterest - plan.totals.interestAccrued) > 1e-8) throw new Error('v22 asset conservation check failed');
    runSql(db, `INSERT INTO coin_global_economy_migrations
      (to_version, source_sha256, source_bank_balance_sum, target_bank_balance_sum,
       source_chip_balance_sum, target_chip_balance_sum, source_interest_sum, target_interest_sum,
       source_fixed_principal_sum, target_fixed_principal_sum, source_fixed_interest_sum, target_fixed_interest_sum,
       source_loan_principal_sum, target_loan_principal_sum, source_loan_debt_sum, target_loan_debt_sum, completed_at)
       VALUES (22, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [plan.sourceSha256,
      plan.totals.bankBalance, targetBankBalance, plan.totals.chipBalance, targetChipBalance,
      plan.totals.interestAccrued, targetInterest, plan.totals.fixedPrincipal,
      plan.totals.fixedPrincipal, plan.totals.fixedInterest, plan.totals.fixedInterest,
      plan.totals.loanPrincipal, plan.totals.loanPrincipal,
      plan.totals.loanDebt, plan.totals.loanDebt, timestamp]);
    db.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) db.exec('ROLLBACK');
    throw error;
  }
}

function verifyGlobalEconomyV22Schema(db) {
  for (const [table, columns] of Object.entries({
    coin_bank_accounts_global: ['user_id', 'balance', 'interest_accrued', 'last_interest_date'],
    coin_bank_rates_global: ['rate_key', 'rate', 'is_event'],
    coin_rate_history_global: ['id', 'rate_key', 'old_rate', 'new_rate', 'source_guild_id'],
    chip_accounts_global: ['user_id', 'balance'],
    reward_grants_v2: ['reward_key', 'user_id', 'amount', 'payload_hash', 'debt_offset', 'net_amount', 'transaction_id'],
    coin_operation_receipts: ['operation_id', 'payload_hash', 'transaction_id'],
    coin_owner_campaigns: ['campaign_id', 'amount', 'reason'],
    coin_owner_campaign_audiences: ['campaign_id', 'source_guild_id', 'audience_type', 'role_id'],
    coin_owner_campaign_recipients: ['campaign_id', 'user_id', 'first_source_guild_id'],
    coin_owner_campaign_audience_members: ['campaign_id', 'source_guild_id', 'audience_type', 'role_id', 'user_id'],
    coin_owner_campaign_history_reviews: ['campaign_id', 'user_id', 'prior_grant', 'source_sha256', 'review_batch_sha256', 'review_id', 'review_reason'],
    coin_owner_campaign_history_classifications: ['campaign_id', 'user_id', 'record_type', 'record_id', 'row_sha256', 'source_sha256', 'evidence_reference'],
    coin_primary_jobs_global: ['user_id', 'job_name', 'work_days', 'state', 'next_cycle_id'],
    coin_primary_job_cycles: ['cycle_id', 'user_id', 'job_name', 'starts_at', 'ends_at'],
    coin_primary_cycle_penalties: ['id', 'cycle_id', 'user_id', 'amount', 'status'],
    coin_primary_cycle_penalty_appeals: ['id', 'penalty_id', 'status', 'reason', 'review_reason'],
    coin_primary_cycle_payroll: ['cycle_id', 'user_id', 'gross_amount', 'paid_amount', 'pay_ratio', 'reward_key', 'settled_at'],
    coin_work_legacy_snapshots: ['job_id', 'source_hash', 'cutover_state_hash', 'snapshot_item_count'],
    coin_work_legacy_snapshot_items: ['job_id', 'item_kind', 'item_id', 'source_hash'],
    coin_work_legacy_settlements: ['job_id', 'period_key', 'user_id', 'source_guild_id', 'reward_key', 'status'],
    discord_game_sessions: ['id', 'user_id', 'source_guild_id', 'game_type', 'revision', 'state_json', 'completed_at'],
    discord_game_actions: ['session_id', 'revision', 'interaction_id', 'action_hash', 'result_json'],
    discord_game_rewards: ['session_id', 'reward_key', 'status', 'amount', 'receipt_id'],
    coin_global_economy_migrations: ['to_version', 'source_sha256'],
  })) requireColumns(db, table, columns);
  requireColumns(db, 'coin_work_tasks', ['global_cycle_id']);
  requireColumns(db, 'casino_venue_orders', ['waiter_global_cycle_id']);
  requireColumns(db, 'casino_venue_order_items', ['global_cycle_id']);
  const receipt = getRow(db, 'SELECT * FROM coin_global_economy_migrations WHERE to_version = 22');
  if (!receipt) throw new Error('missing v22 migration receipt');
  const bank = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM coin_bank_accounts_global').total);
  const chips = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM chip_accounts_global').total);
  if (bank < 0 || chips < 0) throw new Error('invalid v22 global assets');
  if (getRow(db, 'PRAGMA foreign_key_check')) throw new Error('v22 foreign key failure');
}

function buildApi(db) {
  return {
    db,
    all: (sql, params) => getRows(db, sql, params),
    get: (sql, params) => getRow(db, sql, params),
    run: (sql, params) => runSql(db, sql, params),
  };
}

function reconcileWordChainActiveSessions(db) {
  const timestamp = new Date().toISOString();
  const retainedByGuild = new Map();
  const activeSessions = getRows(
    db,
    `SELECT id, guild_id, channel_id
     FROM text_chain_sessions
     WHERE status = 'active'
     ORDER BY guild_id ASC, updated_at DESC, id DESC`
  );

  for (const session of activeSessions) {
    if (!retainedByGuild.has(session.guild_id)) {
      retainedByGuild.set(session.guild_id, session);
      continue;
    }
    runSql(
      db,
      `UPDATE text_chain_sessions
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, updated_at), revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [session.id]
    );
  }

  const guildIds = new Set([
    ...getRows(db, 'SELECT DISTINCT guild_id FROM text_chain_sessions').map((row) => row.guild_id),
    ...getRows(db, "SELECT guild_id FROM feature_guild_settings WHERE feature_key = 'word_chain'").map((row) => row.guild_id),
  ]);
  const existingSettings = new Map(
    getRows(
      db,
      "SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain'"
    ).map((setting) => [setting.guild_id, setting])
  );

  for (const guildId of guildIds) {
    const retained = retainedByGuild.get(guildId);
    const enabled = retained ? 1 : 0;
    const channelId = retained?.channel_id || null;
    const existing = existingSettings.get(guildId);
    if (existing && Number(existing.enabled) === enabled && (existing.channel_id || null) === channelId) {
      continue;
    }
    runSql(
      db,
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, 'word_chain', ?, ?, '{}', ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled, channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      [guildId, enabled, channelId, timestamp, timestamp]
    );
  }
}

function migrateWordChainV12Contract(db) {
  if (!getTableNames(db).has('text_chain_sessions')) {
    return;
  }

  const columns = new Set(getColumnNames(db, 'text_chain_sessions'));
  const definition = getTableDefinition(db, 'text_chain_sessions');
  const hasCompletedStatus = definition.includes("check(statusin('active','stopped','completed'))");

  if (columns.has('completed_at') && hasCompletedStatus) {
    return;
  }

  db.exec(`
    CREATE TABLE text_chain_sessions_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
      current_word TEXT NOT NULL,
      last_word TEXT NOT NULL,
      last_user_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      started_by TEXT NOT NULL,
      stopped_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stopped_at TEXT,
      completed_at TEXT
    );
    INSERT INTO text_chain_sessions_rebuild
      (id, guild_id, channel_id, status, current_word, last_word, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, completed_at)
    SELECT id, guild_id, channel_id,
      CASE WHEN status = 'active' THEN 'active' ELSE 'stopped' END,
      current_word, last_word, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, NULL
    FROM text_chain_sessions;
    DROP TABLE text_chain_sessions;
    ALTER TABLE text_chain_sessions_rebuild RENAME TO text_chain_sessions;
  `);
}

function reconcileNumberChainActiveSessions(db) {
  const timestamp = new Date().toISOString();
  const retainedByGuild = new Map();
  const activeSessions = getRows(
    db,
    `SELECT id, guild_id, channel_id
     FROM number_chain_sessions
     WHERE status = 'active'
     ORDER BY guild_id ASC, updated_at DESC, id DESC`
  );
  for (const session of activeSessions) {
    if (!retainedByGuild.has(session.guild_id)) {
      retainedByGuild.set(session.guild_id, session);
      continue;
    }
    runSql(
      db,
      `UPDATE number_chain_sessions
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, updated_at), revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [session.id]
    );
  }

  const guildIds = new Set([
    ...getRows(db, 'SELECT DISTINCT guild_id FROM number_chain_sessions').map((row) => row.guild_id),
    ...getRows(db, "SELECT guild_id FROM feature_guild_settings WHERE feature_key = 'number_chain'").map((row) => row.guild_id),
  ]);
  const existingSettings = new Map(
    getRows(db, "SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'number_chain'")
      .map((setting) => [setting.guild_id, setting])
  );
  for (const guildId of guildIds) {
    const retained = retainedByGuild.get(guildId);
    const enabled = retained ? 1 : 0;
    const channelId = retained?.channel_id || null;
    const existing = existingSettings.get(guildId);
    if (existing && Number(existing.enabled) === enabled && (existing.channel_id || null) === channelId) continue;
    runSql(
      db,
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, 'number_chain', ?, ?, '{}', ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled, channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      [guildId, enabled, channelId, timestamp, timestamp]
    );
  }
}

function migrateNumberChainV13Contract(db) {
  if (!getTableNames(db).has('number_chain_sessions')) return;

  const columns = new Set(getColumnNames(db, 'number_chain_sessions'));
  const definition = getTableDefinition(db, 'number_chain_sessions');
  const currentColumns = [
    'id', 'guild_id', 'channel_id', 'status', 'expected_target', 'last_user_id', 'revision', 'started_by', 'stopped_by',
    'created_at', 'updated_at', 'stopped_at', 'completed_at',
  ];
  const legacyColumns = currentColumns.filter((column) => column !== 'completed_at');
  const hasCurrentStatus = definition.includes("check(statusin('active','stopped','completed'))");
  const hasLegacyStatus = definition.includes("check(statusin('active','stopped'))");
  const hasAll = (required) => required.every((column) => columns.has(column));
  if (hasAll(currentColumns) && hasCurrentStatus) return;
  if (!hasAll(legacyColumns) || !hasLegacyStatus) {
    throw new Error('number_chain_sessions has an incompatible legacy schema');
  }

  db.exec(`
    CREATE TABLE number_chain_sessions_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
      expected_target INTEGER NOT NULL CHECK (expected_target >= 1 AND expected_target <= 9007199254740991),
      last_user_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      started_by TEXT NOT NULL,
      stopped_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stopped_at TEXT,
      completed_at TEXT
    );
    INSERT INTO number_chain_sessions_rebuild
      (id, guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, completed_at)
    SELECT id, guild_id, channel_id,
      CASE WHEN status = 'active' THEN 'active' ELSE 'stopped' END,
      expected_target, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, NULL
    FROM number_chain_sessions;
    DROP TABLE number_chain_sessions;
    ALTER TABLE number_chain_sessions_rebuild RENAME TO number_chain_sessions;
  `);
}

function assertDailyEventLinks(db) {
  const orphanMessage = getRow(
    db,
    `SELECT message.id
     FROM daily_event_messages AS message
     LEFT JOIN daily_events AS event ON event.id = message.event_id
     WHERE event.id IS NULL LIMIT 1`
  );
  const orphanParticipant = getRow(
    db,
    `SELECT participant.event_id
     FROM daily_event_participants AS participant
     LEFT JOIN daily_events AS event ON event.id = participant.event_id
     WHERE event.id IS NULL LIMIT 1`
  );
  if (orphanMessage || orphanParticipant) {
    throw new Error('daily riddle records contain an orphaned event reference');
  }
  const foreignKeyFailure = getRow(db, 'PRAGMA foreign_key_check');
  if (foreignKeyFailure) throw new Error('daily riddle records fail foreign key validation');
}

function migrateDailyRiddleV15Contract(db) {
  const eventColumnsV14 = [
    'id', 'guild_id', 'event_kind', 'local_date', 'riddle_id', 'parent_channel_id', 'announcement_message_id',
    'thread_id', 'answer_message_id', 'status', 'window_start_at', 'window_end_at', 'publish_marker', 'answer_marker',
    'published_at', 'history_reconciled_at', 'settled_at', 'attempt_count', 'last_error', 'created_at', 'updated_at',
  ];
  const eventColumnsV15 = [
    ...eventColumnsV14.slice(0, 18),
    'publish_lease_owner', 'publish_lease_until', 'settle_lease_owner', 'settle_lease_until',
    ...eventColumnsV14.slice(18),
  ];
  const messageColumnsV14 = [
    'id', 'event_id', 'guild_id', 'thread_id', 'message_id', 'user_id', 'created_at', 'content_hash', 'eligible', 'correct',
  ];
  const messageColumnsV15 = messageColumnsV14.filter((column) => column !== 'content_hash');
  const participantColumns = [
    'event_id', 'guild_id', 'user_id', 'eligible', 'correct', 'participation_reward_status', 'correct_reward_status',
    'created_at', 'updated_at',
  ];
  const exactColumns = (tableName, expected) => {
    const actual = getColumnNames(db, tableName);
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  };
  if (!exactColumns('daily_event_participants', participantColumns)) {
    throw new Error('daily_event_participants has an incompatible schema');
  }

  const eventDefinition = getTableDefinition(db, 'daily_events');
  const messageDefinition = getTableDefinition(db, 'daily_event_messages');
  const currentShape =
    exactColumns('daily_events', eventColumnsV15) &&
    exactColumns('daily_event_messages', messageColumnsV15) &&
    eventDefinition.includes("check(statusin('claimed','published','published_late','settling','rewarding','settled','blocked','missed','failed'))") &&
    !messageDefinition.includes('content_hash');
  if (currentShape) {
    assertDailyEventLinks(db);
    return false;
  }

  const legacyShape =
    exactColumns('daily_events', eventColumnsV14) &&
    exactColumns('daily_event_messages', messageColumnsV14) &&
    eventDefinition.includes("check(statusin('claimed','published','published_late','settling','settled','blocked','missed','failed'))") &&
    messageDefinition.includes('content_hashtextnotnull') &&
    messageDefinition.includes('check(length(content_hash)=64');
  if (!legacyShape) throw new Error('daily riddle tables have an incompatible v14 schema');
  assertDailyEventLinks(db);
  for (const tableName of ['daily_events_v15_rebuild', 'daily_event_messages_v15_rebuild']) {
    if (getTableNames(db).has(tableName)) throw new Error(`unexpected migration table already exists: ${tableName}`);
  }

  const before = {
    events: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_events').count),
    messages: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_messages').count),
    participants: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_participants').count),
  };
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE daily_events_v15_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('riddle', 'discussion')),
        local_date TEXT NOT NULL,
        riddle_id TEXT,
        parent_channel_id TEXT NOT NULL,
        announcement_message_id TEXT,
        thread_id TEXT,
        answer_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'published', 'published_late', 'settling', 'rewarding', 'settled', 'blocked', 'missed', 'failed')),
        window_start_at TEXT NOT NULL,
        window_end_at TEXT NOT NULL,
        publish_marker TEXT NOT NULL,
        answer_marker TEXT NOT NULL,
        published_at TEXT,
        history_reconciled_at TEXT,
        settled_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        publish_lease_owner TEXT,
        publish_lease_until TEXT,
        settle_lease_owner TEXT,
        settle_lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (guild_id, event_kind, local_date)
      );
      CREATE TABLE daily_event_messages_v15_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
        correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
        UNIQUE (event_id, message_id)
      );
      INSERT INTO daily_events_v15_rebuild
        (id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
         answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
         history_reconciled_at, settled_at, attempt_count, publish_lease_owner, publish_lease_until,
         settle_lease_owner, settle_lease_until, last_error, created_at, updated_at)
      SELECT id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
         answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
         history_reconciled_at, settled_at, attempt_count, NULL, NULL, NULL, NULL, last_error, created_at, updated_at
      FROM daily_events;
      INSERT INTO daily_event_messages_v15_rebuild
        (id, event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct)
      SELECT id, event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct
      FROM daily_event_messages;
      DROP TABLE daily_event_messages;
      DROP TABLE daily_events;
      ALTER TABLE daily_events_v15_rebuild RENAME TO daily_events;
      ALTER TABLE daily_event_messages_v15_rebuild RENAME TO daily_event_messages;
    `);
    const after = {
      events: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_events').count),
      messages: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_messages').count),
      participants: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_participants').count),
    };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('daily riddle migration row counts changed');
    assertDailyEventLinks(db);
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Daily riddle v15 migration rollback failed', rollbackError);
      }
    }
    throw error;
  }
}

function migrateGameSessionsV18Bounds(db) {
  if (!getTableNames(db).has('game_sessions')) return false;
  const sessionColumns = [
    'id', 'launch_token_hash', 'access_token_hash', 'launch_consumed_at', 'user_id', 'guild_id', 'channel_id',
    'game_type', 'difficulty', 'seed', 'state_json', 'status', 'action_count', 'score', 'reward_amount', 'expires_at',
    'created_at', 'updated_at', 'completed_at',
  ];
  const actionColumns = ['session_id', 'action_index', 'action_hash', 'state_json', 'created_at'];
  const rewardColumns = ['session_id', 'reward_key', 'status', 'amount', 'created_at', 'updated_at'];
  const exactColumns = (tableName, expected) => {
    const actual = getColumnNames(db, tableName);
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  };
  if (!exactColumns('game_sessions', sessionColumns) || !exactColumns('game_actions', actionColumns) || !exactColumns('game_rewards', rewardColumns)) {
    throw new Error('game tables have an incompatible v18 schema');
  }
  const definition = getTableDefinition(db, 'game_sessions');
  const rewardDefinition = getTableDefinition(db, 'game_rewards');
  const hasCurrentSessionBounds = definition.includes('check(score>=0andscore<=20000)') &&
    definition.includes('check(reward_amount>=0andreward_amount<=1000)');
  const hasLegacySessionBounds = definition.includes('check(score>=0)') && definition.includes('check(reward_amount>=0)');
  const hasCurrentRewardBounds = rewardDefinition.includes('check(amount>=0andamount<=1000)');
  const hasLegacyRewardBounds = rewardDefinition.includes('check(amount>=0)');
  if (!hasCurrentSessionBounds && !hasLegacySessionBounds) {
    throw new Error('game_sessions has incompatible score constraints');
  }
  if (!hasCurrentRewardBounds && !hasLegacyRewardBounds) {
    throw new Error('game_rewards has incompatible amount constraints');
  }
  const invalid = getRow(db, `SELECT id FROM game_sessions
    WHERE typeof(score) <> 'integer' OR score < 0 OR score > 20000
       OR typeof(reward_amount) <> 'integer' OR reward_amount < 0 OR reward_amount > 1000
    LIMIT 1`);
  if (invalid) throw new Error('game_sessions contains values outside the safe score contract');
  const invalidReward = getRow(db, `SELECT session_id FROM game_rewards
    WHERE typeof(amount) <> 'integer' OR amount < 0 OR amount > 1000
    LIMIT 1`);
  if (invalidReward) throw new Error('game_rewards contains values outside the safe reward contract');
  const persistedRewards = getRows(db, `SELECT reward.amount, reward.status AS reward_status,
    session.game_type, session.difficulty, session.status AS session_status, session.score,
    session.reward_amount, session.state_json
    FROM game_rewards AS reward
    JOIN game_sessions AS session ON session.id = reward.session_id`);
  for (const reward of persistedRewards) {
    let state;
    try { state = JSON.parse(reward.state_json); }
    catch (_error) { throw new Error('game reward state is not valid JSON'); }
    const expectedReward = deriveServerGameReward({
      gameType: reward.game_type,
      difficulty: reward.difficulty,
      status: reward.session_status,
      score: reward.score,
      state,
    });
    if (Number(reward.amount) !== expectedReward || Number(reward.reward_amount) !== expectedReward ||
        (expectedReward > 0 && !['pending', 'granted'].includes(reward.reward_status)) ||
        (expectedReward === 0 && reward.reward_status !== 'no_reward')) {
      throw new Error('game reward row does not match its server-authoritative completion state');
    }
  }
  if (hasCurrentSessionBounds && hasCurrentRewardBounds) return false;
  for (const tableName of ['game_sessions_v18_rebuild', 'game_actions_v18_rebuild', 'game_rewards_v18_rebuild']) {
    if (getTableNames(db).has(tableName)) throw new Error(`unexpected migration table already exists: ${tableName}`);
  }
  const before = {
    sessions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_sessions').count),
    actions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_actions').count),
    rewards: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_rewards').count),
  };
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE game_sessions_v18_rebuild (
        id TEXT PRIMARY KEY NOT NULL,
        launch_token_hash TEXT NOT NULL UNIQUE,
        access_token_hash TEXT UNIQUE,
        launch_consumed_at TEXT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        game_type TEXT NOT NULL CHECK (game_type IN ('tetris', 'number-match', 'sudoku')),
        difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'complex', 'hard')),
        seed TEXT NOT NULL,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'failed')),
        action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0 AND action_count <= 500),
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 20000),
        reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0 AND reward_amount <= 1000),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE game_actions_v18_rebuild (
        session_id TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0 AND action_index < 500),
        action_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, action_index),
        FOREIGN KEY (session_id) REFERENCES game_sessions_v18_rebuild(id) ON DELETE CASCADE
      );
      CREATE TABLE game_rewards_v18_rebuild (
        session_id TEXT PRIMARY KEY NOT NULL,
        reward_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'no_reward')),
        amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 1000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES game_sessions_v18_rebuild(id) ON DELETE CASCADE
      );
      INSERT INTO game_sessions_v18_rebuild SELECT * FROM game_sessions;
      INSERT INTO game_actions_v18_rebuild SELECT * FROM game_actions;
      INSERT INTO game_rewards_v18_rebuild SELECT * FROM game_rewards;
      DROP TABLE game_actions;
      DROP TABLE game_rewards;
      DROP TABLE game_sessions;
      ALTER TABLE game_sessions_v18_rebuild RENAME TO game_sessions;
      ALTER TABLE game_actions_v18_rebuild RENAME TO game_actions;
      ALTER TABLE game_rewards_v18_rebuild RENAME TO game_rewards;
    `);
    const after = {
      sessions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_sessions').count),
      actions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_actions').count),
      rewards: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_rewards').count),
    };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('game migration row counts changed');
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Game v18 bounds migration rollback failed', rollbackError); }
    }
    throw error;
  }
}

async function createOrOpenDatabase({ allowNewDatabase = false } = {}) {
  const SQL = await getSqlModule();
  const dbPath = getCoinDatabasePath();
  const existed = fs.existsSync(dbPath);
  if (!existed && !allowNewDatabase) {
    throw new CoinDatabaseError('已選用的吉幣資料庫不存在；已停止啟動。新安裝須明確執行初始化，不能自動建立空庫。');
  }
  let db;
  let sourceSha256 = null;

  try {
    if (existed) {
      const sourceBytes = fs.readFileSync(dbPath);
      if (sourceBytes.length < 100 || sourceBytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
        throw new Error('SQLite source file is empty or has an invalid header');
      }
      sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
      db = new SQL.Database(sourceBytes);
    } else {
      db = new SQL.Database();
    }
  } catch (error) {
    logger.error(`吉幣資料庫讀取失敗，已停止載入：${dbPath}`, error);
    throw new CoinDatabaseError('吉幣資料庫讀取失敗，不會自動重建空資料庫。', error);
  }

  try {
    enableForeignKeys(db);
    verifyIntegrity(db);
    verifyForeignKeyIntegrity(db);
  } catch (error) {
    db.close();
    logger.error(`吉幣資料庫完整性檢查失敗，已停止載入：${dbPath}`, error);
    throw new CoinDatabaseError('吉幣資料庫完整性檢查失敗，不會覆寫原始檔案。', error);
  }

  const beforeTables = getTableNames(db);
  const preBootstrapVersionRow = beforeTables.has('coin_metadata')
    ? getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'")
    : null;
  const preBootstrapVersion = preBootstrapVersionRow ? Number(preBootstrapVersionRow.value) : 0;

  if (!Number.isInteger(preBootstrapVersion) || preBootstrapVersion < 0 || preBootstrapVersion > schemaVersion) {
    db.close();
    throw new CoinDatabaseError(`不支援的吉幣資料庫 schema 版本：${preBootstrapVersionRow?.value ?? 'unknown'}`);
  }
  if (preBootstrapVersion >= 20) {
    try {
      verifyGlobalWalletV20Schema(db);
      if (preBootstrapVersion >= 21) verifyGlobalEconomyV21Schema(db);
      if (preBootstrapVersion >= 22) verifyGlobalEconomyV22Schema(db);
    } catch (error) {
      db.close();
      throw new CoinDatabaseError('吉幣資料庫 v20 結構不完整、不支援，或 v21/v22 全域經濟契約損壞；已停止啟動避免建立第二份權威資料。', error);
    }
  }

  try {
    db.exec(schemaSql);
  } catch (error) {
    db.close();
    logger.error('Coin database schema bootstrap failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  // Simple migration for version 2 (Bank System)
  const currentVersionRow = getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'");
  const currentVersion = currentVersionRow ? Number(currentVersionRow.value) : 0;

  if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion > schemaVersion) {
    db.close();
    throw new CoinDatabaseError(`不支援的吉幣資料庫 schema 版本：${currentVersionRow?.value ?? 'unknown'}`);
  }

  if (currentVersion < 2) {
    logger.info('正在執行資料庫遷移至版本 2 (銀行系統)...');
    try {
      // SQLite doesn't support multiple columns in one ALTER TABLE, and might fail if columns already exist.
      // We check if the column exists by trying to select it or using pragma table_info.
      const columns = getRows(db, "PRAGMA table_info(coin_players)").map(c => c.name);
      
      if (!columns.includes('bank_balance')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN bank_balance INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.includes('bank_interest_accrued')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN bank_interest_accrued REAL NOT NULL DEFAULT 0");
      }
      if (!columns.includes('last_interest_date')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN last_interest_date TEXT");
      }
      logger.info('資料庫遷移至版本 2 完成。');
    } catch (error) {
      logger.error('資料庫遷移至版本 2 失敗。', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 3) {
    logger.info('Migrating coin database schema to version 3 (fixed deposits, rates, work tasks).');
    try {
      addColumnIfMissing(db, 'coin_purchases', 'item_type', "TEXT NOT NULL DEFAULT 'collectible'");
      addColumnIfMissing(db, 'coin_purchases', 'status', "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(db, 'coin_purchases', 'expires_at', 'TEXT');

      addColumnIfMissing(db, 'coin_jobs', 'job_role_id', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'last_contribution_at', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'last_reminder_at', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'today_task_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'today_completed_task_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'no_work_available_today', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'payroll_status', "TEXT NOT NULL DEFAULT 'pending'");
    } catch (error) {
      logger.error('Coin database schema v3 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 4) {
    logger.info('Migrating coin database schema to version 4 (editable work submissions and payroll safety).');
    try {
      addColumnIfMissing(db, 'coin_work_tasks', 'attachment_urls', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'expected_channel_id', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'expected_channel_name', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'message_id', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'external_server_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'external_server_ids', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'reviewed_by', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'review_reason', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'is_paid', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'paid_at', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'paid_amount', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'updated_at', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'deleted_at', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v4 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 5) {
    logger.info('Migrating coin database schema to version 5 (casino games and loans).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v5 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 6) {
    logger.info('Migrating coin database schema to version 6 (casino debt controls).');
    try {
      addColumnIfMissing(db, 'casino_loans', 'relief_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'casino_loans', 'relief_updated_by', 'TEXT');
      addColumnIfMissing(db, 'casino_loans', 'relief_updated_at', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v6 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 7) {
    logger.info('Migrating coin database schema to version 7 (casino venue services).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v7 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 8) {
    logger.info('Migrating coin database schema to version 8 (chips, luxury shop, pawn shop).');
    try {
      db.exec(schemaSql);
      addColumnIfMissing(db, 'casino_games', 'currency', "TEXT NOT NULL DEFAULT 'coin'");
      addColumnIfMissing(db, 'casino_blackjack_sessions', 'currency', "TEXT NOT NULL DEFAULT 'coin'");
      addColumnIfMissing(db, 'casino_ledger', 'currency', "TEXT NOT NULL DEFAULT 'coin'");

      const itemsWithoutHistory = getRows(
        db,
        `SELECT id, guild_id, price, created_by, created_at
         FROM luxury_items
         WHERE NOT EXISTS (
           SELECT 1
           FROM luxury_price_history
           WHERE luxury_price_history.guild_id = luxury_items.guild_id
             AND luxury_price_history.item_id = luxury_items.id
         )`
      );

      for (const item of itemsWithoutHistory) {
        runSql(
          db,
          `INSERT INTO luxury_price_history (guild_id, item_id, price, changed_by, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [item.guild_id, item.id, item.price, item.created_by || null, 'initial price migration', item.created_at || new Date().toISOString()]
        );
      }
    } catch (error) {
      logger.error('Coin database schema v8 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 9) {
    logger.info('Migrating coin database schema to version 9 (venue waiters and work penalties).');
    try {
      db.exec(schemaSql);
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_user_id', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_job_id', 'INTEGER');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_job_name', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_assigned_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_due_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_amount', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_status', "TEXT NOT NULL DEFAULT 'none'");
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_paid_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_refunded_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'served_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'served_by', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v9 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 10) {
    logger.info('Migrating coin database schema to version 10 (casino lodging and duel tower).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v10 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 11) {
    logger.info('Migrating coin database schema to version 11 (community feature platform foundation).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v11 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 12) {
    logger.info('Migrating coin database schema to version 12 (validated word chain).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v12 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 13) {
    logger.info('Migrating coin database schema to version 13 (safe number chain).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v13 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 14) {
    logger.info('Migrating coin database schema to version 14 (daily riddle events).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v14 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 15) {
    logger.info('Migrating coin database schema to version 15 (daily riddle leases and private message records).');
    try {
      migrateDailyRiddleV15Contract(db);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v15 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 16) {
    logger.info('Migrating coin database schema to version 16 (global user chat preferences).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v16 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 17) {
    logger.info('Migrating coin database schema to version 17 (global romance preferences).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v17 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 18) {
    logger.info('Migrating coin database schema to version 18 (server-authoritative games).');
    try { db.exec(schemaSql); }
    catch (error) {
      logger.error('Coin database schema v18 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 19) {
    logger.info('Migrating coin database schema to version 19 (official GitHub release announcements).');
    try { db.exec(schemaSql); }
    catch (error) {
      logger.error('Coin database schema v19 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 20) {
    logger.info('Migrating coin database schema to version 20 (global spendable wallets).');
    try {
      migrateGlobalWalletV20(db, currentVersion);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v20 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫 v20 全域錢包升級失敗，原始資料不會被覆寫。', error);
    }
  }

  if (currentVersion < 21) {
    logger.info('Migrating coin database schema to version 21 (global daily, stores, and debt).');
    try {
      migrateGlobalEconomyV21(db, currentVersion);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v21 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫 v21 全域經濟升級失敗，原始資料不會被覆寫。', error);
    }
  }

  if (currentVersion < 22) {
    try {
      const reviewedV21Source = existed && preBootstrapVersion === 21;
      migrateGlobalEconomyV22(db, {
        expectedSourceSha256: reviewedV21Source ? process.env.COIN_V22_EXPECTED_SOURCE_SHA256 || null : null,
        requireExpectedSource: reviewedV21Source,
        sourceSha256: reviewedV21Source ? sourceSha256 : null,
      });
    } catch (error) {
      db.close();
      logger.error('Coin database schema v22 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫 v22 全域銀行與籌碼升級未完成，原始資料不會被覆寫。', error);
    }
  }

  try {
    db.exec(globalWalletRevisionIndexSql);
  } catch (error) {
    logger.error('Coin database global wallet revision index creation failed', error);
    throw new CoinDatabaseError('吉幣資料庫 v20 全域錢包索引建立失敗，原始資料不會被覆寫。', error);
  }

  try {
    migrateGameSessionsV18Bounds(db);
    db.exec(schemaSql);
  } catch (error) {
    logger.error('Coin database schema v18 game bounds migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    migrateWordChainV12Contract(db);
    reconcileWordChainActiveSessions(db);
    // Recreate v12 indexes after a legacy session-table rebuild only after
    // multiple legacy active sessions have been deterministically reconciled.
    db.exec(schemaSql);
    db.exec(wordChainActiveSessionIndexSql);
  } catch (error) {
    logger.error('Coin database schema v12 word-chain contract migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    migrateNumberChainV13Contract(db);
    reconcileNumberChainActiveSessions(db);
    // The partial index is deliberately last so legacy multi-active rows can
    // be retained and reconciled before SQLite enforces the invariant.
    db.exec(schemaSql);
    db.exec(numberChainActiveSessionIndexSql);
  } catch (error) {
    logger.error('Coin database schema v13 number-chain contract migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    verifyFeaturePlatformSchema(db);
    verifyGlobalWalletV20Schema(db);
    verifyGlobalEconomyV21Schema(db);
    verifyGlobalEconomyV22Schema(db);
  } catch (error) {
    db.close();
    logger.error('Coin database global economy schema verification failed', error);
    throw new CoinDatabaseError('吉幣資料庫 v20 結構驗證失敗，或 v21/v22 全域經濟契約損壞；已停止啟動避免破壞資料。', error);
  }

  const afterTables = getTableNames(db);
  const createdTables = [...afterTables].filter((name) => !beforeTables.has(name));
  const now = new Date().toISOString();

  runSql(
    db,
    `INSERT INTO coin_metadata (key, value, updated_at)
     VALUES ('schema_version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(schemaVersion), now]
  );

  if (existed && crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex') !== sourceSha256) {
    db.close();
    throw new CoinDatabaseError('吉幣來源資料庫在載入期間已變更，已停止寫回避免覆蓋。');
  }
  verifyForeignKeyIntegrity(db);
  if (existed) writeDatabaseFile(dbPath, db);
  else writeNewDatabaseFile(dbPath, db);

  const info = {
    path: dbPath,
    existed,
    createdDatabase: !existed,
    createdTables,
    schemaVersion,
    initializedAt: now,
  };

  state = {
    db,
    info,
    lastSavedAt: now,
  };

  logger.info(`吉幣資料庫路徑：${dbPath}`);
  logger.info(`吉幣資料庫已存在：${existed ? '是' : '否'}`);
  logger.info(`吉幣資料庫新建：${!existed ? '是' : '否'}`);
  logger.info(`吉幣資料表建立：${createdTables.length ? createdTables.join(', ') : '沒有缺少的資料表'}`);
  logger.info('吉幣系統資料庫載入成功。');

  return info;
}

async function initializeCoinDatabase() {
  if (state) {
    assertForeignKeysEnabled(state.db);
    return state.info;
  }

  if (!initializationPromise) {
    const allowNewDatabase = allowCreateOnNextOpenForTests;
    allowCreateOnNextOpenForTests = false;
    initializationPromise = createOrOpenDatabase({ allowNewDatabase }).catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

async function initializeNewCoinDatabase({ expectedPath = getCoinDatabasePath() } = {}) {
  const activePath = path.resolve(getCoinDatabasePath());
  if (path.resolve(expectedPath) !== activePath || fs.existsSync(activePath) || state || initializationPromise) {
    throw new CoinDatabaseError('初裝初始化要求目前所選資料庫路徑完全一致、來源不存在，且尚未開啟。');
  }
  initializationPromise = createOrOpenDatabase({ allowNewDatabase: true }).catch((error) => {
    initializationPromise = null;
    throw error;
  });
  return initializationPromise;
}

async function withCoinDatabase(work, { persist = false } = {}) {
  const runOperation = async () => {
    await initializeCoinDatabase();

    try {
      const result = await work(buildApi(state.db));

      if (persist) {
        writeDatabaseFile(state.info.path, state.db);
        state.lastSavedAt = new Date().toISOString();
      }

      return result;
    } catch (error) {
      throw error;
    }
  };

  const queuedOperation = operationQueue.then(runOperation, runOperation);
  operationQueue = queuedOperation.catch(() => {});
  return queuedOperation;
}

async function withCoinTransaction(work) {
  return withCoinDatabase(async (api) => {
    let transactionStarted = false;
    const snapshot = exportDatabase(state.db);

    try {
      api.run('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = await work(api);
      api.run('COMMIT');
      transactionStarted = false;

      try {
        writeDatabaseFile(state.info.path, state.db);
        state.lastSavedAt = new Date().toISOString();
      } catch (writeError) {
        const Database = state.db.constructor;
        state.db.close();
        state.db = new Database(snapshot);
        enableForeignKeys(state.db);
        verifyForeignKeyIntegrity(state.db);
        throw new CoinDatabaseError('吉幣資料庫落盤失敗，交易已復原。', writeError);
      }

      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          api.run('ROLLBACK');
        } catch (rollbackError) {
          logger.error('吉幣資料庫交易 rollback 失敗。', rollbackError);
        }
      }

      throw error;
    }
  });
}

async function getCoinDatabaseInfo() {
  await initializeCoinDatabase();

  return {
    ...state.info,
    lastSavedAt: state.lastSavedAt,
    exists: fs.existsSync(state.info.path),
  };
}

async function dryRunGlobalEconomyV22({ dbPath = getCoinDatabasePath(), now = new Date() } = {}) {
  const absolutePath = path.resolve(dbPath);
  if (!fs.existsSync(absolutePath)) throw new CoinDatabaseError('來源吉幣資料庫不存在，不能以空資料庫預演。');
  const SQL = await getSqlModule();
  let db;
  try {
    const sourceBytes = fs.readFileSync(absolutePath);
    const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    db = new SQL.Database(sourceBytes);
    enableForeignKeys(db);
    verifyIntegrity(db);
    verifyForeignKeyIntegrity(db);
    const version = Number(getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'")?.value);
    if (version !== 21) throw new Error(`v22 dry run requires schema v21, received ${version}`);
    verifyGlobalWalletV20Schema(db);
    verifyGlobalEconomyV21Schema(db);
    return inspectGlobalEconomyV22(db, now, sourceSha256);
  } catch (error) {
    throw new CoinDatabaseError('吉幣資料庫 v22 預演失敗；來源未改動。', error);
  } finally {
    if (db) db.close();
  }
}

function resetCoinDatabaseForTests({ allowCreateOnNextOpen = false } = {}) {
  if (state?.db) {
    state.db.close();
  }

  state = null;
  initializationPromise = null;
  operationQueue = Promise.resolve();
  allowCreateOnNextOpenForTests = allowCreateOnNextOpen === true;
}

module.exports = {
  CoinDatabaseError,
  dryRunGlobalEconomyV22,
  getCoinDatabaseInfo,
  getCoinDatabasePath,
  initializeCoinDatabase,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
};
