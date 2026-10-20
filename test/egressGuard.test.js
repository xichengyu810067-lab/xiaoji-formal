'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REST } = require('@discordjs/rest');

const { installEgressGuard, setEgressSafetyEventHandler } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { installProtectedRest } = require('../src/platform/protectedRest');
const { claimExtensionContextRunner } = require('../src/platform/extensionContext');
const { runWithHostOperationContext } = require('../src/platform/hostOperationContext');
const { buildWorkPenaltyAnnouncementBody } = require('../src/systems/safety/workPenaltySource');
const { buildWorkReminderBody } = require('../src/systems/safety/workReminderSource');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const {
  ADDRESSES: PARSER_ADDRESSES,
  REMOVED_BY_DESIGN,
  TEXT: PARSER_TEXT,
  TEXT_WITH_A_NAME,
  WITH_CONTEXT,
} = require('./fixtures/schemeAddressCases');

const CHANNEL_ID = '12345678901234567';
const GUILD_ID = '23456789012345678';
const MESSAGE_ID = '34567890123456789';
const OWNER_ID = '45678901234567890';
const HOUR_MS = 60 * 60 * 1_000;
const extensionContextRunner = claimExtensionContextRunner();

function leaveTarget(index) {
  return `9${String(index).padStart(16, '0')}`;
}

function leaveRequest(index) {
  return { method: 'DELETE', fullRoute: `/users/@me/guilds/${leaveTarget(index)}`, body: null };
}

// A leave started by the Owner from a verified private extension call of the given entry kind. The host
// records the user who ran a command in its extension context, and the host operation names the same actor.
function ownerExtensionLeave(rest, index, entry = 'command') {
  return runWithHostOperationContext({ actorId: OWNER_ID }, () => extensionContextRunner.run({
    extensionId: 'test-extension', entry, name: `synthetic.${entry}`, sourceGuildId: GUILD_ID, actorId: OWNER_ID,
  }, () => rest.request(leaveRequest(index))));
}

function leaveTransport({ now = () => 1_000_000 } = {}) {
  const state = { calls: 0 };
  const rest = createSyntheticRest({ delete() { state.calls += 1; } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], ownerId: OWNER_ID });
  const limiter = createEgressLimiter({ now });
  guard.setAdmission((details) => limiter.admit(details));
  return { state, rest, limiter };
}

test('egress rewrites adjacent and IPv6 links, and removes broadcast mentions without mutating the caller body', async () => {
  let received;
  const rest = createSyntheticRest({
    post(route, { body }) {
      assert.equal(route, `/channels/${CHANNEL_ID}/messages`);
      received = body;
      return { id: '34567890123456789' };
    },
  });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const body = {
    content: 'xhttps://evil.example/ https://[::1]/ @everyone',
    allowed_mentions: { parse: ['users', 'everyone', 'roles'], roles: [GUILD_ID], users: [CHANNEL_ID], replied_user: true },
  };
  await rest.request({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body });
  assert.equal(body.content, 'xhttps://evil.example/ https://[::1]/ @everyone');
  assert.deepEqual(body.allowed_mentions.parse, ['users', 'everyone', 'roles']);
  assert.equal(received.content.includes('https://'), false);
  assert.match(received.content, /x\[連結已移除\] \[連結已移除\] @everyone/u);
  assert.deepEqual(received.allowed_mentions, { parse: ['users'], roles: [], users: [CHANNEL_ID], replied_user: false });
});

test('egress blocks an untrusted destructive route before the transport', async () => {
  let calls = 0;
  const rest = createSyntheticRest({ patch() { calls += 1; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID] });
  await assert.rejects(
    () => rest.request({ method: 'PATCH', fullRoute: `/guilds/${GUILD_ID}/members/${CHANNEL_ID}`, body: { roles: [] } }),
    (error) => error?.code === 'EGRESS_NO_EXTENSION_CONTEXT',
  );
  assert.equal(calls, 0);
});

test('a verified private extension deletes channels of a protected guild within the protected-guild cap', async () => {
  let calls = 0;
  const rest = createSyntheticRest({ delete() { calls += 1; } });
  const guard = installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], resolveChannelGuild: () => GUILD_ID,
  });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  const request = () => extensionContextRunner.run({
    extensionId: 'test-extension', entry: 'command', name: 'synthetic.execute', sourceGuildId: GUILD_ID,
  }, () => rest.request({ method: 'DELETE', fullRoute: `/channels/${CHANNEL_ID}`, body: null }));
  for (let index = 0; index < 20; index += 1) await request();
  await assert.rejects(request, (error) => error?.code === 'EGRESS_RATE_LIMITED');
  assert.equal(calls, 20);
});

test('a verified private extension cannot bypass its high-risk cap through an unclassified management route', async () => {
  let calls = 0;
  const rest = createSyntheticRest({ delete() { calls += 1; } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID] });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  const request = () => extensionContextRunner.run({
    extensionId: 'test-extension', entry: 'command', name: 'synthetic.execute', sourceGuildId: GUILD_ID,
  }, () => rest.request({ method: 'DELETE', fullRoute: `/guilds/${GUILD_ID}/roles/${CHANNEL_ID}`, body: null }));
  for (let index = 0; index < 60; index += 1) await request();
  await assert.rejects(request, (error) => error?.code === 'EGRESS_RATE_LIMITED');
  assert.equal(calls, 60);
});

test('an Owner command of a private extension leaves guilds only within the shared cap of 3 an hour and 10 a day', async () => {
  let clock = 1_000_000;
  const { state, rest } = leaveTransport({ now: () => clock });
  let index = 0;
  for (; index < 3; index += 1) await ownerExtensionLeave(rest, index);
  await assert.rejects(() => ownerExtensionLeave(rest, index), (error) => error?.code === 'EGRESS_RATE_LIMITED');
  for (let hour = 0; hour < 3; hour += 1) {
    clock += HOUR_MS;
    const quota = Math.min(3, 10 - index);
    for (let count = 0; count < quota; count += 1, index += 1) await ownerExtensionLeave(rest, index);
  }
  assert.equal(index, 10);
  clock += HOUR_MS;
  await assert.rejects(() => ownerExtensionLeave(rest, index), (error) => error?.code === 'EGRESS_RATE_LIMITED');
  assert.equal(state.calls, 10);
});

test('a private extension hook, guard or preflight cannot leave a guild, even for the Owner', async () => {
  const { state, rest } = leaveTransport();
  for (const entry of ['hook', 'guard', 'preflight']) {
    await assert.rejects(() => ownerExtensionLeave(rest, 0, entry), (error) => error?.code === 'EGRESS_LEAVE_NOT_OWNER', entry);
  }
  await assert.rejects(() => runWithHostOperationContext({ actorId: CHANNEL_ID }, () => extensionContextRunner.run({
    extensionId: 'test-extension', entry: 'command', name: 'synthetic.command', sourceGuildId: GUILD_ID,
  }, () => rest.request(leaveRequest(0)))), (error) => error?.code === 'EGRESS_LEAVE_NOT_OWNER');
  assert.equal(state.calls, 0);
});

test('a command leaves a guild only when the host recorded the Owner as the user who ran it', async () => {
  const { state, rest } = leaveTransport();
  const leave = ({ hostActor, commandActor, sourceGuildId = GUILD_ID, target = leaveTarget(0) }) =>
    runWithHostOperationContext(hostActor ? { actorId: hostActor } : null, () => extensionContextRunner.run({
      extensionId: 'test-extension', entry: 'command', name: 'synthetic.execute', sourceGuildId, actorId: commandActor,
    }, () => rest.request({ method: 'DELETE', fullRoute: `/users/@me/guilds/${target}`, body: null })));
  const notOwner = (error) => error?.code === 'EGRESS_LEAVE_NOT_OWNER';
  // The host operation alone cannot make someone else's command an Owner command, nor the reverse.
  await assert.rejects(() => leave({ hostActor: OWNER_ID, commandActor: CHANNEL_ID }), notOwner);
  await assert.rejects(() => leave({ hostActor: OWNER_ID, commandActor: null }), notOwner);
  await assert.rejects(() => leave({ hostActor: CHANNEL_ID, commandActor: OWNER_ID }), notOwner);
  await assert.rejects(() => leave({ hostActor: null, commandActor: OWNER_ID }), notOwner);
  // The command must run in a protected guild.
  await assert.rejects(() => leave({ hostActor: OWNER_ID, commandActor: OWNER_ID, sourceGuildId: MESSAGE_ID }), notOwner);
  // A protected guild is never left, by anyone.
  await assert.rejects(() => leave({ hostActor: OWNER_ID, commandActor: OWNER_ID, target: GUILD_ID }),
    (error) => error?.code === 'EGRESS_PRIVATE_GUILD_LEAVE');
  assert.equal(state.calls, 0);
  await leave({ hostActor: OWNER_ID, commandActor: OWNER_ID });
  assert.equal(state.calls, 1);
});

