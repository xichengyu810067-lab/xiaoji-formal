const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getArchivePath, initializeArchive, openArchive, restoreArchiveBackup } = require('../src/systems/conversation/aiArchive');
const { archiveInteraction, confirmArchiveInteraction, closeArchiveForTests, configureArchivePathResolver,
  isArchiveCaptureEnabled } = require('../src/services/aiArchiveService');
const { getPrivateMemoryContext } = require('../src/services/memoryService');
const { deleteMemoryProjection } = require('../src/services/memoryService');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-archive-fixture-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function archivePath(label) { return path.join(root, `${label}.sqlite`); }
function newArchive(label) { return initializeArchive({ filePath: archivePath(label), initializationId: `fixture-${label}` }); }
function event(overrides = {}) {
  return {
    interactionKey: 'fixture-interaction-1', userId: 'user-1', guildId: null,
    channelId: 'dm-1', happenedAt: '2026-09-26T00:00:00.000Z',
    userContent: '我想聊天', assistantContent: '你好', sourceId: 'message-1', ...overrides,
  };
}

test('archive asks the injected DataPaths port and fails closed without it', () => {
  assert.throws(() => getArchivePath(), /port is not configured/);
  let request;
  const resolved = getArchivePath({ resolveDataPath: (descriptor) => {
    request = descriptor;
    return { filePath: archivePath('resolved'), source: 'data-root' };
  }, env: {} });
  assert.equal(resolved, archivePath('resolved'));
  assert.equal(request.explicitEnvName, 'XIAOJI_ARCHIVE_DB_PATH');
  assert.equal(request.rootRelativePath, 'archive/conversations.sqlite');
  assert.throws(() => getArchivePath({ resolveDataPath: () => ({ filePath: resolved }),
    env: { COIN_DB_PATH: resolved } }), /collides/);
});

test('active archive never silently recreates a missing database or mismatched generation', () => {
  const missingPath = archivePath('missing-active');
  assert.throws(() => openArchive({ filePath: missingPath }), /explicit initialization/);
  const store = initializeArchive({ filePath: missingPath, initializationId: 'fixture-initialization-receipt' });
  store.close();
  fs.rmSync(missingPath);
  assert.throws(() => openArchive({ filePath: missingPath }), /explicit initialization/);
  assert.throws(() => initializeArchive({ filePath: missingPath, initializationId: 'another-receipt' }),
    /identity or deletion receipt/);
  const otherPath = archivePath('wrong-generation');
  initializeArchive({ filePath: otherPath, initializationId: 'fixture-generation' }).close();
  const identityPath = `${otherPath}.identity.json`;
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  identity.generation = '00000000-0000-0000-0000-000000000000';
  fs.writeFileSync(identityPath, JSON.stringify(identity));
  assert.throws(() => openArchive({ filePath: otherPath }), /generation/);
});

test('raw events, public messages and summaries are independent and idempotent', () => {
  const store = newArchive('separate');
  assert.equal(store.schemaVersion, 1);
  assert.equal(store.appendInteraction(event()).inserted, 2);
  assert.equal(store.appendInteraction(event()).inserted, 0);
  assert.throws(() => store.appendInteraction(event({ assistantContent: 'changed' })), /conflict/);
  assert.equal(store.appendPublicMessage({ messageId: 'public-1', userId: 'user-1', guildId: 'guild-1',
    channelId: 'channel-1', happenedAt: '2026-09-26T01:00:00.000Z', content: '公開原文' }).inserted, 1);
  assert.equal(store.appendSummary({ summaryKey: 'fixture-interaction-1', userId: 'user-1', channelId: 'dm-1',
    happenedAt: '2026-09-26T00:00:00.000Z', userSummary: '聊天', assistantSummary: '回應' }).inserted, 1);
  assert.throws(() => store.markDeliveredAndSummary({ interactionKey: 'fixture-interaction-1',
    summary: { summaryKey: 'fixture-interaction-1', userId: 'user-1', channelId: 'dm-1',
      happenedAt: '2026-09-26T00:00:00.000Z', userSummary: '衝突', assistantSummary: '回應' } }), /conflict/);
  assert.equal(store.listEvents({ userId: 'user-1' }, { kind: 'ai' }).rows.length, 2);
  assert.equal(store.listEvents({ userId: 'user-1' }, { kind: 'ai' }).rows[0].delivery_state, 'pending');
  assert.equal(store.listEvents({ userId: 'user-1' }, { kind: 'ai', limit: 1 }).nextCursor !== null, true);
  assert.equal(store.listEvents({ userId: 'user-1', guildId: 'guild-1' }, { kind: 'public' }).rows[0].content, '公開原文');
  const summary = store.listEvents({ userId: 'user-1' }, { kind: 'summary' }).rows[0];
  assert.equal(store.correctSummary({ summaryId: summary.id, userId: 'user-1',
    userSummary: '更正', assistantSummary: '回應' }), 1);
  assert.equal(store.listEvents({ userId: 'user-1' }, { kind: 'summary' }).rows[0].user_summary, '更正');
  assert.equal(store.listEvents({ userId: 'user-1' }, { kind: 'ai' }).rows[0].content, '你好');
  store.close();
});

