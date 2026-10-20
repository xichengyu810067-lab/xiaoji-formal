'use strict';

/*
 * What the side-effect ledgers tell people: the Owner, the operator's log, the
 * status page, the test-control launcher, and the exit code. Nothing here opens, reads,
 * or writes a ledger; it only classifies what the bootstrap and the runtimes report.
 *
 * prepare(report) takes the bootstrap report (ledgerBootstrap.js, format version 1)
 * before login. Every escalation is recorded and logged at once (ledgerEscalation.js);
 * Owner notices wait for flush() after ready. Later events: noteRuntimeDisabled(),
 * noteBotMismatch(), noteLastSeenFailed(), noteQuarantineUnpersisted().
 *
 * Owner notices go through the Owner ledger (OwnerSafetyNotifier.notifyLedgerEvent, with
 * that ledger's owner-notice budget and 10-minute merge): one notice per start (ledgers
 * created and their cutovers, purposes failed closed or turned off before ready, for
 * example a delivered ledger a runtime refused, maintenance notices, a lastSeen that could
 * not be written) and one per purpose disabled while running after that. When there is an
 * anomaly to report and the Owner ledger cannot carry it (the Owner purpose failed, was
 * refused, or was stopped, the bot identity differs at ready, or the bootstrap failed as a
 * whole), one emergency DM is sent outside every ledger, at most once per 6 hours of wall
 * clock; at a start it also lists the ledgers that start created. The stamp
 * (coin_metadata safety_alert:owner-emergency) is read first (a stamp that cannot be read
 * or parsed sends nothing and is escalated; one more than 5 minutes ahead of the clock is
 * overwritten), then written durably with compare-and-set, and only then is the DM sent;
 * a send that failed is not retried before the next window, unless it never left the bot
 * (refused by the local egress limit or guard, for example): then the stamp is given back and
 * the next anomaly or start tries again, at least a minute later. Nothing is sent under the kill
 * switch or test-control; test-control gets fixed reporter codes instead. While the Owner DM
 * start guard holds the DMs of a start back (ownerDmStartGuard.js), nothing is sent either: the
 * Owner notifier drops the start's notices, and an emergency DM due is dropped here.
 *
 * Texts are fixed: purpose names, codes, reason tokens, a fixed hint per code, and Discord
 * timestamps; never a path, an ID, a confirmation code, or message content.
 */

const crypto = require('node:crypto');
const { Routes } = require('discord.js');
const defaultLogger = require('../../utils/logger');
const coinDatabase = require('../../services/coinDatabase');
const { runWithBackgroundContext } = require('../../platform/hostOperationContext');
const { installProtectedRest } = require('../../platform/protectedRest');
const { createLedgerEscalations, formatLedgerEscalation } = require('./ledgerEscalation');
const { validateCreatedDm } = require('./ownerSafetyNotifier');
const { OWNER_PURPOSE_ID } = require('./sideEffectLedger');
const { PURPOSE_IDS } = require('./ledgerLayout');

