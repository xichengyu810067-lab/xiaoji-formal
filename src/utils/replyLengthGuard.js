'use strict';

// Keeps one reply that joins many stored rows inside Discord's length limits, the way /calendar list does for its
// events. Text a member typed (names, descriptions, reasons, messages) is cut to the same length in every row and
// marked with "…"; rows that still do not fit are left out, and a last line says how many. A reply that already fits
// is returned exactly as it was built, character for character.
//
// Nothing here loads a system or a service, so any command or utility can use it.

// Discord's limits for one message. A reply built here is checked against the one it is sent in: content for a
// plain reply, embedDescription or fieldValue for text inside an embed.
const DISCORD_TEXT_LIMITS = Object.freeze({
  content: 2000,
  embedDescription: 4096,
  fieldValue: 1024,
  embedFields: 25,
  embedTotal: 6000,
});

// The shortest cut of free text tried before rows are left out. Cut shorter than this, the text no longer tells rows
// apart, so a row is left out instead.
const DEFAULT_MIN_TEXT_LIMIT = 40;
const ELLIPSIS = '…';

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

// The text, cut to at most maxLength characters with "…" as the last one when anything was cut. Text that is already
// short enough (and any text, for Infinity) comes back unchanged, and so does anything that is not text, so a missing
// value is shown the way it was shown before. A cut never splits an emoji or another character that takes two UTF-16
// units.
function clipText(text, maxLength) {
  if (typeof text !== 'string' || !(text.length > maxLength)) return text;
  if (maxLength < 1) return '';
  let end = Math.max(0, Math.floor(maxLength) - ELLIPSIS.length);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}

// The line that ends a list with rows left out. unit names what was left out ("筆定存", "則提醒"); hint says where
// the rest can be read, when there is a way.
function omittedLine(count, { unit = '筆', hint = '' } = {}) {
  return `另有 ${count} ${unit}未顯示（訊息長度已達上限）${hint ? `，${hint}` : ''}。`;
}

// The rows of one list as lines, for a reply that mixes lists with other lines. render(item, { textLimit, index })
// returns one row; it cuts the free text of the row with clipText(text, textLimit). rowLimit counts the rows that may
// be shown; when it leaves rows out, the last line is the note (omittedLine by default), given how many rows are not
// shown in all. totalCount is that total when `items` holds only the first rows of a longer list.
function listRows(items, render, { textLimit = Infinity, rowLimit = Infinity, totalCount = items.length, note = omittedLine } = {}) {
  const shown = rowLimit < items.length ? Math.max(0, Math.floor(rowLimit)) : items.length;
  const lines = items.slice(0, shown).map((item, index) => String(render(item, { textLimit, index })));
  if (shown < items.length) lines.push(String(note(Math.max(totalCount, items.length) - shown)));
  return lines;
}

// Builds a reply that fits `limit` characters. build({ textLimit, rowLimit }) returns the whole reply as a string,
// shaped by the two limits (Infinity for both is the reply as it is without any limit); listRows applies them to a
// list. maxRows is the length of the longest list in the reply. Tried in this order:
//   1. the reply without limits, when it fits;
//   2. every row with the same cut of its free text: the longest cut, not shorter than minTextLimit, that fits;
//   3. the free text cut to minTextLimit and only the first rows, as many as fit;
//   4. the reply with no rows, shortened to the limit (only when even that does not fit).
function fitReplyText(build, { limit = DISCORD_TEXT_LIMITS.content, maxRows = 0, minTextLimit = DEFAULT_MIN_TEXT_LIMIT } = {}) {
  const make = (textLimit, rowLimit) => String(build({ textLimit, rowLimit }));

  const full = make(Infinity, Infinity);
  if (full.length <= limit) return full;

  let best = make(minTextLimit, Infinity);
  if (best.length <= limit) {
    // `fits` is a cut known to fit, `tooLong` one known not to: nothing is cut at the length of the whole reply.
    let fits = minTextLimit;
    let tooLong = Math.max(minTextLimit + 1, full.length);
    while (tooLong - fits > 1) {
      const middle = Math.floor((fits + tooLong) / 2);
      const text = make(middle, Infinity);
      if (text.length <= limit) {
        fits = middle;
        best = text;
      } else {
        tooLong = middle;
      }
    }
    return best;
  }

  for (let rows = maxRows - 1; rows >= 0; rows -= 1) {
    const text = make(minTextLimit, rows);
    if (text.length <= limit) return text;
  }

  return clipText(make(minTextLimit, 0), limit);
}

// A header (one line or several) followed by one row for each item, joined by `separator`.
//   items         the rows to show, in the order they are shown (the first ones are kept when some must go)
//   render        (item, { textLimit, index }) => the row as text; cuts its free text with clipText(text, textLimit)
//   totalCount    how many rows the list has in all, when `items` is only its first rows; the note counts from it
//   note          (omittedCount) => the closing line when rows are left out; omittedLine by default
// With nothing to cut or leave out the result is exactly [...header, ...rows].join(separator).
function fitListText({
  header = null,
  items,
  render,
  separator = '\n',
  limit = DISCORD_TEXT_LIMITS.content,
  totalCount = items.length,
  note = omittedLine,
  minTextLimit = DEFAULT_MIN_TEXT_LIMIT,
}) {
  const headerLines = header === null || header === undefined ? [] : [].concat(header);
  return fitReplyText(({ textLimit, rowLimit }) => [
    ...headerLines,
    ...listRows(items, render, { textLimit, rowLimit, totalCount, note }),
  ].join(separator), { limit, maxRows: items.length, minTextLimit });
}

module.exports = {
  DEFAULT_MIN_TEXT_LIMIT,
  DISCORD_TEXT_LIMITS,
  clipText,
  fitListText,
  fitReplyText,
  listRows,
  omittedLine,
};
