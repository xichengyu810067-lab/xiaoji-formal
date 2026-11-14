'use strict';

// Reports of chat requests that got no answer from the model, or whose answer was held back by a safety rule, for
// the developer's maintenance (an optional extension delivers them; see the conversationBlocked hook in
// docs/EXTENSION_CONTRACT.md). Without a handler nothing happens. A report never changes what the member gets: it is
// made after the decision, and a handler that throws is ignored.
//
// A report holds where it happened (server and channel, with their names), who asked (ID and display name), at which
// stage it was stopped and by which rule, what the member wrote, and the reply that was held back, if any. The texts
// are capped; nothing else of the message is included.

const STAGES = Object.freeze([
  'spam',          // the anti-spam gate (aiSpamGuard.js): rate, repeat, meaningless content, cooldown
  'input',         // the request text was refused before anything else (too long, not for 小吉)
  'ingress',       // the request asked for what 小吉 must not tell (disclosurePolicy.js decideRequestIngress)
  'cooldown',      // the member's chat cooldown
  'archive',       // the archive was not available, so nothing was answered
  'output',        // the model's reply was held back by the output rules (disclosurePolicy.js decideAssistantOutput)
  'no_answer',     // the model gave no answer: provider limit, guild quota, provider guard, a failed call
]);
const MAX_TEXT = 1500;
const MAX_NAME = 100;

let handler = null;

function text(value, max) {
  return String(value ?? '').slice(0, max);
}

function normalizeReport(report = {}) {
  if (!STAGES.includes(report.stage)) throw new TypeError('Unknown blocked reply stage.');
  return Object.freeze({
    stage: report.stage,
    rule: text(report.rule || 'unknown', 80),
    guildId: report.guildId ? String(report.guildId) : null,
    guildName: text(report.guildName, MAX_NAME),
    channelId: report.channelId ? String(report.channelId) : null,
    channelName: text(report.channelName, MAX_NAME),
    userId: report.userId ? String(report.userId) : null,
    displayName: text(report.displayName, MAX_NAME),
    userText: text(report.userText, MAX_TEXT),
    draft: text(report.draft, MAX_TEXT),
    at: Number.isFinite(report.at) ? report.at : Date.now(),
  });
}

// Builds the report of one message. Returns the report (also when no handler is installed).
function reportBlockedReply(message, { stage, rule, userText = '', draft = '' } = {}, at = Date.now()) {
  const report = normalizeReport({
    stage,
    rule,
    guildId: message?.guildId ?? null,
    guildName: message?.guild?.name ?? '',
    channelId: message?.channelId ?? null,
    channelName: message?.channel?.name ?? '',
    userId: message?.author?.id ?? null,
    displayName: message?.member?.displayName || message?.author?.globalName || message?.author?.username || '',
    userText,
    draft,
    at,
  });
  if (handler) {
    try {
      Promise.resolve(handler(report)).catch(() => {});
    } catch {
      // Delivery belongs to the handler; a report never fails the chat.
    }
  }
  return report;
}

function setBlockedReplyHandler(next) {
  if (next !== null && typeof next !== 'function') throw new TypeError('The blocked reply handler must be a function or null.');
  const previous = handler;
  handler = next;
  return () => {
    if (handler === next) handler = previous;
  };
}

module.exports = {
  BLOCKED_REPLY_STAGES: STAGES,
  reportBlockedReply,
  setBlockedReplyHandler,
};
