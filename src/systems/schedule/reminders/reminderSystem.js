const { validateDelivery } = require('../delivery/reminderDelivery');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const RETRY_DELAYS = [60_000, 300_000];

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
    mutateRecords((records) => { records[reminder.id] = normalizeReminder(reminder, reminder.id); });
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
      return records[id];
    }) || null;
  }

  function scheduleReminder(client, reminder, now = Date.now()) {
    clearTimer(reminder.id);
    if (reminder.status !== 'pending') return;
    const dueAt = reminder.nextAttemptAt || reminder.remindAt;
    const delay = Math.max(0, dueAt - now);
    const timer = setTimeout(() => {
      timers.delete(reminder.id);
      if (delay > MAX_TIMEOUT_MS) scheduleReminder(client, reminder);
      else void sendReminder(client, reminder.id).catch((error) => logger.warn('Reminder ' + reminder.id + ': ' + error));
    }, Math.min(delay, MAX_TIMEOUT_MS));
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
      logger.warn('Reminder ' + reminderId + ' preflight failed: ' + error);
      return failed;
    }
    // Mark the uncertain boundary before Discord I/O so restart cannot resend it.
    const sending = updateReminder(reminderId, (current) => current.status === 'pending'
      ? { ...current, status: 'sending', attemptCount: current.attemptCount + 1, nextAttemptAt: null }
      : null);
    if (!sending) return null;
    try {
      await channel.send({
        content: '<@' + sending.userId + '> 提醒時間到了：' + sending.message,
        allowedMentions: { users: [sending.userId], roles: [] },
      });
      return updateReminder(reminderId, (current) => current.status === 'sending'
        ? { ...current, status: 'delivered', deliveredAt: Date.now() } : null);
    } catch (error) {
      logger.warn('Reminder ' + reminderId + ' send outcome unknown: ' + error);
      return updateReminder(reminderId, (current) => current.status === 'sending'
        ? { ...current, status: 'failed', failureReason: '投遞結果未確認，請人工核對。' } : null);
    }
  }

  function addReminder(client, reminder) {
    saveReminder(reminder);
    scheduleReminder(client, reminder);
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
    MAX_REMINDER_MS, addReminder, createReminder, deleteUserReminder, initializeReminderStore,
    listUserReminders, migrateLegacyReminderStore, parseReminderDuration, readReminders, removeReminder,
    restoreActiveReminders, scheduleReminder, sendReminder, writeReminders,
  };
}

module.exports = { createReminderSystem };
