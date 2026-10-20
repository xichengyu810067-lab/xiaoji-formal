'use strict';

// The public notice of an outage that ended: one fixed message in each server the bot was in
// before the outage began, sent at most once, and never made up for with anything else. The
// monitor is the real one (liveness record in a temporary folder, injected clock); the REST is a
// real @discordjs/rest answered by handlers, so nothing reaches Discord.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { makeRealTempDir } = require('./support/realTempDir');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const {
  HEARTBEAT_MS,
  STABLE_AFTER_READY_MS,
  STATE_FILE_NAME,
  createOutageMonitor,
  outageIdFor,
} = require('../src/systems/safety/outageMonitor');
const {
  GUILD_NOTICE_INTERVAL_MS,
  GUILD_SPACING_MS,
  MAX_ATTEMPTS,
  createOutageNotice,
  outageNoticeText,
  ownerSourceEventId,
} = require('../src/systems/safety/outageNotice');
const { buildOperation } = require('../src/systems/safety/ownerSafetyNotifier');
const { SAFETY_EVENT_CODES, setSafetyEventHandler } = require('../src/platform/safetyEventCatalog');
const { getHostOperationContext } = require('../src/platform/hostOperationContext');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { installEgressGuard } = require('../src/platform/egressGuard');
const { rewriteLinks } = require('../src/platform/linkPolicy');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_MS = 1_800_000_000_000;
const BOT_ID = '700000000000000001';
const JOINED = BASE_MS - 30 * DAY;
const NO_MENTIONS = { parse: [], users: [], roles: [], replied_user: false };
const LINK_OPTIONS = { approve: () => null, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true };

const GUILD_1 = '111111111111111111';
const GUILD_2 = '222222222222222222';
const GUILD_3 = '333333333333333333';
const WELCOME_1 = '411111111111111111';
const SYSTEM_1 = '511111111111111111';
const SYSTEM_2 = '522222222222222222';
const SYSTEM_3 = '533333333333333333';
const WELCOME_3 = '433333333333333333';
const OTHER_TEXT = '699999999999999999';

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

function channel(id, { send = true } = {}) {
  return { id, isTextBased: () => true, permissionsFor: () => ({ has: () => send }) };
}

function guild(id, { joinedTimestamp = JOINED, channels = [], systemChannel = null, available = true } = {}) {
  return {
    id,
    joinedTimestamp,
    available,
    channels: { cache: new Map(channels.map((item) => [item.id, item])) },
    systemChannel,
    members: { me: { id: BOT_ID, partial: false } },
  };
}

function defaultGuilds() {
  return [
    guild(GUILD_1, { channels: [channel(WELCOME_1), channel(SYSTEM_1)], systemChannel: channel(SYSTEM_1) }),
    guild(GUILD_2, { systemChannel: channel(SYSTEM_2) }),
    guild(GUILD_3, { channels: [channel(WELCOME_3)], systemChannel: channel(SYSTEM_3) }),
  ];
}

