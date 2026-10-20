'use strict';

// Someone leaves the owner's server (XIAOJI_OWNER_GUILD_ID): the Owner is told, by a notice of the
// member-left kind (OWNER_EVENT_MEMBER_LEFT). It is built from the member's facts and fixed text
// only (ownerSafetyNotifier.js); nothing goes through the AI conversation. A leave, a kick and a ban
// cannot be told apart here, so all of them are a leave. A bot account is never reported, and
// without a valid XIAOJI_OWNER_GUILD_ID nothing is reported at all.
//
// One member is told about at most maxNotices times in one fixed window: it opens at that ID's
// first leave and lasts windowMs (7 x 24 hours), whatever happens inside it; it is neither a rolling
// window nor a calendar week. The leaves after the third in a window are not reported. The first
// leave after the window has ended opens a new one. Each owner server counts on its own.
//
// A leave is counted when it is handed to the notifier, before it is handed over: a notice the
// notifier then merges, holds back or fails to send still used one of the three. The notifier has its own
// limits on top of this one (a repeat of the
// same member within ten minutes is merged, and member-left notices have a budget of their own).
//
// The windows are kept in leaveNotices.json (retainedJsonFile.js: written merged, through a temporary
// file), so a restart does not forget them. A file that is damaged starts from empty (the damaged one
// is kept as .corrupt); one that cannot be read at the moment is not overwritten, and the windows
// opened meanwhile are merged into it once it can be read. At most maxTracked windows are kept:
// expired ones go first, then the one that began earliest.

const { SAFETY_EVENT_CODES, emitSafetyEvent } = require('../../platform/safetyEventCatalog');
const { retainedDataFile } = require('../../platform/retainedDataSource');
const { createRetainedJsonFile } = require('../../platform/retainedJsonFile');
const { getOwnerGuildId } = require('../../utils/env');
const defaultLogger = require('../../utils/logger');

const MEMBER_LEAVE_NOTICE_FILE = 'leaveNotices.json';
const MEMBER_LEAVE_NOTICE_SCHEMA = 1;
const MEMBER_LEAVE_NOTICE_LIMITS = Object.freeze({
  windowMs: 7 * 24 * 60 * 60_000,
  maxNotices: 3,
  maxTracked: 5_000,
  // Expired windows are looked for at most this often, and a notice that was left out is logged at
  // most this often, with the number of lines left out since the last.
  sweepIntervalMs: 60_000,
  logIntervalMs: 60_000,
});
// The IDs of the server and of the member, as the notice states them (the notifier reads a Discord ID
// as 17 to 20 digits and calls anything else unknown).
const ID_PATTERN = /^\d{17,20}$/u;
// An owner server ID is configured as 16 to 22 digits (getOwnerGuildId); a real server ID is 17 to 20.
const OWNER_ID_PATTERN = /^\d{16,22}$/u;
// What a name, or a time, that the member does not carry is called in the notice (the same word the
// notifier uses for a value it does not have).
const UNKNOWN_NAME = '未知';