const ALERT_STAMP_NAME = 'owner-emergency';
const STAMP_SCHEMA = 1;
const EMERGENCY_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const STAMP_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const EMERGENCY_TIMEOUT_MS = 15_000;
// After an emergency DM that never left the bot, the next try waits at least this long (or the
// wait its refusal named, if longer); it comes with the next anomaly or the next start.
const EMERGENCY_RETRY_MIN_MS = 60 * 1_000;
// An emergency DM the Owner DM start guard held back is logged at most once a minute.
const START_GUARD_LOG_INTERVAL_MS = 60 * 1_000;
// Room left for the rest of an Owner ledger binding (4 KiB in all), and below Discord's
// 2000-character message limit.
const MAX_NOTICE_BYTES = 2_400;
const MAX_NOTICE_CHARACTERS = 1_900;
const MAX_HINTS = 3;
const MAX_EMERGENCY_CODES = 10;
const SNOWFLAKE = /^\d{17,20}$/u;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const REASON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/u;
const REPORTER_OPERATION = 'ledger';
// Every code this module gives the test-control reporter (testControlProtocol SAFE_CODES).
const REPORTER_CODES = Object.freeze([
  'TEST_LEDGER_ANOMALY',
  'TEST_LEDGER_ESCALATION',
  'TEST_LEDGER_NOTICE',
  'TEST_LEDGER_POLICY_DISABLED',
  'TEST_LEDGER_PROTECTED_EFFECTS_OFF',
]);
const STATUS_COMMAND = 'npm run safety:ledger -- status';
const PURPOSE_NAMES = Object.freeze({
  [OWNER_PURPOSE_ID]: 'Owner 安全通知',
  welcome: '新人歡迎',
  'work.penalty.announce': '扣薪公告',
  'work.reminder.dm.prepare': '工作提醒（私訊準備）',
  'work.reminder.dm.send': '工作提醒（私訊）',
  // Dormant: the bot no longer reviews servers, so nothing leaves one, but the ledger stays and is still reported.
  'audit.guild.leave': '自動離群（休眠）',
  'word-chain.reaction': '文字接龍 ✅',
  'number-chain.reaction': '數字接龍 ✅',
});
// The public features whose status card follows a ledger.
const FEATURE_PURPOSES = Object.freeze({
  welcome: 'welcome',
  word_chain: 'word-chain.reaction',
  number_chain: 'number-chain.reaction',
});
// Notices that also end the process with the escalation exit code.
const ESCALATING_NOTICES = new Set(['LEDGER_REQUEST_NOT_CONSUMED']);
// One fixed hint per code that the operator can act on directly. None of them asks for
// XIAOJI_DATA_ROOT: setting it moves the personal reminders and calendar as well, which
// then have to be migrated first (README).
const HINTS = Object.freeze({
  LEDGER_PATH_IN_PROJECT: '吉幣資料庫與安全帳本位於小吉的程式資料夾內。請先停止小吉，把吉幣資料庫檔案搬到程式資料夾外的本機資料夾，並在 .env 將 COIN_DB_PATH 設為新位置的絕對路徑，再重新啟動。',
  LEDGER_PATH_INVALID: '安全帳本的資料夾無法使用（不存在、不是資料夾，或路徑格式不對）。請確認 .env 的 COIN_DB_PATH 是程式資料夾外、既有本機資料夾內的絕對路徑。',
  LEDGER_PATH_LINKED: '安全帳本的資料夾經過 junction 或捷徑。請改用實體資料夾，並更新 COIN_DB_PATH。',
  LEDGER_PATH_REMOTE: '安全帳本不可放在網路磁碟。請把吉幣資料庫搬到本機磁碟的資料夾，並更新 COIN_DB_PATH。',
  LEDGER_PATH_OVERLAP: 'XIAOJI_SAFETY_LEDGER_DIR 與 XIAOJI_SAFETY_WITNESS_DIR 不可相同，也不可互相包含。',
  LEDGER_TEST_ROOT_IN_PRODUCTION: '正式環境指到了測試資料。請把 COIN_DB_PATH 改回正式吉幣資料庫的位置。',
  LEDGER_IDENTITY_INVALID: '無法確認小吉或 Owner 的身分。請確認 Bot token 與 .env 的 BOT_OWNER_ID。',
  LEDGER_IDENTITY_UNVERIFIED: '小吉這次無法用 Bot token 讀取自己的身分，改用 .env 的 DISCORD_CLIENT_ID；為了不讓帳本綁到錯的身分，這次只開啟既有的帳本，不建立新帳本。請確認網路與 Bot token；下次啟動能讀取身分時就會自動建立。',
  LEDGER_BOT_MISMATCH: '登入身分與開啟帳本時使用的身分不一致。無法用 Bot token 讀取身分時，小吉會改用 .env 的 DISCORD_CLIENT_ID（或 CLIENT_ID），而且只開啟既有的帳本、不建立新帳本；請確認它是這個機器人的應用程式 ID。',
  LEDGER_IN_USE: '帳本被另一個程序占用，可能有第二個小吉正在執行。請只保留一個執行中的小吉。',
});
const DEFAULT_HINT = `請在主機執行 ${STATUS_COMMAND} 查看，並依 README 的異常處理說明處置；不要刪除或重建帳本檔案。`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeCode(code, fallback) {
  return typeof code === 'string' && CODE_TOKEN.test(code) ? code : fallback;
}

function safeReason(reason) {
  return typeof reason === 'string' && REASON_TOKEN.test(reason) ? reason : null;
}

function purposeName(purposeId) {
  return PURPOSE_NAMES[purposeId] || null;
}

function cutoverText(cutoverMs) {
  if (!Number.isSafeInteger(cutoverMs) || cutoverMs <= 0) return '不套用 cutover';
  return `cutover <t:${Math.floor(cutoverMs / 1_000)}:F>`;
}

function codeText(code, reason) {
  return reason ? `${code}／${reason}` : code;
}

