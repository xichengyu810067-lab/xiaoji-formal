const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCalendarEvent,
  formatCalendarEventList,
  parseCalendarDate,
} = require('../src/services/calendarService');

test('parseCalendarDate accepts YYYY-MM-DD HH:mm', () => {
  const date = parseCalendarDate('2026-05-10 20:30');

  assert.ok(date instanceof Date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 10);
  assert.equal(date.getHours(), 20);
  assert.equal(date.getMinutes(), 30);
});

test('parseCalendarDate rejects invalid dates', () => {
  assert.equal(parseCalendarDate('2026-02-30 10:00'), null);
  assert.equal(parseCalendarDate('not-a-date'), null);
});

test('createCalendarEvent builds an event record', () => {
  const event = createCalendarEvent({
    guildId: 'guild',
    channelId: 'channel',
    createdBy: 'user',
    title: 'Meeting',
    description: 'Planning',
    startsAt: 1000,
    now: 500,
  });

  assert.equal(event.guildId, 'guild');
  assert.equal(event.title, 'Meeting');
  assert.equal(event.description, 'Planning');
  assert.equal(event.startsAt, 1000);
  assert.equal(event.createdAt, 500);
  assert.ok(event.id);
});

test('formatCalendarEventList includes event ids and titles', () => {
  const output = formatCalendarEventList([
    {
      id: 'event1',
      title: 'Meeting',
      description: '',
      startsAt: 1893456000000,
    },
  ]);

  assert.match(output, /event1/);
  assert.match(output, /Meeting/);
});
