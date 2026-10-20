const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-words-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
const {
  initializeCoinDatabase,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const {
  acceptWordChainMessage,
  getWordChainStatus,
  handleWordChainMessage,
  startWordChain,
  stopWordChain,
  validateWord,
} = require('../src/services/wordChainService');
const {
  corpusVersion,
  getSuccessors,
  legacyCorpusVersion,
  legacyWords,
  loadCorpusAssets,
  metadata,
  moeWords,
} = require('../src/services/wordChainLexicon');
const { buildPublicExportPlan } = require('../scripts/create-public-export');
const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');

const assetRoot = path.join(__dirname, '../assets/word-chain');
const SCOPES = Object.freeze({
  fresh: ['20000000000000001', '30000000000000001'],
  legacy: ['20000000000000002', '30000000000000002'],
  closed: ['20000000000000003', '30000000000000003'],
  unknown: ['20000000000000004', '30000000000000004'],
  repeat: ['20000000000000005', '30000000000000005'],
  mismatch: ['20000000000000006', '30000000000000006'],
  rollback: ['20000000000000007', '30000000000000007'],
  retireStop: ['20000000000000008', '30000000000000008'],
  retireMove: ['20000000000000009', '30000000000000009', '30000000000000010'],
  variantLink: ['20000000000000011', '30000000000000011'],
  variantRepeat: ['20000000000000012', '30000000000000012'],
  variantEnd: ['20000000000000013', '30000000000000013'],
  variantOpen: ['20000000000000014', '30000000000000014'],
});
const MESSAGES = Object.freeze({
  fresh: '40000000000000001',
  legacy: '40000000000000002',
  closed: '40000000000000003',
  unknown: '40000000000000004',
  unknownPublic: '40000000000000005',
  repeat: '40000000000000006',
  mismatch: '40000000000000007',
  unknownWord: '40000000000000008',
  rollback: '40000000000000009',
  retireStop: '40000000000000010',
  retireMove: '40000000000000011',
  variantMismatch: '40000000000000012',
  variantLink: '40000000000000013',
  variantRepeat: '40000000000000014',
  variantNext: '40000000000000015',
  variantEnd: '40000000000000016',
  variantOpen: '40000000000000017',
});
const PLAYERS = Object.freeze({
  fresh: '50000000000000001',
  legacy: '50000000000000002',
  unknown: '50000000000000003',
  repeat: '50000000000000004',
  mismatch: '50000000000000005',
  rollback: '50000000000000006',
  retire: '50000000000000007',
  variantA: '50000000000000008',
  variantB: '50000000000000009',
});

function createSyntheticReactionRuntime() {
  const fences = new Map();
  const keyFor = (purposeId, guildId) => `${purposeId}:${guildId}`;
  return {
    isPurposeReady: () => true,
    getLedgerIdentity: (purposeId) => ({ ledgerId: `synthetic-${purposeId}` }),
    getCutoverSourceTimestampMs: () => 0,
    getReactionFence: (purposeId, guildId) => fences.get(keyFor(purposeId, guildId)) || null,
    openReactionFence(purposeId, input) {
      const key = keyFor(purposeId, input.guildId);
      const current = fences.get(key);
      if (current?.open && current.channelId === input.channelId && current.sessionKey === input.sessionKey) {
        return { kind: 'existing', fence: current };
      }
      const fence = Object.freeze({
        generation: current ? current.generation + 1 : 1,
        channelId: input.channelId,
        sessionKey: input.sessionKey,
        sourceFence: crypto.createHash('sha256').update(`${key}:${input.sessionKey}`).digest('hex'),
        open: true,
      });
      fences.set(key, fence);
      return { kind: 'opened', fence };
    },
    closeReactionFence(purposeId, guildId, expected = {}) {
      const key = keyFor(purposeId, guildId);
      const current = fences.get(key);
      if (!current) return { kind: 'missing', fence: null };
      if ((expected.channelId !== undefined && expected.channelId !== current.channelId) ||
          (expected.generation !== undefined && expected.generation !== current.generation)) {
        return { kind: 'stale', fence: current };
      }
      const fence = Object.freeze({ ...current, open: false });
      fences.set(key, fence);
      return { kind: 'closed', fence };
    },
    verifyReactionFence(purposeId, input) {
      const current = fences.get(keyFor(purposeId, input.guildId));
      if (!current || !current.open || current.generation !== input.generation ||
          current.channelId !== input.channelId || current.sessionKey !== input.sessionKey ||
          current.sourceFence !== input.sourceFence) return null;
      return current;
    },
  };
}

configureChainReactionFence(createSyntheticReactionRuntime());

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function copyCorpusAssets(name) {
  const destination = path.join(root, name);
  fs.cpSync(assetRoot, destination, { recursive: true });
  return destination;
}

function assertSafeLexiconFailure(callback, expectedCode) {
  let caught = null;
  assert.throws(callback, (error) => {
    caught = error;
    return error?.code === expectedCode;
  });
  assert.doesNotMatch(caught.message, /2015_20260625|sha|\\|\//iu);
}

async function snapshotSession(sessionId) {
  return withCoinDatabase((api) => ({
    session: api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [sessionId]),
    entries: api.all('SELECT * FROM text_chain_entries WHERE session_id = ? ORDER BY id', [sessionId]),
    rewards: api.all("SELECT * FROM reward_grants WHERE source_type = 'word_chain' AND source_id = ? ORDER BY id", [String(sessionId)]),
  }));
}

test('published corpus has the licensed exact assets and known MOE words', () => {
  assert.equal(metadata.sourceVersion, '2015_20260625');
  assert.equal(metadata.uniqueHeadwords, 147794);
  assert.equal(metadata.license, 'CC BY-ND 3.0 TW');
  for (const [file, expected] of [
    [metadata.indexFile, metadata.indexSha256],
    [metadata.usageInstructionsFile, metadata.usageInstructionsSha256],
  ]) {
    const bytes = fs.readFileSync(path.join(assetRoot, file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected);
  }
  const notice = fs.readFileSync(path.join(assetRoot, 'NOTICE.txt'), 'utf8');
  assert.match(notice, /2015_20260625/u);
  assert.match(notice, /創用 CC/u);
  for (const word of ['球體', '氣旋']) {
    assert.ok(moeWords.includes(word));
    assert.equal(legacyWords.includes(word), false);
    assert.equal(validateWord(word, corpusVersion).ok, true);
    assert.equal(validateWord(word, legacyCorpusVersion).code, 'UNKNOWN_WORD');
  }
});

test('missing or modified corpus assets fail closed with stable non-sensitive codes', () => {
  const missing = copyCorpusAssets('missing-corpus');
  fs.rmSync(path.join(missing, metadata.indexFile));
  assertSafeLexiconFailure(() => loadCorpusAssets(missing), 'LEXICON_ASSET_UNAVAILABLE');

  const modified = copyCorpusAssets('modified-corpus');
  fs.appendFileSync(path.join(modified, metadata.indexFile), '額外詞\n', 'utf8');
  assertSafeLexiconFailure(() => loadCorpusAssets(modified), 'LEXICON_INTEGRITY_FAILED');

  const modifiedNotice = copyCorpusAssets('modified-notice');
  fs.appendFileSync(path.join(modifiedNotice, 'NOTICE.txt'), '未授權變更\n', 'utf8');
  assertSafeLexiconFailure(() => loadCorpusAssets(modifiedNotice), 'LEXICON_INTEGRITY_FAILED');
});

test('public export includes the corpus, attribution, license and executable regression', () => {
  const exported = new Set(buildPublicExportPlan({ sourceRoot: path.join(__dirname, '..') }));
  for (const relativePath of [
    'assets/word-chain/NOTICE.txt',
    'assets/word-chain/MOE-usage-revised.pdf',
    'assets/word-chain/moe-revised-source.json',
    'assets/word-chain/moe-revised-2015_20260625.txt',
    'test/wordChainPublic.test.js',
    'test/wordChainCoverage.test.js',
  ]) {
    assert.ok(exported.has(relativePath), `public export is missing ${relativePath}`);
  }
});

test('new and legacy active rounds use the complete corpus without rewriting prior state', async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });

  const fresh = await startWordChain({
    guildId: SCOPES.fresh[0], channelId: SCOPES.fresh[1], actorId: 'fresh-admin', seed: '地球',
  });
  const freshMove = await acceptWordChainMessage({
    guildId: SCOPES.fresh[0], channelId: SCOPES.fresh[1], messageId: MESSAGES.fresh,
    userId: PLAYERS.fresh, content: '球體',
  });
  assert.equal(fresh.session.corpusVersion, corpusVersion);
  assert.equal(freshMove.ok, true);
  assert.equal(freshMove.session.currentWord, '球體');

  const legacy = await startWordChain({
    guildId: SCOPES.legacy[0], channelId: SCOPES.legacy[1], actorId: 'legacy-admin', seed: '天空',
  });
  const fixtureTime = '2026-09-30T01:02:03.000Z';
  await withCoinTransaction((api) => {
    api.run(
      `UPDATE text_chain_sessions
       SET corpus_version = ?, current_word = '空氣', last_word = '空氣', last_user_id = 'old-player', revision = 1
       WHERE id = ?`,
      [legacyCorpusVersion, legacy.session.id]
    );
    api.run(
      `INSERT INTO text_chain_entries
       (session_id, guild_id, channel_id, message_id, user_id, word, created_at)
       VALUES (?, ?, ?, 'old-message', 'old-player', '空氣', ?)`,
      [legacy.session.id, SCOPES.legacy[0], SCOPES.legacy[1], fixtureTime]
    );
    api.run(
      `INSERT INTO reward_grants
       (guild_id, user_id, source_type, source_id, reward_kind, amount, metadata, created_at)
       VALUES (?, 'old-player', 'word_chain', ?, 'synthetic-history', 1, '{}', ?)`,
      [SCOPES.legacy[0], String(legacy.session.id), fixtureTime]
    );
  });
  const before = await snapshotSession(legacy.session.id);

  const accepted = await acceptWordChainMessage({
    guildId: SCOPES.legacy[0], channelId: SCOPES.legacy[1], messageId: MESSAGES.legacy,
    userId: PLAYERS.legacy, content: '氣旋', now: new Date('2026-09-30T02:00:00.000Z'),
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.session.id, legacy.session.id);
  assert.equal(accepted.session.corpusVersion, corpusVersion);
  assert.equal(accepted.session.currentWord, '氣旋');
  assert.equal(accepted.session.revision, 2);

  const after = await snapshotSession(legacy.session.id);
  for (const field of ['id', 'guild_id', 'channel_id', 'status', 'started_by', 'stopped_by', 'created_at', 'stopped_at']) {
    assert.equal(after.session[field], before.session[field], field);
  }
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
  assert.deepEqual(after.rewards, before.rewards);
  assert.deepEqual(after.entries.map((entry) => entry.user_id), ['old-player', PLAYERS.legacy]);
  assert.deepEqual(after.entries.map((entry) => entry.word), ['空氣', '氣旋']);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const replay = await acceptWordChainMessage({
    guildId: SCOPES.legacy[0], channelId: SCOPES.legacy[1], messageId: MESSAGES.legacy,
    userId: PLAYERS.legacy, content: '氣旋',
  });
  assert.deepEqual(replay, { ok: true, duplicate: true, sessionId: legacy.session.id });
  const afterReplay = await snapshotSession(legacy.session.id);
  assert.deepEqual(afterReplay, after);
});

