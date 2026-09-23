const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const turtleSoupEngine = require('../src/games/engines/turtleSoup');
const { createBoardStoreJudgeCommitter } = require('../src/games/turtleSoup/boardStoreAdapter');
const { buildScenarioIndex, createFileScenarioProvider } = require('../src/games/turtleSoup/scenarioProvider');
const {
  createTurtleSoupJudgeWorkflow,
  prepareTurtleSoupJudgment,
  revalidateAndApplyJudgment,
} = require('../src/games/turtleSoup/judgeWorkflow');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');

function syntheticScenario(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-room',
    version: 1,
    locale: 'zh-TW',
    difficulty: 'easy',
    title: '合成測試題',
    publicPrompt: '房間裡有一把鎖。',
    revealText: '合成揭曉：鑰匙藏在杯子下。',
    facts: [
      { id: 'locked_room', statement: '房門原本上鎖。', keywords: ['房門', '上鎖'] },
      { id: 'hidden_key', statement: '鑰匙藏在杯子下。', keywords: ['鑰匙', '杯子'] },
    ],
    solutionFactIds: ['locked_room', 'hidden_key'],
    contradictions: [{ id: 'no_window', statement: '窗戶沒有打開。' }],
    tags: ['synthetic'],
    ...overrides,
  };
}

function makeCorpus(scenarios = [syntheticScenario()]) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-turtle-engine-'));
  for (const scenario of scenarios) {
    fs.writeFileSync(path.join(rootDir, `${scenario.id}-${scenario.version}.json`), JSON.stringify(scenario));
  }
  buildScenarioIndex({ rootDir });
  return { rootDir, provider: createFileScenarioProvider({ rootDir }) };
}

function activeSession(state, overrides = {}) {
  return {
    id: 'session-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    gameKey: 'turtle-soup',
    rulesVersion: '1',
    status: 'active',
    players: ['host-1', 'player-2'],
    activePlayers: ['host-1', 'player-2'],
    retiredPlayers: [],
    revision: 4,
    state,
    outcome: null,
    ...overrides,
  };
}

test('turtle soup engine stores only opaque scenario reference and fixed judgments', async (t) => {
  const { rootDir, provider } = makeCorpus();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1', 'player-2'],
    rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 },
    seed: 'server-seed',
  });
  const rawInput = '鑰匙是在杯子下面嗎？';
  const prepared = await prepareTurtleSoupJudgment({
    session: activeSession(state),
    request: {
      id: 'session-1', guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1',
      actorId: 'player-2', expectedRevision: 4, interactionId: 'interaction-1', kind: 'question', input: rawInput,
    },
    scenarioProvider: provider,
    judgeProvider: { async judge() { return { verdict: '是' }; } },
  });
  const result = revalidateAndApplyJudgment({ latestSession: activeSession(state), prepared, engine: turtleSoupEngine });

  const serialized = JSON.stringify(result.state);
  assert.equal(result.progressed, true);
  assert.equal(result.state.judgments[0].verdict, '是');
  assert.equal(serialized.includes(rawInput), false);
  assert.equal(serialized.includes('合成揭曉'), false);
  assert.equal(serialized.includes('房間裡有一把鎖'), false);
  assert.equal(result.state.judgments[0].inputDigest.length, 64);
});

test('engine rejects user-forged verdicts and keeps public view free of prompt and reveal', () => {
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  assert.throws(
    () => turtleSoupEngine.applyAction(state, {
      type: 'record-judgment', judgmentId: 'fake-1', expectedActorId: 'host-1',
      inputDigest: 'a'.repeat(64), kind: 'guess', verdict: '答對',
    }, { actorId: 'host-1', activePlayers: ['host-1'] }),
    (error) => error?.code === 'INVALID_ACTION'
  );
  const publicView = turtleSoupEngine.getPublicView(state, { actorId: 'host-1' });
  assert.equal(publicView.board.kind, 'narrative');
  assert.equal(JSON.stringify(publicView).includes('scenario'), false);
  assert.equal(JSON.stringify(publicView).includes('reveal'), false);
  assert.deepEqual(turtleSoupEngine.getLegalActions(state, { viewerId: 'host-1', isActivePlayer: true }),
    ['submit-question', 'submit-guess']);
  assert.deepEqual(turtleSoupEngine.getLegalActions(state, { viewerId: 'host-1', isActivePlayer: false }), []);
});