test('the automatic leave shares the leave cap and its label authorizes nothing inside a private extension', async () => {
  const { state, rest, limiter } = leaveTransport();
  const channel = installProtectedRest(rest);
  const autoLeave = (index) => channel.send(leaveRequest(index), { deadlineMs: 1_000, label: 'safety.public-effects' });
  const inside = await extensionContextRunner.run({
    extensionId: 'test-extension', entry: 'hook', name: 'hooks.ready', sourceGuildId: GUILD_ID,
  }, () => autoLeave(0));
  assert.equal(inside.kind, 'not_sent');
  assert.equal(inside.causeCode, 'EGRESS_LEAVE_NOT_OWNER');
  assert.equal(state.calls, 0);
  // The ordinary automatic leave runs outside any extension and still leaves.
  assert.equal((await autoLeave(1)).kind, 'confirmed');
  await ownerExtensionLeave(rest, 2);
  assert.equal((await autoLeave(3)).kind, 'confirmed');
  const capped = await autoLeave(4);
  assert.equal(capped.kind, 'not_sent');
  assert.equal(capped.causeCode, 'EGRESS_RATE_LIMITED');
  assert.equal(state.calls, 3);
  assert.equal(limiter.snapshotForTests().attempts['guild-leave-hour:all'], 3);
});

test('the reaction cap counts a percent-encoded ✅ and consumes the reservation a runtime made with the raw route', async () => {
  let calls = 0;
  const rest = createSyntheticRest({ put() { calls += 1; } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', resolveChannelGuild: () => GUILD_ID });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  // The route discord.js builds for the ✅ reaction (Routes.channelMessageOwnReaction).
  const request = () => ({ method: 'PUT', fullRoute: `/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/reactions/%E2%9C%85/@me`, body: null });
  // A public-effect runtime reserves with the raw route before its ledger claim (publicSideEffectRuntime.js).
  const reserved = limiter.reserve(request());
  assert.equal(reserved.allowed, true);
  await limiter.runWithReservation(reserved.reservation, () => rest.request(request()));
  assert.deepEqual(limiter.snapshotForTests(), { attempts: { [`reaction:${CHANNEL_ID}`]: 1 }, reservations: 0 });
  limiter.cancel(reserved.reservation);
  for (let index = 0; index < 9; index += 1) await rest.request(request());
  await assert.rejects(() => rest.request(request()), (error) => error?.code === 'EGRESS_RATE_LIMITED');
  assert.equal(calls, 10);
});

test('egress rewrites private extension text routes and rejects custom serialization before the transport', async () => {
  let privateBody;
  let calls = 0;
  const rest = createSyntheticRest({
    patch(route, { body }) {
      calls += 1;
      assert.equal(route, `/channels/${CHANNEL_ID}`);
      privateBody = body;
      return {};
    },
    post() { calls += 1; return {}; },
  });
  installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], resolveChannelGuild: () => GUILD_ID,
  });
  await extensionContextRunner.run({
    extensionId: 'test-extension', entry: 'hook', name: 'hooks.test', sourceGuildId: GUILD_ID,
  }, () => rest.request({
    method: 'PATCH', fullRoute: `/channels/${CHANNEL_ID}`, body: { topic: '公告 https://evil.example/' },
  }));
  assert.equal(privateBody.topic, '公告 [連結已移除]');
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
    body: { content: { toJSON: () => 'https://evil.example/' } },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  assert.equal(calls, 1);
});

test('egress rejects an inherited toJSON hook before the transport can serialize it', () => {
  const rest = createSyntheticRest({ post() { throw new Error('transport must not run'); } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() { return 'https://evil.example/'; },
  });
  try {
    assert.deepEqual(guard.preflight({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'safe' },
    }), { allowed: false, code: 'EGRESS_UNINSPECTABLE_BODY' });
  } finally {
    delete Object.prototype.toJSON;
  }
});

const SYNTHETIC_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);

function messageWithFiles(files, body = { content: 'panel' }, extra = {}) {
  return { method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body, files, ...extra };
}

test('egress removes attachment URLs that no admitted file of the same request names', async () => {
  let received;
  const rest = createSyntheticRest({
    post(route, request) {
      assert.equal(route, `/channels/${CHANNEL_ID}/messages`);
      received = request;
      return { id: '34567890123456789' };
    },
  });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
    body: {
      avatar_url: 'https://evil.example/avatar.png',
      embeds: [{ image: { url: 'attachment://not-present.png' }, video: { url: 'https://evil.example/video.mp4' } }],
    },
  });
  assert.deepEqual(received.body.embeds, [{ video: {} }]);
  assert.equal(Object.hasOwn(received.body, 'avatar_url'), false);
  await rest.request(messageWithFiles([{ name: 'board-1-r2.png', data: SYNTHETIC_PNG, contentType: undefined }], {
    embeds: [{ image: { url: 'attachment://board-1-r2.png' }, thumbnail: { url: 'attachment://other.png' } }],
    attachments: [{ id: '0' }],
  }));
  assert.deepEqual(received.body.embeds, [{ image: { url: 'attachment://board-1-r2.png' } }]);
  assert.deepEqual(received.files.map((file) => [file.name, file.type]), [['board-1-r2.png', 'image/png']]);
  assert.deepEqual(received.files[0].data, SYNTHETIC_PNG);
});