test('closed and unknown corpus versions stay unchanged and unavailable to play', async () => {
  const closed = await startWordChain({
    guildId: SCOPES.closed[0], channelId: SCOPES.closed[1], actorId: 'closed-admin', seed: '空氣',
  });
  await stopWordChain({ guildId: SCOPES.closed[0], channelId: SCOPES.closed[1], actorId: 'closed-admin' });
  await withCoinTransaction((api) => api.run(
    'UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?',
    [legacyCorpusVersion, closed.session.id]
  ));
  const closedResult = await acceptWordChainMessage({
    guildId: SCOPES.closed[0], channelId: SCOPES.closed[1], messageId: MESSAGES.closed,
    userId: PLAYERS.unknown, content: '氣旋',
  });
  assert.equal(closedResult.code, 'NO_ACTIVE_SESSION');
  assert.equal(await withCoinDatabase((api) =>
    api.get('SELECT corpus_version FROM text_chain_sessions WHERE id = ?', [closed.session.id]).corpus_version),
  legacyCorpusVersion);

  const unknown = await startWordChain({
    guildId: SCOPES.unknown[0], channelId: SCOPES.unknown[1], actorId: 'unknown-admin', seed: '空氣',
  });
  await withCoinTransaction((api) => api.run(
    'UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?', ['unrecognized', unknown.session.id]
  ));
  const unknownBefore = await snapshotSession(unknown.session.id);
  await assert.rejects(acceptWordChainMessage({
    guildId: SCOPES.unknown[0], channelId: SCOPES.unknown[1], messageId: MESSAGES.unknown,
    userId: PLAYERS.unknown, content: '氣旋',
  }), (error) => error.code === 'INVALID_CORPUS_VERSION');
  assert.deepEqual(await snapshotSession(unknown.session.id), unknownBefore);

  const replies = [];
  const handled = await handleWordChainMessage({
    guildId: SCOPES.unknown[0], channelId: SCOPES.unknown[1], id: MESSAGES.unknownPublic,
    author: { id: PLAYERS.unknown }, content: '氣旋',
    reply: async (payload) => { replies.push(payload); },
  }, { channelId: SCOPES.unknown[1] });
  assert.equal(handled, true);
  assert.equal(replies[0].content, '這局文字接龍目前無法繼續，請稍後再試。');
  assert.doesNotMatch(replies[0].content, /version|corpus|hash|path|2015|2026/iu);
});