// The fixed hints for the distinct codes given, at most MAX_HINTS of them, always ending
// with the status command when any code has no hint of its own.
function hintsFor(codes) {
  const lines = [];
  let needsDefault = false;
  for (const code of new Set(codes)) {
    if (HINTS[code]) {
      if (lines.length < MAX_HINTS) lines.push(HINTS[code]);
    } else {
      needsDefault = true;
    }
  }
  if (needsDefault || !lines.length) lines.push(DEFAULT_HINT);
  return lines;
}

// Joins header, body, and footer, dropping body lines from the end (with one marker)
// until the text fits MAX_NOTICE_BYTES and MAX_NOTICE_CHARACTERS.
function fitLines(header, body, footer) {
  const kept = [...body];
  const assemble = (lines, cut) => [header, ...lines, ...(cut ? ['…（其餘項目略）'] : []), ...footer].join('\n');
  const fits = (text) => Buffer.byteLength(text) <= MAX_NOTICE_BYTES && text.length <= MAX_NOTICE_CHARACTERS;
  let text = assemble(kept, false);
  while (!fits(text) && kept.length) {
    kept.pop();
    text = assemble(kept, true);
  }
  return text;
}

// The one notice of a start: what was created, what failed closed, maintenance notices,
// and a lastSeen that could not be written. One line per item, so a notice too long is
// cut item by item. Null when there is nothing to say.
function buildStartupNotice({ created, anomalies, notices, lastSeenFailed }) {
  if (!created.length && !anomalies.length && !notices.length && !lastSeenFailed) return null;
  const body = [];
  const section = (label, lines) => {
    if (lines.length) body.push(`${label}：`, ...lines.map((line) => `・${line}`));
  };
  section('已建立', created.map((item) => `${purposeName(item.purposeId)}（${cutoverText(item.cutoverMs)}）`));
  section('已停用', anomalies.map((item) => `${purposeName(item.purposeId)}（${codeText(item.code, item.reason)}）`));
  section('維運提示', notices.map((item) => `${purposeName(item.purposeId)}（${item.code}）`));
  if (lastSeenFailed) body.push('lastSeen 未能寫入（LEDGER_LAST_SEEN_WRITE_FAILED），下次啟動偵測還原的能力會變弱。');
  const footer = [
    ...(anomalies.length || lastSeenFailed || notices.length ? hintsFor(anomalies.map((item) => item.code)) : []),
    anomalies.length ? '只有上面列出的功能停用；聊天與其他功能照常運作。'
      : created.length ? '受保護功能已啟用；cutover 之前的事件不會補發。' : '受保護功能照常運作。',
  ];
  const content = fitLines('小吉安全帳本通知（本次啟動）', body, footer);
  const key = JSON.stringify({
    created: created.map((item) => [item.purposeId, item.cutoverMs]),
    anomalies: anomalies.map((item) => [item.purposeId, item.code, item.reason]),
    notices: notices.map((item) => [item.purposeId, item.code]),
    lastSeenFailed,
  });
  return Object.freeze({ category: 'startup', key: sha256(key), mergeScope: 'boot', content });
}

function buildRuntimeNotice(purposeId, code) {
  const content = fitLines(`小吉安全帳本通知：${purposeName(purposeId)}已在執行中停用（${code}）。`, [],
    [...hintsFor([code]), '其他功能照常運作。']);
  return Object.freeze({ category: 'runtime', key: sha256(JSON.stringify([purposeId, code])),
    mergeScope: purposeId, content });
}

// The emergency DM. created: the ledgers this start created, whose notice the Owner ledger
// could not carry; they are listed last, so a text too long loses them first.
function buildEmergencyNotice({ purposeIds, codes, created = [] }) {
  const names = [...new Set(purposeIds)].map(purposeName).filter(Boolean);
  const distinct = [...new Set(codes)];
  const listed = distinct.length > MAX_EMERGENCY_CODES
    ? [...distinct.slice(0, MAX_EMERGENCY_CODES), '…'] : distinct;
  const createdLines = created.filter((item) => purposeName(item.purposeId))
    .map((item) => `・${purposeName(item.purposeId)}（${cutoverText(item.cutoverMs)}）`);
  const body = [
    names.length ? `停用的功能：${names.join('、')}` : '受保護功能已停用。',
    `代碼：${listed.join('、')}`,
    ...hintsFor(distinct),
    ...(createdLines.length ? ['本次啟動已建立的帳本（cutover 之前的事件不會補發）：', ...createdLines] : []),
  ];
  return fitLines('小吉緊急安全提示：受保護功能已停用，而且 Owner 安全通知帳本也無法使用，所以改用這則固定提示。', body,
    ['聊天與其他功能照常運作。6 小時內不會重複提醒。']);
}

