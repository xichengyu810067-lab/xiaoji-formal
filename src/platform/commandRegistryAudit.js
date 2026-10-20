'use strict';

// Compares the slash commands this bot should register with the commands Discord holds,
// and selects which leftovers a guarded cleanup may delete. Nothing here contacts Discord
// by itself: callers pass a REST client and the routes to read.

const crypto = require('node:crypto');
const { redactText } = require('../utils/logger');

// Part of the digest input, so a format change can never reuse an older digest.
const AUDIT_FORMAT = 'xiaoji-command-audit/1';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SNOWFLAKE_PATTERN = /^\d{16,22}$/u;
const CHAT_INPUT = 1;
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;
const ITEM_TYPES = Object.freeze(['missing', 'extra', 'changed', 'shadow', 'tombstone']);
// owner-guild: the guild that holds the owner-only commands when no private command group targets it.
// When one does, the guild stays a private-guild and carries both sets of commands.
const SCOPE_KINDS = new Set(['public-global', 'private-guild', 'owner-guild', 'cleanup-guild', 'other-guild', 'test-guild']);
// Cleanup may delete an extra command only in these scopes. Private guilds and the owner guild are never listed.
const DELETABLE_SCOPE_KINDS = new Set(['public-global', 'cleanup-guild', 'other-guild', 'test-guild']);
// Chat input, user and message commands. Anything else (for example an Activity entry
// point) is reported but never deleted.
const DELETABLE_COMMAND_TYPES = new Set([1, 2, 3]);
// Discord fills these in for global commands from the application settings when a command
// leaves them unset, and they do not apply to guild commands. They are compared only when
// the expected command sets them, and never in a guild scope.
const GLOBAL_DEFAULTED_FIELDS = Object.freeze(['dm_permission', 'contexts', 'integration_types']);
const GUILD_PAGE_SIZE = 200;
const MAX_GUILD_PAGES = 1000;
// Guilds that cleanup must never touch, whatever the deployment plan declares. Guild IDs
// are not secrets; the list is optional.
const PROTECTED_GUILDS_ENV = 'XIAOJI_PROTECTED_GUILD_IDS';

function registryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, details);
}

function isPresent(value) {
  return value !== undefined && value !== null;
}

function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// Snowflakes are digit strings, so a shorter one is always the smaller number.
function compareSnowflakes(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a.length - b.length || compareText(a, b);
}

function scopeLabel(guildId) {
  return isPresent(guildId) ? `guild:${guildId}` : 'global';
}

/**
 * Reads the protected guild list: a comma-separated string (as in the environment), an
 * array or a Set. Returns null when nothing is configured, otherwise the sorted unique IDs.
 * Any entry that is not a Discord ID rejects the whole list; the value is never echoed.
 */
function parseProtectedGuildIds(value) {
  if (!isPresent(value)) return null;
  let entries;
  if (typeof value === 'string') entries = value.split(',');
  else if (Array.isArray(value) || value instanceof Set) entries = [...value];
  else throw registryError('COMMAND_REGISTRY_PROTECTED_INVALID', `${PROTECTED_GUILDS_ENV} must be a list of guild IDs.`);
  const ids = entries.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.some((id) => !SNOWFLAKE_PATTERN.test(id))) {
    throw registryError('COMMAND_REGISTRY_PROTECTED_INVALID', `${PROTECTED_GUILDS_ENV} must list Discord guild IDs separated by commas.`);
  }
  return Object.freeze([...new Set(ids)].sort(compareSnowflakes));
}

// ---- Canonical JSON and command hashing ---------------------------------------------------

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Discord answers null for "no localizations"; builders leave the field out.
function normalizeLocalizations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, text]) => typeof text === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sortedNumbers(values) {
  return values.map(Number).sort((left, right) => left - right);
}

function normalizeChoice(choice) {
  return {
    name: String(choice?.name ?? ''),
    name_localizations: normalizeLocalizations(choice?.name_localizations),
    value: choice?.value,
  };
}

