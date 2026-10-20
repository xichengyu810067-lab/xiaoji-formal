'use strict';

const { GAME_CATALOG, getGame } = require('../../website/gameCatalog');
const { getBoardRuntime } = require('../systems/games/board/core/boardRuntimeRegistry');
const { getSoloRuntime } = require('../systems/games/soloRuntimeRegistry');
const { launchWordChain } = require('../systems/community/discord/wordChainLaunch');
const { launchNumberChain } = require('../systems/community/discord/numberChainLaunch');
const { executeCasinoGame } = require('../systems/casino/discord/casinoLaunch');
const { executeDuelTowerGame } = require('../systems/casino/discord/duelTowerLaunch');
const { buildBlackjackPayload, getActiveBlackjackSession } = require('../services/casinoService');
const { getDailyRiddleEvent, getRiddlePhase, openOrGetDailyRiddle } = require('../services/dailyRiddleService');
const { describeNumberChainStatus, getNumberChainStatus } = require('../services/numberChainService');
const { describeWordChainStatus, getWordChainStatus } = require('../services/wordChainService');
const { replyCoinError } = require('../utils/coinPresentation');
const { replyEphemeral } = require('../utils/moderation');
const { getTaipeiDateKey } = require('../utils/taipeiClock');

const BOARD_LAUNCHERS = new Set(['board']);
const SOLO_LAUNCHERS = new Set(['solo']);
const SUPPORTED_START_LAUNCHERS = Object.freeze(new Set([
  'board', 'solo', 'word-chain', 'number-chain', 'casino', 'duel', 'daily-riddle',
]));
// Casino and duel-tower take every catalog parameter as mandatory (their executors read amount, wager and
// weapon-item-id as required options and the services reject a missing choice). Every other launcher lists
// optional parameters only: channel, seed, target and difficulty all have defaults.
const MANDATORY_PARAMETER_LAUNCHERS = new Set(['casino', 'duel']);
const START_PARAMETER_READERS = Object.freeze({
  amount: (options) => options.getInteger('amount'),
  choice: (options) => options.getString('choice'),
  'weapon-item-id': (options) => options.getString('weapon-item-id'),
  wager: (options) => options.getInteger('wager'),
});
const START_PARAMETER_LABELS = Object.freeze({
  amount: '下注籌碼',
  choice: '下注選項',
  'weapon-item-id': '武器商品 ID',
  wager: '決鬥下注籌碼',
});

function assertGuildChannel(interaction) {
  if (!interaction?.guildId || !interaction?.channelId || !interaction?.user?.id || !interaction.inGuild?.()) {
    const error = new Error('遊戲只能在伺服器文字頻道使用。');
    error.code = 'INVALID_GUILD';
    throw error;
  }
}

async function replyPrivate(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred) return interaction.editReply(payload);
  return replyEphemeral(interaction, payload);
}

// The board runtime refreshes the panel through the store and Discord, which may outlast the 3-second window, so the
// command is acknowledged privately first. The runtime answers through editReply instead of a new follow-up message
// when the interaction carries its "reply was deferred" marker (the same marker it sets after its own defer).
async function deferForBoardRuntime(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
  if (interaction.deferred) interaction.__boardReplyDeferred = true;
}

// Names the mandatory options the user left out. Checked before any launcher runs so a missing option is
// reported plainly and never reaches a coin transaction (which would only roll back and report a generic failure).
function findMissingStartParameters(game, options) {
  if (!MANDATORY_PARAMETER_LAUNCHERS.has(game.launcher)) return [];
  return game.parameters.filter((name) => {
    const read = START_PARAMETER_READERS[name];
    const value = read ? read(options) : options.get?.(name)?.value;
    return value === null || value === undefined || String(value).trim() === '';
  });
}

function missingParametersMessage(game, missing) {
  const list = missing.map((name) => `${name}（${START_PARAMETER_LABELS[name] || name}）`).join('、');
  return `開始「${game.name}」還缺少必要選項：${list}。請重新使用 /board start，並補上這些選項。`;
}

function riddleStatusText(result) {
  if (result?.event?.threadId) return `今天的每日猜謎在 <#${result.event.threadId}>。`;
  if (result?.code === 'RIDDLE_DISABLED') return '這個伺服器尚未啟用每日猜謎，請由管理員使用 /daily-riddle enable 設定。';
  if (result?.code === 'RIDDLE_NOT_OPEN') return '每日猜謎會在台北時間 10:00 開放。';
  if (result?.code === 'RIDDLE_CLOSED') return '今天的每日猜謎時段已結束，沒有可加入的題目。';
  if (result?.event?.status === 'claimed') return '今天的每日猜謎正在開啟，請稍後使用 /board status 再查看。';
  if (['failed', 'blocked', 'missed'].includes(result?.event?.status)) return '今天的每日猜謎無法開啟，請稍後再試。';
  return '今天目前沒有可加入的每日猜謎。';
}

