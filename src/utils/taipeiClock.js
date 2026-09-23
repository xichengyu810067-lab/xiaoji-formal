const TAIPEI_TIME_ZONE = 'Asia/Taipei';
const TAIPEI_OFFSET_MINUTES = 8 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function requireDate(now = new Date()) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now must be a valid Date or date value');
  }

  return date;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function getTaipeiParts(now = new Date()) {
  const date = requireDate(now);
  const shifted = new Date(date.getTime() + TAIPEI_OFFSET_MINUTES * 60 * 1000);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function getTaipeiDateKey(now = new Date()) {
  const parts = getTaipeiParts(now);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function getTaipeiMinuteOfDay(now = new Date()) {
  const parts = getTaipeiParts(now);
  return parts.hour * 60 + parts.minute;
}

function isTaipeiTime(now, hour, minute = 0) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError('Taipei hour and minute are out of range');
  }

  const parts = getTaipeiParts(now);
  return parts.hour === hour && parts.minute === minute;
}

function getTaipeiDayRange(now = new Date()) {
  const parts = getTaipeiParts(now);
  const startMs = Date.UTC(parts.year, parts.month - 1, parts.day) - TAIPEI_OFFSET_MINUTES * 60 * 1000;

  return {
    dateKey: getTaipeiDateKey(now),
    start: new Date(startMs),
    endExclusive: new Date(startMs + DAY_MS),
  };
}

function getNextTaipeiOccurrence(hour, minute = 0, now = new Date()) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError('Taipei hour and minute are out of range');
  }

  const date = requireDate(now);
  const parts = getTaipeiParts(date);
  let targetMs =
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute) - TAIPEI_OFFSET_MINUTES * 60 * 1000;

  if (targetMs <= date.getTime()) {
    targetMs += DAY_MS;
  }

  return new Date(targetMs);
}

module.exports = {
  TAIPEI_OFFSET_MINUTES,
  TAIPEI_TIME_ZONE,
  getNextTaipeiOccurrence,
  getTaipeiDateKey,
  getTaipeiDayRange,
  getTaipeiMinuteOfDay,
  getTaipeiParts,
  isTaipeiTime,
};
