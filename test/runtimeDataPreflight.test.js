const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflightRuntimeData } = require('../src/platform/runtimeDataPreflight');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-runtime-preflight-'));
  const coinPath = path.join(root, 'coins.sqlite');
  const auditPath = path.join(root, 'audit.json');
  const whitelistPath = path.join(root, 'whitelist.json');
  fs.writeFileSync(coinPath, 'synthetic existing database');
  fs.writeFileSync(auditPath, '{}');
  fs.writeFileSync(whitelistPath, '[]');
  const admission = {
    audit: { kind: 'audit', envName: 'XIAOJI_AUDIT_DATA_PATH', filePath: auditPath },
    whitelist: { kind: 'whitelist', envName: 'XIAOJI_INVITER_WHITELIST_PATH', filePath: whitelistPath },
  };
  return {
    root, coinPath, auditPath, whitelistPath, admission,
    cleanup() {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('xiaoji-runtime-preflight-'));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('missing active coin path stops before any data initializer', async () => {
  const data = fixture();
  try {
    fs.unlinkSync(data.coinPath);
    let initialized = false;
    await assert.rejects(preflightRuntimeData({
      coinPath: data.coinPath, admission: data.admission,
      resolvePersonalDescriptors: () => [],
      readReminderData: () => ({}), readCalendarData: () => ({}),
      captureEnabled: () => false, initializeCoins: async () => { initialized = true; },
    }), /尚未明確初始化/);
    assert.equal(initialized, false);
    assert.equal(fs.existsSync(data.coinPath), false);
  } finally { data.cleanup(); }
});

test('corrupt admission or personal data stops before coin initialization', async () => {
  const data = fixture();
  try {
    let initialized = false;
    const options = {
      coinPath: data.coinPath, admission: data.admission,
      resolvePersonalDescriptors: () => [],
      readReminderData: () => ({}), readCalendarData: () => ({}),
      captureEnabled: () => false, initializeCoins: async () => { initialized = true; },
    };
    fs.writeFileSync(data.auditPath, '{broken');
    await assert.rejects(preflightRuntimeData(options), (error) => error.code === 'ADMISSION_DATA_INVALID_JSON');
    fs.writeFileSync(data.auditPath, '{}');
    await assert.rejects(preflightRuntimeData({ ...options, readReminderData: () => { throw new Error('bad reminder'); } }), /bad reminder/);
    await assert.rejects(preflightRuntimeData({ ...options, readCalendarData: () => { throw new Error('bad calendar'); } }), /bad calendar/);
    assert.equal(initialized, false);
  } finally { data.cleanup(); }
});

test('archive gate and database validation finish before login may proceed', async () => {
  const data = fixture();
  try {
    let initialized = false;
    const options = {
      coinPath: data.coinPath, admission: data.admission,
      resolvePersonalDescriptors: () => [],
      readReminderData: () => ({}), readCalendarData: () => ({}),
      captureEnabled: () => true, checkArchive: async () => false,
      initializeCoins: async () => { initialized = true; },
    };
    await assert.rejects(preflightRuntimeData(options), /archive 無法使用/);
    assert.equal(initialized, false);
    await assert.rejects(preflightRuntimeData({ ...options, checkArchive: async () => true,
      initializeCoins: async () => { throw new Error('corrupt database'); } }), /corrupt database/);
    await preflightRuntimeData({ ...options, checkArchive: async () => true });
    assert.equal(initialized, true);
  } finally { data.cleanup(); }
});
