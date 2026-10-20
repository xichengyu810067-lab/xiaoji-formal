'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { preflightRuntimeData } = require('../src/platform/runtimeDataPreflight');
const { startRuntime } = require('../src/platform/startupSequence');

test('startup keeps the production sequence after the optional test preflight', async () => {
  const order = [];
  await startRuntime({
    preflightControl: async () => order.push('control'),
    preflightPublic: async () => order.push('public'),
    preflightPrivate: async () => order.push('private'),
    shouldDeploy: () => true,
    deploy: async () => order.push('deploy'),
    login: async () => order.push('login'),
  });
  assert.deepEqual(order, ['control', 'public', 'private', 'deploy', 'login']);
});

test('startup stops before public/private/deploy/login when test preflight fails', async () => {
  const order = [];
  await assert.rejects(() => startRuntime({
    preflightControl: async () => { order.push('control'); throw Object.assign(new Error('fixed'), { code: 'TEST_DENIED' }); },
    preflightPublic: async () => order.push('public'), preflightPrivate: async () => order.push('private'),
    shouldDeploy: () => true, deploy: async () => order.push('deploy'), login: async () => order.push('login'),
  }), (error) => error.code === 'TEST_DENIED');
  assert.deepEqual(order, ['control']);
});

test('startup diagnostic phases are fixed and do not change the startup sequence', async () => {
  const order = [];
  const diagnostics = { setDiagnosticPhase: (phase) => order.push(`phase:${phase}`) };
  const startupDiagnostics = { enterPhase: (phase) => order.push(`startup:${phase}`) };
  await startRuntime({
    preflightControl: async () => order.push('control'),
    preflightPublic: async () => order.push('public'),
    preflightPrivate: async () => order.push('private'),
    shouldDeploy: () => false,
    deploy: async () => order.push('deploy'),
    login: async () => order.push('login'),
    testControlDiagnostics: diagnostics,
    startupDiagnostics,
  });
  assert.deepEqual(order, [
    'startup:IDENTITY_PREFLIGHT', 'phase:identity_preflight', 'control',
    'startup:RUNTIME_PREFLIGHT', 'phase:runtime_preflight', 'public', 'private',
    'startup:LOGIN_REST', 'phase:login_wait_ready', 'login',
    'startup:READY_WAIT',
  ]);
});

test('public data preflight opens coins, then the ledger bootstrap, then the three runtimes, before private startup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-owner-preflight-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const named = Object.fromEntries(['coin', 'audit', 'whitelist', 'reminder', 'calendar'].map((name) => {
    const filePath = path.join(root, `${name}.data`);
    fs.writeFileSync(filePath, `${name}\n`);
    return [name, filePath];
  }));
  const order = [];
  const delivered = new Map([['welcome', { synthetic: true }]]);
  await startRuntime({
    preflightControl: async () => order.push('control'),
    preflightPublic: () => preflightRuntimeData({
      coinPath: named.coin,
      admission: { audit: { filePath: named.audit }, whitelist: { filePath: named.whitelist } },
      readAdmission: ({ filePath }) => order.push(path.basename(filePath, '.data')),
      readReminderData: () => order.push('reminder'),
      readCalendarData: () => order.push('calendar'),
      resolvePersonalDescriptors: () => [
        { filePath: named.reminder }, { filePath: named.calendar },
      ],
      captureEnabled: () => false,
      bootstrapLedgers: async ({ reservedDescriptors }) => {
        assert.equal(reservedDescriptors.length, 5);
        order.push('bootstrap');
        return delivered;
      },
      checkOwnerSafetyNotifications: async ({ reservedDescriptors, ledgers }) => {
        assert.equal(reservedDescriptors.length, 5);
        assert.equal(ledgers, delivered);
        order.push('owner-safety');
      },
      checkWelcomeSideEffects: async ({ reservedDescriptors, ledgers }) => {
        assert.equal(reservedDescriptors.length, 5);
        assert.equal(ledgers, delivered);
        order.push('welcome-safety');
      },
      checkPublicSideEffects: async ({ reservedDescriptors, ledgers }) => {
        assert.equal(reservedDescriptors.length, 5);
        assert.equal(ledgers, delivered);
        order.push('public-safety');
      },
      initializeCoins: async () => order.push('coins'),
    }),
    preflightPrivate: async () => order.push('private'),
    shouldDeploy: () => false,
    deploy: async () => assert.fail('must not deploy'),
    login: async () => order.push('login'),
  });
  assert.deepEqual(order, [
    'control', 'audit', 'whitelist', 'reminder', 'calendar',
    'coins', 'bootstrap', 'owner-safety', 'welcome-safety', 'public-safety', 'private', 'login',
  ]);
});
