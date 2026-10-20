const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCalendarSystem } = require('../src/systems/community/calendarSystem');

const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const GUILD_A = '333333333333333333';
const GUILD_B = '444444444444444444';
const CHANNEL_A = '555555555555555555';
const INTERACTION_A = '666666666666666666';
const NOW = Date.UTC(2026, 4, 10, 10, 0, 0);
const STARTS_AT = Date.UTC(2026, 4, 10, 12, 30, 0);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-calendar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'calendar.json');
  const system = createCalendarSystem({ filePath });
  system.initializeCalendarStore();
  return { filePath, system };
}

function personalInput(overrides = {}) {
  return {
    interactionId: INTERACTION_A,
    userId: USER_A,
    sourceGuildId: GUILD_A,
    title: '跨群行程',
    description: '只有本人能看見',
    startsAt: STARTS_AT,
    createdAt: NOW,
    ...overrides,
  };
}

test('Taipei calendar input maps to one stable instant', () => {
  const system = createCalendarSystem({ filePath: path.resolve(os.tmpdir(), 'unused-calendar.json') });
  assert.equal(system.parseTaipeiCalendarDate('2026-05-10 20:30').toISOString(), '2026-05-10T12:30:00.000Z');
  assert.equal(system.parseTaipeiCalendarDate('2026-02-30 20:30'), null);
  assert.equal(system.parseTaipeiCalendarDate('2026-05-10 24:00'), null);
});

test('personal events follow the owner across guilds and reject other users', (t) => {
  const { system } = fixture(t);
  const created = system.addPersonalCalendarEvent(personalInput());

  assert.equal(created.replayed, false);
  assert.equal(created.event.sourceGuildId, GUILD_A);
  assert.deepEqual(
    system.listPersonalEvents({ userId: USER_A, now: NOW, days: 1 }).map((event) => event.id),
    [created.event.id],
  );
  assert.deepEqual(system.listPersonalEvents({ userId: USER_B, now: NOW, days: 1 }), []);
  assert.equal(system.deletePersonalEvent({ userId: USER_B, eventId: created.event.id, deletedAt: NOW + 1 }), null);
  assert.equal(system.readCalendarEvents()[created.event.id].title, '跨群行程');

  // There is deliberately no guild parameter in either personal operation: the
  // same owner can list or delete from guild B while the source remains guild A.
  const removed = system.deletePersonalEvent({
    userId: USER_A, eventId: created.event.id, deletedAt: NOW + 2,
  });
  assert.equal(removed.id, created.event.id);
  assert.deepEqual(system.listPersonalEvents({ userId: USER_A, now: NOW, days: 1 }), []);
});

test('duplicate add is stable and conflicting owner or content fails closed', (t) => {
  const { filePath, system } = fixture(t);
  const first = system.addPersonalCalendarEvent(personalInput());
  const replay = system.addPersonalCalendarEvent(personalInput());
  const restarted = createCalendarSystem({ filePath });
  const afterRestart = restarted.addPersonalCalendarEvent(personalInput());

  assert.equal(replay.replayed, true);
  assert.equal(afterRestart.replayed, true);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(afterRestart.event.id, first.event.id);
  assert.equal(Object.keys(restarted.readCalendarEvents()).length, 1);
  assert.throws(
    () => restarted.addPersonalCalendarEvent(personalInput({ userId: USER_B })),
    /conflicts/,
  );
  assert.throws(
    () => restarted.addPersonalCalendarEvent(personalInput({ title: '不同內容' })),
    /conflicts/,
  );
});

test('concurrent duplicate delivery in the single writer produces one event', async (t) => {
  const { system } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    setImmediate(() => resolve(system.addPersonalCalendarEvent(personalInput())));
  })));

  assert.equal(new Set(results.map((result) => result.event.id)).size, 1);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(Object.keys(system.readCalendarEvents()).length, 1);
});

