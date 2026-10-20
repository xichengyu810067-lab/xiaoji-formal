'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const {
  LINK_RISK_REASONS: R,
  MAX_TEXT_LENGTH,
  MAX_URLS,
  osaDistance,
  scanLinkRisk,
} = require('../src/systems/conversation/linkRiskScanner');

const ZERO_WIDTH = String.fromCodePoint(0x200b);
const CYRILLIC_I = String.fromCodePoint(0x0456);
const BIDI = String.fromCodePoint(0x202e);

// Messages that carry a lure, with the reason that has to be among the answer's reasons.
const RISKY = Object.freeze([
  ['free nitro https://dlscord-gift.com/claim', R.BRAND_LOOKALIKE],
  ['free nitro https://dlscord-gift.com/claim', R.BAIT_WITH_LINK],
  ['免費領取 Nitro！ discord-nitro.xyz/claim', R.BRAND_WITH_BAIT_WORD],
  ['https://discord.com.verify-login.xyz/a', R.BRAND_AS_SUBDOMAIN],
  ['https://discordapp.com.free-gift.ru/', R.BRAND_AS_SUBDOMAIN],
  ['https://steamcommunity.com-trade.ru/offer', R.BRAND_AS_SUBDOMAIN],
  ['https://disc0rd.com/login', R.BRAND_LOOKALIKE],
  ['https://dlscord.com/nitro', R.BRAND_LOOKALIKE],
  ['https://dicsord.com/', R.BRAND_LOOKALIKE],
  ['https://discorrd.com/', R.BRAND_LOOKALIKE],
  ['https://dis-cord.com/x', R.BRAND_LOOKALIKE],
  ['https://steamcommunnity.com/gift', R.BRAND_LOOKALIKE],
  ['https://steamcomrnunity.com/login', R.BRAND_LOOKALIKE],
  ['https://ste4mpowered.com/login', R.BRAND_LOOKALIKE],
  ['https://paypa1.com/signin', R.BRAND_LOOKALIKE],
  ['https://twitchh.com/free', R.BRAND_LOOKALIKE],
  [`https://d${CYRILLIC_I}scord.com/x`, R.MIXED_SCRIPT_HOST],
  ['https://xn--dscord-9qa.com/', R.PUNYCODE_HOST],
  ['https://xn--80ak6aa92e.com/', R.PUNYCODE_HOST],
  ['http://192.0.2.7/login', R.IP_HOST],
  ['http://0xC0A80101/', R.IP_HOST],
  ['http://3232235777/pay', R.IP_HOST],
  ['http://[2001:db8::1]/a', R.IP_HOST],
  ['https://discord.com@evil.example/', R.USERINFO_HOST],
  [`https://disc${ZERO_WIDTH}ord.com@evil.example/`, R.USERINFO_HOST],
  ['https://steampowered.com:pass@evil.example/', R.USERINFO_HOST],
  ['download https://cdn.discordapp.com/attachments/1/2/setup.exe', R.EXECUTABLE_DOWNLOAD],
  ['https://files.example.org/Setup_2026.msi', R.EXECUTABLE_DOWNLOAD],
  ['https://x.example/game.apk?dl=1', R.EXECUTABLE_DOWNLOAD],
  ['https://x.example/Invoice.pdf.EXE', R.EXECUTABLE_DOWNLOAD],
  ['https://x.example/a%2Fb/crack.lnk#top', R.EXECUTABLE_DOWNLOAD],
  ['@everyone https://evil.example/win', R.MASS_MENTION_WITH_LINK],
  ['@here free robux https://roblox-gift.example/', R.MASS_MENTION_WITH_LINK],
  ['＠everyone ｈｔｔｐｓ：／／evil.example/win', R.MASS_MENTION_WITH_LINK],
  ['恭喜你中獎 bit.ly/abc123', R.SHORTENER_WITH_BAIT],
  ['Get your free Discord Nitro here: bit.ly/3xYz', R.SHORTENER_WITH_BAIT],
  ['Your account will be suspended, verify now: https://tinyurl.com/abcd', R.SHORTENER_WITH_BAIT],
  ['https://s.id/xyz 領取禮物', R.SHORTENER_WITH_BAIT],
  ['FREE NITRO!!! CLICK https://EVIL-NITRO.example/', R.BAIT_WITH_LINK],
  ['Steam gift for you 🎁 https://giftbox.example/x', R.BAIT_WITH_LINK],
  ['驗證你的帳號 否則將被停用 https://account-check.example/login', R.BAIT_WITH_LINK],
  ['you have won! claim your prize https://prize-center.example/win', R.BAIT_WITH_LINK],
  ['免费领取礼包 点击 https://gift-center.example/get', R.BAIT_WITH_LINK],
  ['恭喜您中奖 www.lucky-draw.example/start', R.BAIT_WITH_LINK],
  ['[點我領取](https://dlscord-nitro.com/gift)', R.BRAND_LOOKALIKE],
  ['<https://disc0rd-app.com/>', R.BRAND_LOOKALIKE],
  ['HTTPS://DISCORD-NITRO.GIFT/', R.BRAND_WITH_BAIT_WORD],
  ['hxxps://discord-gift.com/free', R.BRAND_WITH_BAIT_WORD],
  ['www.steam-gift.ru', R.BRAND_WITH_BAIT_WORD],
  ['ｈｔｔｐｓ：／／ｄｉｓｃ０ｒｄ．ｃｏｍ／ｌｏｇｉｎ', R.BRAND_LOOKALIKE],
  ['https://%64iscord.com.evil.xyz/', R.BRAND_AS_SUBDOMAIN],
  [`請點 ${BIDI}https://dlscord.com/gift 領取`, R.BRAND_LOOKALIKE],
  ['點擊領取 FREE Nitro => https://nitro-free.example/', R.BRAND_WITH_BAIT_WORD],
]);