// The world of one test: a bot in some servers, one data folder, one clock, and runs of the
// process that come and go. outage(ms) is a process that was up until the clock stood still for
// `ms` (it never wrote a signal) followed by a new one that is ready and has the notice attached.
function createWorld(t, { guilds = defaultGuilds(), welcome = { [GUILD_1]: WELCOME_1, [GUILD_3]: WELCOME_3 },
  withGuard = false, filesystem = fs, keep = true, ownerNotifier = null, isEligible = undefined } = {}) {
  const root = makeRealTempDir('xiaoji-outage-notice-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: BASE_MS };
  const posts = [];
  const sleeps = [];
  const handlers = {
    respond: () => ({ id: '900000000000000001' }),
    async post(route, { body }) {
      posts.push({ route, body });
      return handlers.respond(route, body, posts.length);
    },
  };
  const rest = createSyntheticRest(handlers);
  const limiter = createEgressLimiter({ now: () => clock.value });
  if (withGuard) {
    const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [], ownerId: '700000000000000009',
      resolveChannelGuild: () => null });
    guard.setAdmission((details) => limiter.admit(details));
  }
  const client = { rest, user: { id: BOT_ID }, egressLimiter: limiter, isReady: () => true,
    guilds: { cache: new Map(guilds.map((item) => [item.id, item])) } };
  const state = () => JSON.parse(fs.readFileSync(path.join(root, STATE_FILE_NAME), 'utf8'));

  function startRun(options = {}, readyOptions = {}) {
    const logger = capturingLogger();
    const monitor = createOutageMonitor({
      runtimeMode: 'production',
      env: { XIAOJI_DATA_ROOT: root },
      coinDbPath: path.join(root, 'xiaoji.sqlite'),
      logger,
      now: () => clock.value,
      monotonic: () => clock.value,
      gatewayHealthy: (candidate) => candidate.isReady(),
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn() {},
      filesystem,
      ...options,
    });
    const notice = createOutageNotice({
      client,
      ownerNotifier,
      ...(isEligible ? { isEligible } : {}),
      logger,
      getConfig: (guildId) => ({ welcomeChannelId: welcome[guildId] ?? null }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    // keep: the pending outage stays in the record after it is delivered, so a test can read what
    // became of each server.
    monitor.attachDelivery(async (store) => {
      const outcome = await notice.deliver(store);
      return keep && outcome === 'complete' ? 'idle' : outcome;
    });
    monitor.begin();
    monitor.noteReady(client, readyOptions);
    return {
      monitor,
      logger,
      // One heartbeat a minute until the process has been steady for the whole wait.
      async steady(extraMs = 0) {
        for (let left = STABLE_AFTER_READY_MS + extraMs; left > 0;) {
          const part = Math.min(HEARTBEAT_MS, left);
          clock.value += part;
          left -= part;
          await monitor.tick();
        }
      },
      // before runs after the clock has moved and just before the heartbeat.
      async beat(ms = HEARTBEAT_MS, before = null) {
        clock.value += ms;
        if (before) before();
        return monitor.tick();
      },
      // Every heartbeat but the last one that would deliver.
      async untilJustBeforeSteady() {
        for (let left = STABLE_AFTER_READY_MS - HEARTBEAT_MS; left > 0;) {
          const part = Math.min(HEARTBEAT_MS, left);
          clock.value += part;
          left -= part;
          await monitor.tick();
        }
      },
    };
  }

  let current = startRun();
  return {
    root, clock, posts, sleeps, handlers, client, limiter, state,
    get run() { return current; },
    // The process was killed (no signal) and a new one is ready `ms` later.
    outage(ms, readyOptions = {}) {
      clock.value += ms;
      current = startRun({}, readyOptions);
      return current;
    },
    guildStatus: (guildId) => state().pending?.guilds?.[guildId],
  };
}

const sentTo = (posts) => posts.map((post) => post.route);
const messagesTo = (...ids) => ids.map((id) => `/channels/${id}/messages`);

test('the text is fixed: the number of minutes and nothing else, with no link and no mention', () => {
  assert.equal(outageNoticeText(12),
    '小吉剛才因為意外狀況暫停運作了約 12 分鐘，現在已經恢復。停運期間發生的事件原則上不會補發，已經排進排程的操作會照原本的規則接續處理。');
  for (const minutes of [1, 10, 11, 59, 60, 61, 1_440, 10_080, 43_200]) {
    const text = outageNoticeText(minutes);
    assert.equal(text.includes(`約 ${minutes} 分鐘`), true);
    assert.equal(rewriteLinks(text, LINK_OPTIONS).rewritten, false, String(minutes));
    assert.doesNotMatch(text, /[<>@#]|https?:|\.\w{2,}\//u);
    assert.equal(text.length < 200, true);
  }
  // Anything that is not a count is one minute; never text.
  for (const bad of [0, -3, 1.5, '12', null, undefined, Number.NaN, '<@everyone>']) {
    assert.equal(outageNoticeText(bad), outageNoticeText(1));
  }
});

test('every server the bot was in gets exactly one fixed message, in order, 1.5 seconds apart', async (t) => {
  const world = createWorld(t);
  const run = world.outage(20 * MINUTE);
  await run.steady();
  // The welcome channel the server set, else its system channel; no other channel is used.
  assert.deepEqual(sentTo(world.posts), messagesTo(WELCOME_1, SYSTEM_2, WELCOME_3));
  const expected = { content: outageNoticeText(20), allowed_mentions: NO_MENTIONS };
  for (const post of world.posts) {
    assert.deepEqual(post.body, expected);
    assert.equal(rewriteLinks(post.body.content, LINK_OPTIONS).rewritten, false);
  }
  assert.deepEqual(world.sleeps, [GUILD_SPACING_MS, GUILD_SPACING_MS]);
  assert.equal(GUILD_SPACING_MS, 1_500);
  // Kept in the liveness record, not a ledger: the claim time of each server and its end.
  const record = world.state();
  assert.deepEqual(Object.keys(record.pending.guilds).sort(), [GUILD_1, GUILD_2, GUILD_3]);
  assert.deepEqual(Object.values(record.pending.guilds), ['sent', 'sent', 'sent']);
  assert.deepEqual(Object.keys(record.guildNoticeAtMs).sort(), [GUILD_1, GUILD_2, GUILD_3]);
  // Later heartbeats send nothing more.
  await run.beat();
  await run.beat();
  assert.equal(world.posts.length, 3);
  assert.equal(run.logger.lines.filter((line) => line.includes('OUTAGE_NOTICE_SENT')).length, 3);
});

test('a server with no welcome channel and no system channel is skipped, with no request and a line', async (t) => {
  const guilds = [
    // Text channels exist, but none is the welcome or the system channel: there is no "first text channel" fallback.
    guild(GUILD_1, { channels: [channel(OTHER_TEXT), channel(WELCOME_1)], systemChannel: null }),
    guild(GUILD_2, { systemChannel: channel(SYSTEM_2) }),
  ];
  const world = createWorld(t, { guilds, welcome: {} });
  const run = world.outage(15 * MINUTE);
  await run.steady();
  assert.deepEqual(sentTo(world.posts), messagesTo(SYSTEM_2));
  assert.equal(world.guildStatus(GUILD_1), 'skipped:no-channel');
  assert.ok(run.logger.lines.includes(`[OUTAGE_NOTICE] code=OUTAGE_NOTICE_SKIPPED guild=${GUILD_1} reason=no-channel`));
  // A welcome channel that no longer exists in the cache falls back to the system channel.
  const gone = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })],
    welcome: { [GUILD_1]: WELCOME_1 } });
  const goneRun = gone.outage(15 * MINUTE);
  await goneRun.steady();
  assert.deepEqual(sentTo(gone.posts), messagesTo(SYSTEM_1));
});

