'use strict';

// Live test F3/F4 (v1.3.4): a guess the judge ruled 未答對 was shown as "目前無法判定，棋局已保留。", and a long
// scenario ran off the right edge of the board image on one line. 未答對 now has its own reply, and the image wraps
// every prompt to the frame (closing punctuation never starts a line; what does not fit ends in "…").

const test = require('node:test');
const assert = require('node:assert/strict');

const { judgmentReply } = require('../src/systems/games/board/discord/turtleSoupDiscordAdapter');
const { renderBoardSvg, wrapText } = require('../src/systems/games/board/renderer/svgBoardRenderer');

const judged = (verdict) => ({ events: [{ type: 'turtle-soup-judged', verdict }] });

test('each verdict has its own reply, and a wrong guess no longer reads as undecided', () => {
  assert.equal(judgmentReply(judged('未答對')), '未答對，再想想看！');
  assert.equal(judgmentReply(judged('答對')), '答對了！按「查看湯底」可以私下看完整湯底。');
  for (const verdict of ['是', '否', '無關']) assert.equal(judgmentReply(judged(verdict)), verdict);
  assert.equal(judgmentReply(judged('無法判定')), '目前無法判定，棋局已保留。');
  assert.equal(judgmentReply(null), '目前無法判定，棋局已保留。');
});

test('text wraps by width, keeps closing punctuation off the start of a line, and counts Latin letters as narrow', () => {
  assert.deepEqual(wrapText('一二三四五。六七', 5), ['一二三四五。', '六七']);
  assert.deepEqual(wrapText('一二三四五六七八', 3), ['一二三', '四五六', '七八']);
  assert.deepEqual(wrapText('abcdefghij', 5.5), ['abcdefghij']);
  assert.deepEqual(wrapText('hello world again', 3.3), ['hello', 'world', 'again']);
  assert.deepEqual(wrapText('  多個   空白  ', 10), ['多個 空白']);
  assert.deepEqual(wrapText('', 10), []);
});

function narrativeView(text) {
  return {
    gameKey: 'turtle-soup', rulesVersion: '1', turn: null, outcome: null,
    board: { kind: 'narrative', width: null, height: null, points: [], pieces: [] },
    prompts: [{ type: 'scenario', text }, { type: 'status', text: '提問請按「提問」。' }],
  };
}

function textLines(svg) {
  return [...svg.matchAll(/<text [^>]*font-size="24"[^>]*>([^<]*)<\/text>/gu)].map((match) => match[1]);
}

test('a long scenario is drawn in full over several lines inside the frame', () => {
  const scenario = '一名上班族明明趕時間，卻在公司樓下買了兩份早餐，還因此遲到。主管知道原因後沒有責備他。為什麼？';
  const lines = textLines(renderBoardSvg(narrativeView(scenario)));
  assert.equal(lines.at(-1), '提問請按「提問」。');
  assert.equal(lines.slice(0, -1).join(''), scenario, 'nothing of the scenario is lost');
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((line) => [...line].length <= 30), 'every line fits the frame');
  assert.ok(lines.every((line) => !/^[。，、？！」]/u.test(line)));
});

test('a scenario too long for the frame is cut on its last line with "…"', () => {
  const lines = textLines(renderBoardSvg(narrativeView('很長的湯面。'.repeat(200))));
  assert.ok(lines.length <= 17);
  assert.match(lines.at(-1), /…$/u);
});
