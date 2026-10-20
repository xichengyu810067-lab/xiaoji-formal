const { CoinServiceError, ShopItemTypes, TransactionType, describeTransactionReason } = require('../services/coinService');
const { CoinDatabaseError } = require('../services/coinDatabase');
const { replyEphemeral } = require('./moderation');
const { clipText } = require('./replyLengthGuard');
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

// The names admins read for the stored transaction types. A type without a name here (an older
// or extension-made one) is shown as it is stored.
const transactionTypeLabels = Object.freeze({
  [TransactionType.DAILY]: '每日簽到',
  [TransactionType.ADMIN_ADD]: '管理員加幣',
  [TransactionType.ADMIN_REMOVE]: '管理員扣幣',
  [TransactionType.ADMIN_SET]: '管理員設定餘額',
  [TransactionType.ADMIN_RESET_USER]: '管理員重置資料',
  [TransactionType.SHOP_PURCHASE]: '商店購買',
  [TransactionType.SYSTEM_REWARD]: '系統獎勵',
  [TransactionType.SYSTEM_REFUND]: '系統退款',
  [TransactionType.TRANSFER_IN]: '轉帳收入',
  [TransactionType.TRANSFER_OUT]: '轉帳支出',
  [TransactionType.BANK_DEPOSIT]: '存入活存',
  [TransactionType.BANK_WITHDRAW]: '領出活存',
  [TransactionType.BANK_INTEREST]: '活存利息',
  [TransactionType.FIXED_DEPOSIT_CREATE]: '建立定存',
  [TransactionType.FIXED_DEPOSIT_CLAIM]: '定存到期領回',
  [TransactionType.FIXED_DEPOSIT_CANCEL]: '定存解約',
  [TransactionType.FIXED_DEPOSIT_INTEREST]: '定存利息',
  [TransactionType.WORK_SALARY]: '工作薪資',
  [TransactionType.WORK_PENALTY_REFUND]: '扣薪退還',
  [TransactionType.BASIC_SALARY]: '基本薪資',
  [TransactionType.RATE_ADJUST]: '利率調整',
  [TransactionType.CASINO_BET]: '賭場下注',
  [TransactionType.CASINO_PAYOUT]: '賭場派彩',
  [TransactionType.CASINO_LOAN_BORROW]: '賭場借款',
  [TransactionType.CASINO_LOAN_REPAY]: '賭場還款',
  [TransactionType.CASINO_FORCED_COLLECTION]: '賭場強制收回',
  [TransactionType.CHIP_BUY]: '兌換籌碼',
  [TransactionType.CHIP_CASHOUT]: '籌碼換回吉幣',
  [TransactionType.LUXURY_PURCHASE]: '購買奢侈品',
  [TransactionType.PAWN_PAYOUT]: '典當入帳',
  [TransactionType.PAWN_REDEEM]: '贖回典當品',
  event_reward: '活動獎勵',
  tip_income: '小費收入',
});

const fixedDepositStatusLabels = Object.freeze({
  active: '存放中',
  matured: '已到期，可領取',
  claimed: '已領取',
  cancelled: '已解約',
});

const loanStatusLabels = Object.freeze({
  active: '借款中',
  repaid: '已還清',
});

const purchaseStatusLabels = Object.freeze({
  active: '有效',
  expired: '已過期',
});

// Shared by /work and the /economy audit, so a work status reads the same in both.
const workStatusLabels = Object.freeze({
  active: '進行中',
  paid: '已發薪',
  canceled: '已取消',
  failed: '發薪失敗',
  pending: '待審核',
  approved: '已核准',
  rejected: '已駁回',
  deleted: '已刪除',
  completed: '已完成',
  system_completed: '小吉接手完成',
  expired: '已逾期',
  cancelled: '已取消',
  no_work_available: '無工作可做',
  pending_legacy: '等待舊工作結清',
  closed: '本期已結束',
});

function formatTransactionType(type) {
  return transactionTypeLabels[type] || type || '未知類型';
}