test('egress admits only plain, named, allow-listed files and refuses every other file shape', () => {
  const rest = createSyntheticRest({ post() { throw new Error('preflight must not send'); } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const check = (files, body, extra) => guard.preflight(messageWithFiles(files, body, extra));
  const admitted = { allowed: true };
  const refused = { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' };
  const png = (name = 'solo-a1-r0.png', fields = {}) => ({ name, data: SYNTHETIC_PNG, ...fields });

  // What the public presenters send: a PNG panel and a UTF-8 member list.
  assert.deepEqual(check([png()]), admitted);
  assert.deepEqual(check([png('board-0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b-r12.png', { contentType: 'image/png' })]), admitted);
  assert.deepEqual(check([{ name: 'coin-role-preview.txt', data: Buffer.from('名單\nAlpha (1)\n', 'utf8') }]), admitted);
  assert.deepEqual(check([{ name: 'notes.txt', data: 'plain text', contentType: 'text/plain; charset=utf-8' }]), admitted);
  assert.deepEqual(check([{ name: 'panel.png', data: new Uint8Array(SYNTHETIC_PNG) }]), admitted);
  assert.deepEqual(check(Array.from({ length: 10 }, (_, index) => png(`p${index}.png`))), admitted);
  assert.deepEqual(check([]), admitted);

  // The list itself.
  assert.deepEqual(check(png()), refused);
  assert.deepEqual(check(Array.from({ length: 11 }, (_, index) => png(`p${index}.png`))), refused);
  assert.deepEqual(check([png(), png()]), refused);
  assert.deepEqual(check([, png()]), refused);
  const accessorList = [png()];
  Object.defineProperty(accessorList, 0, { get: () => png(), enumerable: true });
  assert.deepEqual(check(accessorList), refused);
  class UploadList extends Array {}
  assert.deepEqual(check(UploadList.from([png()])), refused);

  // The file object.
  class Upload { constructor() { this.name = 'a.png'; this.data = SYNTHETIC_PNG; } }
  assert.deepEqual(check([new Upload()]), refused);
  assert.deepEqual(check([Object.create({ name: 'a.png', data: SYNTHETIC_PNG })]), refused);
  const accessorFile = { data: SYNTHETIC_PNG };
  Object.defineProperty(accessorFile, 'name', { get: () => 'a.png', enumerable: true });
  assert.deepEqual(check([accessorFile]), refused);
  assert.deepEqual(check([png('a.png', { key: 'files[9]' })]), refused);
  assert.deepEqual(check([png('a.png', { description: 'x' })]), refused);
  assert.deepEqual(check([png('a.png', { contentType: 'text/html' })]), refused);
  assert.deepEqual(check([{ attachment: SYNTHETIC_PNG, name: 'a.png' }]), refused);

  // The data.
  const { Readable } = require('node:stream');
  assert.deepEqual(check([png('a.png', { data: Readable.from([SYNTHETIC_PNG]) })]), refused);
  assert.deepEqual(check([png('a.png', { data: () => SYNTHETIC_PNG })]), refused);
  assert.deepEqual(check([png('a.png', { data: SYNTHETIC_PNG.buffer.slice(0) })]), refused);
  assert.deepEqual(check([png('a.png', { data: new Proxy(new Uint8Array(SYNTHETIC_PNG), {}) })]), refused);
  assert.deepEqual(check([png('a.png', { data: Buffer.from('<html>not an image</html>') })]), refused);
  assert.deepEqual(check([png('a.png', { data: SYNTHETIC_PNG.toString('latin1') })]), refused);
  assert.deepEqual(check([{ name: 'a.txt', data: Buffer.from([0xc3, 0x28]) }]), refused);

  // The name.
  for (const name of ['', 'a', '.png', 'png', '../a.png', 'dir/a.png', 'dir\\a.png', 'a\u0000.png', 'a\n.png',
    'a .png', 'a..png', '.hidden.png', 'a.PNG', 'a.png.exe', 'a.exe', 'a.html', 'a.svg', 'a.csv', 'é.png',
    `${'a'.repeat(125)}.png`, 7]) {
    assert.deepEqual(check([png(name)]), refused, JSON.stringify(name));
  }
  assert.deepEqual(check([png(`${'a'.repeat(124)}.png`)]), admitted);

  // The body cannot rename an uploaded file, and form-field bodies are not inspected.
  assert.deepEqual(check([png()], { attachments: [{ id: '0', filename: 'a.exe' }] }), refused);
  assert.deepEqual(check([png()], { data: { attachments: [{ id: '0', filename: '../a.png' }] } }), refused);
  assert.deepEqual(check([png()], { attachments: [{ id: '0', filename: 'renamed.png' }] }), admitted);
  assert.deepEqual(check([png()], { content: 'x' }, { appendToFormData: true }), refused);
});

test('egress admits files of up to 8 MiB each and 16 MiB together, and refuses larger ones', () => {
  const rest = createSyntheticRest({ post() { throw new Error('preflight must not send'); } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const MIB = 1024 * 1024;
  const admitted = { allowed: true };
  const refused = { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' };
  const check = (files) => guard.preflight(messageWithFiles(files));
  const png = (name, size) => ({ name, data: Buffer.concat([SYNTHETIC_PNG, Buffer.alloc(size - SYNTHETIC_PNG.length)]) });
  const text = (name, size) => ({ name, data: Buffer.alloc(size, 'a') });

  // One file, as bytes or as a string.
  assert.deepEqual(check([png('a.png', 8 * MIB)]), admitted);
  assert.deepEqual(check([png('a.png', 8 * MIB + 1)]), refused);
  assert.deepEqual(check([text('a.txt', 8 * MIB)]), admitted);
  assert.deepEqual(check([text('a.txt', 8 * MIB + 1)]), refused);
  assert.deepEqual(check([{ name: 'a.txt', data: 'a'.repeat(8 * MIB) }]), admitted);
  assert.deepEqual(check([{ name: 'a.txt', data: 'a'.repeat(8 * MIB + 1) }]), refused);
  // A view is measured by the bytes it holds, not by what its byteLength answers.
  class SmallLooking extends Uint8Array { get byteLength() { return SYNTHETIC_PNG.length; } }
  assert.deepEqual(check([{ name: 'a.png', data: new SmallLooking(png('a.png', 8 * MIB + 1).data) }]), refused);
  // A text file whose replaced links make it larger than the limit.
  assert.deepEqual(check([{ name: 'a.txt', data: 'http://a '.repeat(512 * 1024) }]), refused);

  // Together.
  assert.deepEqual(check([png('a.png', 8 * MIB), png('b.png', 8 * MIB)]), admitted);
  assert.deepEqual(check([png('a.png', 8 * MIB), png('b.png', 8 * MIB), png('c.png', SYNTHETIC_PNG.length)]), refused);
  assert.deepEqual(check([png('a.png', 8 * MIB), text('b.txt', 4 * MIB), text('c.txt', 4 * MIB + 1)]), refused);
});

test('an image is measured again as copied, so bytes that grow meanwhile stay within the limits', (t) => {
  const rest = createSyntheticRest({ post() { throw new Error('preflight must not send'); } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const MIB = 1024 * 1024;
  const refused = { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' };
  const check = (files) => guard.preflight(messageWithFiles(files));
  const png = (name, size) => ({ name, data: Buffer.concat([SYNTHETIC_PNG, Buffer.alloc(size - SYNTHETIC_PNG.length)]) });
  // A view of a growable shared buffer, which another thread may grow between the measure and the copy.
  // Here it grows by `growth` bytes exactly when it is copied.
  const growOnCopy = new Map();
  const growing = (name, size, growth) => {
    const buffer = new SharedArrayBuffer(size, { maxByteLength: size + growth });
    const data = new Uint8Array(buffer);
    data.set(SYNTHETIC_PNG);
    growOnCopy.set(data, () => buffer.grow(size + growth));
    return { name, data };
  };
  const copyBytesFrom = Buffer.copyBytesFrom;
  Buffer.copyBytesFrom = function copyGrowing(view, ...rest) {
    growOnCopy.get(view)?.();
    growOnCopy.delete(view);
    return Reflect.apply(copyBytesFrom, this, [view, ...rest]);
  };
  t.after(() => { Buffer.copyBytesFrom = copyBytesFrom; });

  // One file of 8 MiB as measured and 8 MiB + 1 as copied.
  assert.deepEqual(check([growing('a.png', 8 * MIB, 1)]), refused);
  // Files of 12 MiB together as measured and more than 16 MiB as copied.
  assert.deepEqual(check([growing('a.png', 4 * MIB, 4 * MIB), png('b.png', 8 * MIB), png('c.png', SYNTHETIC_PNG.length)]), refused);
  // The same files without the growth are admitted.
  assert.deepEqual(check([growing('a.png', 8 * MIB, 0)]), { allowed: true });
  assert.deepEqual(check([png('a.png', 4 * MIB), png('b.png', 8 * MIB), png('c.png', SYNTHETIC_PNG.length)]), { allowed: true });
});

test('a text file that changes size as it is copied is refused, and each copy takes no more than the size measured', (t) => {
  const rest = createSyntheticRest({ post() { throw new Error('preflight must not send'); } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const check = (files) => guard.preflight(messageWithFiles(files));
  // A view of a resizable buffer, which another thread may resize between the measure and the copy.
  const resizeOnCopy = new Map();
  const copyBytesFrom = Buffer.copyBytesFrom;
  const copyLengths = [];
  Buffer.copyBytesFrom = function copyResizing(view, ...args) {
    copyLengths.push(args[1]);
    resizeOnCopy.get(view)?.();
    resizeOnCopy.delete(view);
    return Reflect.apply(copyBytesFrom, this, [view, ...args]);
  };
  t.after(() => { Buffer.copyBytesFrom = copyBytesFrom; });
  const resizing = (size) => {
    const buffer = new ArrayBuffer(5, { maxByteLength: 9 });
    const data = new Uint8Array(buffer);
    data.set(Buffer.from('hello'));
    resizeOnCopy.set(data, () => buffer.resize(size));
    return data;
  };

  assert.deepEqual(check([{ name: 'a.txt', data: resizing(9) }]), { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' });
  assert.deepEqual(check([{ name: 'a.txt', data: resizing(2) }]), { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' });
  assert.deepEqual(check([{ name: 'a.txt', data: resizing(5) }]), { allowed: true });
  assert.deepEqual(copyLengths, [5, 5, 5]);
});

test('an admitted file reaches the transport with the content type of its kind, whatever its first bytes', async () => {
  let received;
  const rest = createSyntheticRest({ post(route, request) { received = request; return { id: MESSAGE_ID }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  await rest.request(messageWithFiles([
    { name: 'panel.png', data: SYNTHETIC_PNG },
    { name: 'gif.txt', data: Buffer.from('GIF89a member list\n', 'utf8') },
    { name: 'pdf.txt', data: '%PDF-1.7 member list\n' },
    { name: 'plain.txt', data: 'plain\n', contentType: 'text/plain' },
  ]));
  assert.deepEqual(received.files.map((file) => [file.name, file.type]), [
    ['panel.png', 'image/png'],
    ['gif.txt', 'text/plain; charset=utf-8'],
    ['pdf.txt', 'text/plain; charset=utf-8'],
    ['plain.txt', 'text/plain; charset=utf-8'],
  ]);
  assert.equal(received.files[1].data.toString('utf8'), 'GIF89a member list\n');
});

test('the starting message of a new thread cannot rename an uploaded file either', () => {
  const rest = createSyntheticRest({ post() { throw new Error('preflight must not send'); } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const thread = { fullRoute: `/channels/${CHANNEL_ID}/threads` };
  const check = (filename) => guard.preflight(messageWithFiles([{ name: 'panel.png', data: SYNTHETIC_PNG }], {
    name: 'thread', message: { content: 'panel', attachments: [{ id: '0', filename }] },
  }, thread));
  for (const filename of ['a.exe', '../a.png', 'panel.html']) {
    assert.deepEqual(check(filename), { allowed: false, code: 'EGRESS_UNINSPECTABLE_FILE' }, filename);
  }
  assert.deepEqual(check('renamed.png'), { allowed: true });
});

test('egress rewrites links inside an admitted text file before the transport', async () => {
  let received;
  const rest = createSyntheticRest({ post(route, request) { received = request; return { id: '34567890123456789' }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const data = Buffer.from('Alpha https://evil.example/x (1)\n', 'utf8');
  await rest.request(messageWithFiles([{ name: 'coin-role-preview.txt', data }]));
  assert.equal(received.files[0].data.toString('utf8'), 'Alpha [連結已移除] (1)\n');
  assert.equal(data.toString('utf8'), 'Alpha https://evil.example/x (1)\n');
});

// A REST whose transport records the URL, method, body and dispatcher of every request it would send.
function recordingRest() {
  const sent = [];
  const rest = new REST({
    retries: 0,
    async makeRequest(url, init) {
      sent.push(Object.freeze({ url, method: init.method, body: init.body, dispatcher: init.dispatcher, headers: init.headers }));
      return new Response(JSON.stringify({ id: MESSAGE_ID }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }).setToken('synthetic-token');
  return { rest, sent };
}

function formFields(body) {
  assert.ok(body instanceof FormData, 'the request was sent as form data');
  return [...body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : value.name]);
}

test('what the caller changes while its request waits for admission does not reach the transport', async () => {
  const { rest, sent } = recordingRest();
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const options = { method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'panel' } };
  guard.setAdmission(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    Object.assign(options, {
      method: 'PUT', fullRoute: `/guilds/${GUILD_ID}/bans/${OWNER_ID}`, versioned: false,
      files: [{ name: 'payload.html', data: Buffer.from('<script></script>'), contentType: 'text/html' }],
      appendToFormData: true, passThroughBody: true,
    });
    options.body.content = 'https://evil.example/';
  });
  await rest.request(options);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
  assert.equal(typeof sent[0].body, 'string');
  assert.equal(JSON.parse(sent[0].body).content, 'panel');
});

test('form fields a caller asks for while an admitted file waits for admission do not reach the transport', async () => {
  const { rest, sent } = recordingRest();
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const files = [{ name: 'panel.png', data: SYNTHETIC_PNG }];
  const options = messageWithFiles(files);
  guard.setAdmission(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    options.appendToFormData = true;
    files.push({ name: 'payload.html', data: Buffer.from('<script></script>') });
  });
  await rest.request(options);
  assert.equal(sent.length, 1);
  assert.deepEqual(formFields(sent[0].body), [['files[0]', 'panel.png'], ['payload_json', JSON.stringify({
    content: 'panel', allowed_mentions: { parse: [], roles: [], replied_user: false },
  })]]);
});

test('a request cannot bring a dispatcher of its own to the transport', async () => {
  const { rest, sent } = recordingRest();
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  // A dispatcher would receive the whole request, token included, and could send it anywhere.
  const dispatcher = { dispatch() { throw new Error('a dispatcher of the caller must not be used'); } };
  const message = () => ({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'panel' } });
  const refused = { allowed: false, code: 'EGRESS_UNINSPECTABLE_BODY' };
  assert.deepEqual(guard.preflight({ ...message(), dispatcher }), refused);
  assert.deepEqual(guard.preflight({ ...message(), dispatcher: null }), refused);
  await assert.rejects(() => rest.request({ ...message(), dispatcher }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  assert.equal(sent.length, 0);
  // One added while the checked request waits for admission does not reach the transport either.
  const options = message();
  guard.setAdmission(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    options.dispatcher = dispatcher;
  });
  await rest.request(options);
  await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'panel' } });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((request) => request.dispatcher), [undefined, undefined]);
});

test('the REST queue, agent, API base and version cannot be reached or changed around the guard', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const dispatcher = { dispatch() { throw new Error('a dispatcher of the caller must not be used'); } };
  // queueRequest() would send a request request() never checked.
  await assert.rejects(() => rest.queueRequest({ method: 'PUT', fullRoute: `/guilds/${GUILD_ID}/bans/${OWNER_ID}` }), TypeError);
  // The agent is the dispatcher of every request; the API base and version start every URL.
  assert.throws(() => rest.setAgent(dispatcher), TypeError);
  assert.throws(() => { rest.agent = dispatcher; }, TypeError);
  assert.throws(() => { rest.options.api = 'https://evil.example/api'; }, TypeError);
  assert.throws(() => { rest.options.version = `10/guilds/${GUILD_ID}/bans/${OWNER_ID}#`; }, TypeError);
  assert.throws(() => { rest.options = { ...rest.options, api: 'https://evil.example/api' }; }, TypeError);
  for (const name of ['queueRequest', 'setAgent', 'agent', 'options']) {
    assert.throws(() => Object.defineProperty(rest, name, { value: dispatcher }), TypeError, name);
  }
  assert.equal(sent.length, 0);
  // What request() admits still goes through the queue to the API, without an agent.
  await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'panel' } });
  await rest.patch(`/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, { body: { content: 'panel' } });
  assert.deepEqual(sent.map((request) => [request.method, request.url, request.dispatcher]), [
    ['POST', `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, undefined],
    ['PATCH', `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, undefined],
  ]);
});

test('a request body that answers differently on each read reaches the transport as it was checked', async () => {
  let received;
  const rest = createSyntheticRest({ post(route, { body }) { received = body; return { id: MESSAGE_ID }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  let reads = 0;
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
    get body() {
      reads += 1;
      return reads === 1 ? { content: 'safe' } : { content: { toJSON: () => 'https://evil.example/' } };
    },
  });
  assert.equal(received.content, 'safe');
});

// The caller's getters and Proxy traps run while the request is read, and the request may only
// be sent as it was read and checked. Each test below changes the caller's object from such a
// trap and expects the transport to see the checked values only.
test('a getter that turns the body into a URL object while the request is read is refused before the transport', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const body = { content: 'panel' };
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body,
    get files() {
      body.content = new URL('https://evil.example/');
      return undefined;
    },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  assert.equal(sent.length, 0);
  // A link written as text by the same getter is still sent with the link removed.
  const plain = { content: 'panel' };
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: plain,
    get files() {
      plain.content = 'https://evil.example/';
      return undefined;
    },
  });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].body, /evil\.example/u);
});

test('a getter that gives the body an allowed_mentions with a toJSON() cannot ping everyone', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const body = { content: '@everyone' };
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body,
    get files() {
      body.allowed_mentions = { parse: [], toJSON: () => ({ parse: ['everyone'] }) };
      return undefined;
    },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  assert.equal(sent.length, 0);
});

test('a getter that renames an attachment while the request is read cannot send the renamed upload', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const plain = { content: 'panel', attachments: [{ id: '0', filename: 'panel.png' }] };
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: plain,
    get appendToFormData() {
      plain.attachments[0].filename = 'evil.exe';
      return false;
    },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_FILE');
  const withFile = { content: 'panel', attachments: [{ id: '0', filename: 'panel.png' }] };
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: withFile,
    files: [{ name: 'panel.png', data: SYNTHETIC_PNG }],
    get appendToFormData() {
      withFile.attachments[0].filename = 'evil.exe';
      return false;
    },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_FILE');
  assert.equal(sent.length, 0);
});

test('an options object whose reads answer differently sends the first read of each field, as it was checked', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const reads = new Map();
  const options = new Proxy({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'panel' } }, {
    get(target, key, receiver) {
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (key === 'body' && count > 1) return { content: { toJSON: () => 'https://evil.example/' } };
      return Reflect.get(target, key, receiver);
    },
  });
  await rest.request(options);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].body).content, 'panel');
});

test('a file list that changes the body while it is inspected does not change what is sent', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const body = { content: 'panel' };
  // inspectFiles() reads the length of the list after the body has been checked and copied.
  const files = new Proxy([{ name: 'panel.png', data: SYNTHETIC_PNG }], {
    get(target, key, receiver) {
      if (key === 'length') body.content = { toJSON: () => 'https://evil.example/' };
      return Reflect.get(target, key, receiver);
    },
  });
  await rest.request(messageWithFiles(files, body));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.get('payload_json'), JSON.stringify({
    content: 'panel', allowed_mentions: { parse: [], roles: [], replied_user: false },
  }));
});

test('a request field the guard does not inspect is sent as it was read when the request was checked', async () => {
  const { rest, sent } = recordingRest();
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  let phase = 'first';
  guard.setAdmission(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    phase = 'second';
  });
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'panel' },
    get reason() { return phase; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['X-Audit-Log-Reason'], 'first');
});

test('a proxy anywhere in the body is refused, whatever it answers to the check and to the copy that is sent', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const message = (body) => ({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body });
  // Its descriptors hold plain text; read, the same field is an object whose toJSON() gives a link.
  const linkOnRead = (target, field) => new Proxy(target, {
    get: (object, key) => (key === field ? new URL('https://evil.example/') : Reflect.get(object, key)),
  });
  // It shows a toJSON() of its own only once something has been read from it.
  let read = false;
  const everyone = () => ({ parse: ['everyone'] });
  const mentions = new Proxy({ parse: [] }, {
    ownKeys: (target) => [...Reflect.ownKeys(target), 'toJSON'],
    getOwnPropertyDescriptor: (target, key) => (key !== 'toJSON' ? Reflect.getOwnPropertyDescriptor(target, key)
      : read ? { value: everyone, writable: true, enumerable: true, configurable: true } : undefined),
    get: (target, key) => {
      read = true;
      return key === 'toJSON' ? everyone : Reflect.get(target, key);
    },
  });
  for (const body of [
    linkOnRead({ content: 'safe' }, 'content'),
    { content: '@everyone', allowed_mentions: mentions },
    { embeds: [{ fields: [linkOnRead({ name: 'a', value: 'safe' }, 'value')] }] },
  ]) {
    await assert.rejects(() => rest.request(message(body)), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  }
  assert.deepEqual(sent, []);
});

test('an array that is not exactly an Array.prototype array is refused before the body is copied', async () => {
  // clone() calls map() on every array, so the map() of a subclass or of another prototype decides what is sent.
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const message = (fields) => ({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { embeds: [{ title: 'panel', fields }] },
  });
  const evilMap = () => [new URL('https://evil.example/')];
  class Fields extends Array { map() { return evilMap(); } }
  const subclass = new Fields();
  subclass.push({ name: 'a', value: 'safe' });
  const otherPrototype = Object.create(Array.prototype);
  otherPrototype.map = evilMap;
  const reprototyped = [{ name: 'a', value: 'safe' }];
  Object.setPrototypeOf(reprototyped, otherPrototype);
  const nullPrototype = [{ name: 'a', value: 'safe' }];
  Object.setPrototypeOf(nullPrototype, null);
  for (const fields of [subclass, reprototyped, nullPrototype]) {
    await assert.rejects(() => rest.request(message(fields)), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  }
  assert.deepEqual(sent, []);
});

test('an array with an own non-enumerable map() or toJSON() is refused before the body is copied', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const evilMap = () => [new URL('https://evil.example/')];
  for (const [key, value] of [['map', evilMap], ['toJSON', () => 'https://evil.example/']]) {
    const fields = [{ name: 'a', value: 'safe' }];
    Object.defineProperty(fields, key, { value, enumerable: false, writable: true, configurable: true });
    await assert.rejects(() => rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { embeds: [{ title: 'panel', fields }] },
    }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY', key);
  }
  assert.deepEqual(sent, []);
});

test('an array with a Symbol-keyed property is refused, so the rename check and the copy cannot read different lists', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  // The rename check iterates the list; the copy that is sent maps it, so the two could differ.
  const attachments = [{ id: '0', filename: 'evil.exe' }];
  attachments[Symbol.iterator] = function* iterate() { yield { id: '0', filename: 'panel.png' }; };
  await assert.rejects(() => rest.request(messageWithFiles([{ name: 'panel.png', data: SYNTHETIC_PNG }], {
    content: 'panel', attachments,
  })), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  const marked = [{ name: 'a', value: 'safe' }];
  marked[Symbol('marker')] = true;
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { embeds: [{ title: 'panel', fields: marked }] },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  assert.deepEqual(sent, []);
});

test('a sparse array is refused before the body is copied', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const fields = [, { name: 'a', value: 'safe' }];
  await assert.rejects(() => rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { embeds: [{ title: 'panel', fields }] },
  }), (error) => error?.code === 'EGRESS_UNINSPECTABLE_BODY');
  assert.deepEqual(sent, []);
});

test('a plain object body sends only its enumerable string-keyed fields, never a hidden one', async () => {
  // clone() copies only these; a non-enumerable or Symbol-keyed property is neither read nor sent.
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const body = { content: 'panel' };
  Object.defineProperty(body, 'hidden', { value: 'https://evil.example/', enumerable: false });
  body[Symbol('hidden')] = 'https://evil.example/';
  await rest.request({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { content: 'panel', allowed_mentions: { parse: [], roles: [], replied_user: false } });
});

test('ordinary arrays and nested objects, frozen or not, are still admitted', async () => {
  const { rest, sent } = recordingRest();
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const body = {
    content: 'panel',
    embeds: Object.freeze([{ title: 'T', fields: Object.freeze([{ name: 'a', value: 'b' }]) }]),
    components: [{ type: 1, components: [] }],
  };
  assert.deepEqual(guard.preflight({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body }), { allowed: true });
  await rest.request({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), {
    content: 'panel',
    embeds: [{ title: 'T', fields: [{ name: 'a', value: 'b' }] }],
    components: [{ type: 1, components: [] }],
    allowed_mentions: { parse: [], roles: [], replied_user: false },
  });
});

test('a file list that answers its length differently on each read reaches the transport with only what was checked', async () => {
  const { rest, sent } = recordingRest();
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const list = Array.from({ length: 12 }, (_, index) => ({ name: `p${index}.png`, data: SYNTHETIC_PNG }));
  let reads = 0;
  const files = new Proxy(list, {
    get(target, key, receiver) {
      if (key !== 'length') return Reflect.get(target, key, receiver);
      reads += 1;
      return reads === 1 ? 1 : target.length;
    },
  });
  await rest.request(messageWithFiles(files));
  assert.equal(sent.length, 1);
  assert.deepEqual(formFields(sent[0].body).map(([key]) => key), ['files[0]', 'payload_json']);
});

test('files stay refused inside a private extension and a protected attempt', async () => {
  let calls = 0;
  const rest = createSyntheticRest({ post() { calls += 1; return { id: '34567890123456789' }; } });
  installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2', privateGuildIds: [GUILD_ID], resolveChannelGuild: () => GUILD_ID, lock: false,
  });
  await assert.rejects(() => extensionContextRunner.run({
    extensionId: 'test-extension', entry: 'command', name: 'synthetic.execute', sourceGuildId: GUILD_ID,
  }, () => rest.request(messageWithFiles([{ name: 'a.png', data: SYNTHETIC_PNG }]))),
  (error) => error?.code === 'EGRESS_UNINSPECTABLE_FILE');
  // A protected send carries no files of its own; a layer that adds one is still refused.
  const guarded = rest.request;
  rest.request = (options) => guarded({ ...options, files: [{ name: 'a.png', data: SYNTHETIC_PNG }] });
  const channel = installProtectedRest(rest);
  const outcome = await channel.send({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'notice' },
  }, { deadlineMs: 1_000, label: 'safety.public-effects' });
  assert.equal(outcome.kind, 'not_sent');
  assert.equal(outcome.causeCode, 'EGRESS_UNINSPECTABLE_FILE');
  assert.equal(calls, 0);
});

test('a protected request that needs rewriting is refused before its ledger entry and transport', async () => {
  let calls = 0;
  let entered = 0;
  const rest = createSyntheticRest({ post() { calls += 1; return { id: '34567890123456789' }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const channel = installProtectedRest(rest);
  const outcome = await channel.send({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'https://evil.example' },
  }, { deadlineMs: 1_000, label: 'safety.public-effects', onNetworkEntry() { entered += 1; } });
  assert.equal(outcome.kind, 'not_sent');
  assert.equal(outcome.reason, 'refused');
  assert.equal(outcome.causeCode, 'EGRESS_PROTECTED_REWRITE_BLOCKED');
  assert.equal(entered, 0);
  assert.equal(calls, 0);
});

test('protected free-text sources rewrite links before a delivery reaches the egress guard', () => {
  const penalty = buildWorkPenaltyAnnouncementBody({
    id: 1,
    userId: CHANNEL_ID,
    jobName: '值班 https://evil.example',
    penaltyAmount: 10,
    reason: '原因 https://[::1]/',
    appealDeadlineAt: '2026-10-05T00:00:00.000Z',
  });
  const reminder = buildWorkReminderBody({ id: 1, task_type: 'work_report', description: '說明 xhttps://evil.example/' });
  assert.equal(penalty.content.includes('https://'), false);
  assert.equal(reminder.content.includes('https://'), false);
  assert.match(penalty.content, /\[連結已移除\]/u);
  assert.match(reminder.content, /x\[連結已移除\]/u);
});

// ---------------------------------------------------------------------------------------------
// Names written without a scheme (free-nitro.com/claim): Discord may show one as a link, so the guard removes it
// ---------------------------------------------------------------------------------------------

const NO_LINK = '[連結已移除]';

function recordingGuard() {
  const received = [];
  const rest = createSyntheticRest({
    post(route, { body }) { received.push({ route, body }); return { id: '34567890123456789' }; },
    patch(route, { body }) { received.push({ route, body }); return {}; },
  });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const events = [];
  const restore = setEgressSafetyEventHandler((event) => events.push(event.code));
  return { rest, received, events, restore };
}

test('egress replaces a name written without a scheme in every text field a message can carry', async () => {
  const { rest, received, events, restore } = recordingGuard();
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: {
        content: '領獎 free-nitro.com/claim',
        embeds: [{
          title: 'bit.ly/abc',
          description: '請看EVIL.COM的說明',
          author: { name: 'paypa1-secure.top/login?x=1' },
          footer: { text: 'evil-site.xyz' },
          fields: [{ name: 'evil.com', value: 't.me/channel' }, { name: '正常', value: '1.5 倍，v1.1.2' }],
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'poll:1:0', label: 'evil.com/claim' },
            { type: 3, custom_id: 'menu', placeholder: 'bit.ly/abc',
              options: [{ label: 'evil-site.xyz', value: 'one', description: 'free-nitro.com' }] },
          ],
        }],
        poll: { question: { text: 'free-nitro.com?' }, answers: [{ poll_media: { text: 'bit.ly/abc' } }] },
        attachments: [{ id: 0, description: 'EVIL.COM' }],
      },
    });
  } finally {
    restore();
  }
  const [{ body }] = received;
  assert.equal(body.content, `領獎 ${NO_LINK}`);
  const [embed] = body.embeds;
  assert.equal(embed.title, NO_LINK);
  assert.equal(embed.description, `請看${NO_LINK}的說明`);
  assert.equal(embed.author.name, NO_LINK);
  assert.equal(embed.footer.text, NO_LINK);
  assert.deepEqual(embed.fields, [{ name: NO_LINK, value: NO_LINK }, { name: '正常', value: '1.5 倍，v1.1.2' }]);
  const [button, menu] = body.components[0].components;
  assert.equal(button.label, NO_LINK);
  assert.equal(button.custom_id, 'poll:1:0');
  assert.equal(menu.placeholder, NO_LINK);
  assert.deepEqual(menu.options, [{ label: NO_LINK, value: 'one', description: NO_LINK }]);
  assert.equal(body.poll.question.text, `${NO_LINK}?`);
  assert.equal(body.poll.answers[0].poll_media.text, NO_LINK);
  assert.equal(body.attachments[0].description, NO_LINK);
  assert.doesNotMatch(JSON.stringify(body), /free-nitro|bit\.ly|evil|paypa1|t\.me/iu);
  // One request, one routine event, as for any other link.
  assert.deepEqual(events, ['EGRESS_LINK_REWRITTEN']);
});

test('egress replaces a name in a thread name, a webhook name and the data of an interaction response', async () => {
  const { rest, received } = recordingGuard();
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/threads`, body: { name: 'free-nitro.com/claim 討論', type: 11 },
  });
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/threads`, body: { name: 'bit.ly/abc' },
  });
  await rest.request({
    method: 'POST', fullRoute: `/webhooks/${CHANNEL_ID}/synthetic-token`,
    body: { content: 'ok', username: 'EVIL.COM', thread_name: 't.me/channel' },
  });
  await rest.request({
    method: 'POST', fullRoute: `/interactions/${MESSAGE_ID}/synthetic-token/callback`,
    body: { type: 4, data: { content: '請看 evil-site.xyz/login', embeds: [{ title: 'paypa1-secure.top' }] } },
  });
  assert.equal(received[0].body.name, `${NO_LINK} 討論`);
  assert.equal(received[1].body.name, NO_LINK);
  assert.equal(received[2].body.username, NO_LINK);
  assert.equal(received[2].body.thread_name, NO_LINK);
  assert.equal(received[3].body.data.content, `請看 ${NO_LINK}`);
  assert.equal(received[3].body.data.embeds[0].title, NO_LINK);
});

test('the identifier of a control is not read for names, but a link written into it is still removed', async () => {
  const { rest, received, events, restore } = recordingGuard();
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: {
        content: '遊戲',
        components: [{ type: 1, components: [
          { type: 2, style: 1, custom_id: 'board|1|abcdef|3|act.top', label: '走棋' },
          { type: 2, style: 1, custom_id: 'solo|1|abcdef|2|move.t', label: '輸入' },
          { type: 2, style: 1, custom_id: 'x https://evil.example/y', label: '其他' },
        ] }],
      },
    });
  } finally {
    restore();
  }
  const ids = received[0].body.components[0].components.map((component) => component.custom_id);
  assert.deepEqual(ids, ['board|1|abcdef|3|act.top', 'solo|1|abcdef|2|move.t', `x ${NO_LINK}`]);
  assert.deepEqual(events, ['EGRESS_LINK_REWRITTEN']);
});

test('what the bot ordinarily writes passes the guard unchanged, with no event', async () => {
  const { rest, received, events, restore } = recordingGuard();
  const releasePage = 'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.1.2';
  const content = [
    '小吉 v1.1.2 版本資訊：見 /help 或 /work submit task-id:3', `最新版本：${releasePage}`,
    '加入伺服器：https://discord.gg/TqkCx9kYmk', '氣象資料：https://opendata.cwa.gov.tw/dist/opendata-swagger.html',
    '1.5 倍加成，12:30 開始，餘額 1,000.50 吉幣', '匯出檔案：coin-role-preview.txt、members.csv、board-panel.png',
    '2026-10-12T00:00:00.000Z', 'user@example.com', 'OK.Fine，ok.me，e.g. README.md 與 main.py',
  ].join('\n');
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: {
        content,
        embeds: [{ title: '小吉 v1.1.2', description: content, fields: [{ name: '版本', value: 'v1.1.2' }],
          footer: { text: '2026-10-12' }, timestamp: '2026-10-12T00:00:00.000Z' }],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: '版本頁面', url: releasePage }] }],
      },
    });
  } finally {
    restore();
  }
  const [{ body }] = received;
  assert.equal(body.content, content);
  assert.equal(body.embeds[0].description, content);
  assert.equal(body.embeds[0].timestamp, '2026-10-12T00:00:00.000Z');
  assert.equal(body.components[0].components[0].url, releasePage);
  assert.deepEqual(events, []);
});

test('an admitted text file keeps the names written in it: links with a scheme and invites go, dotted keys stay', async () => {
  let received;
  const rest = createSyntheticRest({ post(route, request) { received = request; return { id: '34567890123456789' }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  // A file is not a message: Discord shows no links in it, and an export of settings is full of dotted keys
  // (announcement.channel.id) and sites (mysite.com) that are names, not addresses. Rewriting them would
  // corrupt the file and make its keys collide.
  const data = Buffer.from('Alpha free-nitro.com/claim (1)\nBeta v1.1.2 README.md\n', 'utf8');
  await rest.request(messageWithFiles([{ name: 'coin-role-preview.txt', data }]));
  assert.equal(received.files[0].data.toString('utf8'), 'Alpha free-nitro.com/claim (1)\nBeta v1.1.2 README.md\n');
  const exported = JSON.stringify({
    'announcement.channel.id': '1', 'welcome.message': 'hi', site: 'mysite.com', 'logging.info': true, 'app.name': 'x',
    'logging.name': 'y',
  }, null, 1);
  await rest.request(messageWithFiles([{ name: 'settings-export.txt', data: Buffer.from(exported, 'utf8') }]));
  assert.equal(received.files[0].data.toString('utf8'), exported);
  assert.deepEqual(JSON.parse(received.files[0].data.toString('utf8')), JSON.parse(exported));
  // A link with a scheme, an invite and a look-alike address are still removed from the file.
  const links = [
    'Alpha https://evil.example/x (1)', 'Beta discord.gg/abc', 'Gamma https://\u{1F381}.ws/nitro',
    'Delta https://\u{24d4}\u{24e5}\u{24d8}\u{24db}.com/claim', 'Epsilon [x](https://evil.example)', 'www.evil.example',
    'discord.com/invite/abc', 'Theta <https://evil.example>',
  ].join('\n');
  await rest.request(messageWithFiles([{ name: 'coin-role-preview.txt', data: Buffer.from(links, 'utf8') }]));
  assert.deepEqual(received.files[0].data.toString('utf8').split('\n'), [
    `Alpha ${NO_LINK} (1)`, `Beta ${NO_LINK}`, `Gamma ${NO_LINK}`, `Delta ${NO_LINK}`, `Epsilon x ${NO_LINK}`, NO_LINK,
    NO_LINK, `Theta ${NO_LINK}`,
  ]);
});

test('a protected request holding a name is refused, and the free-text sources clean the name first', async () => {
  let sent = 0;
  const rest = createSyntheticRest({ post() { sent += 1; return { id: '34567890123456789' }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const channel = installProtectedRest(rest);
  const request = (body) => ({ method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body });
  const options = { deadlineMs: 1_000, label: 'safety.public-effects' };
  const refused = await channel.send(request({ content: 'free-nitro.com/claim' }), options);
  assert.equal(refused.kind, 'not_sent');
  assert.equal(refused.causeCode, 'EGRESS_PROTECTED_REWRITE_BLOCKED');
  assert.equal(sent, 0);

  const reminder = buildWorkReminderBody({ id: 1, task_type: 'work_report', description: '說明 free-nitro.com/claim' });
  const penalty = buildWorkPenaltyAnnouncementBody({
    id: 2, userId: CHANNEL_ID, jobName: '值班 bit.ly/abc', penaltyAmount: 10, reason: '原因 EVIL.COM',
    appealDeadlineAt: '2026-10-05T00:00:00.000Z',
  });
  assert.match(reminder.content, /說明 \[連結已移除\]/u);
  assert.doesNotMatch(penalty.content, /bit\.ly|EVIL\.COM/iu);
  for (const body of [reminder, penalty]) {
    const outcome = await channel.send(request(body), options);
    assert.equal(outcome.kind, 'confirmed');
  }
  assert.equal(sent, 2);
});

// ---------------------------------------------------------------------------------------------
// An https:// address that starts with an emoji, a symbol or a look-alike letter
// ---------------------------------------------------------------------------------------------

// Discord takes everything after "https://" up to the next space for the link, and a browser maps a circled
// letter back to its ASCII letter: the second of these is evil.com.
const EMOJI_LINK = 'https://\u{1F381}.ws/nitro';
const CIRCLED_LINK = 'https://\u{24d4}\u{24e5}\u{24d8}\u{24db}.com/claim';

test('egress replaces an https:// address that starts with an emoji or a look-alike letter in every text field of a message', async () => {
  const { rest, received, events, restore } = recordingGuard();
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: {
        content: `領獎 ${EMOJI_LINK} ${CIRCLED_LINK}`,
        embeds: [{
          title: EMOJI_LINK,
          description: `請看${CIRCLED_LINK}。`,
          author: { name: EMOJI_LINK },
          footer: { text: CIRCLED_LINK },
          fields: [{ name: EMOJI_LINK, value: CIRCLED_LINK }, { name: '正常', value: '1.5 倍，v1.1.2' }],
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'poll:1:0', label: CIRCLED_LINK },
            { type: 3, custom_id: 'menu', placeholder: EMOJI_LINK,
              options: [{ label: CIRCLED_LINK, value: 'one', description: EMOJI_LINK }] },
          ],
        }],
        poll: { question: { text: EMOJI_LINK }, answers: [{ poll_media: { text: CIRCLED_LINK } }] },
        attachments: [{ id: 0, description: CIRCLED_LINK }],
      },
    });
  } finally {
    restore();
  }
  const [{ body }] = received;
  assert.equal(body.content, `領獎 ${NO_LINK} ${NO_LINK}`);
  const [embed] = body.embeds;
  assert.equal(embed.title, NO_LINK);
  assert.equal(embed.description, `請看${NO_LINK}。`);
  assert.equal(embed.author.name, NO_LINK);
  assert.equal(embed.footer.text, NO_LINK);
  assert.deepEqual(embed.fields, [{ name: NO_LINK, value: NO_LINK }, { name: '正常', value: '1.5 倍，v1.1.2' }]);
  const [button, menu] = body.components[0].components;
  assert.equal(button.label, NO_LINK);
  assert.equal(menu.placeholder, NO_LINK);
  assert.deepEqual(menu.options, [{ label: NO_LINK, value: 'one', description: NO_LINK }]);
  assert.equal(body.poll.question.text, NO_LINK);
  assert.equal(body.poll.answers[0].poll_media.text, NO_LINK);
  assert.equal(body.attachments[0].description, NO_LINK);
  assert.doesNotMatch(JSON.stringify(body), /\u{1F381}|\u{24d4}|nitro|claim/u);
  assert.deepEqual(events, ['EGRESS_LINK_REWRITTEN']);
});

test('egress replaces such an address in a thread name, a webhook name, an interaction response and a control identifier', async () => {
  const { rest, received } = recordingGuard();
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/threads`, body: { name: `${EMOJI_LINK} 討論`, type: 11 },
  });
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/threads`, body: { name: CIRCLED_LINK },
  });
  await rest.request({
    method: 'POST', fullRoute: `/webhooks/${CHANNEL_ID}/synthetic-token`,
    body: { content: EMOJI_LINK, username: CIRCLED_LINK, thread_name: EMOJI_LINK },
  });
  await rest.request({
    method: 'POST', fullRoute: `/interactions/${MESSAGE_ID}/synthetic-token/callback`,
    body: { type: 4, data: { content: `請看 ${CIRCLED_LINK}`, embeds: [{ title: EMOJI_LINK }] } },
  });
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
    body: { content: '遊戲', components: [{ type: 1, components: [
      { type: 2, style: 1, custom_id: `x ${EMOJI_LINK}`, label: '走棋' },
    ] }] },
  });
  assert.equal(received[0].body.name, `${NO_LINK} 討論`);
  assert.equal(received[1].body.name, NO_LINK);
  assert.equal(received[2].body.content, NO_LINK);
  assert.equal(received[2].body.username, NO_LINK);
  assert.equal(received[2].body.thread_name, NO_LINK);
  assert.equal(received[3].body.data.content, `請看 ${NO_LINK}`);
  assert.equal(received[3].body.data.embeds[0].title, NO_LINK);
  assert.equal(received[4].body.components[0].components[0].custom_id, `x ${NO_LINK}`);
});

test('egress replaces such an address in a text file as well, and leaves a dotted key in it', async () => {
  let received;
  const rest = createSyntheticRest({ post(route, request) { received = request; return { id: MESSAGE_ID }; } });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const data = Buffer.from(`${EMOJI_LINK}\n${CIRCLED_LINK}\nkey.name = value\n`, 'utf8');
  await rest.request(messageWithFiles([{ name: 'members.txt', data }]));
  assert.equal(received.files[0].data.toString('utf8'), `${NO_LINK}\n${NO_LINK}\nkey.name = value\n`);
});

// ---------------------------------------------------------------------------------------------
// A forwarded message carries content this guard cannot read
// ---------------------------------------------------------------------------------------------

test('a forwarded message is refused before the transport, in a body, in the data of a response and in a thread', async () => {
  const { rest, received, events, restore } = recordingGuard();
  const refused = (error) => error?.code === 'EGRESS_FORWARD_BLOCKED' && error.terminal === true;
  const forward = { type: 1, message_id: MESSAGE_ID, channel_id: CHANNEL_ID };
  try {
    await assert.rejects(() => rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { message_reference: forward },
    }), refused);
    await assert.rejects(() => rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: { content: '看', message_reference: { ...forward, guild_id: GUILD_ID } },
    }), refused);
    await assert.rejects(() => rest.request({
      method: 'POST', fullRoute: `/interactions/${MESSAGE_ID}/synthetic-token/callback`,
      body: { type: 4, data: { content: 'x', message_reference: forward } },
    }), refused);
    await assert.rejects(() => rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/threads`,
      body: { name: 't', message: { content: 'x', message_reference: forward } },
    }), refused);
    // A type that is not the default one is refused as well, so is a reference that is not a plain object.
    for (const message_reference of [{ type: 2, message_id: MESSAGE_ID }, { type: '1', message_id: MESSAGE_ID }, 'x', [forward]]) {
      await assert.rejects(() => rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content: 'x', message_reference },
      }), refused);
    }
  } finally {
    restore();
  }
  assert.equal(received.length, 0);
  assert.equal(events.length, 8);
  assert.ok(events.every((code) => code === 'EGRESS_FORWARD_BLOCKED'));
  // The check a caller can run without sending says the same.
  const guard = installEgressGuard(createSyntheticRest({ post() { return {}; } }), { approvedReleaseTag: 'v1.1.2' });
  assert.deepEqual(guard.preflight({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { message_reference: forward },
  }), { allowed: false, code: 'EGRESS_FORWARD_BLOCKED' });
});

test('a reply, with a default type or none, is still sent, and its content is checked like any other', async () => {
  const { rest, received } = recordingGuard();
  const replies = [
    { message_id: MESSAGE_ID, fail_if_not_exists: false },
    { type: 0, message_id: MESSAGE_ID, channel_id: CHANNEL_ID },
    { type: null, message_id: MESSAGE_ID },
  ];
  for (const message_reference of replies) {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: { content: '回覆 free-nitro.com/claim', message_reference },
    });
  }
  assert.equal(received.length, 3);
  for (const { body } of received) assert.equal(body.content, `回覆 ${NO_LINK}`);
  assert.deepEqual(received.map(({ body }) => body.message_reference), replies);
});

// ---------------------------------------------------------------------------------------------
// The value of a select option or an autocomplete choice is read back by the bot, not read by people
// ---------------------------------------------------------------------------------------------

test('the value of a select option and of an autocomplete choice is not read for names, and a link in it is removed', async () => {
  const { rest, received, events, restore } = recordingGuard();
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: {
        content: '選單',
        components: [{ type: 1, components: [{
          type: 3, custom_id: 'solo|1|menu', placeholder: '選一個',
          options: [
            { label: '一', value: 'solo:tetris' },
            { label: '二', value: 'board:casino.dice' },
            { label: '三', value: 'act.top', description: 'evil.com/claim' },
            { label: '四', value: 'x https://evil.example/y' },
            { label: '五', value: `y ${EMOJI_LINK}` },
          ],
        }] }],
      },
    });
    await rest.request({
      method: 'POST', fullRoute: `/interactions/${MESSAGE_ID}/synthetic-token/callback`,
      body: { type: 8, data: { choices: [
        { name: '大', value: 'big' }, { name: '指定 7 點', value: 'seven.top' }, { name: 'evil.com', value: 'user.name' },
        { name: 'x', value: 'z discord.gg/abc' },
      ] } },
    });
  } finally {
    restore();
  }
  const { options } = received[0].body.components[0].components[0];
  assert.deepEqual(options.map((option) => option.value),
    ['solo:tetris', 'board:casino.dice', 'act.top', `x ${NO_LINK}`, `y ${NO_LINK}`]);
  // The text people read is still read: the description of an option, and the name of a choice.
  assert.equal(options[2].description, NO_LINK);
  assert.deepEqual(received[1].body.data.choices, [
    { name: '大', value: 'big' }, { name: '指定 7 點', value: 'seven.top' }, { name: NO_LINK, value: 'user.name' },
    { name: 'x', value: `z ${NO_LINK}` },
  ]);
  assert.deepEqual(events, ['EGRESS_LINK_REWRITTEN', 'EGRESS_LINK_REWRITTEN']);
});

