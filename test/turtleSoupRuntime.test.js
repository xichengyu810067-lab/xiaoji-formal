const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildBoardCustomId } = require('../src/games/discord/boardCustomId');
const {
  JUDGE_READY,
  createBoardDiscordRuntime,
  formatTurtleSoupStartupLog,
  logTurtleSoupStartup,
} = require('../src/games/discord/boardDiscordRuntime');
const {
  JUDGE_UNAVAILABLE_MESSAGE,
  LOCAL_BUSY_MESSAGE,
  RATE_LIMIT_MESSAGE,
} = require('../src/games/discord/turtleSoupDiscordAdapter');
const { buildAndVerifyScenarioIndex, main: runBuildIndexCli } = require('../src/games/turtleSoup/buildIndexCli');
const { TurtleSoupError } = require('../src/games/turtleSoup/errors');
const { createJudgeProvider, normalizeProviderError } = require('../src/games/turtleSoup/providerAdapter');
const { turtleSoupSpamGuard } = require('../src/systems/conversation/aiSpamGuard');
const {
  CORPUS_EMPTY,
  CORPUS_INDEX_MISSING,
  CORPUS_INVALID,
  CORPUS_NOT_CONFIGURED,
  CORPUS_PERMISSION_DENIED,
  CORPUS_READY,
  CORPUS_ROOT_MISSING,
  CORPUS_UNAVAILABLE,
  INDEX_FILE_NAME,
  buildScenarioIndex,
  createFileScenarioProvider,
  prepareFileScenarioProvider,
} = require('../src/games/turtleSoup/scenarioProvider');
const {
  BLOCK_REASONS,
  DEFAULT_PROVIDER_GUARD_CONFIG,
  LocalProviderGuardError,
  ProviderCallGuard,
  providerCallGuard,
} = require('../src/systems/conversation/providerGuard');
const {
  CONVERSATION_SAFETY_EVENT_CODES,
  setConversationSafetyEventHandler,
} = require('../src/systems/conversation/safetyEvents');
const { OwnerSafetyNotifier } = require('../src/systems/safety/ownerSafetyNotifier');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');


// Each test starts with the judge's anti-spam gate empty (aiSpamGuard.js): these tests are about the
// provider guard and the game, and many of them ask the same player's questions within one second.
test.beforeEach(() => turtleSoupSpamGuard.resetForTests());

function syntheticScenario() {
  return {
    schemaVersion: 1,
    id: 'synthetic-red-door',
    version: 1,
    locale: 'zh-TW',
    difficulty: 'easy',
    title: '合成測試題',
    publicPrompt: '有人回家後看見紅門，便知道計畫成功。為什麼？',
    revealText: '合成揭曉：紅門被鎖，鑰匙在杯子下。',
    facts: [
      { id: 'red_door', statement: '紅門被鎖。', keywords: ['紅門', '鎖'] },
      { id: 'cup_key', statement: '鑰匙在杯子下。', keywords: ['鑰匙', '杯子'] },
    ],
    solutionFactIds: ['red_door', 'cup_key'],
    contradictions: [{ id: 'not_broken', statement: '門沒有損壞。' }],
    tags: ['synthetic'],
  };
}

function makeCorpus(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-turtle-runtime-'));
  const scenarioPath = path.join(rootDir, 'synthetic-red-door.json');
  fs.writeFileSync(scenarioPath, JSON.stringify(syntheticScenario()), 'utf8');
  buildScenarioIndex({ rootDir });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, scenarioPath };
}

function recoverableStore() {
  const store = new InMemoryBoardStore();
  store.listRecoverable = async ({ now, limit }) => store.snapshot().sessions
    .filter((session) => ['lobby', 'active'].includes(session.status) && session.expiresAt > now)
    .slice(0, limit);
  return store;
}

function fakeTransport() {
  const updates = [];
  return {
    updates,
    async update(value) { updates.push(value); },
    async messageExists() { return true; },
  };
}

let nextInteractionId = 0;
function commandInteraction(game = 'turtle-soup') {
  const output = { edits: [], replies: [], followUps: [] };
  return {
    id: `command-${++nextInteractionId}`,
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'player-1' },
    options: {
      getSubcommand: () => 'start',
      getString: () => game,
    },
    deferred: false,
    replied: false,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { output.edits.push(payload); },
    async reply(payload) { this.replied = true; output.replies.push(payload); },
    async followUp(payload) { output.followUps.push(payload); },
    async fetchReply() { return { id: 'board-message-1' }; },
    output,
  };
}

function componentInteraction({ sessionId, revision, verb, actorId, input = '', modal = true }) {
  const output = { edits: [], replies: [], followUps: [] };
  return {
    id: `component-${++nextInteractionId}`,
    customId: buildBoardCustomId({ sessionId, revision, verb }),
    guildId: 'guild-1',
    channelId: 'channel-1',
    message: { id: 'board-message-1' },
    user: { id: actorId },
    fields: { getTextInputValue: () => input },
    deferred: false,
    replied: false,
    isButton: () => !modal,
    isModalSubmit: () => modal,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { output.edits.push(payload); },
    async reply(payload) { this.replied = true; output.replies.push(payload); },
    async followUp(payload) { output.followUps.push(payload); },
    output,
  };
}

// `warnings` (optional) also captures the logger's warn() calls; `overrides` reach the runtime as-is.
function createRuntime({ rootDir, store, judgeProvider, transport = fakeTransport(), logs = [], warnings = null, ...overrides }) {
  let generatedId = 0;
  const runtime = createBoardDiscordRuntime({
    privateCorpusRoot: rootDir,
    store,
    judgeProvider,
    transport,
    idFactory: () => `session-${++generatedId}`,
    seedFactory: () => `seed-${generatedId}`,
    clock: () => new Date('2026-09-30T00:00:00.000Z'),
    renderPngImpl: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    runtimeLogger: {
      error(...values) { logs.push(values); },
      ...(warnings ? { warn(...values) { warnings.push(values); } } : {}),
    },
    ...overrides,
  });
  return { runtime, transport, logs };
}

test('corpus readiness validates every indexed scenario without returning story text', (t) => {
  const missing = prepareFileScenarioProvider();
  assert.deepEqual(missing.readiness, { ready: false, code: CORPUS_NOT_CONFIGURED, scenarioCount: 0 });
  assert.equal(missing.provider, null);

  const { rootDir, scenarioPath } = makeCorpus(t);
  const ready = prepareFileScenarioProvider({ rootDir });
  assert.deepEqual(ready.readiness, { ready: true, code: CORPUS_READY, scenarioCount: 1 });
  assert.equal(typeof ready.provider.loadScenario, 'function');
  assert.equal(JSON.stringify(ready.readiness).includes('合成揭曉'), false);

  fs.writeFileSync(scenarioPath, '{"schemaVersion":1}', 'utf8');
  const invalid = prepareFileScenarioProvider({ rootDir });
  assert.deepEqual(invalid.readiness, { ready: false, code: 'CORPUS_INVALID', scenarioCount: 0 });
  assert.equal(invalid.provider, null);
});

test('judge provider recognizes chat rate limits and rejects non-enumerated output', async () => {
  for (const error of [
    { status: 429 },
    { statusCode: 429 },
    { response: { status: 429 } },
    { type: 'insufficient_quota' },
    { response: { data: { error: { code: 'model_rate_limit_exceeded' } } } },
  ]) {
    const normalized = normalizeProviderError(error);
    assert.equal(normalized.code, 'JUDGE_RATE_LIMITED');
    assert.equal(normalized.retryable, true);
  }

  const invalid = createJudgeProvider({
    model: 'synthetic-judge',
    client: {
      chat: { completions: { async create() { return { choices: [{ message: { content: '{"verdict":"也許"}' } }] }; } } },
    },
  });
  await assert.rejects(
    () => invalid.judge({
      kind: 'question',
      input: '合成問題',
      evidence: [{ id: 'fact', statement: '合成證據', source: 'fact', solution: true }],
      context: { userId: 'player-1', guildId: 'guild-1', channelId: 'channel-1' },
    }),
    (error) => error?.code === 'JUDGE_INVALID_OUTPUT'
  );
});

