'use strict';

const crypto = require('node:crypto');
const { Routes } = require('discord.js');
const { assertDistinctDataPaths } = require('../../platform/dataPaths');
const { getHostOperationContext } = require('../../platform/hostOperationContext');
const { rewriteLinks } = require('../../platform/linkPolicy');
const { snowflakeTimestamp } = require('../../platform/publicEffectGrant');
const { installProtectedRest, outcomeCode, outcomeResult } = require('../../platform/protectedRest');
const { setConversationSafetyEventHandler } = require('../conversation/safetyEvents');
const {
  SAFETY_EVENT_CODES,
  SECURITY_ALERT_KINDS,
  isSafetyEventCode,
  notifiesOwner,
  safetyEventCategory,
  sanitizeGuildName,
  setSafetyEventHandler,
} = require('../../platform/safetyEventCatalog');
const { createLedgerEscalations, formatLedgerFailure } = require('./ledgerEscalation');
const { resolveProtectedEffects } = require('./ledgerBootstrap');
const {
  OWNER_BUDGET_POLICIES,
  OWNER_BUDGET_TARGET_SUFFIXES,
  OWNER_PURPOSE_ID,
} = require('./sideEffectLedger');

const QUEUE_LIMIT = 128;
// Notices accepted before arm() wait in memory; at most this many. A notice beyond it is
// dropped with a log line: not queued, not recorded (a suppressed record would open a merge
// window that the queued notices of the same kind would then merge into, unsent), not
// sent, and not retried later.
const PRE_ARM_QUEUE_LIMIT = 32;
const WORKER_CONCURRENCY = 1;
const DISPATCH_TIMEOUT_MS = 15_000;
// The background job the deadline timer of a send runs as (protectedRest.js).
const PROTECTED_LABEL = 'safety.owner-notice';
const SNOWFLAKE = /^\d{17,20}$/u;
// The fixed heading of a notice, by the kind of event (the code's family): fixed text, never anything a
// user wrote.
const NOTICE_PREFIXES = Object.freeze({
  ai: '小吉安全提示：已阻擋一項異常 AI 操作。固定代碼：',
  egress: '小吉安全提示：已阻擋一項對外送出的 Discord 請求。固定代碼：',
  audit: '小吉伺服器審核通知。固定代碼：',
  critical: '小吉安全提示：有一項異常需要處理。固定代碼：',
});
const FIXED_NOTICE_PREFIX = NOTICE_PREFIXES.ai;
// The heading of each OWNER_EVENT_* notice, by its code: fixed text, never anything a user wrote. They
// are looked up by code, not by the family a code starts with, and kept apart from NOTICE_PREFIXES,
// which names the kinds of safety event.
const EVENT_NOTICE_PREFIXES = Object.freeze({
  [SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT]: '小吉成員退出通知。固定代碼：',
  [SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED]: '小吉新伺服器加入通知。固定代碼：',
  [SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED]: '小吉恢復營運通知。固定代碼：',
  // The text of a security alert is its own fixed sentence (buildSecurityAlertNotice); this entry only marks
  // the code as an OWNER_EVENT_* one.
  [SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT]: '小吉遭受攻擊',
});
// What a security alert says of its kind: a fixed label for each kind the catalogue accepts (a test walks
// SECURITY_ALERT_KINDS), never a string a producer supplied.
const SECURITY_ALERT_TEXT = Object.freeze({
  'prompt-injection': '提示詞注入',
  'dev-info': '套取開發資訊',
  'personal-data': '索取個資或跨群資料',
  flood: '洗版',
  'output-guard': '輸出護欄觸發',
  'egress-block': '出口護欄阻擋',
  'permission-denied': '權限被拒',
  'link-risk': '釣魚或惡意連結',
});
// What a security alert calls a place that has no usable name: a direct message, or a guild whose name could
// not be found.
const SECURITY_ALERT_DM_NAME = '私訊';
const SECURITY_ALERT_UNKNOWN_GUILD_NAME = '未知群組';
// What an outage notice says of its kind: a fixed word for each of the three kinds the catalogue
// accepts, never a string a producer supplied.
const OUTAGE_KIND_TEXT = Object.freeze({
  crash: '程式異常結束後重新啟動',
  connection: '與 Discord 連線中斷後恢復',
  restore: '手動還原後恢復',
});
const UNKNOWN_TEXT = '未知';
const DM_CHANNEL_TYPE = 1;
const EVENT_MERGE_WINDOW_MS = 10 * 60 * 1_000;
// A category may keep a repeat of the same event out for longer: a security alert is raised by whoever attacks,
// as often as they like, so the same guild and kind is reported once an hour (the ledger holds the same window,
// sideEffectLedger.js OWNER_MERGE_WINDOWS_MS).
const CATEGORY_MERGE_WINDOW_MS = Object.freeze({
  'security-alert': 60 * 60 * 1_000,
});
function mergeWindowMs(category) {
  return Object.hasOwn(CATEGORY_MERGE_WINDOW_MS, category) ? CATEGORY_MERGE_WINDOW_MS[category] : EVENT_MERGE_WINDOW_MS;
}
// The number of held-back counts kept in memory (per category, and per guild and kind for security alerts);
// the oldest is forgotten first.
const MAX_SUPPRESSED_KEYS = 512;
// The in-memory intake budget and the ledger budget class of every category the catalogue has (a test
// walks the catalogue). A category with no entry here is never sent: it is not read as `critical`. The
// categories of the safety events keep their numbers and spend the shared Owner-notice budget in the
// ledger; each of the three event categories takes its numbers from the ledger's policy of its class,
// so memory and ledger never disagree about them.
const CATEGORY_BUDGETS = Object.freeze({
  'ai-egress': Object.freeze([{ windowMs: 60_000, maximum: 1 }, { windowMs: 60 * 60_000, maximum: 6 }]),
  audit: Object.freeze([{ windowMs: 60_000, maximum: 1 }, { windowMs: 60 * 60_000, maximum: 6 }]),
  critical: Object.freeze([{ windowMs: 60_000, maximum: 1 }, { windowMs: 60 * 60_000, maximum: 6 }]),
  'member-leave': OWNER_BUDGET_POLICIES['owner-member-leave'],
  'guild-join': OWNER_BUDGET_POLICIES['owner-guild-join'],
  recovery: OWNER_BUDGET_POLICIES['owner-outage'],
  'security-alert': OWNER_BUDGET_POLICIES['owner-security'],
});
// The ledger budget class a category is charged to; its target is the Owner ID plus the class's suffix
// (none for owner-notice), which is what keeps the classes' durable counts apart.
const CATEGORY_BUDGET_CLASSES = Object.freeze({
  'ai-egress': 'owner-notice',
  audit: 'owner-notice',
  critical: 'owner-notice',
  'member-leave': 'owner-member-leave',
  'guild-join': 'owner-guild-join',
  recovery: 'owner-outage',
  'security-alert': 'owner-security',
});
// Intake attempts are kept as long as the longest window of their category (never less than the merge
// window), so the memory gate can refuse what a daily window refuses and not only what an hourly one does.
function intakeRetentionMs(category) {
  const windows = Object.hasOwn(CATEGORY_BUDGETS, category) ? CATEGORY_BUDGETS[category] : [];
  return Math.max(mergeWindowMs(category), ...windows.map((window) => window.windowMs));
}
// A notice over its in-memory budget is logged once a minute per category, with the number left out.
const BUDGET_LOG_INTERVAL_MS = 60_000;
// A DM preparation that never reached Discord is tried again after 1 and then 5 minutes; the
// third counted failure stops it until the next start, with one log line
// (OWNER_SAFETY_DM_PREPARATION_STOPPED). Every later notice of this process is dropped unsent.
const DM_PREPARATION_RETRY_MS = Object.freeze([60_000, 5 * 60_000]);
const MAX_DM_PREPARATION_FAILURES = 3;
// The action of the Owner DM channel preparation (safety-ledger status looks for it).
const DM_PREPARATION_ACTION = 'dm-channel.prepare';
// The action of an OWNER_EVENT_* notice. It is not 'owner-safety-notification', so what filters or counts
// that action (the status page, the tests) never sees these.
const OWNER_EVENT_ACTION = 'owner-event-notification';
// Notices the Owner DM start guard held back (ownerDmStartGuard.js) are remembered in memory, at
// most this many (oldest forgotten first), so none of them is sent later in this process. Their
// log line is held to one a minute per kind, with the number of lines left out.
const MAX_START_GUARD_DROPPED = 4_096;
const START_GUARD_LOG_INTERVAL_MS = 60_000;
const MAX_INTAKE_KEYS = 512;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