test('deleted marker survives restart and prevents the same interaction from resurrecting content', (t) => {
  const { filePath, system } = fixture(t);
  const created = system.addPersonalCalendarEvent(personalInput()).event;
  system.deletePersonalEvent({ userId: USER_A, eventId: created.id, deletedAt: NOW + 10 });

  const marker = system.readCalendarEvents()[created.id];
  assert.equal(marker.lifecycle, 'deleted');
  assert.equal(marker.userId, USER_A);
  assert.equal(marker.id, created.id);
  assert.equal(marker.title, '[deleted]');
  assert.equal(marker.description, '');
  assert.equal(marker.startsAt, 0);
  assert.equal(marker.sourceGuildId, null);
  assert.equal(marker.guildId, undefined);
  assert.equal(marker.channelId, undefined);
  assert.ok(/^[a-f0-9]{64}$/.test(marker.requestDigest));
  assert.equal(system.formatCalendarEventList([marker]), '目前沒有行事曆事件。');

  const restarted = createCalendarSystem({ filePath });
  const replay = restarted.addPersonalCalendarEvent(personalInput());
  assert.equal(replay.deleted, true);
  assert.equal(replay.event.id, created.id);
  assert.equal(restarted.readCalendarEvents()[created.id].title, '[deleted]');
  assert.throws(
    () => restarted.addPersonalCalendarEvent(personalInput({ description: '改寫內容' })),
    /conflicts/,
  );
  assert.throws(() => restarted.saveCalendarEvent(created), /cannot be overwritten/);
});

test('deleted evidence survives restart instead of being physically removed', (t) => {
  const { filePath, system } = fixture(t);
  const created = system.addPersonalCalendarEvent(personalInput()).event;
  system.deletePersonalEvent({ userId: USER_A, eventId: created.id, deletedAt: NOW + 20 });

  const restarted = createCalendarSystem({ filePath });
  const secondDelete = restarted.deletePersonalEvent({
    userId: USER_A, eventId: created.id, deletedAt: NOW + 30,
  });
  const marker = restarted.readCalendarEvents()[created.id];
  assert.equal(secondDelete.lifecycle, 'deleted');
  assert.equal(marker.lifecycle, 'deleted');
  assert.equal(marker.deletedAt, NOW + 20);

  // The pre-marker v1 reader accepts this shape and its upcoming filter hides it.
  assert.ok(marker.title);
  assert.ok(Number.isFinite(Number(marker.startsAt)));
  assert.equal(marker.scope, 'personal');
  assert.equal(marker.userId, USER_A);
  assert.equal(marker.startsAt >= NOW, false);
});

