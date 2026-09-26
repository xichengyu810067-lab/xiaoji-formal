const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createReminderSystem } = require('../src/systems/reminders/reminderSystem');
const { createCalendarSystem } = require('../src/systems/community/calendarSystem');

test('personal calendar interprets Taipei time identically under different host timezones', () => {
  const modulePath = require.resolve('../src/systems/community/calendarSystem');
  const script = 'const { createCalendarSystem } = require(' + JSON.stringify(modulePath) + '); ' +
    'const system = createCalendarSystem({ filePath: require("node:path").resolve("calendar-test.json") }); ' +
    'process.stdout.write(system.parseTaipeiCalendarDate("2026-05-10 20:30").toISOString());';
  const instants = ['UTC', 'Asia/Taipei'].map((zone) => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: zone }, encoding: 'utf8', cwd: os.tmpdir(),
  }));
  assert.deepEqual(instants, ['2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z']);
  const system = createCalendarSystem({ filePath: path.join(os.tmpdir(), 'calendar-test.json') });
  assert.equal(system.parseTaipeiCalendarDate('2026-02-30 20:30'), null);
  assert.equal(system.parseTaipeiCalendarDate('2026-05-10 24:00'), null);
});

function fixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-personal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function fakeClient({ allow = true, send = async () => {} } = {}) {
  const channel = {
    guildId: 'guild-a',
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => allow }),
    send,
  };
  const member = { id: 'user-a' };
  const guild = { members: { me: { id: 'bot' }, fetch: async () => member } };
  return {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => channel },
    user: { id: 'bot' },
  };
}