test('validated external corpus supports multiplayer judgment, failure recovery, restart, and private reveal', async (t) => {
  const { rootDir, scenarioPath } = makeCorpus(t);
  const store = recoverableStore();
  const logs = [];
  const requests = [];
  let judgeMode = 'rate-limit';
  const judgeProvider = createJudgeProvider({
    model: 'synthetic-judge',
    client: {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            if (judgeMode === 'rate-limit') throw { statusCode: 429 };
            const task = JSON.parse(request.messages[1].content).task;
            return { choices: [{ message: { content: JSON.stringify({ verdict: task === 'guess' ? '答對' : '是' }) } }] };
          },
        },
      },
    },
  });
  const first = createRuntime({ rootDir, store, judgeProvider, logs });
  assert.deepEqual(first.runtime.getTurtleSoupReadiness(), { ready: true, code: CORPUS_READY, scenarioCount: 1 });

  const started = await first.runtime.executeCommand(commandInteraction());
  assert.equal(started.session.gameKey, 'turtle-soup');
  assert.equal(started.session.messageId, 'board-message-1');

  let session = await store.getActiveSession({ guildId: 'guild-1', channelId: 'channel-1' });
  await first.runtime.service.join({
    guildId: session.guildId,
    channelId: session.channelId,
    actorId: 'player-2',
    expectedRevision: session.revision,
    interactionId: 'join-player-2',
  });
  session = await store.getSessionById(session.id);
  await first.runtime.service.begin({
    guildId: session.guildId,
    channelId: session.channelId,
    actorId: 'player-1',
    expectedRevision: session.revision,
    interactionId: 'begin-turtle-soup',
  });
  session = await store.getSessionById(session.id);
  assert.equal(session.status, 'active');
  assert.equal(session.players.length, 2);

  const limited = componentInteraction({
    sessionId: session.id,
    revision: session.revision,
    verb: 'act.ask',
    actorId: 'player-2',
    input: '紅門有鎖嗎？',
  });
  await first.runtime.handleInteraction(limited);
  assert.equal(limited.output.edits.at(-1).content, '小吉有點累了，請稍後再跟我聊天');
  assert.equal((await store.getSessionById(session.id)).revision, session.revision);

  const hiddenPath = `${scenarioPath}.temporarily-unavailable`;
  fs.renameSync(scenarioPath, hiddenPath);
  const missingCorpus = componentInteraction({
    sessionId: session.id,
    revision: session.revision,
    verb: 'act.ask',
    actorId: 'player-1',
    input: '紅門仍然有鎖嗎？',
  });
  await first.runtime.handleInteraction(missingCorpus);
  assert.equal(missingCorpus.output.edits.at(-1).content, '小吉暫時無法判題，棋局已保留，請稍後再試。');
  assert.equal((await store.getSessionById(session.id)).revision, session.revision);
  fs.renameSync(hiddenPath, scenarioPath);

  judgeMode = 'normal';
  const questionInput = '紅門確實被鎖住了嗎？';
  const question = componentInteraction({
    sessionId: session.id,
    revision: session.revision,
    verb: 'act.ask',
    actorId: 'player-2',
    input: questionInput,
  });
  await first.runtime.handleInteraction(question);
  assert.equal(question.output.edits.at(-1).content, '是');
  session = await store.getSessionById(session.id);
  assert.equal(session.revision, 4);

  const restarted = createRuntime({ rootDir, store, judgeProvider, logs });
  const recovery = await restarted.runtime.startLifecycle();
  assert.deepEqual(recovery, { started: true, recovered: 1 });
  assert.equal(restarted.runtime.lifecycle.trackedCount(), 1);

  const guessInput = '完整猜測：紅門被鎖，而且鑰匙在杯子下。';
  const guess = componentInteraction({
    sessionId: session.id,
    revision: session.revision,
    verb: 'act.guess',
    actorId: 'player-1',
    input: guessInput,
  });
  await restarted.runtime.handleInteraction(guess);
  assert.match(guess.output.edits.at(-1).content, /答對/);
  session = await store.getSessionById(session.id);
  assert.equal(session.status, 'completed');

  const reveal = componentInteraction({
    sessionId: session.id,
    revision: session.revision,
    verb: 'reveal',
    actorId: 'player-2',
    modal: false,
  });
  await restarted.runtime.handleInteraction(reveal);
  assert.equal(reveal.output.edits.at(-1).content, syntheticScenario().revealText);

  const outsider = componentInteraction({
    sessionId: session.id,
    revision: session.revision,
    verb: 'reveal',
    actorId: 'outsider',
    modal: false,
  });
  await restarted.runtime.handleInteraction(outsider);
  assert.notEqual(outsider.output.edits.at(-1).content, syntheticScenario().revealText);

  const persisted = JSON.stringify(store.snapshot());
  assert.equal(persisted.includes(questionInput), false);
  assert.equal(persisted.includes(guessInput), false);
  assert.equal(persisted.includes(syntheticScenario().revealText), false);
  assert.equal(JSON.stringify(logs).includes(questionInput), false);
  assert.equal(JSON.stringify(logs).includes(guessInput), false);
  assert.equal(JSON.stringify(logs).includes(syntheticScenario().revealText), false);
  assert.equal(requests.some((request) => JSON.stringify(request).includes('Recent conversation')), false);
  assert.equal(requests.some((request) => JSON.stringify(request).includes('聊天助手')), true);
  await restarted.runtime.stopLifecycle();
});

test('unconfigured corpus fails before creating a room and exposes only readiness metadata', async () => {
  const store = recoverableStore();
  const { runtime } = createRuntime({
    rootDir: null,
    store,
    judgeProvider: { async judge() { return { verdict: '是' }; } },
  });
  assert.deepEqual(runtime.getTurtleSoupReadiness(), {
    ready: false,
    code: CORPUS_NOT_CONFIGURED,
    scenarioCount: 0,
  });
  const result = await runtime.executeCommand(commandInteraction());
  assert.equal(result.code, 'CORPUS_UNAVAILABLE');
  assert.equal(await store.getActiveSession({ guildId: 'guild-1', channelId: 'channel-1' }), null);
});

// ---------------------------------------------------------------------------------------------
// Diagnostics: each corpus and judge failure has its own code, and none of the logs or readiness
// objects carries a private path, a player question, or story text.
// ---------------------------------------------------------------------------------------------

function failedReadiness(code, scenarioCount = 0) {
  return { ready: false, code, scenarioCount };
}

// Makes one fs method fail for matching paths only; everything else passes straight through. The
// message embeds the path (as Node's own messages do), so any leak into a result is visible.
function failFileSystem(t, method, matches, errno = 'EACCES') {
  const original = fs[method];
  return t.mock.method(fs, method, function failing(target, ...rest) {
    if (matches(String(target))) {
      throw Object.assign(new Error(`${errno}: simulated failure, '${target}'`), { code: errno });
    }
    return original.call(this, target, ...rest);
  });
}

async function startActiveSession(runtime, store) {
  const started = await runtime.executeCommand(commandInteraction());
  assert.equal(started.session.gameKey, 'turtle-soup');
  let session = await store.getActiveSession({ guildId: 'guild-1', channelId: 'channel-1' });
  await runtime.service.join({
    guildId: session.guildId,
    channelId: session.channelId,
    actorId: 'player-2',
    expectedRevision: session.revision,
    interactionId: `join-${session.id}`,
  });
  session = await store.getSessionById(session.id);
  await runtime.service.begin({
    guildId: session.guildId,
    channelId: session.channelId,
    actorId: 'player-1',
    expectedRevision: session.revision,
    interactionId: `begin-${session.id}`,
  });
  session = await store.getSessionById(session.id);
  assert.equal(session.status, 'active');
  return session;
}

async function submitAction(runtime, store, sessionId, { actorId, verb = 'act.ask', input }) {
  const session = await store.getSessionById(sessionId);
  const interaction = componentInteraction({ sessionId, revision: session.revision, verb, actorId, input });
  await runtime.handleInteraction(interaction);
  return interaction;
}

test('corpus readiness gives root, index, content, and empty failures their own codes', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-turtle-codes-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const results = [];
  const readiness = (rootDir) => {
    const prepared = prepareFileScenarioProvider({ rootDir });
    results.push(prepared.readiness);
    assert.equal(prepared.provider === null, !prepared.readiness.ready);
    return prepared.readiness;
  };

  assert.deepEqual(readiness(path.join(base, 'absent-root')), failedReadiness('CORPUS_ROOT_MISSING'));

  const fileRoot = path.join(base, 'root-is-a-file');
  fs.writeFileSync(fileRoot, 'not a directory', 'utf8');
  assert.deepEqual(readiness(fileRoot), failedReadiness('CORPUS_ROOT_MISSING'));

  const corpus = path.join(base, 'corpus');
  fs.mkdirSync(corpus);
  const scenarioPath = path.join(corpus, 'synthetic-red-door.json');
  fs.writeFileSync(scenarioPath, JSON.stringify(syntheticScenario()), 'utf8');
  assert.deepEqual(readiness(corpus), failedReadiness('CORPUS_INDEX_MISSING'));

  const indexPath = path.join(corpus, INDEX_FILE_NAME);
  const damagedIndexes = [
    '{ not json',
    '[]',
    JSON.stringify({ schemaVersion: 2, scenarios: [] }),
    JSON.stringify({ schemaVersion: 1, scenarios: [{ id: '../escape', version: 1, relativePath: 'x.json' }] }),
  ];
  for (const damaged of damagedIndexes) {
    fs.writeFileSync(indexPath, damaged, 'utf8');
    assert.deepEqual(readiness(corpus), failedReadiness('CORPUS_INVALID'), damaged);
  }

  fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, scenarios: [] }), 'utf8');
  assert.deepEqual(readiness(corpus), failedReadiness('CORPUS_EMPTY'));

  buildScenarioIndex({ rootDir: corpus });
  assert.deepEqual(readiness(corpus), { ready: true, code: CORPUS_READY, scenarioCount: 1 });

  fs.writeFileSync(scenarioPath, '{ not json', 'utf8');
  assert.deepEqual(readiness(corpus), failedReadiness('CORPUS_INVALID'));

  fs.rmSync(scenarioPath);
  assert.deepEqual(readiness(corpus), failedReadiness('CORPUS_UNAVAILABLE'));

  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes(path.basename(base)), false);
  assert.equal(serialized.includes(syntheticScenario().revealText), false);
});