test('shared compatibility list fails closed for every retained event shape', (t) => {
  const { filePath, system } = fixture(t);
  system.writeCalendarEvents({
    'trusted-creator': {
      id: 'trusted-creator', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_A, channelId: CHANNEL_A, createdBy: USER_A,
      title: '可信建立者', description: '', startsAt: STARTS_AT, createdAt: NOW,
    },
    'unknown-creator': {
      id: 'unknown-creator', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_A, channelId: CHANNEL_A, createdBy: 'unknown',
      title: '未知建立者格式', description: '', startsAt: STARTS_AT + 1, createdAt: NOW,
    },
    'missing-creator': {
      id: 'missing-creator', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_A, channelId: CHANNEL_A,
      title: '缺少建立者', description: '', startsAt: STARTS_AT + 2, createdAt: NOW,
    },
    'conflicting-source': {
      id: 'conflicting-source', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_B, channelId: CHANNEL_A, createdBy: USER_A,
      title: '來源矛盾', description: '', startsAt: STARTS_AT + 3, createdAt: NOW,
    },
    personal: {
      id: 'personal', schemaVersion: 1, scope: 'personal', userId: USER_A,
      sourceGuildId: GUILD_A, createdBy: USER_A,
      title: '個人事件', description: '', startsAt: STARTS_AT + 4, createdAt: NOW,
    },
    deleted: {
      id: 'deleted', schemaVersion: 1, scope: 'personal', userId: USER_A,
      sourceGuildId: null, createdBy: USER_A, lifecycle: 'deleted', deletedAt: NOW,
      requestDigest: 'synthetic', title: '[deleted]', description: '', startsAt: 0, createdAt: NOW,
    },
  });
  const before = fs.readFileSync(filePath, 'utf8');

  const publicEvents = system.listUpcomingEvents({ guildId: GUILD_A, now: NOW, days: 1 });
  assert.deepEqual(publicEvents, []);
  assert.equal(system.formatCalendarEventList(publicEvents), '目前沒有行事曆事件。');
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  const restarted = createCalendarSystem({ filePath });
  assert.deepEqual(restarted.listUpcomingEvents({ guildId: GUILD_A, now: NOW, days: 1 }), []);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('existing personal ids remain stable and only well-proven shared creators become personal owners', (t) => {
  const { system } = fixture(t);
  system.writeCalendarEvents({
    'existing-personal-id': {
      id: 'existing-personal-id', schemaVersion: 1, scope: 'personal',
      userId: USER_A, createdBy: USER_A, sourceGuildId: GUILD_A,
      title: '既有個人資料', description: '', startsAt: STARTS_AT, createdAt: NOW,
    },
    'trusted-shared-id': {
      id: 'trusted-shared-id', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_A, channelId: CHANNEL_A, createdBy: USER_A,
      title: '可信舊群行程', description: '', startsAt: STARTS_AT + 1, createdAt: NOW,
    },
    'unknown-owner-id': {
      id: 'unknown-owner-id', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_A, channelId: CHANNEL_A,
      title: '未知建立者', description: '', startsAt: STARTS_AT + 2, createdAt: NOW,
    },
    'unconfirmed-source-id': {
      id: 'unconfirmed-source-id', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_B, channelId: CHANNEL_A, createdBy: USER_A,
      title: '來源不一致', description: '', startsAt: STARTS_AT + 3, createdAt: NOW,
    },
  });

  assert.deepEqual(
    system.listPersonalEvents({ userId: USER_A, now: NOW, days: 1 }).map((event) => event.id).sort(),
    ['existing-personal-id', 'trusted-shared-id'],
  );
  assert.equal(system.deletePersonalEvent({
    userId: USER_B, eventId: 'trusted-shared-id', deletedAt: NOW + 1,
  }), null);
  assert.equal(system.deletePersonalEvent({
    userId: USER_A, eventId: 'unknown-owner-id', deletedAt: NOW + 1,
  }), null);
  assert.equal(system.deletePersonalEvent({
    userId: USER_A, eventId: 'unconfirmed-source-id', deletedAt: NOW + 1,
  }), null);
  assert.equal(system.deletePersonalEvent({
    userId: USER_A, eventId: 'trusted-shared-id', deletedAt: NOW + 1,
  }).id, 'trusted-shared-id');

  const records = system.readCalendarEvents();
  assert.equal(records['existing-personal-id'].id, 'existing-personal-id');
  assert.equal(records['trusted-shared-id'].lifecycle, 'deleted');
  assert.equal(records['unknown-owner-id'].title, '未知建立者');
  assert.equal(records['unconfirmed-source-id'].title, '來源不一致');
});

test('shared compatibility deletion also retains a hidden marker', (t) => {
  const { system } = fixture(t);
  system.writeCalendarEvents({
    pending: {
      id: 'pending', schemaVersion: 1, scope: 'shared', guildId: GUILD_A,
      sourceGuildId: GUILD_A, title: '待處理', startsAt: STARTS_AT, createdAt: NOW,
    },
  });
  assert.equal(system.deleteCalendarEvent({
    guildId: GUILD_A, eventId: 'pending', deletedAt: NOW + 1,
  }).id, 'pending');
  const marker = system.readCalendarEvents().pending;
  assert.equal(marker.lifecycle, 'deleted');
  assert.equal(marker.title, '[deleted]');
  assert.equal(system.listUpcomingEvents({ guildId: GUILD_A, now: NOW, days: 1 }).length, 0);
});

test('calendar slash command exposes one personal-global entry and always replies ephemerally', async (t) => {
  const servicePath = require.resolve('../src/services/calendarService');
  const commandPath = require.resolve('../src/commands/calendar');
  const originalService = require.cache[servicePath];
  const originalCommand = require.cache[commandPath];
  const event = { id: 'event-id', title: '測試', startsAt: STARTS_AT };
  let addBehavior = () => ({ event, replayed: false, deleted: false });
  const service = {
    MAX_LIST_DAYS: 365,
    addPersonalCalendarEvent: (...args) => addBehavior(...args),
    deletePersonalEvent: () => null,
    formatCalendarEventList: () => '目前沒有行事曆事件。',
    listPersonalEvents: () => [],
    parseTaipeiCalendarDate: () => new Date(STARTS_AT),
  };
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service };
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    if (originalCommand) require.cache[commandPath] = originalCommand;
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
  });

  const commandData = command.data.toJSON();
  assert.deepEqual(commandData.options.map((option) => option.name), ['add', 'list', 'delete']);
  assert.equal(JSON.stringify(commandData).includes('personal-'), false);

  for (const subcommand of ['add', 'list', 'delete']) {
    const replies = [];
    const interaction = {
      id: INTERACTION_A,
      createdTimestamp: NOW,
      user: { id: USER_A },
      guildId: GUILD_B,
      inGuild: () => true,
      channel: { isTextBased: () => true },
      options: {
        getSubcommand: () => subcommand,
        getInteger: () => 30,
        getString: (name) => name === 'id' ? 'event-id' : name === 'title' ? '測試' :
          name === 'starts-at' ? '2026-05-10 20:30' : '',
      },
      reply: async (response) => replies.push(response),
      followUp: async (response) => replies.push(response),
      replied: false,
      deferred: false,
    };
    await command.execute(interaction);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
  }

  addBehavior = () => ({ event, replayed: true, deleted: true });
  const deletedReplies = [];
  await command.execute({
    id: INTERACTION_A, createdTimestamp: NOW, user: { id: USER_A }, guildId: GUILD_B,
    inGuild: () => true, channel: { isTextBased: () => true },
    options: {
      getSubcommand: () => 'add',
      getString: (name) => name === 'title' ? '測試' : name === 'starts-at' ? '2026-05-10 20:30' : '',
    },
    reply: async (response) => deletedReplies.push(response),
    followUp: async (response) => deletedReplies.push(response),
    replied: false,
    deferred: false,
  });
  assert.equal(deletedReplies[0].ephemeral, true);
  assert.match(deletedReplies[0].content, /不會重新建立/);

  addBehavior = () => { throw new Error('synthetic failure'); };
  const failureReplies = [];
  await command.execute({
    id: INTERACTION_A, createdTimestamp: NOW, user: { id: USER_A }, guildId: GUILD_B,
    inGuild: () => true, channel: { isTextBased: () => true },
    options: {
      getSubcommand: () => 'add',
      getString: (name) => name === 'title' ? '測試' : name === 'starts-at' ? '2026-05-10 20:30' : '',
    },
    reply: async (response) => failureReplies.push(response),
    followUp: async (response) => failureReplies.push(response),
    replied: false,
    deferred: false,
  });
  assert.equal(failureReplies[0].ephemeral, true);
  assert.doesNotMatch(failureReplies[0].content, /synthetic failure/);
});