test('a channel the bot cannot write to is not used: the system channel instead, and nothing when neither', async (t) => {
  const guilds = [
    guild(GUILD_1, { channels: [channel(WELCOME_1, { send: false })], systemChannel: channel(SYSTEM_1) }),
    guild(GUILD_2, { systemChannel: channel(SYSTEM_2, { send: false }) }),
  ];
  const world = createWorld(t, { guilds, welcome: { [GUILD_1]: WELCOME_1 } });
  const run = world.outage(15 * MINUTE);
  await run.steady();
  assert.deepEqual(sentTo(world.posts), messagesTo(SYSTEM_1));
  assert.equal(world.guildStatus(GUILD_2), 'skipped:no-permission');
});

test('a server the bot joined after the outage began, or whose join time is unknown, is not told; one it left is not there', async (t) => {
  const world = createWorld(t, { guilds: [
    guild(GUILD_1, { systemChannel: channel(SYSTEM_1) }),
    guild(GUILD_2, { systemChannel: channel(SYSTEM_2), joinedTimestamp: BASE_MS }),
    guild(GUILD_3, { systemChannel: channel(SYSTEM_3), joinedTimestamp: null }),
    guild('444444444444444444', { systemChannel: channel('544444444444444444'), joinedTimestamp: BASE_MS - 1 }),
  ], welcome: {} });
  // The outage began at BASE_MS (the last healthy moment): joined at BASE_MS is not "before", one millisecond earlier is.
  const run = world.outage(20 * MINUTE);
  await run.steady();
  assert.deepEqual(sentTo(world.posts).sort(), messagesTo('544444444444444444', SYSTEM_1).sort());
  assert.equal(world.guildStatus(GUILD_2), 'skipped:joined-later');
  assert.equal(world.guildStatus(GUILD_3), 'skipped:join-unknown');

  // A server the bot left during the outage is no longer in the cache: nothing is sent to it.
  const left = createWorld(t);
  const leftRun = left.outage(20 * MINUTE);
  left.client.guilds.cache.delete(GUILD_2);
  await leftRun.steady();
  assert.deepEqual(sentTo(left.posts), messagesTo(WELCOME_1, WELCOME_3));
});

