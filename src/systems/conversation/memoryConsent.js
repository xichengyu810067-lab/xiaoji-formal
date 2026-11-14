// The notice and choice for 小吉's memory (preferenceMemory.js, channelMemory.js): on a member's first AI chat, and once
// more for everyone when the notice changes (CONSENT_REVISION), 小吉 says what it remembers, points to /memory, and asks
// with two buttons whether the memory may be public (shared by every server). Only that member can press them; not
// pressing keeps the earlier choice (private for a member who never chose).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getConsent, getPromptRevision, isMemoryConfigured, savePromptRevision, updateConsent } = require('./preferenceMemory');
const { forgetCachedConsent } = require('./channelMemory');
const logger = require('../../utils/logger');

const CUSTOM_ID_PREFIX = 'memconsent|1|';
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });
// Revision 2: channel memory. Revision 3: the developer's weekly memory report, which lists every member, public or
// not. Everyone who saw an earlier revision (or nothing) is asked once more.
const CONSENT_REVISION = 3;
const CONSENT_TEXT = [
  '小吉會記住你的聊天內容，讓之後的對話更貼心：你在聊天中提到的喜好，以及你在小吉所在伺服器裡說過的話（每人每天最多 30 則，用完會先借用隔天的額度，整個月用完就暫停；每月 1 號中午 12:00 重新計算並刪除上個月的內容）。私訊的內容不會被記住。',
  '你可以隨時用 /memory 查看、修改、刪除或停止記憶。',
  '不論你選擇公開或不公開，小吉每 7 天會把這段期間新增的記憶（喜好與聊天紀錄）整理成報告，私訊給開發者本人做維護用，不會給其他人。',
  '**是否允許小吉公開聊天記憶？**',
  '-# 請注意，公開後小吉所在的所有伺服器（包含私訊）均會公開，不存在部分公開、部分不公開的情形。選擇不公開時，每個伺服器的記憶各自分開，只在該伺服器使用。',
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

// send(payload) posts the notice where the member is chatting. Asked once per member and revision: the time and the
// revision are saved before it is sent, so a failed send is not retried on every chat.
async function maybeOfferMemoryConsent(userId, send, { now = Date.now() } = {}) {
  if (!userId || !isMemoryConfigured() || asking.has(userId)) return false;
  asking.add(userId);
  try {
    const consent = await getConsent(userId);
    if (!consent) return false;
    const revision = await getPromptRevision(userId);
    if (consent.promptedAt !== null && revision >= CONSENT_REVISION) return false;
    // promptedAt also marks the member as one who chats with 小吉 (channel memory keeps only their messages).
    await updateConsent(userId, { promptedAt: consent.promptedAt ?? now }, now);
    await savePromptRevision(userId, CONSENT_REVISION, now);
    forgetCachedConsent(userId);
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
  forgetCachedConsent(userId);
  await interaction.update({
    content: choice === 'public'
      ? '已設定：公開聊天記憶，小吉所在的所有伺服器共用同一份記憶。可以隨時用 /memory share 修改。'
      : '已設定：不公開聊天記憶，每個伺服器的記憶各自分開。可以隨時用 /memory share 修改。',
    components: [],
    allowedMentions: NO_MENTIONS,
  });
}

module.exports = {
  CONSENT_REVISION,
  CONSENT_TEXT,
  CUSTOM_ID_PREFIX,
  handleMemoryConsentButton,
  maybeOfferMemoryConsent,
};