test('the list reply names the range it read, and an empty list points at the days option', (t) => {
  const { system } = fixture(t);
  assert.equal(system.formatCalendarEventList([], { days: 30 }),
    '未來 30 天內沒有行事曆事件。可用 days 選項查更遠的日期（最多 365 天）。');
  assert.equal(system.formatCalendarEventList([], { days: 365 }), '未來 365 天內沒有行事曆事件。');
  // No English words besides the option name, which members type as it is.
  for (const days of [30, 365]) {
    assert.doesNotMatch(system.formatCalendarEventList([], { days }).replace(' days ', ''), /[A-Za-z]/u);
  }

  // An event 45 days ahead is outside the default range: the default list says which range it read,
  // and a longer days value finds the event under a heading with that range.
  const later = system.addPersonalCalendarEvent(personalInput({ startsAt: NOW + 45 * 86_400_000 })).event;
  assert.deepEqual(system.listPersonalEvents({ userId: USER_A, now: NOW, days: 30 }), []);
  const found = system.listPersonalEvents({ userId: USER_A, now: NOW, days: 60 });
  assert.deepEqual(found.map((event) => event.id), [later.id]);
  const lines = system.formatCalendarEventList(found, { days: 60 }).split('\n');
  assert.equal(lines[0], '**未來 60 天內的行事曆事件**');
  const startsAtSeconds = Math.floor((NOW + 45 * 86_400_000) / 1000);
  assert.equal(lines[1], '`' + later.id + '` - <t:' + startsAtSeconds + ':F> - **跨群行程** - 只有本人能看見');
});