async function startUnifiedGame(interaction) {
  try {
    assertGuildChannel(interaction);
    const gameKey = interaction.options.getString('game', true);
    const game = getGame(gameKey);
    if (!game) throw Object.assign(new Error('找不到這個遊戲。'), { code: 'UNKNOWN_GAME' });
    const missing = findMissingStartParameters(game, interaction.options);
    if (missing.length) {
      await replyPrivate(interaction, missingParametersMessage(game, missing));
      return { ok: false, code: 'MISSING_PARAMETER', missing };
    }
    if (BOARD_LAUNCHERS.has(game.launcher)) return getBoardRuntime().executeCommand(interaction);
    if (SOLO_LAUNCHERS.has(game.launcher)) {
      return getSoloRuntime().start(interaction, game.key, interaction.options.getString('difficulty') || 'normal');
    }
    if (game.launcher === 'word-chain') return launchWordChain(interaction);
    if (game.launcher === 'number-chain') return launchNumberChain(interaction);
    if (game.launcher === 'casino') return await executeCasinoGame(interaction, game.key);
    if (game.launcher === 'duel') return await executeDuelTowerGame(interaction);
    if (game.launcher === 'daily-riddle') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
      const result = await openOrGetDailyRiddle(interaction.client, { guildId: interaction.guildId });
      await replyPrivate(interaction, riddleStatusText(result));
      return result;
    }
    throw Object.assign(new Error('這個遊戲尚未設定啟動方式。'), { code: 'UNKNOWN_LAUNCHER' });
  } catch (error) {
    let failedGame = null;
    try { failedGame = getGame(interaction.options.getString('game')); } catch (_optionError) { /* Invalid interaction shape. */ }
    if (['casino', 'duel'].includes(failedGame?.launcher)) {
      await replyCoinError(interaction, error, '遊戲剛剛執行失敗了，請稍後再試。');
      return { ok: false, code: error?.code || 'GAME_FAILED' };
    }
    const safeMessage = {
      INVALID_GUILD: '遊戲只能在伺服器文字頻道使用。',
      UNKNOWN_GAME: '找不到這個遊戲。',
      RIDDLE_DISABLED: '這個伺服器尚未啟用每日猜謎。',
      RIDDLE_NOT_OPEN: '每日猜謎尚未開放。',
      RIDDLE_CLOSED: '今天的每日猜謎時段已結束。',
    }[error?.code] || '遊戲剛剛執行失敗了，請稍後再試。';
    await replyPrivate(interaction, safeMessage);
    return { ok: false, code: error?.code || 'GAME_FAILED' };
  }
}

// /board stop for the caller's own personal game (sudoku, tetris, number match). The command's stop belongs to the
// public board first: a caller who hosts the public session of this channel gets the board's own answer, and so does a
// caller without a personal game here. Only when the caller has no public session of their own to stop and does have a
// personal game in this channel, that game is ended (all of the caller's games of this channel; nobody else's). Returns
// what the solo runtime returned, or null when the board's stop is to run instead. Any lookup that fails also returns
// null, so the board answers exactly as it did before personal games could be ended.
async function endOwnSoloGame(interaction) {
  let solo = null;
  try {
    assertGuildChannel(interaction);
    const scope = { guildId: interaction.guildId, channelId: interaction.channelId, actorId: interaction.user.id };
    try {
      const board = await getBoardRuntime().service.status(scope);
      if (board?.session?.hostId === interaction.user.id) return null;
    } catch (error) {
      if (error?.code !== 'SESSION_NOT_FOUND') return null;
    }
    const runtime = getSoloRuntime();
    const own = await runtime.service.findLatest({ actorId: scope.actorId, guildId: scope.guildId, channelId: scope.channelId });
    if (own) solo = runtime;
  } catch (_error) {
    return null;
  }
  // The solo runtime answers the interaction itself, including its own failures.
  return solo ? solo.stop(interaction) : null;
}