test('unreadable corpus parts are permission failures and other I/O faults stay unavailable', (t) => {
  const { rootDir } = makeCorpus(t);
  const rootName = path.basename(rootDir);
  const prepareWithFault = (method, matches, errno) => {
    const failing = failFileSystem(t, method, matches, errno);
    try {
      return prepareFileScenarioProvider({ rootDir }).readiness;
    } finally {
      failing.mock.restore();
    }
  };

  assert.deepEqual(
    prepareWithFault('statSync', (target) => target.includes(rootName), 'EACCES'),
    failedReadiness('CORPUS_PERMISSION_DENIED')
  );
  assert.deepEqual(
    prepareWithFault('readFileSync', (target) => target.endsWith(INDEX_FILE_NAME), 'EPERM'),
    failedReadiness('CORPUS_PERMISSION_DENIED')
  );
  assert.deepEqual(
    prepareWithFault('readFileSync', (target) => target.endsWith('synthetic-red-door.json'), 'EACCES'),
    failedReadiness('CORPUS_PERMISSION_DENIED')
  );
  assert.deepEqual(
    prepareWithFault('readFileSync', (target) => target.endsWith(INDEX_FILE_NAME), 'EIO'),
    failedReadiness('CORPUS_UNAVAILABLE')
  );
  assert.deepEqual(prepareFileScenarioProvider({ rootDir }).readiness, { ready: true, code: CORPUS_READY, scenarioCount: 1 });
});

test('corpus errors carry a stable code and a fixed message, never the private path or a cause', (t) => {
  const { rootDir } = makeCorpus(t);
  const leakFree = (error) => {
    assert.equal(error instanceof TurtleSoupError, true);
    assert.equal(error.message.includes(rootDir), false);
    assert.equal(error.message.includes(path.basename(rootDir)), false);
    assert.equal(error.cause, undefined);
    return true;
  };

  assert.throws(
    () => createFileScenarioProvider({ rootDir: path.join(rootDir, 'absent') }),
    (error) => error.code === 'CORPUS_ROOT_MISSING' && leakFree(error)
  );
  fs.rmSync(path.join(rootDir, INDEX_FILE_NAME));
  assert.throws(
    () => createFileScenarioProvider({ rootDir }),
    (error) => error.code === 'CORPUS_INDEX_MISSING' && leakFree(error)
  );
  buildScenarioIndex({ rootDir });
  const failing = failFileSystem(t, 'readFileSync', (target) => target.endsWith(INDEX_FILE_NAME));
  assert.throws(
    () => createFileScenarioProvider({ rootDir }),
    (error) => error.code === 'CORPUS_PERMISSION_DENIED' && leakFree(error)
  );
  failing.mock.restore();
});

test('a corpus prepared elsewhere and found unusable keeps its readiness code in the runtime', async () => {
  const store = recoverableStore();
  const logs = [];
  const absentRoot = path.join(os.tmpdir(), `xiaoji-turtle-absent-${process.pid}-${Date.now()}`);
  const prepared = prepareFileScenarioProvider({ rootDir: absentRoot });
  assert.equal(prepared.provider, null);

  const { runtime } = createRuntime({
    rootDir: null,
    store,
    logs,
    judgeProvider: { async judge() { return { verdict: '是' }; } },
    scenarioProvider: prepared.provider,
    scenarioProviderReadiness: prepared.readiness,
  });
  assert.deepEqual(runtime.getTurtleSoupReadiness(), failedReadiness('CORPUS_ROOT_MISSING'));
  assert.equal(runtime.hasPrivateCorpus(), false);

  const result = await runtime.executeCommand(commandInteraction());
  assert.equal(result.code, 'CORPUS_UNAVAILABLE');
  assert.equal(await store.getActiveSession({ guildId: 'guild-1', channelId: 'channel-1' }), null);
  const [message, error] = logs.at(-1);
  assert.equal(message, 'board command failed code=CORPUS_UNAVAILABLE');
  assert.match(error.message, /CORPUS_ROOT_MISSING/u);
  assert.equal(`${message} ${error.message}`.includes(path.basename(absentRoot)), false);
});

