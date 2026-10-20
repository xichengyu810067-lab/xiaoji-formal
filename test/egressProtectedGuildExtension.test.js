'use strict';

// What a verified private extension may do in a protected guild at the request boundary: upload one
// small text file in the answer to its own command, and manage the guild within the protected-guild
// budgets. The extension contexts are synthetic, opened with the runner the extension host would use;
// no private code is loaded and nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { AttachmentBuilder, MessagePayload, Options, Routes } = require('discord.js');

const { installEgressGuard } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { installProtectedRest } = require('../src/platform/protectedRest');
const { claimExtensionContextRunner } = require('../src/platform/extensionContext');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

const GUILD_ID = '23456789012345678';
const OTHER_GUILD_ID = '78901234567890123';
const CHANNEL_ID = '12345678901234567';
const SECOND_CHANNEL_ID = '12345678901234568';
const OTHER_CHANNEL_ID = '12345678901234569';
const MESSAGE_ID = '34567890123456789';
const USER_ID = '45678901234567890';
const ROLE_ID = '56789012345678900';
const APPLICATION_ID = '67890123456789012';
const INTERACTION_ID = '56789012345678901';
const OTHER_INTERACTION_ID = '56789012345678902';
// Mixed case on purpose: the boundary reads routes in lower case.
const INTERACTION_TOKEN = 'aW50ZXJhY3Rpb24-Synthetic_Token.XyZ';
const OTHER_TOKEN = 'aW50ZXJhY3Rpb24-Other_Token.XyZ';
const MIB = 1024 * 1024;
const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SYNTHETIC_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
const UNINSPECTABLE = { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' };
const ADMITTED = { allowed: true };

const runner = claimExtensionContextRunner();
const CHANNEL_GUILDS = new Map([[CHANNEL_ID, GUILD_ID], [SECOND_CHANNEL_ID, GUILD_ID], [OTHER_CHANNEL_ID, OTHER_GUILD_ID]]);

// Runs fn in a synthetic extension context. A command records the interaction it runs for, as the host does.
function inExtension(fn, {
  entry = 'command', sourceGuildId = GUILD_ID, actorId = USER_ID,
  interactionId = INTERACTION_ID, interactionToken = INTERACTION_TOKEN,
} = {}) {
  return runner.run({
    extensionId: 'synthetic-extension', entry, name: `synthetic.${entry}`, sourceGuildId, actorId, interactionId, interactionToken,
  }, fn);
}

function exportFile(fields = {}) {
  return { name: 'settings-export.json', data: Buffer.from('{"enabled":true}\n', 'utf8'), ...fields };
}

function callback(files, { interactionId = INTERACTION_ID, token = INTERACTION_TOKEN, body } = {}) {
  return {
    method: 'POST', fullRoute: `/interactions/${interactionId}/${token}/callback`, files,
    body: body || { type: 4, data: { content: 'exported', flags: 64, attachments: [{ id: '0' }] } },
  };
}

function followUp(files, token = INTERACTION_TOKEN) {
  return { method: 'POST', fullRoute: `/webhooks/${APPLICATION_ID}/${token}`, body: { content: 'exported' }, files };
}

function editReply(files, { token = INTERACTION_TOKEN, message = '@original' } = {}) {
  return { method: 'PATCH', fullRoute: `/webhooks/${APPLICATION_ID}/${token}/messages/${message}`, body: { content: 'exported' }, files };
}

function previewGuard() {
  const rest = createSyntheticRest({ post() { throw new Error('preflight must not send'); } });
  return installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], resolveChannelGuild: (id) => CHANNEL_GUILDS.get(id) ?? null,
  });
}

test('a verified extension command uploads one small text file in the answer to its own interaction', () => {
  const guard = previewGuard();
  const check = (request) => inExtension(() => guard.preflight(request));

  // The initial response, a follow-up, and an edit of the original response or of a follow-up.
  assert.deepEqual(check(callback([exportFile()])), ADMITTED);
  assert.deepEqual(check(followUp([exportFile()])), ADMITTED);
  assert.deepEqual(check(editReply([exportFile()])), ADMITTED);
  assert.deepEqual(check(editReply([exportFile()], { message: MESSAGE_ID })), ADMITTED);
  // .json, .txt or .csv, as bytes or as a string, with a matching type or none, up to 1 MiB.
  assert.deepEqual(check(callback([exportFile({ contentType: 'application/json' })])), ADMITTED);
  assert.deepEqual(check(callback([{ name: 'members.csv', data: 'id,name\n1,Alpha\n', contentType: 'text/csv' }])), ADMITTED);
  assert.deepEqual(check(callback([{ name: 'report.txt', data: Buffer.from('ok\n'), contentType: 'text/plain; charset=utf-8' }])), ADMITTED);
  assert.deepEqual(check(callback([exportFile({ data: Buffer.alloc(MIB, 'a') })])), ADMITTED);
  assert.deepEqual(check(callback([exportFile({ data: 'a'.repeat(MIB) })])), ADMITTED);
  assert.deepEqual(check(callback([exportFile()], {
    body: { type: 4, data: { content: 'x', attachments: [{ id: '0', filename: 'renamed.json' }] } },
  })), ADMITTED);
  // No file is no upload at all.
  assert.deepEqual(check(callback([])), ADMITTED);
});

