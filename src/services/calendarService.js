const fs = require('node:fs');
const path = require('node:path');

const calendarPath = path.join(__dirname, '..', 'data', 'calendarEvents.json');

function ensureCalendarFile() {
  const directory = path.dirname(calendarPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(calendarPath)) {
    fs.writeFileSync(calendarPath, '{}\n', 'utf8');
  }
}

function readCalendarEvents() {
  ensureCalendarFile();

  try {
    const raw = fs.readFileSync(calendarPath, 'utf8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCalendarEvents(events) {
  ensureCalendarFile();
  fs.writeFileSync(calendarPath, `${JSON.stringify(events, null, 2)}\n`, 'utf8');
}

function parseCalendarDate(input) {
  const text = String(input || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }

  return date;
}

function createCalendarEventId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCalendarEvent({
  guildId,
  channelId,
  createdBy,
  title,
  description = '',
  startsAt,
  now = Date.now(),
}) {
  const normalizedTitle = String(title || '').trim();

  if (!normalizedTitle) {
    throw new Error('Calendar event title is required.');
  }

  return {
    id: createCalendarEventId(),
    guildId,
    channelId,
    createdBy,
    title: normalizedTitle.slice(0, 100),
    description: String(description || '').trim().slice(0, 1000),
    startsAt,
    createdAt: now,
  };
}

function saveCalendarEvent(event) {
  const events = readCalendarEvents();
  events[event.id] = event;
  writeCalendarEvents(events);
}

function listUpcomingEvents({ guildId, days = 30, now = Date.now() }) {
  const maxTime = now + days * 24 * 60 * 60 * 1000;

  return Object.values(readCalendarEvents())
    .filter((event) => event.guildId === guildId && event.startsAt >= now && event.startsAt <= maxTime)
    .sort((a, b) => a.startsAt - b.startsAt);
}

function deleteCalendarEvent({ guildId, eventId }) {
  const events = readCalendarEvents();
  const event = events[eventId];

  if (!event || event.guildId !== guildId) {
    return null;
  }

  delete events[eventId];
  writeCalendarEvents(events);
  return event;
}

function formatCalendarEventList(events) {
  if (events.length === 0) {
    return '沒有找到 upcoming 行事曆事件。';
  }

  return events
    .slice(0, 10)
    .map((event) => {
      const description = event.description ? ` - ${event.description}` : '';
      return `\`${event.id}\` - <t:${Math.floor(event.startsAt / 1000)}:F> - **${event.title}**${description}`;
    })
    .join('\n');
}

module.exports = {
  createCalendarEvent,
  deleteCalendarEvent,
  formatCalendarEventList,
  listUpcomingEvents,
  parseCalendarDate,
  readCalendarEvents,
  saveCalendarEvent,
  writeCalendarEvents,
};
