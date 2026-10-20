'use strict';

// One fixed catalogue is the only bridge into Owner safety notices. Producers may attach
// context, but never arbitrary notification text: a compromised input must not turn an
// alert into a second unreviewed output channel.

const SAFETY_EVENT_CODES = Object.freeze({
  AI_GUARD_DUPLICATE: 'AI_GUARD_DUPLICATE',
  AI_GUARD_GLOBAL_BUSY: 'AI_GUARD_GLOBAL_BUSY',
  AI_GUARD_TIMEOUT: 'AI_GUARD_TIMEOUT',
  AI_GUARD_USER_BUSY: 'AI_GUARD_USER_BUSY',
  AI_GUARD_USER_RATE: 'AI_GUARD_USER_RATE',
  AI_OUTPUT_MENTION_BLOCKED: 'AI_OUTPUT_MENTION_BLOCKED',
  AI_OUTPUT_URL_BLOCKED: 'AI_OUTPUT_URL_BLOCKED',
  AI_REQUEST_REFUSED: 'AI_REQUEST_REFUSED',
  AI_PROMPT_INJECTION_BLOCKED: 'AI_PROMPT_INJECTION_BLOCKED',
  // The two AUDIT_* codes are not sent by anything any more (guilds are not reviewed; a join is
  // OWNER_EVENT_GUILD_JOINED below). They stay in the catalogue, with their fixed texts.
  AUDIT_GUILD_JOINED: 'AUDIT_GUILD_JOINED',
  AUDIT_AUTO_LEFT: 'AUDIT_AUTO_LEFT',
  ARCHIVE_UNAVAILABLE: 'ARCHIVE_UNAVAILABLE',
  // Events the Owner asked to hear about, each its own event with its own fixed text and its own
  // notice budget (ownerSafetyNotifier.js, sideEffectLedger.js OWNER_BUDGET_POLICIES). They carry
  // their facts in `notice` (normalizeContext below).
  OWNER_EVENT_MEMBER_LEFT: 'OWNER_EVENT_MEMBER_LEFT',
  OWNER_EVENT_GUILD_JOINED: 'OWNER_EVENT_GUILD_JOINED',
  OWNER_EVENT_RECOVERED: 'OWNER_EVENT_RECOVERED',
  // A member or an outside party tried something the bot refuses (see SECURITY_ALERT_KINDS). Fixed text
  // only: the notice names the guild and the kind, never anything the actor wrote or their ID.
  OWNER_EVENT_SECURITY_ALERT: 'OWNER_EVENT_SECURITY_ALERT',
});

const FIXED_CODES = new Set(Object.values(SAFETY_EVENT_CODES));
const EGRESS_CODE = /^EGRESS_[A-Z0-9_]{1,96}$/u;
const LEDGER_CODE = /^LEDGER_[A-Z0-9_]{1,96}$/u;
const SNOWFLAKE = /^\d{17,20}$/u;
// The largest time a JavaScript Date can hold; a time beyond it is no time at all.
const MAX_EVENT_TIME_MS = 8_640_000_000_000_000;
let handler = null;

// The category of a code is looked up here first; the families below it are the older ones. A code
// that is in neither falls to `critical`, so every new catalogue code with a category of its own
// must be listed (a test walks the whole catalogue).
const EVENT_CATEGORIES = Object.freeze({
  [SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT]: 'member-leave',
  [SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED]: 'guild-join',
  [SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED]: 'recovery',
  [SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT]: 'security-alert',
});
const OWNER_EVENT_CODES = new Set(Object.keys(EVENT_CATEGORIES));
const OUTAGE_KINDS = Object.freeze(['crash', 'connection', 'restore']);
// What a security alert may be about: the only values a producer can name (the notice words each one with a
// fixed label, ownerSafetyNotifier.js SECURITY_ALERT_TEXT). A kind that is not here is never sent.
const SECURITY_ALERT_KINDS = Object.freeze([
  'prompt-injection', 'dev-info', 'personal-data', 'flood',
  'output-guard', 'egress-block', 'permission-denied', 'link-risk',
]);

function isSafetyEventCode(value) {
  return typeof value === 'string' && (FIXED_CODES.has(value) || EGRESS_CODE.test(value) || LEDGER_CODE.test(value));
}

