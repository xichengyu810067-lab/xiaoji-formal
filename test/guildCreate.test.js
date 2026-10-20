'use strict';

// The bot joining a guild (src/events/guildCreate.js). Guilds are not reviewed: the join is told to the Owner as
// its own event with fixed text, and nothing else follows from it. No record is read or written, no guild is held
// back or left, and what the notice says of the inviter, the member count and the join time is only what Discord
// gave, each value checked, with the word for unknown when it is missing. No Discord call is made: the guilds,
// their audit logs and the bot's member are fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Events, PermissionFlagsBits } = require('discord.js');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-guild-create-');
const AUDIT_PATH = path.join(root, 'guildAudit.json');
const WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.XIAOJI_AUDIT_DATA_PATH = AUDIT_PATH;
process.env.XIAOJI_INVITER_WHITELIST_PATH = WHITELIST_PATH;

const guildCreate = require('../src/events/guildCreate');
const logger = require('../src/utils/logger');
const { SAFETY_EVENT_CODES, setSafetyEventHandler } = require('../src/platform/safetyEventCatalog');
const {
  captureDiscordEventContext,
  getHostOperationContext,
  runWithHostOperationContext,
} = require('../src/platform/hostOperationContext');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { OWNER_EVENT_ACTION, buildOperation } = require('../src/systems/safety/ownerSafetyNotifier');

const GUILD_JOINED = SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED;
const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';
const GUILD_ID = '10000000000000601';
const OTHER_GUILD_ID = '10000000000000602';
const INVITER_ID = '10000000000000701';
const STRANGER_ID = '10000000000000702';
const NOW = 1_800_000_000_000;
const JOINED_AT = NOW - 4_000;
const MINUTE = 60_000;

const AUDIT_FILE_TEXT = `${JSON.stringify({
  [GUILD_ID]: { guildId: GUILD_ID, status: 'unknown', manualAudit: true },
  [OTHER_GUILD_ID]: { guildId: OTHER_GUILD_ID, status: 'denied', reason: 'Audit timeout (24h)' },
}, null, 2)}\n`;

test.after(() => {
  removeRealTempDir(root);
});

function quiet(t) {
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  const lines = [];
  logger.info = (message) => lines.push(['info', String(message)]);
  logger.warn = (message) => lines.push(['warn', String(message)]);
  logger.error = (message) => lines.push(['error', String(message)]);
  t.after(() => Object.assign(logger, original));
  return lines;
}

// A guild as GUILD_CREATE hands it over (a null count or join time is one Discord did not give). `entry` is the
// newest bot-add entry of its audit log (or none), `me` the bot's member in the cache, and every call that could
// change something is counted.
function createGuild({
  id = GUILD_ID,
  name = '合成伺服器',
  memberCount = 42,
  joinedTimestamp = JOINED_AT,
  me = undefined,
  fetchedMe = undefined,
  entry = { target: { id: BOT_ID }, executor: { id: INVITER_ID }, createdTimestamp: NOW - 5_000 },
  auditFailure = null,
  permitted = true,
} = {}) {
  const calls = { leave: 0, rest: [], auditLogs: 0, fetchMe: 0 };
  const whole = {
    id: BOT_ID, partial: false,
    permissions: { has: (flag) => permitted && flag === PermissionFlagsBits.ViewAuditLog },
  };
  const guild = {
    id,
    name,
    ...(memberCount === null ? {} : { memberCount }),
    ...(joinedTimestamp === null ? {} : { joinedTimestamp }),
    client: {
      user: { id: BOT_ID },
      rest: { request: async (details) => { calls.rest.push(details); }, delete: async (route) => { calls.rest.push(['DELETE', route]); } },
    },
    members: {
      me: me === undefined ? whole : me,
      async fetchMe() {
        calls.fetchMe += 1;
        if (fetchedMe instanceof Error) throw fetchedMe;
        return fetchedMe === undefined ? whole : fetchedMe;
      },
    },
    async fetchAuditLogs() {
      calls.auditLogs += 1;
      if (auditFailure) throw auditFailure;
      return { entries: { first: () => entry } };
    },
    async leave() { calls.leave += 1; },
  };
  return { guild, calls };
}