test('a round with an unrecognized corpus version can still be stopped or moved, but never resumes play', async () => {
  const [stopGuild, stopChannel] = SCOPES.retireStop;
  const stopRound = await startWordChain({
    guildId: stopGuild, channelId: stopChannel, actorId: 'retire-admin', seed: '空氣',
  });
  await withCoinTransaction((api) => api.run(
    'UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?', ['unrecognized', stopRound.session.id]
  ));
  const frozen = await snapshotSession(stopRound.session.id);

  // The protection is untouched: no word is accepted, and restarting in the same channel does not revive the round.
  await assert.rejects(acceptWordChainMessage({
    guildId: stopGuild, channelId: stopChannel, messageId: MESSAGES.retireStop,
    userId: PLAYERS.retire, content: '氣旋',
  }), (error) => error.code === 'INVALID_CORPUS_VERSION');
  await assert.rejects(startWordChain({
    guildId: stopGuild, channelId: stopChannel, actorId: 'retire-admin', seed: '地球',
  }), (error) => error.code === 'INVALID_CORPUS_VERSION');
  assert.deepEqual(await snapshotSession(stopRound.session.id), frozen);

  // An administrator can still retire it.
  const stopped = await stopWordChain({ guildId: stopGuild, channelId: stopChannel, actorId: 'retire-admin' });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.session.status, 'stopped');
  assert.equal(stopped.session.stoppedBy, 'retire-admin');
  const afterStop = await snapshotSession(stopRound.session.id);
  assert.equal(afterStop.session.status, 'stopped');
  assert.equal(afterStop.session.corpus_version, 'unrecognized');
  assert.deepEqual(afterStop.entries, frozen.entries);
  const stopSetting = await withCoinDatabase((api) => api.get(
    "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'", [stopGuild]
  ));
  assert.deepEqual({ ...stopSetting, enabled: Number(stopSetting.enabled) }, { enabled: 0, channel_id: null });
  assert.equal((await acceptWordChainMessage({
    guildId: stopGuild, channelId: stopChannel, messageId: MESSAGES.retireStop,
    userId: PLAYERS.retire, content: '氣旋',
  })).code, 'NO_ACTIVE_SESSION');

  // Starting in another channel retires the old round and begins a fresh one with the current corpus.
  const [moveGuild, moveChannel, targetChannel] = SCOPES.retireMove;
  const moveRound = await startWordChain({
    guildId: moveGuild, channelId: moveChannel, actorId: 'retire-admin', seed: '空氣',
  });
  await withCoinTransaction((api) => api.run(
    'UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?', ['unrecognized', moveRound.session.id]
  ));
  const moved = await startWordChain({
    guildId: moveGuild, channelId: targetChannel, actorId: 'retire-admin', seed: '地球',
  });
  assert.equal(moved.alreadyActive, false);
  assert.equal(moved.session.channelId, targetChannel);
  assert.equal(moved.session.status, 'active');
  assert.equal(moved.session.corpusVersion, corpusVersion);
  assert.equal(moved.stoppedSession.id, moveRound.session.id);
  assert.equal(moved.stoppedSession.status, 'stopped');
  assert.equal(moved.stoppedSession.corpusVersion, 'unrecognized');
  const afterMove = await withCoinDatabase((api) => ({
    old: api.get('SELECT status, corpus_version FROM text_chain_sessions WHERE id = ?', [moveRound.session.id]),
    setting: api.get(
      "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'", [moveGuild]
    ),
  }));
  assert.deepEqual(afterMove.old, { status: 'stopped', corpus_version: 'unrecognized' });
  assert.deepEqual({ ...afterMove.setting, enabled: Number(afterMove.setting.enabled) },
    { enabled: 1, channel_id: targetChannel });
  const firstMove = await acceptWordChainMessage({
    guildId: moveGuild, channelId: targetChannel, messageId: MESSAGES.retireMove,
    userId: PLAYERS.retire, content: '球體',
  });
  assert.equal(firstMove.ok, true);
  assert.equal(firstMove.session.corpusVersion, corpusVersion);
});