function normalizeOption(option) {
  const normalized = {
    type: Number(option?.type),
    name: String(option?.name ?? ''),
    name_localizations: normalizeLocalizations(option?.name_localizations),
    description: String(option?.description ?? ''),
    description_localizations: normalizeLocalizations(option?.description_localizations),
  };
  // Discord leaves out false flags and empty lists; builders often send them.
  if (option?.required === true) normalized.required = true;
  if (option?.autocomplete === true) normalized.autocomplete = true;
  if (Array.isArray(option?.choices) && option.choices.length > 0) {
    normalized.choices = option.choices.map(normalizeChoice);
  }
  if (Array.isArray(option?.channel_types) && option.channel_types.length > 0) {
    normalized.channel_types = sortedNumbers(option.channel_types);
  }
  for (const key of ['min_value', 'max_value', 'min_length', 'max_length']) {
    if (isPresent(option?.[key])) normalized[key] = Number(option[key]);
  }
  if (Array.isArray(option?.options) && option.options.length > 0) {
    normalized.options = option.options.map(normalizeOption);
  }
  return normalized;
}

function commandType(command) {
  return isPresent(command?.type) ? Number(command.type) : CHAT_INPUT;
}

// Discord keeps names unique per command type, so a slash command and a context menu
// command may share a name.
function commandKey(command) {
  return `${commandType(command)}:${String(command?.name ?? '')}`;
}

function specifiedGlobalFields(command, globalScope) {
  if (!globalScope) return [];
  return GLOBAL_DEFAULTED_FIELDS.filter((field) => isPresent(command?.[field]));
}

// dm_permission is deprecated in favour of contexts, and Discord may answer with either.
// Compare what they mean: a context list decides when present (1 is the bot DM context),
// otherwise the command is usable in DMs unless dm_permission is false.
const BOT_DM_CONTEXT = 1;
function isDmAvailable(command) {
  if (Array.isArray(command?.contexts)) return command.contexts.map(Number).includes(BOT_DM_CONTEXT);
  return command?.dm_permission !== false;
}

/**
 * Reduces builder JSON or a Discord command object to the fields that define the command.
 * Only known fields are kept, so Discord's id, version, application_id, guild_id and any
 * field Discord adds later never count as a change.
 */
function normalizeCommandForHash(command, { globalScope = true, globalFields = [] } = {}) {
  const normalized = {
    type: commandType(command),
    name: String(command?.name ?? ''),
    name_localizations: normalizeLocalizations(command?.name_localizations),
    description: String(command?.description ?? ''),
    description_localizations: normalizeLocalizations(command?.description_localizations),
    default_member_permissions: isPresent(command?.default_member_permissions)
      ? String(command.default_member_permissions)
      : undefined,
    nsfw: command?.nsfw === true ? true : undefined,
    options: Array.isArray(command?.options) && command.options.length > 0
      ? command.options.map(normalizeOption)
      : undefined,
  };
  if (globalScope) {
    for (const field of globalFields) {
      if (field === 'dm_permission') normalized.dm_permission = isDmAvailable(command);
      else normalized[field] = Array.isArray(command?.[field]) ? sortedNumbers(command[field]) : null;
    }
  }
  return canonicalize(normalized);
}

function hashCommand(command, options) {
  return sha256Hex(canonicalJson(normalizeCommandForHash(command, options)));
}

// A whole removed command is reported once; otherwise each removed subcommand or group.
function findRemovedPaths(command, removed) {
  if (removed.size === 0 || commandType(command) !== CHAT_INPUT) return [];
  const name = String(command?.name ?? '');
  if (removed.has(name)) return [name];
  const found = [];
  const visit = (options, prefix) => {
    for (const option of Array.isArray(options) ? options : []) {
      if (option?.type !== SUBCOMMAND && option?.type !== SUBCOMMAND_GROUP) continue;
      const optionPath = `${prefix} ${option.name}`;
      if (removed.has(optionPath)) found.push(optionPath);
      else if (option.type === SUBCOMMAND_GROUP) visit(option.options, optionPath);
    }
  };
  visit(command?.options, name);
  return found;
}

// ---- Reading Discord ------------------------------------------------------------------------