test('only those positions are exempt: the field of an embed, the content and a text input keep being read for names', async () => {
  const { rest, received } = recordingGuard();
  await rest.request({
    method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
    body: {
      content: 'evil.com/claim',
      embeds: [{ title: 'x', fields: [{ name: 'a', value: 'free-nitro.com/claim' }, { name: 'bit.ly/abc', value: 'b' }] }],
      components: [{ type: 1, components: [
        { type: 4, custom_id: 'input', label: '輸入', value: 'user.name evil.com/x' },
      ] }],
    },
  });
  const [{ body }] = received;
  assert.equal(body.content, NO_LINK);
  assert.deepEqual(body.embeds[0].fields, [{ name: 'a', value: NO_LINK }, { name: NO_LINK, value: 'b' }]);
  assert.equal(body.components[0].components[0].value, `user.name ${NO_LINK}`);
});

// ---------------------------------------------------------------------------------------------
// An approved address in Markdown emphasis, and text about "https://"
// ---------------------------------------------------------------------------------------------

test('an approved link wrapped in Markdown emphasis passes the guard unchanged, in a protected request too', async () => {
  const content = [
    '**https://discord.gg/TqkCx9kYmk**',
    '__https://github.com/xichengyu810067-lab/xiaoji-formal/releases__',
    '~~https://data.gov.tw/dataset/102011~~',
  ].join('\n');
  const { rest, received, events, restore } = recordingGuard();
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: { content, embeds: [{ description: content }] },
    });
  } finally {
    restore();
  }
  assert.equal(received[0].body.content, content);
  assert.equal(received[0].body.embeds[0].description, content);
  assert.deepEqual(events, []);

  let sent = 0;
  const protectedRest = createSyntheticRest({ post() { sent += 1; return { id: MESSAGE_ID }; } });
  installEgressGuard(protectedRest, { approvedReleaseTag: 'v1.1.2' });
  const channel = installProtectedRest(protectedRest);
  const outcome = await channel.send(
    { method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content } },
    { deadlineMs: 1_000, label: 'safety.public-effects' });
  assert.equal(outcome.kind, 'confirmed');
  assert.equal(sent, 1);
});