// Runs the event as the host runs it: in the context of its own GUILD_CREATE, with the safety handler recording what
// the catalogue was given, and the host context the notifier would read at that moment.
async function join(guild, { policy = null, now = () => NOW } = {}) {
  const emitted = [];
  const restore = setSafetyEventHandler((event) => emitted.push({ event, context: getHostOperationContext() }));
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    guild.client.testControlPolicy = policy;
    const context = captureDiscordEventContext(Events.GuildCreate, [guild], {
      publicEffectAuthority: createPublicEffectAuthority(), now,
    });
    await runWithHostOperationContext(context, () => guildCreate.execute(guild));
  } finally {
    Date.now = originalNow;
    restore();
  }
  return emitted;
}

test('a new guild is told to the Owner once, as its own event, with the facts Discord gave and a context the notifier accepts', async (t) => {
  quiet(t);
  const { guild, calls } = createGuild();

  const emitted = await join(guild);

  assert.equal(guildCreate.name, 'guildCreate');
  assert.equal(emitted.length, 1);
  const [{ event, context }] = emitted;
  assert.equal(event.code, GUILD_JOINED);
  assert.equal(event.category, 'guild-join');
  assert.equal(event.actorId, BOT_ID);
  assert.equal(event.guildId, GUILD_ID);
  assert.equal(event.guildName, '合成伺服器');
  assert.deepEqual({ ...event.notice }, {
    subjectId: null, subjectName: '', subjectUsername: '', joinedAtMs: JOINED_AT, leftAtMs: null,
    memberCount: 42, inviterId: INVITER_ID, outageStartedAtMs: null, outageEndedAtMs: null, outageKind: null, alertKind: null,
  });
  assert.equal(emitted.some(({ event: seen }) => seen.code.startsWith('AUDIT_')), false);
  assert.equal(calls.leave, 0);
  assert.deepEqual(calls.rest, []);

  // The context the join ran in: the guild and the time of the join, acted by the bot.
  assert.equal(context.sourceEventId, `${GUILD_ID}.${JOINED_AT}`);
  assert.equal(context.guildId, GUILD_ID);
  assert.equal(context.actorId, BOT_ID);
  assert.equal(context.hostPurpose, 'discord.guildCreate');
  assert.equal(context.scope, `guild:${GUILD_ID}`);
  const operation = buildOperation(event, context, OWNER_ID);
  assert.ok(operation, 'the notifier takes the event');
  assert.equal(operation.action, OWNER_EVENT_ACTION);
  assert.equal(operation.budgetClass, 'owner-guild-join');
  assert.equal(operation.target, `${OWNER_ID}:guild-join`);
  assert.equal(operation.mergeKey, `owner-join-v1:${GUILD_ID}`);
  assert.equal(operation.sourceKey, `discord.guildCreate:guild:${GUILD_ID}:actor:${BOT_ID}`);
  // The source has no snowflake time of its own, so the time of the event stands for it.
  assert.equal(operation.sourceTimeMs, event.at);
  const { content, allowed_mentions: mentions } = operation.payload;
  assert.match(content, new RegExp(`^小吉新伺服器加入通知。固定代碼：OWNER_EVENT_GUILD_JOINED；伺服器 ID：${GUILD_ID}；`, 'u'));
  assert.ok(content.includes(`邀請者 ID：${INVITER_ID}`), content);
  assert.ok(content.includes('成員數：42'), content);
  assert.ok(content.includes(`<t:${Math.floor(JOINED_AT / 1_000)}:F>`), content);
  assert.ok(content.endsWith('伺服器：「合成伺服器」'), content);
  assert.deepEqual(mentions, { parse: [], users: [], roles: [], replied_user: false });
});

