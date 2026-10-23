// The one-time notice and choice for preference memory (preferenceMemory.js): on a member's first AI chat after the
// feature is configured, 小吉 says it remembers preferences, points to /memory, and asks with two buttons whether
// the memory may be public (shared by every server). Only that member can press them; not pressing keeps it private.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getConsent, isMemoryConfigured, updateConsent } = require('./preferenceMemory');
const logger = require('../../utils/logger');

const CUSTOM_ID_PREFIX = 'memconsent|1|';
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });
const CONSENT_TEXT = [
  '小吉會默默記住你在聊天中提到的喜好，讓之後的對話更貼心；你可以隨時用 /memory 查看、修改、刪除或停止記憶。',
  '**是否允許小吉公開聊天記憶？**',
  '-# 請注意，公開後小吉所在的所有伺服器（包含私訊）均會公開，不存在部分公開、部分不公開的情形。選擇不公開時，每個伺服器的記憶各自分開。',
].join('\n');
// Members being asked right now, so two quick chats do not ask twice.
const asking = new Set();

function consentPayload(userId) {
  return {
    content: CONSENT_TEXT,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}public|${userId}`).setLabel('允許公開').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}private|${userId}`).setLabel('不公開').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: NO_MENTIONS,
  };
}

// send(payload) posts the notice where the member is chatting. Asked at most once per member, ever: the time it
// was asked is saved before it is sent, so a failed send is not retried on every chat.
async function maybeOfferMemoryConsent(userId, send, { now = Date.now() } = {}) {
  if (!userId || !isMemoryConfigured() || asking.has(userId)) return false;
  asking.add(userId);
  try {
    const consent = await getConsent(userId);
    if (!consent || consent.promptedAt !== null) return false;
    await updateConsent(userId, { promptedAt: now }, now);
    await send(consentPayload(userId));
    return true;
  } catch (error) {
    logger.warn(`[PREFERENCE_MEMORY] code=PREFERENCE_CONSENT_NOT_SENT reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
    return false;
  } finally {
    asking.delete(userId);
  }
}

async function handleMemoryConsentButton(interaction) {
  const [, , choice, userId] = String(interaction.customId).split('|');
  if (interaction.user?.id !== userId) {
    await interaction.reply({ content: '這是別人的記憶設定，只有本人可以選擇。', ephemeral: true });
    return;
  }
  if ((choice !== 'public' && choice !== 'private') || !isMemoryConfigured()) {
    await interaction.reply({ content: '記憶設定目前無法使用，請稍後用 /memory share 設定。', ephemeral: true });
    return;
  }
  await updateConsent(userId, { choice });
  await interaction.update({
    content: choice === 'public'
      ? '已設定：公開聊天記憶，小吉所在的所有伺服器共用同一份記憶。可以隨時用 /memory share 修改。'
      : '已設定：不公開聊天記憶，每個伺服器的記憶各自分開。可以隨時用 /memory share 修改。',
    components: [],
    allowedMentions: NO_MENTIONS,
  });
}

module.exports = {
  CONSENT_TEXT,
  CUSTOM_ID_PREFIX,
  handleMemoryConsentButton,
  maybeOfferMemoryConsent,
};
