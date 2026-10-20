'use strict';

// Test fixture for the public side-effect runtime: one ledger per public purpose,
// initialized offline, and opened the way the bootstrap (src/systems/safety/
// ledgerBootstrap.js) delivers them. In production only the bootstrap opens ledgers; the
// runtime takes what it is given and never opens one itself.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializePublicPurposeLedger,
  openPublicPurposeLedger,
} = require('../../src/systems/safety/sideEffectLedger');
const { PURPOSES } = require('../../src/systems/safety/publicSideEffectRuntime');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ledgerIdFor(purposeId, name) {
  return `${purposeId.replace(/[^A-Za-z0-9]+/gu, '-')}-${name}`;
}

// Creates the ledgers under root and returns how to open each of them:
// { [purposeId]: { filePath, expectedReceiptSha256 } }.
function initializePublicLedgers({ root, name, botId, cutover, cutovers = {}, initializedAtMs = cutover }) {
  const ledgers = {};
  let index = 0;
  for (const [purposeId, definition] of Object.entries(PURPOSES)) {
    const ledgerRoot = path.join(root, `${name}-${index}-ledger`);
    const witnessRoot = path.join(root, `${name}-${index}-witness`);
    fs.mkdirSync(ledgerRoot);
    fs.mkdirSync(witnessRoot);
    const initialized = initializePublicPurposeLedger({
      filePath: path.join(ledgerRoot, 'ledger.json'),
      continuityWitnessPath: path.join(witnessRoot, 'witness.json'),
      ledgerId: ledgerIdFor(purposeId, name),
      initializationId: `synthetic-${purposeId}-${name}`,
      purposeIdentity: {
        purposeId,
        botId,
        sourceNamespace: definition.sourceNamespace,
        cutoverSourceTimestampMs: cutovers[purposeId] ?? cutover,
        freshSourceProofDigest: sha256(`fresh-${purposeId}-${name}`),
      },
      now: () => initializedAtMs,
    });
    ledgers[purposeId] = Object.freeze({ filePath: initialized.ledgerPath, expectedReceiptSha256: initialized.receiptSha256 });
    index += 1;
  }
  return Object.freeze(ledgers);
}

// Opens the configured ledgers as a Map from purpose ID to ledger, the shape the bootstrap
// delivers. Like the bootstrap, a ledger that cannot be opened is not delivered (its
// error is kept in `failures`). faultInjectorFor(purposeId) may return a test-only fault
// injector.
function openPublicLedgers(ledgers, { botId, now, faultInjectorFor = () => null } = {}) {
  const opened = new Map();
  const failures = new Map();
  for (const [purposeId, config] of Object.entries(ledgers)) {
    const faultInjector = faultInjectorFor(purposeId);
    try {
      opened.set(purposeId, openPublicPurposeLedger({
        ...config,
        now,
        expectedPurposeIdentity: { purposeId, botId, sourceNamespace: PURPOSES[purposeId].sourceNamespace },
        ...(faultInjector ? { faultInjector } : {}),
      }));
    } catch (error) {
      failures.set(purposeId, error);
    }
  }
  return Object.assign(opened, { failures });
}

module.exports = { initializePublicLedgers, ledgerIdFor, openPublicLedgers };