test('caller-supplied readiness never claims ready without a provider or carries a log-unsafe code', () => {
  const judgeProvider = { async judge() { return { verdict: '是' }; } };
  const provider = {
    listScenarioReferences: () => [],
    loadScenario() { throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Synthetic corpus.'); },
    selectScenarioReference() { throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Synthetic corpus.'); },
  };
  const readinessOf = (overrides) => createRuntime({
    rootDir: null,
    store: recoverableStore(),
    judgeProvider,
    ...overrides,
  }).runtime.getTurtleSoupReadiness();

  assert.deepEqual(
    readinessOf({ scenarioProvider: null, scenarioProviderReadiness: { ready: true, code: CORPUS_READY, scenarioCount: 3 } }),
    failedReadiness('CORPUS_UNAVAILABLE', 3)
  );
  assert.deepEqual(
    readinessOf({ scenarioProvider: null, scenarioProviderReadiness: failedReadiness('C:\\private\\corpus is missing') }),
    failedReadiness('CORPUS_UNAVAILABLE')
  );
  assert.deepEqual(
    readinessOf({ scenarioProvider: provider, scenarioProviderReadiness: failedReadiness('CORPUS_INVALID') }),
    failedReadiness('CORPUS_INVALID')
  );
  assert.deepEqual(readinessOf({ scenarioProvider: provider }), { ready: true, code: CORPUS_READY, scenarioCount: null });
  assert.deepEqual(readinessOf({}), failedReadiness(CORPUS_NOT_CONFIGURED));
});

test('judge readiness is recorded at startup and the startup line holds codes and counts only', (t) => {
  const saved = { GROQ_API_KEY: process.env.GROQ_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { rootDir } = makeCorpus(t);

  assert.throws(() => createJudgeProvider(), (error) => error.code === 'JUDGE_NOT_CONFIGURED' && error.retryable === true);
  const missing = createRuntime({ rootDir, store: recoverableStore() }).runtime;
  assert.deepEqual(missing.getTurtleSoupJudgeReadiness(), { ready: false, code: 'JUDGE_NOT_CONFIGURED' });
  assert.equal(
    formatTurtleSoupStartupLog(missing),
    '[TURTLE_SOUP] corpus readiness=CORPUS_READY scenarioCount=1 judgeReadiness=JUDGE_NOT_CONFIGURED'
  );

  // A configured key builds the judge without contacting any provider.
  process.env.OPENAI_API_KEY = 'synthetic-judge-key-not-real';
  const configured = createRuntime({ rootDir, store: recoverableStore() }).runtime;
  assert.deepEqual(configured.getTurtleSoupJudgeReadiness(), { ready: true, code: JUDGE_READY });
  const configuredLine = formatTurtleSoupStartupLog(configured);
  assert.equal(configuredLine, '[TURTLE_SOUP] corpus readiness=CORPUS_READY scenarioCount=1 judgeReadiness=JUDGE_READY');
  assert.equal(configuredLine.includes('synthetic-judge-key'), false);
  assert.equal(configuredLine.includes(path.basename(rootDir)), false);

  const injected = createRuntime({
    rootDir: null,
    store: recoverableStore(),
    judgeProvider: { async judge() { return { verdict: '是' }; } },
  }).runtime;
  assert.equal(
    formatTurtleSoupStartupLog(injected),
    '[TURTLE_SOUP] corpus readiness=CORPUS_NOT_CONFIGURED scenarioCount=0 judgeReadiness=JUDGE_READY'
  );
});

test('startup logging warns for a broken configured corpus or a missing judge and stays routine otherwise', () => {
  const runtimeWith = (corpus, judge) => ({
    getTurtleSoupReadiness: () => corpus,
    getTurtleSoupJudgeReadiness: () => judge,
  });
  const written = [];
  const capture = {
    info(message) { written.push(['info', message]); },
    warn(message) { written.push(['warn', message]); },
  };
  const ready = { ready: true, code: CORPUS_READY, scenarioCount: 2 };
  const judgeReady = { ready: true, code: JUDGE_READY };
  const judgeMissing = { ready: false, code: 'JUDGE_NOT_CONFIGURED' };

  logTurtleSoupStartup(runtimeWith(failedReadiness(CORPUS_NOT_CONFIGURED), judgeMissing), capture);
  logTurtleSoupStartup(runtimeWith(ready, judgeReady), capture);
  logTurtleSoupStartup(runtimeWith(ready, judgeMissing), capture);
  logTurtleSoupStartup(runtimeWith(failedReadiness('CORPUS_INDEX_MISSING'), judgeReady), capture);

  assert.deepEqual(written.map(([level]) => level), ['info', 'info', 'warn', 'warn']);
  assert.equal(written[2][1], '[TURTLE_SOUP] corpus readiness=CORPUS_READY scenarioCount=2 judgeReadiness=JUDGE_NOT_CONFIGURED');
  assert.equal(written[3][1], '[TURTLE_SOUP] corpus readiness=CORPUS_INDEX_MISSING scenarioCount=0 judgeReadiness=JUDGE_READY');
});

test('safe judge failures keep the session, tell the player, and are logged by code only', async (t) => {
  const { rootDir } = makeCorpus(t);
  const store = recoverableStore();
  const logs = [];
  const warnings = [];
  let nextFailure = 'JUDGE_RATE_LIMITED';
  const judgeProvider = {
    async judge() { throw new TurtleSoupError(nextFailure, 'Synthetic failure.', { retryable: true }); },
  };
  const { runtime } = createRuntime({ rootDir, store, judgeProvider, logs, warnings });
  const session = await startActiveSession(runtime, store);

  const expectations = [
    ['JUDGE_RATE_LIMITED', RATE_LIMIT_MESSAGE],
    ['JUDGE_LOCAL_BUSY', LOCAL_BUSY_MESSAGE],
    ['JUDGE_TIMEOUT', JUDGE_UNAVAILABLE_MESSAGE],
    ['JUDGE_INVALID_OUTPUT', JUDGE_UNAVAILABLE_MESSAGE],
    ['JUDGE_UNAVAILABLE', JUDGE_UNAVAILABLE_MESSAGE],
  ];
  const questions = [];
  for (const [code, message] of expectations) {
    nextFailure = code;
    const input = `合成提問${questions.length}：紅門有鎖嗎？`;
    questions.push(input);
    const interaction = await submitAction(runtime, store, session.id, { actorId: 'player-2', input });
    assert.equal(interaction.output.edits.at(-1).content, message, code);
    assert.equal(warnings.at(-1)[0], `[TURTLE_SOUP] safe failure action=ask code=${code}`);
  }

  nextFailure = 'JUDGE_TIMEOUT';
  const guessInput = '合成猜測：紅門被鎖，鑰匙在杯子下。';
  const guess = await submitAction(runtime, store, session.id, { actorId: 'player-1', verb: 'act.guess', input: guessInput });
  assert.equal(guess.output.edits.at(-1).content, JUDGE_UNAVAILABLE_MESSAGE);
  assert.equal(warnings.at(-1)[0], '[TURTLE_SOUP] safe failure action=guess code=JUDGE_TIMEOUT');

  assert.equal((await store.getSessionById(session.id)).revision, session.revision);
  assert.equal(warnings.length, expectations.length + 1);
  const recorded = JSON.stringify({
    warnings,
    logs: logs.map((values) => values.map((value) => value?.message ?? String(value))),
  });
  const story = syntheticScenario();
  for (const secret of [...questions, guessInput, path.basename(rootDir), story.revealText, story.publicPrompt]) {
    assert.equal(recorded.includes(secret), false, secret);
  }
});

test('a corpus file that becomes unreadable mid-game keeps the session and logs the permission code', async (t) => {
  const { rootDir, scenarioPath } = makeCorpus(t);
  const store = recoverableStore();
  const warnings = [];
  const { runtime } = createRuntime({
    rootDir,
    store,
    warnings,
    judgeProvider: { async judge() { return { verdict: '是' }; } },
  });
  const session = await startActiveSession(runtime, store);

  const failing = failFileSystem(t, 'readFileSync', (target) => target.endsWith(path.basename(scenarioPath)));
  const denied = await submitAction(runtime, store, session.id, { actorId: 'player-1', input: '紅門有鎖嗎？' });
  failing.mock.restore();
  assert.equal(denied.output.edits.at(-1).content, JUDGE_UNAVAILABLE_MESSAGE);
  assert.equal(warnings.at(-1)[0], '[TURTLE_SOUP] safe failure action=ask code=CORPUS_PERMISSION_DENIED');
  assert.equal((await store.getSessionById(session.id)).revision, session.revision);

  const retried = await submitAction(runtime, store, session.id, { actorId: 'player-1', input: '紅門有鎖嗎？' });
  assert.equal(retried.output.edits.at(-1).content, '是');
});

// ---------------------------------------------------------------------------------------------
// Judge calls go through the chat provider guard and keep its limits: per-player rate, duplicate
// input, in-flight and global concurrency, and timeout (a player's own limits are counted apart
// from chat's; see the quota tests further down). Their blocks are logged locally by code; unlike
// chat blocks they are never sent to the owner as safety events.
// ---------------------------------------------------------------------------------------------

function okClient(verdict = '是', onCall = () => {}) {
  return {
    chat: {
      completions: {
        async create(request, options) {
          onCall(request, options);
          return { choices: [{ message: { content: JSON.stringify({ verdict }) } }] };
        },
      },
    },
  };
}

function judgeRequest(overrides = {}) {
  return {
    kind: 'question',
    input: '合成問題一',
    evidence: [{ id: 'fact', statement: '合成證據', source: 'fact', solution: true }],
    context: { userId: 'player-1', guildId: 'guild-1', channelId: 'channel-1' },
    ...overrides,
  };
}

function guardWith(config = {}, events = []) {
  let now = 1_000;
  const guard = new ProviderCallGuard({
    perUserWindowMs: 1_000,
    perUserMaxRequests: 2,
    duplicateWindowMs: 300,
    globalConcurrency: 4,
    timeoutMs: 500,
    noticeCooldownMs: 100,
    stateTtlMs: 5_000,
    maxTrackedUsers: 16,
    ...config,
  }, {
    now: () => now,
    onBlocked(code, scope, at) { events.push({ code, scope, at }); },
  });
  return { guard, events, advance(ms) { now += ms; } };
}

const isLocalBusy = (error) => error?.code === 'JUDGE_LOCAL_BUSY' && error.retryable === true;

function captureLog() {
  const lines = [];
  return { lines, warn(message) { lines.push(message); } };
}

const THROTTLED = (reason) => `[TURTLE_SOUP] code=TURTLE_SOUP_JUDGE_THROTTLED reason=${reason}`;
const JUDGE_TIMEOUT_LINE = '[TURTLE_SOUP] code=TURTLE_SOUP_JUDGE_TIMEOUT';
const UNATTRIBUTED_LINE = '[TURTLE_SOUP] code=TURTLE_SOUP_JUDGE_UNATTRIBUTED';

test('the judge calls the model through the shared provider guard by default', async (t) => {
  providerCallGuard.resetForTests();
  t.after(() => providerCallGuard.resetForTests());
  let during;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    client: okClient('是', (_request, options) => {
      during = { stats: providerCallGuard.getStatsForTests(), signal: options?.signal };
    }),
  });

  assert.deepEqual(await judge.judge(judgeRequest()), { verdict: '是' });
  assert.deepEqual(during.stats, { activeCalls: 1, trackedUsers: 1, inFlightUsers: 1 });
  assert.equal(during.signal instanceof AbortSignal, true);
  assert.deepEqual(providerCallGuard.getStatsForTests(), { activeCalls: 0, trackedUsers: 1, inFlightUsers: 0 });
});

test('the judge request leaves enough completion tokens for a reasoning model to finish its JSON verdict', async () => {
  const { guard } = guardWith();
  let sent;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: captureLog(),
    client: okClient('是', (request) => { sent = request; }),
  });

  assert.deepEqual(await judge.judge(judgeRequest()), { verdict: '是' });
  assert.ok(sent.max_completion_tokens >= 500);
});

test('guard limits stop a judgment with JUDGE_LOCAL_BUSY before the model is called', async () => {
  const { guard, events, advance } = guardWith();
  const log = captureLog();
  let modelCalls = 0;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: okClient('是', () => { modelCalls += 1; }),
  });

  await judge.judge(judgeRequest({ input: '問題一' }));
  advance(1);
  await assert.rejects(() => judge.judge(judgeRequest({ input: '  問題一 ' })), isLocalBusy);
  assert.equal(modelCalls, 1);

  advance(300);
  await judge.judge(judgeRequest({ input: '問題二' }));
  advance(300);
  await assert.rejects(() => judge.judge(judgeRequest({ input: '問題三' })), isLocalBusy);
  assert.equal(modelCalls, 2);

  await judge.judge(judgeRequest({
    input: '問題三',
    context: { userId: 'player-2', guildId: 'guild-1', channelId: 'channel-1' },
  }));
  assert.equal(modelCalls, 3);

  // Both blocks were enforced, but neither was reported as a safety event; each left one local
  // line holding a code and the guard's reason, with no player, channel, or question text.
  assert.deepEqual(events, []);
  assert.deepEqual(log.lines, [THROTTLED('duplicate'), THROTTLED('user_rate')]);
  const written = JSON.stringify(log.lines);
  for (const secret of ['問題', 'player-1', 'guild-1', 'channel-1']) assert.equal(written.includes(secret), false, secret);
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 0, trackedUsers: 2, inFlightUsers: 0 });
});