test('an extension upload is refused for any other file, size, count or name', () => {
  const guard = previewGuard();
  const check = (files, body) => inExtension(() => guard.preflight(callback(files, { body })));

  assert.deepEqual(check([exportFile(), exportFile({ name: 'second.json' })]), UNINSPECTABLE);
  assert.deepEqual(check([exportFile({ data: Buffer.alloc(MIB + 1, 'a') })]), UNINSPECTABLE);
  assert.deepEqual(check([exportFile({ data: 'a'.repeat(MIB + 1) })]), UNINSPECTABLE);
  // A text file whose replaced links make it larger than the limit.
  assert.deepEqual(check([exportFile({ data: 'http://a '.repeat(MIB / 8) })]), UNINSPECTABLE);
  // The public kinds are not the extension's: an image is refused.
  assert.deepEqual(check([{ name: 'panel.png', data: SYNTHETIC_PNG }]), UNINSPECTABLE);
  assert.deepEqual(check([exportFile({ contentType: 'text/html' })]), UNINSPECTABLE);
  assert.deepEqual(check([exportFile({ contentType: 'text/plain' })]), UNINSPECTABLE);
  assert.deepEqual(check([exportFile({ data: Buffer.from([0xc3, 0x28]) })]), UNINSPECTABLE);
  assert.deepEqual(check([exportFile({ description: 'x' })]), UNINSPECTABLE);
  for (const name of ['', 'a', '.json', 'json', '../a.json', 'dir/a.json', 'dir\\a.json', 'a\u0000.json', 'a\n.json',
    'a .json', 'a..json', '.hidden.json', 'a.JSON', 'a.json.exe', 'a.exe', 'a.html', 'a.js', 'a.png', 'a.svg', 'é.json',
    `${'a'.repeat(124)}.json`, 7]) {
    assert.deepEqual(check([exportFile({ name })]), UNINSPECTABLE, JSON.stringify(name));
  }
  assert.deepEqual(check([exportFile({ name: `${'a'.repeat(123)}.json` })]), ADMITTED);
  // The body cannot rename the upload to a name the extension could not upload.
  for (const filename of ['a.exe', '../a.json', 'panel.png', 'a.html']) {
    assert.deepEqual(check([exportFile()], { type: 4, data: { content: 'x', attachments: [{ id: '0', filename }] } }),
      UNINSPECTABLE, filename);
  }
  // Form-field bodies are not inspected.
  assert.deepEqual(inExtension(() => guard.preflight({ ...callback([exportFile()]), appendToFormData: true })), UNINSPECTABLE);
});

test('a follow-up or an edit may rename the extension upload only to a name the extension could upload', () => {
  const guard = previewGuard();
  const renamed = (request, filename) => inExtension(() => guard.preflight({
    ...request, body: { content: 'exported', attachments: [{ id: '0', filename }] },
  }));
  const routes = [
    ['a follow-up', followUp([exportFile()])],
    ['an edit of the original response', editReply([exportFile()])],
    ['an edit of a follow-up', editReply([exportFile()], { message: MESSAGE_ID })],
  ];
  for (const [label, request] of routes) {
    for (const filename of ['renamed.json', 'members.v2.csv', 'report.txt']) {
      assert.deepEqual(renamed(request, filename), ADMITTED, `${label}: ${filename}`);
    }
    for (const filename of ['a.exe', '../a.json', 'dir/a.json', 'a..json', 'a.JSON', 'panel.png', 'a.html', '.json',
      `${'a'.repeat(124)}.json`]) {
      assert.deepEqual(renamed(request, filename), UNINSPECTABLE, `${label}: ${filename}`);
    }
  }
});

