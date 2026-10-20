'use strict';

// Where the link-risk rules meet the optional Jev second opinion and the security alert. The monitor is run with the
// real scanner and a recording `report`; the second opinion is a recording stand-in, or the real jevClient on a fake
// transport and fake timers.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createJevClient, parseJevConfig } = require('../src/systems/conversation/jevClient');
const { inspectMessageLinkRisk } = require('../src/systems/conversation/linkRiskMonitor');
const { runWithHostOperationContext, getHostOperationContext } = require('../src/platform/hostOperationContext');

const GUILD = '111111111111111111';
const OTHER_GUILD = '121212121212121212';
const CHANNEL = '222222222222222222';
const ACTOR = '555555555555555555';
const MESSAGE_ID = '333333333333333333';
const LURE = 'free nitro https://dlscord-gift.com/claim';
const PLAIN_LINK = '看這個 https://www.example.org/article/1 很有趣';

function message(overrides = {}) {
  return {
    id: MESSAGE_ID,
    content: PLAIN_LINK,
    author: { id: ACTOR, bot: false },
    guildId: GUILD,
    guild: { name: '測試群組' },
    channelId: CHANNEL,
    ...overrides,
  };
}

function recorders() {
  const reports = [];
  const logs = [];
  return {
    reports,
    logs,
    options: {
      report: (kind, place) => reports.push({ kind, place, host: getHostOperationContext() }),
      loggerImpl: { info: (line) => logs.push(line) },
    },
  };
}

// A stand-in for the second opinion that records every call.
function fakeRuntime(mode, answer, { guildIds = [GUILD], linkRisk = true } = {}) {
  const calls = [];
  return {
    calls,
    config: Object.freeze({ mode, linkRisk, guildIds: Object.freeze(guildIds) }),
    judgeLinkRisk: (input) => {
      calls.push(input);
      return typeof answer === 'function' ? answer(input) : Promise.resolve(answer);
    },
  };
}

const RISKY_ANSWER = { ok: true, safe: false };
const SAFE_ANSWER = { ok: true, safe: true };

test('only a message in a server from a member is read: not a direct message, a bot, a webhook, a system message, an empty or short one', () => {
  const { reports, options } = recorders();
  let scans = 0;
  const scan = () => { scans += 1; return { risky: true, reasons: ['x'], hasLink: true }; };
  for (const odd of [{ guildId: null }, { author: { id: ACTOR, bot: true } }, { webhookId: '9' }, { system: true },
    { content: '' }, { content: 'hi' }, { content: undefined }, { content: 42 }, { author: null }]) {
    const result = inspectMessageLinkRisk(message(odd), { ...options, scan, runtime: null });
    assert.equal(result.scanned, false, JSON.stringify(odd));
  }
  assert.equal(scans, 0);
  assert.deepEqual(reports, []);
  assert.equal(inspectMessageLinkRisk(null, options).scanned, false);
});

test('a lure found by the rules raises one link-risk alert at once, with the place and the member and nothing else', () => {
  const { reports, options } = recorders();
  const runtime = fakeRuntime('enforce', RISKY_ANSWER);
  const result = inspectMessageLinkRisk(message({ content: LURE }), { ...options, runtime });
  assert.equal(result.risky, true);
  assert.equal(result.settled, null);
  assert.deepEqual(reports.map(({ kind, place }) => [kind, place]), [['link-risk', {
    guildId: GUILD, guildName: '測試群組', actorId: ACTOR, channelId: CHANNEL, messageId: MESSAGE_ID,
  }]]);
  assert.equal(JSON.stringify(reports).includes('dlscord'), false, 'no text of the message goes with the alert');
  assert.equal(runtime.calls.length, 0, 'the second opinion is not asked when the rules already decided');
});