test('/calendar list reads 30 days by default and passes the range it read to the reply', async (t) => {
  const servicePath = require.resolve('../src/services/calendarService');
  const commandPath = require.resolve('../src/commands/calendar');
  const originalService = require.cache[servicePath];
  const originalCommand = require.cache[commandPath];
  const calls = [];
  const service = {
    MAX_LIST_DAYS: 365,
    addPersonalCalendarEvent: () => { throw new Error('not used'); },
    deletePersonalEvent: () => null,
    formatCalendarEventList: (events, options) => {
      calls.push({ format: options });
      return `range ${options?.days}`;
    },
    listPersonalEvents: (input) => {
      calls.push({ list: input });
      return [];
    },
    parseTaipeiCalendarDate: () => null,
  };
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service };
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    if (originalCommand) require.cache[commandPath] = originalCommand;
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
  });

  for (const [given, expected] of [[null, 30], [120, 120]]) {
    calls.length = 0;
    const replies = [];
    await command.execute({
      user: { id: USER_A }, guildId: GUILD_B, inGuild: () => true, channel: { isTextBased: () => true },
      options: { getSubcommand: () => 'list', getInteger: () => given },
      reply: async (response) => replies.push(response),
      replied: false, deferred: false,
    });
    assert.deepEqual(calls, [{ list: { userId: USER_A, days: expected } }, { format: { days: expected } }]);
    assert.deepEqual(replies, [{ content: `range ${expected}`, ephemeral: true }]);
  }
});

function listedEvent(index, { title = `事件 ${index}`, description = '' } = {}) {
  return { id: `cal-${String(index).padStart(64, '0')}`, title, description, startsAt: STARTS_AT + index * 60_000 };
}

test('a list that would pass Discord\'s 2000-character limit is shortened to fit in one message', (t) => {
  const { system } = fixture(t);
  // Ten events at the longest title and description /calendar add accepts.
  const events = Array.from({ length: 10 }, (_, index) => listedEvent(index, {
    title: '標'.repeat(100), description: `說明${index}-${'長'.repeat(996)}`,
  }));
  const reply = system.formatCalendarEventList(events, { days: 30 });
  assert.ok(reply.length <= 1900, `length ${reply.length}`);
  const lines = reply.split('\n');
  assert.equal(lines[0], '**未來 30 天內的行事曆事件**');
  const eventLines = lines.slice(1).filter((line) => line.startsWith('`cal-'));
  assert.ok(eventLines.length >= 1 && eventLines.length < 10, `${eventLines.length} events listed`);
  eventLines.forEach((line, index) => {
    assert.ok(line.startsWith('`' + events[index].id + '`'), line);
    // The description is cut to its first 79 characters and an ellipsis.
    assert.ok(line.endsWith(` - 說明${index}-${'長'.repeat(79 - `說明${index}-`.length)}…`), line);
  });
  assert.equal(lines.at(-1), `另有 ${10 - eventLines.length} 筆事件未顯示，可縮短 days 範圍分次查看。`);
});

test('more events than a list shows end with a note on how many were left out', (t) => {
  const { system } = fixture(t);
  const events = Array.from({ length: 12 }, (_, index) => listedEvent(index, { description: '短說明' }));
  const lines = system.formatCalendarEventList(events, { days: 30 }).split('\n');
  assert.equal(lines.length, 12);
  assert.equal(lines.slice(1, 11).every((line) => line.endsWith(' - 短說明')), true);
  assert.equal(lines[11], '另有 2 筆事件未顯示，可縮短 days 範圍分次查看。');

  // A list that fits is not changed: every description in full, and no note.
  const fitting = system.formatCalendarEventList(events.slice(0, 3), { days: 30 }).split('\n');
  assert.deepEqual(fitting.slice(1).map((line) => line.endsWith(' - 短說明')), [true, true, true]);
  assert.equal(fitting.length, 4);
});

