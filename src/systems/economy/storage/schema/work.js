// Work tables: coin_jobs, coin_work_*, coin_payroll_history and coin_primary_*.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: coin_jobs, coin_work_tasks, coin_payroll_history, coin_work_penalties,
// coin_work_penalty_appeals
const jobTablesSql = `CREATE TABLE IF NOT EXISTS coin_jobs (
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
);`;

// Part of schemaSql: idx_coin_jobs_pay_at, idx_coin_jobs_user
const jobIndexesSql = `CREATE INDEX IF NOT EXISTS idx_coin_jobs_pay_at
  ON coin_jobs (pay_at, status, is_paid);

CREATE INDEX IF NOT EXISTS idx_coin_jobs_user
  ON coin_jobs (guild_id, user_id, status);`;

// Part of schemaSql: idx_coin_work_tasks_user, idx_coin_payroll_history_guild,
// idx_coin_work_penalties_user, idx_coin_work_penalties_daily,
// idx_coin_work_penalty_appeals_penalty
const taskPayrollAndPenaltyIndexesSql = `CREATE INDEX IF NOT EXISTS idx_coin_work_tasks_user
  ON coin_work_tasks (guild_id, user_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_coin_payroll_history_guild
  ON coin_payroll_history (guild_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalties_user
  ON coin_work_penalties (guild_id, user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalties_daily
  ON coin_work_penalties (guild_id, user_id, job_id, penalty_date, status);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalty_appeals_penalty
  ON coin_work_penalty_appeals (guild_id, penalty_id, status, created_at DESC);`;

// Part of globalEconomyV22Sql: coin_primary_jobs_global, coin_primary_job_cycles,
// coin_primary_cycle_penalties, coin_primary_cycle_payroll, coin_primary_cycle_penalty_appeals,
// idx_primary_cycle_penalties, idx_primary_cycle_appeals, coin_work_legacy_snapshots,
// coin_work_legacy_snapshot_items, coin_work_legacy_settlements
const primaryJobAndLegacyWorkTablesV22Sql = `CREATE TABLE IF NOT EXISTS coin_primary_jobs_global (
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
);`;

module.exports = {
  jobTablesSql,
  jobIndexesSql,
  taskPayrollAndPenaltyIndexesSql,
  primaryJobAndLegacyWorkTablesV22Sql,
};
