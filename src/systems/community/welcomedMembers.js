'use strict';

// Who was welcomed already. The same Discord ID is welcomed once in a server: joining it again later
// (after leaving, being removed, or rejoining by an invite) is not welcomed again. Every server counts
// on its own, so the same ID is welcomed once in each server, and changing a server's welcome channel
// forgets nothing.
//
// A join takes a reservation for (server, member) before the welcome is handled and settles it after:
//   - commit() when the welcome was accepted for sending: the member is remembered;
//   - release() when it was not (no channel, no permission, a full queue, a failure): nothing is
//     remembered, so a later join is welcomed.
// A second join of the same member while the first is being handled is not welcomed (the first one
// decides). The reservation is memory only; what is remembered is kept in welcomedMembers.json
// (retainedJsonFile.js: written merged, through a temporary file), so a restart does not forget it.
// A file that is damaged starts the record from empty (the damaged one is kept as .corrupt); one that
// cannot be read at the moment is not overwritten, and what was learned meanwhile is merged into it
// once it can be read. Nothing expires: a member stays until the caps make room for newer ones.
//
// It is capped, so the file cannot grow without end: at most maxPerGuild members per server, maxTotal
// in all, and WELCOMED_MEMBERS_MAX_GUILDS servers. When a cap is reached the oldest remembered member
// is forgotten first (when the servers are too many, the oldest server with all its members), and a
// member forgotten that way may be welcomed once more when they join again.

const { retainedDataFile } = require('../../platform/retainedDataSource');
const { createRetainedJsonFile } = require('../../platform/retainedJsonFile');
const defaultLogger = require('../../utils/logger');

const WELCOMED_MEMBERS_FILE = 'welcomedMembers.json';
const WELCOMED_MEMBERS_SCHEMA = 1;
const WELCOMED_MEMBERS_LIMITS = Object.freeze({ maxPerGuild: 20_000, maxTotal: 50_000 });
// More servers than this in a file is not a file this module wrote (the bot is in a few). The record
// itself never holds more: a server that would be the next one takes the place of the oldest.
const WELCOMED_MEMBERS_MAX_GUILDS = 1_000;
const MAX_GUILD_KEYS = WELCOMED_MEMBERS_MAX_GUILDS;
const ID_PATTERN = /^\d{16,22}$/u;