// Only the HTTP status and a fixed-format error code are kept; the original message and
// request details never reach the output.
function describeCause(cause) {
  const parts = [];
  if (Number.isInteger(cause?.status)) parts.push(`status ${cause.status}`);
  const code = cause?.code;
  if (Number.isInteger(code) || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/u.test(code))) {
    parts.push(`code ${code}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no status';
}

/**
 * Reads one scope's commands with full localizations. Fails closed when Discord returns
 * anything that is not a list of this application's commands for this scope.
 */
async function readRegisteredCommands({ rest, route, applicationId, guildId = null, label = scopeLabel(guildId) }) {
  if (typeof rest?.get !== 'function') {
    throw registryError('COMMAND_REGISTRY_READ_UNAVAILABLE', 'Discord command readback is unavailable.');
  }
  let commands;
  try {
    commands = await rest.get(route, { query: new URLSearchParams({ with_localizations: 'true' }) });
  } catch (cause) {
    throw registryError('COMMAND_REGISTRY_READ_FAILED', `Discord command read failed for ${label} (${describeCause(cause)}).`, {
      cause,
      status: cause?.status,
    });
  }
  if (!Array.isArray(commands)) {
    throw registryError('COMMAND_REGISTRY_READ_INVALID', `Discord returned an invalid command list for ${label}.`);
  }
  const expectedGuild = isPresent(guildId) ? String(guildId) : null;
  for (const command of commands) {
    if (!command || typeof command !== 'object' || !SNOWFLAKE_PATTERN.test(String(command.id ?? ''))
        || typeof command.name !== 'string' || command.name === '') {
      throw registryError('COMMAND_REGISTRY_READ_INVALID', `Discord returned an invalid command in ${label}.`);
    }
    if (String(command.application_id ?? '') !== String(applicationId)) {
      throw registryError('COMMAND_REGISTRY_FOREIGN', `Discord returned a command of another application in ${label}.`);
    }
    const registeredGuild = isPresent(command.guild_id) ? String(command.guild_id) : null;
    const wrongGuild = expectedGuild === null
      ? registeredGuild !== null
      : registeredGuild !== null && registeredGuild !== expectedGuild;
    if (wrongGuild) {
      throw registryError('COMMAND_REGISTRY_READ_INVALID', `Discord returned a command of another scope in ${label}.`);
    }
  }
  return commands;
}

// Lists every guild the bot has joined, following Discord's ascending `after` pages.
async function listJoinedGuildIds({ rest, route, pageSize = GUILD_PAGE_SIZE, maxPages = MAX_GUILD_PAGES }) {
  if (typeof rest?.get !== 'function') {
    throw registryError('COMMAND_REGISTRY_READ_UNAVAILABLE', 'Discord guild listing is unavailable.');
  }
  const ids = new Set();
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (after !== null) query.set('after', after);
    let guilds;
    try {
      guilds = await rest.get(route, { query });
    } catch (cause) {
      throw registryError('COMMAND_REGISTRY_READ_FAILED', `Discord guild list read failed (${describeCause(cause)}).`, {
        cause,
        status: cause?.status,
      });
    }
    if (!Array.isArray(guilds)) throw registryError('COMMAND_REGISTRY_READ_INVALID', 'Discord returned an invalid guild list.');
    let last = after;
    for (const guild of guilds) {
      const id = String(guild?.id ?? '');
      if (!SNOWFLAKE_PATTERN.test(id)) throw registryError('COMMAND_REGISTRY_READ_INVALID', 'Discord returned an invalid guild ID.');
      ids.add(id);
      if (last === null || compareSnowflakes(id, last) > 0) last = id;
    }
    if (guilds.length < pageSize) return [...ids].sort(compareSnowflakes);
    if (last === after) throw registryError('COMMAND_REGISTRY_READ_INVALID', 'Discord guild list pagination did not advance.');
    after = last;
  }
  throw registryError('COMMAND_REGISTRY_READ_INVALID', 'Discord guild list exceeded the page limit.');
}

// ---- Difference list ------------------------------------------------------------------------

function normalizeScope(scope, protectedGuilds) {
  if (!SCOPE_KINDS.has(scope?.kind)) {
    throw registryError('COMMAND_REGISTRY_SCOPE_INVALID', 'Unknown command registry scope kind.');
  }
  const guildId = isPresent(scope.guildId) ? String(scope.guildId) : null;
  if ((scope.kind === 'public-global') !== (guildId === null)) {
    throw registryError('COMMAND_REGISTRY_SCOPE_INVALID', 'Only the public global scope has no guild ID.');
  }
  if (guildId !== null && !SNOWFLAKE_PATTERN.test(guildId)) {
    throw registryError('COMMAND_REGISTRY_SCOPE_INVALID', 'A command registry scope has an invalid guild ID.');
  }
  return {
    scope: scopeLabel(guildId),
    kind: scope.kind,
    guildId,
    // Protection follows the guild ID only, so it holds even when the plan forgot the guild.
    protected: guildId !== null && protectedGuilds.has(guildId),
    expected: Array.isArray(scope.expected) ? scope.expected : [],
    actual: Array.isArray(scope.actual) ? scope.actual : [],
  };
}

// The flag is written only when true, so an unset list leaves items and digests unchanged.
function protectedMark(scope) {
  return scope.protected ? { protected: true } : {};
}

function compareScopes(left, right) {
  if ((left.guildId === null) !== (right.guildId === null)) return left.guildId === null ? -1 : 1;
  return compareSnowflakes(left.guildId, right.guildId);
}

function sortRegistered(commands) {
  return [...commands].sort((left, right) => compareText(commandKey(left), commandKey(right))
    || compareSnowflakes(left.id, right.id));
}

/**
 * Builds the difference list for scopes that each carry `expected` (builder JSON) and
 * `actual` (Discord command objects). Every item names its scope and, when it exists on
 * Discord, its command ID; items and scopes of a protected guild carry protected: true.
 * The digest is a SHA-256 over the canonical JSON of the whole list together with the
 * format, the application ID and the scopes that were read (with their protection).
 */
function computeRegistryDiff({ applicationId, scopes, removedPaths = [], protectedGuildIds = null }) {
  const removed = new Set(removedPaths);
  const protectedGuilds = new Set(parseProtectedGuildIds(protectedGuildIds) || []);
  const ordered = scopes.map((scope) => normalizeScope(scope, protectedGuilds)).sort(compareScopes);
  const seen = new Set();
  for (const scope of ordered) {
    if (seen.has(scope.scope)) throw registryError('COMMAND_REGISTRY_SCOPE_INVALID', `Scope ${scope.scope} is listed twice.`);
    seen.add(scope.scope);
  }

  const globalCommandIds = new Map();
  for (const scope of ordered.filter((item) => item.guildId === null)) {
    for (const command of sortRegistered(scope.actual)) {
      const key = commandKey(command);
      if (!globalCommandIds.has(key)) globalCommandIds.set(key, String(command.id));
    }
  }

  const items = [];
  for (const scope of ordered) {
    const globalScope = scope.guildId === null;
    const expectedByKey = new Map(scope.expected.map((command) => [commandKey(command), command]));
    const matched = new Set();
    for (const command of sortRegistered(scope.actual)) {
      const key = commandKey(command);
      const base = {
        scope: scope.scope,
        scopeKind: scope.kind,
        name: String(command.name),
        commandType: commandType(command),
        commandId: String(command.id),
        ...protectedMark(scope),
      };
      const expected = matched.has(key) ? undefined : expectedByKey.get(key);
      if (expected) {
        matched.add(key);
        const globalFields = specifiedGlobalFields(expected, globalScope);
        const expectedHash = hashCommand(expected, { globalScope, globalFields });
        const actualHash = hashCommand(command, { globalScope, globalFields });
        if (expectedHash !== actualHash) items.push({ type: 'changed', ...base, expectedHash, actualHash });
      } else {
        items.push({ type: 'extra', ...base, actualHash: hashCommand(command, { globalScope }) });
      }
      // Discord shows a guild command next to a global command of the same name and type.
      if (!globalScope && globalCommandIds.has(key)) {
        items.push({ type: 'shadow', ...base, globalCommandId: globalCommandIds.get(key) });
      }
      // Tombstones describe public commands; a private guild's own planned commands follow its plan.
      if (!(scope.kind === 'private-guild' && expected)) {
        for (const removedPath of findRemovedPaths(command, removed)) items.push({ type: 'tombstone', ...base, path: removedPath });
      }
    }
    for (const [key, expected] of expectedByKey) {
      if (matched.has(key)) continue;
      items.push({
        type: 'missing',
        scope: scope.scope,
        scopeKind: scope.kind,
        name: String(expected.name),
        commandType: commandType(expected),
        ...protectedMark(scope),
        expectedHash: hashCommand(expected, { globalScope, globalFields: specifiedGlobalFields(expected, globalScope) }),
      });
    }
  }

  const scopeRank = new Map(ordered.map((scope, index) => [scope.scope, index]));
  items.sort((left, right) => scopeRank.get(left.scope) - scopeRank.get(right.scope)
    || ITEM_TYPES.indexOf(left.type) - ITEM_TYPES.indexOf(right.type)
    || left.commandType - right.commandType
    || compareText(left.name, right.name)
    || compareText(left.path || '', right.path || '')
    || compareSnowflakes(left.commandId || '', right.commandId || ''));

  const summaries = ordered.map((scope) => Object.freeze({
    scope: scope.scope,
    kind: scope.kind,
    guildId: scope.guildId,
    ...protectedMark(scope),
    expected: scope.expected.length,
    registered: scope.actual.length,
  }));
  const frozenItems = items.map((item) => Object.freeze(item));
  // Protection is part of the digest: changing the protected list after an audit changes
  // what cleanup may delete, so the old digest must stop matching.
  const digest = sha256Hex(canonicalJson({
    format: AUDIT_FORMAT,
    applicationId: String(applicationId),
    scopes: summaries.map((summary) => ({ scope: summary.scope, kind: summary.kind, ...protectedMark(summary) })),
    items: frozenItems,
  }));
  return Object.freeze({
    format: AUDIT_FORMAT,
    applicationId: String(applicationId),
    scopes: Object.freeze(summaries),
    items: Object.freeze(frozenItems),
    counts: Object.freeze(Object.fromEntries(ITEM_TYPES.map((type) => [type, items.filter((item) => item.type === type).length]))),
    digest,
  });
}

// Only extra commands in global or non-private, unprotected scopes are cleanup candidates.
// Missing, changed and subcommand tombstones are fixed by a normal deployment instead.
function selectCleanupTargets(diff) {
  return diff.items.filter((item) => item.type === 'extra'
    && item.protected !== true
    && DELETABLE_SCOPE_KINDS.has(item.scopeKind)
    && DELETABLE_COMMAND_TYPES.has(item.commandType));
}

// Extra commands that cleanup leaves alone because their guild is protected.
function selectProtectedExtras(diff) {
  return diff.items.filter((item) => item.type === 'extra' && item.protected === true);
}

// ---- Output ---------------------------------------------------------------------------------

function safeLabel(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N}\p{M}_' -]/gu, '?').slice(0, 100);
}

function commandLabel(name, type) {
  return `"${type === CHAT_INPUT ? '/' : ''}${safeLabel(name)}"`;
}

function formatRegistryItem(item) {
  const parts = [item.type, `scope=${item.scope}`, `kind=${item.scopeKind}`, `name=${commandLabel(item.name, item.commandType)}`];
  if (item.commandType !== CHAT_INPUT) parts.push(`type=${item.commandType}`);
  if (item.commandId) parts.push(`id=${item.commandId}`);
  if (item.path) parts.push(`path=${commandLabel(item.path, CHAT_INPUT)}`);
  if (item.globalCommandId) parts.push(`global-id=${item.globalCommandId}`);
  if (item.type === 'changed') {
    parts.push(`expected-hash=${item.expectedHash.slice(0, 12)}`, `registered-hash=${item.actualHash.slice(0, 12)}`);
  }
  if (item.protected === true) parts.push('protected=true');
  return parts.join(' ');
}

// The digest is always the last line.
function formatRegistryReport(diff, { prefix = '[COMMAND_AUDIT]', cleanupCandidates } = {}) {
  const lines = diff.scopes.map((scope) => `${prefix} scope ${scope.scope} kind=${scope.kind} expected=${scope.expected} registered=${scope.registered}`
    + (scope.protected === true ? ' protected=true' : ''));
  for (const item of diff.items) lines.push(`${prefix} ${formatRegistryItem(item)}`);
  const counts = ITEM_TYPES.map((type) => `${type}=${diff.counts[type]}`).join(' ');
  lines.push(`${prefix} summary ${counts}${cleanupCandidates === undefined ? '' : ` cleanup-candidates=${cleanupCandidates}`}`);
  lines.push(`${prefix} digest ${diff.digest}`);
  return lines;
}

// Every output line passes through here: the known token is removed, and so is anything
// that looks like a Discord token, an API key or a secret from the environment.
function createSafeWriter(write, secrets = []) {
  const known = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= 8))];
  return (line) => {
    let text = String(line);
    for (const secret of known) text = text.split(secret).join('[redacted-secret]');
    write(redactText(text));
  };
}

module.exports = {
  AUDIT_FORMAT,
  DIGEST_PATTERN,
  ITEM_TYPES,
  PROTECTED_GUILDS_ENV,
  SNOWFLAKE_PATTERN,
  canonicalJson,
  computeRegistryDiff,
  createSafeWriter,
  describeCause,
  findRemovedPaths,
  formatRegistryItem,
  formatRegistryReport,
  hashCommand,
  listJoinedGuildIds,
  normalizeCommandForHash,
  parseProtectedGuildIds,
  readRegisteredCommands,
  scopeLabel,
  selectCleanupTargets,
  selectProtectedExtras,
};