async function catalogStatus(interaction) {
  // The lookups below read several stores and may outlast Discord's 3-second window, so acknowledge privately
  // first; replyPrivate then answers through editReply, and so does the caller's error reply once deferred.
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
  const active = [];
  try {
    const board = await getBoardRuntime().service.status({ guildId: interaction.guildId,
      channelId: interaction.channelId, actorId: interaction.user.id });
    if (board?.session) active.push(`目前頻道公開局：${getGame(board.session.gameKey)?.name || board.session.gameKey}`);
  } catch (_error) { /* No public board in this channel. */ }
  try {
    const solo = await getSoloRuntime().service.findLatest({ actorId: interaction.user.id,
      guildId: interaction.guildId, channelId: interaction.channelId });
    if (solo) active.push(`你的個人局：${getGame(solo.gameType)?.name || solo.gameType}`);
  } catch (_error) { /* No private solo game for this user. */ }
  const blackjack = await getActiveBlackjackSession(interaction.guildId, interaction.user.id).catch(() => null);
  if (blackjack) active.push('你的賭場局：賭場 21 點');
  const wordChain = await getWordChainStatus(interaction.guildId, interaction.channelId).catch(() => null);
  if (wordChain) {
    active.push(`目前頻道公開局：文字接龍（${wordChain.paused ? '已暫停，' : ''}目前詞「${wordChain.currentWord}」）`);
  }
  const numberChain = await getNumberChainStatus(interaction.guildId, interaction.channelId).catch(() => null);
  if (numberChain) {
    active.push(`目前頻道公開局：數字接龍（${numberChain.paused ? '已暫停，' : ''}目前目標 ${numberChain.expectedTarget}）`);
  }
  const daily = await getDailyRiddleEvent(interaction.guildId, getTaipeiDateKey()).catch(() => null);
  if (daily?.threadId) active.push(`今日每日猜謎：<#${daily.threadId}>`);
  const directory = GAME_CATALOG.map((game) => `• ${game.name}（${game.key}）`).join('\n');
  await replyPrivate(interaction, [
    '**小吉遊戲目錄｜使用 /board start 開始**',
    directory,
    '',
    active.length ? `**你可查看的現存遊戲**\n${active.join('\n')}` : '**你可查看的現存遊戲**\n目前沒有。',
  ].join('\n'));
  return { activeCount: active.length };
}

async function showUnifiedGameStatus(interaction) {
  try {
    assertGuildChannel(interaction);
    const gameKey = interaction.options.getString('game');
    // Awaited so a failure after the deferral is answered by the catch below (through editReply).
    if (!gameKey) return await catalogStatus(interaction);
    const game = getGame(gameKey);
    if (!game) throw Object.assign(new Error('找不到這個遊戲。'), { code: 'UNKNOWN_GAME' });
    if (game.launcher === 'board') {
      await deferForBoardRuntime(interaction);
      const current = await getBoardRuntime().service.status({ guildId: interaction.guildId,
        channelId: interaction.channelId, actorId: interaction.user.id });
      if (current.session.gameKey !== game.key) return await replyPrivate(interaction, '目前頻道沒有這個公開遊戲。');
      return await getBoardRuntime().executeCommand(interaction);
    }
    if (game.launcher === 'solo') return getSoloRuntime().resume(interaction, game.key);
    if (game.launcher === 'word-chain') {
      const session = await getWordChainStatus(interaction.guildId, interaction.channelId);
      return replyPrivate(interaction, session
        ? describeWordChainStatus(session)
        : '目前頻道沒有進行中的文字接龍。');
    }
    if (game.launcher === 'number-chain') {
      const session = await getNumberChainStatus(interaction.guildId, interaction.channelId);
      return replyPrivate(interaction, session
        ? describeNumberChainStatus(session)
        : '目前頻道沒有進行中的數字接龍。');
    }
    if (game.launcher === 'daily-riddle') {
      const event = await getDailyRiddleEvent(interaction.guildId, getTaipeiDateKey());
      return replyPrivate(interaction, riddleStatusText({ event, code: event?.status, phase: getRiddlePhase() }));
    }
    if (game.key === 'casino-blackjack') {
      const session = await getActiveBlackjackSession(interaction.guildId, interaction.user.id);
      if (!session) return replyPrivate(interaction, '你目前沒有進行中的 21 點。');
      const response = { ...buildBlackjackPayload(session), ephemeral: true };
      return interaction.deferred ? interaction.editReply(response) : interaction.reply(response);
    }
    return replyPrivate(interaction, '這個遊戲是立即結算遊戲，目前沒有可恢復的遊戲面板。');
  } catch (error) {
    const safeMessage = {
      SESSION_NOT_FOUND: '目前頻道沒有這個公開遊戲。',
      INVALID_GUILD: '遊戲只能在伺服器文字頻道使用。',
      UNKNOWN_GAME: '找不到這個遊戲。',
      INVALID_CORPUS_VERSION: '這局文字接龍使用的詞庫版本無法辨識，請管理員先用 /word-chain stop 停止這一局，再重新開局。',
    }[error?.code] || '查詢遊戲狀態失敗，請稍後再試。';
    await replyPrivate(interaction, safeMessage);
    return { ok: false, code: error?.code || 'STATUS_FAILED' };
  }
}

module.exports = {
  SUPPORTED_START_LAUNCHERS, assertGuildChannel, catalogStatus, endOwnSoloGame, showUnifiedGameStatus, startUnifiedGame,
};