test('a message that has no dot, no :// and no www is not scanned at all; anything that could hold an address is', () => {
  const { reports, options } = recorders();
  const scanned = [];
  const scan = (text) => { scanned.push(text); return { risky: false, reasons: [], hasLink: false }; };
  for (const plain of ['今天晚上一起打遊戲嗎？很久沒有玩了', 'hello everyone, how are you', '@everyone 晚上八點集合', 'free nitro for you',
    'discord gg slash abc', '哈哈哈哈哈哈哈哈']) {
    const result = inspectMessageLinkRisk(message({ content: plain }), { ...options, scan, runtime: null });
    assert.equal(result.scanned, false, plain);
  }
  assert.deepEqual(scanned, []);
  for (const maybe of ['version 3.5 is out', 'see example.com', 'https://a', 'www x', 'ＷＷＷ x', 'ｈｔｔｐｓ：／／ｘ', 'disc0rd。com', '看ｅｘａｍｐｌｅ．ｃｏｍ']) {
    inspectMessageLinkRisk(message({ content: maybe }), { ...options, scan, runtime: null });
  }
  assert.equal(scanned.length, 8);
  // The check reads the text before it is folded, and a link written full width still gets to the rules.
  inspectMessageLinkRisk(message({ content: 'ｈｔｔｐｓ：／／ｄｉｓｃ０ｒｄ．ｃｏｍ／ｌｏｇｉｎ' }), { ...options, runtime: null });
  assert.equal(reports.length, 1);
});

test('a message without a link is read by the rules and goes nowhere else', () => {
  const { reports, options } = recorders();
  const runtime = fakeRuntime('enforce', RISKY_ANSWER);
  const result = inspectMessageLinkRisk(message({ content: '今天看了 3.5 版的更新說明，很多改動' }), { ...options, runtime });
  assert.deepEqual([result.scanned, result.risky, result.settled], [true, false, null]);
  assert.deepEqual(reports, []);
  assert.equal(runtime.calls.length, 0);
});

test('with the second opinion off, or not set up for this server, nothing is asked and nothing is sent', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('no network'); };
  try {
    const base = { JEV_API_KEY: 'k'.repeat(24), JEV_GUILD_IDS: GUILD, JEV_POLICY_ACK: 'yes', JEV_LINK_RISK: 'yes' };
    const environments = {
      'mode off': { ...base, JEV_MODE: 'off' },
      'mode missing': { ...base },
      'acknowledgement missing': { ...base, JEV_MODE: 'enforce', JEV_POLICY_ACK: undefined },
      'acknowledgement wrong': { ...base, JEV_MODE: 'enforce', JEV_POLICY_ACK: 'no' },
      'no key': { ...base, JEV_MODE: 'enforce', JEV_API_KEY: undefined },
      'no servers': { ...base, JEV_MODE: 'enforce', JEV_GUILD_IDS: undefined },
      // Everything else is set up, but the owner has not opted in to sending server messages for this use.
      'link risk opt-in missing (shadow)': { ...base, JEV_MODE: 'shadow', JEV_LINK_RISK: undefined },
      'link risk opt-in missing (enforce)': { ...base, JEV_MODE: 'enforce', JEV_LINK_RISK: undefined },
      'link risk opt-in empty': { ...base, JEV_MODE: 'enforce', JEV_LINK_RISK: '' },
      'link risk opt-in not yes': { ...base, JEV_MODE: 'enforce', JEV_LINK_RISK: 'true' },
    };
    for (const [label, env] of Object.entries(environments)) {
      const runtime = createJevClient({ config: parseJevConfig(env, { loggerImpl: null, warned: new Set() }), fetchImpl: fetch });
      const { reports, options } = recorders();
      const result = inspectMessageLinkRisk(message(), { ...options, runtime });
      assert.equal(result.settled, null, label);
      assert.deepEqual(reports, [], label);
    }
    // Set up, but for another server.
    const runtime = createJevClient({
      config: parseJevConfig({ ...base, JEV_MODE: 'enforce', JEV_GUILD_IDS: OTHER_GUILD }, { loggerImpl: null, warned: new Set() }),
      fetchImpl: fetch,
    });
    const { reports, options } = recorders();
    assert.equal(inspectMessageLinkRisk(message(), { ...options, runtime }).settled, null);
    assert.deepEqual(reports, []);
    // A stand-in without the link-risk opt-in is not asked either.
    const optedOut = fakeRuntime('enforce', RISKY_ANSWER, { linkRisk: false });
    assert.equal(inspectMessageLinkRisk(message(), { ...options, runtime: optedOut }).settled, null);
    assert.equal(optedOut.calls.length, 0);
    // A stand-in whose mode is "off", or with no judge function, is not asked either.
    const off = fakeRuntime('off', RISKY_ANSWER);
    assert.equal(inspectMessageLinkRisk(message(), { ...options, runtime: off }).settled, null);
    assert.equal(off.calls.length, 0);
    assert.equal(inspectMessageLinkRisk(message(), { ...options, runtime: { config: { mode: 'enforce', linkRisk: true, guildIds: [GUILD] } } }).settled, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0, 'not one network call');
});

