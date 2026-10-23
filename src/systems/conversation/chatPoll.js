// A poll asked for in a chat with 小吉. The model only proposes one (provider.js, propose_poll); 小吉 shows the
// question and options with 確認 and 取消 buttons, and the poll is opened only when the member who asked presses
// 確認, within two minutes, in the same channel. Opening it is the same createPoll as /poll, with the same limits.
const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createPoll, validatePollInput } = require('../../services/pollService');

const CUSTOM_ID_PREFIX = 'chatpoll|1|';
const PROPOSAL_TTL_MS = 2 * 60 * 1000;
// Proposals waiting for a press; the oldest is dropped past this, so a flood cannot grow the map without end.
const MAX_PENDING_PROPOSALS = 500;
const DEFAULT_DURATION_MINUTES = 10;
const proposals = new Map();

function dropExpired(now) {
  for (const [id, proposal] of proposals) if (proposal.expiresAt <= now) proposals.delete(id);
  while (proposals.size >= MAX_PENDING_PROPOSALS) proposals.delete(proposals.keys().next().value);
}

// The model's propose_poll input, checked like /poll's options and by checkText (the output check of an AI reply,
// returning null for text that must not be shown). Null when it cannot become a poll.
function preparePollProposal(raw, { checkText = (text) => text } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const options = Array.isArray(raw.options) ? raw.options.slice(0, 5) : [];
  const duration = Number.isInteger(raw.duration_minutes) ? raw.duration_minutes : DEFAULT_DURATION_MINUTES;
  const validation = validatePollInput(String(raw.question ?? '').slice(0, 200), options.map((option) =>
    String(option ?? '').slice(0, 100)), Math.min(1440, Math.max(1, duration)));
  if (!validation.ok) return null;
  const question = checkText(validation.question);
  const checkedOptions = validation.options.map((option) => checkText(option));
  if (!question || checkedOptions.some((option) => !option)) return null;
  return { question, options: checkedOptions, durationMinutes: validation.durationMinutes };
}

function proposalPayload(id, poll, intro) {
  const lines = [
    intro || '小吉幫你準備好投票了，確認內容沒問題就按「確認」：',
    `**${poll.question}**`,
    ...poll.options.map((option, index) => `${index + 1}. ${option}`),
    `投票時間：${poll.durationMinutes} 分鐘（2 分鐘內沒按確認就會失效）`,
  ];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}confirm|${id}`).setLabel('確認').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}cancel|${id}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
  return {
    content: lines.join('\n'),
    components: [row],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
  };
}

// Shows the preview under the member's message. Returns the proposal id, or null when nothing was sent.
async function offerChatPoll(message, poll, { intro = '', now = Date.now() } = {}) {
  if (!poll) return null;
  dropExpired(now);
  const id = crypto.randomUUID().replace(/-/gu, '').slice(0, 16);
  proposals.set(id, {
    poll,
    userId: message.author.id,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    expiresAt: now + PROPOSAL_TTL_MS,
  });
  try {
    await message.reply(proposalPayload(id, poll, intro));
    return id;
  } catch (error) {
    proposals.delete(id);
    throw error;
  }
}

async function closePreview(interaction, content) {
  try {
    await interaction.message?.edit({ content, components: [], allowedMentions: { parse: [] } });
  } catch {
    // The preview may be gone; the answer to the press was already sent.
  }
}

async function handleChatPollButton(interaction, { now = Date.now() } = {}) {
  const [, , action, id] = String(interaction.customId).split('|');
  const proposal = proposals.get(id);
  if (!proposal || proposal.expiresAt <= now || proposal.channelId !== interaction.channelId ||
      proposal.guildId !== (interaction.guildId ?? null)) {
    if (proposal && proposal.expiresAt <= now) proposals.delete(id);
    await interaction.reply({ content: '這個投票預覽已經失效，想開投票請再跟小吉說一次。', ephemeral: true });
    return;
  }
  if (interaction.user?.id !== proposal.userId) {
    await interaction.reply({ content: '只有提出投票的人可以確認或取消。', ephemeral: true });
    return;
  }
  proposals.delete(id);
  if (action === 'cancel') {
    await interaction.update({ content: '好的，這個投票已取消。', components: [], allowedMentions: { parse: [] } });
    return;
  }
  if (action !== 'confirm') {
    await interaction.reply({ content: '這個按鈕無法使用。', ephemeral: true });
    return;
  }
  const opened = await createPoll(interaction, {
    question: proposal.poll.question,
    options: proposal.poll.options,
    durationMinutes: proposal.poll.durationMinutes,
  });
  await closePreview(interaction, opened
    ? `已開出投票：**${proposal.poll.question}**`
    : '這個投票沒有開出來（原因已私下告訴提出的人）。');
}

function clearChatPollsForTests() {
  proposals.clear();
}

module.exports = {
  CUSTOM_ID_PREFIX,
  PROPOSAL_TTL_MS,
  clearChatPollsForTests,
  handleChatPollButton,
  offerChatPoll,
  preparePollProposal,
};
