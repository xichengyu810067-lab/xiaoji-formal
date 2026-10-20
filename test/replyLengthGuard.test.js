'use strict';

// The helper that keeps a reply made of many rows inside one Discord message (src/utils/replyLengthGuard.js): a reply
// that fits is returned exactly as it was built, free text is cut the same way in every row, and rows that still do
// not fit are left out with a line that says how many.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MIN_TEXT_LIMIT,
  DISCORD_TEXT_LIMITS,
  clipText,
  fitListText,
  fitReplyText,
  listRows,
  omittedLine,
} = require('../src/utils/replyLengthGuard');

// A row with one free text, the way the commands build theirs: a fixed part, then the text.
const rowOf = (item, { textLimit }) => `#${item.id}｜固定欄位｜${clipText(item.text, textLimit)}`;
// The same with a long fixed part, so that even short texts do not let every row fit.
const wideRowOf = (item, { textLimit }) => `#${item.id}｜${'欄'.repeat(100)}｜${clipText(item.text, textLimit)}`;

const items = (count, textLength, start = 1) => Array.from({ length: count }, (_, index) => ({
  id: String(start + index).padStart(3, '0'),
  text: `${String(start + index).padStart(3, '0')}-${'字'.repeat(Math.max(0, textLength - 4))}`.slice(0, textLength),
}));

test('the limits are the ones Discord documents', () => {
  assert.deepEqual({ ...DISCORD_TEXT_LIMITS }, {
    content: 2000, embedDescription: 4096, fieldValue: 1024, embedFields: 25, embedTotal: 6000,
  });
  assert.equal(Object.isFrozen(DISCORD_TEXT_LIMITS), true);
});

test('clipText keeps short text, cuts long text to the length with an ellipsis, and leaves what is not text', () => {
  assert.equal(clipText('短文字', 10), '短文字');
  assert.equal(clipText('一二三四五', 5), '一二三四五');
  assert.equal(clipText('一二三四五六', 5), '一二三四…');
  assert.equal(clipText('一二三四五六', 5).length, 5);
  assert.equal(clipText('一二三', Infinity), '一二三');
  assert.equal(clipText('一二三四五六', 1), '…');
  assert.equal(clipText('一二三', 0), '');
  assert.equal(clipText(undefined, 3), undefined);
  assert.equal(clipText(null, 3), null);
  assert.equal(clipText(12345678, 3), 12345678);
});

test('clipText never cuts an emoji in half', () => {
  // The emoji is two UTF-16 units, at 2 and 3: a cut after 3 units would land between its halves.
  const text = '一二😀三四五';
  assert.equal(clipText(text, 4), '一二…');
  assert.equal(clipText(text, 5), '一二😀…');
  assert.equal(clipText(text, 6), '一二😀三…');
  for (let length = 1; length < text.length; length += 1) {
    const clipped = clipText(text, length);
    assert.ok(clipped.length <= length, `${length}`);
    assert.doesNotMatch(clipped, /[\ud800-\udbff](?![\udc00-\udfff])/u, `a lone first half at ${length}`);
    assert.doesNotMatch(clipped, /(?<![\ud800-\udbff])[\udc00-\udfff]/u, `a lone second half at ${length}`);
  }
});

test('omittedLine says how many rows are not shown, with the unit and the hint when there are some', () => {
  assert.equal(omittedLine(3), '另有 3 筆未顯示（訊息長度已達上限）。');
  assert.equal(omittedLine(16, { unit: '筆定存' }), '另有 16 筆定存未顯示（訊息長度已達上限）。');
  assert.equal(
    omittedLine(2, { unit: '則提醒', hint: '前面的提醒送出或刪除後才會顯示' }),
    '另有 2 則提醒未顯示（訊息長度已達上限），前面的提醒送出或刪除後才會顯示。'
  );
});

test('a list that fits is returned exactly as it was built', () => {
  const rows = items(4, 20);
  const expected = ['**標題**', ...rows.map((item) => rowOf(item, { textLimit: Infinity }))].join('\n');
  assert.equal(fitListText({ header: '**標題**', items: rows, render: rowOf }), expected);

  // Blocks of several lines under a different separator, and a header of two lines.
  const blocks = items(3, 30);
  assert.equal(
    fitListText({ header: ['**標題**', '副標'], items: blocks, render: rowOf, separator: '\n\n' }),
    ['**標題**', '副標', ...blocks.map((item) => rowOf(item, { textLimit: Infinity }))].join('\n\n')
  );
  // No header: the rows only.
  assert.equal(
    fitListText({ items: blocks, render: rowOf }),
    blocks.map((item) => rowOf(item, { textLimit: Infinity })).join('\n')
  );
  // Nothing to list: the header alone.
  assert.equal(fitListText({ header: '**標題**', items: [], render: rowOf }), '**標題**');
});

