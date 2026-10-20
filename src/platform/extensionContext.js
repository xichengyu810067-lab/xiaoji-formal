'use strict';

// Which verified private extension the running code works for. The extension host opens this context
// around each call into an extension that came through the verified assembly: its hooks, its interaction
// guard, its preflight and the execute and autocomplete of its slash commands. Whatever that call starts
// (promises, timers, sockets) inherits the context; the caller is back in its own context once the call
// returns. Listeners an extension registers with client.on run in the emitter's context, not in this one.
//
// The context is kept apart from the host operation context, so runWithHostOperationContext cannot make
// one. Only one runner can open it: the extension host claims it when it loads, and a second claim in the
// same process throws EXTENSION_CONTEXT_RUNNER_CLAIMED. Code anywhere may read the context.

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const SNOWFLAKE = /^\d{17,20}$/u;
const ENTRY_KINDS = new Set(['command', 'guard', 'hook', 'preflight']);
// Far above the length of a Discord interaction token; a longer value names no interaction.
const MAX_INTERACTION_TOKEN_LENGTH = 1024;
let runnerClaimed = false;

class ExtensionContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionContextError';
    this.code = code;
  }
}

function snowflakeOrNull(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value) ? value : null;
}

// The digest an interaction token is known by in a context: SHA-256 (hex) of the token in lower case. The
// request boundary reads a route in lower case, and the context never holds the token itself.
function interactionTokenDigest(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_INTERACTION_TOKEN_LENGTH) return null;
  return crypto.createHash('sha256').update(token.toLowerCase(), 'utf8').digest('hex');
}

// The context of one call:
//   extensionId    the verified extension's id
//   entry          'hook', 'guard', 'preflight' or 'command'
//   name           what was called: 'hooks.interactionCreate', 'guards.interaction', 'preflight', '<command>.execute'
//   sourceGuildId  the guild the call came from, or null when the payload names none
// and, for a command only (null for any other entry), what the host read from the interaction it runs for:
//   actorId                 the user who ran the command
//   interactionId           the id of that interaction
//   interactionTokenDigest  the digest of its token (interactionTokenDigest above)
function freezeContext({
  extensionId, entry, name, sourceGuildId = null, actorId = null, interactionId = null, interactionToken = null,
} = {}) {
  if (typeof extensionId !== 'string' || !extensionId) throw new TypeError('An extension context needs the extension id.');
  if (!ENTRY_KINDS.has(entry)) throw new TypeError('Unknown extension context entry.');
  if (typeof name !== 'string' || !name) throw new TypeError('An extension context needs the name of what was called.');
  const command = entry === 'command';
  return Object.freeze({
    extensionId,
    entry,
    name,
    sourceGuildId: snowflakeOrNull(sourceGuildId),
    actorId: command ? snowflakeOrNull(actorId) : null,
    interactionId: command ? snowflakeOrNull(interactionId) : null,
    interactionTokenDigest: command ? interactionTokenDigest(interactionToken) : null,
  });
}

function claimExtensionContextRunner() {
  if (runnerClaimed) {
    throw new ExtensionContextError('EXTENSION_CONTEXT_RUNNER_CLAIMED', 'The extension context runner was already claimed.');
  }
  runnerClaimed = true;
  return Object.freeze({
    // Runs fn inside the context and returns what fn returns.
    run(context, fn) {
      if (typeof fn !== 'function') throw new TypeError('Extension context callback is required.');
      return storage.run(freezeContext(context), fn);
    },
  });
}

// The context of the running code as a frozen copy, or null outside any extension call.
function currentExtensionContext() {
  const context = storage.getStore();
  return context ? Object.freeze({ ...context }) : null;
}

// Runs fn with no extension context, for example to report something without lending it the extension's.
function runOutsideExtensionContext(fn) {
  if (typeof fn !== 'function') throw new TypeError('Callback is required.');
  return storage.run(null, fn);
}

module.exports = {
  claimExtensionContextRunner,
  currentExtensionContext,
  interactionTokenDigest,
  runOutsideExtensionContext,
};