const DAY = 86_400_000;

function interactionIdFor(index) {
  return String(700000000000000000n + BigInt(index));
}

function storedPersonal(id, { userId = USER_A, startsAt, title = '既有行程' }) {
  return {
    id, schemaVersion: 1, scope: 'personal', userId, createdBy: userId, sourceGuildId: GUILD_A,
    title, description: '', startsAt, createdAt: NOW - DAY,
  };
}

function storedMarker(id, { userId = USER_A, deletedAt }) {
  return {
    id, schemaVersion: 1, scope: 'personal', userId, createdBy: userId, sourceGuildId: null,
    lifecycle: 'deleted', deletedAt, requestDigest: 'synthetic', title: '[deleted]', description: '',
    startsAt: 0, createdAt: NOW - 40 * DAY,
  };
}

function seedStore(system, records) {
  system.writeCalendarEvents(Object.fromEntries(records.map((record) => [record.id, record])));
}

function upcomingRecords(count, userId = USER_A) {
  return Array.from({ length: count }, (_, index) => storedPersonal(`upcoming-${userId}-${index}`, {
    userId, startsAt: NOW + (index + 1) * 60_000,
  }));
}

function nextAdd(index, overrides = {}) {
  return personalInput({ interactionId: interactionIdFor(index), title: `新事件 ${index}`, ...overrides });
}

test('a person cannot hold more than 100 events that have not ended', (t) => {
  const { filePath, system } = fixture(t);
  seedStore(system, upcomingRecords(100));
  const before = fs.readFileSync(filePath, 'utf8');

  const refused = system.addPersonalCalendarEvent(nextAdd(1));
  assert.equal(refused.limitReached, true);
  assert.equal(refused.limit, 100);
  assert.equal(refused.event, null);
  assert.equal(Object.keys(system.readCalendarEvents()).length, 100);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'a refused add writes nothing');

  // Another person is not affected by this person's events.
  const other = system.addPersonalCalendarEvent(nextAdd(2, { userId: USER_B }));
  assert.equal(other.limitReached, undefined);
  assert.equal(other.replayed, false);

  // Deleting one makes room again.
  system.deletePersonalEvent({ userId: USER_A, eventId: `upcoming-${USER_A}-0`, deletedAt: NOW });
  const accepted = system.addPersonalCalendarEvent(nextAdd(1));
  assert.equal(accepted.limitReached, undefined);
  assert.equal(accepted.event.title, '新事件 1');
});

test('a repeated delivery of an accepted add is still answered when the person is at the limit', (t) => {
  const { system } = fixture(t);
  seedStore(system, upcomingRecords(99));
  const first = system.addPersonalCalendarEvent(nextAdd(1));
  assert.equal(first.replayed, false);
  assert.equal(system.addPersonalCalendarEvent(nextAdd(2)).limitReached, true);

  const replay = system.addPersonalCalendarEvent(nextAdd(1));
  assert.equal(replay.replayed, true);
  assert.equal(replay.limitReached, undefined);
  assert.equal(replay.event.id, first.event.id);
});

test('events that already ended make room instead of blocking a new event', (t) => {
  const { system } = fixture(t);
  const ended = Array.from({ length: 30 }, (_, index) => storedPersonal(`ended-${index}`, {
    startsAt: NOW - (index + 1) * DAY / 2,
  }));
  seedStore(system, [...upcomingRecords(70), ...ended]);

  const accepted = system.addPersonalCalendarEvent(nextAdd(1));
  assert.equal(accepted.limitReached, undefined);
  const stored = system.readCalendarEvents();
  assert.equal(Object.keys(stored).length, 100, 'the person never holds more than 100 events');
  assert.equal(Object.values(stored).filter((event) => event.startsAt >= NOW).length, 71);
  assert.ok(stored['ended-0'], 'the most recently ended event stays');
  assert.equal(stored['ended-29'], undefined, 'the oldest ended events go first');
});