// The egress guard rewrites every link in what the bot sends, and refuses a protected send it would have
// to rewrite (PROTECTED_REWRITE_BLOCKED), for good. A guild name is chosen by whoever owns the guild, so a
// notice is cleaned here with the guard's own link rules and options (egressGuard.js rewriteText), except
// that no link is approved: what is left has nothing the guard could rewrite, whatever it approves. A
// text that still changes after a few passes loses its guild name.
const NOTICE_LINK_OPTIONS = Object.freeze({
  approve: () => null, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true,
});
const NOTICE_LINK_PASSES = 3;

function withoutLinks(text) {
  let current = text;
  for (let pass = 0; pass < NOTICE_LINK_PASSES; pass += 1) {
    const result = rewriteLinks(current, NOTICE_LINK_OPTIONS);
    if (!result.rewritten) return current;
    current = result.text;
  }
  return null;
}

function noticePrefix(code) {
  if (Object.hasOwn(EVENT_NOTICE_PREFIXES, code)) return EVENT_NOTICE_PREFIXES[code];
  if (code.startsWith('AI_')) return NOTICE_PREFIXES.ai;
  if (code.startsWith('EGRESS_')) return NOTICE_PREFIXES.egress;
  if (code.startsWith('AUDIT_')) return NOTICE_PREFIXES.audit;
  return NOTICE_PREFIXES.critical;
}

function discordTimeText(ms) {
  return Number.isSafeInteger(ms) && ms >= 0 ? `<t:${Math.floor(ms / 1_000)}:F>` : UNKNOWN_TEXT;
}

function idText(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value) ? value : UNKNOWN_TEXT;
}

function countText(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : UNKNOWN_TEXT;
}

// The characters that could close or open the bracket pair a security alert puts around the place's name, so a
// guild name cannot end the pair early and write the rest of the notice itself.
const ALERT_BRACKETS = /[【】〖〗]/gu;

// The place a security alert names, in the form the notice shows: the guild name cleaned like any guild name
// (mentions, links, markup, field separators), of the brackets, and then by the link rules. A direct message is
// "私訊"; a guild whose name is empty or does not survive the clean-up is "未知群組".
function securityAlertPlace(guildId, guildName, placeUnknown = false) {
  if (!(typeof guildId === 'string' && SNOWFLAKE.test(guildId))) {
    return placeUnknown ? SECURITY_ALERT_UNKNOWN_GUILD_NAME : SECURITY_ALERT_DM_NAME;
  }
  const cleaned = sanitizeGuildName(String(guildName || '').replace(ALERT_BRACKETS, ' '));
  const safe = cleaned ? withoutLinks(cleaned) : null;
  const final = safe ? sanitizeGuildName(safe.replace(ALERT_BRACKETS, ' ')) : '';
  return final || SECURITY_ALERT_UNKNOWN_GUILD_NAME;
}

// The fixed sentence of a security alert: 【place】小吉遭受攻擊(label) and, when events of the same guild and kind
// were held back since the last one, （過去一小時共 N 次） where N counts the one that opens the hour and the ones
// that were merged. Nothing a user wrote and no ID of a user is in it.
function buildSecurityAlertNotice({ suppressed = 0, guildId = null, guildName = '', notice = null, placeUnknown = false } = {}) {
  const kind = notice && typeof notice === 'object' ? notice.alertKind : null;
  if (typeof kind !== 'string' || !Object.hasOwn(SECURITY_ALERT_TEXT, kind) || !SECURITY_ALERT_KINDS.includes(kind)) {
    throw new TypeError('Unknown security alert kind.');
  }
  const count = Number.isSafeInteger(suppressed) && suppressed > 0 ? suppressed : 0;
  return `【${securityAlertPlace(guildId, guildName, placeUnknown)}】小吉遭受攻擊(${SECURITY_ALERT_TEXT[kind]})` +
    `${count ? `（過去一小時共 ${count + 1} 次）` : ''}`;
}

// The place part of the merge key of a security alert: the guild ID, "dm" for a direct message, "unknown" for a place
// that is not known (the producer says so). The last two never merge with each other or with a guild.
function securityAlertPlaceKey(event) {
  if (SNOWFLAKE.test(event.guildId || '')) return event.guildId;
  return event.placeUnknown === true ? 'unknown' : 'dm';
}

// The notice of an OWNER_EVENT_* event. Its fields are fixed and in a fixed order: the code, the guild ID
// (when the event has one), the IDs, the times, the counts, the merged count; a missing value is the
// fixed word for unknown. An ID is only digits (never a mention), and a time is a Discord timestamp
// built from a number. What a member chose (the guild name, the member's name and account name) comes
// last, each quoted, cleaned like a guild name and then by the link rules; a text that still changes
// after those passes loses its names, the last one first, as an audit notice loses its guild name.
function buildOwnerEventNotice(code, { suppressed = 0, guildId = null, guildName = '', notice = null, placeUnknown = false } = {}) {
  const facts = notice && typeof notice === 'object' ? notice : {};
  const safeGuildId = typeof guildId === 'string' && SNOWFLAKE.test(guildId) ? guildId : '';
  const suppressedCount = Number.isSafeInteger(suppressed) && suppressed > 0 ? suppressed : 0;
  if (code === SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT) {
    return buildSecurityAlertNotice({ suppressed, guildId, guildName, notice, placeUnknown });
  }
  const clean = (value) => (typeof value === 'string' ? sanitizeGuildName(value) : '');
  const fields = [];
  const names = [];
  if (code === SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT) {
    if (safeGuildId) fields.push(`伺服器 ID：${safeGuildId}`);
    fields.push(`成員 ID：${idText(facts.subjectId)}`, `退出時間：${discordTimeText(facts.leftAtMs)}`,
      `加入時間：${discordTimeText(facts.joinedAtMs)}`, `成員數：${countText(facts.memberCount)}`);
    names.push(['伺服器', clean(guildName)], ['成員名稱', clean(facts.subjectName)],
      ['成員帳號', clean(facts.subjectUsername)]);
  } else if (code === SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED) {
    if (safeGuildId) fields.push(`伺服器 ID：${safeGuildId}`);
    fields.push(`邀請者 ID：${idText(facts.inviterId)}`, `加入時間：${discordTimeText(facts.joinedAtMs)}`,
      `成員數：${countText(facts.memberCount)}`);
    names.push(['伺服器', clean(guildName)]);
  } else if (code === SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED) {
    const kindText = Object.hasOwn(OUTAGE_KIND_TEXT, facts.outageKind) ? OUTAGE_KIND_TEXT[facts.outageKind] : UNKNOWN_TEXT;
    fields.push(`停運開始：${discordTimeText(facts.outageStartedAtMs)}`,
      `恢復時間：${discordTimeText(facts.outageEndedAtMs)}`, `類型：${kindText}`);
  } else {
    throw new TypeError('Unknown owner event notification code.');
  }
  if (suppressedCount) fields.push(`另有 ${suppressedCount} 則同類事件已合併`);
  const present = names.filter(([, value]) => value);
  const compose = (kept) => [`${noticePrefix(code)}${code}`, ...fields,
    ...kept.map(([label, value]) => `${label}：「${value}」`)].join('；');
  for (let keep = present.length; keep > 0; keep -= 1) {
    const text = withoutLinks(compose(present.slice(0, keep)));
    if (text !== null) return text;
  }
  return withoutLinks(compose([])) ?? compose([]);
}

// An audit notice also names the guild ID, as the guild-join DM did before the catalogue: the Owner reviews
// the guild by it, and a guild name is neither unique nor always shown (see withoutLinks). The fixed fields
// come first and the guild name last, quoted, so whatever the name says cannot stand before the real ID.
function buildFixedNotice(code, { suppressed = 0, guildName = '', guildId = null, notice = null, placeUnknown = false } = {}) {
  if (!isSafetyEventCode(code)) throw new TypeError('Unknown owner safety notification code.');
  if (Object.hasOwn(EVENT_NOTICE_PREFIXES, code)) {
    return buildOwnerEventNotice(code, { suppressed, guildName, guildId, notice, placeUnknown });
  }
  const safeName = sanitizeGuildName(guildName);
  const safeGuildId = code.startsWith('AUDIT_') && typeof guildId === 'string' && SNOWFLAKE.test(guildId) ? guildId : '';
  const suppressedCount = Number.isSafeInteger(suppressed) && suppressed > 0 ? suppressed : 0;
  const compose = (name) => `${noticePrefix(code)}${code}` +
    `${safeGuildId ? `；伺服器 ID：${safeGuildId}` : ''}` +
    `${suppressedCount ? `；另有 ${suppressedCount} 則同類事件已合併` : ''}` +
    `${name ? `；伺服器：「${name}」` : ''}`;
  return withoutLinks(compose(safeName)) ?? compose('');
}

