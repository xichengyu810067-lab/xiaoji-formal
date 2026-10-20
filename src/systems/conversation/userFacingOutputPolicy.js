const {
  CONVERSATION_SAFETY_EVENT_CODES,
  emitConversationSafetyEvent,
} = require('./safetyEvents');
const { getApprovedPublicRelease } = require('./publicFacts');
const { reportSecurityAlert } = require('../../platform/safetyEventCatalog');
const linkPolicy = require('../../platform/linkPolicy');
const { observe } = require('../../platform/testControlObservation');
const { createFixedCodeLog } = require('./fixedCodeLog');

const { BLOCKED_LINK_REPLACEMENT } = linkPolicy;
const BLOCKED_MENTION_REPLACEMENT = '[提及已移除]';
// AI replies may link to the fixed public pages and to the one approved release, never to another tag.
const chatLinkApproval = linkPolicy.createLinkApproval({
  approvedReleaseTag: getApprovedPublicRelease().tag,
  releaseTags: 'approved',
});

const APPROVED_USER_FACING_URLS = chatLinkApproval.rules;

const DISCORD_MENTION = /@(?:everyone|here)\b|<@(?:[!&])?[^>\r\n]{1,100}>/giu;

function approvedUrl(value) {
  return chatLinkApproval.approve(value);
}

function containsUnapprovedXiaojiReleaseUrl(value) {
  return linkPolicy.containsUnapprovedXiaojiReleaseUrl(value, approvedUrl);
}

// A reply cleaned before it is sent still goes out, so this is routine, not a matter for the Owner: the
// safety catalogue does not send these two codes as a DM of their own (notifiesOwner). What is left of them is a
// fixed-code log line, at most one per code a minute (the lines left out are counted on the next one),
// a test-control observation, and the conversation safety event itself. The clean-up is also reported as a
// security alert of kind output-guard: it is noisy (a member only has to ask for a link), so the Owner hears of it
// at most once an hour per guild (ownerSafetyNotifier.js).
const OUTPUT_OBSERVATIONS = Object.freeze({
  [CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_URL_BLOCKED]: 'TEST_OBS_AI_OUTPUT_URL_BLOCKED',
  [CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_MENTION_BLOCKED]: 'TEST_OBS_AI_OUTPUT_MENTION_BLOCKED',
});
const outputLog = createFixedCodeLog();

// securityAlert false keeps the log line, the observation and the conversation event but raises no security alert:
// for text that is not the AI's reply to a member (the weather command's third-party data), where a link in it says
// nothing about an attack.
function reportOutputCleanup(code, context, { securityAlert = true } = {}) {
  observe(OUTPUT_OBSERVATIONS[code]);
  outputLog.write(code, 'warn', `[AI_OUTPUT] code=${code}`);
  const event = emitConversationSafetyEvent(code, context);
  if (securityAlert) {
    reportSecurityAlert('output-guard', {
      guildId: event.guildId, actorId: event.actorId, channelId: event.channelId, messageId: event.messageId,
    });
  }
  return event;
}

function sanitizeUserFacingOutput(value, { context = {}, securityAlert = true,
  emit = (code, eventContext) => reportOutputCleanup(code, eventContext, { securityAlert }) } = {}) {
  // bareDomains: a name written without a scheme (free-nitro.com/claim) may be shown as a link in Discord
  // too, and a member can ask the AI to repeat one. It is cleaned and reported like any other URL.
  const links = linkPolicy.rewriteLinks(String(value || ''), {
    approve: chatLinkApproval.approve, maskedLink: 'label', bareDomains: true,
  });
  let text = links.text;
  let mentionBlocked = false;

  text = text.replace(DISCORD_MENTION, () => {
    mentionBlocked = true;
    return BLOCKED_MENTION_REPLACEMENT;
  });

  if (links.rewritten) emit(CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_URL_BLOCKED, context);
  if (mentionBlocked) emit(CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_MENTION_BLOCKED, context);
  return text.trim() || '這段內容目前無法安全顯示。';
}

module.exports = {
  APPROVED_USER_FACING_URLS,
  BLOCKED_LINK_REPLACEMENT,
  BLOCKED_MENTION_REPLACEMENT,
  approvedUrl,
  containsUnapprovedXiaojiReleaseUrl,
  sanitizeUserFacingOutput,
};