function safetyEventCategory(code) {
  if (Object.hasOwn(EVENT_CATEGORIES, code)) return EVENT_CATEGORIES[code];
  if (code.startsWith('AI_') || code.startsWith('EGRESS_')) return 'ai-egress';
  if (code.startsWith('AUDIT_')) return 'audit';
  return 'critical';
}

// Which safety events are a DM to the Owner: decided here and nowhere else. Every DM spends a notice
// budget in the Owner ledger and a notice over it is dropped for good. The safety events and the ledger
// notices share the one Owner-notice budget (1 a minute, 6 an hour, 24 a day); each of the three
// OWNER_EVENT_* events (the security alert too) has a budget of its own, which no other notice spends and which they do not spend
// (OWNER_BUDGET_POLICIES in sideEffectLedger.js). An outbound text that was cleaned and
// then sent (a link replaced, a mention taken out) asks nothing of the Owner and happens whenever a
// member's words are echoed, so it is not a DM. That holds for the egress guard, which keeps its log line
// and its test-control observations (TEST_OBS_EGRESS_*), and for the clean-up of an AI reply before it is
// sent, which keeps its own (userFacingOutputPolicy.js, TEST_OBS_AI_OUTPUT_*): a member only has to ask
// the AI to repeat a link or a mention. The AI provider guard holding a chat request back (one already in
// flight, the same words again, every call slot taken, a call cut off, asking too often) is routine traffic
// too, which any member can cause; it keeps the guard's log line and observations (providerGuard.js,
// TEST_OBS_AI_GUARD_*).
// A refused AI request (AI_REQUEST_REFUSED, AI_PROMPT_INJECTION_BLOCKED) is not a DM of its own either:
// the attempt is reported as a security alert (OWNER_EVENT_SECURITY_ALERT), one DM per guild and kind an
// hour, and these two codes keep only their log line and observations.
// Nor is a blocked outbound request (every EGRESS_* code): the egress guard reports it as a security alert
// of kind egress-block. Every other code is a DM: the audit events, and the critical ones.
const ROUTINE_CODES = new Set([
  'AI_REQUEST_REFUSED',
  'AI_PROMPT_INJECTION_BLOCKED',
  'EGRESS_LINK_REWRITTEN',
  'EGRESS_MENTION_STRIPPED',
  'AI_OUTPUT_URL_BLOCKED',
  'AI_OUTPUT_MENTION_BLOCKED',
  'AI_GUARD_USER_BUSY',
  'AI_GUARD_DUPLICATE',
  'AI_GUARD_GLOBAL_BUSY',
  'AI_GUARD_TIMEOUT',
  'AI_GUARD_USER_RATE',
]);

// A blocked outbound request (any EGRESS_* code) is reported as a security alert of kind egress-block by the egress
// guard, so the code itself keeps only its log line and observation.
function notifiesOwner(code) {
  return isSafetyEventCode(code) && !ROUTINE_CODES.has(code) && !EGRESS_CODE.test(code);
}