// Old rows keep the fixed English reasons older versions wrote; they are named in Chinese here.
function formatTransactionReason(reason) {
  return describeTransactionReason(reason);
}

function formatFixedDepositStatus(status) {
  return fixedDepositStatusLabels[status] || status || '未知';
}

function formatLoanStatus(status) {
  return loanStatusLabels[status] || status || '未知';
}

function formatPurchaseStatus(status) {
  return purchaseStatusLabels[status] || status || '未知';
}

function formatWorkStatus(status) {
  return workStatusLabels[status] || status || '未知';
}

// demand is the demand-deposit rate and fixed_<days> the rate of that fixed-deposit term.
function formatRateKey(rateKey) {
  if (rateKey === 'demand') return '活存';
  const term = /^fixed_(\d+)$/u.exec(String(rateKey || ''));
  return term ? `${term[1]} 天定存` : rateKey || '未知利率';
}

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

// The name an admin reads for a member, the same in every reply: the server display name, then the
// global name, then the account tag. The member is optional; without it the user's own names are used.
function formatMemberName(user, member = null) {
  const name = member?.displayName || user?.globalName || user?.tag || user?.username;
  if (!name) {
    return '未知使用者';
  }

  return String(name).replace(/[@<>&]/g, '');
}

// A global primary job names the server it was chosen in. That ID is shown only when it is the server the command
// ran in; any other server is just "其他伺服器", so one server's answer never carries another server's ID.
function formatSourceGuild(sourceGuildId, currentGuildId) {
  return sourceGuildId && sourceGuildId === currentGuildId ? String(sourceGuildId) : '其他伺服器';
}

// True for a global primary job that was chosen in a server other than currentGuildId (or in an unknown one). When an
// administrator looks at another member, such a job is left out whole: its name would tell this server which job the
// member holds somewhere else.
function isForeignPrimaryJob(job, currentGuildId) {
  return Boolean(job) && job.scope === 'primary' && !(job.sourceGuildId && job.sourceGuildId === currentGuildId);
}

// Whether the latest settled pay of a member's global primary job may be shown to the server the command runs in
// when an administrator looks at another member: only a cycle that was started in this very server. (The job row
// changes its source server when the member chooses again, so the server of the job now says nothing about the
// pay of an earlier cycle.) A pay without a known source server is never shown.
function isPrimaryPayrollVisibleTo(payroll, currentGuildId) {
  return Boolean(payroll) && Boolean(payroll.sourceGuildId) && payroll.sourceGuildId === currentGuildId;
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

// textLimit is how many characters the name and the description may take. A long list passes a number and the text is
// cut with "…"; without it the line is shown whole.
function formatShopItemLine(item, { textLimit = Infinity } = {}) {
  const enabled = item.enabled ? '' : '（停用）';
  const roleText = item.roleId ? `｜身分組 <@&${item.roleId}>` : '';

  return [
    `#${item.id} **${clipText(item.name, textLimit)}**${enabled}`,
    `${formatCoins(item.price)}｜${formatItemType(item.type)}｜庫存 ${formatStock(item.stock)}｜每人限制 ${formatPurchaseLimit(item.purchaseLimit)}${roleText}`,
    clipText(item.description || '沒有描述', textLimit),
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

    if (error.code === 'INSUFFICIENT_BANK_FUNDS') {
      message = `${error.message}\n目前活存：${formatCoins(error.details.bankBalance)}\n需要金額：${formatCoins(error.details.required)}`;
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
  formatFixedDepositStatus,
  formatItemType,
  formatLoanStatus,
  formatMemberName,
  formatPurchaseLimit,
  formatPurchaseStatus,
  formatRateKey,
  formatShopItemLine,
  formatSourceGuild,
  isForeignPrimaryJob,
  isPrimaryPayrollVisibleTo,
  formatStock,
  formatTransactionReason,
  formatTransactionType,
  formatUser,
  formatWorkStatus,
  replyCoinError,
};
