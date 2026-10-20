// Starts a word chain game for /board start and answers the interaction. The checks that come before any chain
// action, the start itself and the failure replies moved here from src/commands/word-chain.js. The command runs
// the same functions for its own stop and status, so a refusal reads the same whichever way in the person came.
const { PermissionFlagsBits } = require('discord.js');
const { startWordChain, validateWord } = require('../../../services/wordChainService');
const logger = require('../../../utils/logger');
const { ensureModerationAccess, handleCommandError, replyEphemeral } = require('../../../utils/moderation');

// Explanations for service failures that the generic "setting failed" text would hide from the administrator.
// They name no internal path, version, or configuration value.
const CONTACT_OWNER = '若仍失敗，請聯絡機器人擁有者。';
const FENCE_PAUSED_MESSAGE = `反應防護暫時無法啟用，接龍設定已暫停，進度已保留；請稍後在同一頻道再次使用 /board start 接續這一局。${CONTACT_OWNER}`;
const FENCE_NOT_STARTED_MESSAGE = `反應防護暫時無法啟用，這次沒有開始新的一局，接龍保持停用；請稍後再開局。${CONTACT_OWNER}`;
const FENCE_NOT_STARTED_AFTER_SWITCH_MESSAGE = `反應防護暫時無法啟用，這次沒有開始新的一局，原頻道的那一局已結束，接龍保持停用；請稍後再開局。${CONTACT_OWNER}`;
const CORPUS_UNRECOGNIZED_MESSAGE = '這局使用的詞庫版本無法辨識，請先用 /word-chain stop 停止這一局，再重新開局。';

function describeFailure(error) {
  if (error?.code === 'REACTION_FENCE_OPEN_FAILED') {
    if (error.sessionKept === true) return FENCE_PAUSED_MESSAGE;
    return error.previousRoundEnded === true ? FENCE_NOT_STARTED_AFTER_SWITCH_MESSAGE : FENCE_NOT_STARTED_MESSAGE;
  }
  if (error?.code === 'INVALID_CORPUS_VERSION') return CORPUS_UNRECOGNIZED_MESSAGE;
  return null;
}

function getTargetChannel(interaction) {
  return interaction.options.getChannel('channel') || interaction.channel;
}

// The access objects ensureWordChainAccess has handed out, each with the interaction it was granted for. The start
// below runs only for one of them, so it cannot be reached without the checks having passed here for that
// interaction: an object that merely says ok: true is refused.
const accessGrants = new WeakMap();

// The checks that come before any word chain action, in this order: inside a guild, a text channel
// the bot can send to, Manage Server for the person, four channel permissions for the bot. A failed check has
// already answered the interaction and gives { ok: false }; otherwise the channel the action applies to comes back
// in an access object that startWordChainInChannel accepts.
async function ensureWordChainAccess(interaction) {
  if (!interaction.guildId || !interaction.guild || !interaction.inGuild()) {
    await replyEphemeral(interaction, '文字接龍只能在伺服器內管理。');
    return { ok: false };
  }
  const channel = getTargetChannel(interaction);
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
    await replyEphemeral(interaction, '請選擇小吉可以傳送訊息的伺服器文字頻道。');
    return { ok: false };
  }
  const access = await ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.ManageGuild,
    userPermissionName: 'Manage Server',
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    botPermissionNames: ['View Channel', 'Send Messages', 'Add Reactions', 'Read Message History'],
    permissionChannel: channel,
  });
  if (!access.ok) return { ok: false };
  const granted = Object.freeze({ ok: true, channel });
  accessGrants.set(granted, interaction);
  return granted;
}

// The start branch: checks the optional seed, starts the round and answers privately. It needs the access object that
// ensureWordChainAccess returned for this interaction; with anything else it throws before it reads or starts anything.
async function startWordChainInChannel(interaction, access) {
  if (access?.ok !== true || accessGrants.get(access) !== interaction) {
    throw Object.assign(new Error('Starting a word chain needs the access ensureWordChainAccess granted for this interaction.'),
      { code: 'CHAIN_ACCESS_REQUIRED' });
  }
  const { channel } = access;
  const seed = interaction.options.getString('seed');
  if (seed && !validateWord(seed).ok) {
    await replyEphemeral(interaction, validateWord(seed).message);
    return;
  }
  const result = await startWordChain({ guildId: interaction.guildId, channelId: channel.id, actorId: interaction.user.id, seed: seed || undefined });
  await interaction.reply({
    content: result.alreadyActive
      ? `這個頻道的文字接龍已在進行中，目前詞為「${result.session.currentWord}」。`
      : `文字接龍開始！起始詞是「${result.session.currentWord}」，請從「${result.session.currentWord.at(-1)}」字接詞。`,
    ephemeral: true,
  });
  return;
}

// The answer for a failed action: a mapped explanation, or the generic wording, never the error's own text.
async function replyWordChainFailure(interaction, error) {
  if (error?.code === 'CHAIN_CHANNEL_CONFLICT') {
    await replyEphemeral(interaction, '這個頻道已有進行中的數字接龍，請先停止它再開始文字接龍。');
    return;
  }
  const explanation = describeFailure(error);
  if (explanation) {
    logger.warn(`/${interaction.commandName} word-chain failed: ${error.code}`);
    await replyEphemeral(interaction, { content: explanation, allowedMentions: { parse: [] } });
    return;
  }
  await handleCommandError(interaction, error, '文字接龍設定失敗，請稍後再試。');
}

// The whole /board start flow for a word chain: the same checks, the start and the same failure replies as the command.
async function launchWordChain(interaction) {
  try {
    const access = await ensureWordChainAccess(interaction);
    if (!access.ok) return;
    await startWordChainInChannel(interaction, access);
  } catch (error) {
    await replyWordChainFailure(interaction, error);
  }
}

module.exports = { ensureWordChainAccess, launchWordChain, replyWordChainFailure, startWordChainInChannel };
