const {
  finalizeAssistantReply,
  generateChatReply,
  getDeployedModelIds,
  getProtectedPromptTexts,
  isGuildQuotaExhaustedError,
  isLocalProviderGuardError,
  isProviderRateLimitError,
  QUOTA_EXHAUSTED_MESSAGE,
} = require('./provider');
const { providerCallGuard } = require('./providerGuard');
const { resolveProviderOutput } = require('./jevOutputGate');
const { AI_SPAM_BLOCK_REASONS, aiSpamGuard, isBareCall } = require('./aiSpamGuard');
const { refusalNoticeCap } = require('./refusalNoticeCap');
const {
  DEFAULT_CHAT_STYLE,
  renderChatStyleFallback,
  renderChatStyleInformationalReply,
  resolveUserChatPreference,
} = require('../../services/chatStyleService');
const {
  renderRomanceFallback,
  resolveUserRomancePreference,
} = require('../../services/romanceModeService');
const {
  checkCooldown,
  endConversation,
  hasActiveConversation,
  isConversationSilenced,
  isStopConversationCommand,
  refreshConversation,
  silenceConversation,
  startConversation,
  validateChatInput,
} = require('../../services/conversationModeService');
const { answerMemoryQuery, recordPrivateInteraction } = require('./projection');
const { resolveMemberFacts } = require('./memberFacts');
const {
  INTERNAL_REPLY,
  decideAssistantOutput,
  decideLocalBusyOutput,
  decideRateLimitOutput,
  decideRequestIngress,
  getConversationDecisionPayload,
  getMessageDecisionContext,
  looksLikeInjectionAttempt,
  verifyConversationDecisionContext,
} = require('./disclosurePolicy');
const { ARCHIVE_UNAVAILABLE_REPLY, archiveInteraction, confirmArchiveInteraction,
  markArchivePartialDelivery, preflightArchive } = require('../../services/aiArchiveService');
const { getRecentConversationTurns, rememberConversationTurn } = require('../../services/conversationHistoryService');
const { captureProofFor, isCurrentPublicChannel } = require('./publicVisibility');
const logger = require('../../utils/logger');
const { isEgressRateLimitError } = require('../../platform/egressLimiter');
const { SAFETY_EVENT_CODES, reportSecurityAlert } = require('../../platform/safetyEventCatalog');

const MENTION_OUTCOME = Object.freeze({
  SUPPRESS_PUBLIC_PERSISTENCE: 'suppress_public_persistence',
});

// The weather port: getMentionReply(userText, { guildId }) resolves to the reply to a weather
// question or null; isQuery(userText) says whether a text is one. The second argument of
// getMentionReply is optional context (the server the question was asked in, null in a direct
// message): a port that reads only the text keeps working.
const DEFAULT_WEATHER_PORT = Object.freeze({
  getMentionReply: async () => null,
  isQuery: () => false,
});
const DEFAULT_STATUS_PORT = Object.freeze({
  recordInteraction: async () => undefined,
});

// Both members are required and nothing else is checked: getMentionReply may take the context
// argument or ignore it, so a port written for the text alone is as valid as the default one.
function requireWeatherPort(weatherPort) {
  if (!weatherPort || typeof weatherPort.getMentionReply !== 'function' || typeof weatherPort.isQuery !== 'function') {
    throw new TypeError('Conversation weather port is invalid.');
  }
  return weatherPort;
}

function requireStatusPort(statusPort) {
  if (!statusPort || typeof statusPort.recordInteraction !== 'function') {
    throw new TypeError('Conversation status port is invalid.');
  }
  return statusPort;
}

function isPublicPersistenceSuppressed(result) {
  return result?.outcome === MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE;
}

function createBotMentionPattern(botId) {
  return new RegExp(`<@!?${botId}>`, 'g');
}

function getMentionText(content, botId) {
  const mentionPattern = createBotMentionPattern(botId);

  if (!mentionPattern.test(content)) {
    return null;
  }

  return content.replace(createBotMentionPattern(botId), '').trim();
}

function removeBotMention(content, botId) {
  return String(content || '').replace(createBotMentionPattern(botId), '').trim();
}

