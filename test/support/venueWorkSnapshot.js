'use strict';

// Golden snapshot helper for the venue <-> work characterization tests.
//
// It reads synthetic SQLite state through the public coin database API, normalizes the
// only non-deterministic values (primary cycle UUIDs and hashes derived from them), and
// compares the result with reviewed golden files under test/fixtures/.  It never opens a
// database on its own, so the caller decides which synthetic COIN_DB_PATH is used.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN_FORMAT = 'xiaoji-venue-work-golden/v1';
// Set this variable to "update" only after reviewing an intended behavior change.
const GOLDEN_UPDATE_ENV = 'XIAOJI_VENUE_WORK_GOLDEN';
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures');

// Every table that the venue <-> work flows read or write, including the wallet,
// chip, transaction and reward ledgers.  Empty tables stay in the snapshot so that
// "nothing was written here" is part of the reviewed behavior as well.
const TRACKED_TABLES = Object.freeze([
  'casino_venue_menu',
  'casino_venue_orders',
  'casino_venue_order_items',
  'coin_jobs',
  'coin_work_tasks',
  'coin_work_penalties',
  'coin_work_penalty_appeals',
  'coin_payroll_history',
  'coin_work_legacy_snapshots',
  'coin_work_legacy_snapshot_items',
  'coin_work_legacy_settlements',
  'coin_primary_jobs_global',
  'coin_primary_job_cycles',
  'coin_primary_cycle_penalties',
  'coin_primary_cycle_penalty_appeals',
  'coin_primary_cycle_payroll',
  'coin_guild_settings',
  'coin_wallets',
  'coin_guild_players',
  'coin_bank_accounts_global',
  'coin_debts',
  'coin_transactions',
  'coin_operation_receipts',
  'coin_admin_logs',
  'chip_accounts_global',
  'chip_ledger',
  'reward_grants',
  'reward_grants_v2',
]);

// Not compared by the untracked-table guard: sqlite_sequence only mirrors tracked
// AUTOINCREMENT tables, and coin_metadata.schema_version.updated_at is rewritten by
// every database open, so a simulated restart legitimately touches it.
const IGNORED_INTERNAL_TABLES = Object.freeze(['sqlite_sequence', 'coin_metadata']);

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const REWARD_KEY_PATTERN = /reward:v1:[0-9a-f]{64}/gu;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Independent re-implementation of the reward identity hash so the snapshot can label
// keys by their meaning instead of trusting the product code under test.
function rewardKeyFor({ kind, canonicalSourceId, rewardKind, userId }) {
  return `reward:v1:${sha256(JSON.stringify([kind, canonicalSourceId, rewardKind, userId]))}`;
}

function rewardPayloadHashFor(row) {
  return sha256(JSON.stringify([row.kind, row.canonical_source_id, row.reward_kind, row.user_id, Number(row.amount)]));
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTuples(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const result = compareValues(left[index], right[index]);
    if (result !== 0) return result;
  }
  return 0;
}

function readTableDefinition(api, table) {
  const info = api.all(`PRAGMA table_info("${table}")`);
  if (!info.length) throw new Error(`Tracked table is missing from the synthetic database: ${table}`);
  const columns = [...info].sort((left, right) => Number(left.cid) - Number(right.cid)).map((column) => column.name);
  const key = info
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  return { key: key.length ? key : columns, columns };
}

function readTrackedTables(api) {
  return Object.fromEntries(TRACKED_TABLES.map((table) => {
    const definition = readTableDefinition(api, table);
    return [table, { ...definition, rows: api.all(`SELECT * FROM "${table}" ORDER BY rowid`) }];
  }));
}

function digestUntrackedTables(api) {
  const names = api
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name)
    .filter((name) => !TRACKED_TABLES.includes(name) && !IGNORED_INTERNAL_TABLES.includes(name));
  return Object.fromEntries(names.map((name) => {
    const rows = api.all(`SELECT * FROM "${name}"`).map((row) => JSON.stringify(row)).sort();
    return [name, sha256(JSON.stringify(rows))];
  }));
}