test('which servers may be told is one function that says every server by default, and that can keep one out', async (t) => {
  const world = createWorld(t, { isEligible: (item) => item.id !== GUILD_2 });
  const run = world.outage(20 * MINUTE);
  await run.steady();
  assert.deepEqual(sentTo(world.posts), messagesTo(WELCOME_1, WELCOME_3));
  assert.equal(world.guildStatus(GUILD_2), 'skipped:not-eligible');
  // One that throws keeps every server out, and nothing else breaks.
  const broken = createWorld(t, { isEligible: () => { throw new Error('synthetic'); } });
  await broken.outage(20 * MINUTE).steady();
  assert.deepEqual(broken.posts, []);
  assert.deepEqual(Object.values(broken.state().pending.guilds), ['skipped:not-eligible', 'skipped:not-eligible',
    'skipped:not-eligible']);
});

test('a request the egress limit would refuse claims nothing, and is tried again at the next heartbeat', async (t) => {
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {} });
  const fill = () => {
    for (let index = 0; index < 20; index += 1) {
      world.limiter.admit({ method: 'POST', fullRoute: `/channels/${SYSTEM_1}/messages` });
    }
  };
  const run = world.outage(20 * MINUTE);
  await run.untilJustBeforeSteady();
  assert.deepEqual(world.posts, []);
  // Twenty messages in this channel in the last ten seconds: the limiter refuses the next.
  await run.beat(HEARTBEAT_MS, fill);
  assert.equal(world.clock.value, BASE_MS + 20 * MINUTE + STABLE_AFTER_READY_MS);
  assert.deepEqual(world.posts, []);
  assert.equal(world.guildStatus(GUILD_1), undefined, 'nothing was claimed');
  assert.deepEqual(world.state().guildNoticeAtMs, {});
  assert.ok(run.logger.lines.some((line) => line.includes(`OUTAGE_NOTICE_DEFERRED guild=${GUILD_1} reason=egress-limited attempt=1`)));
  // A minute later the window has passed.
  await run.beat();
  assert.equal(world.posts.length, 1);
  assert.equal(world.guildStatus(GUILD_1), 'sent');
});

test('a server that is held back every time is given up after three tries, and says so', async (t) => {
  assert.equal(MAX_ATTEMPTS, 3);
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {} });
  const run = world.outage(20 * MINUTE);
  await run.untilJustBeforeSteady();
  const fill = () => {
    for (let index = 0; index < 20; index += 1) {
      world.limiter.admit({ method: 'POST', fullRoute: `/channels/${SYSTEM_1}/messages` });
    }
  };
  for (let beat = 0; beat < 5; beat += 1) await run.beat(HEARTBEAT_MS, fill);
  assert.deepEqual(world.posts, []);
  assert.equal(world.guildStatus(GUILD_1), 'skipped:retry-limit');
  assert.equal(run.logger.lines.filter((line) => line.includes('OUTAGE_NOTICE_DEFERRED')).length, 2);
  assert.ok(run.logger.lines.includes(`[OUTAGE_NOTICE] code=OUTAGE_NOTICE_SKIPPED guild=${GUILD_1} reason=retry-limit`));
});

test('Discord\'s own 429 means the message took no effect: the claim is given back and it is tried again, three times at most', async (t) => {
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {} });
  let calls = 0;
  world.handlers.respond = () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 0 });
    return { id: '900000000000000001' };
  };
  const run = world.outage(20 * MINUTE);
  await run.steady();
  assert.equal(world.posts.length, 1);
  assert.equal(world.guildStatus(GUILD_1), undefined, 'released');
  assert.deepEqual(world.state().guildNoticeAtMs, {}, 'and its time with it');
  await run.beat();
  assert.equal(world.posts.length, 2);
  assert.equal(world.guildStatus(GUILD_1), 'sent');

  // Always limited: three requests, then it is given up.
  const stubborn = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {} });
  stubborn.handlers.respond = () => { throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 0 }); };
  const stubbornRun = stubborn.outage(20 * MINUTE);
  await stubbornRun.steady();
  for (let beat = 0; beat < 4; beat += 1) await stubbornRun.beat();
  assert.equal(stubborn.posts.length, 3);
  assert.equal(stubborn.guildStatus(GUILD_1), 'skipped:retry-limit');
});