const IGNORED = Object.freeze({
  otherGuild: Object.freeze({ outcome: 'ignored', reason: 'not-owner-guild', count: 0 }),
  bot: Object.freeze({ outcome: 'ignored', reason: 'bot', count: 0 }),
  invalid: Object.freeze({ outcome: 'ignored', reason: 'invalid-id', count: 0 }),
});

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Member leave notice ${name} is invalid.`);
  return value;
}

// A value read from a member that may be partial or odd: the first of the readers that gives text,
// or the word for unknown. A reader that throws is skipped.
function readText(...readers) {
  for (const reader of readers) {
    try {
      const value = reader();
      if (typeof value === 'string' && value.trim() !== '') return value;
    } catch { /* a getter that fails is a value that is unknown */ }
  }
  return UNKNOWN_NAME;
}

function readInteger(reader) {
  try {
    const value = reader();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

// The windows as the file holds them, or null for a document that is not a version-1 record or holds
// more than twice maxTracked windows (more than a file this module wrote can; it is not read at all, so
// that loading it cannot take long). An entry that does not fit is dropped.
function parseDocument(value, { maxEntries }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== MEMBER_LEAVE_NOTICE_SCHEMA ||
      !Array.isArray(value.windows) || value.windows.length > maxEntries) {
    return null;
  }
  const windows = [];
  for (const entry of value.windows) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    const [guildId, memberId, startMs, count] = entry;
    if (typeof guildId === 'string' && ID_PATTERN.test(guildId) && typeof memberId === 'string' &&
        ID_PATTERN.test(memberId) && Number.isSafeInteger(startMs) && startMs >= 0 &&
        Number.isSafeInteger(count) && count >= 1) {
      windows.push({ guildId, memberId, startMs, count });
    }
  }
  return { windows };
}

function createMemberLeaveNotices({
  filePath = null,
  now = () => Date.now(),
  logger = defaultLogger,
  limits = {},
  emit = emitSafetyEvent,
  ownerGuildId = getOwnerGuildId,
  ...fileOptions
} = {}) {
  const caps = Object.freeze({ ...MEMBER_LEAVE_NOTICE_LIMITS, ...limits });
  for (const name of ['windowMs', 'maxNotices', 'maxTracked', 'sweepIntervalMs', 'logIntervalMs']) {
    positiveInteger(caps[name], name);
  }
  const file = createRetainedJsonFile({
    name: 'MEMBER_LEAVE_NOTICES',
    resolvePath: () => filePath ?? retainedDataFile(MEMBER_LEAVE_NOTICE_FILE),
    logger,
    now,
    ...fileOptions,
  });
  // key -> { guildId, memberId, startMs, count }, in the order the windows were opened.
  const windows = new Map();
  let loaded = false;
  let lastSweepAt = -Infinity;
  let cappedLog = null;

  function clock() {
    let value;
    try { value = Number(now()); } catch { value = Number.NaN; }
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }

  // A window is open from its start (included) until windowMs later (excluded). One that starts in the
  // future (the clock was set back) is not open: it is left, and the next leave opens a new one.
  function isOpen(entry, at) {
    return at >= entry.startMs && at - entry.startMs < caps.windowMs;
  }

  function sweep(at) {
    lastSweepAt = at;
    for (const [key, entry] of windows) {
      if (!isOpen(entry, at)) windows.delete(key);
    }
  }

  function forgetEarliest() {
    let victim = null;
    let victimStart = Infinity;
    for (const [key, entry] of windows) {
      if (entry.startMs < victimStart) {
        victim = key;
        victimStart = entry.startMs;
      }
    }
    if (victim === null) return false;
    windows.delete(victim);
    return true;
  }

  // A window that has run out at the moment of the write is of no use after a restart (it is dropped when
  // the file is read), so it is not written either. One that starts in the future (the clock was set back)
  // has not run out and is written as it is.
  function describe() {
    const at = clock();
    return {
      schema: MEMBER_LEAVE_NOTICE_SCHEMA,
      windows: [...windows.values()].filter((entry) => at - entry.startMs < caps.windowMs)
        .map((entry) => [entry.guildId, entry.memberId, entry.startMs, entry.count]),
    };
  }

  // Takes the windows of a document read from the file into the ones already open. The windows that are
  // no longer open are dropped. A member whose window is in the file and who left again since (the file
  // could not be read until now) is in that same window, since it was open when they left: the counts add
  // up and the start is the file's. The newest windows are kept when there are more than maxTracked.
  function absorb({ windows: stored }) {
    const at = clock();
    const merged = new Map();
    for (const entry of stored) {
      const key = `${entry.guildId}\u0000${entry.memberId}`;
      const known = merged.get(key);
      if (isOpen(entry, at) && (!known || entry.startMs > known.startMs)) merged.set(key, { ...entry });
    }
    for (const [key, entry] of windows) {
      if (!isOpen(entry, at)) continue;
      const earlier = merged.get(key);
      if (earlier) merged.set(key, { ...earlier, count: earlier.count + entry.count });
      else merged.set(key, { ...entry });
    }
    const ordered = [...merged.entries()].sort((left, right) => left[1].startMs - right[1].startMs);
    windows.clear();
    for (const [key, entry] of ordered.slice(Math.max(0, ordered.length - caps.maxTracked))) windows.set(key, entry);
    lastSweepAt = at;
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    // A file that cannot be read now is read again before the first write, and the windows opened in the
    // meantime are merged into it (retainedJsonFile.js: blocked).
    const result = file.load((value) => parseDocument(value, { maxEntries: caps.maxTracked * 2 }), { merge: absorb });
    if (result.state === 'loaded') absorb(result.value);
  }

  function noteCapped(at) {
    if (cappedLog !== null && at >= cappedLog.at && at - cappedLog.at < caps.logIntervalMs) {
      cappedLog.skipped += 1;
      return;
    }
    const skipped = cappedLog === null ? 0 : cappedLog.skipped;
    cappedLog = { at, skipped: 0 };
    try {
      logger?.info?.(`[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_CAPPED skipped=${skipped}`);
    } catch { /* logging never blocks */ }
  }

  function deliver(member, { guildId, memberId, at }) {
    emit(SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT, {
      at,
      actorId: memberId,
      guildId,
      guildName: readText(() => member.guild.name),
      notice: {
        subjectId: memberId,
        subjectName: readText(() => member.displayName, () => member.user.globalName, () => member.user.username),
        subjectUsername: readText(() => member.user.username),
        joinedAtMs: readInteger(() => member.joinedTimestamp),
        leftAtMs: at,
        memberCount: readInteger(() => member.guild.memberCount),
      },
    });
  }

  // One member left a server (the member as discord.js delivers it, a partial one included). Returns
  // { outcome, reason?, count }: `notified` (count is which notice of the window it was), `capped`
  // (the window's notices are used up) or `ignored` (not the owner's server, a bot, or no usable ID).
  // Never throws.
  function report(member) {
    try {
      let owner = null;
      try { owner = ownerGuildId(); } catch { owner = null; }
      const guildId = member?.guild?.id;
      if (typeof owner !== 'string' || !OWNER_ID_PATTERN.test(owner) || guildId !== owner ||
          !ID_PATTERN.test(guildId)) {
        return IGNORED.otherGuild;
      }
      if (member?.user?.bot === true) return IGNORED.bot;
      const memberId = member?.id ?? member?.user?.id;
      if (typeof memberId !== 'string' || !ID_PATTERN.test(memberId)) return IGNORED.invalid;

      const at = clock();
      ensureLoaded();
      const key = `${guildId}\u0000${memberId}`;
      const known = windows.get(key);
      let count;
      if (known && isOpen(known, at)) {
        if (known.count >= caps.maxNotices) {
          noteCapped(at);
          return Object.freeze({ outcome: 'capped', reason: 'window-used-up', count: known.count });
        }
        known.count += 1;
        count = known.count;
      } else {
        windows.delete(key);
        if (at - lastSweepAt >= caps.sweepIntervalMs || windows.size >= caps.maxTracked) sweep(at);
        while (windows.size >= caps.maxTracked && forgetEarliest()) { /* until there is room */ }
        windows.set(key, { guildId, memberId, startMs: at, count: 1 });
        count = 1;
      }
      // Counted before it is handed over.
      file.markDirty(describe);
      try {
        deliver(member, { guildId, memberId, at });
      } catch {
        try { logger?.warn?.('[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_HANDOVER_FAILED'); } catch { /* ignored */ }
      }
      return Object.freeze({ outcome: 'notified', count });
    } catch {
      try { logger?.warn?.('[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_FAILED'); } catch { /* ignored */ }
      return Object.freeze({ outcome: 'ignored', reason: 'failed', count: 0 });
    }
  }

  // Writes what is pending now (the shutdown); true when nothing is left unwritten.
  function flush() {
    return file.flush();
  }

  function stats() {
    ensureLoaded();
    return Object.freeze({ tracked: windows.size, pendingWrite: file.pending });
  }

  return Object.freeze({ report, flush, stats, limits: caps });
}

// The one set of windows of this process, made when it is first used.
let shared = null;

function getMemberLeaveNotices() {
  if (shared === null) shared = createMemberLeaveNotices();
  return shared;
}

// Tests install their own (a temporary file, a clock and a notifier they control); null puts the
// shared one back.
function setMemberLeaveNoticesForTests(instance) {
  shared = instance || null;
}

function reportMemberLeft(member) {
  return getMemberLeaveNotices().report(member);
}

function flushMemberLeaveNotices() {
  return shared === null ? true : shared.flush();
}

module.exports = {
  MEMBER_LEAVE_NOTICE_FILE,
  MEMBER_LEAVE_NOTICE_LIMITS,
  createMemberLeaveNotices,
  flushMemberLeaveNotices,
  getMemberLeaveNotices,
  reportMemberLeft,
  setMemberLeaveNoticesForTests,
};