// Messages that carry no lure: ordinary links, links to the real places, text about lures, and text with dots.
const SAFE = Object.freeze([
  'check this out https://www.youtube.com/watch?v=abc',
  'https://github.com/user/repo/releases/download/v1/tool.exe',
  '請看https://youtube.com/watch?v=1很好看',
  '@everyone https://youtube.com/watch?v=1',
  '@here 今晚八點開會 https://meet.google.com/abc-defg-hij',
  'https://discord.com/channels/1/2/3',
  'https://discord.com/developers/docs/intro',
  'https://support.discord.com/hc/en-us/articles/123',
  'https://discordapp.com/channels/1/2/3',
  'https://www.discordapp.com/',
  'https://cdn.discordapp.com/attachments/1/2/image.png',
  'https://discord.gift/abcd',
  'HTTPS://DISCORD.COM/channels/1',
  'discord.gg/abcd1234',
  'join us: discordapp.com/invite/abcd',
  'https://store.steampowered.com/app/730 免費玩',
  'https://steamcommunity.com/id/foo/',
  'https://store.steampowered.com/app/10',
  'https://en.wikipedia.org/wiki/Discord_(software)',
  '請參考 https://zh.wikipedia.org/wiki/中華民國 這篇',
  'https://twitch.tv/somestreamer',
  'https://reddit.com/r/discordapp',
  'https://x.com/user/status/123',
  'https://docs.google.com/document/d/abc',
  'https://www.google.com/search?q=free+nitro',
  'visit https://tenor.com/view/free-nitro-gif-123',
  'https://github.com/org/repo/archive/refs/tags/v1.zip',
  'https://discord.js.org/docs',
  'https://discordbotlist.com/',
  'https://top.gg/bot/1',
  'https://mydiscordshop.example/',
  'https://www.example.com/page',
  'https://www.bahamut.com.tw/',
  'https://pcpartpicker.com/list/abc',
  'https://nitrotype.com/race',
  'https://www.ubuntu.com/download/desktop/ubuntu-24.04.iso',
  'http://localhost:3000/dashboard',
  'http://127.0.0.1:8080/x',
  'http://192.168.1.10/admin',
  'see https://bit.ly/3abc',
  'free nitro 詐騙很多，大家小心不要點',
  '有人說 Steam gift 要小心，不要亂領取',
  '恭喜你中獎了！（只是開玩笑）',
  'README.md 與 main.py 都改好了',
  'v1.1.2 版已發布，node.js 跟 package.json 都有更新',
  '我今天吃了一碗 1.5 倍的牛肉麵。很好吃',
  'email me at someone@example.com please',
  'the price is 3.99 and the file is archive.tar.gz',
  `plain text with a zero width${ZERO_WIDTH} space and ＡＢＣ full width letters`,
  '',
  '   ',
]);