function buildNoticePayload(code, options = {}) {
  return Object.freeze({
    content: buildFixedNotice(code, options),
    allowed_mentions: Object.freeze({ parse: [], users: [], roles: [], replied_user: false }),
  });
}

// The binding carries the source event's snowflake time, so a notice for an event already
// covered by its source watermark (after retention) is answered terminal by the ledger.
// The Owner ledger has no cutover (0): no notice is ever too old for it by that rule.
function buildOperation(event, context, ownerId) {
  const snowflakeTime = snowflakeTimestamp(context?.sourceEventId);
  const eventTime = Number(event?.at);
  const backgroundTime = Number(context?.startedAtMs);
  const sourceTimeMs = snowflakeTime ?? (Number.isSafeInteger(eventTime) && eventTime >= 0 ? eventTime
    : Number.isSafeInteger(backgroundTime) && backgroundTime >= 0 ? backgroundTime : null);
  const sourceEventId = typeof context?.sourceEventId === 'string' ? context.sourceEventId : '';
  const actorId = SNOWFLAKE.test(context?.actorId || '') ? context.actorId : 'background';
  const background = typeof context?.hostPurpose === 'string' && context.hostPurpose.startsWith('background.');
  if (!isSafetyEventCode(event?.code) || !context || !SNOWFLAKE.test(ownerId) || !sourceEventId ||
      !context.hostPurpose || !context.scope || sourceTimeMs === null || (!background && actorId === 'background')) return null;
  const category = safetyEventCategory(event.code);
  // A security alert whose kind is not one of the catalogue's is not sent.
  if (event.code === SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT &&
      !SECURITY_ALERT_KINDS.includes(event.notice?.alertKind)) return null;
  // A category the notifier has no budget class for is not sent (never read as another category).
  if (!Object.hasOwn(CATEGORY_BUDGET_CLASSES, category)) return null;
  const budgetClass = CATEGORY_BUDGET_CLASSES[category];
  const target = `${ownerId}${Object.hasOwn(OWNER_BUDGET_TARGET_SUFFIXES, budgetClass)
    ? OWNER_BUDGET_TARGET_SUFFIXES[budgetClass] : ''}`;
  const payload = buildNoticePayload(event.code,
    { guildName: event.guildName, guildId: event.guildId, notice: event.notice, placeUnknown: event.placeUnknown === true });
  const sourceKey = `${context.hostPurpose}:${context.scope}:actor:${actorId}`;
  if (Object.hasOwn(EVENT_NOTICE_PREFIXES, event.code)) {
    // An OWNER_EVENT_* event is its own event, not a kind of safety event: its operation is its source
    // plus the guild, the member and the time it is about, and it merges only with a repeat of the same
    // fact (the same member leaving again, the same guild joined again, the same outage), never with
    // another member's or another guild's.
    const identity = ownerEventIdentity(event);
    return Object.freeze({
      operationId: `owner-event-v1:${sha256(stableJson({
        version: 1, sourceKey, sourceEventId, code: event.code, ...identity.seed,
      }))}`,
      sourceKey,
      sourceTimeMs,
      sourceEventId,
      hostPurpose: context.hostPurpose,
      scope: context.scope,
      action: OWNER_EVENT_ACTION,
      target,
      budgetClass,
      mergeKey: identity.mergeKey,
      payload,
    });
  }
  // An audit event names its guild. When its source event is not about that one guild (a background run
  // that leaves several guilds), the guild ID is part of the operation, so two guilds never share one.
  // When it is (a guild join), the seed stays as it was, so an operation an earlier version recorded
  // keeps its ID and a notice already sent is not sent again.
  const auditGuildId = event.code.startsWith('AUDIT_') && SNOWFLAKE.test(event.guildId || '') &&
    event.guildId !== context.guildId ? event.guildId : null;
  const operationSeed = stableJson({
    version: 1,
    sourceKey,
    sourceEventId,
    code: event.code,
    ...(auditGuildId ? { guildId: auditGuildId } : {}),
  });
  return Object.freeze({
    operationId: `owner-safety-v1:${sha256(operationSeed)}`,
    sourceKey,
    sourceTimeMs,
    sourceEventId,
    hostPurpose: context.hostPurpose,
    scope: context.scope,
    action: 'owner-safety-notification',
    target,
    budgetClass,
    mergeKey: `owner-safety-v2:${category}:${event.code}:${context.hostPurpose}:${context.scope}`,
    payload,
  });
}

// What an OWNER_EVENT_* event is about, as the part of its operation that its source does not give and
// the key it merges by. An ID or time the event does not have is the word `unknown`, so such events
// merge together (coarser, never finer) instead of each being its own.
function ownerEventIdentity(event) {
  const facts = event.notice && typeof event.notice === 'object' ? event.notice : {};
  const guildId = SNOWFLAKE.test(event.guildId || '') ? event.guildId : 'unknown';
  const time = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  if (event.code === SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT) {
    const memberId = typeof facts.subjectId === 'string' && SNOWFLAKE.test(facts.subjectId) ? facts.subjectId : 'unknown';
    return Object.freeze({
      seed: { guildId, subjectId: memberId, atMs: time(facts.leftAtMs) },
      mergeKey: `owner-leave-v1:${guildId}:${memberId}`,
    });
  }
  if (event.code === SAFETY_EVENT_CODES.OWNER_EVENT_GUILD_JOINED) {
    return Object.freeze({
      seed: { guildId, atMs: time(facts.joinedAtMs) },
      mergeKey: `owner-join-v1:${guildId}`,
    });
  }
  if (event.code === SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT) {
    // The same guild (or "dm" for a direct message) and the same kind merge; another guild or another kind
    // never does.
    const place = securityAlertPlaceKey(event);
    const kind = SECURITY_ALERT_KINDS.includes(facts.alertKind) ? facts.alertKind : null;
    if (!kind) throw new TypeError('Unknown security alert kind.');
    return Object.freeze({
      seed: { place, kind },
      mergeKey: `owner-security-v1:${place}:${kind}`,
    });
  }
  // Every code reaching here must be named above: a code that is not is an error, never read as the recovery.
  if (event.code !== SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED) {
    throw new TypeError('Unknown owner event code.');
  }
  const startedAtMs = time(facts.outageStartedAtMs);
  return Object.freeze({
    seed: { startedAtMs, endedAtMs: time(facts.outageEndedAtMs) },
    mergeKey: `owner-recovery-v1:${startedAtMs ?? 'unknown'}`,
  });
}

const LEDGER_ALERT_CATEGORIES = new Set(['startup', 'runtime']);
const MERGE_SCOPE = /^[A-Za-z0-9:._/-]{1,64}$/u;
const MAX_LEDGER_ALERT_LENGTH = 1_900;

// A ledger notice (ledgerAlerts.js builds its fixed text). Its source is one boot of the
// Owner ledger: the key names the bot, the time is the ledger clock when this notifier
// took the ledger (above any watermark retention could have left), and the operation ID
// hashes that boot, the category, and the notice's own key, so recomputing a notice in
// the same boot gives the same operation. A start's notice merges only within its own boot
// (its merge key carries the boot epoch): the notice of a restart within ten minutes is
// never swallowed by the previous start's. Notices of a purpose stopped while running
// merge across boots. The Owner ledger has no cutover.
function buildLedgerAlertOperation({ botId, ownerId, bootEpoch, sourceTimeMs, category, key, mergeScope, content }) {
  if (!SNOWFLAKE.test(String(botId || '')) || !SNOWFLAKE.test(String(ownerId || '')) || botId === ownerId ||
      !Number.isSafeInteger(bootEpoch) || bootEpoch < 0 || !Number.isSafeInteger(sourceTimeMs) || sourceTimeMs < 0 ||
      !LEDGER_ALERT_CATEGORIES.has(category) || typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key) ||
      typeof mergeScope !== 'string' || !MERGE_SCOPE.test(mergeScope) ||
      typeof content !== 'string' || !content || content.length > MAX_LEDGER_ALERT_LENGTH) return null;
  const operationSeed = stableJson({ version: 1, botId, ownerId, bootEpoch, category, key });
  return Object.freeze({
    operationId: `owner-ledger-alert-v1:${sha256(operationSeed)}`,
    sourceKey: `ledger-alert:bot:${botId}`,
    sourceTimeMs,
    sourceEventId: `boot:${bootEpoch}`,
    hostPurpose: 'safety.ledger-alert',
    scope: `bot:${botId}`,
    action: 'owner-ledger-alert',
    target: ownerId,
    budgetClass: 'owner-notice',
    mergeKey: `owner-ledger-alert-v1:${category}:${mergeScope}${category === 'startup' ? `:boot-${bootEpoch}` : ''}`,
    payload: Object.freeze({
      content,
      allowed_mentions: Object.freeze({ parse: [], users: [], roles: [], replied_user: false }),
    }),
  });
}