test('a list that is exactly as long as the limit is not changed, and one character more is', () => {
  const row = (length) => ({ id: '001', text: 'x'.repeat(length) });
  const fixedLength = rowOf({ id: '001', text: '' }, { textLimit: Infinity }).length;
  const exact = 2000 - fixedLength;
  const same = fitListText({ items: [row(exact)], render: rowOf });
  assert.equal(same.length, 2000);
  assert.equal(same, rowOf(row(exact), { textLimit: Infinity }));

  const over = fitListText({ items: [row(exact + 1)], render: rowOf });
  assert.ok(over.length <= 2000);
  assert.ok(over.endsWith('…'));
  assert.notEqual(over, rowOf(row(exact + 1), { textLimit: Infinity }));
});

test('a list that is too long keeps every row and cuts the free text of all of them to the same, longest fitting length', () => {
  const rows = items(10, 400);
  const result = fitListText({ header: '**標題**', items: rows, render: rowOf });
  assert.ok(result.length <= 2000, `${result.length}`);
  const lines = result.split('\n');
  assert.equal(lines[0], '**標題**');
  assert.equal(lines.length, 11, 'no row is left out');
  assert.equal(lines.some((line) => line.includes('另有')), false);

  // Every row is cut to the same length, and a cut one character longer would not have fitted.
  const cut = lines.slice(1).map((line) => line.split('｜')[2]);
  assert.equal(new Set(cut.map((text) => text.length)).size, 1);
  assert.ok(cut.every((text) => text.endsWith('…')));
  const length = cut[0].length;
  const longer = ['**標題**', ...rows.map((item) => rowOf(item, { textLimit: length + 1 }))].join('\n');
  assert.ok(longer.length > 2000, `a cut of ${length + 1} would be ${longer.length}`);
  // The start of every text is what stays.
  rows.forEach((item, index) => assert.equal(cut[index], item.text.slice(0, length - 1) + '…'));
});

test('rows that do not fit even with the shortest cut are left out from the end, and the last line says how many', () => {
  const rows = items(25, 400);
  const result = fitListText({
    header: '**標題**',
    items: rows,
    render: wideRowOf,
    note: (count) => omittedLine(count, { unit: '筆紀錄', hint: '可縮小範圍' }),
  });
  assert.ok(result.length <= 2000, `${result.length}`);
  const lines = result.split('\n');
  assert.equal(lines[0], '**標題**');
  const shown = lines.slice(1, -1);
  assert.ok(shown.length > 0 && shown.length < 25, `${shown.length} rows shown`);
  // The first rows, in their order, each cut to the shortest length.
  shown.forEach((line, index) => assert.equal(line, wideRowOf(rows[index], { textLimit: DEFAULT_MIN_TEXT_LIMIT })));
  assert.equal(lines.at(-1), `另有 ${25 - shown.length} 筆紀錄未顯示（訊息長度已達上限），可縮小範圍。`);
  // One more row would not have fitted.
  const oneMore = ['**標題**', ...rows.slice(0, shown.length + 1).map((item) => wideRowOf(item, { textLimit: DEFAULT_MIN_TEXT_LIMIT })),
    omittedLine(25 - shown.length - 1, { unit: '筆紀錄', hint: '可縮小範圍' })].join('\n');
  assert.ok(oneMore.length > 2000);
});

test('rows without free text are left out from the end when they do not fit', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1), text: '' }));
  const wide = (item) => `#${item.id}｜${'欄'.repeat(150)}`;
  const result = fitListText({ header: '**標題**', items: rows, render: wide });
  assert.ok(result.length <= 2000);
  const lines = result.split('\n');
  const shown = lines.length - 2;
  assert.ok(shown > 0 && shown < 25);
  assert.equal(lines.at(-1), omittedLine(25 - shown));
});

test('a list sliced from a longer one counts the rows that were never in it', () => {
  const rows = items(10, 400);
  const result = fitListText({ items: rows, totalCount: 14, render: rowOf });
  // Everything in the slice fits after the cut, so there is no note: the caller chose to show ten.
  assert.equal(result.split('\n').length, 10);
  assert.equal(result.includes('另有'), false);

  const many = items(25, 400);
  const left = fitListText({ items: many, totalCount: 30, render: wideRowOf });
  const shown = left.split('\n').length - 1;
  assert.ok(shown > 0 && shown < 25);
  assert.equal(left.split('\n').at(-1), omittedLine(30 - shown));
});

test('a header that alone is longer than the limit is cut to it', () => {
  const result = fitListText({ header: `**${'長'.repeat(2500)}**`, items: items(3, 10), render: rowOf });
  assert.equal(result.length, 2000);
  assert.ok(result.endsWith('…'));
});

test('the limit can be the one of an embed description or a field', () => {
  const rows = items(30, 200);
  for (const limit of [DISCORD_TEXT_LIMITS.fieldValue, DISCORD_TEXT_LIMITS.embedDescription]) {
    const result = fitListText({ header: '**標題**', items: rows, render: rowOf, limit });
    assert.ok(result.length <= limit, `${limit}: ${result.length}`);
  }
  const embed = fitListText({ items: rows.slice(0, 5), render: rowOf, limit: DISCORD_TEXT_LIMITS.embedDescription });
  assert.equal(embed, rows.slice(0, 5).map((item) => rowOf(item, { textLimit: Infinity })).join('\n'));
});