test('a write drops deletion markers and ended events older than 30 days and keeps the rest', (t) => {
  const { system } = fixture(t);
  seedStore(system, [
    storedMarker('old-marker', { deletedAt: NOW - 31 * DAY }),
    storedMarker('recent-marker', { deletedAt: NOW - 29 * DAY }),
    storedPersonal('old-event', { startsAt: NOW - 31 * DAY }),
    storedPersonal('recent-ended-event', { startsAt: NOW - 29 * DAY }),
    storedPersonal('upcoming-event', { startsAt: NOW + DAY }),
    storedPersonal('other-old-event', { userId: USER_B, startsAt: NOW - 60 * DAY }),
  ]);

  const added = system.addPersonalCalendarEvent(nextAdd(1));
  assert.deepEqual(Object.keys(system.readCalendarEvents()).sort(), [
    added.event.id, 'recent-ended-event', 'recent-marker', 'upcoming-event',
  ].sort());
});

test('deleting an event also drops what is past its retention time', (t) => {
  const { system } = fixture(t);
  seedStore(system, [
    storedMarker('old-marker', { deletedAt: NOW - 45 * DAY }),
    storedPersonal('old-event', { startsAt: NOW - 45 * DAY }),
    storedPersonal('to-delete', { startsAt: NOW + DAY }),
  ]);

  assert.equal(system.deletePersonalEvent({ userId: USER_A, eventId: 'to-delete', deletedAt: NOW }).id, 'to-delete');
  const stored = system.readCalendarEvents();
  assert.deepEqual(Object.keys(stored), ['to-delete']);
  assert.equal(stored['to-delete'].lifecycle, 'deleted');
});

test('an event that ended long ago can still be deleted while no write has dropped it', (t) => {
  const { system } = fixture(t);
  seedStore(system, [storedPersonal('old-event', { startsAt: NOW - 45 * DAY })]);
  const removed = system.deletePersonalEvent({ userId: USER_A, eventId: 'old-event', deletedAt: NOW });
  assert.equal(removed.id, 'old-event');
  assert.equal(system.readCalendarEvents()['old-event'].lifecycle, 'deleted');
});

test('one owner keeps only the 100 newest deletion markers', (t) => {
  const { system } = fixture(t);
  seedStore(system, [
    ...Array.from({ length: 120 }, (_, index) => storedMarker(`marker-${index}`, { deletedAt: NOW - 1_000 + index })),
    storedMarker('other-owner-marker', { userId: USER_B, deletedAt: NOW - 5_000 }),
  ]);

  system.addPersonalCalendarEvent(nextAdd(1));
  const stored = system.readCalendarEvents();
  const markers = Object.values(stored).filter((event) => event.lifecycle === 'deleted' && event.userId === USER_A);
  assert.equal(markers.length, 100);
  assert.ok(stored['marker-119'], 'the newest marker stays');
  assert.equal(stored['marker-19'], undefined, 'the oldest markers go');
  assert.ok(stored['marker-20']);
  assert.ok(stored['other-owner-marker'], 'another owner keeps its marker');
});

test('/calendar add tells a person at the limit what to do and does not report a data fault', async (t) => {
  const servicePath = require.resolve('../src/services/calendarService');
  const commandPath = require.resolve('../src/commands/calendar');
  const originalService = require.cache[servicePath];
  const originalCommand = require.cache[commandPath];
  require.cache[servicePath] = {
    id: servicePath, filename: servicePath, loaded: true,
    exports: {
      MAX_LIST_DAYS: 365,
      addPersonalCalendarEvent: () => ({ event: null, replayed: false, deleted: false, limitReached: true, limit: 100 }),
      deletePersonalEvent: () => null,
      formatCalendarEventList: () => '',
      listPersonalEvents: () => [],
      parseTaipeiCalendarDate: () => new Date(STARTS_AT),
    },
  };
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    if (originalCommand) require.cache[commandPath] = originalCommand;
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
  });

  const replies = [];
  await command.execute({
    id: INTERACTION_A, createdTimestamp: NOW, user: { id: USER_A }, guildId: GUILD_B,
    inGuild: () => true, channel: { isTextBased: () => true },
    options: {
      getSubcommand: () => 'add',
      getString: (name) => (name === 'title' ? '測試' : name === 'starts-at' ? '2026-05-10 20:30' : ''),
    },
    reply: async (response) => replies.push(response),
    followUp: async (response) => replies.push(response),
    replied: false, deferred: false,
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /100 筆/u);
  assert.match(replies[0].content, /\/calendar delete/u);
  assert.doesNotMatch(replies[0].content, /無法安全讀寫/u);
});

