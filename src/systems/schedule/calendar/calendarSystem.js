const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const DELETED_LIFECYCLE = 'deleted';
const DELETED_TITLE = '[deleted]';
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
// The longest range /calendar list accepts in its days option.
const MAX_LIST_DAYS = 365;
// A list reply lists at most this many events, stays below Discord's 2000-character message limit,
// and shortens long descriptions to this length when the full list would not fit.
const MAX_LISTED_EVENTS = 10;
const MAX_LIST_CHARACTERS = 1900;
const SHORT_DESCRIPTION_CHARACTERS = 80;
// One person keeps at most this many events. An event that has not ended counts against it; one that
// has ended is no longer listed anywhere, so it gives way to a new event instead of blocking it.
const MAX_EVENTS_PER_USER = 100;
// A write drops events that ended, and deletion markers that were written, longer ago than this.
const RETAIN_MS = 30 * 86_400_000;
// A deletion marker only has to outlive a repeated delivery of the same interaction, so one owner
// keeps the most recent ones even inside the retention time.
const MAX_DELETED_MARKERS_PER_OWNER = 100;

function parseCalendarDate(input) {
  const match = String(input || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 &&
    date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute ? date : null;
}

function parseTaipeiCalendarDate(input) {
  const match = String(input || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  if (year < 100 || hour > 23 || minute > 59) return null;
  const taipeiOffsetMs = 8 * 3_600_000;
  const instant = Date.UTC(year, month - 1, day, hour, minute) - taipeiOffsetMs;
  const check = new Date(instant + taipeiOffsetMs);
  if (!Number.isFinite(instant) || check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  return new Date(instant);
}

function normalizeEvent(event, id) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !event.title || !Number.isFinite(Number(event.startsAt))) throw new Error('Invalid calendar event: ' + id);
  const scope = event.scope || 'shared';
  if (!['shared', 'personal'].includes(scope)) throw new Error('Invalid calendar scope: ' + id);
  if (scope === 'shared' && !event.guildId) throw new Error('Shared calendar event has no guild: ' + id);
  const userId = event.userId || (scope === 'personal' ? event.createdBy : null);
  if (scope === 'personal' && !userId) throw new Error('Personal calendar event has no owner: ' + id);
  if (event.lifecycle && !['active', DELETED_LIFECYCLE].includes(event.lifecycle)) {
    throw new Error('Invalid calendar lifecycle: ' + id);
  }
  if (event.lifecycle === DELETED_LIFECYCLE && !Number.isFinite(Number(event.deletedAt))) {
    throw new Error('Deleted calendar event has no deletion time: ' + id);
  }
  return {
    ...event, id, scope, userId: userId ? String(userId) : null,
    sourceGuildId: event.sourceGuildId || event.guildId || null,
    startsAt: Number(event.startsAt),
  };
}

function isDeletedEvent(event) {
  return event?.lifecycle === DELETED_LIFECYCLE;
}

function isReliableSharedOwner(event) {
  return event?.scope === 'shared' && event.schemaVersion === 1 &&
    DISCORD_SNOWFLAKE.test(String(event.createdBy || '')) &&
    DISCORD_SNOWFLAKE.test(String(event.guildId || '')) &&
    DISCORD_SNOWFLAKE.test(String(event.channelId || '')) &&
    String(event.sourceGuildId || '') === String(event.guildId) &&
    Number(event.createdAt) > 0 && Number.isFinite(Number(event.createdAt));
}

function resolveCalendarEventOwner(event) {
  if (!event) return null;
  if (event.scope === 'personal' && event.userId) return String(event.userId);
  return isReliableSharedOwner(event) ? String(event.createdBy) : null;
}

// Drops, in place, what is past its retention time at `now`, then keeps only the newest deletion
// markers of each owner. An event that has not ended is never dropped here.
function pruneStaleEvents(events, now) {
  const cutoff = now - RETAIN_MS;
  const markersByOwner = new Map();
  for (const [id, event] of Object.entries(events)) {
    if (!isDeletedEvent(event)) {
      if (event.startsAt < cutoff) delete events[id];
      continue;
    }
    if (Number(event.deletedAt) < cutoff) {
      delete events[id];
      continue;
    }
    const owner = event.scope === 'personal' ? 'user:' + event.userId : 'guild:' + event.guildId;
    if (!markersByOwner.has(owner)) markersByOwner.set(owner, []);
    markersByOwner.get(owner).push(event);
  }
  for (const markers of markersByOwner.values()) {
    markers.sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt));
    for (const marker of markers.slice(MAX_DELETED_MARKERS_PER_OWNER)) delete events[marker.id];
  }
}

