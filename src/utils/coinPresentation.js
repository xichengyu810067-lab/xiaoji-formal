const { CoinServiceError, ShopItemTypes } = require('../services/coinService');
const { CoinDatabaseError } = require('../services/coinDatabase');
const { replyEphemeral } = require('./moderation');
const logger = require('./logger');

const itemTypeLabels = {
  [ShopItemTypes.ROLE]: '身分組獎勵',
  [ShopItemTypes.TEXT_CHANNEL]: '文字頻道使用權',
  [ShopItemTypes.VOICE_CHANNEL]: '語音頻道使用權',
  [ShopItemTypes.TITLE]: '稱號或頭銜',
  [ShopItemTypes.COLLECTIBLE]: '收藏道具',
  [ShopItemTypes.INTERACTION]: '特殊互動道具',
  [ShopItemTypes.BATTLE_ITEM]: '對戰技能道具',
};

function formatCoins(amount) {
  return `${Number(amount || 0).toLocaleString('zh-TW')} 吉幣`;
}

function formatChips(amount) {
  return `${Number(amount || 0).toLocaleString('zh-TW')} 籌碼`;
}

function formatUser(user) {
  if (!user) {
    return '未知使用者';
  }

  const displayName = user.displayName || user.globalName || user.username || user.nickname;
  if (!displayName) {
    return '未知使用者';
  }

  return String(displayName).replace(/[@<>&]/g, '');
}

function formatItemType(type) {
  return itemTypeLabels[type] || type || '未知類型';
}

function formatStock(stock) {
  return stock === null || stock === undefined ? '不限' : String(stock);
}

function formatPurchaseLimit(limit) {
  return limit === null || limit === undefined ? '不限' : String(limit);
}

function formatShopItemLine(item) {
  const enabled = item.enabled ? '' : '（停用）';
  const roleText = item.roleId ? `｜身分組 <@&${item.roleId}>` : '';

  return [
    `#${item.id} **${item.name}**${enabled}`,
    `${formatCoins(item.price)}｜${formatItemType(item.type)}｜庫存 ${formatStock(item.stock)}｜每人限制 ${formatPurchaseLimit(item.purchaseLimit)}${roleText}`,
    item.description || '沒有描述',
  ].join('\n');
}

async function replyCoinError(interaction, error, fallbackMessage = '系統暫時無法處理吉幣資料，請稍後再試。') {
  async function send(message) {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(message);
      return;
    }

    await replyEphemeral(interaction, message);
  }

  if (error instanceof CoinServiceError) {
    let message = error.message;

    if (error.code === 'ALREADY_CHECKED_IN') {
      message = error.message;
    }

    if (error.code === 'INSUFFICIENT_FUNDS') {
      message = `${error.message}\n目前餘額：${formatCoins(error.details.balance)}\n需要金額：${formatCoins(error.details.required)}`;
    }

    if (error.code === 'NEGATIVE_BALANCE') {
      message = `${error.message}\n目前餘額：${formatCoins(error.details.balance)}。`;
    }

    await send(message);
    return;
  }

  if (error instanceof CoinDatabaseError) {
    logger.error(`/${interaction.commandName} coin database failed`, error);
    await send(fallbackMessage);
    return;
  }

  logger.error(`/${interaction.commandName} coin command failed`, error);
  await send(fallbackMessage);
}

module.exports = {
  formatChips,
  formatCoins,
  formatItemType,
  formatPurchaseLimit,
  formatShopItemLine,
  formatStock,
  formatUser,
  replyCoinError,
};
