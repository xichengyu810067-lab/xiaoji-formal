'use strict';

// Child process for the ledger bootstrap, store, and safety-ledger script tests. The only
// argument is a JSON object; `mode` selects what the child does:
// - hold: opens one ledger store, reports READY, and either closes it after holdMs or
//   (holdMs 0) waits to be killed, which simulates a second running instance.
// - decide-crash: opens a store and is killed (SIGKILL) inside recordDecision, after the
//   commit and before the witness write.
// - bootstrap-crash: runs the bootstrap against a temporary coin database and is killed
//   when the fault injector reaches the given label and phase.
// Every path it touches is passed in by the test and lies in a temporary directory.

const crypto = require('node:crypto');

const options = JSON.parse(process.argv[2] || '{}');

function kill() {
  process.kill(process.pid, 'SIGKILL');
}

async function main() {
  if (options.mode === 'hold') {
    const { openLedgerStore } = require('../../src/systems/safety/ledgerStore');
    const store = openLedgerStore({
      filePath: options.filePath,
      witnessPaths: options.witnessPaths,
      kind: options.kind,
      expected: { botId: options.botId, ownerId: options.ownerId ?? undefined, runtimeMode: options.runtimeMode },
    });
    process.stdout.write('READY\n');
    if (options.holdMs > 0) {
      setTimeout(() => {
        store.close();
        process.stdout.write('RELEASED\n');
      }, options.holdMs);
    } else {
      setInterval(() => {}, 60_000);
    }
    return;
  }
  if (options.mode === 'decide-crash') {
    const { openLedgerStore } = require('../../src/systems/safety/ledgerStore');
    let armed = false;
    const store = openLedgerStore({
      filePath: options.filePath,
      witnessPaths: options.witnessPaths,
      kind: 'public',
      expected: { botId: options.botId, runtimeMode: 'production' },
      faultInjector: ({ label, phase }) => {
        if (armed && label === 'decide' && phase === 'before-witness-write') kill();
      },
    });
    const bindingJson = JSON.stringify({ decision: 'crash' });
    armed = true;
    process.stdout.write('DECIDING\n');
    store.recordDecision({
      purposeId: 'synthetic.purpose',
      operationId: 'crash-decision',
      sourceKey: 'source:crash',
      sourceTimeMs: null,
      bindingJson,
      bindingDigest: crypto.createHash('sha256').update(bindingJson).digest('hex'),
      generation: 1,
      target: 'synthetic-target',
      mergeKey: 'crash-merge',
      mergeWindowUntilMs: null,
      budgetCharged: false,
      budgetReservedAtMs: null,
      claimedAtMs: 10_000,
      resultCode: 'never_sent',
    });
    process.stdout.write('DECIDED_UNEXPECTEDLY\n');
    return;
  }
  if (options.mode === 'bootstrap-crash') {
    process.env.COIN_DB_PATH = options.coinDbPath;
    const { bootstrapSafetyLedgers } = require('../../src/systems/safety/ledgerBootstrap');
    const quiet = { info() {}, warn() {}, error() {} };
    await bootstrapSafetyLedgers({
      env: { XIAOJI_DATA_ROOT: options.dataRoot },
      runtimeMode: 'production',
      botId: options.botId,
      ownerId: options.ownerId,
      coinDbPath: options.coinDbPath,
      logger: quiet,
      faultInjector: ({ label, phase, purposeId }) => {
        if (label === options.label && phase === options.phase &&
            (!options.purposeId || !purposeId || purposeId === options.purposeId)) kill();
      },
    });
    process.stdout.write('BOOTSTRAP_FINISHED_UNEXPECTEDLY\n');
    return;
  }
  throw new Error('unknown mode');
}

main().catch((error) => {
  process.stdout.write(`ERROR ${error?.code || 'UNKNOWN'}\n`);
  process.exitCode = 1;
});
