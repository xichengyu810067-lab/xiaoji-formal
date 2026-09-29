const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-words-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinTransaction } = require('../src/services/coinDatabase');
const { acceptWordChainMessage, getWordChainStatus, startWordChain, validateWord } = require('../src/services/wordChainService');
const { corpusVersion, legacyCorpusVersion, legacyWords, metadata, moeWords } = require('../src/services/wordChainLexicon');

test('published word list and usage document match their declared checksums', () => {
  for (const [file, expected] of [
    [metadata.indexFile, metadata.indexSha256],
    [metadata.usageInstructionsFile, metadata.usageInstructionsSha256],
  ]) {
    const bytes = fs.readFileSync(path.join(__dirname, '../assets/word-chain', file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected);
  }
  const addedWord = moeWords.find((word) => !legacyWords.includes(word));
  assert.ok(addedWord);
  assert.equal(validateWord(addedWord, corpusVersion).ok, true);
  assert.equal(validateWord(addedWord, legacyCorpusVersion).code, 'UNKNOWN_WORD');
});

test('new rounds use the expanded list; older rounds retain their list and unknown versions stop safely', async () => {
  try {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
    const scope = { guildId: 'public-guild', channelId: 'public-room', actorId: 'public-admin' };
    const started = await startWordChain({ ...scope, seed: '明白' });
    assert.equal(started.session.corpusVersion, corpusVersion);

    await withCoinTransaction((api) => api.run(
      'UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?',
      [legacyCorpusVersion, started.session.id],
    ));
    assert.equal((await getWordChainStatus(scope.guildId, scope.channelId)).corpusVersion, legacyCorpusVersion);

    await withCoinTransaction((api) => api.run(
      'UPDATE text_chain_sessions SET corpus_version = ? WHERE id = ?',
      ['unrecognized', started.session.id],
    ));
    await assert.rejects(getWordChainStatus(scope.guildId, scope.channelId),
      (error) => error.code === 'INVALID_CORPUS_VERSION');
    await assert.rejects(acceptWordChainMessage({ guildId: scope.guildId,
      channelId: scope.channelId, messageId: 'public-message', userId: 'public-player', content: '白天' }),
    (error) => error.code === 'INVALID_CORPUS_VERSION');
  } finally {
    resetCoinDatabaseForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