class VenueWorkSnapshotter {
  constructor({ withCoinDatabase, userLabels = {} } = {}) {
    if (typeof withCoinDatabase !== 'function') throw new TypeError('withCoinDatabase is required.');
    this.withCoinDatabase = withCoinDatabase;
    this.userLabels = { ...userLabels };
    this.uuidLabels = new Map();
    this.cycleOrdinals = new Map();
    this.untrackedBaseline = null;
  }

  userLabel(userId) {
    return this.userLabels[userId] || String(userId);
  }

  // Remember the untouched state of every other table right after initialization.
  async recordUntrackedBaseline() {
    this.untrackedBaseline = await this.withCoinDatabase((api) => digestUntrackedTables(api));
  }

  async assertUntrackedTablesUnchanged(context) {
    assert.ok(this.untrackedBaseline, 'recordUntrackedBaseline() must run before the flow starts.');
    const current = await this.withCoinDatabase((api) => digestUntrackedTables(api));
    const changed = [...new Set([...Object.keys(this.untrackedBaseline), ...Object.keys(current)])]
      .filter((name) => this.untrackedBaseline[name] !== current[name])
      .sort();
    assert.deepEqual(changed, [], `${context}: venue/work flow changed tables outside the golden snapshot`);
  }

  registerCycle(uuid, userId) {
    if (!uuid || this.uuidLabels.has(uuid)) return;
    const label = this.userLabel(userId);
    const ordinal = (this.cycleOrdinals.get(label) || 0) + 1;
    this.cycleOrdinals.set(label, ordinal);
    this.uuidLabels.set(uuid, `<cycle:${label}#${ordinal}>`);
  }

  registerCycles(raw) {
    const cycles = [...raw.coin_primary_job_cycles.rows].sort((left, right) => compareTuples(
      [left.created_at, left.starts_at, left.user_id, left.job_name],
      [right.created_at, right.starts_at, right.user_id, right.job_name]
    ));
    for (const cycle of cycles) this.registerCycle(cycle.cycle_id, cycle.user_id);
    const primaries = [...raw.coin_primary_jobs_global.rows].sort((left, right) => compareTuples(
      [left.requested_at, left.user_id],
      [right.requested_at, right.user_id]
    ));
    for (const primary of primaries) this.registerCycle(primary.next_cycle_id, primary.user_id);
  }

  replaceUuids(text) {
    return text.replace(UUID_PATTERN, (uuid) => this.uuidLabels.get(uuid.toLowerCase()) || uuid);
  }

  buildRewardKeyLabels(raw) {
    const labels = new Map();
    const add = (identity) => {
      const key = rewardKeyFor(identity);
      if (labels.has(key)) return;
      labels.set(key, `<reward-key:${identity.kind}|${this.replaceUuids(identity.canonicalSourceId)}|` +
        `${identity.rewardKind}|${identity.userId}>`);
    };
    for (const [uuid] of this.uuidLabels) {
      const owner = raw.coin_primary_job_cycles.rows.find((row) => row.cycle_id === uuid) ||
        raw.coin_primary_jobs_global.rows.find((row) => row.next_cycle_id === uuid);
      if (owner) {
        add({ kind: 'work-settlement', canonicalSourceId: `primary:${uuid}`, rewardKind: 'salary', userId: owner.user_id });
      }
    }
    for (const job of raw.coin_jobs.rows) {
      add({
        kind: 'work-settlement',
        canonicalSourceId: `legacy:${job.id}:${job.pay_at}`,
        rewardKind: 'salary',
        userId: job.user_id,
      });
    }
    for (const grant of raw.reward_grants_v2.rows) {
      add({
        kind: grant.kind,
        canonicalSourceId: grant.canonical_source_id,
        rewardKind: grant.reward_kind,
        userId: grant.user_id,
      });
    }
    return labels;
  }