function commandWithService(t, service) {
  const servicePath = require.resolve('../src/services/calendarService');
  const commandPath = require.resolve('../src/commands/calendar');
  const originalService = require.cache[servicePath];
  const originalCommand = require.cache[commandPath];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service };
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    if (originalCommand) require.cache[commandPath] = originalCommand;
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
  });
  return command;
}

test('an event further ahead than /calendar list can show is refused when it is added', (t) => {
  const { filePath, system } = fixture(t);
  const days = system.MAX_LIST_DAYS;
  assert.equal(days, 365);

  const edge = system.addPersonalCalendarEvent(nextAdd(1, { startsAt: NOW + days * DAY }));
  assert.equal(edge.tooFarAhead, undefined);
  assert.equal(edge.replayed, false);
  const before = fs.readFileSync(filePath, 'utf8');

  const refused = system.addPersonalCalendarEvent(nextAdd(2, { startsAt: NOW + days * DAY + 60_000 }));
  assert.equal(refused.tooFarAhead, true);
  assert.equal(refused.maxDays, days);
  assert.equal(refused.event, null);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'a refused add writes nothing');

  // Everything that was accepted can be listed with the longest range, so it can be found and deleted.
  assert.deepEqual(
    system.listPersonalEvents({ userId: USER_A, now: NOW, days }).map((event) => event.id),
    [edge.event.id],
  );
});

test('an event stored further ahead earlier is left alone and does not stop another add', (t) => {
  const { system } = fixture(t);
  seedStore(system, [storedPersonal('far-event', { startsAt: NOW + 400 * DAY })]);

  const added = system.addPersonalCalendarEvent(nextAdd(1));
  assert.equal(added.limitReached, undefined);
  assert.equal(added.tooFarAhead, undefined);
  assert.equal(system.readCalendarEvents()['far-event'].startsAt, NOW + 400 * DAY);
});

test('/calendar add says how far ahead an event may be and does not report a data fault', async (t) => {
  const command = commandWithService(t, {
    MAX_LIST_DAYS: 365,
    addPersonalCalendarEvent: () => ({ event: null, replayed: false, deleted: false, tooFarAhead: true, maxDays: 365 }),
    deletePersonalEvent: () => null,
    formatCalendarEventList: () => '',
    listPersonalEvents: () => [],
    parseTaipeiCalendarDate: () => new Date(STARTS_AT),
  });

  const replies = [];
  await command.execute({
    id: INTERACTION_A, createdTimestamp: NOW, user: { id: USER_A }, guildId: GUILD_B,
    inGuild: () => true, channel: { isTextBased: () => true },
    options: {
      getSubcommand: () => 'add',
      getString: (name) => (name === 'title' ? '測試' : name === 'starts-at' ? '2030-05-10 20:30' : ''),
    },
    reply: async (response) => replies.push(response),
    followUp: async (response) => replies.push(response),
    replied: false, deferred: false,
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /365 天/u);
  assert.doesNotMatch(replies[0].content, /無法安全讀寫/u);
});

test('the longest range of /calendar list comes from the same constant as the add limit', (t) => {
  const command = commandWithService(t, {
    MAX_LIST_DAYS: 123,
    addPersonalCalendarEvent: () => { throw new Error('not used'); },
    deletePersonalEvent: () => null,
    formatCalendarEventList: () => '',
    listPersonalEvents: () => [],
    parseTaipeiCalendarDate: () => null,
  });

  const list = command.data.toJSON().options.find((option) => option.name === 'list');
  assert.equal(list.options.find((option) => option.name === 'days').max_value, 123);
});