test('a game question is not a duplicate of a chat message, or of a guess with the same words', async () => {
  const { guard } = guardWith({ perUserMaxRequests: 4 });
  const judge = createJudgeProvider({ model: 'synthetic-judge', guard, logger: captureLog(), client: okClient('是') });
  const chatContext = { userId: 'player-1', guildId: 'guild-1', channelId: 'channel-1' };

  await guard.execute(chatContext, '紅門有鎖', async () => 'chat reply');
  await judge.judge(judgeRequest({ input: '紅門有鎖' }));
  await assert.rejects(() => judge.judge(judgeRequest({ input: '紅門有鎖' })), isLocalBusy);

  const guessJudge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: captureLog(),
    client: okClient('答對'),
  });
  assert.deepEqual(await guessJudge.judge(judgeRequest({ kind: 'guess', input: '紅門有鎖' })), { verdict: '答對' });
});

test('an in-flight judgment blocks the same player and a full pool blocks everyone else', async () => {
  const { guard, events } = guardWith({ globalConcurrency: 1, perUserMaxRequests: 10 });
  const log = captureLog();
  // The gate also opens by itself, so a missing guard fails the assertions below instead of hanging.
  let release;
  const gate = new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    release = () => { clearTimeout(timer); resolve(); };
  });
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: {
      chat: {
        completions: {
          async create() {
            await gate;
            return { choices: [{ message: { content: '{"verdict":"是"}' } }] };
          },
        },
      },
    },
  });

  const first = judge.judge(judgeRequest({ input: '問題甲' }));
  await assert.rejects(() => judge.judge(judgeRequest({ input: '問題乙' })), isLocalBusy);
  await assert.rejects(
    () => judge.judge(judgeRequest({
      input: '問題丙',
      context: { userId: 'player-2', guildId: 'guild-1', channelId: 'channel-1' },
    })),
    isLocalBusy
  );
  release();
  assert.deepEqual(await first, { verdict: '是' });
  assert.deepEqual(events, []);
  assert.deepEqual(log.lines, [THROTTLED('user_busy'), THROTTLED('global_busy')]);
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 0, trackedUsers: 2, inFlightUsers: 0 });
  assert.deepEqual(await judge.judge(judgeRequest({ input: '問題丁' })), { verdict: '是' });
});

test('a hung model call is cut off by the guard timeout and its request is aborted', async () => {
  const { guard, events } = guardWith({ timeoutMs: 20 });
  const log = captureLog();
  let abortedSignal = null;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: {
      chat: {
        completions: {
          create(_request, options) {
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => {
                abortedSignal = options.signal;
                reject(new Error('aborted by the guard'));
              });
            });
          },
        },
      },
    },
  });

  await assert.rejects(
    () => judge.judge(judgeRequest()),
    (error) => error.code === 'JUDGE_TIMEOUT' && error.retryable === true
  );
  assert.equal(abortedSignal?.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.getStatsForTests().activeCalls, 0);
  // A cut-off call is also kept away from the owner and left as one local line.
  assert.deepEqual(events, []);
  assert.deepEqual(log.lines, [JUDGE_TIMEOUT_LINE]);
});

test('a judgment without a player identity is guarded under one shared bucket and says so in the log', async () => {
  const { guard, events } = guardWith({ perUserMaxRequests: 1 });
  const log = captureLog();
  let modelCalls = 0;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: okClient('是', () => { modelCalls += 1; }),
  });
  const { context: _omitted, ...withoutContext } = judgeRequest();

  await judge.judge({ ...withoutContext, input: '無身分問題一' });
  await assert.rejects(() => judge.judge({ ...withoutContext, input: '無身分問題二' }), isLocalBusy);
  assert.equal(modelCalls, 1);
  // One warning per call that fell into the shared bucket, then the throttle line of the second.
  assert.deepEqual(log.lines, [UNATTRIBUTED_LINE, UNATTRIBUTED_LINE, THROTTLED('user_rate')]);

  // A call that names its player is not reported as unattributed.
  log.lines.length = 0;
  await assert.rejects(
    () => judge.judge(judgeRequest({ context: { userId: 'player-9' } })),
    (error) => error.code === 'JUDGE_UNAVAILABLE'
  );
  assert.equal(modelCalls, 1);
  assert.deepEqual(log.lines, []);
  assert.deepEqual(events, []);
});

test('a logger that fails or is missing never changes the outcome of a judgment', async () => {
  const { guard, advance } = guardWith({ perUserMaxRequests: 1 });
  const { context: _omitted, ...withoutContext } = judgeRequest();
  for (const logger of [
    null,
    {},
    { warn() { throw new Error('the log destination is down'); } },
  ]) {
    advance(2_000); // past the player window and the duplicate window of the previous round
    // The same two questions again each round: the judge's anti-spam gate would call the third a repeat.
    turtleSoupSpamGuard.resetForTests();
    const judge = createJudgeProvider({ model: 'synthetic-judge', guard, logger, client: okClient('是') });
    assert.deepEqual(await judge.judge({ ...withoutContext, input: '無身分的第一個問題' }), { verdict: '是' });
    await assert.rejects(() => judge.judge({ ...withoutContext, input: '無身分的第二個問題' }), isLocalBusy);
  }
});

test('local guard blocks become retryable judge errors and a guard timeout stays a timeout', () => {
  for (const reason of [
    BLOCK_REASONS.DUPLICATE,
    BLOCK_REASONS.GLOBAL_BUSY,
    BLOCK_REASONS.USER_BUSY,
    BLOCK_REASONS.USER_RATE,
  ]) {
    const normalized = normalizeProviderError(new LocalProviderGuardError(reason, true));
    assert.equal(normalized.code, 'JUDGE_LOCAL_BUSY', reason);
    assert.equal(normalized.retryable, true);
  }
  const timeout = normalizeProviderError(new LocalProviderGuardError(BLOCK_REASONS.TIMEOUT, true));
  assert.equal(timeout.code, 'JUDGE_TIMEOUT');
  assert.equal(timeout.retryable, true);
});

test('the workflow tells the judge who is asking so the limits apply per player', async (t) => {
  const { rootDir } = makeCorpus(t);
  const store = recoverableStore();
  const seen = [];
  const judgeProvider = {
    async judge(request) {
      seen.push(request.context);
      return { verdict: '是' };
    },
  };
  const { runtime } = createRuntime({ rootDir, store, judgeProvider });
  const session = await startActiveSession(runtime, store);

  await submitAction(runtime, store, session.id, { actorId: 'player-2', input: '紅門確實被鎖住了嗎？' });
  assert.deepEqual(seen, [{ userId: 'player-2', guildId: 'guild-1', channelId: 'channel-1' }]);
});

test('a guard-blocked question keeps the session, asks the player to retry, and spares other players', async (t) => {
  const { rootDir } = makeCorpus(t);
  const store = recoverableStore();
  const warnings = [];
  const { guard, events, advance } = guardWith({
    perUserMaxRequests: 1,
    perUserWindowMs: 60_000,
    duplicateWindowMs: 60_000,
    stateTtlMs: 120_000,
  });
  const judgeLog = captureLog();
  const judgeProvider = createJudgeProvider({ model: 'synthetic-judge', guard, logger: judgeLog, client: okClient('是') });
  const { runtime } = createRuntime({ rootDir, store, judgeProvider, warnings });
  const session = await startActiveSession(runtime, store);

  const allowed = await submitAction(runtime, store, session.id, { actorId: 'player-2', input: '紅門確實被鎖住了嗎？' });
  assert.equal(allowed.output.edits.at(-1).content, '是');
  const afterAllowed = await store.getSessionById(session.id);

  const blocked = await submitAction(runtime, store, session.id, { actorId: 'player-2', input: '鑰匙在杯子下面嗎？' });
  assert.equal(blocked.output.edits.at(-1).content, LOCAL_BUSY_MESSAGE);
  assert.equal((await store.getSessionById(session.id)).revision, afterAllowed.revision);
  assert.equal(warnings.at(-1)[0], '[TURTLE_SOUP] safe failure action=ask code=JUDGE_LOCAL_BUSY');
  // The block was enforced and logged locally, and nothing was reported as a safety event.
  assert.deepEqual(events, []);
  assert.deepEqual(judgeLog.lines, [THROTTLED('user_rate')]);

  const other = await submitAction(runtime, store, session.id, { actorId: 'player-1', input: '鑰匙在杯子下面嗎？' });
  assert.equal(other.output.edits.at(-1).content, '是');
  assert.deepEqual(events, []);

  advance(60_001);
  const retried = await submitAction(runtime, store, session.id, { actorId: 'player-2', input: '鑰匙在杯子下面嗎？' });
  assert.equal(retried.output.edits.at(-1).content, '是');
});

