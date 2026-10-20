'use strict';

// With XIAOJI_ARCHIVE_CAPTURE_ENABLED=true the start-up preflight asks the archive service for the
// archive path. The service once did not export getArchivePath, so the bot refused to start the moment
// the archive was switched on ("getArchivePath is not a function"). This runs the real preflight with
// capture on, so a missing export fails here and not on the host.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const archiveService = require('../src/services/aiArchiveService');
const { resolveDataPath } = require('../src/platform/dataPaths');
const { preflightRuntimeData } = require('../src/platform/runtimeDataPreflight');

function withEnv(values, run) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
  return Promise.resolve().then(run).finally(restore);
}

test('the archive service exports the path function the preflight uses', () => {
  assert.equal(typeof archiveService.getArchivePath, 'function');
  assert.equal(typeof archiveService.isArchiveCaptureEnabled, 'function');
  assert.equal(typeof archiveService.preflightArchive, 'function');
});

test('the start-up preflight resolves the archive path when archive capture is on', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-archive-preflight-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coinPath = path.join(root, 'xiaoji.sqlite');
  fs.writeFileSync(coinPath, 'not empty');
  fs.writeFileSync(path.join(root, 'audit.json'), '{}');
  fs.writeFileSync(path.join(root, 'whitelist.json'), '{}');
  const archivePath = path.join(root, 'archive', 'conversations.sqlite');
  fs.mkdirSync(path.dirname(archivePath));
  fs.writeFileSync(archivePath, 'archive');
  archiveService.configureArchivePathResolver(resolveDataPath);
  const calls = [];
  await withEnv({
    XIAOJI_ARCHIVE_CAPTURE_ENABLED: 'true',
    XIAOJI_ARCHIVE_POLICY_VERSION: archiveService.ARCHIVE_POLICY_VERSION,
    XIAOJI_ARCHIVE_DB_PATH: archivePath,
  }, async () => {
    await preflightRuntimeData({
      coinPath,
      admission: { audit: { filePath: path.join(root, 'audit.json') }, whitelist: { filePath: path.join(root, 'whitelist.json') } },
      readAdmission: () => calls.push('admission'),
      readReminderData: () => calls.push('reminders'),
      readCalendarData: () => calls.push('calendar'),
      resolvePersonalDescriptors: () => [],
      checkArchive: async () => { calls.push('archive'); return true; },
      initializeCoins: async () => { calls.push('coins'); },
    });
  });
  assert.deepEqual(calls, ['admission', 'admission', 'reminders', 'calendar', 'archive', 'coins']);
});

test('the start-up preflight stops the login when the archive cannot be used', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-archive-preflight-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coinPath = path.join(root, 'xiaoji.sqlite');
  fs.writeFileSync(coinPath, 'not empty');
  fs.writeFileSync(path.join(root, 'audit.json'), '{}');
  fs.writeFileSync(path.join(root, 'whitelist.json'), '{}');
  const archivePath = path.join(root, 'archive', 'conversations.sqlite');
  fs.mkdirSync(path.dirname(archivePath));
  fs.writeFileSync(archivePath, 'archive');
  archiveService.configureArchivePathResolver(resolveDataPath);
  await withEnv({
    XIAOJI_ARCHIVE_CAPTURE_ENABLED: 'true',
    XIAOJI_ARCHIVE_POLICY_VERSION: archiveService.ARCHIVE_POLICY_VERSION,
    XIAOJI_ARCHIVE_DB_PATH: archivePath,
  }, async () => {
    await assert.rejects(preflightRuntimeData({
      coinPath,
      admission: { audit: { filePath: path.join(root, 'audit.json') }, whitelist: { filePath: path.join(root, 'whitelist.json') } },
      readAdmission: () => {},
      readReminderData: () => {},
      readCalendarData: () => {},
      resolvePersonalDescriptors: () => [],
      checkArchive: async () => false,
      initializeCoins: async () => { throw new Error('must not be reached'); },
    }), /AI archive/u);
  });
});