test('repeated, disconnected and unknown words are rejected without changing turns', async () => {
  const repeated = await startWordChain({
    guildId: SCOPES.repeat[0], channelId: SCOPES.repeat[1], actorId: 'repeat-admin', seed: '地球',
  });
  await withCoinTransaction((api) => api.run(
    `INSERT INTO text_chain_entries
     (session_id, guild_id, channel_id, message_id, user_id, word, created_at)
     VALUES (?, ?, ?, 'prior-ball', 'prior-player', '球體', ?)`,
    [repeated.session.id, SCOPES.repeat[0], SCOPES.repeat[1], '2026-09-30T03:00:00.000Z']
  ));
  const repeatedBefore = await snapshotSession(repeated.session.id);
  const repeatedResult = await acceptWordChainMessage({
    guildId: SCOPES.repeat[0], channelId: SCOPES.repeat[1], messageId: MESSAGES.repeat,
    userId: PLAYERS.repeat, content: '球體',
  });
  assert.equal(repeatedResult.code, 'REPEATED_WORD');
  assert.deepEqual(await snapshotSession(repeated.session.id), repeatedBefore);

  const mismatchSession = await startWordChain({
    guildId: SCOPES.mismatch[0], channelId: SCOPES.mismatch[1], actorId: 'mismatch-admin', seed: '地球',
  });
  const mismatchBefore = await snapshotSession(mismatchSession.session.id);
  const mismatch = await acceptWordChainMessage({
    guildId: SCOPES.mismatch[0], channelId: SCOPES.mismatch[1], messageId: MESSAGES.mismatch,
    userId: PLAYERS.mismatch, content: '氣旋',
  });
  assert.equal(mismatch.code, 'CHAIN_MISMATCH');
  assert.deepEqual(await snapshotSession(mismatchSession.session.id), mismatchBefore);

  assert.equal(validateWord('球貓').code, 'UNKNOWN_WORD');
  const unknown = await acceptWordChainMessage({
    guildId: SCOPES.mismatch[0], channelId: SCOPES.mismatch[1], messageId: MESSAGES.unknownWord,
    userId: PLAYERS.mismatch, content: '球貓',
  });
  assert.equal(unknown.code, 'UNKNOWN_WORD');
  assert.deepEqual(await snapshotSession(mismatchSession.session.id), mismatchBefore);
});