test('judge throttling never reaches the owner notifier, while a blocked chat call still does', async (t) => {
  const notifier = new OwnerSafetyNotifier({
    client: {},
    ownerId: '444444444444444444',
    botId: '777777777777777777',
    logger: null,
  });
  const accepted = [];
  t.mock.method(notifier, 'accept', (event) => {
    accepted.push(event.code);
    return false;
  });
  notifier.install();
  t.after(() => notifier.stop());

  // No onBlocked override: blocks take the real route, from the guard to the notifier's intake.
  const now = 1_000;
  const guard = new ProviderCallGuard({
    perUserWindowMs: 60_000,
    perUserMaxRequests: 1,
    duplicateWindowMs: 60_000,
    globalConcurrency: 4,
    timeoutMs: 500,
    noticeCooldownMs: 100,
    stateTtlMs: 120_000,
    maxTrackedUsers: 16,
  }, { now: () => now });
  const log = captureLog();
  const judge = createJudgeProvider({ model: 'synthetic-judge', guard, logger: log, client: okClient('是') });

  await judge.judge(judgeRequest({ input: '問題一' }));
  await assert.rejects(() => judge.judge(judgeRequest({ input: '問題一' })), isLocalBusy);
  await assert.rejects(() => judge.judge(judgeRequest({ input: '問題二' })), isLocalBusy);
  assert.deepEqual(accepted, [], 'the owner notifier received a judge block');
  assert.deepEqual(log.lines, [THROTTLED('duplicate'), THROTTLED('user_rate')]);

  // The chat path calls the same guard without the option, so its blocks are still reported.
  const chat = { userId: 'chat-player', guildId: 'guild-1', channelId: 'channel-9' };
  await guard.execute(chat, '你好', async () => '你好呀');
  await assert.rejects(
    () => guard.execute(chat, '再問一次', async () => '你好呀'),
    (error) => error.reason === BLOCK_REASONS.USER_RATE
  );
  assert.deepEqual(accepted, [CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_USER_RATE]);
});

test('opting out of safety events changes no limit, notice cooldown, error, or slot', async (t) => {
  const received = [];
  t.after(setConversationSafetyEventHandler((event) => received.push(event.code)));

  // One scripted run through every kind of block, on a fresh guard with a fixed clock.
  async function runScript(options) {
    let now = 1_000;
    const guard = new ProviderCallGuard({
      perUserWindowMs: 10_000,
      perUserMaxRequests: 1,
      duplicateWindowMs: 5_000,
      globalConcurrency: 2,
      timeoutMs: 30,
      noticeCooldownMs: 200,
      stateTtlMs: 60_000,
      maxTrackedUsers: 8,
    }, { now: () => now });
    const player = (userId) => ({ userId, guildId: 'guild-1', channelId: 'channel-1' });
    const outcomes = [];
    const attempt = async (label, userId, input, operation = async () => 'ok') => {
      try {
        outcomes.push([label, await guard.execute(player(userId), input, operation, options)]);
      } catch (error) {
        outcomes.push([label, error.reason, error.shouldNotify]);
      }
    };

    await attempt('first', 'p1', 'a');
    await attempt('rate', 'p1', 'b');
    await attempt('rate again inside the cooldown', 'p1', 'c');
    now += 250;
    await attempt('rate after the cooldown', 'p1', 'd');
    await attempt('duplicate', 'p1', 'a');

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = guard.execute(player('p2'), 'held', async () => { await gate; return 'held'; }, options);
    await attempt('same player busy', 'p2', 'x');
    const filler = guard.execute(player('p3'), 'filler', async () => { await gate; return 'filler'; }, options);
    await attempt('pool full', 'p4', 'y');
    release();
    outcomes.push(['held', await held], ['filler', await filler]);

    await attempt('timeout', 'p5', 'z', () => new Promise(() => {}));
    outcomes.push(['stats', guard.getStatsForTests()]);
    return outcomes;
  }

  const quiet = await runScript({ emitSafetyEvents: false });
  const quietEvents = received.splice(0);
  const loud = await runScript(undefined);
  const loudEvents = received.splice(0);

  assert.deepEqual(quiet, loud);
  assert.deepEqual(quiet.map(([label, outcome]) => `${label}: ${typeof outcome === 'string' ? outcome : 'ok'}`), [
    'first: ok',
    'rate: user_rate',
    'rate again inside the cooldown: user_rate',
    'rate after the cooldown: user_rate',
    'duplicate: duplicate',
    'same player busy: user_busy',
    'pool full: global_busy',
    'held: held',
    'filler: filler',
    'timeout: timeout',
    'stats: ok',
  ]);
  assert.deepEqual(quiet.filter((row) => row[2] !== undefined).map((row) => row[2]), [true, false, true, false, true, true, true]);
  assert.deepEqual(quietEvents, []);
  assert.deepEqual(loudEvents, [
    'AI_GUARD_USER_RATE',
    'AI_GUARD_USER_RATE',
    'AI_GUARD_USER_RATE',
    'AI_GUARD_DUPLICATE',
    'AI_GUARD_USER_BUSY',
    'AI_GUARD_GLOBAL_BUSY',
    'AI_GUARD_TIMEOUT',
  ]);

  // Only an explicit false opts out; anything else keeps reporting, so a typo cannot silence chat.
  for (const options of [
    undefined,
    null,
    {},
    { emitSafetyEvents: true },
    { emitSafetyEvents: 0 },
    { emitSafetyEvents: null },
    { emitSafetyEvents: 'no' },
  ]) {
    const guard = new ProviderCallGuard({ perUserMaxRequests: 1 }, { now: () => 1_000 });
    const chat = { userId: 'chat-player', guildId: 'guild-1', channelId: 'channel-9' };
    await guard.execute(chat, 'a', async () => 'ok', options);
    await assert.rejects(() => guard.execute(chat, 'b', async () => 'ok', options));
    assert.deepEqual(received.splice(0), ['AI_GUARD_USER_RATE'], JSON.stringify(options));
  }
});

// ---------------------------------------------------------------------------------------------
// One guard serves chat and the judge, but each side counts its per-player limits (rate window,
// duplicate input, one call in flight, busy-notice cooldown) apart. A player's game questions never
// spend chat's allowance or put a chat block in front of the owner, and chat never spends the
// judge's. Only the pool of concurrent calls is still shared.
// ---------------------------------------------------------------------------------------------

// The reviewed production limits (4 requests per 20 seconds per player, 4 calls at once) on a
// fixed clock. Every block the guard reports to the safety-event hook is collected in `events`.
function productionGuard(config = {}) {
  let now = 1_000;
  const events = [];
  const guard = new ProviderCallGuard({ ...DEFAULT_PROVIDER_GUARD_CONFIG, ...config }, {
    now: () => now,
    onBlocked(code, scope) { events.push({ code, actorId: scope.actorId }); },
  });
  return { guard, events, advance(ms) { now += ms; } };
}

const PLAYER = Object.freeze({ userId: 'player-1', guildId: 'guild-1', channelId: 'channel-1' });
const reported = (code, actorId = 'player-1') => ({ code, actorId });
const USER_RATE_EVENT = CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_USER_RATE;

// What chat does with the guard: a provider call runs through execute (the fixed local replies of
// the chat preflight go through admit instead).
const chatCall = (guard, input, context = PLAYER) => guard.execute(context, input, async () => '聊天回覆');
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A gate that also opens by itself after a second, so a missing guard fails the assertions below
// instead of hanging the run.
function heldGate() {
  let release;
  const opened = new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    release = () => { clearTimeout(timer); resolve(); };
  });
  return { opened, release };
}

function gatedJudgeClient(gate) {
  return {
    chat: {
      completions: {
        async create() {
          await gate.opened;
          return { choices: [{ message: { content: '{"verdict":"是"}' } }] };
        },
      },
    },
  };
}

test('four judge questions inside the window leave the same player their full chat allowance', async () => {
  const { guard, events } = productionGuard();
  const log = captureLog();
  const judge = createJudgeProvider({ model: 'synthetic-judge', guard, logger: log, client: okClient('是') });

  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await judge.judge(judgeRequest({ input: `遊戲問題${index}` })), { verdict: '是' });
  }

  // Right after, the same player talks to 小吉. Three fixed local replies (the chat preflight) and a
  // provider call all fit in the chat allowance, and nothing reaches the owner.
  for (let index = 0; index < 3; index += 1) assert.doesNotThrow(() => guard.admit(PLAYER, `固定回覆${index}`));
  assert.equal(await chatCall(guard, '你好'), '聊天回覆');
  assert.deepEqual(events, []);
  assert.deepEqual(log.lines, []);

  // The chat limit itself is untouched: the fifth chat request is the one that is refused.
  assert.throws(() => guard.admit(PLAYER, '固定回覆三'),
    (error) => error.reason === BLOCK_REASONS.USER_RATE && error.shouldNotify === false);
  assert.deepEqual(events, [reported(USER_RATE_EVENT)]);
});

