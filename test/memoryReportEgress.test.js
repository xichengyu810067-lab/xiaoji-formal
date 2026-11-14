'use strict';

// The weekly memory report (src/platform/memoryReportFile.js) is the one HTML file the request boundary admits, and
// only from the weeklyMemoryReport hook, to the direct-message channel that hook has just opened with the owner, once.
// Every other channel, hook, command, file kind, size or markup is refused.

const test = require('node:test');
const assert = require('node:assert/strict');

const { installEgressGuard } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { claimExtensionContextRunner } = require('../src/platform/extensionContext');
const {
  MEMORY_REPORT_CSP,
  MEMORY_REPORT_HOOK_NAME,
  MEMORY_REPORT_MAX_BYTES,
  escapeHtml,
  isInertReportHtml,
} = require('../src/platform/memoryReportFile');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

const OWNER_ID = '45678901234567890';
const OTHER_USER_ID = '56789012345678901';
const DM_CHANNEL_ID = '67890123456789012';
const OTHER_DM_CHANNEL_ID = '67890123456789013';
const GUILD_CHANNEL_ID = '12345678901234567';
const GUILD_ID = '23456789012345678';
const MESSAGE_ID = '34567890123456789';
const NAME = 'xiaoji-memory-report-20261113.html';
const runner = claimExtensionContextRunner();

function reportHtml(body = '<p>成員：喜歡拉麵</p>', { csp = true, style = 'body{color:#222}' } = {}) {
  return [
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
    csp ? `<meta http-equiv="Content-Security-Policy" content="${MEMORY_REPORT_CSP}">` : '',
    `<title>報告</title><style>${style}</style></head><body><main>${body}</main></body></html>`,
  ].join('');
}

// A guarded synthetic REST that answers a direct-message channel for any recipient (OTHER_USER_ID's channel has its
// own id) and a message for any channel; every request that reached the transport is recorded.
function transport({ ownerId = OWNER_ID, now = () => 1_000_000 } = {}) {
  const sent = [];
  const rest = createSyntheticRest({
    post(route, request) {
      sent.push({ route, ...request });
      if (route === '/users/@me/channels') {
        const recipient = request.body.recipient_id;
        return { id: recipient === OWNER_ID ? DM_CHANNEL_ID : OTHER_DM_CHANNEL_ID, type: 1, recipients: [{ id: recipient }] };
      }
      return { id: MESSAGE_ID };
    },
  });
  const guard = installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], ownerId,
    resolveChannelGuild: (id) => (id === GUILD_CHANNEL_ID ? GUILD_ID : null), monotonicNow: now,
  });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  return { rest, sent };
}

function inHook(name, fn) {
  return runner.run({ extensionId: 'test-extension', entry: 'hook', name }, fn);
}

function inCommand(fn) {
  return runner.run({
    extensionId: 'test-extension', entry: 'command', name: 'synthetic.execute', sourceGuildId: GUILD_ID,
    actorId: OWNER_ID, interactionId: '78901234567890123', interactionToken: 'token',
  }, fn);
}

function openDm(rest, recipient = OWNER_ID) {
  return rest.request({ method: 'POST', fullRoute: '/users/@me/channels', body: { recipient_id: recipient } });
}

function upload(rest, { channelId = DM_CHANNEL_ID, files, body } = {}) {
  return rest.request({
    method: 'POST',
    fullRoute: `/channels/${channelId}/messages`,
    body: body || { content: '每週記憶報告', allowed_mentions: { parse: [] } },
    files: files || [{ name: NAME, data: Buffer.from(reportHtml(), 'utf8') }],
  });
}

const refused = { code: 'EGRESS_UNINSPECTABLE_FILE' };

test('the report hook sends its one inert HTML file to the direct-message channel it opened with the owner', async () => {
  const { rest, sent } = transport();
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    await upload(rest);
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].route, `/channels/${DM_CHANNEL_ID}/messages`);
  assert.equal(sent[1].files.length, 1);
  assert.equal(sent[1].files[0].name, NAME);
  assert.equal(sent[1].files[0].type, 'text/html; charset=utf-8');
  assert.equal(sent[1].files[0].data.toString('utf8'), reportHtml());
});