  normalizeCell(value, rewardKeyLabels) {
    if (typeof value !== 'string') return value;
    const withRewardKeys = value.replace(REWARD_KEY_PATTERN, (key) => rewardKeyLabels.get(key) || key);
    return this.replaceUuids(withRewardKeys);
  }

  normalize(raw) {
    this.registerCycles(raw);
    const rewardKeyLabels = this.buildRewardKeyLabels(raw);
    const tables = {};
    for (const table of TRACKED_TABLES) {
      const { key, columns, rows } = raw[table];
      const normalizedRows = rows.map((row) => columns.map((column) => {
        if (table === 'reward_grants_v2' && column === 'payload_hash') {
          // A matching payload hash is replaced by a marker; a mismatch keeps the raw value.
          return row.payload_hash === rewardPayloadHashFor(row) ? '<payload-hash:verified>' : row.payload_hash;
        }
        return this.normalizeCell(row[column], rewardKeyLabels);
      }));
      for (const normalizedRow of normalizedRows) {
        normalizedRow.forEach((cell, index) => {
          if (typeof cell === 'string' && new RegExp(UUID_PATTERN.source, 'iu').test(cell)) {
            throw new Error(`Unregistered UUID in ${table}.${columns[index]}; the golden snapshot would not be stable.`);
          }
        });
      }
      const keyIndexes = key.map((column) => columns.indexOf(column));
      normalizedRows.sort((left, right) => compareTuples(
        keyIndexes.map((index) => left[index]),
        keyIndexes.map((index) => right[index])
      ));
      tables[table] = { key, columns, rows: normalizedRows };
    }
    return tables;
  }

  async capture() {
    const raw = await this.withCoinDatabase((api) => readTrackedTables(api));
    return this.normalize(raw);
  }
}

function createVenueWorkSnapshotter(options) {
  return new VenueWorkSnapshotter(options);
}

function buildGoldenDocument(flow, checkpoints) {
  const entries = Object.entries(checkpoints);
  assert.ok(entries.length > 0, 'A golden document needs at least one checkpoint.');
  const tables = {};
  for (const table of TRACKED_TABLES) {
    const { key, columns } = entries[0][1][table];
    for (const [name, snapshot] of entries) {
      assert.deepEqual({ key: snapshot[table].key, columns: snapshot[table].columns }, { key, columns },
        `${flow}: table definition of ${table} changed inside checkpoint ${name}`);
    }
    tables[table] = { key, columns };
  }
  return {
    format: GOLDEN_FORMAT,
    flow,
    tables,
    checkpoints: Object.fromEntries(entries.map(([name, snapshot]) => [
      name,
      Object.fromEntries(TRACKED_TABLES.map((table) => [table, snapshot[table].rows])),
    ])),
  };
}