// Whether an emergency DM sent at sentAtMs still holds the next one back ('within' the
// 6-hour window) or not ('past'). A time more than STAMP_FUTURE_TOLERANCE_MS ahead of the
// clock ('future': a clock set back, or a damaged stamp) holds nothing back, so a bad value
// can never keep the Owner from hearing about an anomaly for hours.
function emergencyWindow(sentAtMs, nowMs) {
  if (sentAtMs > nowMs + STAMP_FUTURE_TOLERANCE_MS) return 'future';
  return nowMs - sentAtMs < EMERGENCY_INTERVAL_MS ? 'within' : 'past';
}

// The stamp value: { schema: 1, sentAtMs }. null when absent; { invalid: true } when it
// cannot be trusted.
function parseStamp(entry) {
  if (!entry) return null;
  try {
    const value = JSON.parse(String(entry.value));
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
        value.schema === STAMP_SCHEMA && Number.isSafeInteger(value.sentAtMs) && value.sentAtMs >= 0) {
      return Object.freeze({ sentAtMs: value.sentAtMs });
    }
  } catch {}
  return Object.freeze({ invalid: true });
}

// One request of the emergency DM through the protected channel of client.rest
// (protectedRest.js): it reaches Discord at most once, and only while a third of its timeout
// (at most 5 s) is still left for the answer; the timer runs as the safety.ledger-alerts job.
// A rate limit discord.js already knows is waited out if it ends by then; a longer one, or
// Discord's own 429, fails this delivery. A request that never left the bot (not_sent: the
// local egress limit or the egress guard refused it, a known rate limit or the deadline came
// first) is marked notSent, with the wait the refusal named, if any.
async function sendEmergencyRequest(channel, request, timeoutMs) {
  const sent = await channel.send(request, { deadlineMs: timeoutMs, label: 'safety.ledger-alerts' });
  if (sent.kind === 'confirmed') return sent.value;
  throw Object.assign(new Error('LEDGER_EMERGENCY_NOT_DELIVERED'), {
    code: 'LEDGER_EMERGENCY_NOT_DELIVERED',
    notSent: sent.kind === 'not_sent',
    retryAfterMs: Number.isSafeInteger(sent.retryAfterMs) && sent.retryAfterMs >= 0 ? sent.retryAfterMs : 0,
  });
}

// The emergency DM itself: open the Owner's DM channel, then post the fixed text.
async function deliverEmergency(rest, ownerId, content, timeoutMs) {
  const channel = installProtectedRest(rest);
  const opened = await sendEmergencyRequest(channel, { method: 'POST', fullRoute: Routes.userChannels(),
    body: { recipient_id: ownerId } }, timeoutMs);
  const evidence = validateCreatedDm(opened, ownerId);
  if (!evidence) throw Object.assign(new Error('LEDGER_EMERGENCY_CHANNEL_INVALID'), { code: 'LEDGER_EMERGENCY_CHANNEL_INVALID' });
  await sendEmergencyRequest(channel, { method: 'POST', fullRoute: Routes.channelMessages(evidence.channelId),
    body: { content, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } } }, timeoutMs);
}

const DEFAULT_STAMP = Object.freeze({
  read: () => coinDatabase.readSafetyAlertStamp(ALERT_STAMP_NAME),
  write: (value, expectedValue) => coinDatabase.writeSafetyAlertStamp(ALERT_STAMP_NAME, { value, expectedValue }),
});

// What one bootstrap report (format version 1) says, without recording anything. Throws for
// a report that cannot be read at all.
function classifyReport(bootstrapReport) {
  if (!bootstrapReport || typeof bootstrapReport !== 'object' || bootstrapReport.version !== 1 ||
      !Array.isArray(bootstrapReport.purposes)) {
    throw new TypeError('The bootstrap report cannot be read.');
  }
  const protectedEffects = bootstrapReport.protectedEffects === 'off' ? 'off' : 'on';
  const classified = { protectedEffects, purposes: [], created: [], anomalies: [], notices: [], lastSeenFailed: false };
  if (protectedEffects === 'off') return classified;
  for (const item of bootstrapReport.purposes) {
    const purposeId = item?.purposeId;
    if (!purposeName(purposeId)) continue;
    const code = safeCode(item.code, 'LEDGER_UNKNOWN');
    const reason = safeReason(item.reason);
    // Giving up the wait for a lock because this process is stopping is not an anomaly.
    const quiet = item.status === 'failed' && code === 'LEDGER_IN_USE' && reason === 'stopping';
    classified.purposes.push([purposeId, Object.freeze({ status: item.status, code, reason, quiet })]);
    if (item.status === 'ready' && item.created === true) classified.created.push({ purposeId, cutoverMs: item.cutoverMs });
    if (item.status === 'failed' && !quiet) classified.anomalies.push({ purposeId, code, reason });
    for (const notice of Array.isArray(item.notices) ? item.notices : []) {
      const noticeCode = safeCode(notice, null);
      if (noticeCode) classified.notices.push({ purposeId, code: noticeCode });
    }
  }
  classified.lastSeenFailed = bootstrapReport.lastSeen === 'failed';
  return classified;
}