test('legacy promotion, new entry and turn update roll back together', async () => {
  const started = await startWordChain({
    guildId: SCOPES.rollback[0], channelId: SCOPES.rollback[1], actorId: 'rollback-admin', seed: '空氣',
  });
  await withCoinTransaction((api) => {
    api.run('UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?',
      [legacyCorpusVersion, started.session.id]);
    api.run(
      `INSERT INTO reward_grants
       (guild_id, user_id, source_type, source_id, reward_kind, amount, metadata, created_at)
       VALUES (?, 'old-player', 'word_chain', ?, 'synthetic-history', 1, '{}', ?)`,
      [SCOPES.rollback[0], String(started.session.id), '2026-09-30T04:00:00.000Z']
    );
  });
  const before = await snapshotSession(started.session.id);
  await assert.rejects(acceptWordChainMessage({
    guildId: SCOPES.rollback[0], channelId: SCOPES.rollback[1], messageId: MESSAGES.rollback,
    userId: PLAYERS.rollback, content: '氣旋',
    beforeCommit: () => { throw new Error('synthetic rollback'); },
  }), /synthetic rollback/u);
  assert.deepEqual(await snapshotSession(started.session.id), before);
  assert.equal((await getWordChainStatus(SCOPES.rollback[0], SCOPES.rollback[1])).corpusVersion, legacyCorpusVersion);
});