test('every risky sample is found, with the reason it is meant for', () => {
  assert.ok(RISKY.length >= 50);
  for (const [text, reason] of RISKY) {
    const result = scanLinkRisk(text);
    assert.equal(result.risky, true, text);
    assert.ok(result.reasons.includes(reason), `${text}: ${JSON.stringify(result.reasons)}`);
    assert.equal(result.hasLink, true, text);
  }
});

test('no safe sample is risky: real places, ordinary links, talk about lures, dotted text and e-mail', () => {
  assert.ok(SAFE.length >= 50);
  for (const text of SAFE) {
    const result = scanLinkRisk(text);
    assert.equal(result.risky, false, `${text}: ${JSON.stringify(result.reasons)}`);
    assert.deepEqual(result.reasons, [], text);
  }
});

test('the answer holds fixed codes only and is frozen; hasLink tells whether the text has a link at all', () => {
  const codes = new Set(Object.values(R));
  const result = scanLinkRisk('free nitro https://dlscord-gift.com/claim?token=SECRET-TOKEN-1234');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.ok(result.reasons.every((code) => codes.has(code)));
  assert.equal(JSON.stringify(result).includes('SECRET-TOKEN'), false);
  assert.equal(JSON.stringify(result).includes('dlscord'), false);
  assert.deepEqual(Object.keys(result).sort(), ['hasLink', 'reasons', 'risky']);
  assert.equal(scanLinkRisk('今天天氣真好').hasLink, false);
  assert.equal(scanLinkRisk('看看 https://www.youtube.com/watch?v=1').hasLink, true);
  assert.equal(scanLinkRisk('discord.gg/abcd1234').hasLink, true);
  assert.equal(scanLinkRisk(undefined).risky, false);
  assert.equal(scanLinkRisk(null).hasLink, false);
  assert.equal(scanLinkRisk(12345).risky, false);
});

test('a lure phrase without a link, or with a link to a place everybody knows, is not risky', () => {
  for (const text of ['free nitro', '免費領取 nitro 禮物', '@everyone', 'verify your discord account',
    'free nitro https://discord.com/nitro', '@everyone https://github.com/org/repo', 'claim your prize https://www.youtube.com/watch?v=1']) {
    assert.equal(scanLinkRisk(text).risky, false, text);
  }
});

test('the official domains and their subdomains are never judged by the brand rules, in any letter case', () => {
  for (const host of ['discord.com', 'DISCORD.COM', 'support.discord.com', 'cdn.discordapp.com', 'discord.gg', 'dis.gd',
    'discordstatus.com', 'store.steampowered.com', 'steamcommunity.com', 'help.steampowered.com', 'www.roblox.com',
    'www.epicgames.com', 'www.paypal.com', 'www.twitch.tv']) {
    assert.equal(scanLinkRisk(`https://${host}/free-nitro/login`).risky, false, host);
    assert.equal(scanLinkRisk(`claim your prize https://${host}/x`).risky, false, host);
  }
  // The same words one label away from the official name are not official.
  for (const host of ['discord.com.example', 'xdiscord.com.evil.xyz']) {
    const result = scanLinkRisk(`https://${host}/x`);
    assert.equal(result.reasons.includes(R.BRAND_AS_SUBDOMAIN), host === 'discord.com.example', host);
  }
});

test('at most ten links are read, and a text is cut to its limit before anything is read', () => {
  const links = Array.from({ length: 30 }, (_, index) => `https://www.example.org/page${index}`).join(' ');
  const lure = `${links} https://dlscord.com/last`;
  // The lure is the 31st link: not read.
  assert.equal(scanLinkRisk(lure).risky, false);
  assert.equal(scanLinkRisk(`https://dlscord.com/first ${links}`).risky, true);
  assert.equal(MAX_URLS, 10);
  // A lure past the character limit is not read either.
  const padded = `${'好'.repeat(MAX_TEXT_LENGTH)}https://dlscord.com/gift`;
  assert.equal(scanLinkRisk(padded).risky, false);
  assert.equal(scanLinkRisk(`${'好'.repeat(100)}https://dlscord.com/gift`).risky, true);
});

test('osaDistance counts insertions, deletions, substitutions and swapped neighbours', () => {
  assert.equal(osaDistance('discord', 'discord'), 0);
  assert.equal(osaDistance('dlscord', 'discord'), 1);
  assert.equal(osaDistance('dicsord', 'discord'), 1);
  assert.equal(osaDistance('discorrd', 'discord'), 1);
  assert.equal(osaDistance('discord', 'disco'), 2);
  assert.equal(osaDistance('discord', 'dis'), 3);
  assert.equal(osaDistance('discard', 'discord'), 1);
});