test('a 403, a 5xx and a lost connection each end the server\'s notice: kept as they came, never sent again', async (t) => {
  const cases = [
    [() => { throw Object.assign(new Error('Missing Access'), { status: 403, code: 50001 }); }, 'rejected'],
    [() => { throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 }); }, 'rejected'],
    [() => { throw Object.assign(new Error('boom'), { status: 500 }); }, 'unknown'],
    [() => { throw Object.assign(new Error('bad gateway'), { status: 502 }); }, 'unknown'],
    [() => { throw new Error('connection reset'); }, 'unknown'],
  ];
  for (const [respond, expected] of cases) {
    const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) }),
      guild(GUILD_2, { systemChannel: channel(SYSTEM_2) })], welcome: {} });
    world.handlers.respond = (route) => {
      if (route.includes(SYSTEM_1)) return respond();
      return { id: '900000000000000001' };
    };
    const run = world.outage(20 * MINUTE);
    await run.steady();
    assert.equal(world.guildStatus(GUILD_1), expected, expected);
    assert.equal(world.guildStatus(GUILD_2), 'sent', 'one server\'s answer does not stop the others');
    assert.ok(world.state().guildNoticeAtMs[GUILD_1], 'the claim time stays');
    const before = world.posts.length;
    for (let beat = 0; beat < 3; beat += 1) await run.beat();
    assert.equal(world.posts.length, before, `${expected}: not tried again`);
    assert.equal(world.posts.filter((post) => post.route.includes(SYSTEM_1)).length, 1);
  }
});

test('one notice per server in 24 hours: a second outage three hours later skips it', async (t) => {
  assert.equal(GUILD_NOTICE_INTERVAL_MS, DAY);
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {}, keep: false });
  const first = world.outage(20 * MINUTE);
  await first.steady();
  assert.equal(world.posts.length, 1);
  assert.equal(world.state().pending, null, 'the first outage is over');
  const claimedAt = world.state().guildNoticeAtMs[GUILD_1];
  assert.ok(claimedAt);
  // The process dies; a new one is ready three hours after the notice.
  const second = world.outage(3 * HOUR);
  assert.equal(world.state().pending.startedAtMs, claimedAt);
  await second.steady();
  assert.equal(world.posts.length, 1, 'skipped');
  assert.ok(second.logger.lines.includes(`[OUTAGE_NOTICE] code=OUTAGE_NOTICE_SKIPPED guild=${GUILD_1} reason=recent`));
});

test('the day is counted from the claim: 24 hours less a millisecond is held, 24 hours is not', async (t) => {
  for (const [delta, expectedPosts] of [[DAY - 1, 1], [DAY, 2], [DAY + 1, 2]]) {
    const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {}, keep: false });
    const first = world.outage(20 * MINUTE);
    await first.steady();
    assert.equal(world.posts.length, 1);
    const claimedAt = world.state().guildNoticeAtMs[GUILD_1];
    assert.equal(world.clock.value, claimedAt);
    // Another outage whose notice comes due exactly `delta` after the claim.
    const second = world.outage(delta - STABLE_AFTER_READY_MS);
    await second.steady();
    assert.equal(world.clock.value, claimedAt + delta);
    assert.equal(world.posts.length, expectedPosts, String(delta));
  }
});

test('a time kept more than five minutes ahead of the clock is not believed', async (t) => {
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {}, keep: false });
  const first = world.outage(20 * MINUTE);
  await first.steady();
  assert.equal(world.posts.length, 1);
  // The record says the notice was claimed an hour from now (a clock that was ahead): ignored.
  const file = path.join(world.root, STATE_FILE_NAME);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.guildNoticeAtMs[GUILD_1] = world.clock.value + HOUR;
  fs.writeFileSync(file, JSON.stringify(record));
  const second = world.outage(20 * MINUTE);
  await second.steady();
  assert.equal(world.posts.length, 2);
  // Within the five minutes it still counts.
  const record2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  record2.guildNoticeAtMs[GUILD_1] = world.clock.value + 5 * MINUTE;
  fs.writeFileSync(file, JSON.stringify(record2));
  const third = world.outage(20 * MINUTE);
  await third.steady();
  assert.equal(world.posts.length, 2);
});

