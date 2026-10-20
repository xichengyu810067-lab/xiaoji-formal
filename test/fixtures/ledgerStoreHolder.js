'use strict';

// Child process for test/ledgerStore.test.js. It opens a synthetic ledger, optionally
// records one attempted operation, reports READY on stdout, and then waits to be killed,
// which simulates closing the console window while the ledger is held.

const crypto = require('node:crypto');
const { openLedgerStore } = require('../../src/systems/safety/ledgerStore');

const [filePath, witnessPath, mode] = process.argv.slice(2);

try {
  const store = openLedgerStore({
    filePath,
    witnessPaths: [witnessPath],
    kind: 'public',
    expected: { botId: '10000000000000001', runtimeMode: 'production' },
  });
  if (mode === 'begin') {
    const bindingJson = JSON.stringify({ holder: 'synthetic' });
    store.begin({
      purposeId: 'holder',
      operationId: 'held-operation',
      sourceKey: 'holder:source',
      sourceTimeMs: null,
      bindingJson,
      bindingDigest: crypto.createHash('sha256').update(bindingJson).digest('hex'),
      generation: 1,
      target: 'holder-target',
      mergeKey: 'holder-merge',
      mergeWindowUntilMs: null,
      budgetCharged: false,
      budgetReservedAtMs: null,
      claimedAtMs: Date.now(),
    });
  }
  process.stdout.write('READY\n');
  setInterval(() => {}, 60_000);
} catch (error) {
  process.stdout.write(`ERROR ${error?.code || 'UNKNOWN'}\n`);
  process.exitCode = 1;
}
