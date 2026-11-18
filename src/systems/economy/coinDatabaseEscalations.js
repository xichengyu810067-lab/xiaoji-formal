'use strict';

// The coin database's part of the stop, for src/index.js, which does not load the storage engine
// itself: the escalations for the shutdown report and closeCoinDatabase.
//
// The escalations: a directory fsync that failed after a new database file was already created
// (see storage/durableFile.js); every other write is a SQLite COMMIT, so there are normally none.
// They have the same shape as the side-effect ledgers' own (src/systems/safety/ledgerEscalation.js),
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

const coinDatabase = require('./storage/coinDatabase');

const handedOut = new WeakSet();

function getLedgerEscalations() {
  const fresh = coinDatabase.getLedgerEscalations().filter((entry) => !handedOut.has(entry));
  for (const entry of fresh) handedOut.add(entry);
  return Object.freeze(fresh);
}

// Closes the coin database once every writer has stopped (the last step of the stop before the
// last report): new operations are refused, queued ones finish, and the connection closes, which
// checkpoints its -wal into the file and removes it.
function closeCoinDatabase() {
  return coinDatabase.closeCoinDatabase();
}

module.exports = { closeCoinDatabase, getLedgerEscalations };