// Pretty JSON where every array of plain values (one table row, one column list)
// stays on a single line, so golden diffs show whole rows.
function formatGoldenValue(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) return JSON.stringify(value);
    const inner = `${indent}  `;
    return `[\n${value.map((item) => inner + formatGoldenValue(item, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const inner = `${indent}  `;
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${formatGoldenValue(item, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function formatGoldenDocument(document) {
  return `${formatGoldenValue(document)}\n`;
}

function keysOf(...objects) {
  return [...new Set(objects.flatMap((object) => Object.keys(object || {})))];
}

function describeGoldenDifferences(expected, actual, limit = 25) {
  const lines = [];
  if (expected.format !== actual.format || expected.flow !== actual.flow) {
    lines.push(`header expected ${JSON.stringify([expected.format, expected.flow])} actual ${JSON.stringify([actual.format, actual.flow])}`);
  }
  for (const table of keysOf(expected.tables, actual.tables)) {
    if (JSON.stringify(expected.tables?.[table]) !== JSON.stringify(actual.tables?.[table])) {
      lines.push(`table definition ${table} expected ${JSON.stringify(expected.tables?.[table])} actual ${JSON.stringify(actual.tables?.[table])}`);
    }
  }
  const expectedNames = Object.keys(expected.checkpoints || {});
  const actualNames = Object.keys(actual.checkpoints || {});
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    lines.push(`checkpoints expected ${JSON.stringify(expectedNames)} actual ${JSON.stringify(actualNames)}`);
  }
  for (const checkpoint of keysOf(expected.checkpoints, actual.checkpoints)) {
    const expectedTables = expected.checkpoints?.[checkpoint] || {};
    const actualTables = actual.checkpoints?.[checkpoint] || {};
    for (const table of keysOf(expectedTables, actualTables)) {
      const definition = actual.tables?.[table] || expected.tables?.[table] || { key: [], columns: [] };
      const keyIndexes = definition.key.map((column) => definition.columns.indexOf(column));
      const keyOf = (row) => JSON.stringify(keyIndexes.map((index) => row[index]));
      const expectedRows = new Map((expectedTables[table] || []).map((row) => [keyOf(row), row]));
      const actualRows = new Map((actualTables[table] || []).map((row) => [keyOf(row), row]));
      for (const rowKey of keysOf(Object.fromEntries(expectedRows), Object.fromEntries(actualRows))) {
        const expectedRow = expectedRows.get(rowKey);
        const actualRow = actualRows.get(rowKey);
        if (!expectedRow) {
          lines.push(`[${checkpoint}] ${table} ${rowKey}: unexpected row ${JSON.stringify(actualRow)}`);
        } else if (!actualRow) {
          lines.push(`[${checkpoint}] ${table} ${rowKey}: missing row ${JSON.stringify(expectedRow)}`);
        } else {
          const changed = definition.columns
            .map((column, index) => [column, expectedRow[index], actualRow[index]])
            .filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right))
            .map(([column, left, right]) => `${column} expected ${JSON.stringify(left)} actual ${JSON.stringify(right)}`);
          if (changed.length) lines.push(`[${checkpoint}] ${table} ${rowKey}: ${changed.join('; ')}`);
        }
      }
    }
  }
  if (lines.length > limit) return [...lines.slice(0, limit), `... ${lines.length - limit} more difference(s)`];
  return lines;
}

function goldenPath(fileName) {
  if (path.basename(fileName) !== fileName || !fileName.endsWith('.golden.json')) {
    throw new Error(`Golden files must be plain *.golden.json names: ${fileName}`);
  }
  return path.join(FIXTURE_ROOT, fileName);
}

function assertMatchesGolden(fileName, document) {
  const filePath = goldenPath(fileName);
  const text = formatGoldenDocument(document);
  const actual = JSON.parse(text);
  if (process.env[GOLDEN_UPDATE_ENV] === 'update') {
    fs.writeFileSync(filePath, text, 'utf8');
    return;
  }
  assert.ok(fs.existsSync(filePath), `Missing golden file ${fileName}; generate it with ${GOLDEN_UPDATE_ENV}=update and review it.`);
  const expected = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const differences = describeGoldenDifferences(expected, actual);
  if (differences.length) {
    assert.fail([
      `${fileName} no longer matches the reviewed golden snapshot:`,
      ...differences,
      `Only after reviewing an intended behavior change, regenerate with ${GOLDEN_UPDATE_ENV}=update.`,
    ].join('\n'));
  }
  assert.deepStrictEqual(actual, expected);
}

module.exports = {
  GOLDEN_FORMAT,
  GOLDEN_UPDATE_ENV,
  TRACKED_TABLES,
  assertMatchesGolden,
  buildGoldenDocument,
  createVenueWorkSnapshotter,
  describeGoldenDifferences,
  formatGoldenDocument,
  rewardKeyFor,
};
