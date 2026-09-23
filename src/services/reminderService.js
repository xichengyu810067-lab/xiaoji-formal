const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

const remindersPath = path.join(__dirname, '..', 'data', 'reminders.json');
const reminderTimers = new Map();
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;

function ensureReminderFile() {
  const directory = path.dirname(remindersPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(remindersPath)) {
    fs.writeFileSync(remindersPath, '{}\n', 'utf8');
  }
}

function readReminders() {
  ensureReminderFile();

  try {
    const raw = fs.readFileSync(remindersPath, 'utf8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeReminders(reminders) {
  ensureReminderFile();
  fs.writeFileSync(remindersPath, `${JSON.stringify(reminders, null, 2)}\n`, 'utf8');
}

function parseReminderDuration(input) {
  const match = String(input || '')
    .trim()
    .match(/^(\d+)([smhd])$/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const ms = amount * multipliers[unit];

  if (ms > MAX_REMINDER_MS) {
    return null;
  }

  return {
    input: `${amount}${unit}`,
    ms,
  };
}

function createReminderId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createReminder({ guildId, channelId, userId, message, durationMs, now = Date.now() }) {
  const content = String(message || '').trim();

  if (!content) {
    throw new Error('Reminder message is required.');
  }

  return {
    id: createReminderId(),
    guildId,
    channelId,
    userId,
    message: content.slice(0, 1000),
    createdAt: now,
    remindAt: now + durationMs,
  };
}

function saveReminder(reminder) {
  const reminders = readReminders();
  reminders[reminder.id] = reminder;
  writeReminders(reminders);
}

function removeReminder(reminderId) {
  const reminders = readReminders();
  const removed = reminders[reminderId] || null;
  delete reminders[reminderId];
  writeReminders(reminders);

  const timer = reminderTimers.get(reminderId);
  if (timer) {
    clearTimeout(timer);
    reminderTimers.delete(reminderId);
  }
  return removed;
}

function listUserReminders({ guildId, userId, now = Date.now() }) {
  return Object.values(readReminders())
    .filter((reminder) => reminder.guildId === guildId && reminder.userId === userId && reminder.remindAt >= now)
    .sort((a, b) => a.remindAt - b.remindAt);
}

function deleteUserReminder({ guildId, userId, reminderId }) {
  const reminder = readReminders()[reminderId];

  if (!reminder || reminder.guildId !== guildId || reminder.userId !== userId) {
    return null;
  }

  return removeReminder(reminderId);
}

async function sendReminder(client, reminder) {
  try {
    const channel = await client.channels.fetch(reminder.channelId);

    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
      throw new Error(`Reminder channel is not text based: ${reminder.channelId}`);
    }

    await channel.send({
      content: `<@${reminder.userId}> 提醒時間到了：${reminder.message}`,
      allowedMentions: { users: [reminder.userId], roles: [] },
    });
    removeReminder(reminder.id);
  } catch (error) {
    logger.warn(`Failed to send reminder ${reminder.id}: ${error?.message || error}`);
  }
}

function scheduleReminder(client, reminder, now = Date.now()) {
  const existingTimer = reminderTimers.get(reminder.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const delay = Math.max(0, reminder.remindAt - now);
  const timer = setTimeout(() => {
    if (delay > MAX_TIMEOUT_MS) {
      scheduleReminder(client, reminder);
      return;
    }

    void sendReminder(client, reminder);
  }, Math.min(delay, MAX_TIMEOUT_MS));

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  reminderTimers.set(reminder.id, timer);
}

function addReminder(client, reminder) {
  saveReminder(reminder);
  scheduleReminder(client, reminder);
}

async function restoreActiveReminders(client) {
  const reminders = readReminders();

  for (const reminder of Object.values(reminders)) {
    scheduleReminder(client, reminder);
  }
}

module.exports = {
  MAX_REMINDER_MS,
  addReminder,
  createReminder,
  deleteUserReminder,
  listUserReminders,
  parseReminderDuration,
  readReminders,
  removeReminder,
  restoreActiveReminders,
  scheduleReminder,
  writeReminders,
};