function normalizedPersonalPayload({ userId, sourceGuildId, title, description = '', startsAt, createdAt }) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle || !userId || !Number.isFinite(Number(startsAt)) ||
      !Number.isFinite(Number(createdAt))) {
    throw new Error('Invalid personal calendar event.');
  }
  return {
    userId: String(userId), sourceGuildId: sourceGuildId ? String(sourceGuildId) : null,
    title: normalizedTitle.slice(0, 100), description: String(description || '').trim().slice(0, 1000),
    startsAt: Number(startsAt), createdAt: Number(createdAt),
  };
}

function requestDigest(payload) {
  return crypto.createHash('sha256').update(JSON.stringify([
    payload.userId, payload.sourceGuildId, payload.title, payload.description,
    payload.startsAt, payload.createdAt,
  ])).digest('hex');
}

function deterministicPersonalEventId(interactionId) {
  const normalized = String(interactionId || '').trim();
  if (!DISCORD_SNOWFLAKE.test(normalized)) throw new Error('Invalid calendar interaction id.');
  return 'cal-' + crypto.createHash('sha256').update('calendar:add:v1:' + normalized).digest('hex');
}

function createCalendarSystem({ filePath }) {
  if (!path.isAbsolute(filePath)) throw new Error('Calendar path must be absolute.');
  const lockPath = filePath + '.lock';
  const backupPath = filePath + '.legacy-v1.bak';
  const receiptPath = filePath + '.migration-v1.receipt.json';

  function readSource() {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) throw new Error('Calendar data is empty.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Calendar data must be an object.');
    return { raw, parsed };
  }

  function readCalendarEvents() {
    const { parsed } = readSource();
    return Object.fromEntries(Object.entries(parsed).map(([id, event]) => [id, normalizeEvent(event, id)]));
  }

  function atomicWriteAt(targetPath, events) {
    const tempPath = targetPath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    let handle;
    try {
      handle = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify(events, null, 2) + '\n', 'utf8');
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(tempPath, targetPath);
    } finally {
      if (handle !== null && handle !== undefined) fs.closeSync(handle);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
  const atomicWrite = (events) => atomicWriteAt(filePath, events);

  function hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  function isLegacy(parsed) {
    return Object.values(parsed).some((item) => !item || item.schemaVersion !== 1);
  }

  function migrateLegacyCalendarStore() {
    return withWriteLock(() => {
      const { raw, parsed } = readSource();
      const records = Object.fromEntries(Object.entries(parsed).map(([id, item]) => [
        id, { ...normalizeEvent(item, id), schemaVersion: 1 },
      ]));
      const expected = JSON.stringify(records, null, 2) + '\n';
      if (fs.existsSync(receiptPath)) {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        if (!fs.existsSync(backupPath) || hash(fs.readFileSync(backupPath)) !== receipt.sourceHash) {
          throw new Error('Calendar migration receipt or backup mismatch.');
        }
        return receipt;
      }
      if (!isLegacy(parsed) && !fs.existsSync(backupPath)) return null;
      if (fs.existsSync(backupPath)) {
        const original = fs.readFileSync(backupPath, 'utf8');
        const originalParsed = JSON.parse(original);
        const normalized = Object.fromEntries(Object.entries(originalParsed).map(([id, item]) => [
          id, { ...normalizeEvent(item, id), schemaVersion: 1 },
        ]));
        const normalizedText = JSON.stringify(normalized, null, 2) + '\n';
        if (raw === original) atomicWrite(normalized);
        else if (raw !== normalizedText) {
          throw new Error('Calendar migration source changed without a receipt.');
        }
        atomicWriteAt(receiptPath, {
          version: 1, sourceHash: hash(original), targetHash: hash(normalizedText),
          recordCount: Object.keys(originalParsed).length,
        });
        return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      }
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      const backupHandle = fs.openSync(backupPath, 'r+');
      try { fs.fsyncSync(backupHandle); } finally { fs.closeSync(backupHandle); }
      if (hash(fs.readFileSync(backupPath)) !== hash(raw)) throw new Error('Calendar migration backup mismatch.');
      atomicWrite(records);
      const receipt = {
        version: 1, sourceHash: hash(raw), targetHash: hash(expected),
        recordCount: Object.keys(parsed).length,
      };
      atomicWriteAt(receiptPath, receipt);
      return receipt;
    });
  }

  function withWriteLock(change) {
    const handle = fs.openSync(lockPath, 'wx', 0o600);
    try {
      return change();
    } finally {
      fs.closeSync(handle);
      fs.unlinkSync(lockPath);
    }
  }

  function initializeCalendarStore() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return withWriteLock(() => {
      if (fs.existsSync(filePath)) return false;
      if (fs.existsSync(backupPath) || fs.existsSync(receiptPath)) {
        throw new Error('Calendar migration evidence exists; missing source cannot be initialized.');
      }
      atomicWrite({});
      return true;
    });
  }

  function mutateEvents(change) {
    return withWriteLock(() => {
      const { parsed } = readSource();
      if (isLegacy(parsed) || (fs.existsSync(backupPath) && !fs.existsSync(receiptPath))) {
        throw new Error('Calendar data requires a verified legacy migration.');
      }
      const events = readCalendarEvents();
      const result = change(events);
      if (result !== false) atomicWrite(events);
      return result;
    });
  }

  function writeCalendarEvents(events) {
    return mutateEvents((current) => {
      for (const key of Object.keys(current)) delete current[key];
      for (const [id, event] of Object.entries(events)) current[id] = normalizeEvent(event, id);
    });
  }

  function createCalendarEvent({ guildId, channelId, createdBy, title, description = '', startsAt, now = Date.now() }) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle || !guildId || !createdBy || !Number.isFinite(Number(startsAt))) {
      throw new Error('Invalid shared calendar event.');
    }
    return {
      id: crypto.randomUUID(), schemaVersion: 1, scope: 'shared', guildId: String(guildId),
      sourceGuildId: String(guildId), channelId, createdBy: String(createdBy),
      title: normalizedTitle.slice(0, 100), description: String(description || '').trim().slice(0, 1000),
      startsAt: Number(startsAt), createdAt: now,
    };
  }

  function createPersonalCalendarEvent({ userId, sourceGuildId, title, description = '', startsAt,
    now = Date.now(), id = crypto.randomUUID(), digest = null }) {
    const payload = normalizedPersonalPayload({
      userId, sourceGuildId, title, description, startsAt, createdAt: now,
    });
    return {
      id, schemaVersion: 1, scope: 'personal', userId: payload.userId,
      sourceGuildId: payload.sourceGuildId, createdBy: payload.userId,
      title: payload.title, description: payload.description,
      startsAt: payload.startsAt, createdAt: payload.createdAt,
      ...(digest ? { requestDigest: digest } : {}),
    };
  }

  function addPersonalCalendarEvent({ interactionId, userId, sourceGuildId, title, description = '',
    startsAt, createdAt }) {
    if (!sourceGuildId) throw new Error('Personal calendar source guild is required.');
    const payload = normalizedPersonalPayload({
      userId, sourceGuildId, title, description, startsAt, createdAt,
    });
    const id = deterministicPersonalEventId(interactionId);
    const digest = requestDigest(payload);
    const candidate = createPersonalCalendarEvent({
      ...payload, now: payload.createdAt, id, digest,
    });

    // Why an add was refused; a refused add writes nothing.
    let refusal = null;
    const added = mutateEvents((events) => {
      const existing = events[id];
      if (existing) {
        if (resolveCalendarEventOwner(existing) !== payload.userId || existing.requestDigest !== digest) {
          throw new Error('Calendar interaction id conflicts with another event.');
        }
        return { event: existing, replayed: true, deleted: isDeletedEvent(existing) };
      }
      // An event further ahead than /calendar list can reach could not be listed, so not deleted either.
      if (payload.startsAt > payload.createdAt + MAX_LIST_DAYS * 86_400_000) {
        refusal = { event: null, replayed: false, deleted: false, tooFarAhead: true, maxDays: MAX_LIST_DAYS };
        return false;
      }
      pruneStaleEvents(events, payload.createdAt);
      const owned = Object.values(events).filter((event) => !isDeletedEvent(event) &&
        resolveCalendarEventOwner(event) === payload.userId);
      const upcoming = owned.filter((event) => event.startsAt >= payload.createdAt);
      if (upcoming.length >= MAX_EVENTS_PER_USER) {
        refusal = { event: null, replayed: false, deleted: false, limitReached: true, limit: MAX_EVENTS_PER_USER };
        return false;
      }
      const ended = owned.filter((event) => event.startsAt < payload.createdAt)
        .sort((a, b) => a.startsAt - b.startsAt);
      for (const event of ended.slice(0, Math.max(0, owned.length + 1 - MAX_EVENTS_PER_USER))) {
        delete events[event.id];
      }
      events[id] = normalizeEvent(candidate, id);
      return { event: events[id], replayed: false, deleted: false };
    });
    return added || refusal;
  }

  function saveCalendarEvent(event) {
    return mutateEvents((events) => {
      const next = normalizeEvent(event, event.id);
      const existing = events[event.id];
      if (existing && isDeletedEvent(existing)) {
        throw new Error('Deleted calendar events cannot be overwritten.');
      }
      if (existing && !isDeepStrictEqual(existing, next)) {
        throw new Error('Calendar event id conflicts with another event.');
      }
      events[event.id] = next;
      return events[event.id];
    });
  }

  function listUpcomingEvents() {
    // The retained v1 schema has no independent evidence that a shared event was
    // authorized for public display. Keep the compatibility API fail-closed.
    return [];
  }

  function listPersonalEvents({ userId, days = 30, now = Date.now() }) {
    const maxTime = now + days * 86_400_000;
    const owner = String(userId || '');
    return Object.values(readCalendarEvents())
      .filter((event) => !isDeletedEvent(event) && resolveCalendarEventOwner(event) === owner &&
        event.startsAt >= now && event.startsAt <= maxTime)
      .sort((a, b) => a.startsAt - b.startsAt);
  }

  function deletedMarker(event, ownerId, deletedAt) {
    const deletionTime = Number(deletedAt);
    if (!Number.isFinite(deletionTime)) throw new Error('Invalid calendar deletion time.');
    const digest = event.requestDigest || requestDigest({
      userId: ownerId || String(event.createdBy || ''),
      sourceGuildId: String(event.sourceGuildId || event.guildId || ''),
      title: event.title,
      description: event.description || '',
      startsAt: event.startsAt,
      createdAt: Number(event.createdAt || 0),
    });
    const common = {
      id: event.id, schemaVersion: 1, title: DELETED_TITLE, description: '', startsAt: 0,
      createdAt: Number(event.createdAt || deletionTime), lifecycle: DELETED_LIFECYCLE,
      deletedAt: deletionTime, requestDigest: digest,
    };
    if (ownerId) {
      return normalizeEvent({
        ...common, scope: 'personal', userId: String(ownerId), createdBy: String(ownerId),
        sourceGuildId: null,
      }, event.id);
    }
    return normalizeEvent({
      ...common, scope: 'shared', guildId: String(event.guildId),
      sourceGuildId: String(event.sourceGuildId || event.guildId),
      createdBy: event.createdBy ? String(event.createdBy) : null,
    }, event.id);
  }

  function deleteCalendarEvent({ guildId, eventId, deletedAt = Date.now() }) {
    return mutateEvents((events) => {
      const event = events[eventId];
      if (!event || event.scope !== 'shared' || event.guildId !== guildId) return false;
      if (isDeletedEvent(event)) return event;
      events[eventId] = deletedMarker(event, resolveCalendarEventOwner(event), deletedAt);
      pruneStaleEvents(events, Number(deletedAt));
      return event;
    }) || null;
  }

  function deletePersonalEvent({ userId, eventId, deletedAt = Date.now() }) {
    return mutateEvents((events) => {
      const event = events[eventId];
      const owner = resolveCalendarEventOwner(event);
      if (!event || owner !== String(userId || '')) return false;
      if (isDeletedEvent(event)) return event;
      events[eventId] = deletedMarker(event, owner, deletedAt);
      pruneStaleEvents(events, Number(deletedAt));
      return event;
    }) || null;
  }

  // days is the range the list was read for. When it is given, the reply says that range, so an event
  // further ahead is not mistaken for a lost one, and an empty list points at the days option.
  function formatCalendarEventList(events, { days = null } = {}) {
    const visibleEvents = events.filter((event) => !isDeletedEvent(event));
    const range = Number.isSafeInteger(days) && days > 0 ? days : null;
    if (visibleEvents.length === 0) {
      if (!range) return '目前沒有行事曆事件。';
      return range < MAX_LIST_DAYS
        ? '未來 ' + range + ' 天內沒有行事曆事件。可用 days 選項查更遠的日期（最多 ' + MAX_LIST_DAYS + ' 天）。'
        : '未來 ' + range + ' 天內沒有行事曆事件。';
    }
    const quote = String.fromCharCode(96);
    const lineOf = (event, descriptionLimit = Infinity) => {
      let description = event.description || '';
      if (description.length > descriptionLimit) description = description.slice(0, descriptionLimit - 1) + '…';
      return quote + event.id + quote + ' - <t:' + Math.floor(event.startsAt / 1000) +
        ':F> - **' + event.title + '**' + (description ? ' - ' + description : '');
    };
    const header = range ? ['**未來 ' + range + ' 天內的行事曆事件**'] : [];
    const listed = visibleEvents.slice(0, MAX_LISTED_EVENTS);
    const omittedNote = (count) => '另有 ' + count + ' 筆事件未顯示，可縮短 days 範圍分次查看。';
    const full = [...header, ...listed.map((event) => lineOf(event))];
    if (listed.length === visibleEvents.length && full.join('\n').length <= MAX_LIST_CHARACTERS) {
      return full.join('\n');
    }
    // Too long for one message, or more events than are listed: long descriptions are shortened, and
    // events that still do not fit are left out with a note saying how many, so the reply always fits.
    const kept = [...header];
    let length = kept.join('\n').length;
    for (const line of listed.map((event) => lineOf(event, SHORT_DESCRIPTION_CHARACTERS))) {
      const room = MAX_LIST_CHARACTERS - omittedNote(visibleEvents.length).length - 1;
      if (length + (kept.length ? 1 : 0) + line.length > room) break;
      length += (kept.length ? 1 : 0) + line.length;
      kept.push(line);
    }
    const omitted = visibleEvents.length - (kept.length - header.length);
    return [...kept, ...(omitted > 0 ? [omittedNote(omitted)] : [])].join('\n');
  }

  return {
    MAX_LIST_DAYS,
    addPersonalCalendarEvent, createCalendarEvent, createPersonalCalendarEvent,
    deleteCalendarEvent, deletePersonalEvent,
    formatCalendarEventList, initializeCalendarStore, listPersonalEvents, listUpcomingEvents,
    migrateLegacyCalendarStore,
    parseCalendarDate, parseTaipeiCalendarDate, readCalendarEvents,
    resolveCalendarEventOwner, saveCalendarEvent, writeCalendarEvents,
  };
}

module.exports = { createCalendarSystem };