test('with the opt-in given, a real client is asked with the redacted message text, and with it missing no request is made at all', async () => {
  const requests = [];
  const env = { JEV_MODE: 'shadow', JEV_API_KEY: 'k'.repeat(24), JEV_GUILD_IDS: GUILD, JEV_POLICY_ACK: 'yes' };
  const answer = { ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ answers: { phishing_or_malware: { type: 'noul', noul: 0.01 }, counterfeit_policy: { type: 'noul', noul: 0.01 } } }) };
  const client = (extra) => createJevClient({
    config: parseJevConfig({ ...env, ...extra }, { loggerImpl: null, warned: new Set() }),
    fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return answer; },
    loggerImpl: { warn() {}, info() {} },
  });
  const { logs, options } = recorders();
  await inspectMessageLinkRisk(message({ content: 'see https://www.example.org/a?token=SECRET&x=1 and <@555555555555555555>' }),
    { ...options, runtime: client({}) }).settled;
  assert.deepEqual(requests, [], 'no opt-in, no request');
  assert.deepEqual(logs, []);
  await inspectMessageLinkRisk(message({ content: 'see https://www.example.org/a?token=SECRET&x=1 and <@555555555555555555>' }),
    { ...options, runtime: client({ JEV_LINK_RISK: 'yes' }) }).settled;
  assert.equal(requests.length, 1);
  const sent = JSON.stringify(requests[0].state);
  assert.equal(sent.includes('SECRET'), false, 'the value of a query parameter does not leave');
  assert.equal(sent.includes('555555555555555555'), false, 'the mention does not leave');
  assert.deepEqual(logs, ['[JEV_SHADOW] kind=link verdict=safe']);
});

test('shadow mode only logs the verdict: risky, safe, a failure and a throw change nothing', async () => {
  for (const [answer, verdict] of [[RISKY_ANSWER, 'risky'], [SAFE_ANSWER, 'safe'], [{ ok: false, reason: 'timeout' }, 'error'],
    [() => { throw new Error('boom'); }, 'error'], [() => Promise.reject(new Error('boom')), 'error']]) {
    const { reports, logs, options } = recorders();
    const runtime = fakeRuntime('shadow', answer);
    const result = inspectMessageLinkRisk(message(), { ...options, runtime });
    assert.equal(result.risky, false);
    await result.settled;
    assert.equal(runtime.calls.length, 1);
    assert.deepEqual(logs, [`[JEV_SHADOW] kind=link verdict=${verdict}`]);
    assert.deepEqual(reports, [], verdict);
  }
});

test('enforce mode raises the alert only for a risky verdict; safe, failed and thrown verdicts leave the rules\' answer', async () => {
  for (const [answer, verdict, alerts] of [[RISKY_ANSWER, 'risky', 1], [SAFE_ANSWER, 'safe', 0], [{ ok: false, reason: 'busy' }, 'error', 0],
    [{ ok: true }, 'risky', 1], [null, 'error', 0], [() => { throw new Error('boom'); }, 'error', 0],
    [() => Promise.reject(new Error('boom')), 'error', 0]]) {
    const { reports, logs, options } = recorders();
    const runtime = fakeRuntime('enforce', answer);
    const result = inspectMessageLinkRisk(message(), { ...options, runtime });
    assert.equal(result.risky, false, 'the rules\' own answer is returned at once');
    await result.settled;
    assert.deepEqual(logs, [`[JEV_ENFORCE] kind=link verdict=${verdict}`]);
    assert.equal(reports.length, alerts, verdict);
    if (alerts) assert.deepEqual(reports[0].place, { guildId: GUILD, guildName: '測試群組', actorId: ACTOR, channelId: CHANNEL, messageId: MESSAGE_ID });
  }
});