test('four chat requests inside the window leave the same player their full judge allowance', async () => {
  const { guard, events } = productionGuard();
  const log = captureLog();
  let modelCalls = 0;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: okClient('是', () => { modelCalls += 1; }),
  });

  for (let index = 0; index < 2; index += 1) guard.admit(PLAYER, `固定回覆${index}`);
  for (let index = 0; index < 2; index += 1) await chatCall(guard, `聊天${index}`);
  await assert.rejects(() => chatCall(guard, '聊天二'), (error) => error.reason === BLOCK_REASONS.USER_RATE);
  assert.deepEqual(events, [reported(USER_RATE_EVENT)]);

  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await judge.judge(judgeRequest({ input: `遊戲問題${index}` })), { verdict: '是' });
  }
  assert.equal(modelCalls, 4);

  // The judge's own limit is the one that applies to the fifth question, and it stays off the
  // owner's channel: the only event is still the chat block above.
  await assert.rejects(() => judge.judge(judgeRequest({ input: '遊戲問題四' })), isLocalBusy);
  assert.equal(modelCalls, 4);
  assert.deepEqual(log.lines, [THROTTLED('user_rate')]);
  assert.deepEqual(events, [reported(USER_RATE_EVENT)]);
});

test('the chat limit alone is unchanged: the fifth request in 20 seconds is refused and reported', async () => {
  const { guard, events, advance } = productionGuard();

  for (let index = 0; index < 4; index += 1) {
    if (index % 2) await chatCall(guard, `聊天${index}`);
    else guard.admit(PLAYER, `固定回覆${index}`);
  }
  assert.deepEqual(events, []);

  assert.throws(() => guard.admit(PLAYER, '固定回覆四'),
    (error) => error.reason === BLOCK_REASONS.USER_RATE && error.shouldNotify === false);
  await assert.rejects(() => chatCall(guard, '聊天四'),
    (error) => error.reason === BLOCK_REASONS.USER_RATE && error.shouldNotify === true);
  assert.deepEqual(events, [reported(USER_RATE_EVENT), reported(USER_RATE_EVENT)]);

  advance(19_999);
  assert.throws(() => guard.admit(PLAYER, '視窗之內'), (error) => error.reason === BLOCK_REASONS.USER_RATE);
  advance(1);
  assert.doesNotThrow(() => guard.admit(PLAYER, '視窗之後'));
});

test('the judge limit alone is unchanged: the fifth question in 20 seconds is turned away and only logged', async () => {
  const { guard, events, advance } = productionGuard();
  const log = captureLog();
  let modelCalls = 0;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: okClient('是', () => { modelCalls += 1; }),
  });

  for (let index = 0; index < 4; index += 1) await judge.judge(judgeRequest({ input: `問題${index}` }));
  await assert.rejects(() => judge.judge(judgeRequest({ input: '問題四' })), isLocalBusy);
  assert.equal(modelCalls, 4);
  assert.deepEqual(log.lines, [THROTTLED('user_rate')]);
  assert.deepEqual(events, []);

  // Another player has an allowance of their own, and this player's reopens after the window.
  await judge.judge(judgeRequest({ input: '問題四', context: { ...PLAYER, userId: 'player-2' } }));
  advance(20_000);
  await judge.judge(judgeRequest({ input: '問題五' }));
  assert.equal(modelCalls, 6);
  assert.deepEqual(events, []);
});

test('the pool of concurrent calls is still shared between chat and judge questions', async () => {
  const { guard, events } = productionGuard({ globalConcurrency: 1 });
  const log = captureLog();
  const other = { ...PLAYER, userId: 'player-2' };
  const judge = createJudgeProvider({ model: 'synthetic-judge', guard, logger: log, client: okClient('是') });

  // A chat call holds the only slot, so another player's judge question is turned away.
  const chatGate = heldGate();
  const chat = guard.execute(PLAYER, '佔住名額的聊天', async () => { await chatGate.opened; return '聊天回覆'; });
  await settle();
  await assert.rejects(() => judge.judge(judgeRequest({ input: '另一位的問題', context: other })), isLocalBusy);
  assert.deepEqual(log.lines, [THROTTLED('global_busy')]);
  assert.deepEqual(events, []);
  chatGate.release();
  assert.equal(await chat, '聊天回覆');

  // A judge question holds the only slot, so another player's chat call is refused and reported.
  const judgeGate = heldGate();
  const holding = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: gatedJudgeClient(judgeGate),
  });
  const question = holding.judge(judgeRequest({ input: '佔住名額的問題' }));
  await settle();
  await assert.rejects(() => chatCall(guard, '另一位的聊天', other), (error) => error.reason === BLOCK_REASONS.GLOBAL_BUSY);
  assert.deepEqual(events, [reported(CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_GLOBAL_BUSY, 'player-2')]);
  judgeGate.release();
  assert.deepEqual(await question, { verdict: '是' });
  assert.equal(guard.getStatsForTests().activeCalls, 0);
});

test('a call in flight on one side does not make the same player busy on the other side', async () => {
  const { guard, events } = productionGuard();
  const log = captureLog();
  const judge = createJudgeProvider({ model: 'synthetic-judge', guard, logger: log, client: okClient('是') });

  // A chat call is in flight: the same player's judge question is answered, but a second chat call is busy.
  const chatGate = heldGate();
  const chat = guard.execute(PLAYER, '進行中的聊天', async () => { await chatGate.opened; return '聊天回覆'; });
  await settle();
  assert.deepEqual(await judge.judge(judgeRequest({ input: '遊戲問題' })), { verdict: '是' });
  await assert.rejects(() => chatCall(guard, '再聊一次'), (error) => error.reason === BLOCK_REASONS.USER_BUSY);
  chatGate.release();
  assert.equal(await chat, '聊天回覆');
  assert.deepEqual(events, [reported(CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_USER_BUSY)]);

  // A judge question is in flight: the same player's chat call is answered, but a second question is busy.
  const judgeGate = heldGate();
  const slowJudge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: log,
    client: gatedJudgeClient(judgeGate),
  });
  const question = slowJudge.judge(judgeRequest({ input: '進行中的問題' }));
  await settle();
  assert.equal(await chatCall(guard, '另一句聊天'), '聊天回覆');
  await assert.rejects(() => slowJudge.judge(judgeRequest({ input: '再問一題' })), isLocalBusy);
  judgeGate.release();
  assert.deepEqual(await question, { verdict: '是' });
  assert.deepEqual(log.lines, [THROTTLED('user_busy')]);
  assert.deepEqual(events, [reported(CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_USER_BUSY)]);
});

// ---------------------------------------------------------------------------------------------
// Index CLI: the same failure codes as the runtime, and output that never carries a private path,
// a file name, or story text.
// ---------------------------------------------------------------------------------------------

function runIndexCli(argv) {
  const lines = [];
  const output = {
    log(line) { lines.push(['log', line]); },
    error(line) { lines.push(['error', line]); },
  };
  return { exitCode: runBuildIndexCli(argv, output), lines };
}

const INDEX_CLI_FAILURE = (code) => [['error', `Turtle soup private index failed: ${code}.`]];

test('the index CLI builds and verifies the index and prints only a count', (t) => {
  const { rootDir } = makeCorpus(t);
  const indexPath = path.join(rootDir, INDEX_FILE_NAME);
  fs.rmSync(indexPath);

  const { exitCode, lines } = runIndexCli([rootDir]);
  assert.equal(exitCode, 0);
  assert.deepEqual(lines, [['log', 'Turtle soup private index verified: 1 scenarios.']]);
  assert.equal(fs.existsSync(indexPath), true);
  assert.deepEqual(prepareFileScenarioProvider({ rootDir }).readiness, { ready: true, code: CORPUS_READY, scenarioCount: 1 });
});