test('text that is written about "https://" passes the guard unchanged, and an ideographic dot does not hide a host', async () => {
  const text = [
    '網址要以https://開頭', '請輸入以https://開頭的網址', '支援 http://、https://等協定',
    'https://から始まるURL', '格式是 https://＜你的網域＞/api',
  ].join('\n');
  const hidden = ['https://\u{30fb}領獎。jp/x', 'https://「evil。com/x', 'https://\u{b7}evil。com',
    'https://\u{2014}evil。com/x', 'https://「領獎。台灣'];
  const { rest, received, events, restore } = recordingGuard();
  try {
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: { content: text, embeds: [{ description: text }] },
    });
    assert.deepEqual(events, []);
    await rest.request({
      method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
      body: { content: hidden.join('\n'), embeds: [{ footer: { text: hidden[0] } }] },
    });
  } finally {
    restore();
  }
  assert.equal(received[0].body.content, text);
  assert.equal(received[0].body.embeds[0].description, text);
  assert.equal(received[1].body.content, Array(hidden.length).fill(NO_LINK).join('\n'));
  assert.equal(received[1].body.embeds[0].footer.text, NO_LINK);
  assert.deepEqual(events, ['EGRESS_LINK_REWRITTEN']);
});

// The runs after "https://" are read by the parser a browser opens them with (test/fixtures/schemeAddressCases.js
// has the rows): an IP address in any spelling, and a name of two labels or more, are addresses; a run the
// parser refuses, or reads as a single label, is text.
function textFieldsOf(body) {
  return [body.content, body.embeds[0].description, body.embeds[0].footer.text, body.embeds[0].fields[0].value];
}