test('delete journal prevents old imports and backup restore from reviving deleted scope', async () => {
  const filePath = archivePath('delete');
  const store = initializeArchive({ filePath, initializationId: 'fixture-delete' });
  store.appendInteraction(event());
  store.appendPublicMessage({ messageId: 'public-2', userId: 'user-1', guildId: 'guild-1',
    channelId: 'channel-1', happenedAt: '2026-09-26T01:00:00.000Z', content: '公開原文' });
  const olderBackup = archivePath('older-backup');
  await store.backupTo(olderBackup);
  assert.throws(() => openArchive({ filePath: olderBackup }), /snapshot/);
  configureArchivePathResolver(() => ({ filePath: olderBackup, source: 'explicit' }));
  assert.throws(() => openArchive(), /snapshot/);
  const deleted = store.deleteScope({ actorId: 'owner-1', filter: { userId: 'user-1' },
    happenedAt: '2026-09-26T02:00:00Z' });
  assert.equal(deleted.deleted, 3);
  assert.equal(store.listEvents({ userId: 'user-1' }).rows.length, 0);
  assert.equal(store.appendInteraction(event()).reason, 'deleted_scope');
  const lateLegacy = path.join(root, 'late-legacy.json');
  fs.writeFileSync(lateLegacy, JSON.stringify({ version: 1, conversations: {} }));
  assert.throws(() => store.importLegacyConversation(lateLegacy), /blocked after a deletion/);
  const disguisedOldJournal = path.join(root, 'disguised-old-journal.jsonl');
  fs.copyFileSync(`${olderBackup}.deletions.jsonl`, disguisedOldJournal);
  assert.throws(() => restoreArchiveBackup({ backupPath: olderBackup, targetPath: archivePath('unsafe-restore'),
    authoritativeJournalPath: disguisedOldJournal }), /caller-supplied deletion journal/);
  configureArchivePathResolver(() => ({ filePath: olderBackup, source: 'explicit' }));
  assert.throws(() => restoreArchiveBackup({ backupPath: olderBackup,
    targetPath: archivePath('snapshot-as-active') }), /snapshot/);
  const foreign = newArchive('foreign-generation');
  configureArchivePathResolver(() => ({ filePath: foreign.filePath, source: 'data-root' }));
  assert.throws(() => restoreArchiveBackup({ backupPath: olderBackup,
    targetPath: archivePath('foreign-restore') }), /generation mismatch/);
  foreign.close();
  configureArchivePathResolver(() => ({ filePath, source: 'data-root' }));
  const restoredPath = archivePath('safe-restore');
  restoreArchiveBackup({ backupPath: olderBackup, targetPath: restoredPath });
  const restored = openArchive({ filePath: restoredPath });
  assert.equal(restored.listEvents({ userId: 'user-1' }).rows.length, 0);
  restored.close();
  const backupPath = archivePath('backup');
  await store.backupTo(backupPath);
  store.close();
  assert.throws(() => openArchive({ filePath: backupPath }), /snapshot/);
  const restoredLatestPath = archivePath('restored-latest');
  restoreArchiveBackup({ backupPath, targetPath: restoredLatestPath });
  const reopened = openArchive({ filePath: restoredLatestPath });
  assert.equal(reopened.listEvents({ userId: 'user-1' }).rows.length, 0);
  reopened.close();
  fs.rmSync(`${restoredLatestPath}.deletions.jsonl`);
  assert.throws(() => openArchive({ filePath: restoredLatestPath }), /journal/);
  const activeJournal = `${filePath}.deletions.jsonl`;
  const heldJournal = `${activeJournal}.held`;
  fs.renameSync(activeJournal, heldJournal);
  try {
    const missingJournalTarget = archivePath('missing-journal-restore');
    assert.throws(() => restoreArchiveBackup({ backupPath: olderBackup,
      targetPath: missingJournalTarget }), /journal/);
    assert.equal(fs.existsSync(missingJournalTarget), false);
  } finally {
    fs.renameSync(heldJournal, activeJournal);
  }
  fs.rmSync(filePath);
  const missingActiveTarget = archivePath('missing-active-restore');
  assert.throws(() => restoreArchiveBackup({ backupPath: olderBackup,
    targetPath: missingActiveTarget }), /explicit initialization/);
  assert.equal(fs.existsSync(missingActiveTarget), false);
  assert.equal(fs.existsSync(`${missingActiveTarget}.identity.json`), false);
  assert.equal(fs.existsSync(`${missingActiveTarget}.deletions.jsonl`), false);
});

