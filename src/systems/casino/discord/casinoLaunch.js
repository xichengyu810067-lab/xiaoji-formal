// Starts a casino game for /board start and answers the interaction with the settlement.
// These functions moved here from src/commands/casino.js, which still exports executeCasinoGame
// under the same name, so the systems layer no longer has to load a command file.
const {
  BlackjackStatus,
  buildBlackjackPayload,
  formatCard,
  formatHand,
  playBaccarat,
  playDice,
  playPoker,
  playRoulette,
  playSlots,
  startBlackjack,
} = require('../../../services/casinoService');
const { formatChips } = require('../../../utils/coinPresentation');

const diceChoiceLabels = {
  big: '大',
  small: '小',
  seven: '指定 7 點',
};

const rouletteChoiceLabels = {
  red: '紅色',
  black: '黑色',
  odd: '單數',
  even: '雙數',
  zero: '零',
};

const baccaratChoiceLabels = {
  player: '閒家',
  banker: '莊家',
  tie: '和局',
};

const baccaratOutcomeLabels = {
  player: '閒家',
  banker: '莊家',
  tie: '和局',
};

function formatSignedChips(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatChips(Math.abs(numeric))}`;
}

function formatAutoTopUp(result) {
  return result.autoTopUpAmount > 0 ? `籌碼不足，已自動用吉幣兌換 ${formatChips(result.autoTopUpAmount)}。` : null;
}

function formatSettlementLines(result) {
  return [
    `下注：${formatChips(result.betAmount)}`,
    `派彩：${formatChips(result.payoutAmount)}`,
    `本局損益：${formatSignedChips(result.netAmount)}`,
    `籌碼餘額：${formatChips(result.balanceAfter)}`,
    formatAutoTopUp(result),
  ].filter(Boolean);
}

function formatDiceResult(result) {
  const gameResult = result.game.result;

  return [
    '**小吉賭場｜骰子**',
    `選擇：${diceChoiceLabels[gameResult.choice] || gameResult.choice}`,
    `骰面：${gameResult.dice.join(' + ')} = ${gameResult.sum}`,
    `結果：${gameResult.win ? '命中' : '未命中'}`,
    ...formatSettlementLines(result),
  ].join('\n');
}

function formatSlotsResult(result) {
  const gameResult = result.game.result;

  return [
    '**小吉賭場｜角子機**',
    `盤面：${gameResult.reels.join(' | ')}`,
    `結果：${gameResult.win ? '中獎' : '未中獎'}`,
    ...formatSettlementLines(result),
  ].join('\n');
}

function formatRouletteResult(result) {
  const gameResult = result.game.result;
  const colorLabel = gameResult.color === 'red' ? '紅色' : gameResult.color === 'black' ? '黑色' : '綠色';

  return [
    '**小吉賭場｜輪盤**',
    `選擇：${rouletteChoiceLabels[gameResult.choice] || gameResult.choice}`,
    `結果：${gameResult.number}（${colorLabel}）`,
    `狀態：${gameResult.win ? '命中' : '未命中'}`,
    ...formatSettlementLines(result),
  ].join('\n');
}

function formatBaccaratResult(result) {
  const gameResult = result.game.result;

  return [
    '**小吉賭場｜百家樂**',
    `選擇：${baccaratChoiceLabels[gameResult.choice] || gameResult.choice}`,
    `閒家：${formatHand(gameResult.playerHand)}｜點數 ${gameResult.playerValue}`,
    `莊家：${formatHand(gameResult.bankerHand)}｜點數 ${gameResult.bankerValue}`,
    `結果：${baccaratOutcomeLabels[gameResult.outcome] || gameResult.outcome}`,
    `狀態：${gameResult.win ? '命中' : '未命中'}`,
    ...formatSettlementLines(result),
  ].join('\n');
}

function formatPokerResult(result) {
  const gameResult = result.game.result;
  const outcomeLabel = gameResult.outcome === 'win' ? '獲勝' : gameResult.outcome === 'push' ? '平手' : '落敗';

  return [
    '**小吉賭場｜撲克牌**',
    `你的牌：${gameResult.playerHand.map(formatCard).join(' ')}｜${gameResult.playerRank.label}`,
    `小吉牌：${gameResult.dealerHand.map(formatCard).join(' ')}｜${gameResult.dealerRank.label}`,
    `結果：${outcomeLabel}`,
    ...formatSettlementLines(result),
  ].join('\n');
}

async function executeCasinoGame(interaction, gameKey) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const amount = interaction.options.getInteger('amount', true);
  const choice = interaction.options.getString('choice');
  const common = { amount, interactionId: interaction.id };
  let result;
  if (gameKey === 'casino-dice') {
    result = await playDice(guildId, userId, { ...common, choice });
    await interaction.reply({ content: formatDiceResult(result) });
  } else if (gameKey === 'casino-slots') {
    result = await playSlots(guildId, userId, common);
    await interaction.reply({ content: formatSlotsResult(result) });
  } else if (gameKey === 'casino-roulette') {
    result = await playRoulette(guildId, userId, { ...common, choice });
    await interaction.reply({ content: formatRouletteResult(result) });
  } else if (gameKey === 'casino-baccarat') {
    result = await playBaccarat(guildId, userId, { ...common, choice });
    await interaction.reply({ content: formatBaccaratResult(result) });
  } else if (gameKey === 'casino-poker') {
    result = await playPoker(guildId, userId, common);
    await interaction.reply({ content: formatPokerResult(result) });
  } else if (gameKey === 'casino-blackjack') {
    result = await startBlackjack(guildId, userId, { ...common, channelId: interaction.channelId });
    const payload = buildBlackjackPayload(result.session);
    payload.content = result.session.status === BlackjackStatus.ACTIVE
      ? `${interaction.user} 開了一局 21 點，下注 ${formatChips(result.session.betAmount)}。`
      : `${interaction.user} 的 21 點已結算，本局損益 ${formatSignedChips(result.session.netAmount)}。`;
    if (result.autoTopUpAmount > 0) payload.content += `\n${formatAutoTopUp(result)}`;
    await interaction.reply(payload);
  } else {
    throw new Error('Unknown casino game.');
  }
  return result;
}

module.exports = { executeCasinoGame, formatAutoTopUp, formatSignedChips };
