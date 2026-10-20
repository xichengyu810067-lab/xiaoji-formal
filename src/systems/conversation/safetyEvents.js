const CONVERSATION_SAFETY_EVENT_CODES = Object.freeze({
  PROVIDER_DUPLICATE: 'AI_GUARD_DUPLICATE',
  PROVIDER_GLOBAL_BUSY: 'AI_GUARD_GLOBAL_BUSY',
  PROVIDER_TIMEOUT: 'AI_GUARD_TIMEOUT',
  PROVIDER_USER_BUSY: 'AI_GUARD_USER_BUSY',
  PROVIDER_USER_RATE: 'AI_GUARD_USER_RATE',
  OUTPUT_MENTION_BLOCKED: 'AI_OUTPUT_MENTION_BLOCKED',
  OUTPUT_URL_BLOCKED: 'AI_OUTPUT_URL_BLOCKED',
});

const knownCodes = new Set(Object.values(CONVERSATION_SAFETY_EVENT_CODES));
let safetyEventHandler = null;

function normalizeEventContext(context = {}) {
  return Object.freeze({
    actorId: context.actorId ? String(context.actorId) : null,
    guildId: context.guildId ? String(context.guildId) : null,
    channelId: context.channelId ? String(context.channelId) : null,
    messageId: context.messageId ? String(context.messageId) : null,
  });
}

function emitConversationSafetyEvent(code, context = {}, at = Date.now()) {
  if (!knownCodes.has(code)) throw new TypeError('Unknown conversation safety event code.');
  const normalized = normalizeEventContext(context);
  const event = Object.freeze({ code, at: Number(at), ...normalized });
  if (safetyEventHandler) {
    try {
      safetyEventHandler(event);
    } catch {
      // This callback only reports a fail-safe event; notification delivery is owned elsewhere.
    }
  }
  return event;
}

function setConversationSafetyEventHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('Conversation safety event handler must be a function or null.');
  }
  const previous = safetyEventHandler;
  safetyEventHandler = handler;
  return () => {
    if (safetyEventHandler === handler) safetyEventHandler = previous;
  };
}

function clearConversationSafetyEventHandlerForTests() {
  safetyEventHandler = null;
}

module.exports = {
  CONVERSATION_SAFETY_EVENT_CODES,
  clearConversationSafetyEventHandlerForTests,
  emitConversationSafetyEvent,
  setConversationSafetyEventHandler,
};