test('no record is read or written: an audit file that is whole, unreadable or missing is left as it is, and the notice goes out', async (t) => {
  quiet(t);
  const states = [
    ['whole', () => fs.writeFileSync(AUDIT_PATH, AUDIT_FILE_TEXT)],
    ['unreadable', () => { fs.rmSync(AUDIT_PATH, { recursive: true, force: true }); fs.mkdirSync(AUDIT_PATH); }],
    ['missing', () => fs.rmSync(AUDIT_PATH, { recursive: true, force: true })],
  ];
  for (const [label, arrange] of states) {
    fs.rmSync(AUDIT_PATH, { recursive: true, force: true });
    arrange();
    const before = fs.existsSync(AUDIT_PATH) && fs.statSync(AUDIT_PATH).isFile() ? fs.readFileSync(AUDIT_PATH) : null;
    const { guild, calls } = createGuild();

    const emitted = await join(guild);

    assert.equal(emitted.length, 1, label);
    assert.equal(emitted[0].event.code, GUILD_JOINED, label);
    assert.equal(calls.leave, 0, label);
    if (label === 'whole') assert.deepEqual(fs.readFileSync(AUDIT_PATH), before, label);
    if (label === 'unreadable') assert.equal(fs.statSync(AUDIT_PATH).isDirectory(), true, label);
    if (label === 'missing') assert.equal(fs.existsSync(AUDIT_PATH), false, label);
    // Nothing next to it either: no temporary file of a write, no whitelist.
    assert.deepEqual(fs.readdirSync(root).filter((name) => name !== 'guildAudit.json'), [], label);
  }
  fs.rmSync(AUDIT_PATH, { recursive: true, force: true });
});

test('a guild whose old record says pending, unknown or denied is told like any other, and never left', async (t) => {
  quiet(t);
  fs.writeFileSync(AUDIT_PATH, AUDIT_FILE_TEXT);
  for (const id of [GUILD_ID, OTHER_GUILD_ID, '10000000000000603']) {
    const { guild, calls } = createGuild({ id });
    const emitted = await join(guild);
    assert.equal(emitted.length, 1, id);
    assert.equal(emitted[0].event.guildId, id);
    assert.equal(calls.leave, 0, id);
    assert.deepEqual(calls.rest, [], id);
  }
  assert.equal(fs.readFileSync(AUDIT_PATH, 'utf8'), AUDIT_FILE_TEXT);
  fs.rmSync(AUDIT_PATH, { force: true });
});

test('without the permission to view the audit log the inviter is not looked for, and the notice still goes out', async (t) => {
  quiet(t);
  const { guild, calls } = createGuild({ permitted: false });

  const emitted = await join(guild);

  assert.equal(calls.auditLogs, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event.notice.inviterId, null);
  const operation = buildOperation(emitted[0].event, emitted[0].context, OWNER_ID);
  assert.ok(operation.payload.content.includes('邀請者 ID：未知'), operation.payload.content);
});

test('an audit log entry that is old, about another bot, or from the far future is not taken as the inviter', async (t) => {
  quiet(t);
  const cases = [
    ['fresh', { target: { id: BOT_ID }, executor: { id: INVITER_ID }, createdTimestamp: NOW - 119_000 }, INVITER_ID],
    ['two minutes and a second old', { target: { id: BOT_ID }, executor: { id: INVITER_ID }, createdTimestamp: NOW - 2 * MINUTE - 1_000 }, null],
    ['an earlier add of the bot, months ago', { target: { id: BOT_ID }, executor: { id: INVITER_ID }, createdTimestamp: NOW - 90 * 24 * 60 * MINUTE }, null],
    ['from the far future', { target: { id: BOT_ID }, executor: { id: INVITER_ID }, createdTimestamp: NOW + 10 * MINUTE }, null],
    ['another bot', { target: { id: STRANGER_ID }, executor: { id: INVITER_ID }, createdTimestamp: NOW - 1_000 }, null],
    ['no time at all', { target: { id: BOT_ID }, executor: { id: INVITER_ID } }, null],
    ['no executor', { target: { id: BOT_ID }, createdTimestamp: NOW - 1_000 }, null],
    ['no entry', null, null],
  ];
  for (const [label, entry, expected] of cases) {
    const { guild } = createGuild({ entry });
    const emitted = await join(guild);
    assert.equal(emitted.length, 1, label);
    assert.equal(emitted[0].event.notice.inviterId, expected, label);
  }
});

