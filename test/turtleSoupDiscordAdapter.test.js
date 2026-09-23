const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBoardCustomId } = require('../src/games/discord/boardCustomId');
const {
  JUDGE_UNAVAILABLE_MESSAGE,
  RATE_LIMIT_MESSAGE,
  createTurtleSoupDiscordAdapter,
} = require('../src/games/discord/turtleSoupDiscordAdapter');

function session(status = 'active') {
  return {
    id: 'soup-session', guildId: 'g', channelId: 'c', messageId: 'm', gameKey: 'turtle-soup',
    rulesVersion: '1', status, hostId: 'p1', revision: 4,
    players: [{ userId: 'p1', status: 'active' }, { userId: 'p2', status: 'active' }],
  };
}

function interaction(verb, fields = {}, actorId = 'p1') {
  return {
    id: `interaction-${verb}`,
    customId: buildBoardCustomId({ sessionId: 'soup-session', revision: 4, verb }),
    guildId: 'g', channelId: 'c', message: { id: 'm' }, user: { id: actorId },
    fields: { getTextInputValue(name) { return fields[name] || ''; } },
  };
}

function createAdapter({ submit, getReveal } = {}) {
  const stored = session();
  let recovered = 0;
  const adapter = createTurtleSoupDiscordAdapter({
    workflow: { submit: submit || (async () => ({ events: [{ type: 'turtle-soup-judged', verdict: '是' }], replayed: false })) },
    revealService: { getReveal: getReveal || (async () => ({ ephemeral: true, revealText: '合成湯底' })) },
    service: { async recoverSession() { recovered += 1; return { session: { id: stored.id, revision: 5 } }; } },
    store: { async getSessionById() { return stored; } },
  });
  return { adapter, getRecovered: () => recovered, stored };
}

test('turtle soup modal uses the dedicated workflow DTO and refreshes the committed board', async () => {
  let request = null;
  const harness = createAdapter({
    async submit(value) {
      request = value;
      return { events: [{ type: 'turtle-soup-judged', verdict: '答對' }], replayed: false };
    },
  });
  const result = await harness.adapter.handle(interaction('act.guess', { input: '我猜答案' }));
  assert.deepEqual(request, {
    id: 'soup-session', guildId: 'g', channelId: 'c', messageId: 'm', actorId: 'p1',
    expectedRevision: 4, interactionId: 'interaction-act.guess', kind: 'guess', input: '我猜答案',
  });
  assert.equal(result.ok, true);
  assert.equal(result.ephemeral, true);
  assert.match(result.content, /答對/);
  assert.equal(harness.getRecovered(), 1);
});

test('429 and judge/corpus failures preserve the session with safe dedicated messages', async () => {
  for (const [code, expected] of [
    ['JUDGE_RATE_LIMITED', RATE_LIMIT_MESSAGE],
    ['JUDGE_UNAVAILABLE', JUDGE_UNAVAILABLE_MESSAGE],
    ['JUDGE_TIMEOUT', JUDGE_UNAVAILABLE_MESSAGE],
    ['CORPUS_UNAVAILABLE', JUDGE_UNAVAILABLE_MESSAGE],
    ['JUDGE_INVALID_OUTPUT', JUDGE_UNAVAILABLE_MESSAGE],
    ['JUDGE_INVALID_RESULT', JUDGE_UNAVAILABLE_MESSAGE],
  ]) {
    const harness = createAdapter({ submit: async () => { throw Object.assign(new Error('private provider detail'), { code }); } });
    const before = JSON.stringify(harness.stored);
    const result = await harness.adapter.handle(interaction('act.ask', { input: '這是事故嗎？' }));
    assert.deepEqual(result, { ok: false, ephemeral: true, content: expected, preserveSession: true, code });
    assert.equal(result.content.includes('答對'), false);
    assert.equal(harness.getRecovered(), 0);
    assert.equal(JSON.stringify(harness.stored), before);
  }
});

test('reveal goes only through the dedicated participant-only reveal service', async () => {
  let request = null;
  const harness = createAdapter({
    async getReveal(value) { request = value; return { ephemeral: true, revealText: '私密湯底' }; },
  });
  harness.stored.status = 'completed';
  const result = await harness.adapter.handle(interaction('reveal'));
  assert.deepEqual(result, { ephemeral: true, revealText: '私密湯底' });
  assert.deepEqual(request, { id: 'soup-session', guildId: 'g', channelId: 'c', messageId: 'm', actorId: 'p1' });
  assert.equal(harness.getRecovered(), 0);
});

test('non-participant judgment is rejected before calling the dedicated workflow', async () => {
  let called = false;
  const harness = createAdapter({ submit: async () => { called = true; } });
  await assert.rejects(
    () => harness.adapter.handle(interaction('act.ask', { input: '問題' }, 'outsider')),
    (error) => error?.code === 'NOT_A_PLAYER'
  );
  assert.equal(called, false);
});