const UNTRACKED = Object.freeze({
  proceed: true,
  status: 'untracked',
  commit() {},
  release() {},
});

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Welcomed members ${name} is invalid.`);
  return value;
}

// The entries of a file's content, as { entries: [{ guildId, memberId, atMs }] }, or null for a document
// that is not a version-1 record or is larger than a file this module wrote can be: more than
// MAX_GUILD_KEYS servers, or more than twice the total cap of members (a file like that is not read at
// all, so that loading it cannot take long). A single entry that does not fit is dropped.
function parseDocument(value, { maxEntries }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== WELCOMED_MEMBERS_SCHEMA ||
      !value.guilds || typeof value.guilds !== 'object' || Array.isArray(value.guilds)) {
    return null;
  }
  const guildIds = Object.keys(value.guilds);
  if (guildIds.length > MAX_GUILD_KEYS) return null;
  const entries = [];
  let seen = 0;
  for (const guildId of guildIds) {
    const members = value.guilds[guildId];
    if (!Array.isArray(members)) continue;
    seen += members.length;
    if (seen > maxEntries) return null;
    if (!ID_PATTERN.test(guildId)) continue;
    for (const entry of members) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [memberId, atMs] = entry;
      if (typeof memberId === 'string' && ID_PATTERN.test(memberId) && Number.isSafeInteger(atMs) && atMs >= 0) {
        entries.push({ guildId, memberId, atMs });
      }
    }
  }
  return { entries };
}

function createWelcomedMembers({
  filePath = null,
  now = () => Date.now(),
  logger = defaultLogger,
  limits = {},
  ...fileOptions
} = {}) {
  const caps = Object.freeze({ ...WELCOMED_MEMBERS_LIMITS, ...limits });
  positiveInteger(caps.maxPerGuild, 'maxPerGuild');
  positiveInteger(caps.maxTotal, 'maxTotal');
  const file = createRetainedJsonFile({
    name: 'WELCOMED_MEMBERS',
    resolvePath: () => filePath ?? retainedDataFile(WELCOMED_MEMBERS_FILE),
    logger,
    now,
    ...fileOptions,
  });
  // guildId -> Map(memberId -> record). A Map keeps insertion order, which is the order members were
  // remembered in, so the first record of a server is its oldest. A record is { guildId, memberId,
  // atMs, forgotten }.
  const guilds = new Map();
  // Every remembered member once, in the order they were remembered in, so that the oldest of all is
  // at `head` without looking at the servers. A record that was forgotten since stays in the list,
  // marked, and is passed when the head reaches it; the list is cut when the passed part is most of it.
  let queue = [];
  let head = 0;
  const reserved = new Set();
  let total = 0;
  let loaded = false;

  function clock() {
    let value;
    try { value = Number(now()); } catch { value = Number.NaN; }
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }

  function drop(record) {
    record.forgotten = true;
    const members = guilds.get(record.guildId);
    members.delete(record.memberId);
    total -= 1;
    if (members.size === 0) guilds.delete(record.guildId);
  }

  function forgetOldestOf(guildId) {
    const members = guilds.get(guildId);
    if (!members || members.size === 0) return;
    drop(members.values().next().value);
  }

  // The list is cut to the records that are still remembered when what is not one of them is most of it
  // (the passed part, or records forgotten by a server's own cap while an older one of another server
  // kept the head where it was), so it never holds more than about twice the members plus a constant.
  function compact() {
    if (queue.length - head > 2 * total + 1_024 || (head >= 1_024 && head * 2 >= queue.length)) {
      queue = queue.slice(head).filter((record) => !record.forgotten);
      head = 0;
    }
  }

  // The oldest remembered record of all, or null.
  function oldestOverall() {
    while (head < queue.length && queue[head].forgotten) head += 1;
    if (head < queue.length) return queue[head];
    queue = [];
    head = 0;
    return null;
  }

  function forgetOldestOverall() {
    const record = oldestOverall();
    if (record === null) return false;
    drop(record);
    head += 1;
    compact();
    return true;
  }

  // The server of the oldest remembered member goes, with all its members (the room is for a server).
  function forgetOldestServer() {
    const record = oldestOverall();
    if (record === null) return false;
    for (const member of [...guilds.get(record.guildId).values()]) drop(member);
    return true;
  }

  function remember(guildId, memberId, atMs) {
    if (guilds.get(guildId)?.has(memberId)) return;
    while ((guilds.get(guildId)?.size || 0) >= caps.maxPerGuild) forgetOldestOf(guildId);
    while (total >= caps.maxTotal && forgetOldestOverall()) { /* until there is room */ }
    // The file never holds more servers than a file this module wrote may: the next server takes the
    // place of the oldest one (a file with more would not be read at all after a restart).
    while (!guilds.has(guildId) && guilds.size >= WELCOMED_MEMBERS_MAX_GUILDS && forgetOldestServer()) { /* until there is room */ }
    let members = guilds.get(guildId);
    if (!members) {
      members = new Map();
      guilds.set(guildId, members);
    }
    const record = { guildId, memberId, atMs, forgotten: false };
    members.set(memberId, record);
    queue.push(record);
    total += 1;
    compact();
  }

  function describe() {
    return {
      schema: WELCOMED_MEMBERS_SCHEMA,
      guilds: Object.fromEntries([...guilds].map(([guildId, members]) =>
        [guildId, [...members.values()].map((record) => [record.memberId, record.atMs])])),
    };
  }

  // Takes the members of a document read from the file into the ones already known, oldest first so that
  // the caps keep the newest when there are more than they allow. A member that is in both is kept once,
  // with the earlier time.
  function absorb({ entries }) {
    const all = new Map();
    const add = (guildId, memberId, atMs, order) => {
      const key = `${guildId}\u0000${memberId}`;
      const known = all.get(key);
      if (!known || atMs < known.atMs) all.set(key, { guildId, memberId, atMs, order });
    };
    let order = 0;
    for (const [guildId, members] of guilds) {
      for (const record of members.values()) add(guildId, record.memberId, record.atMs, order++);
    }
    for (const entry of entries) add(entry.guildId, entry.memberId, entry.atMs, order++);
    guilds.clear();
    queue = [];
    head = 0;
    total = 0;
    const ordered = [...all.values()].sort((left, right) => left.atMs - right.atMs || left.order - right.order);
    for (const { guildId, memberId, atMs } of ordered) remember(guildId, memberId, atMs);
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    // A file that cannot be read now is read again before the first write, and what was learned in the
    // meantime is merged into it (retainedJsonFile.js: blocked).
    const result = file.load((value) => parseDocument(value, { maxEntries: caps.maxTotal * 2 }), { merge: absorb });
    if (result.state === 'loaded') absorb(result.value);
  }

  // Takes the reservation for one join. `proceed` says whether the welcome may be handled now;
  // `status` is `reserved` (commit or release it), `welcomed` (remembered already), `pending` (another
  // join of this member is being handled) or `untracked` (an ID that cannot be remembered, handled as
  // before). Synchronous, so two joins of one member cannot both pass.
  function reserve(guildId, memberId) {
    if (typeof guildId !== 'string' || typeof memberId !== 'string' ||
        !ID_PATTERN.test(guildId) || !ID_PATTERN.test(memberId)) {
      return UNTRACKED;
    }
    ensureLoaded();
    if (guilds.get(guildId)?.has(memberId)) return Object.freeze({ proceed: false, status: 'welcomed' });
    const key = `${guildId}\u0000${memberId}`;
    if (reserved.has(key)) return Object.freeze({ proceed: false, status: 'pending' });
    reserved.add(key);
    let settled = false;
    return Object.freeze({
      proceed: true,
      status: 'reserved',
      commit() {
        if (settled) return;
        settled = true;
        reserved.delete(key);
        remember(guildId, memberId, clock());
        file.markDirty(describe);
      },
      release() {
        if (settled) return;
        settled = true;
        reserved.delete(key);
      },
    });
  }

  function has(guildId, memberId) {
    ensureLoaded();
    return Boolean(guilds.get(guildId)?.has(memberId));
  }

  // Writes what is pending now (the shutdown); true when nothing is left unwritten.
  function flush() {
    return file.flush();
  }

  function stats() {
    ensureLoaded();
    return Object.freeze({ guilds: guilds.size, total, reserved: reserved.size, pendingWrite: file.pending });
  }

  return Object.freeze({ reserve, has, flush, stats, limits: caps });
}

// The one registry of this process, made when it is first used (its file is resolved then, not when
// this module is loaded).
let shared = null;

function getWelcomedMembers() {
  if (shared === null) shared = createWelcomedMembers();
  return shared;
}

// Tests install their own registry (a temporary file, a clock they control); null puts the shared one back.
function setWelcomedMembersForTests(instance) {
  shared = instance || null;
}

function flushWelcomedMembers() {
  return shared === null ? true : shared.flush();
}

module.exports = {
  WELCOMED_MEMBERS_FILE,
  WELCOMED_MEMBERS_LIMITS,
  WELCOMED_MEMBERS_MAX_GUILDS,
  createWelcomedMembers,
  flushWelcomedMembers,
  getWelcomedMembers,
  setWelcomedMembersForTests,
};
