const {
  AI_PROVIDER_RATE_LIMIT_REPLY,
  finalizeAssistantReply,
  generateChatReply,
  isProviderRateLimitError,
} = require('./provider');
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
  hasActiveConversation,
  isConversationSilenced,
  isStopConversationCommand,
  refreshConversation,
  silenceConversation,
  startConversation,
  validateChatInput,
} = require('../../services/conversationModeService');
const { answerMemoryQuery, recordPrivateInteraction } = require('./projection');
const { ARCHIVE_UNAVAILABLE_REPLY, archiveInteraction, confirmArchiveInteraction,
  markArchivePartialDelivery, preflightArchive } = require('../../services/aiArchiveService');
const { rememberConversationTurn } = require('../../services/conversationHistoryService');
const { getWeatherMentionReply, isWeatherQuery, recordConversationInteraction } = require('../../coordinators/conversationCoordinator');
const logger = require('../../utils/logger');

const MENTION_OUTCOME = Object.freeze({
  SUPPRESS_PUBLIC_PERSISTENCE: 'suppress_public_persistence',
});

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
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
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
  romanceEnabled = false
) {
  logger.info('[HELP_FALLBACK] using mention fallback reply');
  const finalizeFallback = (templateName, context = {}) => finalizeAssistantReply(
    renderRomanceFallback(
      renderChatStyleFallback(chatStyle, templateName, { displayName, ...context }),
      { enabled: romanceEnabled, chatStyle, displayName }
    ),
    userId
  );
  const safeUserText = String(userText || '')
    .split(String(userId || '').trim() || '\0')
    .join('[內部識別碼已隱藏]')
    .replace(/\b\d{17,20}\b/g, '[Discord 識別碼已隱藏]');
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
  return finalizeAssistantReply(romanticReply, userId);
}

function finalizeGeneratedConversationalReply(
  content,
  displayName = 'Discord 使用者',
  userId = '',
  chatStyle = DEFAULT_CHAT_STYLE,
  romanceEnabled = false
) {
  const romanticReply = renderRomanceFallback(content, {
    enabled: romanceEnabled,
    chatStyle,
    displayName,
  });
  return finalizeAssistantReply(romanticReply, userId);
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
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    const referenceErrors = error?.rawError?.errors?.message_reference?._errors;
    const hasUnknownReferenceCode = Array.isArray(referenceErrors)
      ? referenceErrors.some((entry) => entry?.code === 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE')
      : false;
    const hasUnknownReferenceMessage = /MESSAGE_REFERENCE_UNKNOWN_MESSAGE/.test(String(error?.message || ''));

    if (Number(error?.code) !== 50035 || (!hasUnknownReferenceCode && !hasUnknownReferenceMessage)) {
      throw error;
    }

    logger.warn('[CHAT_REPLY_FALLBACK] Source message is unavailable; sending an unreferenced channel message.');
    await message.channel.send({
      content: firstChunk,
      allowedMentions: { parse: [] },
    });
  }

  onChunkDelivered?.();

  for (const chunk of restChunks) {
    await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    onChunkDelivered?.();
  }
}

async function handleMentionMessage(message, { generateChatReplyImpl = generateChatReply } = {}) {
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

  if (isStopConversationCommand(userText)) {
    silenceConversation(message);
    await replyInChunks(message, '好，我先安靜。');
    return;
  }

  const inputValidation = userText ? validateChatInput(userText) : { ok: true };

  if (!inputValidation.ok) {
    if (inputValidation.message) {
      await replyInChunks(message, inputValidation.message);
    }
    return;
  }

  if (!await preflightArchive(message.client)) {
    await replyInChunks(message, ARCHIVE_UNAVAILABLE_REPLY);
    return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
  }

  const cooldown = checkCooldown(message);

  if (!cooldown.ok) {
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

  const memoryReply = answerMemoryQuery({ text: userText, message });

  const sendSavedReply = async (content, { rememberPrompt = false } = {}) => {
    const saved = await archiveInteraction(message, { userText, assistantText: content });
    if (!saved) {
      await replyInChunks(message, ARCHIVE_UNAVAILABLE_REPLY);
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    let deliveredChunks = 0;
    try {
      await replyInChunks(message, content, { onChunkDelivered: () => { deliveredChunks += 1; } });
    } catch (error) {
      if (deliveredChunks > 0) await markArchivePartialDelivery(message);
      throw error;
    }
    if (!await confirmArchiveInteraction(message, { userText, assistantText: content })) {
      return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
    }
    if (rememberPrompt) {
      const persistence = await rememberConversationTurn({
        userId: message.author.id, guildId: message.guildId, channelId: message.channelId,
      }, userText || '', content);
      if (!persistence.persisted) logger.warn(`[NORMAL_CHAT] Prompt projection was not persisted: ${persistence.reason}`);
    }
    await recordConversationInteraction();
    recordPrivateInteraction({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      displayName,
      userText,
      assistantText: content,
    });
    return undefined;
  };

  if (memoryReply) {
    const finalMemoryReply = finalizeConversationalInformationReply(
      memoryReply,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    );
    return sendSavedReply(finalMemoryReply);
  }

  const weatherReply = await getWeatherMentionReply(userText);

  if (weatherReply) {
    const finalWeatherReply = finalizeConversationalInformationReply(
      weatherReply,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    );
    return sendSavedReply(finalWeatherReply);
  }

  let reply;
  let providerRateLimitError = null;
  try {
    reply = await generateChatReplyImpl({
      userText,
      displayName,
      userId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
      chatStyle: chatPreference.style,
      romanceEnabled: romancePreference.enabled,
    }, { persistConversation: false });
  } catch (error) {
    if (isProviderRateLimitError(error)) {
      providerRateLimitError = error;
    } else {
      logger.error('AI mention reply failed', error);
    }
  }

  if (providerRateLimitError) {
    await replyInChunks(message, AI_PROVIDER_RATE_LIMIT_REPLY);
    return { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE };
  }

  const finalReply = reply
    ? finalizeGeneratedConversationalReply(
      reply,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    )
    : getMentionFallbackReply(
      userText,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    );
  return sendSavedReply(finalReply, { rememberPrompt: Boolean(reply) });
}

module.exports = {
  MENTION_OUTCOME,
  finalizeGeneratedConversationalReply,
  finalizeConversationalInformationReply,
  getConversationDisplayName,
  getMentionFallbackReply,
  getExplicitCallText,
  getMentionText,
  getWeatherMentionReply,
  handleMentionMessage,
  isPublicPersistenceSuppressed,
  replyInChunks,
  splitReply,
};