test('the second opinion gets the message text and is asked once per message, only when the rules found a link and no lure', async () => {
  const { options } = recorders();
  const runtime = fakeRuntime('shadow', SAFE_ANSWER);
  await inspectMessageLinkRisk(message(), { ...options, runtime }).settled;
  assert.deepEqual(runtime.calls, [{ text: PLAIN_LINK }]);
  await inspectMessageLinkRisk(message({ content: 'discord.gg/abcd1234' }), { ...options, runtime }).settled;
  assert.equal(runtime.calls.length, 2);
  await inspectMessageLinkRisk(message({ content: LURE }), { ...options, runtime }).settled;
  await inspectMessageLinkRisk(message({ content: '沒有任何連結的一句話' }), { ...options, runtime }).settled;
  assert.equal(runtime.calls.length, 2);
});

test('the answer of the second opinion is handled inside the host operation of the message, so the alert has its source', async () => {
  const { reports, options } = recorders();
  const runtime = fakeRuntime('enforce', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return RISKY_ANSWER;
  });
  const context = { sourceEventId: MESSAGE_ID, actorId: ACTOR, guildId: GUILD, channelId: CHANNEL, hostPurpose: 'discord.message',
    scope: `guild:${GUILD}:channel:${CHANNEL}` };
  const settled = runWithHostOperationContext(context, () => inspectMessageLinkRisk(message(), { ...options, runtime }).settled);
  // Outside the operation, later: the alert is raised after the call has returned.
  assert.equal(reports.length, 0);
  await settled;
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].host, context);
});

test('handling the message does not wait for the second opinion: with the real client and a transport that never answers, it returns at once', async () => {
  const timers = [];
  const fetchCalls = [];
  const config = parseJevConfig({
    JEV_MODE: 'enforce', JEV_API_KEY: 'k'.repeat(24), JEV_GUILD_IDS: GUILD, JEV_POLICY_ACK: 'yes', JEV_LINK_RISK: 'yes', JEV_TIMEOUT_MS: '1000',
  }, { loggerImpl: null, warned: new Set() });
  const runtime = createJevClient({
    config,
    fetchImpl: (url, init) => { fetchCalls.push({ url, body: JSON.parse(init.body) }); return new Promise(() => {}); },
    setTimeoutImpl: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutImpl: () => {},
    loggerImpl: { warn() {}, info() {} },
  });
  const { reports, logs, options } = recorders();
  const handler = async (incoming) => { inspectMessageLinkRisk(incoming, { ...options, runtime }); return 'handled'; };
  let finished = false;
  const run = handler(message()).then((value) => { finished = value === 'handled'; });
  await run;
  assert.equal(finished, true, 'the handler finished while the second opinion had not answered');
  // Let the call start, then show it is still waiting.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  assert.deepEqual(reports, []);
  assert.deepEqual(logs, []);
  // The text that leaves is the redacted message, not a link with its query values.
  assert.equal(JSON.stringify(fetchCalls[0].body.state).includes(ACTOR), false);
  // The deadline passes: the verdict is "error" (timeout), nothing is raised.
  timers[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(logs, ['[JEV_ENFORCE] kind=link verdict=error']);
  assert.deepEqual(reports, []);
});

test('a flood of lures is one alert per message here and left to the notifier to merge; the rules do not remember', () => {
  const { reports, options } = recorders();
  for (let index = 0; index < 60; index += 1) {
    inspectMessageLinkRisk(message({ id: String(333333333333333400n + BigInt(index)), content: LURE }), { ...options, runtime: null });
  }
  assert.equal(reports.length, 60);
  assert.ok(reports.every((entry) => entry.kind === 'link-risk'));
});
