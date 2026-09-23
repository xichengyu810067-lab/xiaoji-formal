const { SlashCommandBuilder } = require('discord.js');
const {
  BlackjackStatus,
  MAX_CASINO_AMOUNT,
  buildBlackjackPayload,
  borrowCasinoLoan,
  formatCard,
  formatHand,
  getCasinoLoanStatus,
  listCasinoHistory,
  playBaccarat,
  playDice,
  playPoker,
  playRoulette,
  playSlots,
  repayCasinoLoan,
  startBlackjack,
} = require('../services/casinoService');
const { formatChips, formatCoins, replyCoinError } = require('../utils/coinPresentation');

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

const ledgerTypeLabels = {
  game_win: '遊戲獲勝',
  game_loss: '遊戲落敗',
  game_push: '遊戲平手',
  loan_borrow: '貸幣借款',
  loan_repay: '貸幣還款',
  loan_interest: '貸幣利息',
  blackjack_refund: '21 點逾時退還',
};

function formatSignedCoins(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatCoins(Math.abs(numeric))}`;
}

function formatSignedChips(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatChips(Math.abs(numeric))}`;
}

function formatAutoTopUp(result) {
  return result.autoTopUpAmount > 0 ? `籌碼不足，已自動用吉幣兌換 ${formatChips(result.autoTopUpAmount)}。` : null;
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return '未知';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F>`;
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

function formatLoan(loan) {
  if (!loan) {
    return '目前沒有賭場借款。';
  }

  return [
    `借款編號：${loan.id}`,
    `本金：${formatCoins(loan.principalAmount)}`,
    `目前債務：${formatCoins(loan.currentDebtAmount)}`,
    `狀態：${loan.status}`,
  ].join('\n');
}

function formatHistoryRow(row) {
  const targetId = row.gameId ? `遊戲 #${row.gameId}` : row.loanId ? `借款 #${row.loanId}` : '系統';
  return [
    `#${row.id}`,
    ledgerTypeLabels[row.entryType] || row.entryType,
    targetId,
    row.currency === 'coin' ? formatSignedCoins(row.amount) : formatSignedChips(row.amount),
    formatTimestamp(row.createdAt),
  ].join('｜');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino')
    .setDescription('使用籌碼遊玩小吉賭場')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dice')
        .setDescription('下注骰子大小或指定 7 點')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
        .addStringOption((option) =>
          option
            .setName('choice')
            .setDescription('下注選項')
            .setRequired(true)
            .addChoices(
              { name: '大', value: 'big' },
              { name: '小', value: 'small' },
              { name: '指定 7 點', value: 'seven' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('slots')
        .setDescription('遊玩籌碼角子機')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('blackjack')
        .setDescription('遊玩 21 點')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('roulette')
        .setDescription('遊玩輪盤')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
        .addStringOption((option) =>
          option
            .setName('choice')
            .setDescription('下注選項')
            .setRequired(true)
            .addChoices(
              { name: '紅色', value: 'red' },
              { name: '黑色', value: 'black' },
              { name: '單數', value: 'odd' },
              { name: '雙數', value: 'even' },
              { name: '零', value: 'zero' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('baccarat')
        .setDescription('遊玩百家樂')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
        .addStringOption((option) =>
          option
            .setName('choice')
            .setDescription('下注選項')
            .setRequired(true)
            .addChoices(
              { name: '閒家', value: 'player' },
              { name: '莊家', value: 'banker' },
              { name: '和局', value: 'tie' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('poker')
        .setDescription('遊玩五張牌撲克')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('loan-borrow')
        .setDescription('從貸幣兌換區借入籌碼')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('借款籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('loan-repay')
        .setDescription('償還賭場貸幣借款')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('還款籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('loan-status').setDescription('查看自己的賭場借款狀態'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的賭場紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '賭場功能只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (subcommand === 'dice') {
        const result = await playDice(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
          choice: interaction.options.getString('choice', true),
        });
        await interaction.reply({ content: formatDiceResult(result) });
        return;
      }

      if (subcommand === 'slots') {
        const result = await playSlots(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({ content: formatSlotsResult(result) });
        return;
      }

      if (subcommand === 'roulette') {
        const result = await playRoulette(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
          choice: interaction.options.getString('choice', true),
        });
        await interaction.reply({ content: formatRouletteResult(result) });
        return;
      }

      if (subcommand === 'baccarat') {
        const result = await playBaccarat(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
          choice: interaction.options.getString('choice', true),
        });
        await interaction.reply({ content: formatBaccaratResult(result) });
        return;
      }

      if (subcommand === 'poker') {
        const result = await playPoker(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({ content: formatPokerResult(result) });
        return;
      }

      if (subcommand === 'blackjack') {
        const result = await startBlackjack(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
          channelId: interaction.channelId,
        });
        const payload = buildBlackjackPayload(result.session);
        payload.content =
          result.session.status === BlackjackStatus.ACTIVE
            ? `${interaction.user} 開了一局 21 點，下注 ${formatChips(result.session.betAmount)}。`
            : `${interaction.user} 的 21 點已結算，本局損益 ${formatSignedChips(result.session.netAmount)}。`;
        if (result.autoTopUpAmount > 0) {
          payload.content += `\n${formatAutoTopUp(result)}`;
        }
        await interaction.reply(payload);
        return;
      }

      if (subcommand === 'loan-borrow') {
        const result = await borrowCasinoLoan(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜貸幣兌換區借款**',
            `已借入：${formatChips(result.borrowedAmount)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
            formatLoan(result.loan),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'loan-repay') {
        const result = await repayCasinoLoan(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜貸幣兌換區還款**',
            `已還款：${formatChips(result.repaymentAmount)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
            formatAutoTopUp(result),
            formatLoan(result.loan),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'loan-status') {
        const result = await getCasinoLoanStatus(guildId, userId);
        await interaction.reply({
          content: [
            '**小吉賭場｜借款狀態**',
            `籌碼餘額：${formatChips(result.chipBalance)}`,
            formatLoan(result.loan),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const rows = await listCasinoHistory(guildId, userId, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length ? ['**小吉賭場｜紀錄**', ...rows.map(formatHistoryRow)].join('\n') : '目前沒有賭場紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '小吉賭場剛剛執行失敗了，請稍後再試。');
    }
  },
};