test('a claim a crash left behind is unknown at the next start and is never sent again; the other servers go on', async (t) => {
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) }),
    guild(GUILD_2, { systemChannel: channel(SYSTEM_2) })], welcome: {} });
  const first = world.outage(20 * MINUTE);
  // The process claimed the first server and died before Discord answered.
  assert.equal(first.monitor.store.claimGuild(GUILD_1, world.clock.value), true);
  world.clock.value += MINUTE;
  const second = world.outage(0);
  await second.steady();
  assert.deepEqual(sentTo(world.posts), messagesTo(SYSTEM_2));
  assert.equal(world.guildStatus(GUILD_1), 'unknown');
  assert.equal(world.guildStatus(GUILD_2), 'sent');
});

test('a stop in the middle sends nothing more, and a claim that cannot be written sends nothing at all', async (t) => {
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) }),
    guild(GUILD_2, { systemChannel: channel(SYSTEM_2) }), guild(GUILD_3, { systemChannel: channel(SYSTEM_3) })], welcome: {} });
  const run = world.outage(20 * MINUTE);
  world.handlers.respond = () => {
    run.monitor.noteSignalStop();
    return { id: '900000000000000001' };
  };
  await run.steady();
  assert.equal(world.posts.length, 1);
  assert.equal(world.state().stop.kind, 'signal');

  // The record cannot be written once the process is running: no claim, so no request.
  let refuse = false;
  const filesystem = { ...fs, openSync: (target, ...rest) => {
    if (refuse && String(target).endsWith('.tmp')) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    return fs.openSync(target, ...rest);
  } };
  const blocked = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {}, filesystem });
  const blockedRun = blocked.outage(20 * MINUTE);
  refuse = true;
  await blockedRun.steady();
  assert.deepEqual(blocked.posts, []);
  assert.ok(blockedRun.logger.lines.includes(`[OUTAGE_NOTICE] code=OUTAGE_NOTICE_STATE_UNWRITABLE guild=${GUILD_1}`));
});

test('signs of a restored backup alone tell no server, and with an outage the servers hear nothing of them', async (t) => {
  const world = createWorld(t);
  // A short gap, but the ledgers say a backup was restored: the Owner's matter, not the servers'.
  const restored = world.outage(2 * MINUTE, { recovery: ['LEDGER_ROLLBACK:database-behind'] });
  assert.equal(world.state().pending.kind, 'restore');
  await restored.steady();
  assert.deepEqual(world.posts, []);
  assert.deepEqual(world.state().pending.guilds, {});

  // The same signs with a real outage: the servers get the one fixed message, which names no restore.
  const both = createWorld(t);
  const run = both.outage(25 * MINUTE, { recovery: ['LEDGER_ROLLBACK:database-behind', 'LEDGER_PARTIAL'] });
  await run.steady();
  assert.equal(both.posts.length, 3);
  for (const post of both.posts) {
    assert.deepEqual(post.body, { content: outageNoticeText(25), allowed_mentions: NO_MENTIONS });
    assert.doesNotMatch(post.body.content, /還原|LEDGER|備份/u);
  }
});

test('the pieces of an outage that nobody chose: the real egress guard and limiter let the fixed message through unchanged', async (t) => {
  const world = createWorld(t, { guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })], welcome: {}, withGuard: true });
  const run = world.outage(31 * MINUTE);
  await run.steady();
  assert.equal(world.posts.length, 1);
  assert.deepEqual(world.posts[0].body, { content: outageNoticeText(31), allowed_mentions: NO_MENTIONS });
  assert.equal(world.guildStatus(GUILD_1), 'sent');
  assert.equal(world.limiter.snapshotForTests().attempts[`message-create:${SYSTEM_1}`], 1, 'counted once');
  assert.equal(world.limiter.snapshotForTests().reservations, 0);
});

// ---- The Owner's notice: one catalogue event per outage, with an identity of the outage's own. ----

const OWNER_ID = '700000000000000009';

// The events the catalogue is handed, each with the operation context it was emitted in.
function captureOwnerEvents(t) {
  const captured = [];
  const restore = setSafetyEventHandler((event) => captured.push({ event, context: getHostOperationContext() }));
  t.after(restore);
  return captured;
}