function getExplicitCallText(content) {
  const normalized = String(content || '').trim();
  const matched = normalized.match(/^小吉[，,：:\s]*(.*)$/);

  return matched ? matched[1].trim() : null;
}

function getConversationDisplayName(message) {
  const userId = String(message.author?.id || '');
  const candidates = [message.member?.displayName, message.author?.globalName, message.author?.username];

  for (const candidate of candidates) {
    const normalized = String(candidate || '')
      .replace(/<@!?\d{17,20}>/g, '')
      // Invisible format characters (bidirectional overrides, zero-width and tag characters) are dropped.
      .replace(/\p{Cf}/gu, '')
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (normalized && normalized !== userId) {
      return normalized;
    }
  }

  return 'Discord 使用者';
}

function shouldIgnoreChatMessage(message) {
  return Boolean(
    !message?.author ||
      message.author.bot ||
      message.author.id === message.client?.user?.id ||
      message.webhookId ||
      message.system
  );
}

async function isReplyToBot(message, botId) {
  const referencedMessageId = message.reference?.messageId;

  if (!referencedMessageId || !message.channel?.messages?.fetch) {
    return false;
  }

  try {
    const referencedMessage = await message.channel.messages.fetch(referencedMessageId);
    return referencedMessage?.author?.id === botId;
  } catch (error) {
    logger.warn(`failed to inspect referenced message: ${error?.message || error}`);
    return false;
  }
}

function getMentionFallbackReply(
  userText,
  displayName = 'Discord 使用者',
  userId = '',
  chatStyle = DEFAULT_CHAT_STYLE,
  romanceEnabled = false,
  weatherPort = DEFAULT_WEATHER_PORT
) {
  const { isQuery: isWeatherQuery } = requireWeatherPort(weatherPort);
  logger.info('[HELP_FALLBACK] using mention fallback reply');
  const finalizeFallback = (templateName, context = {}) => finalizeAssistantReply(
    renderRomanceFallback(
      renderChatStyleFallback(chatStyle, templateName, { displayName, ...context }),
      { enabled: romanceEnabled, chatStyle, displayName }
    ),
    userId,
    { displayNames: [displayName] }
  );
  // Generic fallback must never mirror arbitrary input, credentials, or injected instructions.
  const safeUserText = '這件事';
  if (!userText) {
    return finalizeFallback('empty');
  }

  const normalized = userText.toLowerCase();

  if (isWeatherQuery(userText)) {
    return finalizeFallback('weather');
  }

  if (userText.includes('你好') || userText.includes('嗨') || normalized.includes('hi')) {
    return finalizeFallback('greeting');
  }

  if (userText.includes('晚安')) {
    return finalizeFallback('goodnight');
  }

  if (userText.includes('你是誰') || userText.includes('你誰') || userText.includes('自我介紹')) {
    return finalizeFallback('identity');
  }

  if (userText.includes('幫我寫公告') || userText.includes('寫公告')) {
    return finalizeFallback('announcement');
  }

  if (userText.includes('幫助') || userText.includes('指令')) {
    return finalizeFallback('help');
  }

  return finalizeFallback('generic', { safeUserText });
}

function finalizeConversationalInformationReply(
  content,
  displayName = 'Discord 使用者',
  userId = '',
  chatStyle = DEFAULT_CHAT_STYLE,
  romanceEnabled = false
) {
  const styledReply = renderChatStyleInformationalReply(chatStyle, content, { displayName });
  const romanticReply = renderRomanceFallback(styledReply, {
    enabled: romanceEnabled,
    chatStyle,
    displayName,
  });
  // Memory and weather replies quote stored user text or service data, not the assistant describing
  // itself, so first-person self-description rules do not apply to them.
  return finalizeAssistantReply(romanticReply, userId, { assistantVoice: false, displayNames: [displayName] });
}

// The romance-mode opener placed before a generated reply ("小明～小吉很喜歡和你這樣甜甜地聊聊 ♡"), or '' when
// romance mode is off. It is program text, so the checks leave it out and read only the model's reply.
function getRomanceReplyPrefix(chatStyle = DEFAULT_CHAT_STYLE, romanceEnabled = false, displayName = 'Discord 使用者') {
  return renderRomanceFallback('', { enabled: romanceEnabled, chatStyle, displayName });
}

