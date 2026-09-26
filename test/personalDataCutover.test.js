const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { exportPublicFiles } = require('../scripts/create-public-export');
const { createReminderSystem } = require('../src/services/reminderService');
const { createCalendarSystem } = require('../src/services/calendarService');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('explicit personal cutover retains legacy bytes and survives normal writes and restart', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-personal-cutover-')));
  const exportRoot = path.join(root, 'public');
  const protectedRoot = path.join(root, 'protected');
  try {
    exportPublicFiles({ outputPath: exportRoot });
    fs.mkdirSync(protectedRoot);
    const oldRoot = path.join(exportRoot, 'src', 'data');
    fs.mkdirSync(oldRoot, { recursive: true });
    const reminderSource = path.join(oldRoot, 'reminders.json');
    const calendarSource = path.join(oldRoot, 'calendarEvents.json');
    fs.writeFileSync(reminderSource, JSON.stringify({ one: {
      id: 'one', guildId: 'guild-a', channelId: 'channel-a', userId: 'user-a',
      message: 'legacy', remindAt: 100000, createdAt: 1000,
    } }));
    fs.writeFileSync(calendarSource, JSON.stringify({ one: {
      id: 'one', guildId: 'guild-a', channelId: 'channel-a', createdBy: 'user-a',
      title: 'legacy', startsAt: Date.now() + 60000,
    } }));
    const before = [hash(reminderSource), hash(calendarSource)];
    const env = { ...process.env, XIAOJI_DATA_ROOT: protectedRoot,
      NODE_PATH: [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter) };
    const run = (args, additionalEnv = {}) => spawnSync(process.execPath, args, {
      cwd: exportRoot, env: { ...env, ...additionalEnv }, encoding: 'utf8',
    });
    const backupPath = `${reminderSource}.legacy-v1.bak`;
    const oldReceiptPath = `${reminderSource}.migration-v1.receipt.json`;
    const reminderTarget = path.join(protectedRoot, 'reminders.json');
    const assertNoCutoverFiles = () => {
      for (const filePath of [reminderTarget, `${reminderTarget}.source-snapshot.json`,
        `${reminderTarget}.provenance.json`]) assert.equal(fs.existsSync(filePath), false);
    };
    fs.writeFileSync(backupPath, '{"older":true}\n');
    assert.notEqual(run(['scripts/migrate-personal-data.js', 'reminders', '--writers-stopped']).status, 0);
    assertNoCutoverFiles();
    fs.writeFileSync(oldReceiptPath, JSON.stringify({ version: 1, sourceHash: '0'.repeat(64),
      targetHash: hash(reminderSource), recordCount: 1 }));
    assert.notEqual(run(['scripts/migrate-personal-data.js', 'reminders', '--writers-stopped']).status, 0);
    assertNoCutoverFiles();
    fs.writeFileSync(backupPath, fs.readFileSync(reminderSource));
    fs.writeFileSync(oldReceiptPath, JSON.stringify({ version: 1, sourceHash: hash(backupPath),
      targetHash: hash(reminderSource), recordCount: 1 }));
    assert.notEqual(run(['scripts/migrate-personal-data.js', 'reminders', '--writers-stopped']).status, 0);
    assertNoCutoverFiles();
    fs.unlinkSync(backupPath);
    fs.unlinkSync(oldReceiptPath);
    fs.writeFileSync(`${reminderSource}.unknown`, 'unverified');
    assert.notEqual(run(['scripts/migrate-personal-data.js', 'reminders', '--writers-stopped']).status, 0);
    assertNoCutoverFiles();
    fs.unlinkSync(`${reminderSource}.unknown`);
    fs.writeFileSync(`${reminderSource}.lock`, 'writer');
    assert.notEqual(run(['scripts/migrate-personal-data.js', 'reminders', '--writers-stopped']).status, 0);
    assertNoCutoverFiles();
    fs.unlinkSync(`${reminderSource}.lock`);
    const sourceSystem = createReminderSystem({ filePath: reminderSource });
    sourceSystem.migrateLegacyReminderStore();
    assert.equal(hash(backupPath), before[0]);
    const migratedSourceBytes = fs.readFileSync(reminderSource);
    sourceSystem.writeReminders({ ...sourceSystem.readReminders(), later: {
      schemaVersion: 1, guildId: 'guild-a', channelId: 'channel-a', userId: 'user-a',
      message: 'later', remindAt: 200000, createdAt: 2000,
    } });
    assert.notEqual(run(['scripts/migrate-personal-data.js', 'reminders', '--writers-stopped']).status, 0);
    assertNoCutoverFiles();
    fs.writeFileSync(reminderSource, migratedSourceBytes);
    createCalendarSystem({ filePath: calendarSource }).migrateLegacyCalendarStore();
    const calendarBackupPath = `${calendarSource}.legacy-v1.bak`;
    const calendarReceiptPath = `${calendarSource}.migration-v1.receipt.json`;
    assert.equal(hash(calendarBackupPath), before[1]);
    const beforeCutover = [hash(reminderSource), hash(calendarSource)];
    const sourceReceiptBytes = fs.readFileSync(oldReceiptPath);
    const calendarReceiptBytes = fs.readFileSync(calendarReceiptPath);
    for (const kind of ['reminders', 'calendar']) {
      const result = run(['scripts/migrate-personal-data.js', kind, '--writers-stopped']);
      assert.equal(result.status, 0, result.stderr);
      const repeated = run(['scripts/migrate-personal-data.js', kind, '--writers-stopped']);
      assert.notEqual(repeated.status, 0);
    }
    assert.deepEqual([hash(reminderSource), hash(calendarSource)], beforeCutover);
    assert.equal(hash(backupPath), before[0]);
    assert.deepEqual(fs.readFileSync(oldReceiptPath), sourceReceiptBytes);
    assert.equal(hash(calendarBackupPath), before[1]);
    assert.deepEqual(fs.readFileSync(calendarReceiptPath), calendarReceiptBytes);
    const calendarTarget = path.join(protectedRoot, 'calendarEvents.json');
    for (const [sourceBackup, sourceReceipt, target] of [
      [backupPath, oldReceiptPath, reminderTarget],
      [calendarBackupPath, calendarReceiptPath, calendarTarget],
    ]) {
      assert.equal(hash(`${target}.legacy-v1.bak`), hash(sourceBackup));
      assert.equal(hash(`${target}.migration-v1.receipt.json`), hash(sourceReceipt));
      const provenance = JSON.parse(fs.readFileSync(`${target}.provenance.json`, 'utf8'));
      assert.equal(provenance.legacyMigrationEvidence.backup.filePath, `${target}.legacy-v1.bak`);
      assert.equal(provenance.legacyMigrationEvidence.receipt.filePath, `${target}.migration-v1.receipt.json`);
    }
    const receiptEnv = {
      XIAOJI_REMINDERS_PROVENANCE_SHA256: hash(`${reminderTarget}.provenance.json`),
      XIAOJI_CALENDAR_PROVENANCE_SHA256: hash(`${calendarTarget}.provenance.json`),
    };
    const currentReceipt = `${reminderTarget}.provenance.json`;
    const verify = () => run(['-e',
      "const r=require('./src/services/reminderService');const c=require('./src/services/calendarService');if(!r.readReminders().one||!c.readCalendarEvents().one)process.exit(2);"], receiptEnv);
    const firstVerify = verify();
    assert.equal(firstVerify.status, 0, firstVerify.stderr);
    const snapshotPath = `${reminderTarget}.source-snapshot.json`;
    const snapshotIdentity = fs.lstatSync(snapshotPath, { bigint: true });
    const releaseIdentity = fs.lstatSync(reminderSource, { bigint: true });
    assert.notEqual(`${snapshotIdentity.dev}:${snapshotIdentity.ino}`,
      `${releaseIdentity.dev}:${releaseIdentity.ino}`);
    const receiptBeforeRounding = fs.readFileSync(currentReceipt);
    const roundedReceipt = JSON.parse(receiptBeforeRounding.toString('utf8'));
    roundedReceipt.origin.fileIdentity = roundedReceipt.source.fileIdentity;
    fs.writeFileSync(currentReceipt, `${JSON.stringify(roundedReceipt)}\n`);
    const roundedRead = run(['-e',
      "const fs=require('node:fs');const path=require('node:path');const source=path.resolve('src/data/reminders.json');const snapshot=path.join(process.env.XIAOJI_DATA_ROOT,'reminders.json.source-snapshot.json');const roundedIno=fs.lstatSync(snapshot).ino;const original=fs.lstatSync;fs.lstatSync=(file,options)=>{const stat=original(file,options);if(typeof file==='string'&&path.resolve(file)===source&&!options?.bigint)stat.ino=roundedIno;return stat;};require('./src/services/reminderService').readReminders();"],
    { ...receiptEnv, XIAOJI_REMINDERS_PROVENANCE_SHA256: hash(currentReceipt) });
    assert.equal(roundedRead.status, 0, roundedRead.stderr);
    fs.writeFileSync(currentReceipt, receiptBeforeRounding);
    const explicitEnv = { ...receiptEnv, XIAOJI_DATA_ROOT: '',
      XIAOJI_REMINDERS_PATH: reminderTarget, XIAOJI_CALENDAR_PATH: calendarTarget };
    const explicitVerify = run(['-e',
      "require('./src/services/reminderService').readReminders();require('./src/services/calendarService').readCalendarEvents();"], explicitEnv);
    assert.equal(explicitVerify.status, 0, explicitVerify.stderr);
    const noReceipt = run(['-e', "require('./src/services/reminderService').readReminders()"], {
      ...explicitEnv, XIAOJI_REMINDERS_PROVENANCE_SHA256: '',
    });
    assert.notEqual(noReceipt.status, 0);
    const reminders = createReminderSystem({ filePath: reminderTarget });
    const calendars = createCalendarSystem({ filePath: calendarTarget });
    reminders.writeReminders({ ...reminders.readReminders(), two: {
      schemaVersion: 1, guildId: 'guild-b', channelId: 'channel-b', userId: 'user-b',
      message: 'new', remindAt: 200000, createdAt: 2000,
    } });
    calendars.writeCalendarEvents({ ...calendars.readCalendarEvents(), two: {
      schemaVersion: 1, guildId: 'guild-b', channelId: 'channel-b', createdBy: 'user-b',
      title: 'new', startsAt: Date.now() + 120000,
    } });
    const restarted = run(['-e',
      "const r=require('./src/services/reminderService');const c=require('./src/services/calendarService');if(!r.readReminders().two||!c.readCalendarEvents().two)process.exit(2);"], receiptEnv);
    assert.equal(restarted.status, 0, restarted.stderr);
    fs.unlinkSync(reminderSource);
    fs.unlinkSync(calendarSource);
    for (const filePath of [backupPath, oldReceiptPath, calendarBackupPath, calendarReceiptPath]) {
      fs.unlinkSync(filePath);
    }
    const replacedRelease = run(['-e',
      "require('./src/services/reminderService').readReminders();require('./src/services/calendarService').readCalendarEvents();"], receiptEnv);
    assert.equal(replacedRelease.status, 0, replacedRelease.stderr);
    const protectedReceipt = `${reminderTarget}.migration-v1.receipt.json`;
    const protectedReceiptBytes = fs.readFileSync(protectedReceipt);
    fs.writeFileSync(protectedReceipt, '{}');
    const alteredEvidence = run(['-e', "require('./src/services/reminderService').readReminders()"], receiptEnv);
    assert.notEqual(alteredEvidence.status, 0);
    assert.match(alteredEvidence.stderr, /Protected migration evidence/);
    fs.writeFileSync(protectedReceipt, protectedReceiptBytes);
    const badDigest = run(['-e', "require('./src/services/reminderService').readReminders()"], {
      ...receiptEnv, XIAOJI_REMINDERS_PROVENANCE_SHA256: '0'.repeat(64),
    });
    assert.notEqual(badDigest.status, 0);
    const originalReceipt = fs.readFileSync(currentReceipt);
    const forged = JSON.parse(originalReceipt.toString('utf8'));
    fs.copyFileSync(`${reminderTarget}.source-snapshot.json`, reminderSource);
    const oldSourceStat = fs.lstatSync(reminderSource);
    forged.source.filePath = reminderSource;
    forged.source.realPath = reminderSource;
    forged.source.fileIdentity = `${oldSourceStat.dev}:${oldSourceStat.ino}`;
    forged.origin.fileIdentity = `${oldSourceStat.dev}:${oldSourceStat.ino}`;
    forged.origin.realPath = reminderSource;
    fs.writeFileSync(currentReceipt, `${JSON.stringify(forged)}\n`);
    const forgedReceipt = run(['-e', "require('./src/services/reminderService').readReminders()"], {
      ...receiptEnv, XIAOJI_REMINDERS_PROVENANCE_SHA256: hash(currentReceipt),
    });
    assert.notEqual(forgedReceipt.status, 0);
    assert.match(forgedReceipt.stderr, /Cutover origin and protected snapshot/);
    const forgedCreation = run(['-e',
      "const fs=require('node:fs');const p=require('./src/platform/personalDataPaths');const t=process.env.XIAOJI_REMINDERS_PATH;const r=JSON.parse(fs.readFileSync(t+'.provenance.json'));p.createProvenance('reminders',t,{source:r.source,origin:r.origin});"],
    { ...receiptEnv, XIAOJI_REMINDERS_PATH: reminderTarget });
    assert.notEqual(forgedCreation.status, 0);
    assert.match(forgedCreation.stderr, /Cutover origin and protected snapshot/);
    fs.unlinkSync(reminderSource);
    const afterReleaseReplacement = run(['-e', "require('./src/services/reminderService').readReminders()"], {
      ...receiptEnv, XIAOJI_REMINDERS_PROVENANCE_SHA256: hash(currentReceipt),
    });
    assert.notEqual(afterReleaseReplacement.status, 0);
    assert.match(afterReleaseReplacement.stderr, /Cutover origin and protected snapshot/);
    fs.writeFileSync(currentReceipt, originalReceipt);
    const originalSnapshotBytes = fs.readFileSync(snapshotPath);
    fs.writeFileSync(snapshotPath, '{}');
    const badSource = run(['-e', "require('./src/services/reminderService').readReminders()"], receiptEnv);
    assert.notEqual(badSource.status, 0);
    fs.writeFileSync(snapshotPath, originalSnapshotBytes);
    fs.copyFileSync(snapshotPath, reminderSource);
    fs.unlinkSync(snapshotPath);
    fs.linkSync(reminderSource, snapshotPath);
    const hardlinkStat = fs.lstatSync(snapshotPath);
    const hardlinkIdentity = `${hardlinkStat.dev}:${hardlinkStat.ino}`;
    const hardlinkReceipt = JSON.parse(originalReceipt.toString('utf8'));
    hardlinkReceipt.source.fileIdentity = hardlinkIdentity;
    hardlinkReceipt.origin.fileIdentity = hardlinkIdentity;
    hardlinkReceipt.origin.realPath = reminderSource;
    fs.writeFileSync(currentReceipt, `${JSON.stringify(hardlinkReceipt)}\n`);
    const hardlinkRead = run(['-e', "require('./src/services/reminderService').readReminders()"], {
      ...receiptEnv, XIAOJI_REMINDERS_PROVENANCE_SHA256: hash(currentReceipt),
    });
    assert.notEqual(hardlinkRead.status, 0);
    assert.match(hardlinkRead.stderr, /Protected data paths must not alias/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
