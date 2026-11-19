'use strict';

// How each slash command has been doing, from what really happened: src/events/interactionCreate.js records whether
// every run finished or threw. The public status page (publicCommandStatus.js) reads it per command and subcommand.
//
// A command (or one of its subcommands) is 'broken' after 3 runs in a row threw, the last of them within 15 minutes,
// the same rule as the outside services (serviceHealth.js). One run that finishes clears it, and a failure older than
// 15 minutes with nothing since is forgotten. A command that nobody ran yet has no evidence of a problem.
//
// Only outcomes are kept, in memory: no user, server, option value or error text. A command that catches its own error
// and answers with a message counts as finished; only an error that escapes the command is seen here.

const { FAILURES_TO_BREAK, FAILURE_MEMORY_MS } = require('./serviceHealth');

const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const state = new Map();

// "command" or "command subcommand"; a subcommand inside a group is "command group sub", as in src/platform/catalogs/commandCatalog.js.
function commandPath(command, subcommand = null) {
  return subcommand ? `${command} ${subcommand}` : command;
}

function isValidPath(path) {
  return typeof path === 'string' && path.split(' ').length <= 3 && path.split(' ').every((part) => NAME_PATTERN.test(part));
}

function recordCommandOutcome(command, subcommand, ok, at = Date.now()) {
  const path = commandPath(command, subcommand);
  if (!isValidPath(path)) return;
  const current = state.get(path) || { consecutiveFailures: 0, lastFailureAt: null };
  if (ok) {
    current.consecutiveFailures = 0;
  } else {
    current.consecutiveFailures += 1;
    current.lastFailureAt = at;
  }
  state.set(path, current);
}

// 'broken' or 'normal' for one command or subcommand path.
function commandOutcomeStatus(command, subcommand = null, now = Date.now()) {
  const current = state.get(commandPath(command, subcommand));
  if (!current) return 'normal';
  if (current.consecutiveFailures >= FAILURES_TO_BREAK && current.lastFailureAt !== null &&
      now - current.lastFailureAt <= FAILURE_MEMORY_MS) {
    return 'broken';
  }
  return 'normal';
}

// The subcommand path a chat input interaction ran ("group sub" or "sub"), or null for a command without one.
function interactionSubcommand(interaction) {
  try {
    const group = interaction?.options?.getSubcommandGroup?.(false) || null;
    const subcommand = interaction?.options?.getSubcommand?.(false) || null;
    if (!subcommand) return null;
    return group ? `${group} ${subcommand}` : subcommand;
  } catch {
    return null;
  }
}

function resetCommandHealthForTests() {
  state.clear();
}

module.exports = {
  commandOutcomeStatus,
  interactionSubcommand,
  recordCommandOutcome,
  resetCommandHealthForTests,
};