test('an extension upload is refused anywhere but the answer to its own command in a protected guild', () => {
  const guard = previewGuard();
  const files = [exportFile()];
  // Another interaction, another token, or a message route.
  assert.deepEqual(inExtension(() => guard.preflight(callback(files, { interactionId: OTHER_INTERACTION_ID }))), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight(callback(files, { token: OTHER_TOKEN }))), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight(followUp(files, OTHER_TOKEN))), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight(editReply(files, { token: OTHER_TOKEN }))), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight({
    method: 'DELETE', fullRoute: `/webhooks/${APPLICATION_ID}/${INTERACTION_TOKEN}/messages/@original`, files,
  })), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'exported' }, files,
  })), UNINSPECTABLE);
  // A command of a guild that is not protected, or one with no recorded interaction.
  assert.deepEqual(inExtension(() => guard.preflight(callback(files)), { sourceGuildId: OTHER_GUILD_ID }), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight(callback(files)), { sourceGuildId: null }), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight(callback(files)), { interactionToken: null }), UNINSPECTABLE);
  assert.deepEqual(inExtension(() => guard.preflight(callback(files)), { interactionId: null }), UNINSPECTABLE);
  // A hook, a guard or a preflight, even when handed the same interaction.
  for (const entry of ['hook', 'guard', 'preflight']) {
    assert.deepEqual(inExtension(() => guard.preflight(callback(files)), { entry }), UNINSPECTABLE, entry);
  }
  // Outside the extension the public rules apply: an image passes, a .json does not.
  assert.deepEqual(guard.preflight(callback(files)), UNINSPECTABLE);
  assert.deepEqual(guard.preflight(callback([{ name: 'panel.png', data: SYNTHETIC_PNG }])), ADMITTED);
});

test('a protected delivery still carries no file, inside an extension command or not', async () => {
  let calls = 0;
  const rest = createSyntheticRest({ post() { calls += 1; return { id: MESSAGE_ID }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], lock: false });
  const guarded = rest.request;
  rest.request = (options) => guarded({ ...options, files: [exportFile()] });
  const channel = installProtectedRest(rest);
  const notice = { method: 'POST', fullRoute: `/interactions/${INTERACTION_ID}/${INTERACTION_TOKEN}/callback`,
    body: { type: 4, data: { content: 'notice' } } };
  const send = () => channel.send(notice, { deadlineMs: 1_000, label: 'safety.public-effects' });
  for (const outcome of [await send(), await inExtension(send)]) {
    assert.equal(outcome.kind, 'not_sent');
    assert.equal(outcome.causeCode, 'EGRESS_UNINSPECTABLE_FILE');
  }
  assert.equal(calls, 0);
});

async function resolvePayload(options) {
  const target = { client: { options: Options.createDefault() } };
  return MessagePayload.create(target, options).resolveBody().resolveFiles();
}

test('a settings export built the way discord.js builds it reaches the transport as the checked JSON file', async () => {
  const received = [];
  const record = (route, request) => { received.push({ route, ...request }); return { id: MESSAGE_ID }; };
  const rest = createSyntheticRest({ post: record, patch: record });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID] });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  const json = `${JSON.stringify({ guildName: 'Synthetic', site: 'https://evil.example/x', filters: { enabled: true } }, null, 2)}\n`;
  const payload = {
    content: 'exported',
    files: [new AttachmentBuilder(Buffer.from(json, 'utf8'), { name: `settings-${GUILD_ID}.json` })],
    flags: 64,
  };
  const { body, files } = await resolvePayload(payload);
  assert.deepEqual(files.map((file) => Object.keys(file).sort()), [['contentType', 'data', 'name']]);

  await inExtension(() => rest.post(Routes.interactionCallback(INTERACTION_ID, INTERACTION_TOKEN),
    { body: { type: 4, data: body }, files, auth: false }));
  await inExtension(() => rest.patch(Routes.webhookMessage(APPLICATION_ID, INTERACTION_TOKEN, '@original'),
    { body, files, auth: false }));
  assert.equal(received.length, 2);
  for (const call of received) {
    assert.equal(call.files.length, 1);
    assert.equal(call.files[0].name, `settings-${GUILD_ID}.json`);
    assert.equal(call.files[0].type, 'application/json; charset=utf-8');
    const sent = JSON.parse(call.files[0].data.toString('utf8'));
    assert.equal(sent.site, '[連結已移除]');
    assert.deepEqual(sent.filters, { enabled: true });
  }
  // The same request from a hook, or for another interaction, never reaches the transport.
  await assert.rejects(() => inExtension(() => rest.post(Routes.interactionCallback(INTERACTION_ID, INTERACTION_TOKEN),
    { body: { type: 4, data: body }, files, auth: false }), { entry: 'hook' }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_FILE');
  await assert.rejects(() => inExtension(() => rest.post(Routes.interactionCallback(OTHER_INTERACTION_ID, INTERACTION_TOKEN),
    { body: { type: 4, data: body }, files, auth: false })), (error) => error?.code === 'EGRESS_UNINSPECTABLE_FILE');
  assert.equal(received.length, 2);
});

