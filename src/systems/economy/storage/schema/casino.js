// Casino tables: casino_games, casino_blackjack_sessions, casino_venue_*, casino_lodging_bookings and casino_duel_tower_runs.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: casino_games, casino_blackjack_sessions
const gameTablesSql = `CREATE TABLE IF NOT EXISTS casino_games (
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
);`;

// Part of schemaSql: casino_venue_menu, casino_venue_orders, casino_venue_order_items
const venueTablesSql = `CREATE TABLE IF NOT EXISTS casino_venue_menu (
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
);`;

// Part of schemaSql: casino_lodging_bookings, casino_duel_tower_runs
const lodgingAndDuelTowerTablesSql = `CREATE TABLE IF NOT EXISTS casino_lodging_bookings (
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
);`;

// Part of schemaSql: idx_casino_games_user, idx_casino_blackjack_sessions_user
const gameIndexesSql = `CREATE INDEX IF NOT EXISTS idx_casino_games_user
  ON casino_games (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_blackjack_sessions_user
  ON casino_blackjack_sessions (guild_id, user_id, status, expires_at);`;

// Part of schemaSql: idx_casino_venue_menu_guild, idx_casino_venue_orders_customer,
// idx_casino_venue_order_items_status, idx_casino_venue_order_items_maker
const venueIndexesSql = `CREATE INDEX IF NOT EXISTS idx_casino_venue_menu_guild
  ON casino_venue_menu (guild_id, item_type, deleted, id);

CREATE INDEX IF NOT EXISTS idx_casino_venue_orders_customer
  ON casino_venue_orders (guild_id, customer_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_venue_order_items_status
  ON casino_venue_order_items (guild_id, status, completed_at, id);

CREATE INDEX IF NOT EXISTS idx_casino_venue_order_items_maker
  ON casino_venue_order_items (guild_id, maker_user_id, item_type, service_date, id);`;

// Part of schemaSql: idx_casino_lodging_bookings_user, idx_casino_duel_tower_runs_user
const lodgingAndDuelTowerIndexesSql = `CREATE INDEX IF NOT EXISTS idx_casino_lodging_bookings_user
  ON casino_lodging_bookings (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_duel_tower_runs_user
  ON casino_duel_tower_runs (guild_id, user_id, created_at DESC, id DESC);`;

module.exports = {
  gameTablesSql,
  venueTablesSql,
  lodgingAndDuelTowerTablesSql,
  gameIndexesSql,
  venueIndexesSql,
  lodgingAndDuelTowerIndexesSql,
};
