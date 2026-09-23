const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_REMINDER_MS,
  createReminder,
  parseReminderDuration,
} = require('../src/services/reminderService');

test('parseReminderDuration supports relative reminder formats', () => {
  assert.equal(parseReminderDuration('10m').ms, 10 * 60 * 1000);
  assert.equal(parseReminderDuration('1h').ms, 60 * 60 * 1000);
  assert.equal(parseReminderDuration('1d').ms, 24 * 60 * 60 * 1000);
});

test('parseReminderDuration rejects invalid and too long values', () => {
  assert.equal(parseReminderDuration('abc'), null);
  assert.equal(parseReminderDuration('0m'), null);
  assert.equal(parseReminderDuration('31d'), null);
  assert.ok(MAX_REMINDER_MS >= parseReminderDuration('30d').ms);
});

test('createReminder builds a persisted reminder record', () => {
  const reminder = createReminder({
    guildId: 'guild',
    channelId: 'channel',
    userId: 'user',
    message: 'hello',
    durationMs: 60000,
    now: 1000,
  });

  assert.equal(reminder.guildId, 'guild');
  assert.equal(reminder.channelId, 'channel');
  assert.equal(reminder.userId, 'user');
  assert.equal(reminder.message, 'hello');
  assert.equal(reminder.createdAt, 1000);
  assert.equal(reminder.remindAt, 61000);
  assert.ok(reminder.id);
});