test('the channel takes one report: a second upload needs a channel opened again', async () => {
  const { rest, sent } = transport();
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    await upload(rest);
    await assert.rejects(upload(rest), refused);
    await openDm(rest);
    await upload(rest);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 2);
});

test('the report goes nowhere else: another channel, a guild channel, or a channel opened with someone else', async () => {
  const { rest, sent } = transport();
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    // Nothing opened yet.
    await assert.rejects(upload(rest), refused);
    await openDm(rest, OTHER_USER_ID);
    await assert.rejects(upload(rest, { channelId: OTHER_DM_CHANNEL_ID }), refused);
    await openDm(rest);
    await assert.rejects(upload(rest, { channelId: GUILD_CHANNEL_ID }), refused);
    await assert.rejects(upload(rest, { channelId: OTHER_DM_CHANNEL_ID }), refused);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 0);
});

test('a channel the hook opened expires after ten minutes', async () => {
  let now = 1_000_000;
  const { rest, sent } = transport({ now: () => now });
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    now += 10 * 60 * 1000;
    await assert.rejects(upload(rest), refused);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 0);
});

test('no other hook, command, or code outside an extension may send the report, even to the owner\'s channel', async () => {
  const { rest, sent } = transport();
  // The channel a ready hook opens is not a report channel, and the ready hook may not upload either.
  await inHook('hooks.ready', async () => {
    await openDm(rest);
    await assert.rejects(upload(rest), refused);
  });
  // A channel the report hook opened is still refused to everyone but that hook.
  await inHook(MEMORY_REPORT_HOOK_NAME, () => openDm(rest));
  await inHook('hooks.featureStatusChanged', () => assert.rejects(upload(rest), refused));
  await inHook('hooks.conversationBlocked', () => assert.rejects(upload(rest), refused));
  await inCommand(() => assert.rejects(upload(rest), refused));
  await assert.rejects(upload(rest), refused);
  assert.equal(sent.filter((call) => call.files?.length).length, 0);
});

test('without a configured owner the report hook uploads nothing', async () => {
  const { rest, sent } = transport({ ownerId: null });
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    await assert.rejects(upload(rest), refused);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 0);
});

test('the report hook sends no other file kind, name, type, count or size', async () => {
  const { rest, sent } = transport();
  const html = Buffer.from(reportHtml(), 'utf8');
  const cases = [
    [{ name: 'report.txt', data: Buffer.from('text') }],
    [{ name: 'xiaoji-memory-report-20261113.txt', data: Buffer.from('text') }],
    [{ name: 'xiaoji-memory-report-20261113.json', data: Buffer.from('{}') }],
    [{ name: 'xiaoji-memory-report-20261113.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
    [{ name: 'xiaoji-memory-report-20261113.htm', data: html }],
    [{ name: 'xiaoji-memory-report-20261113.HTML', data: html }],
    [{ name: 'report.html', data: html }],
    [{ name: 'xiaoji-memory-report-2026.html', data: html }],
    [{ name: '../xiaoji-memory-report-20261113.html', data: html }],
    [{ name: NAME, data: html, contentType: 'text/plain' }],
    [{ name: NAME, data: html, contentType: 'application/xhtml+xml' }],
    [{ name: NAME, data: html }, { name: 'xiaoji-memory-report-20261114.html', data: html }],
    [{ name: NAME, data: Buffer.from([0xff, 0xfe, 0x00]) }],
    [{ name: NAME, data: Buffer.from(reportHtml(`<p>${'a'.repeat(MEMORY_REPORT_MAX_BYTES)}</p>`), 'utf8') }],
  ];
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    for (const files of cases) {
      await assert.rejects(upload(rest, { files }), refused, files.map((file) => file.name).join(','));
    }
    // A refused upload does not use up the channel: the report itself still goes.
    await upload(rest);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 1);
});

test('the report message carries no embed, component, sticker, poll or reference', async () => {
  const { rest, sent } = transport();
  const bodies = [
    { content: 'x', embeds: [{ description: 'y' }] },
    { content: 'x', components: [{ type: 1, components: [] }] },
    { content: 'x', sticker_ids: ['89012345678901234'] },
    { content: 'x', poll: { question: { text: 'q' }, answers: [] } },
    { content: 'x', message_reference: { message_id: MESSAGE_ID } },
  ];
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    for (const body of bodies) {
      await assert.rejects(upload(rest, { body }), refused, Object.keys(body).join(','));
    }
    await upload(rest);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 1);
});

