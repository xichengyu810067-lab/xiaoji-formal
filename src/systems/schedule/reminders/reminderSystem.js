const { validateDelivery } = require('../delivery/reminderDelivery');
const { runWithBackgroundContext } = require('../../../platform/hostOperationContext');
const { isEgressRefusal } = require('../../../platform/egressGuard');
const { isEgressRateLimitError } = require('../../../platform/egressLimiter');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_REMINDERS_PER_USER = 20;
const MAX_TIMEOUT_MS = 2_147_483_647;
const RETRY_DELAYS = [60_000, 300_000];
// Delivered and failed reminders are kept this long, and one user keeps at most this many of them.
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FINISHED_REMINDERS_PER_USER = 50;

function parseReminderDuration(input) {
  const match = String(input || '').trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  const unit = match[2].toLowerCase();
  const ms = amount * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Number.isSafeInteger(ms) && ms <= MAX_REMINDER_MS ? { input: String(amount) + unit, ms } : null;
}

function normalizeReminder(record, id) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid reminder record: ' + id);
  const sourceGuildId = record.sourceGuildId || record.guildId;
  const deliveryGuildId = record.deliveryGuildId || record.guildId;
  const deliveryChannelId = record.deliveryChannelId || record.channelId;
  if (!record.userId || !sourceGuildId || !deliveryGuildId || !deliveryChannelId ||
      typeof record.message !== 'string' || !Number.isFinite(Number(record.remindAt))) {
    throw new Error('Invalid reminder record: ' + id);
  }
  const status = record.status || 'pending';
  if (!['pending', 'sending', 'delivered', 'failed'].includes(status)) throw new Error('Invalid reminder status: ' + id);
  return {
    ...record, id, sourceGuildId: String(sourceGuildId), deliveryGuildId: String(deliveryGuildId),
    deliveryChannelId: String(deliveryChannelId), userId: String(record.userId),
    remindAt: Number(record.remindAt), status, attemptCount: Number(record.attemptCount || 0),
  };
}

// Drops, in place, the delivered and failed reminders older than the retention time, then all but the
// newest ones of each user. A reminder finished before its time was recorded is timed from now, so
// it is never dropped on a guess.
function pruneFinishedReminders(records, now) {
  const cutoff = now - FINISHED_RETENTION_MS;
  const byUser = new Map();
  for (const [id, record] of Object.entries(records)) {
    if (record.status !== 'delivered' && record.status !== 'failed') continue;
    const field = record.status === 'delivered' ? 'deliveredAt' : 'failedAt';
    if (!Number.isFinite(record[field])) record[field] = now;
    if (record[field] < cutoff) {
      delete records[id];
      continue;
    }
    if (!byUser.has(record.userId)) byUser.set(record.userId, []);
    byUser.get(record.userId).push({ id, at: record[field] });
  }
  for (const finished of byUser.values()) {
    finished.sort((a, b) => b.at - a.at);
    for (const { id } of finished.slice(MAX_FINISHED_REMINDERS_PER_USER)) delete records[id];
  }
}

