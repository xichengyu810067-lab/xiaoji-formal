const {
  AI_PROVIDER_RATE_LIMIT_REPLY,
  finalizeAssistantReply,
  generateChatReply,
  isProviderRateLimitError,
} = require('./aiService');
const {
  DEFAULT_CHAT_STYLE,
  renderChatStyleFallback,
  renderChatStyleInformationalReply,
  resolveUserChatPreference,
} = require('./chatStyleService');
const {
  renderRomanceFallback,
  resolveUserRomancePreference,
} = require('./romanceModeService');
const {
  checkCooldown,
  hasActiveConversation,
  isConversationSilenced,
  isStopConversationCommand,
  refreshConversation,
  silenceConversation,
  startConversation,
  validateChatInput,
} = require('./conversationModeService');
const { answerMemoryQuery, recordPrivateInteraction } = require('./memoryService');
const { WeatherError, getWeather } = require('./weatherService');
const { parseWeatherQuery } = require('../utils/weatherNLP');
const logger = require('../utils/logger');
const { recordPublicInteraction } = require('./publicStatusService');

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

function getAdvice(weather) {
  const advice = [];

  if (weather.tempMaxRaw >= 30) {
    advice.push('天氣炎熱，請注意防曬並多補充水分');
  } else if (weather.tempMinRaw <= 15) {
    advice.push('天氣偏冷，出門請記得穿暖一點');
  } else {
    advice.push('氣溫舒適，出門保持一般準備就可以');
  }

  if (weather.popRaw > 0.4) {
    advice.push('降雨機率偏高，建議帶傘');
  } else if (weather.popRaw > 0.1) {
    advice.push('有一點降雨機率，可以視情況帶傘');
  }

  return `${advice.join('，')}。`;
}

function formatWeatherReply(weather, timeStr, suggest) {
  let reply = '';
  if (suggest) {
    reply += `我先幫你查${weather.city}的天氣；如果之後 API 支援行政區，可以再精準到該區，或者你可以說${suggest}天氣。\n\n`;
  }

  if (weather.isWeek) {
    return `${weather.city}未來一週天氣：\n${weather.weekSummary}`;
  }

  reply += `${weather.city}${timeStr}天氣：\n\n`;
  reply += `天氣狀況：${weather.description}\n`;
  reply += `氣溫：${weather.tempMin} ~ ${weather.tempMax}\n`;

  if (weather.pop) {
    reply += `降雨機率：${weather.pop}\n`;
  }

  reply += `體感提醒：${getAdvice(weather)}`;

  return reply;
}

function logWeatherDebug(debug) {
  logger.info(
    [
      `[weather:${debug.source}] raw="${debug.raw}"`,
      `cleaned="${debug.cleaned}"`,
      `normalized="${debug.normalized}"`,
      `intent=${debug.isWeatherIntent}`,
      `city="${debug.city || ''}"`,
      `district="${debug.district || ''}"`,
      `final="${debug.finalLocation || ''}"`,
      `api="${debug.apiLocation || ''}"`,
    ].join(' ')
  );
}

async function getWeatherMentionReply(userText) {
  const query = parseWeatherQuery(userText);
  if (!query) {
    return null;
  }

  logWeatherDebug(query.debug);

  if (query.ambiguous) {
    const examples = query.candidates?.slice(0, 4).join('、') || '臺北市大同區、新竹市東區、臺南市東區';
    return `這個地名有點模糊，你可以補上縣市嗎？例如：${examples}`;
  }

  if (!query.location) {
    return '你想查哪裡的天氣呢？例如：臺北市大同區天氣、新北新莊天氣、臺南東區天氣。';
  }

  try {
    const weather = await getWeather(query.apiLocation || query.location, query.time);

    const timeLabels = {
      today: '今天',
      tomorrow: '明天',
      day_after_tomorrow: '後天',
      week: '一週',
      weekend: '週末',
    };
    const timeStr = timeLabels[query.time] || '今天';

    return formatWeatherReply(weather, timeStr, query.suggest);
  } catch (error) {
    if (error instanceof WeatherError && error.code === 'missing_api_key') {
      return '小吉有查詢天氣功能，但目前還沒設定 `OPENWEATHER_API_KEY`。請在 `.env` 補上後重新啟動小吉。';
    }

    if (error instanceof WeatherError && error.code === 'unauthorized') {
      return '小吉有查詢天氣功能，但 OpenWeather API key 目前無效或尚未啟用。請確認 `.env` 的 `OPENWEATHER_API_KEY` 是正確 key，儲存後重新啟動小吉。';
    }

    if (error instanceof WeatherError && error.code === 'city_not_found') {
      return '我找不到這個地名的天氣資料。請試著補上縣市與行政區，例如：臺北市大同區天氣。';
    }

    logger.warn(`weather mention failed: ${error?.message || error}`);
    return '我剛剛有抓到地點，但天氣資料查詢失敗。可能是 API 暫時沒有回應，請稍後再試。';
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

  const query = parseWeatherQuery(userText);
  if (query) {
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

async function replyInChunks(message, content) {
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

  for (const chunk of restChunks) {
    await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

async function handleMentionMessage(message) {
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

  if (memoryReply) {
    const finalMemoryReply = finalizeConversationalInformationReply(
      memoryReply,
      displayName,
      message.author.id,
      chatPreference.style,
      romancePreference.enabled
    );
    await replyInChunks(message, finalMemoryReply);
    await recordPublicInteraction();
    recordPrivateInteraction({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      displayName,
      userText,
      assistantText: finalMemoryReply,
    });
    return;
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
    await replyInChunks(message, finalWeatherReply);
    await recordPublicInteraction();
    recordPrivateInteraction({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      displayName,
      userText,
      assistantText: finalWeatherReply,
    });
    return;
  }

  let reply;
  let providerRateLimitError = null;
  try {
    reply = await generateChatReply({
      userText,
      displayName,
      userId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
      chatStyle: chatPreference.style,
      romanceEnabled: romancePreference.enabled,
    });
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
  await replyInChunks(message, finalReply);
  await recordPublicInteraction();
  recordPrivateInteraction({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    displayName,
    userText,
    assistantText: finalReply,
  });
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
