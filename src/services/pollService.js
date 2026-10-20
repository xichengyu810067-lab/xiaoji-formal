const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const logger = require('../utils/logger');

const { runWithBackgroundContext } = require('../platform/hostOperationContext');
const { retainedDataFile } = require('../platform/retainedDataSource');
const pollsPath = retainedDataFile('polls.json');
const pollTimers = new Map();

// One server (or one direct-message channel) can have this many polls open at once; polls still being
// created count too, so a burst of requests cannot pass the check together.
const MAX_OPEN_POLLS_PER_SCOPE = 20;
const pendingCreations = new Map();
// One member can have this many polls open at once, in all servers together, so a single member
// cannot fill the server's places for a whole day. Counted the same way, with the polls being created.
const MAX_OPEN_POLLS_PER_MEMBER = 3;
const pendingMemberCreations = new Map();
// A poll that ended longer ago than this is dropped when the file is written.
const ENDED_POLL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Windows can briefly refuse to replace a file that a scanner, indexer or backup program holds open.
// These codes are retried like the coin database file replace does: 8 attempts, 25 ms doubling to 1 s.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 8;

function pollScope(value) {
  return value.guildId || value.channelId;
}

function reserveCreation(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function releaseCreation(counts, key) {
  const left = (counts.get(key) || 1) - 1;
  if (left > 0) counts.set(key, left);
  else counts.delete(key);
}

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

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renameWithRetry(from, to) {
  let delay = 25;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

// Written next to the file and renamed over it, so a crash in the middle leaves the earlier file whole.
// A failure, after the retries of the rename, removes the temporary file and leaves the file as it was.
function writePolls(polls) {
  ensurePollFile();
  const tempPath = `${pollsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(polls, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    renameWithRetry(tempPath, pollsPath);
  } finally {
    // A cleanup that fails must not hide the failure of the write itself.
    if (handle !== undefined && handle !== null) {
      try { fs.closeSync(handle); } catch { /* keep the original failure */ }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch { /* keep the original failure */ }
  }
}

function pruneEndedPolls(polls, keepMessageId, now = Date.now()) {
  for (const [messageId, poll] of Object.entries(polls)) {
    if (messageId !== keepMessageId && poll?.endedAt && now - poll.endedAt > ENDED_POLL_RETENTION_MS) {
      delete polls[messageId];
    }
  }
}

function savePoll(poll) {
  const polls = readPolls();
  polls[poll.messageId] = poll;
  pruneEndedPolls(polls, poll.messageId);
  writePolls(polls);
}

function getPoll(messageId) {
  const polls = readPolls();
  return Object.hasOwn(polls, messageId) ? polls[messageId] || null : null;
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

  const scope = pollScope(interaction);
  const memberId = interaction.user.id;
  const openPolls = Object.values(readPolls()).filter((stored) => stored && !isPollEnded(stored));
  const memberOpen = openPolls.filter((stored) => stored.createdBy === memberId).length +
    (pendingMemberCreations.get(memberId) || 0);
  if (memberOpen >= MAX_OPEN_POLLS_PER_MEMBER) {
    await interaction.reply({
      content: `你同時最多只能有 ${MAX_OPEN_POLLS_PER_MEMBER} 個進行中的投票，請等其中一個結束後再建立新的投票。`,
      ephemeral: true,
    });
    return;
  }
  const scopeOpen = openPolls.filter((stored) => pollScope(stored) === scope).length +
    (pendingCreations.get(scope) || 0);
  if (scopeOpen >= MAX_OPEN_POLLS_PER_SCOPE) {
    await interaction.reply({
      content: `進行中的投票已達 ${MAX_OPEN_POLLS_PER_SCOPE} 個上限，請等其中一個結束後再建立新的投票。`,
      ephemeral: true,
    });
    return;
  }

  reserveCreation(pendingCreations, scope);
  reserveCreation(pendingMemberCreations, memberId);
  let poll;
  try {
    await interaction.deferReply();
    const placeholder = await interaction.editReply('正在建立投票...');
    const now = Date.now();
    poll = {
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
  } finally {
    releaseCreation(pendingCreations, scope);
    releaseCreation(pendingMemberCreations, memberId);
  }
  schedulePollEnd(interaction.client, poll);
  await interaction.editReply(buildPollPayload(poll));
}

async function endPoll(client, poll, now = Date.now()) {
  // Timers hold the creation snapshot; votes may have been saved since then.
  const currentPoll = getPoll(poll.messageId);
  if (!currentPoll || currentPoll.endedAt) {
    return currentPoll;
  }

  currentPoll.endedAt = now;
  savePoll(currentPoll);

  const existingTimer = pollTimers.get(poll.messageId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pollTimers.delete(poll.messageId);
  }

  try {
    const channel = await client.channels.fetch(currentPoll.channelId);
    const message = await channel.messages.fetch(currentPoll.messageId);
    await message.edit(buildPollPayload(currentPoll));
  } catch (error) {
    if (!String(error?.code || '').startsWith('TEST_')) {
      logger.warn(`Failed to close poll ${poll.messageId}: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`);
    }
  }

  return currentPoll;
}

// A scheduled close runs as the background job `poll.end`, whether it is due at once
// (restored after a restart) or later from its timer.
function schedulePollEnd(client, poll) {
  if (isPollEnded(poll)) {
    void runWithBackgroundContext('poll.end', () => endPoll(client, poll));
    return;
  }

  const existingTimer = pollTimers.get(poll.messageId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    void runWithBackgroundContext('poll.end', () => endPoll(client, poll));
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

  // A button is only valid on the poll message it was made for, in the server that poll belongs to.
  if (!poll || poll.guildId !== interaction.guildId || poll.messageId !== interaction.message?.id ||
      !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= (poll.options?.length || 0)) {
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
