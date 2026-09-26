const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  return {
    ...event, id, scope, userId: userId ? String(userId) : null,
    sourceGuildId: event.sourceGuildId || event.guildId || null,
    startsAt: Number(event.startsAt),
  };
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

  function createPersonalCalendarEvent({ userId, sourceGuildId, title, description = '', startsAt, now = Date.now() }) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle || !userId || !Number.isFinite(Number(startsAt))) {
      throw new Error('Invalid personal calendar event.');
    }
    return {
      id: crypto.randomUUID(), schemaVersion: 1, scope: 'personal', userId: String(userId),
      sourceGuildId: sourceGuildId || null, createdBy: String(userId),
      title: normalizedTitle.slice(0, 100), description: String(description || '').trim().slice(0, 1000),
      startsAt: Number(startsAt), createdAt: now,
    };
  }

  function saveCalendarEvent(event) {
    mutateEvents((events) => { events[event.id] = normalizeEvent(event, event.id); });
  }

  function listUpcomingEvents({ guildId, days = 30, now = Date.now() }) {
    const maxTime = now + days * 86_400_000;
    return Object.values(readCalendarEvents())
      .filter((event) => event.scope === 'shared' && event.guildId === guildId &&
        event.startsAt >= now && event.startsAt <= maxTime)
      .sort((a, b) => a.startsAt - b.startsAt);
  }

  function listPersonalEvents({ userId, days = 30, now = Date.now() }) {
    const maxTime = now + days * 86_400_000;
    return Object.values(readCalendarEvents())
      .filter((event) => event.scope === 'personal' && event.userId === userId &&
        event.startsAt >= now && event.startsAt <= maxTime)
      .sort((a, b) => a.startsAt - b.startsAt);
  }

  function deleteCalendarEvent({ guildId, eventId }) {
    return mutateEvents((events) => {
      const event = events[eventId];
      if (!event || event.scope !== 'shared' || event.guildId !== guildId) return false;
      delete events[eventId];
      return event;
    }) || null;
  }

  function deletePersonalEvent({ userId, eventId }) {
    return mutateEvents((events) => {
      const event = events[eventId];
      if (!event || event.scope !== 'personal' || event.userId !== userId) return false;
      delete events[eventId];
      return event;
    }) || null;
  }

  function formatCalendarEventList(events) {
    if (events.length === 0) return '沒有找到 upcoming 行事曆事件。';
    const quote = String.fromCharCode(96);
    return events.slice(0, 10).map((event) => {
      const description = event.description ? ' - ' + event.description : '';
      return quote + event.id + quote + ' - <t:' + Math.floor(event.startsAt / 1000) +
        ':F> - **' + event.title + '**' + description;
    }).join('\n');
  }

  return {
    createCalendarEvent, createPersonalCalendarEvent, deleteCalendarEvent, deletePersonalEvent,
    formatCalendarEventList, initializeCalendarStore, listPersonalEvents, listUpcomingEvents,
    migrateLegacyCalendarStore,
    parseCalendarDate, parseTaipeiCalendarDate, readCalendarEvents,
    saveCalendarEvent, writeCalendarEvents,
  };
}

module.exports = { createCalendarSystem };