test('a bot member that cannot be had, or an audit log that fails, never stops the notice', async (t) => {
  const lines = quiet(t);
  const partial = { id: BOT_ID, partial: true, permissions: { has: () => true } };
  const variants = [
    ['no member at all, and fetching it fails', createGuild({ me: null, fetchedMe: new Error('synthetic fetch failure') })],
    ['a partial member, and the fetch answers a partial one', createGuild({ me: partial, fetchedMe: partial })],
    ['an audit log that cannot be fetched', createGuild({ auditFailure: new Error('Missing Access') })],
  ];
  for (const [label, { guild, calls }] of variants) {
    const emitted = await join(guild);
    assert.equal(emitted.length, 1, label);
    assert.equal(emitted[0].event.notice.inviterId, null, label);
    assert.equal(calls.leave, 0, label);
  }
  assert.ok(lines.some(([level, line]) => level === 'warn' && line.includes('Failed to fetch audit logs')));
  // A failure of the lookup is logged by its message only, never as an unhandled rejection.
  assert.equal(lines.some(([level]) => level === 'error'), false);
});

test('a join time or member count Discord did not give is left out, and the notice says unknown for it', async (t) => {
  quiet(t);
  for (const [label, overrides] of [
    ['neither of them', { memberCount: null, joinedTimestamp: null }],
    ['wrong kinds of value', { memberCount: '42', joinedTimestamp: -5 }],
  ]) {
    const { guild } = createGuild(overrides);
    const emitted = await join(guild);
    assert.equal(emitted.length, 1, label);
    const [{ event, context }] = emitted;
    assert.equal(event.notice.memberCount, null, label);
    assert.equal(event.notice.joinedAtMs, null, label);
    // The context still exists: the moment the event was seen stands in for the join time.
    assert.equal(context.sourceEventId, `${GUILD_ID}.${NOW}`, label);
    const operation = buildOperation(event, context, OWNER_ID);
    assert.ok(operation, label);
    assert.ok(operation.payload.content.includes('加入時間：未知'), operation.payload.content);
    assert.ok(operation.payload.content.includes('成員數：未知'), operation.payload.content);
  }
});

test('the same join seen again is the same operation, and another join of the guild merges with it', async (t) => {
  quiet(t);
  const operationOf = async (guild) => {
    const [{ event, context }] = await join(guild);
    return buildOperation(event, context, OWNER_ID);
  };
  const first = await operationOf(createGuild().guild);
  // A reconnect sends the guild again: the event layer holds nothing back, and does not turn one join into two.
  const again = await operationOf(createGuild().guild);
  assert.equal(again.operationId, first.operationId);
  assert.equal(again.mergeKey, first.mergeKey);
  // The bot added again later is another join of the same guild: another operation, merged by the same key.
  const later = await operationOf(createGuild({ joinedTimestamp: JOINED_AT + 3 * 24 * 60 * MINUTE }).guild);
  assert.notEqual(later.operationId, first.operationId);
  assert.equal(later.mergeKey, first.mergeKey);
  // Another guild never shares an operation or a merge key.
  const other = await operationOf(createGuild({ id: OTHER_GUILD_ID }).guild);
  assert.notEqual(other.operationId, first.operationId);
  assert.notEqual(other.mergeKey, first.mergeKey);
});

test('what a guild owner chose as its name cannot carry a mention or a link into the notice', async (t) => {
  quiet(t);
  const { guild } = createGuild({ name: '@everyone 看這裡 https://evil.example/join <@123456789012345678>' });

  const [{ event, context }] = await join(guild);
  const { content, allowed_mentions: mentions } = buildOperation(event, context, OWNER_ID).payload;

  assert.equal(content.includes('@everyone'), false, content);
  assert.equal(content.includes('https://'), false, content);
  assert.equal(content.includes('<@'), false, content);
  assert.deepEqual(mentions, { parse: [], users: [], roles: [], replied_user: false });
});

test('under test-control the join passes the ingress check first and is turned away without the event allowed', async (t) => {
  quiet(t);
  const denied = [];
  const policy = (allowed) => ({
    allowsEvent: (name) => allowed.includes(name),
    allowsGuild: () => true,
    allowsChannel: () => true,
    reporter: { deny: (code, operation) => denied.push([code, operation]) },
  });
  const { guild, calls } = createGuild();

  assert.deepEqual(await join(guild, { policy: policy([]) }), []);
  assert.deepEqual(denied, [['TEST_EVENT_DENIED', 'event_ingress']]);
  assert.equal(calls.auditLogs, 0, 'a denied event looks nothing up');
  const allowed = await join(guild, { policy: policy(['guildCreate']) });
  assert.equal(allowed.length, 1);
  assert.equal(denied.length, 1);
});