// waiveSoft (a Set of soft output rules, see disclosurePolicy.js) is passed only by the optional second opinion.
function finalizeGeneratedConversationalReply(
  content,
  displayName = 'Discord 使用者',
  userId = '',
  chatStyle = DEFAULT_CHAT_STYLE,
  romanceEnabled = false,
  { waiveSoft = null } = {}
) {
  if (content === INTERNAL_REPLY) return INTERNAL_REPLY;
  const romanticReply = renderRomanceFallback(content, {
    enabled: romanceEnabled,
    chatStyle,
    displayName,
  });
  return finalizeAssistantReply(romanticReply, userId, {
    displayNames: [displayName],
    templatePrefix: getRomanceReplyPrefix(chatStyle, romanceEnabled, displayName),
    waiveSoft,
  });
}

// The whole output check of one model reply: the text check, then the decision. Both gates take the same waiveSoft.
// protectedModelIds is the deployed model list unless a caller (a test) supplies its own.
function evaluateProviderReply({
  ingressDecision, reply, displayName, userId, chatStyle, romanceEnabled, waiveSoft = null,
  protectedModelIds = getDeployedModelIds(),
}) {
  const finalReply = finalizeGeneratedConversationalReply(reply, displayName, userId, chatStyle, romanceEnabled, { waiveSoft });
  const decision = decideAssistantOutput({
    ingressDecision,
    rawCandidate: reply,
    styledCandidate: finalReply,
    source: 'provider',
    historyAllowed: true,
    // The exact prompt texts the provider ran under; a reply that copies them is refused.
    protectedInstructions: getProtectedPromptTexts(chatStyle, romanceEnabled),
    // Deployed model identifiers, compared in memory only.
    protectedModelIds,
    // The user's display name is only a name; the romance-mode opener is program text.
    displayNames: [displayName],
    templatePrefix: getRomanceReplyPrefix(chatStyle, romanceEnabled, displayName),
    waiveSoft,
  });
  return { finalReply, decision };
}