test('the index CLI reports each failure with the runtime code and prints no path or story text', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-turtle-cli-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const story = syntheticScenario();
  const scenarioJson = JSON.stringify(story);
  let caseNumber = 0;
  const newCorpus = (files = {}) => {
    const rootDir = path.join(base, `case-${++caseNumber}`);
    fs.mkdirSync(rootDir);
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    return rootDir;
  };
  const fileRoot = path.join(base, 'root-is-a-file');
  fs.writeFileSync(fileRoot, 'not a directory', 'utf8');
  const withOneScenario = () => newCorpus({ 'one.json': scenarioJson });
  const fault = (method, matches, errno) => () => ({ method, matches, errno });

  // `index`: what must be true of the index file afterwards ('absent' or 'unchanged').
  // `runtime`: the code prepareFileScenarioProvider gives the very same directory.
  const cases = [
    { label: 'absent root', code: CORPUS_ROOT_MISSING, runtime: CORPUS_ROOT_MISSING, prepare: () => path.join(base, 'absent') },
    { label: 'root is a file', code: CORPUS_ROOT_MISSING, runtime: CORPUS_ROOT_MISSING, prepare: () => fileRoot },
    { label: 'no scenario documents', code: CORPUS_EMPTY, index: 'absent', prepare: () => newCorpus() },
    {
      label: 'only skipped files',
      code: CORPUS_EMPTY,
      index: 'unchanged',
      prepare: () => newCorpus({ 'manifest.json': '{}', [INDEX_FILE_NAME]: '{"kept":true}' }),
    },
    { label: 'document is not JSON', code: CORPUS_INVALID, index: 'absent', prepare: () => newCorpus({ 'broken.json': '{ not json' }) },
    { label: 'document fails the schema', code: CORPUS_INVALID, index: 'absent', prepare: () => newCorpus({ 'thin.json': '{"schemaVersion":1}' }) },
    {
      label: 'document id outside the allowed pattern',
      code: CORPUS_INVALID,
      index: 'absent',
      prepare: () => newCorpus({ 'odd.json': JSON.stringify({ ...story, id: '../escape' }) }),
    },
    {
      label: 'duplicate scenario references',
      code: CORPUS_INVALID,
      index: 'absent',
      prepare: () => newCorpus({ 'first.json': scenarioJson, 'second.json': scenarioJson }),
    },
    {
      label: 'directory listing denied',
      code: CORPUS_PERMISSION_DENIED,
      index: 'absent',
      prepare: withOneScenario,
      fault: (rootDir) => ({ method: 'readdirSync', matches: (target) => target.includes(path.basename(rootDir)), errno: 'EACCES' }),
    },
    {
      label: 'document unreadable',
      code: CORPUS_PERMISSION_DENIED,
      index: 'absent',
      prepare: withOneScenario,
      fault: fault('readFileSync', (target) => target.endsWith('one.json'), 'EPERM'),
    },
    {
      label: 'index cannot be written',
      code: CORPUS_PERMISSION_DENIED,
      index: 'absent',
      prepare: withOneScenario,
      fault: fault('writeFileSync', (target) => target.endsWith('.tmp'), 'EACCES'),
    },
    {
      label: 'index write fails for another reason',
      code: CORPUS_UNAVAILABLE,
      index: 'absent',
      prepare: withOneScenario,
      fault: fault('writeFileSync', (target) => target.endsWith('.tmp'), 'EIO'),
    },
    {
      label: 'directory fails while being listed',
      code: CORPUS_UNAVAILABLE,
      index: 'absent',
      prepare: withOneScenario,
      fault: (rootDir) => ({ method: 'readdirSync', matches: (target) => target.includes(path.basename(rootDir)), errno: 'EIO' }),
    },
    {
      label: 'index disappears before verification',
      code: CORPUS_INDEX_MISSING,
      prepare: withOneScenario,
      fault: fault('readFileSync', (target) => target.endsWith(INDEX_FILE_NAME), 'ENOENT'),
    },
  ];

  const printed = [];
  for (const entry of cases) {
    const rootDir = entry.prepare();
    const indexPath = path.join(rootDir, INDEX_FILE_NAME);
    const before = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;
    const injected = entry.fault ? entry.fault(rootDir) : null;
    const failing = injected && failFileSystem(t, injected.method, injected.matches, injected.errno);
    let result;
    try {
      result = runIndexCli([rootDir]);
    } finally {
      failing?.mock.restore();
    }

    assert.equal(result.exitCode, 1, entry.label);
    assert.deepEqual(result.lines, INDEX_CLI_FAILURE(entry.code), entry.label);
    printed.push(...result.lines.map(([, line]) => line));
    if (entry.index === 'absent') assert.equal(fs.existsSync(indexPath), false, `${entry.label}: no index written`);
    if (entry.index === 'unchanged') assert.equal(fs.readFileSync(indexPath, 'utf8'), before, `${entry.label}: index kept`);
    if (entry.runtime) {
      assert.equal(prepareFileScenarioProvider({ rootDir }).readiness.code, entry.runtime, `${entry.label}: same as runtime`);
    }
  }

  // Every code the CLI can print is one the runtime already uses, and nothing else is printed.
  const vocabulary = new Set([
    CORPUS_ROOT_MISSING,
    CORPUS_INDEX_MISSING,
    CORPUS_PERMISSION_DENIED,
    CORPUS_INVALID,
    CORPUS_EMPTY,
    CORPUS_UNAVAILABLE,
  ]);
  for (const line of printed) {
    const code = /^Turtle soup private index failed: ([A-Z_]+)\.$/u.exec(line)?.[1];
    assert.equal(vocabulary.has(code), true, line);
  }
  const everything = printed.join('\n');
  for (const secret of [base, path.basename(base), os.tmpdir(), story.revealText, story.publicPrompt, story.title, 'one.json']) {
    assert.equal(everything.includes(secret), false, secret);
  }
});

test('the index CLI never replaces a good index when no scenarios are left', (t) => {
  const { rootDir, scenarioPath } = makeCorpus(t);
  const indexPath = path.join(rootDir, INDEX_FILE_NAME);
  const before = fs.readFileSync(indexPath, 'utf8');
  fs.rmSync(scenarioPath);

  const { exitCode, lines } = runIndexCli([rootDir]);
  assert.equal(exitCode, 1);
  assert.deepEqual(lines, INDEX_CLI_FAILURE(CORPUS_EMPTY));
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
});

test('the index CLI usage line is fixed text and only a single argument is accepted', () => {
  for (const argv of [[], ['   '], ['first', 'second']]) {
    const { exitCode, lines } = runIndexCli(argv);
    assert.equal(exitCode, 1);
    assert.deepEqual(lines, [['error', 'Usage: node src/games/turtleSoup/buildIndexCli.js <private-corpus-root>']]);
  }
});

test('index building classifies its own failures and refuses an empty corpus unless told to allow one', (t) => {
  const { rootDir } = makeCorpus(t);
  const leakFree = (error) => {
    assert.equal(error instanceof TurtleSoupError, true);
    assert.equal(error.message.includes(path.basename(rootDir)), false);
    assert.equal(error.cause, undefined);
    return true;
  };

  const denied = failFileSystem(t, 'readFileSync', (target) => target.endsWith('synthetic-red-door.json'));
  try {
    assert.throws(
      () => buildAndVerifyScenarioIndex({ rootDir }),
      (error) => error.code === CORPUS_PERMISSION_DENIED && leakFree(error)
    );
  } finally {
    denied.mock.restore();
  }
  const unwritable = failFileSystem(t, 'renameSync', (target) => target.endsWith('.tmp'), 'EPERM');
  try {
    assert.throws(
      () => buildScenarioIndex({ rootDir }),
      (error) => error.code === CORPUS_PERMISSION_DENIED && leakFree(error)
    );
  } finally {
    unwritable.mock.restore();
  }

  // An empty corpus is refused by default, so a caller that forgets the option cannot write an
  // empty index; only an explicit allowEmpty: true can.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-turtle-empty-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  const emptyIndexPath = path.join(emptyDir, INDEX_FILE_NAME);
  for (const options of [{}, { allowEmpty: false }, { allowEmpty: undefined }, { write: false }]) {
    assert.throws(
      () => buildScenarioIndex({ rootDir: emptyDir, ...options }),
      (error) => error.code === CORPUS_EMPTY && leakFree(error),
      JSON.stringify(options)
    );
    assert.equal(fs.existsSync(emptyIndexPath), false, JSON.stringify(options));
  }
  assert.deepEqual(buildScenarioIndex({ rootDir: emptyDir, allowEmpty: true }), { schemaVersion: 1, scenarios: [] });
  assert.equal(fs.existsSync(emptyIndexPath), true);
});

test('the index CLI works as a real command: exit codes and streams carry only counts and codes', (t) => {
  const cli = path.join(__dirname, '..', 'src', 'games', 'turtleSoup', 'buildIndexCli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
  const { rootDir } = makeCorpus(t);
  fs.rmSync(path.join(rootDir, INDEX_FILE_NAME));

  const built = run(rootDir);
  assert.equal(built.status, 0);
  assert.equal(built.stdout, 'Turtle soup private index verified: 1 scenarios.\n');
  assert.equal(built.stderr, '');

  const absent = run(path.join(rootDir, 'absent'));
  assert.equal(absent.status, 1);
  assert.equal(absent.stdout, '');
  assert.equal(absent.stderr, 'Turtle soup private index failed: CORPUS_ROOT_MISSING.\n');

  const usage = run();
  assert.equal(usage.status, 1);
  assert.equal(usage.stdout, '');
  assert.equal(usage.stderr, 'Usage: node src/games/turtleSoup/buildIndexCli.js <private-corpus-root>\n');

  const story = syntheticScenario();
  for (const result of [built, absent, usage]) {
    const text = `${result.stdout}${result.stderr}`;
    for (const secret of [rootDir, path.basename(rootDir), os.tmpdir(), story.revealText, story.publicPrompt]) {
      assert.equal(text.includes(secret), false, secret);
    }
  }
});