// ---------------------------------------------------------------------------------------------------------
// Time: the scan stays linear, and nothing an attacker writes can make it hang.
// ---------------------------------------------------------------------------------------------------------

// A scan that backtracked without end could not be stopped from outside (the call is synchronous), so every timed call
// goes through vm.Script#runInContext with a time limit, which stops it and lets the case be named.
const STOP_AFTER_MS = 3_000;
const guardContext = vm.createContext({ run: null, text: '' });
const guardedCall = new vm.Script('run(text)');

function elapsedMs(run, text) {
  guardContext.run = run;
  guardContext.text = text;
  const start = process.hrtime.bigint();
  try {
    guardedCall.runInContext(guardContext, { timeout: STOP_AFTER_MS });
  } catch (error) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return Infinity;
    throw error;
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const fill = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const FUZZ_UNITS = Object.freeze([
  'https://', 'http://a.', 'a.', 'a-', 'xn--', '@', '@everyone ', 'free nitro ', '免費領取 ', 'www.', 'hxxps://', '...', '[(',
  'https://dis-cord.', 'discord', 'd1sc0rd.', '%2e%2f', '%', ZERO_WIDTH, '。', '：', 'a'.repeat(63) + '.', '1.', '0x',
  String.fromCodePoint(0xfdfa), 'https://x@', ':80', '/.exe', '　', '\n', '${', '))))', 'steam gift ', '恭喜你',
]);

test('every adversarial text finishes within the limit and stays fast, at the size of the limit and far over it', () => {
  for (const unit of FUZZ_UNITS) {
    for (const length of [1_000, MAX_TEXT_LENGTH, 100_000]) {
      const text = fill(unit, length);
      const ms = elapsedMs(scanLinkRisk, text);
      assert.ok(Number.isFinite(ms), `${JSON.stringify(unit)} x ${length}: no result within ${STOP_AFTER_MS} ms`);
      assert.ok(ms < 1_500, `${JSON.stringify(unit)} x ${length}: ${ms.toFixed(0)} ms`);
    }
  }
});

test('the work grows with the text no faster than the text does, up to the limit', () => {
  const MAX_GROWTH = 12;
  for (const unit of ['https://a.', 'free nitro https://x.', 'discord-', 'a.b.', '@everyone https://']) {
    const small = fill(unit, 1_000);
    const large = fill(unit, MAX_TEXT_LENGTH);
    let smallMs = Infinity;
    let largeMs = Infinity;
    for (let round = 0; round < 3; round += 1) {
      smallMs = Math.min(smallMs, elapsedMs(scanLinkRisk, small));
      largeMs = Math.min(largeMs, elapsedMs(scanLinkRisk, large));
    }
    assert.ok(Number.isFinite(largeMs), unit);
    // The limit is 4 times the small size; a quadratic scan would show 16 or more. Fast runs always pass.
    assert.ok(largeMs < 50 || largeMs / Math.max(smallMs, 1) < MAX_GROWTH, `${unit}: ${smallMs.toFixed(1)} -> ${largeMs.toFixed(1)} ms`);
  }
});

test('the scanner opens no connection and never throws, whatever the input', () => {
  const originalFetch = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = () => { touched += 1; throw new Error('no network in the scanner'); };
  try {
    for (const value of [undefined, null, 0, {}, [], Symbol.iterator.toString(), '\u0000', '\ud800', 'https://\ud800.com/', 'https://:@/',
      'https://[', 'https://%zz.com/', 'https://' + 'a'.repeat(5_000) + '.com', '@'.repeat(5_000)]) {
      assert.doesNotThrow(() => scanLinkRisk(value));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(touched, 0);
});

test('known limit: a seven-letter brand name two letters off is not caught (only one off, or twelve letters and over, are)', () => {
  assert.equal(scanLinkRisk('https://discorcl.com/login').risky, false);
  assert.equal(osaDistance('discorcl', 'discord'), 2);
  assert.equal(scanLinkRisk('https://dlscord.com/login').risky, true);
  assert.equal(scanLinkRisk('https://steamcommunnity.com/login').risky, true);
});