test('deletion blocks old records but permits later and same-millisecond live events after restart', async () => {
  const filePath = archivePath('delete-then-chat');
  const store = initializeArchive({ filePath, initializationId: 'fixture-delete-then-chat' });
  store.appendInteraction(event());
  const oldBackup = archivePath('delete-then-chat-old-backup');
  await store.backupTo(oldBackup);
  store.deleteScope({ actorId: 'owner-1', filter: { userId: 'user-1', scope: 'dm' },
    happenedAt: '2026-09-26T02:00:00Z' });
  assert.equal(store.appendInteraction(event({ interactionKey: 'legacy-replay', origin: 'legacy',
    happenedAt: '2026-09-26T02:00:00Z' })).reason, 'deleted_scope');
  assert.equal(store.appendInteraction(event({ interactionKey: 'live-same-ms',
    happenedAt: '2026-09-26T02:00:00Z' })).inserted, 2);
  assert.equal(store.appendInteraction(event({ interactionKey: 'live-later',
    happenedAt: '2026-09-26T03:00:00Z' })).inserted, 2);
  store.close();
  const reopened = openArchive({ filePath });
  assert.equal(reopened.listEvents({ userId: 'user-1', scope: 'dm' }).rows.length, 4);
  const newBackup = archivePath('delete-then-chat-new-backup');
  await reopened.backupTo(newBackup);
  reopened.close();
  configureArchivePathResolver(() => ({ filePath, source: 'data-root' }));
  const restoredNew = archivePath('delete-then-chat-restored-new');
  restoreArchiveBackup({ backupPath: newBackup, targetPath: restoredNew });
  const fromNew = openArchive({ filePath: restoredNew });
  assert.equal(fromNew.listEvents({ userId: 'user-1', scope: 'dm' }).rows.length, 4);
  fromNew.close();
  const restoredOld = archivePath('delete-then-chat-restored-old');
  restoreArchiveBackup({ backupPath: oldBackup, targetPath: restoredOld });
  const fromOld = openArchive({ filePath: restoredOld });
  assert.equal(fromOld.listEvents({ userId: 'user-1', scope: 'dm' }).rows.length, 0);
  fromOld.close();
});

test('legacy import uses source hash and stable positions, quarantining unknown time', () => {
  const store = newArchive('import');
  const legacy = path.join(root, 'legacy-conversation.json');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, conversations: {
    'dm:dm-1:user-1': { guildId: 'dm', channelId: 'dm-1', userId: 'user-1', updatedAt: '2026-09-26T00:00:00Z',
      turns: [{ user: '甲', assistant: '乙', createdAt: '2026-09-26T00:00:00Z' },
        { user: '丙', assistant: '丁', createdAt: 'unknown' }] },
  } }));
  assert.deepEqual(store.importLegacyConversation(legacy), { imported: 2, quarantined: 1, replayed: false });
  assert.equal(store.importLegacyConversation(legacy).replayed, true);
  const memory = path.join(root, 'legacy-memory.json');
  fs.writeFileSync(memory, JSON.stringify({ private_user_memory: { 'user-1': [{ userId: 'user-1',
    guildId: null, channelId: 'dm-1', timestamp: '2026-09-26T00:00:00Z',
    userContentSummary: '甲', assistantContentSummary: '乙' }] }, public_channel_memory: {} }));
  assert.equal(store.importLegacyMemory(memory).imported, 1);
  assert.equal(store.listEvents({ userId: 'user-1' }, { kind: 'summary' }).rows.length, 1);
  store.close();
});