test('an address the parser of a browser reads as a host is removed in every text field, whatever it is made of', async () => {
  const { rest, received, events, restore } = recordingGuard();
  const requests = [];
  try {
    for (let from = 0; from < PARSER_ADDRESSES.length; from += 8) {
      const chunk = PARSER_ADDRESSES.slice(from, from + 8);
      requests.push(chunk);
      const joined = chunk.join('\n');
      await rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
        body: {
          content: `請重複：${joined}`,
          embeds: [{ description: joined, footer: { text: chunk[0] }, fields: [{ name: 'x', value: `**${chunk[0]}**` }] }],
        },
      });
    }
  } finally {
    restore();
  }
  assert.equal(received.length, requests.length);
  assert.ok(PARSER_ADDRESSES.length >= 40);
  for (const [index, chunk] of requests.entries()) {
    const marker = Array(chunk.length).fill(NO_LINK).join('\n');
    const [content, description, footer, field] = textFieldsOf(received[index].body);
    assert.equal(content, `請重複：${marker}`);
    assert.equal(description, marker);
    assert.equal(footer, NO_LINK);
    assert.equal(field, `**${NO_LINK}**`);
  }
  // one event for each request, as for any rewritten text
  assert.deepEqual(events, Array(requests.length).fill('EGRESS_LINK_REWRITTEN'));
});