test('every reply stays inside the limit and keeps the order of the rows, whatever the lengths', () => {
  // A small deterministic generator, so a failure can be repeated.
  let seed = 20261012;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const between = (min, max) => min + Math.floor(random() * (max - min + 1));

  let fitting = 0;
  let cut = 0;
  let left = 0;
  for (let round = 0; round < 400; round += 1) {
    const count = between(1, 25);
    const rows = Array.from({ length: count }, (_, index) => ({
      id: String(index + 1).padStart(3, '0'),
      text: '字'.repeat(between(0, random() < 0.5 ? 60 : 1000)),
    }));
    const header = random() < 0.8 ? `**標題 ${round}**` : null;
    const separator = random() < 0.5 ? '\n' : '\n\n';
    const render = round % 2 === 0 ? rowOf : wideRowOf;
    const result = fitListText({ header, items: rows, render, separator });
    assert.ok(result.length <= 2000, `round ${round}: ${result.length}`);

    const full = [...(header ? [header] : []), ...rows.map((item) => render(item, { textLimit: Infinity }))].join(separator);
    if (full.length <= 2000) {
      assert.equal(result, full, `round ${round}: a list that fits is not changed`);
      fitting += 1;
      continue;
    }
    const shownIds = [...result.matchAll(/#(\d{3})｜/gu)].map((match) => match[1]);
    assert.deepEqual(shownIds, rows.slice(0, shownIds.length).map((item) => item.id), `round ${round}: the first rows, in order`);
    const note = /另有 (\d+) 筆未顯示/u.exec(result);
    if (shownIds.length === count) {
      assert.equal(note, null, `round ${round}: nothing left out, so no note`);
      cut += 1;
    } else {
      assert.ok(note, `round ${round}: rows were left out, so there is a note`);
      assert.equal(Number(note[1]), count - shownIds.length, `round ${round}: the note counts the rows left out`);
      left += 1;
    }
  }
  assert.ok(fitting > 20 && cut > 20 && left > 20, `${fitting} fit, ${cut} cut, ${left} left rows out`);
});

test('fitReplyText shapes a reply with several lists by one pair of limits, and always ends inside the limit', () => {
  const first = items(8, 300);
  const second = items(8, 300, 101);
  const build = ({ textLimit, rowLimit }) => [
    '**報告**',
    '**第一份**',
    ...listRows(first, rowOf, { textLimit, rowLimit }),
    '',
    '**第二份**',
    ...listRows(second, rowOf, { textLimit, rowLimit }),
  ].join('\n');

  // Fitting: unchanged.
  const small = fitReplyText(({ textLimit, rowLimit }) => [
    '**報告**', ...listRows(items(2, 20), rowOf, { textLimit, rowLimit }),
  ].join('\n'), { maxRows: 2 });
  assert.equal(small, ['**報告**', ...items(2, 20).map((item) => rowOf(item, { textLimit: Infinity }))].join('\n'));

  const result = fitReplyText(build, { maxRows: 8 });
  assert.ok(result.length <= 2000, `${result.length}`);
  assert.ok(result.includes('**第一份**') && result.includes('**第二份**'));
  const notes = result.split('\n').filter((line) => line.startsWith('另有'));
  // Both lists are shortened alike: the same number of rows shown, and the same note under each.
  const shownFirst = [...result.split('**第二份**')[0].matchAll(/#\d{3}｜/gu)].length;
  const shownSecond = [...result.split('**第二份**')[1].matchAll(/#\d{3}｜/gu)].length;
  assert.equal(shownFirst, shownSecond);
  if (shownFirst < 8) assert.deepEqual(notes, [omittedLine(8 - shownFirst), omittedLine(8 - shownSecond)]);
});

test('fitReplyText ends inside the limit even when the builder has no rows to leave out', () => {
  const stubborn = () => '長'.repeat(5000);
  const result = fitReplyText(stubborn, { maxRows: 0 });
  assert.equal(result.length, 2000);
  assert.ok(result.endsWith('…'));
});

test('listRows leaves out nothing without a row limit, and puts the note last when it does', () => {
  const rows = items(5, 10);
  assert.equal(listRows(rows, rowOf).length, 5);
  assert.deepEqual(listRows(rows, rowOf, { rowLimit: 2 }).slice(0, 2), rows.slice(0, 2).map((item) => rowOf(item, { textLimit: Infinity })));
  assert.equal(listRows(rows, rowOf, { rowLimit: 2 }).at(-1), omittedLine(3));
  assert.equal(listRows(rows, rowOf, { rowLimit: 0 }).length, 1);
  // A row limit that is not below the row count leaves the list whole.
  assert.equal(listRows(rows, rowOf, { rowLimit: 5 }).length, 5);
});