test('prepared judgment is idempotent at engine boundary and stale CAS is rejected', async (t) => {
  const { rootDir, provider } = makeCorpus();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1', 'player-2'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  const session = activeSession(state);
  const prepared = await prepareTurtleSoupJudgment({
    session,
    request: {
      id: session.id, guildId: session.guildId, channelId: session.channelId, messageId: session.messageId,
      actorId: 'player-2', expectedRevision: session.revision, interactionId: 'interaction-repeat', kind: 'question', input: '房門有上鎖嗎？',
    },
    scenarioProvider: provider,
    judgeProvider: { async judge() { return { verdict: '是' }; } },
  });
  const first = revalidateAndApplyJudgment({ latestSession: session, prepared, engine: turtleSoupEngine });
  const duplicate = revalidateAndApplyJudgment({
    latestSession: activeSession(first.state), prepared, engine: turtleSoupEngine,
  });
  assert.equal(duplicate.progressed, false);
  assert.equal(duplicate.state.judgments.length, 1);
  assert.throws(
    () => revalidateAndApplyJudgment({
      latestSession: activeSession(first.state, { revision: session.revision + 1 }), prepared, engine: turtleSoupEngine,
    }),
    (error) => error?.code === 'SESSION_STALE' && error.retryable === true
  );
});

test('correct guess ends the session without persisting the guess text', async (t) => {
  const { rootDir, provider } = makeCorpus();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1', 'player-2'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  const session = activeSession(state);
  const prepared = await prepareTurtleSoupJudgment({
    session,
    request: {
      id: session.id, guildId: session.guildId, channelId: session.channelId, messageId: session.messageId,
      actorId: 'player-2', expectedRevision: session.revision, interactionId: 'interaction-win', kind: 'guess', input: '門被鎖，鑰匙在杯子下。',
    },
    scenarioProvider: provider,
    judgeProvider: { async judge() { return { verdict: '答對' }; } },
  });
  const result = revalidateAndApplyJudgment({ latestSession: session, prepared, engine: turtleSoupEngine });
  assert.deepEqual(result.outcome, {
    terminal: true, type: 'win', winnerIds: ['player-2'], loserIds: [], reason: 'turtle-soup-solved',
  });
  assert.equal(JSON.stringify(result.state).includes('鑰匙在杯子下'), false);
});

test('board store adapter revalidates core player DTO and commits a replay-safe CAS', async (t) => {
  const { rootDir, provider } = makeCorpus();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1', 'player-2'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  const storedSession = activeSession(state, {
    players: [
      { userId: 'host-1', seat: 0, status: 'active' },
      { userId: 'player-2', seat: 1, status: 'active' },
    ],
    hostId: 'host-1',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    lastProgressAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-23T00:00:00.000Z',
  });
  const store = new InMemoryBoardStore({ sessions: [storedSession], actions: [], interactions: [] });
  const prepared = await prepareTurtleSoupJudgment({
    session: await store.getSessionById(storedSession.id),
    request: {
      id: storedSession.id, guildId: storedSession.guildId, channelId: storedSession.channelId,
      messageId: storedSession.messageId, actorId: 'player-2', expectedRevision: storedSession.revision,
      interactionId: 'interaction-store', kind: 'question', input: '房門有上鎖嗎？',
    },
    scenarioProvider: provider,
    judgeProvider: { async judge() { return { verdict: '是' }; } },
  });
  const commitPrepared = createBoardStoreJudgeCommitter({ store, clock: () => new Date('2026-09-22T01:00:00.000Z') });
  const apply = (latestSession) => revalidateAndApplyJudgment({
    latestSession, prepared, engine: turtleSoupEngine, now: '2026-09-22T01:00:00.000Z',
  });
  const first = await commitPrepared({ prepared, apply });
  const replay = await commitPrepared({ prepared, apply });
  const snapshot = store.snapshot();

  assert.equal(first.session.revision, storedSession.revision + 1);
  assert.equal(replay.replayed, true);
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].action.verdict, '是');
  assert.equal(JSON.stringify(snapshot).includes('房門有上鎖嗎'), false);
  assert.equal(snapshot.sessions[0].state.judgments.length, 1);
});