// Guild names are only a diagnostic hint. The canonical code carries the security meaning;
// discard mentions, links and markdown rather than attempting to preserve them. Format and
// bidirectional control characters go first (invisible, they could split a mention or a link,
// or reorder what is shown around the name); the field separators and quote marks of a notice
// become spaces, so a name cannot pose as another field of it. The same clean-up serves the
// names of the OWNER_EVENT_* notices, which a member chose just as freely.
function cleanNameOnce(text) {
  return text
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/<@!?(?:\d+)>|<@&(?:\d+)>|<#(?:\d+)>/gu, '')
    .replace(/@(?:everyone|here)/giu, '')
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[\\`*_~|>[\]()]/gu, '')
    .replace(/[;:；：﹔﹕︔︓∶꞉「」『』﹁﹂﹃﹄｢｣]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 100)
    // The cut may leave half of a surrogate pair, which is no text at all and breaks the JSON of the
    // request that carries it.
    .replace(/[\uD800-\uDFFF]/gu, '');
}

// One pass can join what it leaves into the very thing it removes ('@@everyoneeveryone' becomes
// '@everyone'), so it is repeated until nothing changes. After the first pass the text is at most 100
// characters and every pass that changes it shortens it or only turns characters into spaces, so this
// ends; the bound is a guard, not part of the rule.
function sanitizeGuildName(value) {
  let current = cleanNameOnce(String(value || ''));
  for (let pass = 0; pass < 256; pass += 1) {
    const next = cleanNameOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function snowflakeOrNull(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value) ? value : null;
}

function timeOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EVENT_TIME_MS ? value : null;
}

function countOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nameOrEmpty(value) {
  return typeof value === 'string' ? sanitizeGuildName(value) : '';
}

// The facts of an OWNER_EVENT_* notice. Only the fields named here are read, each checked by its kind;
// anything else the producer attached is dropped, and a field that does not fit is null (or '' for a
// name), which the notice words as unknown. Never free text: names are cleaned like a guild name.
function normalizeNotice(notice) {
  const source = notice && typeof notice === 'object' ? notice : {};
  return Object.freeze({
    subjectId: snowflakeOrNull(source.subjectId),
    subjectName: nameOrEmpty(source.subjectName),
    subjectUsername: nameOrEmpty(source.subjectUsername),
    joinedAtMs: timeOrNull(source.joinedAtMs),
    leftAtMs: timeOrNull(source.leftAtMs),
    memberCount: countOrNull(source.memberCount),
    inviterId: snowflakeOrNull(source.inviterId),
    outageStartedAtMs: timeOrNull(source.outageStartedAtMs),
    outageEndedAtMs: timeOrNull(source.outageEndedAtMs),
    outageKind: typeof source.outageKind === 'string' && OUTAGE_KINDS.includes(source.outageKind)
      ? source.outageKind : null,
    alertKind: typeof source.alertKind === 'string' && SECURITY_ALERT_KINDS.includes(source.alertKind)
      ? source.alertKind : null,
  });
}

function normalizeContext(context = {}, code = null) {
  const at = Number(context.at ?? Date.now());
  return Object.freeze({
    at: Number.isSafeInteger(at) && at >= 0 ? at : Date.now(),
    actorId: context.actorId == null ? null : String(context.actorId),
    guildId: context.guildId == null ? null : String(context.guildId),
    channelId: context.channelId == null ? null : String(context.channelId),
    messageId: context.messageId == null ? null : String(context.messageId),
    guildName: sanitizeGuildName(context.guildName),
    ...(OWNER_EVENT_CODES.has(code) ? { notice: normalizeNotice(context.notice) } : {}),
    // A security alert without a guild is a direct message, unless the producer says the place is not known
    // (placeUnknown: no guild and no direct message either, as for a request made by a background run).
    ...(code === SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT ? { placeUnknown: context.placeUnknown === true } : {}),
  });
}

// The one way to raise a security alert. Only the named kind and the place it happened are taken; whatever
// else a producer holds (the text, the user's name) is not accepted here at all. A kind outside
// SECURITY_ALERT_KINDS is a bug of the producer and throws. The alert is a DM to the Owner only when it is
// raised inside a host operation (the notifier needs its source), and is merged by guild and kind.
function reportSecurityAlert(kind, { guildId = null, guildName = '', actorId = null, channelId = null, messageId = null,
  placeUnknown = false } = {}) {
  if (typeof kind !== 'string' || !SECURITY_ALERT_KINDS.includes(kind)) {
    throw new TypeError('Unknown security alert kind.');
  }
  return emitSafetyEvent(SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT, {
    guildId, guildName, actorId, channelId, messageId, placeUnknown, notice: { alertKind: kind },
  });
}

function emitSafetyEvent(code, context = {}) {
  if (!isSafetyEventCode(code)) throw new TypeError('Unknown safety event code.');
  const event = Object.freeze({ code, category: safetyEventCategory(code), ...normalizeContext(context, code) });
  if (handler) {
    try { handler(event); } catch {}
  }
  return event;
}

function setSafetyEventHandler(next) {
  if (next !== null && typeof next !== 'function') throw new TypeError('Safety event handler must be a function or null.');
  const previous = handler;
  handler = next;
  return () => {
    if (handler === next) handler = previous;
  };
}

function clearSafetyEventHandlerForTests() {
  handler = null;
}

module.exports = {
  SAFETY_EVENT_CODES,
  clearSafetyEventHandlerForTests,
  emitSafetyEvent,
  SECURITY_ALERT_KINDS,
  isSafetyEventCode,
  notifiesOwner,
  reportSecurityAlert,
  safetyEventCategory,
  sanitizeGuildName,
  setSafetyEventHandler,
};
