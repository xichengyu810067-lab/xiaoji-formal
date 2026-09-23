const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const logger = require('../utils/logger');

const pollsPath = path.join(__dirname, '..', 'data', 'polls.json');
const pollTimers = new Map();

function ensurePollFile() {
  const directory = path.dirname(pollsPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(pollsPath)) {
    fs.writeFileSync(pollsPath, '{}\n', 'utf8');
  }
}

function readPolls() {
  ensurePollFile();

  try {
    const raw = fs.readFileSync(pollsPath, 'utf8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePolls(polls) {
  ensurePollFile();
  fs.writeFileSync(pollsPath, `${JSON.stringify(polls, null, 2)}\n`, 'utf8');
}

function savePoll(poll) {
  const polls = readPolls();
  polls[poll.messageId] = poll;
  writePolls(polls);
}

function getPoll(messageId) {
  return readPolls()[messageId] || null;
}

function getPollCounts(poll) {
  const counts = Array.from({ length: poll.options.length }, () => 0);

  for (const optionIndex of Object.values(poll.votes || {})) {
    if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < counts.length) {
      counts[optionIndex] += 1;
    }
  }

  return counts;
}

function isPollEnded(poll, now = Date.now()) {
  return Boolean(poll.endedAt) || now >= poll.endsAt;
}

function buildPollEmbed(poll) {
  const counts = getPollCounts(poll);
  const totalVotes = counts.reduce((sum, count) => sum + count, 0);
  const ended = isPollEnded(poll);
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x64748b : 0x3b82f6)
    .setTitle(poll.question)
    .setDescription(ended ? '投票已結束。' : `投票截止：<t:${Math.floor(poll.endsAt / 1000)}:R>`)
    .setFooter({ text: `總票數：${totalVotes}` });

  poll.options.forEach((option, index) => {
    embed.addFields({
      name: `${index + 1}. ${option}`,
      value: `${counts[index]} 票`,
      inline: false,
    });
  });

  return embed;
}

function buildPollComponents(poll, disabled = isPollEnded(poll)) {
  const row = new ActionRowBuilder();

  poll.options.forEach((option, index) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll:${poll.messageId}:${index}`)
        .setLabel(String(index + 1))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled)
    );
  });

  return [row];
}

function buildPollPayload(poll) {
  return {
    content: '',
    embeds: [buildPollEmbed(poll)],
    components: buildPollComponents(poll),
    allowedMentions: { parse: [] },
  };
}

function validatePollInput(question, options, durationMinutes) {
  const normalizedQuestion = String(question || '').trim();
  const normalizedOptions = options.map((option) => String(option || '').trim()).filter(Boolean);

  if (!normalizedQuestion) {
    return { ok: false, message: '請輸入投票問題。' };
  }

  if (normalizedOptions.length < 2) {
    return { ok: false, message: '投票至少需要 2 個選項。' };
  }

  if (new Set(normalizedOptions.map((option) => option.toLowerCase())).size !== normalizedOptions.length) {
    return { ok: false, message: '投票選項不可重複。' };
  }

  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    return { ok: false, message: '投票時間請設定 1 到 1440 分鐘。' };
  }

  return {
    ok: true,
    question: normalizedQuestion.slice(0, 256),
    options: normalizedOptions.map((option) => option.slice(0, 100)),
    durationMinutes,
  };
}

async function createPoll(interaction, { question, options, durationMinutes }) {
  const validation = validatePollInput(question, options, durationMinutes);

  if (!validation.ok) {
    await interaction.reply({ content: validation.message, ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const placeholder = await interaction.editReply('正在建立投票...');
  const now = Date.now();
  const poll = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: placeholder.id,
    question: validation.question,
    options: validation.options,
    votes: {},
    createdBy: interaction.user.id,
    createdAt: now,
    endsAt: now + validation.durationMinutes * 60 * 1000,
    endedAt: null,
  };

  savePoll(poll);
  schedulePollEnd(interaction.client, poll);
  await interaction.editReply(buildPollPayload(poll));
}

async function endPoll(client, poll, now = Date.now()) {
  if (poll.endedAt) {
    return poll;
  }

  poll.endedAt = now;
  savePoll(poll);

  const existingTimer = pollTimers.get(poll.messageId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pollTimers.delete(poll.messageId);
  }

  try {
    const channel = await client.channels.fetch(poll.channelId);
    const message = await channel.messages.fetch(poll.messageId);
    await message.edit(buildPollPayload(poll));
  } catch (error) {
    logger.warn(`Failed to close poll ${poll.messageId}: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`);
  }

  return poll;
}

function schedulePollEnd(client, poll) {
  if (isPollEnded(poll)) {
    void endPoll(client, poll);
    return;
  }

  const existingTimer = pollTimers.get(poll.messageId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    void endPoll(client, poll);
  }, Math.max(0, poll.endsAt - Date.now()));

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  pollTimers.set(poll.messageId, timer);
}

async function handlePollButton(interaction) {
  const [, messageId, optionIndexText] = interaction.customId.split(':');
  const optionIndex = Number(optionIndexText);
  const poll = getPoll(messageId);

  if (!poll || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= (poll.options?.length || 0)) {
    await interaction.reply({ content: '找不到這個投票，可能已經被清除。', ephemeral: true });
    return;
  }

  if (isPollEnded(poll)) {
    await endPoll(interaction.client, poll);
    await interaction.reply({ content: '這個投票已經結束。', ephemeral: true });
    return;
  }

  poll.votes[interaction.user.id] = optionIndex;
  savePoll(poll);
  await interaction.update(buildPollPayload(poll));
}

async function restoreActivePolls(client) {
  const polls = readPolls();

  for (const poll of Object.values(polls)) {
    if (!poll.endedAt) {
      schedulePollEnd(client, poll);
    }
  }
}

module.exports = {
  buildPollComponents,
  buildPollEmbed,
  createPoll,
  getPollCounts,
  handlePollButton,
  readPolls,
  restoreActivePolls,
  validatePollInput,
};