// A version-1 report for a bootstrap that threw, never ran, or left a report that could not
// be classified: every purpose failed closed, or, with the kill switch set
// (protectedEffects 'off'), disabled as the bootstrap itself would report it.
function failedBootstrapReport({ runtimeMode = 'production', code = 'LEDGER_BOOTSTRAP_FAILED', nowMs = Date.now(),
  protectedEffects = 'on' } = {}) {
  const off = protectedEffects === 'off';
  return Object.freeze({
    version: 1,
    protectedEffects: off ? 'off' : 'on',
    runtimeMode: ['production', 'test-control'].includes(runtimeMode) ? runtimeMode : null,
    startedAtMs: nowMs,
    finishedAtMs: nowMs,
    legacyVariables: Object.freeze([]),
    lastSeen: 'skipped',
    purposes: Object.freeze(PURPOSE_IDS.map((purposeId) => Object.freeze({
      purposeId, kind: purposeId === OWNER_PURPOSE_ID ? 'owner' : 'public', status: off ? 'disabled' : 'failed',
      code: off ? 'LEDGER_PROTECTED_EFFECTS_OFF' : safeCode(code, 'LEDGER_BOOTSTRAP_FAILED'), reason: null,
      notices: Object.freeze([]), ledgerId: null, confirmationCode: null, genesisMs: null, cutoverMs: null,
      created: false, escalate: !off,
    }))),
  });
}