test('text the parser of a browser refuses or reads as a single label passes the guard unchanged, and the sentences by design go', async () => {
  const text = PARSER_TEXT.map(([sentence]) => sentence);
  const { rest, received, events, restore } = recordingGuard();
  try {
    for (let from = 0; from < text.length; from += 10) {
      const joined = text.slice(from, from + 10).join('\n');
      await rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
        body: { content: joined, embeds: [{ description: joined, footer: { text: text[from] }, fields: [{ name: 'x', value: text[from] }] }] },
      });
    }
    assert.deepEqual(events, []);
    for (const [input] of REMOVED_BY_DESIGN) {
      await rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
        body: { content: input, embeds: [{ description: input, footer: { text: input }, fields: [{ name: 'x', value: input }] }] },
      });
    }
    for (const [input] of [...TEXT_WITH_A_NAME, ...WITH_CONTEXT]) {
      await rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
        body: { content: input, embeds: [{ description: input, footer: { text: input }, fields: [{ name: 'x', value: input }] }] },
      });
    }
  } finally {
    restore();
  }
  const textRequests = Math.ceil(text.length / 10);
  for (let index = 0; index < textRequests; index += 1) {
    const joined = text.slice(index * 10, index * 10 + 10).join('\n');
    const [content, description, footer, field] = textFieldsOf(received[index].body);
    assert.equal(content, joined);
    assert.equal(description, joined);
    assert.equal(footer, text[index * 10]);
    assert.equal(field, text[index * 10]);
  }
  const rewrittenInputs = [...REMOVED_BY_DESIGN, ...TEXT_WITH_A_NAME, ...WITH_CONTEXT];
  for (const [offset, [input, expected]] of rewrittenInputs.entries()) {
    const body = received[textRequests + offset].body;
    assert.deepEqual(textFieldsOf(body), [expected, expected, expected, expected], input);
  }
  assert.deepEqual(events, Array(rewrittenInputs.length).fill('EGRESS_LINK_REWRITTEN'));
});