test('markup that is not inert is refused whole', async () => {
  const { rest, sent } = transport();
  const documents = [
    reportHtml('<script>alert(1)</script>'),
    reportHtml('<SCRIPT>alert(1)</SCRIPT>'),
    reportHtml('<p onclick="alert(1)">x</p>'),
    reportHtml('<p class="a" onclick="x">x</p>'),
    reportHtml('<a href="https://evil.example/">x</a>'),
    reportHtml('<img src="x">'),
    reportHtml('<iframe></iframe>'),
    reportHtml('<svg><script>1</script></svg>'),
    reportHtml('<!-- comment -->'),
    reportHtml('<p style="color:red">x</p>'),
    reportHtml('<p>unclosed'),
    reportHtml('<p>a < b</p>'),
    reportHtml('<p>x</p>', { csp: false }),
    reportHtml('<p>x</p>', { style: 'body{background:url(https://evil.example/x)}' }),
    reportHtml('<p>x</p>', { style: '@import "x.css";' }),
    reportHtml('<p>x</p>', { style: 'body{background:u\\72l(x)}' }),
    reportHtml('<p>x</p>').replace('<head>', '<head><meta http-equiv="refresh" content="0">'),
    reportHtml('<p>x</p>').replace('<head>', '<head><base href="https://evil.example/">'),
    reportHtml('<p>x</p>').replace('<!doctype html>', ''),
    `${reportHtml('<p>x</p>')}<meta http-equiv="Content-Security-Policy" content="${MEMORY_REPORT_CSP}">`,
  ];
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    for (const html of documents) {
      await assert.rejects(upload(rest, { files: [{ name: NAME, data: Buffer.from(html, 'utf8') }] }), refused, html);
    }
    await upload(rest);
  });
  assert.equal(sent.filter((call) => call.files?.length).length, 1);
});

test('links in the report text are replaced like any outgoing text, and the report stays inert', async () => {
  const { rest, sent } = transport();
  await inHook(MEMORY_REPORT_HOOK_NAME, async () => {
    await openDm(rest);
    await upload(rest, { files: [{ name: NAME, data: Buffer.from(reportHtml('<p>看 https://evil.example/x</p>'), 'utf8') }] });
  });
  const delivered = sent[1].files[0].data.toString('utf8');
  assert.match(delivered, /看 \[連結已移除\]/u);
  assert.ok(isInertReportHtml(delivered));
});

test('HTML is never admitted outside the report hook', async () => {
  const { rest, sent } = transport();
  const files = [{ name: NAME, data: Buffer.from(reportHtml(), 'utf8') }];
  await assert.rejects(upload(rest, { channelId: GUILD_CHANNEL_ID, files }), refused);
  await inCommand(() => assert.rejects(rest.request({
    method: 'POST', fullRoute: '/interactions/78901234567890123/token/callback',
    body: { type: 4, data: { content: 'x' } }, files,
  }), refused));
  assert.equal(sent.length, 0);
});

test('escapeHtml leaves no markup, quote or attribute sign of a member text', () => {
  const hostile = '<script>alert("x")</script> onclick=\'y\' `z` & </p>';
  const escaped = escapeHtml(hostile);
  assert.doesNotMatch(escaped, /[<>"'=`]/u);
  assert.ok(isInertReportHtml(reportHtml(`<p>${escaped}</p>`)));
});