test('the Owner is handed one OWNER_EVENT_RECOVERED per outage, in a background context the notifier accepts', async (t) => {
  const captured = captureOwnerEvents(t);
  const notifier = { isReady: () => true };
  const world = createWorld(t, { ownerNotifier: notifier });
  const run = world.outage(20 * MINUTE);
  await run.steady();
  assert.equal(captured.length, 1);
  const [{ event, context }] = captured;
  assert.equal(event.code, SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED);
  assert.equal(event.category, 'recovery');
  assert.deepEqual(
    [event.notice.outageStartedAtMs, event.notice.outageEndedAtMs, event.notice.outageKind],
    [BASE_MS, BASE_MS + 20 * MINUTE, 'crash'],
  );
  assert.equal(event.actorId, BOT_ID);
  assert.equal(event.guildId, null);
  assert.match(context.sourceEventId, /^outage:[a-f0-9]{32}$/u);
  assert.equal(context.hostPurpose, 'background.safety.outage-notice');
  assert.equal(context.scope, 'background:safety.outage-notice');
  assert.equal(context.actorId, BOT_ID);
  assert.equal(context.sourceEventId, ownerSourceEventId(outageIdFor(BASE_MS)));
  // What the notifier makes of it: the outage budget class and target, and the fixed text.
  const operation = buildOperation(event, context, OWNER_ID);
  assert.ok(operation);
  assert.deepEqual([operation.budgetClass, operation.target, operation.action, operation.mergeKey],
    ['owner-outage', `${OWNER_ID}:outage`, 'owner-event-notification', `owner-recovery-v1:${BASE_MS}`]);
  assert.equal(operation.payload.content,
    `小吉恢復營運通知。固定代碼：OWNER_EVENT_RECOVERED；停運開始：<t:${Math.floor(BASE_MS / 1_000)}:F>；` +
    `恢復時間：<t:${Math.floor((BASE_MS + 20 * MINUTE) / 1_000)}:F>；類型：程式異常結束後重新啟動`);
  assert.deepEqual(operation.payload.allowed_mentions, NO_MENTIONS);
  assert.equal(rewriteLinks(operation.payload.content, LINK_OPTIONS).rewritten, false);
  assert.equal(world.guildStatus(GUILD_1), 'sent');
  assert.equal(world.state().pending.owner, 'queued');
  // Later heartbeats, and a restart that continues the same outage, hand over nothing again.
  await run.beat();
  const next = world.outage(MINUTE);
  await next.steady();
  assert.equal(captured.length, 1);
});

test('the same outage has the same identity across the starts it spans; another outage has another', async (t) => {
  const captured = captureOwnerEvents(t);
  const world = createWorld(t, { ownerNotifier: { isReady: () => true }, keep: false });
  // A storm: ready, gone within two minutes, three times, then steady.
  for (let index = 0; index < 3; index += 1) {
    const storm = world.outage(index === 0 ? 20 * MINUTE : MINUTE);
    await storm.beat(2 * MINUTE);
  }
  const steady = world.outage(MINUTE);
  await steady.steady();
  assert.equal(captured.length, 1);
  const first = buildOperation(captured[0].event, captured[0].context, OWNER_ID);
  assert.equal(captured[0].context.sourceEventId, ownerSourceEventId(outageIdFor(BASE_MS)), 'made from the first start of it');
  assert.equal(world.state().pending, null);

  // Another outage, hours later: its own source, so its own operation.
  const later = world.outage(5 * HOUR);
  await later.steady();
  assert.equal(captured.length, 2);
  const second = buildOperation(captured[1].event, captured[1].context, OWNER_ID);
  assert.notEqual(second.operationId, first.operationId);
  assert.notEqual(captured[1].context.sourceEventId, captured[0].context.sourceEventId);
  // The same facts make the same operation: a replay of one is answered by the ledger, not sent again.
  assert.equal(buildOperation(captured[0].event, captured[0].context, OWNER_ID).operationId, first.operationId);
});

test('the three kinds are the fixed ones, and a restore alone is the Owner\'s only', async (t) => {
  const captured = captureOwnerEvents(t);
  const notifier = { isReady: () => true };
  // A restore that comes with no gap: no server, one Owner event of kind restore.
  const restore = createWorld(t, { ownerNotifier: notifier });
  await restore.outage(MINUTE, { recovery: ['LEDGER_PARTIAL'] }).steady();
  assert.deepEqual(restore.posts, []);
  assert.deepEqual(captured.map(({ event }) => event.notice.outageKind), ['restore']);
  // A lost connection.
  const connection = createWorld(t, { ownerNotifier: notifier, guilds: [guild(GUILD_1, { systemChannel: channel(SYSTEM_1) })],
    welcome: {} });
  const run = connection.run;
  const gateway = { up: true };
  connection.client.isReady = () => gateway.up;
  await run.beat();
  gateway.up = false;
  for (let beat = 0; beat < 12; beat += 1) await run.beat();
  gateway.up = true;
  await run.beat();
  await run.steady();
  assert.deepEqual(captured.map(({ event }) => event.notice.outageKind), ['restore', 'connection']);
  assert.equal(connection.posts.length, 1);
});

