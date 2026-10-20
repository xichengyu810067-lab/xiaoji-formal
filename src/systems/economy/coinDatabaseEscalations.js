'use strict';

// The coin database's escalations for the shutdown report: a directory fsync that failed
// after a write was already committed (see "Durable persistence" in coinDatabase.js). They
// have the same shape as the side-effect ledgers' own (src/systems/safety/ledgerEscalation.js),
// so src/index.js lists this module among its shutdown sources and a pending one ends the
// process with the escalation exit code. Entry code does not load the storage engine itself,
// so it reads them through here.
//
// Unlike the ledgers' sources, each escalation is handed out once: the stop reports the coin
// database twice (with the ledgers, then once more just before the process exits, for a write
// that failed during the later stop steps), and nothing may be reported twice. The entries are
// the coin database's own frozen objects, so a fresh database (tests) starts afresh.
//
// Only the shutdown reports (settleLedgerShutdown in src/index.js) may call
// getLedgerEscalations: a call takes the escalations it returns, so any other reader would
// keep them from the exit code. The name is the one every shutdown source must have.

const coinDatabase = require('../../services/coinDatabase');

const handedOut = new WeakSet();

function getLedgerEscalations() {
  const fresh = coinDatabase.getLedgerEscalations().filter((entry) => !handedOut.has(entry));
  for (const entry of fresh) handedOut.add(entry);
  return Object.freeze(fresh);
}

module.exports = { getLedgerEscalations };