function createReminderSystem({ filePath, logger = { warn() {} }, timers = new Map() }) {
  if (!path.isAbsolute(filePath)) throw new Error('Reminder path must be absolute.');
  const lockPath = filePath + '.lock';
  const backupPath = filePath + '.legacy-v1.bak';
  const receiptPath = filePath + '.migration-v1.receipt.json';

  function readSource() {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) throw new Error('Reminder data is empty.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Reminder data must be an object.');
    return { raw, parsed };
  }

  function readReminders() {
    const { parsed } = readSource();
    return Object.fromEntries(Object.entries(parsed).map(([id, record]) => [id, normalizeReminder(record, id)]));
  }

  function atomicWriteAt(targetPath, records) {
    const tempPath = targetPath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    let handle;
    try {
      handle = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify(records, null, 2) + '\n', 'utf8');
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(tempPath, targetPath);
    } finally {
      if (handle !== undefined && handle !== null) fs.closeSync(handle);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
  const atomicWrite = (records) => atomicWriteAt(filePath, records);

  function hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  function isLegacy(parsed) {
    return Object.values(parsed).some((item) => !item || item.schemaVersion !== 1);
  }

  function migrateLegacyReminderStore() {
    return withWriteLock(() => {
      const { raw, parsed } = readSource();
      const records = Object.fromEntries(Object.entries(parsed).map(([id, item]) => [
        id, { ...normalizeReminder(item, id), schemaVersion: 1 },
      ]));
      const expected = JSON.stringify(records, null, 2) + '\n';
      if (fs.existsSync(receiptPath)) {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        if (!fs.existsSync(backupPath) || hash(fs.readFileSync(backupPath)) !== receipt.sourceHash) {
          throw new Error('Reminder migration receipt or backup mismatch.');
        }
        return receipt;
      }
      if (!isLegacy(parsed) && !fs.existsSync(backupPath)) return null;
      if (fs.existsSync(backupPath)) {
        const original = fs.readFileSync(backupPath, 'utf8');
        const originalParsed = JSON.parse(original);
        const normalized = Object.fromEntries(Object.entries(originalParsed).map(([id, item]) => [
          id, { ...normalizeReminder(item, id), schemaVersion: 1 },
        ]));
        const normalizedText = JSON.stringify(normalized, null, 2) + '\n';
        if (raw === original) atomicWrite(normalized);
        else if (raw !== normalizedText) {
          throw new Error('Reminder migration source changed without a receipt.');
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
      if (hash(fs.readFileSync(backupPath)) !== hash(raw)) throw new Error('Reminder migration backup mismatch.');
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

  function initializeReminderStore() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return withWriteLock(() => {
      if (fs.existsSync(filePath)) return false;
      if (fs.existsSync(backupPath) || fs.existsSync(receiptPath)) {
        throw new Error('Reminder migration evidence exists; missing source cannot be initialized.');
      }
      atomicWrite({});
      return true;
    });
  }

  function mutateRecords(change) {
    return withWriteLock(() => {
      const { parsed } = readSource();
      if (isLegacy(parsed) || (fs.existsSync(backupPath) && !fs.existsSync(receiptPath))) {
        throw new Error('Reminder data requires a verified legacy migration.');
      }
      const records = readReminders();
      const result = change(records);
      if (result !== false) atomicWrite(records);
      return result;
    });
  }

  function writeReminders(records) {
    return mutateRecords((current) => {
      for (const key of Object.keys(current)) delete current[key];
      for (const [id, record] of Object.entries(records)) current[id] = normalizeReminder(record, id);
    });
  }

  function createReminder({ guildId, channelId, userId, message, durationMs, now = Date.now() }) {
    const content = String(message || '').trim();
    if (!content) throw new Error('Reminder message is required.');
    if (!guildId || !channelId || !userId || !Number.isSafeInteger(durationMs) ||
        durationMs < 1 || durationMs > MAX_REMINDER_MS) throw new Error('Invalid reminder destination or duration.');
    return {
      id: crypto.randomUUID(), schemaVersion: 1, guildId: String(guildId), channelId: String(channelId),
      sourceGuildId: String(guildId), deliveryGuildId: String(guildId),
      deliveryChannelId: String(channelId), userId: String(userId),
      message: content.slice(0, 1000), createdAt: now, remindAt: now + durationMs,
      status: 'pending', attemptCount: 0,
    };
  }

  function clearTimer(id) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }

  function saveReminder(reminder) {
    return mutateRecords((records) => {
      const normalized = normalizeReminder(reminder, reminder.id);
      const existing = records[normalized.id];
      if (!existing && normalized.status === 'pending') {
        const active = Object.values(records).filter((record) => record.userId === normalized.userId &&
          (record.status === 'pending' || record.status === 'sending')).length;
        if (active >= MAX_ACTIVE_REMINDERS_PER_USER) {
          throw Object.assign(new Error('每位使用者最多只能有 20 則進行中的提醒。'), { code: 'REMINDER_ACTIVE_LIMIT' });
        }
      }
      records[normalized.id] = normalized;
      pruneFinishedReminders(records, Date.now());
      return normalized;
    });
  }

  function removeReminder(reminderId) {
    const removed = mutateRecords((records) => {
      const item = records[reminderId] || null;
      if (!item) return false;
      delete records[reminderId];
      return item;
    });
    if (removed) clearTimer(reminderId);
    return removed || null;
  }

  function listUserReminders({ userId }) {
    return Object.values(readReminders())
      .filter((record) => record.userId === userId && record.status !== 'delivered')
      .sort((a, b) => a.remindAt - b.remindAt);
  }

  function deleteUserReminder({ userId, reminderId }) {
    const removed = mutateRecords((records) => {
      const item = records[reminderId];
      if (!item || item.userId !== userId) return false;
      delete records[reminderId];
      return item;
    });
    if (removed) clearTimer(reminderId);
    return removed || null;
  }

  function updateReminder(id, update) {
    return mutateRecords((records) => {
      const current = records[id];
      const next = current ? update(current) : null;
      if (!next) return false;
      records[id] = normalizeReminder(next, id);
      const result = records[id];
      pruneFinishedReminders(records, Date.now());
      return result;
    }) || null;
  }

  function scheduleReminder(client, reminder, now = Date.now()) {
    clearTimer(reminder.id);
    if (reminder.status !== 'pending') return;
    const dueAt = reminder.nextAttemptAt || reminder.remindAt;
    const delay = Math.max(0, dueAt - now);
    // Every firing runs as the background job `reminder.deliver`, never in the context of
    // the command or restore that scheduled it.
    const timer = setTimeout(() => runWithBackgroundContext('reminder.deliver', () => {
      timers.delete(reminder.id);
      if (delay > MAX_TIMEOUT_MS) scheduleReminder(client, reminder);
      else void sendReminder(client, reminder.id).catch((error) => logger.warn('Reminder ' + reminder.id + ': ' + error));
    }), Math.min(delay, MAX_TIMEOUT_MS));
    timer.unref?.();
    timers.set(reminder.id, timer);
  }

  async function sendReminder(client, reminderId) {
    const reminder = readReminders()[reminderId];
    if (!reminder || reminder.status !== 'pending') return null;
    let channel;
    try {
      channel = await validateDelivery(client, reminder);
    } catch (error) {
      const failed = updateReminder(reminderId, (current) => {
        if (current.status !== 'pending') return null;
        const attemptCount = current.attemptCount + 1;
        return {
          ...current, attemptCount, status: attemptCount >= 3 ? 'failed' : 'pending',
          nextAttemptAt: attemptCount >= 3 ? null : Date.now() + RETRY_DELAYS[attemptCount - 1],
          failureReason: String(error?.message || error).slice(0, 200),
        };
      });
      if (failed?.status === 'pending') scheduleReminder(client, failed);
      if (!String(error?.code || '').startsWith('TEST_')) logger.warn('Reminder ' + reminderId + ' preflight failed: ' + error);
      return failed;
    }
    // Reserve before changing the durable reminder to `sending`.  If the egress window is
    // full, keep it pending and let the normal scheduler try again; it must never become a
    // failed reminder merely because output is being throttled.
    const payload = {
      content: '<@' + reminder.userId + '> 提醒時間到了：' + reminder.message,
      allowedMentions: { users: [reminder.userId], roles: [] },
    };
    const limiter = client?.egressLimiter;
    let reservation = null;
    if (limiter) {
      const reserved = limiter.reserve({ method: 'POST', fullRoute: `/channels/${reminder.deliveryChannelId}/messages`, body: payload });
      if (!reserved.allowed) {
        const deferred = updateReminder(reminderId, (current) => current.status === 'pending'
          ? { ...current, nextAttemptAt: Date.now() + reserved.retryAfterMs } : null);
        if (deferred?.status === 'pending') scheduleReminder(client, deferred);
        return deferred;
      }
      reservation = reserved.reservation;
    }
    // From here on the reservation is released on every path, including a failed write below.
    try {
      // Mark the uncertain boundary before Discord I/O so restart cannot resend it.
      const sending = updateReminder(reminderId, (current) => current.status === 'pending'
        ? { ...current, status: 'sending', attemptCount: current.attemptCount + 1, nextAttemptAt: null }
        : null);
      if (!sending) return null;
      try {
        const send = () => channel.send(payload);
        if (reservation) await limiter.runWithReservation(reservation, send);
        else await send();
        return updateReminder(reminderId, (current) => current.status === 'sending'
          ? { ...current, status: 'delivered', deliveredAt: Date.now() } : null);
      } catch (error) {
        if (isEgressRateLimitError(error) || isEgressRefusal(error)) {
          // Stopped inside this process, before any request left it: known not to be sent.
          if (!String(error?.code || '').startsWith('TEST_')) logger.warn('Reminder ' + reminderId + ' was not sent: ' + error);
          return returnUnsentReminder(client, reminderId, error);
        }
        if (!String(error?.code || '').startsWith('TEST_')) logger.warn('Reminder ' + reminderId + ' send outcome unknown: ' + error);
        return updateReminder(reminderId, (current) => current.status === 'sending'
          ? { ...current, status: 'failed', failureReason: '投遞結果未確認，請人工核對。' } : null);
      }
    } finally {
      limiter?.cancel(reservation);
    }
  }

  // A reminder marked `sending` whose request was stopped before it left the process goes back
  // to `pending`. A rate limit is only a delay, so it never counts as an attempt; a refusal
  // counts like any failed attempt, so a request that is always refused ends as failed.
  function returnUnsentReminder(client, reminderId, error) {
    const returned = updateReminder(reminderId, (current) => {
      if (current.status !== 'sending') return null;
      if (isEgressRateLimitError(error)) {
        const advised = Number(error.retryAfterMs);
        return {
          ...current, status: 'pending', attemptCount: Math.max(0, current.attemptCount - 1),
          nextAttemptAt: Date.now() + (advised > 0 ? advised : RETRY_DELAYS[0]),
        };
      }
      const exhausted = current.attemptCount >= 3;
      return {
        ...current, status: exhausted ? 'failed' : 'pending',
        nextAttemptAt: exhausted ? null : Date.now() + RETRY_DELAYS[current.attemptCount - 1],
        failureReason: '提醒被輸出政策拒絕，未送出。',
      };
    });
    if (returned?.status === 'pending') scheduleReminder(client, returned);
    return returned;
  }

  function addReminder(client, reminder) {
    const saved = saveReminder(reminder);
    scheduleReminder(client, saved);
    return saved;
  }

  async function restoreActiveReminders(client) {
    for (const reminder of Object.values(readReminders())) {
      if (reminder.status === 'sending') {
        updateReminder(reminder.id, (current) => ({
          ...current, status: 'failed', failureReason: '重啟前投遞結果未確認，請人工核對。',
        }));
      } else if (reminder.status === 'pending') {
        scheduleReminder(client, reminder);
      }
    }
  }

  return {
    MAX_ACTIVE_REMINDERS_PER_USER, MAX_REMINDER_MS, addReminder, createReminder, deleteUserReminder, initializeReminderStore,
    listUserReminders, migrateLegacyReminderStore, parseReminderDuration, readReminders, removeReminder,
    restoreActiveReminders, scheduleReminder, sendReminder, writeReminders,
  };
}

module.exports = { createReminderSystem };