test('a word written 台灣 follows a 臺 and is stored as it was typed', async () => {
  const [guildId, channelId] = SCOPES.variantLink;
  const started = await startWordChain({ guildId, channelId, actorId: 'variant-admin', seed: '舞台' });
  assert.equal(started.session.currentWord, '舞台');
  const before = await snapshotSession(started.session.id);

  // The message names the character as the previous word wrote it.
  const mismatch = await acceptWordChainMessage({
    guildId, channelId, messageId: MESSAGES.variantMismatch, userId: PLAYERS.variantA, content: '天空',
  });
  assert.equal(mismatch.code, 'CHAIN_MISMATCH');
  assert.match(mismatch.message, /「台」/u);
  assert.deepEqual(await snapshotSession(started.session.id), before);

  // 臺北 starts with the other form of the character the round has to continue from.
  const linked = await acceptWordChainMessage({
    guildId, channelId, messageId: MESSAGES.variantLink, userId: PLAYERS.variantA, content: '臺北',
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.session.currentWord, '臺北');
  const after = await snapshotSession(started.session.id);
  assert.deepEqual(after.entries.map((entry) => entry.word), ['臺北']);
  assert.equal(after.session.corpus_version, corpusVersion);
});

test('a word written with the other form of a character counts as already used', async () => {
  const [guildId, channelId] = SCOPES.variantRepeat;
  const started = await startWordChain({ guildId, channelId, actorId: 'variant-admin', seed: '舞臺' });
  await withCoinTransaction((api) => api.run(
    `INSERT INTO text_chain_entries
     (session_id, guild_id, channel_id, message_id, user_id, word, created_at)
     VALUES (?, ?, ?, 'prior-taiwan', 'prior-player', '臺灣', ?)`,
    [started.session.id, guildId, channelId, '2026-10-12T03:00:00.000Z']
  ));
  const before = await snapshotSession(started.session.id);
  const repeated = await acceptWordChainMessage({
    guildId, channelId, messageId: MESSAGES.variantRepeat, userId: PLAYERS.variantA, content: '台灣',
  });
  assert.equal(repeated.code, 'REPEATED_WORD');
  assert.deepEqual(await snapshotSession(started.session.id), before);

  // Another word that starts with the same character is still a new word.
  const next = await acceptWordChainMessage({
    guildId, channelId, messageId: MESSAGES.variantNext, userId: PLAYERS.variantB, content: '台北',
  });
  assert.equal(next.ok, true);
  assert.equal(next.session.currentWord, '台北');
});

test('a round is complete when every word that could follow was used, in any written form', async () => {
  // 垮臺 is the only word that starts with 垮, so 累垮 leaves nothing to follow once 垮臺 has been used.
  assert.deepEqual(getSuccessors('累垮'), ['垮臺']);

  const [guildId, channelId] = SCOPES.variantEnd;
  const started = await startWordChain({ guildId, channelId, actorId: 'variant-admin', seed: '勞累' });
  await withCoinTransaction((api) => api.run(
    `INSERT INTO text_chain_entries
     (session_id, guild_id, channel_id, message_id, user_id, word, created_at)
     VALUES (?, ?, ?, 'prior-collapse', 'prior-player', '垮台', ?)`,
    [started.session.id, guildId, channelId, '2026-10-12T03:30:00.000Z']
  ));
  const ended = await acceptWordChainMessage({
    guildId, channelId, messageId: MESSAGES.variantEnd, userId: PLAYERS.variantA, content: '累垮',
  });
  assert.equal(ended.ok, true);
  assert.equal(ended.completed, true);
  assert.equal(ended.session.status, 'completed');

  // The same move continues the round while 垮臺 is still unused.
  const [openGuild, openChannel] = SCOPES.variantOpen;
  const open = await startWordChain({ guildId: openGuild, channelId: openChannel, actorId: 'variant-admin', seed: '勞累' });
  const continued = await acceptWordChainMessage({
    guildId: openGuild, channelId: openChannel, messageId: MESSAGES.variantOpen, userId: PLAYERS.variantA, content: '累垮',
  });
  assert.equal(continued.ok, true);
  assert.equal(continued.completed, false);
  assert.equal(continued.session.status, 'active');
  assert.equal(continued.session.id, open.session.id);
});