test('an Owner notifier that is not ready is logged once, the servers are still told, and a later start hands it over', async (t) => {
  const captured = captureOwnerEvents(t);
  const notifier = { ready: false, isReady() { return this.ready; } };
  const world = createWorld(t, { ownerNotifier: notifier });
  const run = world.outage(20 * MINUTE);
  await run.steady();
  for (let beat = 0; beat < 3; beat += 1) await run.beat();
  assert.equal(captured.length, 0);
  assert.equal(world.posts.length, 3, 'the servers are told all the same');
  assert.equal(world.state().pending.owner, 'none');
  assert.equal(run.logger.lines.filter((line) => line.includes('OUTAGE_OWNER_NOTICE_UNAVAILABLE')).length, 1);
  assert.ok(run.logger.lines.includes('[OUTAGE_NOTICE] code=OUTAGE_OWNER_NOTICE_UNAVAILABLE reason=notifier'));

  // The next start has it: the Owner is told, the servers are not told again.
  notifier.ready = true;
  const next = world.outage(5 * MINUTE);
  await next.steady();
  assert.equal(captured.length, 1);
  assert.equal(world.posts.length, 3);
  assert.equal(world.state().pending.owner, 'queued');
});

test('without an Owner notifier at all the Owner is no part of the delivery, and the notice is not marked handed over', async (t) => {
  const captured = captureOwnerEvents(t);
  const world = createWorld(t, { keep: false });
  await world.outage(20 * MINUTE).steady();
  assert.equal(captured.length, 0);
  assert.equal(world.posts.length, 3);
  assert.equal(world.state().pending, null);
});

test('a pending that cannot be recorded as handed over is not emitted', async (t) => {
  const captured = captureOwnerEvents(t);
  let refuse = false;
  const filesystem = { ...fs, openSync: (target, ...rest) => {
    if (refuse && String(target).endsWith('.tmp')) throw Object.assign(new Error('synthetic'), { code: 'EIO' });
    return fs.openSync(target, ...rest);
  } };
  const world = createWorld(t, { ownerNotifier: { isReady: () => true }, filesystem, guilds: [] });
  const run = world.outage(20 * MINUTE);
  refuse = true;
  await run.steady();
  assert.equal(captured.length, 0, 'at most once: not recorded, so not emitted');
  assert.ok(run.logger.lines.includes('[OUTAGE_NOTICE] code=OUTAGE_OWNER_NOTICE_UNAVAILABLE reason=state'));
});

// What a module loads, as the files of the program: the module itself and everything it requires,
// transitively, in a process of its own.
function loadedBy(file) {
  const target = path.join(__dirname, '..', 'src', 'systems', 'safety', file);
  const script = `require(${JSON.stringify(target)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const root = path.join(__dirname, '..').replaceAll('\\', '/');
  return JSON.parse(run.stdout.trim().split(/\r?\n/u).at(-1)).map((item) => item.replaceAll('\\', '/'))
    .filter((item) => item.startsWith(`${root}/`) && !item.includes('/node_modules/'))
    .map((item) => item.slice(root.length + 1)).sort();
}

test('the notice loads nothing of the AI conversation, and only the few files it needs', () => {
  // The notice itself: the log, the protected REST, the host operation context, the event catalogue
  // (the one bridge to the Owner notifier) and the bot's own member. No ledger, no conversation.
  assert.deepEqual(loadedBy('outageNotice.js'), [
    'src/platform/hostOperationContext.js',
    'src/platform/protectedRest.js',
    'src/platform/safetyEventCatalog.js',
    'src/systems/safety/outageNotice.js',
    'src/utils/botMember.js',
    'src/utils/logger.js',
  ]);
  // The monitor is the one that reads the ledger layout; neither of them loads the conversation.
  for (const file of ['outageNotice.js', 'outageMonitor.js']) {
    assert.deepEqual(loadedBy(file).filter((item) => /\/conversation\/|aiService|mentionService|provider/u.test(item)), [], file);
  }
});