function buildPreparationOperation(botId, ownerId) {
  if (!SNOWFLAKE.test(botId) || !SNOWFLAKE.test(ownerId) || botId === ownerId) return null;
  const identity = { schemaVersion: 1, botId, ownerId };
  const identityDigest = sha256(stableJson(identity));
  return Object.freeze({
    operationId: `owner-dm-channel-v1:${identityDigest}`,
    sourceKey: `discord.owner-safety:bot:${botId}:owner:${ownerId}`,
    sourceEventId: botId,
    hostPurpose: 'discord.owner-safety',
    scope: `bot:${botId}:owner:${ownerId}`,
    action: DM_PREPARATION_ACTION,
    target: ownerId,
    budgetClass: 'none',
    mergeKey: `owner-dm-channel-v1:${identityDigest}`,
    payload: identity,
  });
}

function buildChannelBinding(operation, dmEvidence, botId, ownerId) {
  const base = {
    schemaVersion: 1,
    channelId: dmEvidence.channelId,
    channelType: dmEvidence.channelType,
    recipientId: dmEvidence.recipientId,
    recipientCount: dmEvidence.recipientCount,
    ownerId,
    botId,
    prepareOperationId: operation.operationId,
    prepareBindingDigest: operation.bindingDigest,
  };
  return Object.freeze({ ...base, bindingProof: sha256(stableJson(base)) });
}

function validateChannelBinding(result, operation, botId, ownerId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const expectedKeys = [
    'bindingProof', 'botId', 'channelId', 'ownerId',
    'prepareBindingDigest', 'prepareOperationId', 'recipientCount',
    'recipientId', 'schemaVersion', 'channelType',
  ];
  if (Object.keys(result).sort().join(',') !== expectedKeys.sort().join(',')) return null;
  if (result.schemaVersion !== 1 || !SNOWFLAKE.test(result.channelId || '') ||
      result.channelId === botId || result.channelId === ownerId || result.botId !== botId ||
      result.ownerId !== ownerId || result.channelType !== DM_CHANNEL_TYPE ||
      result.recipientId !== ownerId || result.recipientCount !== 1 ||
      result.prepareOperationId !== operation?.operationId ||
      result.prepareBindingDigest !== operation?.bindingDigest) return null;
  const expected = buildChannelBinding(operation, {
    channelId: result.channelId,
    channelType: result.channelType,
    recipientId: result.recipientId,
    recipientCount: result.recipientCount,
  }, botId, ownerId);
  return result.bindingProof === expected.bindingProof ? result.channelId : null;
}

function validateCreatedDm(response, ownerId) {
  if (!response || response.type !== DM_CHANNEL_TYPE || !SNOWFLAKE.test(response.id || '') ||
      response.id === ownerId || !Array.isArray(response.recipients) || response.recipients.length !== 1 ||
      response.recipients[0]?.id !== ownerId) return null;
  return Object.freeze({
    channelId: response.id,
    channelType: response.type,
    recipientId: response.recipients[0].id,
    recipientCount: response.recipients.length,
  });
}

class OwnerSafetyNotifier {
  #escalations = createLedgerEscalations();

  // The Owner ledger comes only from the bootstrap (ledgerBootstrap.js), through
  // preflight(); this notifier never opens one. onPurposeDisabled('owner-safety', code), if
  // given, hears a delivered ledger preflight refused, or the notifier stop while running
  // (ledgerAlerts.js), once. ownerDmGate, if given, is the Owner DM start guard
  // (ownerDmStartGuard.js): while its allowsOwnerDm() is not true, every notice is dropped.
  constructor({ client, ownerId, botId, logger, env = process.env, now = () => Date.now(),
    getContext = getHostOperationContext,
    installHandler = setConversationSafetyEventHandler, dispatchTimeoutMs = DISPATCH_TIMEOUT_MS,
    installSafetyHandler = setSafetyEventHandler, protectedRestFactory = installProtectedRest, onPurposeDisabled = null,
    ownerDmGate = null } = {}) {
    this.client = client;
    this.ownerDmGate = ownerDmGate && typeof ownerDmGate.allowsOwnerDm === 'function' ? ownerDmGate : null;
    // The third failed DM preparation is logged once per process, and so is a preparation that
    // reached Discord and ended rejected or unknown (it blocks every notice, across restarts).
    this.preparationStopLogged = false;
    this.preparationBlockedLogged = false;
    // Notices the start guard held back (operation ID), and their log throttle per kind.
    this.startGuardDropped = new Map();
    this.startGuardLog = new Map();
    // The log throttle of events over their category's budget, per category.
    this.budgetLog = new Map();
    this.ownerId = String(ownerId || '').trim();
    this.botId = String(botId || '').trim();
    this.logger = logger;
    this.now = now;
    this.onPurposeDisabled = typeof onPurposeDisabled === 'function' ? onPurposeDisabled : null;
    this.getContext = getContext;
    this.installHandler = installHandler;
    this.installSafetyHandler = installSafetyHandler;
    this.dispatchTimeoutMs = dispatchTimeoutMs;
    this.protectedRestFactory = protectedRestFactory;
    this.protectedRest = null;
    this.queue = [];
    this.ledger = null;
    // The boot of the Owner ledger that ledger notices are bound to (see
    // buildLedgerAlertOperation): its boot epoch and its clock when it was taken.
    this.ledgerBoot = null;
    this.restoreHandler = null;
    this.restoreSafetyHandler = null;
    this.intakeAttempts = new Map();
    this.suppressedByCategory = new Map();
    this.nextIntakeId = 0;
    this.drainPromise = null;
    this.accepting = false;
    this.disabled = true;
    // Notices accepted before arm() (index.js, at ClientReady, after the bot identity check)
    // wait in memory; nothing is prepared or sent until then.
    this.armed = false;
    // The kill switch: no ledger is taken, read, or written in this process.
    this.protectedEffectsEnabled = resolveProtectedEffects(env).enabled;
  }

  // Codes only: a cause adds its fixed ledger code, never a message, path, or ID.
  log(code, cause = undefined) {
    const detail = cause === undefined ? '' : ` ${formatLedgerFailure(cause)}`;
    this.logger?.warn?.(`[OWNER_SAFETY] code=${code}${detail}`);
  }