// A guard over a transport that answers every request at once, with an egress limiter on a clock the test moves.
function budgetTransport() {
  const state = { clock: 1_000_000, calls: 0 };
  const rest = { request: async () => { state.calls += 1; return {}; } };
  const guard = installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], resolveChannelGuild: (id) => CHANNEL_GUILDS.get(id) ?? null,
  });
  const limiter = createEgressLimiter({ now: () => state.clock });
  guard.setAdmission((details) => limiter.admit(details));
  return { state, rest, limiter };
}

const rateLimited = (error) => error?.code === 'EGRESS_RATE_LIMITED';

// Sends requests[index % length] until the cap, checks that the next one is deferred, and returns the count.
async function sendUntilCapped(rest, requests, options) {
  let sent = 0;
  for (;;) {
    try {
      await inExtension(() => rest.request(requests[sent % requests.length]), options);
    } catch (error) {
      assert.ok(rateLimited(error), error?.code);
      return sent;
    }
    sent += 1;
    assert.ok(sent <= 1_000, 'no cap was reached');
  }
}

test('member sanctions of a protected guild share a cap of 30 an hour', async () => {
  const { state, rest } = budgetTransport();
  const sanctions = [
    { method: 'PUT', fullRoute: `/guilds/${GUILD_ID}/bans/${USER_ID}`, body: { delete_message_seconds: 0 } },
    { method: 'DELETE', fullRoute: `/guilds/${GUILD_ID}/bans/${USER_ID}` },
    { method: 'DELETE', fullRoute: `/guilds/${GUILD_ID}/members/${USER_ID}` },
    { method: 'PATCH', fullRoute: `/guilds/${GUILD_ID}/members/${USER_ID}`, body: { communication_disabled_until: '2026-10-11T00:10:00.000Z' } },
  ];
  assert.equal(await sendUntilCapped(rest, sanctions), 30);
  // A hook (an automatic timeout) draws on the same budget.
  await assert.rejects(() => inExtension(() => rest.request(sanctions[3]), { entry: 'hook' }), rateLimited);
  state.clock += HOUR_MS;
  assert.equal(await sendUntilCapped(rest, sanctions, { entry: 'hook' }), 30);
  assert.equal(state.calls, 60);
});

test('role changes of a protected guild allow 300 an hour at no more than 30 a minute', async () => {
  const { state, rest } = budgetTransport();
  const roles = [
    { method: 'PUT', fullRoute: `/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}` },
    { method: 'DELETE', fullRoute: `/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}` },
  ];
  let total = 0;
  for (let minute = 0; minute < 10; minute += 1) {
    assert.equal(await sendUntilCapped(rest, roles, { entry: minute % 2 ? 'hook' : 'command' }), 30, `minute ${minute}`);
    total += 30;
    state.clock += MINUTE_MS;
  }
  assert.equal(total, 300);
  // The hour is spent even though the minute is not.
  await assert.rejects(() => inExtension(() => rest.request(roles[0])), rateLimited);
  // Sanctions keep their own budget.
  await inExtension(() => rest.request({ method: 'DELETE', fullRoute: `/guilds/${GUILD_ID}/members/${USER_ID}` }));
  state.clock += HOUR_MS - 9 * MINUTE_MS;
  assert.equal(await sendUntilCapped(rest, roles), 30);
});

test('single message deletions of a protected guild share a cap of 200 an hour across its channels', async () => {
  const { state, rest } = budgetTransport();
  const deletions = [
    { method: 'DELETE', fullRoute: `/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}` },
    { method: 'DELETE', fullRoute: `/channels/${SECOND_CHANNEL_ID}/messages/${MESSAGE_ID}` },
  ];
  assert.equal(await sendUntilCapped(rest, deletions, { entry: 'hook' }), 200);
  state.clock += HOUR_MS;
  assert.equal(await sendUntilCapped(rest, deletions), 200);
});