test('reminders are owned by one user across source guilds and retain delivery source', (t) => {
  const filePath = fixture(t, 'reminders.json');
  const system = createReminderSystem({ filePath });
  assert.equal(system.initializeReminderStore(), true);
  const a = system.createReminder({
    guildId: 'guild-a', channelId: 'channel-a', userId: 'user-a',
    message: 'A', durationMs: 60_000, now: 1000,
  });
  const b = system.createReminder({
    guildId: 'guild-b', channelId: 'channel-b', userId: 'user-a',
    message: 'B', durationMs: 60_000, now: 1000,
  });
  const other = system.createReminder({
    guildId: 'guild-b', channelId: 'channel-b', userId: 'user-b',
    message: 'secret', durationMs: 60_000, now: 1000,
  });
  system.writeReminders({ [a.id]: a, [b.id]: b, [other.id]: other });
  assert.deepEqual(system.listUserReminders({ guildId: 'guild-a', userId: 'user-a' }).map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.equal(system.deleteUserReminder({ guildId: 'guild-b', userId: 'user-b', reminderId: a.id }), null);
  assert.equal(system.deleteUserReminder({ guildId: 'guild-b', userId: 'user-a', reminderId: a.id }).id, a.id);
  assert.equal(system.readReminders()[b.id].deliveryChannelId, 'channel-b');
});

test('missing or damaged reminder authority is not overwritten', (t) => {
  const filePath = fixture(t, 'reminders.json');
  const system = createReminderSystem({ filePath });
  assert.throws(() => system.readReminders(), /ENOENT/);
  assert.throws(() => system.writeReminders({}), /ENOENT/);
  assert.equal(system.initializeReminderStore(), true);
  fs.writeFileSync(filePath, 'broken');
  assert.throws(() => system.writeReminders({}), SyntaxError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'broken');
});

test('legacy reminders migrate atomically with retained source and repeatable receipt', (t) => {
  const filePath = fixture(t, 'reminders.json');
  const system = createReminderSystem({ filePath });
  const legacy = { one: {
    id: 'one', guildId: 'guild-a', channelId: 'channel-a',
    userId: 'user-a', message: 'legacy', remindAt: 100_000, createdAt: 1000,
  } };
  const source = JSON.stringify(legacy);
  fs.writeFileSync(filePath, source);
  assert.equal(system.listUserReminders({ userId: 'user-a' }).length, 1);
  assert.throws(() => system.deleteUserReminder({ userId: 'user-a', reminderId: 'one' }), /migration/);
  const receipt = system.migrateLegacyReminderStore();
  assert.equal(receipt.recordCount, 1);
  assert.equal(fs.readFileSync(filePath + '.legacy-v1.bak', 'utf8'), source);
  assert.equal(system.readReminders().one.sourceGuildId, 'guild-a');
  assert.deepEqual(system.migrateLegacyReminderStore(), receipt);
  assert.equal(system.deleteUserReminder({ userId: 'user-a', reminderId: 'one' }).id, 'one');
});

test('interrupted reminder migration recovers only when source matches its backup', (t) => {
  const filePath = fixture(t, 'reminders.json');
  const system = createReminderSystem({ filePath });
  const source = JSON.stringify({ one: {
    guildId: 'guild-a', channelId: 'channel-a', userId: 'user-a',
    message: 'legacy', remindAt: 100_000,
  } });
  fs.writeFileSync(filePath, source);
  fs.copyFileSync(filePath, filePath + '.legacy-v1.bak');
  assert.equal(system.migrateLegacyReminderStore().recordCount, 1);
  fs.unlinkSync(filePath + '.migration-v1.receipt.json');
  assert.equal(system.migrateLegacyReminderStore().recordCount, 1);
  assert.equal(fs.readFileSync(filePath + '.legacy-v1.bak', 'utf8'), source);
});

test('reminder restart schedules once and uncertain delivery never resends', async (t) => {
  const filePath = fixture(t, 'reminders.json');
  const system = createReminderSystem({ filePath });
  system.initializeReminderStore();
  const reminder = system.createReminder({
    guildId: 'guild-a', channelId: 'channel-a', userId: 'user-a',
    message: 'A', durationMs: 60_000,
  });
  system.writeReminders({ [reminder.id]: reminder });
  let sends = 0;
  const client = fakeClient({ send: async () => { sends++; } });
  await system.restoreActiveReminders(client);
  await system.restoreActiveReminders(client);
  const delivered = await system.sendReminder(client, reminder.id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(sends, 1);
  await system.restoreActiveReminders(client);
  await system.sendReminder(client, reminder.id);
  assert.equal(sends, 1);
});

test('reminder permissions fail with finite retries and visible failed state', async (t) => {
  const filePath = fixture(t, 'reminders.json');
  const system = createReminderSystem({ filePath });
  system.initializeReminderStore();
  const reminder = system.createReminder({
    guildId: 'guild-a', channelId: 'channel-a', userId: 'user-a',
    message: 'A', durationMs: 60_000,
  });
  system.writeReminders({ [reminder.id]: reminder });
  const client = fakeClient({ allow: false });
  await system.sendReminder(client, reminder.id);
  await system.sendReminder(client, reminder.id);
  const failed = await system.sendReminder(client, reminder.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attemptCount, 3);
  assert.equal(system.listUserReminders({ userId: 'user-a' })[0].status, 'failed');
});

test('shared calendar remains guild isolated while personal events follow owner', (t) => {
  const filePath = fixture(t, 'calendar.json');
  const system = createCalendarSystem({ filePath });
  system.initializeCalendarStore();
  const now = Date.now();
  const shared = system.createCalendarEvent({
    guildId: 'guild-a', channelId: 'channel-a', createdBy: 'user-a',
    title: 'shared', startsAt: now + 60_000,
  });
  const personal = system.createPersonalCalendarEvent({
    userId: 'user-a', sourceGuildId: 'guild-a', title: 'private', startsAt: now + 60_000,
  });
  system.writeCalendarEvents({ [shared.id]: shared, [personal.id]: personal });
  assert.deepEqual(system.listUpcomingEvents({ guildId: 'guild-a' }).map((e) => e.id), [shared.id]);
  assert.deepEqual(system.listUpcomingEvents({ guildId: 'guild-b' }), []);
  assert.deepEqual(system.listPersonalEvents({ userId: 'user-a' }).map((e) => e.id), [personal.id]);
  assert.deepEqual(system.listPersonalEvents({ userId: 'user-b' }), []);
  assert.equal(system.deletePersonalEvent({ userId: 'user-b', eventId: personal.id }), null);
  assert.equal(system.deleteCalendarEvent({ guildId: 'guild-b', eventId: shared.id }), null);
  assert.equal(system.deletePersonalEvent({ userId: 'user-a', eventId: personal.id }).id, personal.id);
});

test('damaged calendar authority is not overwritten', (t) => {
  const filePath = fixture(t, 'calendar.json');
  const system = createCalendarSystem({ filePath });
  assert.throws(() => system.writeCalendarEvents({}), /ENOENT/);
  system.initializeCalendarStore();
  fs.writeFileSync(filePath, '');
  assert.throws(() => system.writeCalendarEvents({}), /empty/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '');
});

test('legacy shared events keep their guild and migrate with a repeatable receipt', (t) => {
  const filePath = fixture(t, 'calendar.json');
  const system = createCalendarSystem({ filePath });
  const legacy = { one: {
    id: 'one', guildId: 'guild-a', channelId: 'channel-a',
    createdBy: 'user-a', title: 'legacy', startsAt: Date.now() + 60_000,
  } };
  const source = JSON.stringify(legacy);
  fs.writeFileSync(filePath, source);
  assert.throws(() => system.deleteCalendarEvent({ guildId: 'guild-a', eventId: 'one' }), /migration/);
  const receipt = system.migrateLegacyCalendarStore();
  assert.equal(receipt.recordCount, 1);
  assert.equal(fs.readFileSync(filePath + '.legacy-v1.bak', 'utf8'), source);
  assert.equal(system.listUpcomingEvents({ guildId: 'guild-a' })[0].scope, 'shared');
  assert.deepEqual(system.migrateLegacyCalendarStore(), receipt);
  assert.equal(system.deletePersonalEvent({ userId: 'user-a', eventId: 'one' }), null);
  assert.equal(system.deleteCalendarEvent({ guildId: 'guild-a', eventId: 'one' }).id, 'one');
});

test('calendar migration refuses changed source after backup', (t) => {
  const filePath = fixture(t, 'calendar.json');
  const system = createCalendarSystem({ filePath });
  const event = { one: {
    guildId: 'guild-a', createdBy: 'user-a', title: 'legacy',
    startsAt: Date.now() + 60_000,
  } };
  fs.writeFileSync(filePath, JSON.stringify(event));
  fs.copyFileSync(filePath, filePath + '.legacy-v1.bak');
  fs.writeFileSync(filePath, JSON.stringify({ ...event, two: { ...event.one, title: 'changed' } }));
  assert.throws(() => system.migrateLegacyCalendarStore(), /changed/);
  assert.equal(system.readCalendarEvents().two.title, 'changed');
});