  // Stops notices for the rest of this process; a notifier that was running tells
  // onPurposeDisabled once.
  #disable(code, cause = undefined) {
    const wasEnabled = !this.disabled && Boolean(this.ledger);
    this.disabled = true;
    this.log(code, cause);
    if (wasEnabled && this.accepting && this.onPurposeDisabled) {
      try {
        Promise.resolve(this.onPurposeDisabled(OWNER_PURPOSE_ID, code)).catch(() => {});
      } catch {}
    }
  }

  // Usable while accepting and the ledger is open and still trusted. A ledger that failed
  // (in the facade or its store) or was quarantined disables notices for the rest of this
  // process.
  #usable() {
    if (!this.protectedEffectsEnabled || !this.accepting || this.disabled || !this.ledger) return false;
    if (this.ledger.closed || this.ledger.failed || this.ledger.quarantined) {
      this.#disable(this.ledger.quarantined ? 'OWNER_SAFETY_LEDGER_QUARANTINED' : 'OWNER_SAFETY_LEDGER_FAILED');
      return false;
    }
    return true;
  }

  // Ready to send: usable and armed.
  isReady() {
    return this.armed && this.#usable();
  }

  // Lets queued and later notices be sent (index.js, at ClientReady, after the bot
  // identity check). Never after quiesce() or stop().
  arm() {
    if (!this.accepting) return;
    this.armed = true;
    if (this.queue.length) this.kickDrain();
  }

  // The logged-in bot is not the one the Owner ledger was opened for: notices stay off for
  // this process, and those queued before the check end without being sent. Reported by
  // ledgerAlerts.js, not through onPurposeDisabled.
  disableAll(code = 'OWNER_SAFETY_DISABLED') {
    if (!this.disabled) this.log(code);
    this.disabled = true;
    this.#finalizeQueued('disabled_before_dispatch');
  }

  #finalizeQueued(resultCode) {
    const queued = this.queue.splice(0);
    if (!this.ledger) return;
    for (const task of queued) {
      this.#releaseIntake(task.intake);
      try {
        this.ledger.finalizeUnattempted(task.binding, resultCode);
      } catch (error) {
        this.log('OWNER_SAFETY_SHUTDOWN_FINALIZE_FAILED', error);
        break;
      }
    }
  }

  // Ledger escalations recorded in this process, by code only (see ledgerEscalation.js).
  getLedgerEscalations() {
    return this.#escalations.list();
  }

  install() {
    if (this.restoreHandler || this.restoreSafetyHandler) throw new Error('Owner safety hook is already installed.');
    this.accepting = true;
    this.restoreHandler = this.installHandler((event) => this.accept(event));
    this.restoreSafetyHandler = this.installSafetyHandler((event) => this.accept(event));
  }

  // Tells onPurposeDisabled about a delivered Owner ledger preflight refused: the bootstrap
  // reported it ready, so without this the alerts would neither send the start's notice
  // nor know that only an emergency DM can reach the Owner.
  #refused(code) {
    if (!this.onPurposeDisabled) return;
    try {
      Promise.resolve(this.onPurposeDisabled(OWNER_PURPOSE_ID, code)).catch(() => {});
    } catch {}
  }

  // Takes the Owner ledger from `ledgers`, the map of open facades the bootstrap
  // delivered. Without one the notifier stays off; a ledger that does not fit (another
  // purpose, bot, or Owner, or already failed) is refused, told to onPurposeDisabled, and
  // left to the bootstrap to close.
  preflight({ reservedDescriptors = [], ledgers = null } = {}) {
    if (!this.restoreHandler) this.install();
    if (!this.protectedEffectsEnabled) {
      this.disabled = true;
      this.log('OWNER_SAFETY_PROTECTED_EFFECTS_OFF');
      return Object.freeze({ enabled: false, code: 'OWNER_SAFETY_PROTECTED_EFFECTS_OFF' });
    }
    const ledger = ledgers instanceof Map ? ledgers.get(OWNER_PURPOSE_ID) : null;
    if (!ledger || !SNOWFLAKE.test(this.ownerId) || !SNOWFLAKE.test(this.botId) ||
        this.ownerId === this.botId || !this.#installProtectedRest()) {
      this.disabled = true;
      this.log('OWNER_SAFETY_DISABLED');
      if (ledger) this.#refused('OWNER_SAFETY_DISABLED');
      return Object.freeze({ enabled: false, code: 'OWNER_SAFETY_DISABLED' });
    }
    try {
      const identity = ledger.provenance?.notificationIdentity;
      if (ledger.purposeId !== OWNER_PURPOSE_ID || ledger.closed || ledger.failed || ledger.quarantined ||
          identity?.botId !== this.botId || identity?.ownerId !== this.ownerId) {
        throw Object.assign(new Error('Owner ledger does not fit this notifier.'), { code: 'OWNER_SAFETY_LEDGER_UNUSABLE' });
      }
      assertDistinctDataPaths([
        ...reservedDescriptors,
        { filePath: ledger.locations.ledgerPath },
        { filePath: ledger.locations.anchorPath },
        { filePath: ledger.locations.receiptPath },
      ]);
      const preparationBinding = buildPreparationOperation(this.botId, this.ownerId);
      const preparation = ledger.getOperation(preparationBinding.operationId);
      if (preparation?.status === 'confirmed') {
        const verified = ledger.verifyBinding(preparationBinding);
        if (!validateChannelBinding(verified.result, verified, this.botId, this.ownerId)) {
          throw Object.assign(new Error('Durable Owner DM binding proof is invalid.'), { code: 'OWNER_DM_BINDING_INVALID' });
        }
      }
      // A preparation that reached Discord and ended rejected or unknown is never tried again (a
      // durable outcome is final), so no notice of this ledger can be sent. The notifier stays on,
      // as before; this start says so once, and safety-ledger status reports it.
      if (preparation?.durable && (preparation.status === 'unknown' || preparation.status === 'rejected')) {
        this.#notePreparationBlocked(preparation.status);
      }
      const ledgerBoot = Object.freeze({ bootEpoch: ledger.identityCounters.bootEpoch, sourceTimeMs: ledger.observedNow() });
      this.ledger = ledger;
      this.ledgerBoot = ledgerBoot;
      this.disabled = false;
      return Object.freeze({ enabled: true, code: 'OWNER_SAFETY_READY' });
    } catch (error) {
      this.disabled = true;
      // The mapped ledger code (for example SIDE_EFFECT_FORMAT_OUTDATED) names the operations guide step.
      this.log('OWNER_SAFETY_LEDGER_UNAVAILABLE', error);
      this.#escalations.openFailed(OWNER_PURPOSE_ID, error);
      // Unlike another purpose's refusal, this one is escalated (exit code 3): every other
      // notice goes through this ledger, so once it is refused only the emergency DM, at most
      // one per 6 hours, can reach the Owner. Every cause here is about the Owner ledger
      // itself (failed, quarantined, bound elsewhere, sharing a path with other data, or a
      // stored DM binding that does not verify), the same kind of finding that fails a
      // purpose closed at the bootstrap.
      this.#escalations.record(OWNER_PURPOSE_ID, 'OWNER_SAFETY_LEDGER_UNAVAILABLE', 'open');
      this.#refused('OWNER_SAFETY_LEDGER_UNAVAILABLE');
      return Object.freeze({ enabled: false, code: 'OWNER_SAFETY_LEDGER_UNAVAILABLE' });
    }
  }

  // An event the catalogue does not send to the Owner (notifiesOwner) is left here, before any intake,
  // ledger call, or budget.
  accept(rawEvent) {
    if (!notifiesOwner(rawEvent?.code)) return false;
    if (!this.#usable()) return false;
    const context = this.getContext();
    if (this.#heldBySecurityWindow(rawEvent, context)) return false;
    const event = this.#withGuildName(rawEvent);
    const initialBinding = buildOperation(event, context, this.ownerId);
    if (!initialBinding) {
      this.log('OWNER_SAFETY_SOURCE_UNAVAILABLE');
      return false;
    }
    const category = safetyEventCategory(event.code);
    if (this.startGuardDropped.has(initialBinding.operationId)) return false;
    // Before the intake: a notice held back takes nothing from the notice budget or the merge
    // windows, so the first notices after the DMs resume go out as usual.
    if (this.#heldByStartGuard()) return this.#dropForStartGuard(initialBinding, 'safety-event', category);
    const intake = this.#admitIntake(initialBinding, category);
    if (!intake.allowed) return false;
    const binding = intake.suppressed > 0 ? Object.freeze({
      ...initialBinding,
      payload: buildNoticePayload(event.code, { guildName: event.guildName, guildId: event.guildId, notice: event.notice,
        suppressed: intake.suppressed, placeUnknown: event.placeUnknown === true }),
    }) : initialBinding;
    return this.#enqueue(binding, intake.intake);
  }

  // A security alert that names no guild name gets the one the client holds for its guild ID, if any.
  #withGuildName(event) {
    if (event.code !== SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT || event.guildName ||
        !SNOWFLAKE.test(event.guildId || '')) return event;
    let name = '';
    try {
      const found = this.client?.guilds?.cache?.get?.(event.guildId)?.name;
      name = typeof found === 'string' ? sanitizeGuildName(found) : '';
    } catch {
      name = '';
    }
    return name ? Object.freeze({ ...event, guildName: name }) : event;
  }

  // The flood fast path: an attack raises its alert again and again. When the same guild and kind was already
  // let in within the hour, the event is only counted and nothing else is built (no notice text, no operation,
  // no ledger call). Held back by the start guard, or without a host context, it is not counted here: those
  // take the normal path, which drops them as before.
  #heldBySecurityWindow(event, context) {
    if (event?.code !== SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT || !context) return false;
    const kind = event.notice?.alertKind;
    if (!SECURITY_ALERT_KINDS.includes(kind) || this.#heldByStartGuard()) return false;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return false;
    const place = securityAlertPlaceKey(event);
    const mergeKey = `owner-security-v1:${place}:${kind}`;
    const attempts = this.intakeAttempts.get(`security-alert:${mergeKey}`);
    if (!attempts?.some((entry) => now < entry.at + mergeWindowMs('security-alert'))) return false;
    this.#countSuppressed(`security-alert:${mergeKey}`, 1, now);
    return true;
  }

  // The Owner DM start guard holds every Owner DM of this start back. A gate that fails holds
  // them back too.
  #heldByStartGuard() {
    if (!this.ownerDmGate) return false;
    try {
      return this.ownerDmGate.allowsOwnerDm() !== true;
    } catch {
      return true;
    }
  }

  // A notice the start guard held back ends here as "not sent", in this notifier's memory only:
  // it is never queued, prepared, or sent later in this process (the guard lets DMs through again
  // once the start succeeds), and the ledger is not called at all. A decision recorded there would
  // open a 10-minute merge window that would swallow the first notice of its kind after the DMs
  // resume. The log line is held to one a minute per kind, with the number of lines left out.
  #dropForStartGuard(binding, kind, category = null) {
    this.startGuardDropped.delete(binding.operationId);
    this.startGuardDropped.set(binding.operationId, true);
    if (this.startGuardDropped.size > MAX_START_GUARD_DROPPED) {
      this.startGuardDropped.delete(this.startGuardDropped.keys().next().value);
    }
    const key = category ? `${kind}:${category}` : kind;
    const now = this.now();
    const last = this.startGuardLog.get(key);
    if (last && Number.isSafeInteger(now) && now >= last.at && now < last.at + START_GUARD_LOG_INTERVAL_MS) {
      last.skipped += 1;
      return false;
    }
    this.startGuardLog.set(key, { at: now, skipped: 0 });
    this.logger?.warn?.(`[OWNER_SAFETY] code=OWNER_DM_GUARD_BLOCKED kind=${kind}` +
      `${category ? ` category=${category}` : ''} skipped=${last?.skipped || 0}`);
    return false;
  }

  // A DM preparation that reached Discord and ended rejected or unknown: said once per process.
  #notePreparationBlocked(state) {
    if (this.preparationBlockedLogged) return;
    this.preparationBlockedLogged = true;
    this.logger?.warn?.(`[OWNER_SAFETY] code=OWNER_SAFETY_DM_PREPARATION_BLOCKED state=${state}`);
  }

  // Memory-only intake gate.  It runs before queueing, claims, DM preparation, or any
  // ledger call; suppressed floods therefore become an integer carried by the next
  // allowed notification instead of hundreds of durable rows.
  #admitIntake(binding, category) {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return Object.freeze({ allowed: false, suppressed: 0, intake: null });
    // A category without an entry of its own is refused, not given another category's numbers
    // (buildOperation already turns such an event away; this is the second gate).
    if (!Object.hasOwn(CATEGORY_BUDGETS, category)) {
      return Object.freeze({ allowed: false, suppressed: 0, intake: null });
    }
    const budget = CATEGORY_BUDGETS[category];
    // Each key is `<category>:<merge key>`, and no category name has a colon in it.
    for (const [key, attempts] of this.intakeAttempts) {
      const keepFor = intakeRetentionMs(key.slice(0, key.indexOf(':')));
      const kept = attempts.filter((entry) => entry.at > now - keepFor);
      if (kept.length) this.intakeAttempts.set(key, kept); else this.intakeAttempts.delete(key);
    }
    for (const [key, entry] of this.suppressedByCategory) {
      if (entry.lastAt + (24 * 60 * 60_000) <= now) this.suppressedByCategory.delete(key);
    }
    const key = `${category}:${binding.mergeKey}`;
    const attempts = this.intakeAttempts.get(key) || [];
    const merged = attempts.some((entry) => now < entry.at + mergeWindowMs(category));
    const countKey = this.#suppressionKey(category, binding);
    const categoryAttempts = [...this.intakeAttempts.entries()]
      .filter(([candidate]) => candidate.startsWith(`${category}:`))
      .flatMap(([, entries]) => entries);
    const withinBudget = budget.every(({ windowMs, maximum }) =>
      categoryAttempts.filter((entry) => entry.at > now - windowMs).length < maximum);
    if (merged || !withinBudget) {
      this.#countSuppressed(countKey, 1, now);
      // A repeat of what was just reported is not news; one over the category's budget is, once a minute.
      if (!merged) this.#logBudgetExceeded(category, now);
      return Object.freeze({ allowed: false, suppressed: 0, intake: null });
    }
    // The count taken here is written into this notice; `carried` keeps it, so that a notice the ledger's
    // budget then refuses (process) can put it back.
    const suppressed = this.suppressedByCategory.get(countKey)?.count || 0;
    this.suppressedByCategory.delete(countKey);
    const intake = Object.freeze({ key, id: `intake-${++this.nextIntakeId}`, category, countKey, carried: suppressed });
    attempts.push(Object.freeze({ at: now, id: intake.id }));
    this.intakeAttempts.set(key, attempts);
    if (this.intakeAttempts.size > MAX_INTAKE_KEYS) {
      const oldest = this.intakeAttempts.keys().next().value;
      if (oldest) this.intakeAttempts.delete(oldest);
    }
    return Object.freeze({ allowed: true, suppressed, intake });
  }

  // The key the number of held-back events is kept under: the category for the safety events and the other
  // OWNER_EVENT_* events, and for a security alert the guild and the kind as well, so that "過去一小時共 N 次" counts
  // the events of that one guild and kind and another's attack is never counted into it.
  #suppressionKey(category, binding) {
    return category === 'security-alert' ? `${category}:${binding.mergeKey}` : category;
  }

  #countSuppressed(countKey, amount, now) {
    const previous = this.suppressedByCategory.get(countKey);
    this.suppressedByCategory.delete(countKey);
    this.suppressedByCategory.set(countKey, Object.freeze({ count: (previous?.count || 0) + amount, lastAt: now }));
    while (this.suppressedByCategory.size > MAX_SUPPRESSED_KEYS) {
      this.suppressedByCategory.delete(this.suppressedByCategory.keys().next().value);
    }
  }

  // A notice the process's memory let in and the ledger's budget then refused (claim answered
  // suppressed_budget): after a restart the memory knows nothing of the day's earlier notices, so only the
  // ledger can refuse. The notice is never sent and not tried again, so it is counted for the next notice of
  // its category like one the memory gate refused: itself, and what had been merged into its text. Those
  // were counted once, at the memory gate, and taken out when this text was written, so they are put back
  // here and not counted twice. The refusal is logged like the memory gate's. The count lives in memory:
  // a restart starts it from zero. A notice with no category (a ledger notice) has nothing to carry it.
  #noteLedgerBudgetRefusal(intake) {
    const category = intake?.category;
    if (!category) return;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return;
    this.#countSuppressed(intake.countKey ?? category,
      (Number.isSafeInteger(intake.carried) ? intake.carried : 0) + 1, now);
    this.#logBudgetExceeded(category, now);
  }

  // A security alert the ledger's merge window held back (the same guild and kind was sent within the hour,
  // possibly before a restart, which the memory gate cannot know): never sent, so it is counted for the next
  // alert of that guild and kind, with what had been merged into its text.
  #noteLedgerMerge(intake) {
    if (intake?.category !== 'security-alert') return;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return;
    this.#countSuppressed(intake.countKey ?? intake.category,
      (Number.isSafeInteger(intake.carried) ? intake.carried : 0) + 1, now);
  }

  // An event the in-memory budget of its category refused: the count is carried by the next notice of
  // the category (suppressedByCategory); this line says so, at most once a minute per category, with the
  // number of events left out since the last line. Codes only, never what the event carried.
  #logBudgetExceeded(category, now) {
    const last = this.budgetLog.get(category);
    if (last && now >= last.at && now < last.at + BUDGET_LOG_INTERVAL_MS) {
      last.skipped += 1;
      return;
    }
    this.budgetLog.set(category, { at: now, skipped: 0 });
    this.logger?.warn?.(`[OWNER_SAFETY] code=OWNER_NOTICE_BUDGET_EXCEEDED category=${category} ` +
      `skipped=${last?.skipped || 0}`);
  }

  // Takes an admitted notice back out of the memory gate. A notice that was never sent (restoreCarried) also gives back
  // the held-back count that was taken out of memory to be written into its text, so the next notice of its category
  // (of its guild and kind, for a security alert) still says how many events it stands for.
  #releaseIntake(intake, { restoreCarried = false } = {}) {
    if (restoreCarried && intake && Number.isSafeInteger(intake.carried) && intake.carried > 0) {
      const now = this.now();
      if (Number.isSafeInteger(now) && now >= 0) this.#countSuppressed(intake.countKey ?? intake.category, intake.carried, now);
    }
    if (!intake?.key || !intake?.id) return;
    const attempts = this.intakeAttempts.get(intake.key);
    if (!attempts) return;
    const kept = attempts.filter((entry) => entry.id !== intake.id);
    if (kept.length) this.intakeAttempts.set(intake.key, kept); else this.intakeAttempts.delete(intake.key);
  }

  // A fixed ledger notice from ledgerAlerts.js ({ category, key, mergeScope, content }),
  // sent like an AI safety notice: the same budget, the same 10-minute merge by mergeKey,
  // the same DM channel. Returns whether it was queued.
  notifyLedgerEvent(notice = {}) {
    if (!this.#usable() || !this.ledgerBoot) return false;
    const binding = buildLedgerAlertOperation({ botId: this.botId, ownerId: this.ownerId, ...this.ledgerBoot,
      category: notice.category, key: notice.key, mergeScope: notice.mergeScope, content: notice.content });
    if (!binding) {
      this.log('OWNER_SAFETY_LEDGER_ALERT_INVALID');
      return false;
    }
    if (this.startGuardDropped.has(binding.operationId)) return false;
    if (this.#heldByStartGuard()) return this.#dropForStartGuard(binding, 'ledger-notice');
    return this.#enqueue(binding);
  }

  #enqueue(binding, intake = null) {
    const reject = () => {
      this.#releaseIntake(intake, { restoreCarried: true });
      return false;
    };
    try {
      const preparationBinding = buildPreparationOperation(this.botId, this.ownerId);
      const preparation = preparationBinding
        ? this.ledger.getOperation(preparationBinding.operationId) : null;
      if (preparation) {
        const verified = this.ledger.verifyBinding(preparationBinding);
        const observedNow = this.ledger.observedNow();
        const recoverableClaim = verified.status === 'claimed' && verified.leaseUntilMs <= observedNow;
        // A preparation that never reached Discord was released in memory: it is prepared
        // again once its retry wait has passed.
        const releasedPreparation = verified.status === 'prepare_failed' &&
          !(Number.isSafeInteger(verified.retryNotBeforeMs) && observedNow < verified.retryNotBeforeMs);
        const confirmedBinding = verified.status === 'confirmed' &&
          validateChannelBinding(verified.result, verified, this.botId, this.ownerId);
        if (!recoverableClaim && !releasedPreparation && !confirmedBinding) {
          if (verified.durable && (verified.status === 'unknown' || verified.status === 'rejected')) {
            this.#notePreparationBlocked(verified.status);
          }
          return reject();
        }
      }
      if (!this.armed && this.queue.length >= PRE_ARM_QUEUE_LIMIT) {
        this.log('OWNER_SAFETY_PRE_ARM_QUEUE_FULL');
        return reject();
      }
      if (this.queue.length >= QUEUE_LIMIT) {
        this.log('OWNER_SAFETY_QUEUE_FULL');
        return reject();
      }
      const existing = this.ledger.getOperation(binding.operationId);
      if (existing) {
        let verified;
        try {
          verified = this.ledger.verifyBinding(binding);
        } catch (error) {
          // The operation was recorded with other content (an earlier start or version worded it
          // differently, or its source raised it again with another merged count): the ledger refused
          // this one notice without failing, so only it is dropped. Any other error stops the notifier.
          if (error?.code !== 'SIDE_EFFECT_BINDING_CONFLICT') throw error;
          this.log('OWNER_SAFETY_NOTICE_CONFLICT');
          return reject();
        }
        const observedNow = this.ledger.observedNow();
        if (verified.status !== 'claimed' || verified.leaseUntilMs > observedNow) return reject();
      }
      if (this.queue.some((task) => task.binding?.operationId === binding.operationId)) return reject();
      this.queue.push(Object.freeze({ binding, intake }));
      if (this.armed) this.kickDrain();
      return true;
    } catch (error) {
      this.#releaseIntake(intake);
      this.#disable('OWNER_SAFETY_LEDGER_FAILED', error);
      return false;
    }
  }

  kickDrain() {
    if (this.drainPromise) return;
    this.drainPromise = Promise.resolve()
      .then(() => this.drain())
      .catch((error) => this.log('OWNER_SAFETY_WORKER_FAILED', error))
      .finally(() => {
        this.drainPromise = null;
        if (this.accepting && this.armed && this.queue.length) this.kickDrain();
      });
  }

  async drain() {
    while (this.accepting && this.armed && this.queue.length) {
      const task = this.queue.shift();
      await this.process(task);
    }
  }

  // The protected channel of client.rest (protectedRest.js); false when this REST cannot
  // carry it. Installed before the ledger checks, so such a REST turns the notifier off
  // (OWNER_SAFETY_DISABLED) and is never escalated as a fault of the Owner ledger.
  #installProtectedRest() {
    try {
      this.protectedRest = this.protectedRestFactory(this.client?.rest);
      return true;
    } catch {
      return false;
    }
  }

  // Sends one request through the protected channel, once, with the dispatch timeout as
  // its deadline. beginAttempt, the ledger begin, runs at the network entry, in the same
  // synchronous step as the send, so a row exists exactly when the request reached Discord.
  sendProtected(request, beginAttempt) {
    return this.protectedRest.send(request, {
      deadlineMs: this.dispatchTimeoutMs, label: PROTECTED_LABEL, onNetworkEntry: beginAttempt,
    });
  }

  // Records what Discord answered to an attempt that reached it and was not confirmed:
  // rejected (a 4xx, never sent again) or unknown (it may have taken effect).
  finishSent(operationId, generation, sent, prefix) {
    try {
      this.ledger.finish(operationId, generation, sent.kind === 'rejected' ? 'rejected' : 'unknown',
        outcomeCode(prefix, sent), outcomeResult(sent));
    } catch (error) {
      this.#disable('OWNER_SAFETY_FINAL_PERSIST_FAILED', error);
    }
  }

  finishUnknown(operationId, generation, kind, prefix) {
    const resultCode = kind === 'timeout' ? `${prefix}_timeout` : `${prefix}_unknown`;
    try {
      this.ledger.finish(operationId, generation, 'unknown', resultCode);
    } catch (error) {
      this.#disable('OWNER_SAFETY_FINAL_PERSIST_FAILED', error);
    }
  }

  async ensureDeliveryChannel() {
    const binding = buildPreparationOperation(this.botId, this.ownerId);
    if (!binding) throw new Error('Fixed notification identity is invalid.');
    const existing = this.ledger.getOperation(binding.operationId);
    if (existing) {
      const replay = this.ledger.claim(binding);
      if (replay.operation.status === 'confirmed') {
        const channelId = validateChannelBinding(replay.operation.result, replay.operation, this.botId, this.ownerId);
        if (!channelId) throw new Error('Durable Owner DM binding is unavailable.');
        return channelId;
      }
      if (replay.kind !== 'claimed') throw new Error('Owner DM preparation is not safely recoverable.');
      const renewed = this.ledger.renew(binding.operationId, replay.operation.generation);
      return this.prepareDeliveryChannel(binding, renewed);
    }

    const claimed = this.ledger.claim(binding);
    if (claimed.kind !== 'claimed') throw new Error('Owner DM preparation was not claimed.');
    const renewed = this.ledger.renew(binding.operationId, claimed.operation.generation);
    return this.prepareDeliveryChannel(binding, renewed);
  }

  async prepareDeliveryChannel(binding, renewed) {
    let attempted = null;
    // At the network entry: a notifier that stopped or was disabled meanwhile prepares nothing.
    const sent = await this.sendProtected({ method: 'POST', fullRoute: Routes.userChannels(), body: { recipient_id: this.ownerId } },
      () => {
        if (!this.isReady()) throw Object.assign(new Error('OWNER_SAFETY_NOT_READY'), { unavailable: true });
        attempted = this.ledger.beginDispatch(binding, renewed.generation);
      });
    if (!attempted) {
      // Never sent, nothing written: the preparation is released, so a later notice prepares
      // again after the retry wait (a rate limit's own wait, not counted; a notifier that is
      // no longer ready is not a failed preparation either). A ledger that failed at the
      // begin is left to process(), as before.
      if (!this.ledger.failed) {
        try {
          if (Number.isSafeInteger(sent.retryAfterMs)) {
            this.ledger.releasePreparation(binding.operationId, renewed.generation, 'rate_limited',
              { counted: false, retryNotBeforeMs: this.ledger.observedNow() + sent.retryAfterMs });
          } else if (sent.reason === 'entry_failed' && sent.entryError?.unavailable === true) {
            this.ledger.releasePreparation(binding.operationId, renewed.generation, 'not_ready', { counted: false });
          } else {
            const failures = Number(this.ledger.getOperation(binding.operationId)?.prepareFailures || 0);
            const retryAfterMs = DM_PREPARATION_RETRY_MS[Math.min(failures, DM_PREPARATION_RETRY_MS.length - 1)];
            const released = this.ledger.releasePreparation(binding.operationId, renewed.generation, 'prepare_failed', {
              maxFailures: MAX_DM_PREPARATION_FAILURES,
              retryNotBeforeMs: this.ledger.observedNow() + retryAfterMs,
            });
            // Settled: no DM is prepared or sent again until the next start. Said once, since
            // every later notice is dropped without a line of its own.
            if (released?.status === 'final' && !this.preparationStopLogged) {
              this.preparationStopLogged = true;
              this.logger?.warn?.('[OWNER_SAFETY] code=OWNER_SAFETY_DM_PREPARATION_STOPPED ' +
                `failures=${Number(released.prepareFailures) || MAX_DM_PREPARATION_FAILURES}`);
            }
          }
        } catch (error) {
          this.#disable('OWNER_SAFETY_FINAL_PERSIST_FAILED', error);
        }
      }
      throw new Error('Owner DM preparation was not sent.');
    }
    if (sent.kind !== 'confirmed') {
      this.finishSent(binding.operationId, attempted.generation, sent, 'dm_prepare');
      // Recorded (a ledger that failed to record it has stopped the notifier instead).
      if (!this.disabled) this.#notePreparationBlocked(sent.kind === 'rejected' ? 'rejected' : 'unknown');
      throw new Error('Owner DM preparation outcome is uncertain.');
    }
    const dmEvidence = validateCreatedDm(sent.value, this.ownerId);
    if (!dmEvidence) {
      this.finishUnknown(binding.operationId, attempted.generation, 'unknown', 'dm_binding_invalid');
      if (!this.disabled) this.#notePreparationBlocked('unknown');
      throw new Error('Owner DM response does not match the fixed Owner.');
    }
    const channelBinding = buildChannelBinding(attempted, dmEvidence, this.botId, this.ownerId);
    this.ledger.finish(binding.operationId, attempted.generation, 'confirmed', 'dm_channel_confirmed', channelBinding);
    return dmEvidence.channelId;
  }

  async process(task) {
    // A notifier disabled after this task was queued never prepares or sends it.
    if (this.accepting && !this.isReady()) return;
    let channelId;
    try {
      channelId = await this.ensureDeliveryChannel();
    } catch (preparationError) {
      this.#releaseIntake(task.intake, { restoreCarried: true });
      try {
        this.ledger.finalizeUnattempted(task.binding,
          this.accepting ? 'dm_channel_unavailable' : 'shutdown_before_dispatch');
      } catch (error) {
        this.#disable('OWNER_SAFETY_FINAL_PERSIST_FAILED', error);
      }
      this.log('OWNER_SAFETY_PREPARATION_UNAVAILABLE', preparationError);
      return;
    }

    if (!this.accepting) {
      try {
        this.ledger.finalizeUnattempted(task.binding, 'shutdown_before_dispatch');
      } catch (error) {
        this.#disable('OWNER_SAFETY_SHUTDOWN_FINALIZE_FAILED', error);
      }
      return;
    }

    let generation = null;
    let refusedForBudget = false;
    let refusedForMerge = false;
    try {
      const claimed = this.ledger.claim(task.binding);
      refusedForMerge = claimed.kind === 'suppressed' && claimed.operation?.status === 'suppressed_merge';
      // Only the ledger's budget is a refusal to report here; a merge window of the ledger (suppressed_merge)
      // is a repeat of a notice already sent, and every other answer is a replay of one already settled.
      refusedForBudget = claimed.kind === 'suppressed' && claimed.operation?.status === 'suppressed_budget';
      if (claimed.kind === 'claimed') {
        ({ generation } = this.ledger.renew(task.binding.operationId, claimed.operation.generation));
      }
    } catch (error) {
      this.#disable('OWNER_SAFETY_ATTEMPT_PERSIST_FAILED', error);
      return;
    }
    if (refusedForBudget) this.#noteLedgerBudgetRefusal(task.intake);
    if (refusedForMerge) this.#noteLedgerMerge(task.intake);
    if (generation === null) return;

    let attempted = null;
    // At the network entry: a notifier that stopped or was disabled meanwhile sends nothing.
    const sent = await this.sendProtected({ method: 'POST', fullRoute: Routes.channelMessages(channelId),
      body: task.binding.payload }, () => {
      if (!this.isReady()) throw Object.assign(new Error('OWNER_SAFETY_NOT_READY'), { unavailable: true });
      attempted = this.ledger.beginDispatch(task.binding, generation);
    });
    if (!attempted) {
      this.#settleNotSent(task, generation, sent);
      return;
    }
    if (sent.kind !== 'confirmed') {
      this.finishSent(task.binding.operationId, attempted.generation, sent, 'message');
      return;
    }
    try {
      this.ledger.finish(task.binding.operationId, attempted.generation, 'confirmed', 'message_confirmed');
    } catch (error) {
      this.#disable('OWNER_SAFETY_FINAL_PERSIST_FAILED', error);
    }
  }

  // A notice that never reached Discord wrote nothing: its claim ends in memory and its
  // budget is given back, like a notice not sent for a full queue. A begin refused at the
  // network entry is settled as before: an event made terminal by its source watermark after
  // the claim (retention ran in between) ends under the source's code and the ledger stays
  // usable; any other ledger fault stops the notifier.
  #settleNotSent(task, generation, sent) {
    this.#releaseIntake(task.intake, { restoreCarried: true });
    const error = sent.entryError;
    let code;
    if (sent.reason === 'entry_failed' && error?.unavailable !== true) {
      if (error?.code !== 'SIDE_EFFECT_SOURCE_TERMINAL' || this.ledger.failed) {
        this.#disable('OWNER_SAFETY_ATTEMPT_PERSIST_FAILED', error);
        return;
      }
      code = error.storeDetail?.reason === 'cutover' ? 'before_cutover' : 'source_watermark';
    } else {
      code = sent.reason === 'entry_failed' ? 'shutdown_before_dispatch'
        : sent.reason === 'rate_limited' ? 'rate_limited_before_dispatch'
          : sent.reason === 'deadline' ? 'deadline_before_dispatch' : 'refused_before_dispatch';
    }
    try {
      this.ledger.finalizeClaim(task.binding.operationId, generation, code);
    } catch (finalizeError) {
      this.#disable('OWNER_SAFETY_ATTEMPT_PERSIST_FAILED', finalizeError);
    }
  }

  // The first step of a stop: the safety hook is removed, queued notices end without being
  // sent (nothing durable is written), and the one in flight is waited for (its dispatch
  // timeout bounds it). The ledger stays open until stop().
  async quiesce() {
    this.accepting = false;
    this.armed = false;
    const restore = this.restoreHandler;
    this.restoreHandler = null;
    if (restore) restore();
    const restoreSafety = this.restoreSafetyHandler;
    this.restoreSafetyHandler = null;
    if (restoreSafety) restoreSafety();
    this.#finalizeQueued('shutdown_before_dispatch');
    if (this.drainPromise) await this.drainPromise;
  }

  async stop() {
    if (!this.accepting && !this.restoreHandler && !this.restoreSafetyHandler && !this.ledger) return;
    await this.quiesce();
    if (this.ledger) {
      this.ledger.close();
      this.#escalations.closed(OWNER_PURPOSE_ID, this.ledger);
    }
    this.ledger = null;
    this.ledgerBoot = null;
    this.disabled = true;
  }

  getStatsForTests() {
    return Object.freeze({
      accepting: this.accepting,
      disabled: this.disabled,
      queueLength: this.queue.length,
      workerConcurrency: WORKER_CONCURRENCY,
    });
  }

  async waitForIdleForTests() {
    while (this.drainPromise) await this.drainPromise;
  }
}

module.exports = {
  CATEGORY_BUDGETS,
  CATEGORY_BUDGET_CLASSES,
  DISPATCH_TIMEOUT_MS,
  DM_PREPARATION_ACTION,
  EVENT_NOTICE_PREFIXES,
  FIXED_NOTICE_PREFIX,
  MAX_DM_PREPARATION_FAILURES,
  NOTICE_PREFIXES,
  OUTAGE_KIND_TEXT,
  OWNER_EVENT_ACTION,
  OwnerSafetyNotifier,
  SECURITY_ALERT_TEXT,
  PRE_ARM_QUEUE_LIMIT,
  QUEUE_LIMIT,
  WORKER_CONCURRENCY,
  buildChannelBinding,
  buildFixedNotice,
  buildLedgerAlertOperation,
  buildOperation,
  buildPreparationOperation,
  ownerEventIdentity,
  validateChannelBinding,
  validateCreatedDm,
};
