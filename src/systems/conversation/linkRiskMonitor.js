'use strict';

// Tells the Owner about a message that looks like a phishing or malware lure, as a security alert of kind link-risk
// (safetyEventCatalog.js). It only tells: the message is not deleted, nobody is muted, and nothing is answered.
//
// A message in a server is first read by the offline rules of linkRiskScanner.js. When they find a lure, the alert is
// raised at once. When they find none but the message holds a link, the optional second opinion (jevClient.js
// judgeLinkRisk) may be asked, and only if it is switched on for this server (mode shadow or enforce, JEV_POLICY_ACK
// given, the server on JEV_GUILD_IDS; parseJevConfig answers null otherwise, and then nothing is sent anywhere) and the
// owner has opted in to this use with JEV_LINK_RISK=yes (config.linkRisk): without it member messages are never sent:
//  - shadow: the verdict is only logged (`[JEV_SHADOW] kind=link verdict=...`) and changes nothing;
//  - enforce: a verdict of risky raises the alert too. A verdict of safe, an error or a timeout leaves the rules'
//    answer (not risky) in place.
// The call is not waited for: inspectMessageLinkRisk returns at once, so handling the message goes on; the answer is
// handled when it comes, inside the same host operation (the alert needs that), and every failure is swallowed.
// Merging the alerts of one flood into a single DM is the notifier's work (one per server and kind an hour).

const defaultLogger = require('../../utils/logger');
const { reportSecurityAlert } = require('../../platform/safetyEventCatalog');
const { getDefaultJevClient, isGuildEnabled } = require('./jevClient');
const { scanLinkRisk } = require('./linkRiskScanner');

const VERDICTS = Object.freeze({ SAFE: 'safe', RISKY: 'risky', ERROR: 'error' });
// A message too short to hold an address is not read.
const MIN_TEXT_LENGTH = 4;
// A message that has no dot, no "://" and no "www" (also written full width or with the ideographic full stop) holds no
// address, so it is not scanned at all. Anything with one of them goes to the scanner, which decides.
const MAYBE_AN_ADDRESS = /[.。．｡]|:\/\/|：[/／]{2}|www|ｗｗｗ/iu;

function verdictOf(result) {
  if (!result || result.ok !== true) return VERDICTS.ERROR;
  return result.safe === true ? VERDICTS.SAFE : VERDICTS.RISKY;
}

function raiseAlert(message, report) {
  report('link-risk', {
    guildId: message.guildId,
    guildName: message.guild?.name ?? '',
    actorId: message.author?.id ?? null,
    channelId: message.channelId ?? null,
    messageId: message.id ?? null,
  });
}

// Reads one message. Returns { scanned, risky, reasons, settled }: `settled` is the promise of the second opinion when
// one was asked (resolves when it has been handled, never rejects) and null otherwise; callers do not wait for it.
function inspectMessageLinkRisk(message, {
  scan = scanLinkRisk,
  report = reportSecurityAlert,
  runtime = undefined,
  loggerImpl = defaultLogger,
} = {}) {
  const none = Object.freeze({ scanned: false, risky: false, reasons: Object.freeze([]), settled: null });
  if (!message?.guildId || !message.author || message.author.bot || message.webhookId || message.system) return none;
  const content = message.content;
  if (typeof content !== 'string' || content.length < MIN_TEXT_LENGTH) return none;

  if (!MAYBE_AN_ADDRESS.test(content)) return none;
  const result = scan(content);
  if (result.risky) {
    raiseAlert(message, report);
    return Object.freeze({ scanned: true, risky: true, reasons: result.reasons, settled: null });
  }
  const answer = Object.freeze({ scanned: true, risky: false, reasons: result.reasons });
  if (!result.hasLink) return Object.freeze({ ...answer, settled: null });

  const jev = runtime === undefined ? getDefaultJevClient() : runtime;
  const config = jev?.config;
  const enabled = Boolean(config) && config.linkRisk === true && config.mode !== 'off' &&
    isGuildEnabled(config, message.guildId) && typeof jev.judgeLinkRisk === 'function';
  if (!enabled) return Object.freeze({ ...answer, settled: null });

  const mode = config.mode === 'enforce' ? 'ENFORCE' : 'SHADOW';
  const settled = Promise.resolve()
    .then(() => jev.judgeLinkRisk({ text: content }))
    .then(verdictOf, () => VERDICTS.ERROR)
    .then((verdict) => {
      try { loggerImpl.info(`[JEV_${mode}] kind=link verdict=${verdict}`); } catch { /* logging never changes a decision */ }
      if (mode === 'ENFORCE' && verdict === VERDICTS.RISKY) raiseAlert(message, report);
    })
    .catch(() => {});
  return Object.freeze({ ...answer, settled });
}

module.exports = {
  MIN_TEXT_LENGTH,
  VERDICTS,
  inspectMessageLinkRisk,
};