test('bulk deletions in a protected guild allow 10 per channel every 10 minutes and keep the 2 to 100 bound', async () => {
  const { state, rest } = budgetTransport();
  const bulk = (channelId, count = 2) => ({
    method: 'POST', fullRoute: `/channels/${channelId}/messages/bulk-delete`,
    body: { messages: Array.from({ length: count }, (_, index) => String(BigInt(MESSAGE_ID) + BigInt(index))) },
  });
  assert.equal(await sendUntilCapped(rest, [bulk(CHANNEL_ID, 100)]), 10);
  assert.equal(await sendUntilCapped(rest, [bulk(SECOND_CHANNEL_ID)]), 10);
  for (const count of [1, 101]) {
    await assert.rejects(() => inExtension(() => rest.request(bulk(CHANNEL_ID, count))),
      (error) => error?.code === 'EGRESS_BULK_DELETE_SIZE', String(count));
  }
  state.clock += 10 * MINUTE_MS;
  assert.equal(await sendUntilCapped(rest, [bulk(CHANNEL_ID)]), 10);
});

test('channel creation and deletion in a protected guild allow 20 a day each', async () => {
  const { state, rest } = budgetTransport();
  const create = { method: 'POST', fullRoute: `/guilds/${GUILD_ID}/channels`, body: { name: 'support', type: 0 } };
  const remove = { method: 'DELETE', fullRoute: `/channels/${CHANNEL_ID}` };
  assert.equal(await sendUntilCapped(rest, [create]), 20);
  assert.equal(await sendUntilCapped(rest, [remove]), 20);
  state.clock += DAY_MS - 1;
  await assert.rejects(() => inExtension(() => rest.request(create)), rateLimited);
  state.clock += 1;
  assert.equal(await sendUntilCapped(rest, [create, remove]), 40);
});

test('any other write of an extension in a protected guild shares a cap of 60 an hour', async () => {
  const { state, rest } = budgetTransport();
  const others = [
    { method: 'POST', fullRoute: `/guilds/${GUILD_ID}/roles`, body: { name: 'job' } },
    { method: 'PUT', fullRoute: `/channels/${CHANNEL_ID}/permissions/${ROLE_ID}`, body: { type: 0, allow: '1024' } },
    { method: 'PATCH', fullRoute: `/guilds/${GUILD_ID}/roles/${ROLE_ID}`, body: { name: 'job' } },
  ];
  assert.equal(await sendUntilCapped(rest, others), 60);
  state.clock += HOUR_MS;
  assert.equal(await sendUntilCapped(rest, others), 60);
});

test('outside a protected guild or an extension the management routes keep their refusals and narrow caps', async () => {
  const { state, rest, limiter } = budgetTransport();
  const ban = { method: 'PUT', fullRoute: `/guilds/${OTHER_GUILD_ID}/bans/${USER_ID}` };
  await assert.rejects(() => inExtension(() => rest.request(ban)), (error) => error?.code === 'EGRESS_NOT_PRIVATE_GUILD');
  await assert.rejects(() => rest.request({ method: 'PUT', fullRoute: `/guilds/${GUILD_ID}/bans/${USER_ID}` }),
    (error) => error?.code === 'EGRESS_NO_EXTENSION_CONTEXT');
  await assert.rejects(() => inExtension(() => rest.request({ method: 'DELETE', fullRoute: `/channels/${OTHER_CHANNEL_ID}` })),
    (error) => error?.code === 'EGRESS_NOT_PRIVATE_GUILD');
  assert.equal(state.calls, 0);

  // A message the bot itself just sent may be deleted without an extension, in a protected guild too,
  // and keeps the narrow cap of 3 per channel every 10 minutes.
  const ids = Array.from({ length: 4 }, (_, index) => String(BigInt(MESSAGE_ID) + BigInt(index)));
  const created = [...ids];
  const sender = { request: async () => { state.calls += 1; return { id: created.shift() }; } };
  const senderGuard = installEgressGuard(sender, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], resolveChannelGuild: (id) => CHANNEL_GUILDS.get(id) ?? null,
  });
  senderGuard.setAdmission((details) => limiter.admit(details));
  for (let index = 0; index < 4; index += 1) {
    await sender.request({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'x' } });
  }
  for (const id of ids.slice(0, 3)) await sender.request({ method: 'DELETE', fullRoute: `/channels/${CHANNEL_ID}/messages/${id}` });
  await assert.rejects(() => sender.request({ method: 'DELETE', fullRoute: `/channels/${CHANNEL_ID}/messages/${ids[3]}` }),
    rateLimited);
  assert.equal(limiter.snapshotForTests().attempts[`bulk-delete:${CHANNEL_ID}`], 3);
});