test('DM deletion is precise and leaves the same user guild record intact', () => {
  const store = newArchive('dm-delete');
  store.appendInteraction(event());
  store.appendInteraction(event({ interactionKey: 'guild-interaction', guildId: 'guild-1', channelId: 'channel-1' }));
  assert.equal(store.listEvents({ userId: 'user-1', scope: 'dm' }).rows.length, 2);
  assert.equal(store.listEvents({ userId: 'user-1', scope: 'guild', guildId: 'guild-1' }).rows.length, 2);
  store.deleteScope({ actorId: 'owner-1', filter: { userId: 'user-1', scope: 'dm' } });
  assert.equal(store.listEvents({ userId: 'user-1', scope: 'dm' }).rows.length, 0);
  assert.equal(store.listEvents({ userId: 'user-1', scope: 'guild', guildId: 'guild-1' }).rows.length, 2);
  store.close();
});

test('projection deletion handles unknown timestamps without claiming a partial time-range deletion complete', () => {
  const filePath = path.join(root, 'unknown-time-memory.json');
  const previous = process.env.XIAOJI_MEMORY_PATH;
  process.env.XIAOJI_MEMORY_PATH = filePath;
  fs.writeFileSync(filePath, JSON.stringify({ private_user_memory: { 'user-1': [
    { userId: 'user-1', guildId: null, channelId: 'dm-1', userContentSummary: '舊摘要' },
  ] }, public_channel_memory: {} }));
  const timed = deleteMemoryProjection({ userId: 'user-1', scope: 'dm', from: '2026-09-26T00:00:00Z' });
  assert.deepEqual(timed, { persisted: false, reason: 'unknown_target_timestamp' });
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).private_user_memory['user-1'].length, 1);
  const allDm = deleteMemoryProjection({ userId: 'user-1', scope: 'dm' });
  assert.equal(allDm.persisted, true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).private_user_memory['user-1'].length, 0);
  if (previous === undefined) delete process.env.XIAOJI_MEMORY_PATH;
  else process.env.XIAOJI_MEMORY_PATH = previous;
});

test('capture activation is explicit and prompt memory stays scoped to the current user', async () => {
  const oldEnabled = process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED;
  const oldVersion = process.env.XIAOJI_ARCHIVE_POLICY_VERSION;
  const filePath = archivePath('capture');
  configureArchivePathResolver(() => ({ filePath, source: 'data-root' }));
  process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = 'false';
  process.env.XIAOJI_ARCHIVE_POLICY_VERSION = '1.1.0';
  assert.equal(isArchiveCaptureEnabled(), false);
  const message = { id: 'message-99', author: { id: 'user-1' }, guildId: null,
    channelId: 'dm-1', createdTimestamp: Date.parse('2026-09-26T00:00:00Z'), content: '原始訊息', client: {} };
  assert.equal(await archiveInteraction(message, { userText: '訊息', assistantText: '回覆' }), true);
  assert.equal(fs.existsSync(filePath), false);
  initializeArchive({ filePath, initializationId: 'fixture-capture' }).close();
  process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = 'true';
  assert.equal(isArchiveCaptureEnabled(), true);
  assert.equal(await archiveInteraction(message, { userText: '訊息', assistantText: '回覆' }), true);
  assert.equal(getPrivateMemoryContext('user-1'), '');
  assert.equal(await confirmArchiveInteraction(message, { userText: '訊息', assistantText: '回覆' }), true);
  assert.match(getPrivateMemoryContext('user-1'), /訊息/);
  assert.doesNotMatch(getPrivateMemoryContext('user-2'), /訊息/);
  closeArchiveForTests();
  if (oldEnabled === undefined) delete process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED;
  else process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = oldEnabled;
  if (oldVersion === undefined) delete process.env.XIAOJI_ARCHIVE_POLICY_VERSION;
  else process.env.XIAOJI_ARCHIVE_POLICY_VERSION = oldVersion;
});
