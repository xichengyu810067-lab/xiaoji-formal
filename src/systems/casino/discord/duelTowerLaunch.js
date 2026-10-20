// Starts a duel tower challenge for /board start and answers the interaction with the settlement.
// These functions moved here from src/commands/duel-tower.js, which still exports executeDuelTowerGame
// under the same name, so the systems layer no longer has to load a command file.
const { enterDuelTower } = require('../../../services/casinoFacilityService');
const { formatChips } = require('../../../utils/coinPresentation');

function formatSignedChips(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatChips(Math.abs(numeric))}`;
}

function formatAutoTopUp(result) {
  return result.autoTopUpAmount > 0 ? `籌碼不足，已自動用吉幣兌換 ${formatChips(result.autoTopUpAmount)}。` : null;
}

async function executeDuelTowerGame(interaction) {
  const result = await enterDuelTower(interaction.guildId, interaction.user.id, {
    weaponItemId: interaction.options.getString('weapon-item-id', true),
    wager: interaction.options.getInteger('wager', true),
    interactionId: interaction.id,
  });
  const status = result.run.status === 'win' ? '勝利' : result.run.status === 'draw' ? '平手' : '落敗';
  await interaction.reply({
    content: [
      '**決鬥塔台｜挑戰結算**',
      `層數：第 ${result.run.floor} 層`,
      `對手：${result.run.opponentName}`,
      `武器：${result.run.weaponName}`,
      `結果：${status}`,
      `本次損益：${formatSignedChips(result.run.netAmount)}`,
      `籌碼餘額：${formatChips(result.balanceAfter)}`,
      formatAutoTopUp(result),
    ].filter(Boolean).join('\n'),
  });
  return result;
}

module.exports = { executeDuelTowerGame, formatSignedChips };