test('judge workflow replays duplicate interaction before provider I/O and rejects stale new work', async (t) => {
  const { rootDir, provider } = makeCorpus();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1', 'player-2'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  const storedSession = activeSession(state, {
    players: [
      { userId: 'host-1', seat: 0, status: 'active' },
      { userId: 'player-2', seat: 1, status: 'active' },
    ],
    hostId: 'host-1', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    lastProgressAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-23T00:00:00.000Z',
  });
  const store = new InMemoryBoardStore({ sessions: [storedSession], actions: [], interactions: [] });
  let providerCalls = 0;
  const workflow = createTurtleSoupJudgeWorkflow({
    loadSession: ({ id }) => store.getSessionById(id),
    scenarioProvider: provider,
    judgeProvider: { async judge() { providerCalls += 1; return { verdict: '是' }; } },
    commitPrepared: createBoardStoreJudgeCommitter({ store, clock: () => new Date('2026-09-22T01:00:00.000Z') }),
    engine: turtleSoupEngine,
    clock: () => new Date('2026-09-22T01:00:00.000Z'),
  });
  const input = {
    id: storedSession.id, guildId: storedSession.guildId, channelId: storedSession.channelId,
    messageId: storedSession.messageId, actorId: 'player-2', expectedRevision: storedSession.revision,
    interactionId: 'interaction-workflow', kind: 'question', input: '房門有上鎖嗎？',
  };
  const first = await workflow.submit(input);
  const replay = await workflow.submit(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(providerCalls, 1);

  await assert.rejects(
    () => workflow.submit({ ...input, interactionId: 'interaction-stale', input: '鑰匙在杯子下嗎？' }),
    (error) => error?.code === 'STALE_REVISION'
  );
  assert.equal(providerCalls, 1);
});

test('retired participant cannot judge even though historical engine players are retained', async (t) => {
  const { rootDir, provider } = makeCorpus();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1', 'player-2'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  const storedSession = activeSession(state, {
    players: [
      { userId: 'host-1', seat: 0, status: 'active' },
      { userId: 'player-2', seat: 1, status: 'retired' },
    ],
    hostId: 'host-1', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    lastProgressAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-23T00:00:00.000Z',
  });
  const store = new InMemoryBoardStore({ sessions: [storedSession], actions: [], interactions: [] });
  let providerCalls = 0;
  const workflow = createTurtleSoupJudgeWorkflow({
    loadSession: ({ id }) => store.getSessionById(id),
    scenarioProvider: provider,
    judgeProvider: { async judge() { providerCalls += 1; return { verdict: '是' }; } },
    commitPrepared: createBoardStoreJudgeCommitter({ store }),
    engine: turtleSoupEngine,
  });
  await assert.rejects(
    () => workflow.submit({
      id: storedSession.id, guildId: storedSession.guildId, channelId: storedSession.channelId,
      messageId: storedSession.messageId, actorId: 'player-2', expectedRevision: storedSession.revision,
      interactionId: 'interaction-retired', kind: 'question', input: '房門有上鎖嗎？',
    }),
    (error) => error?.code === 'NOT_PARTICIPANT'
  );
  assert.equal(providerCalls, 0);
});

test('judgment store adapter rejects input mutation before persistence', async () => {
  const state = turtleSoupEngine.createInitialState({
    players: ['host-1'], rules: { scenarioId: 'synthetic-room', scenarioVersion: 1 }, seed: 'seed',
  });
  const storedSession = activeSession(state, {
    players: [{ userId: 'host-1', seat: 0, status: 'active' }],
    hostId: 'host-1', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    lastProgressAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-23T00:00:00.000Z',
  });
  const store = new InMemoryBoardStore({ sessions: [storedSession], actions: [], interactions: [] });
  const commitPrepared = createBoardStoreJudgeCommitter({ store });
  const prepared = {
    sessionId: storedSession.id, guildId: storedSession.guildId, channelId: storedSession.channelId,
    messageId: storedSession.messageId, actorId: 'host-1', expectedRevision: storedSession.revision,
    judgmentId: 'interaction-mutation', inputDigest: 'a'.repeat(64), kind: 'question', verdict: '是',
  };
  await assert.rejects(
    () => commitPrepared({
      prepared,
      apply(latestSession) {
        latestSession.state.judgments.push({ injected: true });
        return { state: latestSession.state, outcome: null, events: [{ type: 'synthetic' }], progressed: true };
      },
    }),
    (error) => error?.code === 'ENGINE_CONTRACT_VIOLATION'
  );
  assert.deepEqual(store.snapshot().sessions[0], storedSession);
  assert.equal(store.snapshot().actions.length, 0);
});