// ownerDmGate, if given, is the Owner DM start guard (ownerDmStartGuard.js): while its
// allowsOwnerDm() is not true, an emergency DM due is dropped, never sent later, and leaves
// the stamp alone.
function createLedgerAlerts({
  runtimeMode,
  logger = defaultLogger,
  reporter = null,
  ownerId = null,
  now = () => Date.now(),
  stamp = DEFAULT_STAMP,
  emergencyTimeoutMs = EMERGENCY_TIMEOUT_MS,
  ownerDmGate = null,
} = {}) {
  const testControl = runtimeMode === 'test-control';
  const heldByStartGuard = () => {
    if (!ownerDmGate || typeof ownerDmGate.allowsOwnerDm !== 'function') return false;
    try {
      return ownerDmGate.allowsOwnerDm() !== true;
    } catch {
      return true;
    }
  };
  // The line of an emergency DM the guard held back: at most one a minute, with the number of
  // lines left out since the last one.
  const guardLog = { at: null, skipped: 0 };
  const logHeldByStartGuard = () => {
    const nowMs = now();
    if (guardLog.at !== null && Number.isSafeInteger(nowMs) && nowMs >= guardLog.at &&
        nowMs < guardLog.at + START_GUARD_LOG_INTERVAL_MS) {
      guardLog.skipped += 1;
      return;
    }
    logger?.warn?.(`[SAFETY_LEDGER] code=OWNER_DM_GUARD_BLOCKED kind=emergency skipped=${guardLog.skipped}`);
    guardLog.at = nowMs;
    guardLog.skipped = 0;
  };
  const owner = String(ownerId || '').trim();
  const report = (code) => {
    if (testControl) {
      try { reporter?.deny?.(code, REPORTER_OPERATION); } catch {}
    }
  };
  const escalations = createLedgerEscalations({
    onRecord(entry) {
      logger?.error?.(formatLedgerEscalation(entry));
      report('TEST_LEDGER_ESCALATION');
    },
  });
  const state = {
    prepared: false,
    protectedEffects: 'on',
    purposes: new Map(),
    runtimeDisabled: new Map(),
    botMismatch: false,
    stopping: false,
    attached: null,
    pending: { created: [], anomalies: [], notices: [], lastSeenFailed: false, runtime: [] },
    // Anomalies the Owner ledger could not carry, waiting for an emergency DM, with the
    // ledgers the start created when its notice could not go out either.
    emergency: { purposeIds: new Set(), codes: [], created: [] },
    lastEmergencyAtMs: null,
    // After an emergency DM that never left the bot: no new try before this time.
    emergencyRetryAtMs: null,
    emergencyChain: Promise.resolve(),
  };
  const silent = () => testControl || state.protectedEffects === 'off';

  function ownerUsable() {
    return !state.botMismatch && state.attached?.notifier?.isReady?.() === true;
  }

  function noteEmergency(purposeIds, codes) {
    for (const purposeId of purposeIds) if (purposeName(purposeId)) state.emergency.purposeIds.add(purposeId);
    for (const code of codes) if (!state.emergency.codes.includes(code)) state.emergency.codes.push(code);
  }

  // An emergency DM that never left the bot spends nothing. What it was to say waits for the next try,
  // together with anything noted meanwhile; the stamp goes back to what it was (an absent one becomes
  // "sent at 0", which holds nothing back), with the same compare-and-set; and the next try waits
  // EMERGENCY_RETRY_MIN_MS, or the refusal's own wait when longer. A stamp that cannot be given back
  // keeps the window, as a sent DM would.
  async function releaseWindow({ sending, previousAtMs, previousValue, written, nowMs, error }) {
    const waiting = state.emergency;
    state.emergency = {
      purposeIds: new Set([...sending.purposeIds, ...waiting.purposeIds]),
      codes: [...sending.codes, ...waiting.codes.filter((code) => !sending.codes.includes(code))],
      created: sending.created.length ? sending.created : waiting.created,
    };
    state.emergencyRetryAtMs = nowMs + Math.max(EMERGENCY_RETRY_MIN_MS, error.retryAfterMs || 0);
    logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_NOT_SENT');
    try {
      await stamp.write(previousValue ?? JSON.stringify({ schema: STAMP_SCHEMA, sentAtMs: 0 }), written);
    } catch {
      logger?.error?.('[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_RELEASE_FAILED');
      return 'not-sent';
    }
    state.lastEmergencyAtMs = previousAtMs;
    return 'not-sent';
  }

  // Reads the stamp, writes the new one durably, then sends. Serialized in this process.
  function sendEmergency() {
    const run = async () => {
      if (silent() || state.stopping || !state.emergency.codes.length) return 'none';
      // Before the window and the stamp: what was due is dropped, not kept for a later try, so
      // nothing held back comes out once the guard lets DMs through again. Escalations are
      // recorded as before.
      if (heldByStartGuard()) {
        state.emergency = { purposeIds: new Set(), codes: [], created: [] };
        logHeldByStartGuard();
        return 'start-guard';
      }
      const rest = state.attached?.rest;
      if (!SNOWFLAKE.test(owner) || !rest) {
        logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_UNAVAILABLE');
        return 'unavailable';
      }
      const nowMs = now();
      if (state.lastEmergencyAtMs !== null && emergencyWindow(state.lastEmergencyAtMs, nowMs) === 'within') {
        return 'suppressed';
      }
      if (state.emergencyRetryAtMs !== null && nowMs < state.emergencyRetryAtMs) return 'deferred';
      let current;
      try {
        current = await stamp.read();
      } catch {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_UNREADABLE');
        escalations.record('all', 'LEDGER_ALERT_STAMP_UNREADABLE', 'runtime');
        return 'stamp-unreadable';
      }
      const parsed = parseStamp(current);
      if (parsed?.invalid) {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_INVALID');
        escalations.record('all', 'LEDGER_ALERT_STAMP_INVALID', 'runtime');
        return 'stamp-invalid';
      }
      const window = parsed ? emergencyWindow(parsed.sentAtMs, nowMs) : 'past';
      if (window === 'within') {
        state.lastEmergencyAtMs = parsed.sentAtMs;
        logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_SUPPRESSED');
        return 'suppressed';
      }
      // A stamp too far ahead of the clock holds nothing back: it is overwritten below, with
      // the same compare-and-set, and the DM is sent.
      if (window === 'future') logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_FUTURE');
      const content = buildEmergencyNotice({ purposeIds: [...state.emergency.purposeIds], codes: state.emergency.codes,
        created: state.emergency.created });
      const previousValue = current ? String(current.value) : null;
      const written = JSON.stringify({ schema: STAMP_SCHEMA, sentAtMs: nowMs });
      try {
        await stamp.write(written, previousValue);
      } catch {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_WRITE_FAILED');
        escalations.record('all', 'LEDGER_ALERT_STAMP_WRITE_FAILED', 'runtime');
        return 'stamp-write-failed';
      }
      const previousAtMs = state.lastEmergencyAtMs;
      const sending = state.emergency;
      state.lastEmergencyAtMs = nowMs;
      state.emergency = { purposeIds: new Set(), codes: [], created: [] };
      try {
        await runWithBackgroundContext('safety.ledger-alerts',
          () => deliverEmergency(rest, owner, content, emergencyTimeoutMs));
      } catch (error) {
        if (error?.notSent === true) return releaseWindow({ sending, previousAtMs, previousValue, written, nowMs, error });
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_FAILED');
        return 'failed';
      }
      logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_SENT');
      return 'sent';
    };
    const result = state.emergencyChain.then(run, run);
    state.emergencyChain = result.then(() => undefined, () => undefined);
    return result;
  }

  // Queues a notice on the Owner ledger. When it reports anomalies and the Owner ledger
  // turns out unable to take it, they wait for the emergency DM instead.
  function queueOwnerNotice(notice, { purposeIds = [], codes = [] } = {}) {
    let queued = false;
    try {
      queued = state.attached.notifier.notifyLedgerEvent(notice) === true;
    } catch {}
    if (!queued && codes.length && !ownerUsable()) noteEmergency(purposeIds, codes);
    return queued ? 'queued' : 'not-queued';
  }

  return Object.freeze({
    // Classifies one bootstrap report. Escalations are recorded now; notices wait.
    prepare(bootstrapReport) {
      if (state.prepared) throw new Error('Ledger alerts were already prepared.');
      // The whole report is classified before anything is recorded: a report that cannot be
      // read leaves these alerts unprepared, so the caller can prepare a failed one instead.
      const classified = classifyReport(bootstrapReport);
      state.prepared = true;
      state.protectedEffects = classified.protectedEffects;
      if (classified.protectedEffects === 'off') {
        report('TEST_LEDGER_PROTECTED_EFFECTS_OFF');
        return;
      }
      for (const [purposeId, entry] of classified.purposes) {
        state.purposes.set(purposeId, entry);
        if (entry.status === 'disabled' && entry.code === 'LEDGER_POLICY_DISABLED') report('TEST_LEDGER_POLICY_DISABLED');
      }
      state.pending.created.push(...classified.created);
      for (const anomaly of classified.anomalies) {
        state.pending.anomalies.push(anomaly);
        escalations.record(anomaly.purposeId, anomaly.code, 'open', anomaly.reason);
        report('TEST_LEDGER_ANOMALY');
      }
      for (const notice of classified.notices) {
        state.pending.notices.push(notice);
        if (ESCALATING_NOTICES.has(notice.code)) escalations.record(notice.purposeId, notice.code, 'open');
        report('TEST_LEDGER_NOTICE');
      }
      if (classified.lastSeenFailed) {
        state.pending.lastSeenFailed = true;
        escalations.record('all', 'LEDGER_LAST_SEEN_WRITE_FAILED', 'open');
      }
    },

    // After ready: what the start found, and any runtime event noted before this. notifier
    // is the Owner notifier (or null); rest is the client's REST for an emergency DM.
    // Returns { owner: notices queued on the Owner ledger, emergency: the emergency DM's
    // outcome ('none' when none was needed) }.
    async flush({ notifier = null, rest = null } = {}) {
      if (state.attached) throw new Error('Ledger alerts were already flushed.');
      state.attached = Object.freeze({ notifier, rest });
      const pending = state.pending;
      state.pending = { created: [], anomalies: [], notices: [], lastSeenFailed: false, runtime: [] };
      if (silent() || state.stopping) return Object.freeze({ owner: 0, emergency: 'none' });
      // Purposes turned off before this point (a delivered ledger a runtime's preflight
      // refused, or a purpose stopped before ready) are told in the start's one notice, so
      // the Owner-notice budget cannot drop them. The Owner purpose among them means the
      // Owner ledger cannot carry anything.
      const anomalies = [...pending.anomalies, ...pending.runtime];
      const ownerOff = pending.runtime.some((item) => item.purposeId === OWNER_PURPOSE_ID);
      let owner = 0;
      if (ownerUsable() && !ownerOff) {
        const startupNotice = buildStartupNotice({ ...pending, anomalies });
        if (startupNotice && queueOwnerNotice(startupNotice, { purposeIds: anomalies.map((item) => item.purposeId),
          codes: anomalies.map((item) => item.code) }) === 'queued') owner += 1;
      } else {
        noteEmergency(anomalies.map((item) => item.purposeId), anomalies.map((item) => item.code));
        // The start's notice cannot go out through the Owner ledger: the emergency DM lists
        // the ledgers it created as well, so their cutovers are not lost.
        if (state.emergency.codes.length && pending.created.length) state.emergency.created = [...pending.created];
      }
      const emergency = state.emergency.codes.length ? await sendEmergency() : 'none';
      return Object.freeze({ owner, emergency });
    },

    // A runtime stopped one purpose for the rest of this process (its ledger failed, was
    // quarantined, or could not be written). Noted once per purpose.
    noteRuntimeDisabled(purposeId, code) {
      if (!purposeName(purposeId) || state.stopping || state.runtimeDisabled.has(purposeId)) {
        return Promise.resolve('none');
      }
      const disabledCode = safeCode(code, 'LEDGER_RUNTIME_DISABLED');
      state.runtimeDisabled.set(purposeId, disabledCode);
      report('TEST_LEDGER_ANOMALY');
      if (silent()) return Promise.resolve('none');
      if (!state.attached) {
        state.pending.runtime.push({ purposeId, code: disabledCode });
        return Promise.resolve('pending');
      }
      // The Owner ledger cannot carry a notice about itself, nor one while it is unusable.
      if (purposeId !== OWNER_PURPOSE_ID && ownerUsable()) {
        queueOwnerNotice(buildRuntimeNotice(purposeId, disabledCode), { purposeIds: [purposeId], codes: [disabledCode] });
        return state.emergency.codes.length ? sendEmergency() : Promise.resolve('queued');
      }
      noteEmergency([purposeId], [disabledCode]);
      return sendEmergency();
    },

    // At ready the logged-in bot is not the one the ledgers were opened for: every
    // purpose stays off. The Owner ledger is bound to that identity too, so only the
    // emergency DM may tell the Owner.
    noteBotMismatch() {
      if (state.botMismatch) return Promise.resolve('none');
      state.botMismatch = true;
      escalations.record('all', 'LEDGER_BOT_MISMATCH', 'open');
      if (silent() || state.stopping) return Promise.resolve('none');
      noteEmergency(PURPOSE_IDS, ['LEDGER_BOT_MISMATCH']);
      return state.attached ? sendEmergency() : Promise.resolve('pending');
    },

    // lastSeen could not be written by the hourly refresh ('runtime') or at stop ('close').
    noteLastSeenFailed(stage = 'runtime') {
      escalations.record('all', 'LEDGER_LAST_SEEN_WRITE_FAILED', stage === 'close' ? 'close' : 'runtime');
    },

    // A quarantine that reached none of its three places at stop.
    noteQuarantineUnpersisted(purposeId) {
      escalations.record(purposeName(purposeId) ? purposeId : 'all', 'LEDGER_QUARANTINE_UNPERSISTED', 'close');
    },

    // From here on nothing is sent and the status page is not overridden.
    beginStop() {
      state.stopping = true;
    },

    // The status card override of one public feature: 'maintenance' (kill switch or
    // policy), 'broken' (failed closed, stopped while running, or a bot identity that
    // differs), or null (no override).
    featureStatus(featureKey) {
      const purposeId = FEATURE_PURPOSES[featureKey];
      if (!purposeId || !state.prepared || state.stopping) return null;
      if (state.protectedEffects === 'off') return 'maintenance';
      const entry = state.purposes.get(purposeId);
      if (entry?.status === 'disabled') return 'maintenance';
      if (entry?.status === 'failed' && !entry.quiet) return 'broken';
      if (state.botMismatch || state.runtimeDisabled.has(purposeId)) return 'broken';
      return null;
    },

    getLedgerEscalations() {
      return escalations.list();
    },
  });
}

module.exports = {
  ALERT_STAMP_NAME,
  EMERGENCY_INTERVAL_MS,
  FEATURE_PURPOSES,
  HINTS,
  MAX_NOTICE_BYTES,
  MAX_NOTICE_CHARACTERS,
  PURPOSE_NAMES,
  REPORTER_CODES,
  REPORTER_OPERATION,
  STAMP_FUTURE_TOLERANCE_MS,
  buildEmergencyNotice,
  buildRuntimeNotice,
  buildStartupNotice,
  createLedgerAlerts,
  failedBootstrapReport,
  parseStamp,
};