function splitReply(content, maxLength = 1800) {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);

    if (splitAt < Math.floor(maxLength * 0.6)) {
      splitAt = remaining.lastIndexOf('。', maxLength);
      if (splitAt >= Math.floor(maxLength * 0.6)) {
        splitAt += 1;
      }
    }

    if (splitAt < Math.floor(maxLength * 0.6)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function replyInChunks(message, content, { onChunkDelivered } = {}) {
  const [firstChunk, ...restChunks] = splitReply(content);

  try {
    await message.reply({
      content: firstChunk,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    });
  } catch (error) {
    if (isEgressRateLimitError(error)) return false;
    const referenceErrors = error?.rawError?.errors?.message_reference?._errors;
    const hasUnknownReferenceCode = Array.isArray(referenceErrors)
      ? referenceErrors.some((entry) => entry?.code === 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE')
      : false;
    const hasUnknownReferenceMessage = /MESSAGE_REFERENCE_UNKNOWN_MESSAGE/.test(String(error?.message || ''));

    if (Number(error?.code) !== 50035 || (!hasUnknownReferenceCode && !hasUnknownReferenceMessage)) {
      throw error;
    }

    logger.warn('[CHAT_REPLY_FALLBACK] Source message is unavailable; sending an unreferenced channel message.');
    try {
      await message.channel.send({
        content: firstChunk,
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      });
    } catch (error) {
      if (isEgressRateLimitError(error)) return false;
      throw error;
    }
  }

  onChunkDelivered?.();

  for (const chunk of restChunks) {
    try {
      await message.channel.send({
        content: chunk,
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      });
    } catch (error) {
      if (isEgressRateLimitError(error)) return false;
      throw error;
    }
    onChunkDelivered?.();
  }
  return true;
}

function getPriorUserStatements(message) {
  const identity = {
    userId: message.author.id,
    guildId: message.guildId,
    channelId: message.channelId,
  };
  if (!message.guildId) {
    return getRecentConversationTurns(identity).map((turn) => turn.user).filter(Boolean);
  }
  const hasCurrentPublicProof = isCurrentPublicChannel(message) && Boolean(captureProofFor(message));
  return hasCurrentPublicProof
    ? getRecentConversationTurns(identity, { requirePublicCapture: true }).map((turn) => turn.user).filter(Boolean)
    : [];
}

// Replies sent before the main flow (stop acknowledgement, oversized input, confidentiality refusal,
// archive unavailable) spend the same per-channel cooldown and per-user provider guard budget as a
// normal reply, so repeating them cannot bypass rate limits. A blocked attempt is dropped silently.
// Neither limit exempts the owner. A provider call that is merely in flight does not block them.
function admitPreflightReply(message, userText) {
  const scope = `guild=${message.guildId || 'dm'} channel=${message.channelId} user=${message.author.id}`;
  if (!checkCooldown(message).ok) {
    logger.info(`[CHAT_COOLDOWN] ${scope} preflight=true`);
    return false;
  }
  try {
    providerCallGuard.admit({
      userId: message.author.id,
      guildId: message.guildId ?? null,
      channelId: message.channelId,
    }, userText);
    return true;
  } catch (error) {
    if (!isLocalProviderGuardError(error)) throw error;
    logger.info(`[CHAT_PREFLIGHT_GUARD] ${scope} reason=${error.reason}`);
    return false;
  }
}

// Reports a security alert for a message: where it was written and by whom, never what it said. The notifier
// sends it only from the host's operation for that message (safetyEventCatalog.js reportSecurityAlert).
function reportMessageSecurityAlert(kind, message) {
  return reportSecurityAlert(kind, {
    guildId: message.guildId ?? null,
    guildName: message.guild?.name ?? '',
    actorId: message.author?.id ?? null,
    channelId: message.channelId ?? null,
    messageId: message.id ?? null,
  });
}

function hasStickerOrFile(message) {
  return Number(message.stickers?.size) > 0 || Number(message.attachments?.size) > 0;
}

// A request the anti-spam gate blocked (aiSpamGuard.js): no model call, no provider guard count, no
// archive, history, statistics or public memory, and no safety event. The member gets the gate's fixed
// notice when it allows one, sent through the same egress guard and output rate limit as every reply; a
// notice that cannot be sent is only logged, and the request stays out of persistence either way.
async function replyToBlockedRequest(message, verdict) {
  // Only a flood of a channel, or a member who has just been put on cooldown, is an attack worth telling the Owner
  // of; a meaningless message, one repeat or a bare call is routine and is not.
  if (verdict.reason === AI_SPAM_BLOCK_REASONS.CHANNEL_FLOOD || verdict.cooldownStarted === true) {
    reportMessageSecurityAlert('flood', message);
  }
  if (verdict.cooldownStarted) endConversation(message);
  if (verdict.notice) {
    try {
      await replyInChunks(message, verdict.notice);
    } catch {
      aiSpamGuard.reportNoticeFailure();
    }
  }
  return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
}

async function sendUnpersistedDecision(message, decision) {
  const payload = getConversationDecisionPayload(decision);
  if (payload.archiveAllowed || payload.historyAllowed || payload.privateMemoryAllowed) {
    throw new TypeError('Unpersisted output must not carry persistence authority.');
  }
  verifyConversationDecisionContext(decision, getMessageDecisionContext(message), 'send');
  await replyInChunks(message, payload.text);
  return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
}

async function handleMentionMessage(message, {
  generateChatReplyImpl = generateChatReply,
  weatherPort = DEFAULT_WEATHER_PORT,
  statusPort = DEFAULT_STATUS_PORT,
  // The optional second opinion ({ config, judgeAssistantReply }); undefined uses the one the environment configures.
  jevRuntime = undefined,
} = {}) {
  const activeWeatherPort = requireWeatherPort(weatherPort);
  const activeStatusPort = requireStatusPort(statusPort);
  if (shouldIgnoreChatMessage(message)) {
    return;
  }

  const botId = message.client.user?.id;

  if (!botId) {
    return;
  }

  const mentionedText = getMentionText(message.content, botId);
  const explicitCallText = getExplicitCallText(message.content);
  const isReply = await isReplyToBot(message, botId);
  const isMentioned = mentionedText !== null;
  const isExplicitCall = explicitCallText !== null;
  const isActiveConversation = hasActiveConversation(message);

  if (!isMentioned && !isExplicitCall && !isReply && !isActiveConversation) {
    return;
  }

  if (!isMentioned && !isExplicitCall && !isReply && isConversationSilenced(message)) {
    return;
  }

  const userText = isMentioned ? mentionedText : isExplicitCall ? explicitCallText : removeBotMention(message.content, botId);
  const isStopCommand = isStopConversationCommand(userText);

  // Silencing always applies; only the acknowledgement is rate limited.
  if (isStopCommand) silenceConversation(message);

  const inputValidation = !isStopCommand && userText ? validateChatInput(userText) : { ok: true };

  // A message meant for someone else, or nothing but spaces, is not a request: nothing counts it.
  if (!inputValidation.ok && !inputValidation.message) return;

  // A bare mention, or a message that is only 小吉, with nothing after it but punctuation or emoji ("小吉！",
  // "@小吉 ~", "小吉..."; no sticker or file): not a request for the model and not counted against the
  // member. It may get a fixed line, which also opens a conversation so that the next message needs no
  // mention. One to three question marks ("小吉？") still ask something, so they are a request.
  if ((isMentioned || isExplicitCall) && isBareCall(userText) && !hasStickerOrFile(message)) {
    const presence = aiSpamGuard.evaluatePresence({
      guildId: message.guildId ?? null,
      channelId: message.channelId,
      userId: message.author.id,
    });
    if (presence.notice && presence.reason === 'presence') startConversation(message);
    return replyToBlockedRequest(message, presence);
  }

  // A reply to 小吉 with only punctuation or emoji (no sticker or file) is a reaction, not a request: it is
  // ignored without a word, never counted against the member and never sent to the model.
  if (isReply && isBareCall(userText) && !hasStickerOrFile(message)) {
    return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
  }

  // Every request passes the anti-spam gate before anything else that costs (see replyToBlockedRequest).
  const spamVerdict = aiSpamGuard.evaluate({
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    userId: message.author.id,
    text: userText,
    explicit: isMentioned || isExplicitCall || isReply,
  });
  if (!spamVerdict.allowed) return replyToBlockedRequest(message, spamVerdict);
  // A request that ends without an answer is taken back out of the repeat history, so sending it again is
  // not "said before" (it still counted toward the rate limits).
  const unanswered = () => aiSpamGuard.forgetRepeat(spamVerdict.ticket);

  if (isStopCommand) {
    if (admitPreflightReply(message, userText)) {
      await replyInChunks(message, '好，我先安靜。');
    } else {
      unanswered();
    }
    return;
  }

  if (!inputValidation.ok) {
    if (inputValidation.message && admitPreflightReply(message, userText)) {
      await replyInChunks(message, inputValidation.message);
    } else {
      unanswered();
    }
    return;
  }

  const ingressDecision = decideRequestIngress({
    userText,
    priorUserStatements: getPriorUserStatements(message),
    context: getMessageDecisionContext(message),
  });
  if (ingressDecision.kind === 'refusal') {
    // The refusal keeps its log line and observation (refusalNoticeCap.js); the Owner is told by a security alert,
    // one fixed notice per guild, kind and hour: a request shaped like a role or authority override is a prompt
    // injection, any other refused request asked for the bot's internals.
    refusalNoticeCap.report(ingressDecision.reason === 'sensitive_request'
      ? SAFETY_EVENT_CODES.AI_PROMPT_INJECTION_BLOCKED : SAFETY_EVENT_CODES.AI_REQUEST_REFUSED, {
      actorId: message.author?.id, guildId: message.guildId, channelId: message.channelId, messageId: message.id,
    });
    reportMessageSecurityAlert(looksLikeInjectionAttempt(userText) ? 'prompt-injection' : 'dev-info', message);
    // A suppressed refusal still keeps the request out of public persistence.
    if (!admitPreflightReply(message, userText)) {
      unanswered();
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    const refusal = decideAssistantOutput({ ingressDecision, rawCandidate: INTERNAL_REPLY });
    return sendUnpersistedDecision(message, refusal);
  }

  if (!await preflightArchive(message.client)) {
    unanswered();
    if (admitPreflightReply(message, userText)) {
      await replyInChunks(message, ARCHIVE_UNAVAILABLE_REPLY);
    }
    return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
  }

  const cooldown = checkCooldown(message);

  if (!cooldown.ok) {
    unanswered();
    logger.info(
      `[CHAT_COOLDOWN] guild=${message.guildId || 'dm'} channel=${message.channelId} user=${message.author.id}`
    );
    return;
  }

  if (isMentioned || isExplicitCall || isReply) {
    startConversation(message);
  } else {
    refreshConversation(message);
  }

  logger.info(
    `[chat] mode=${isMentioned ? 'mention' : isExplicitCall ? 'explicit' : isReply ? 'reply' : 'continuous'} guild=${
      message.guildId || 'dm'
    } channel=${message.channelId} user=${message.author.tag}`
  );

  const displayName = getConversationDisplayName(message);
  const [chatPreference, romancePreference] = await Promise.all([
    resolveUserChatPreference(message.author.id),
    resolveUserRomancePreference(message.author.id),
  ]);

  const sendDecision = async (decision) => {
    const payload = getConversationDecisionPayload(decision);
    verifyConversationDecisionContext(decision, getMessageDecisionContext(message), 'send');
    // The reply the model wrote was turned into the fixed refusal because it leaked what it must not say.
    if (payload.kind === 'refusal') reportMessageSecurityAlert('output-guard', message);
    if (!payload.archiveAllowed) return sendUnpersistedDecision(message, decision);
    const saved = await archiveInteraction(message, decision);
    if (!saved) {
      unanswered();
      await replyInChunks(message, ARCHIVE_UNAVAILABLE_REPLY);
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    let deliveredChunks = 0;
    let delivered;
    try {
      delivered = await replyInChunks(message, payload.text, { onChunkDelivered: () => { deliveredChunks += 1; } });
    } catch (error) {
      if (deliveredChunks > 0) await markArchivePartialDelivery(message);
      throw error;
    }
    if (!delivered) {
      // The output rate limit held back a part: the reply did not fully reach the channel, so it is
      // neither confirmed in the archive nor written to history, statistics or private memory.
      unanswered();
      if (deliveredChunks > 0) await markArchivePartialDelivery(message);
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    if (!await confirmArchiveInteraction(message, decision)) {
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    if (payload.historyAllowed) {
      const persistence = await rememberConversationTurn({
        userId: message.author.id, guildId: message.guildId, channelId: message.channelId,
      }, decision, new Date(), { captureMessage: message });
      if (!persistence.persisted) logger.warn(`[NORMAL_CHAT] Prompt projection was not persisted: ${persistence.reason}`);
    }
    await activeStatusPort.recordInteraction();
    if (payload.privateMemoryAllowed) {
      recordPrivateInteraction({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        displayName,
        decision,
        message,
      });
    }
    return payload.publicPersistenceAllowed
      ? undefined
      : { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
  };

  if (ingressDecision.kind === 'public_fact') {
    return sendDecision(decideAssistantOutput({
      ingressDecision,
      rawCandidate: ingressDecision.publicFact.text,
      publicFact: ingressDecision.publicFact,
      source: 'public_fact',
    }));
  }

  const memberResult = await resolveMemberFacts(message, userText);
  if (memberResult.reply) return sendDecision(decideAssistantOutput({
    ingressDecision,
    rawCandidate: memberResult.reply,
    source: 'member_fact',
  }));

  const memoryReply = answerMemoryQuery({ text: userText, message });

  if (memoryReply) {
    const finalMemoryReply = finalizeConversationalInformationReply(
      memoryReply,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    );
    return sendDecision(decideAssistantOutput({
      ingressDecision,
      rawCandidate: memoryReply,
      styledCandidate: finalMemoryReply,
      source: 'memory',
      displayNames: [displayName],
    }));
  }

  // The server is passed along so a question that names no place can use the server's default city.
  const weatherReply = await activeWeatherPort.getMentionReply(userText, { guildId: message.guildId ?? null });

  if (weatherReply) {
    const finalWeatherReply = finalizeConversationalInformationReply(
      weatherReply,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    );
    return sendDecision(decideAssistantOutput({
      ingressDecision,
      rawCandidate: weatherReply,
      styledCandidate: finalWeatherReply,
      source: 'weather',
      displayNames: [displayName],
    }));
  }

  let reply;
  let providerRateLimitError = null;
  let localProviderGuardError = null;
  let guildQuotaExhausted = false;
  try {
    reply = await generateChatReplyImpl({
      userText,
      displayName,
      userId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
      chatStyle: chatPreference.style,
      romanceEnabled: romancePreference.enabled,
      memberFacts: memberResult.facts,
      ingressDecision,
      message,
    });
  } catch (error) {
    if (isProviderRateLimitError(error)) {
      providerRateLimitError = error;
    } else if (isLocalProviderGuardError(error)) {
      localProviderGuardError = error;
    } else if (isGuildQuotaExhaustedError(error)) {
      guildQuotaExhausted = true;
    } else {
      logger.warn(`[AI_CHAT_FAILED] code=${String(error?.code || 'unknown').slice(0, 80)}`);
    }
  }

  // No answer from the model: the provider's own limit, the guild quota, the provider guard, or a failed call
  // (a fixed fallback reply follows).
  if (!reply) unanswered();
  if (providerRateLimitError) {
    return sendUnpersistedDecision(message, decideRateLimitOutput(ingressDecision));
  }
  // The guild's AI quota is used up and the model was not called: a fixed line, nothing persisted.
  if (guildQuotaExhausted) {
    await replyInChunks(message, QUOTA_EXHAUSTED_MESSAGE);
    return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
  }
  if (localProviderGuardError) {
    if (!localProviderGuardError.shouldNotify) {
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    return sendUnpersistedDecision(message, decideLocalBusyOutput(ingressDecision));
  }

  if (reply) {
    // The one place the optional second opinion can matter (see jevOutputGate.js). With it off, or for a server
    // that is not listed, this is the single check it always was.
    const output = await resolveProviderOutput({
      evaluate: (waiveSoft) => evaluateProviderReply({
        ingressDecision,
        reply,
        displayName,
        userId: message.author.id,
        chatStyle: chatPreference.style,
        romanceEnabled: romancePreference.enabled,
        waiveSoft,
      }),
      userText,
      replyText: reply,
      displayNames: [displayName],
      guildId: message.guildId ?? null,
      runtime: jevRuntime,
    });
    return sendDecision(output.decision);
  }

  const finalReply = getMentionFallbackReply(
    userText,
    displayName,
    message.author.id,
    chatPreference.style,
    romancePreference.enabled,
    activeWeatherPort
  );
  return sendDecision(decideAssistantOutput({
    ingressDecision,
    rawCandidate: finalReply,
    styledCandidate: finalReply,
    source: 'fallback',
    historyAllowed: false,
    // The exact prompt texts the provider ran under; a reply that copies them is refused.
    protectedInstructions: getProtectedPromptTexts(chatPreference.style, romancePreference.enabled),
    // Deployed model identifiers, compared in memory only.
    protectedModelIds: getDeployedModelIds(),
    // The user's display name is only a name; the romance-mode opener is program text.
    displayNames: [displayName],
    templatePrefix: '',
  }));
}

module.exports = {
  MENTION_OUTCOME,
  evaluateProviderReply,
  finalizeGeneratedConversationalReply,
  getRomanceReplyPrefix,
  finalizeConversationalInformationReply,
  getConversationDisplayName,
  getMentionFallbackReply,
  getExplicitCallText,
  getMentionText,
  handleMentionMessage,
  isPublicPersistenceSuppressed,
  replyInChunks,
  splitReply,
};
