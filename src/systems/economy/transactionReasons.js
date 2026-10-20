'use strict';

// The reasons stored with coin transactions and rate changes, which admins read in /economy audit and
// /coin-admin history. New rows are written with the Chinese sentences below (reward keys aside). Rows
// written by older versions keep the fixed English reasons they were written with;
// describeTransactionReason names those in Chinese when they are shown, so old and new rows read alike.
// Anything it does not know (a reason an admin typed, or one an extension wrote) is shown as stored.

const BankReason = Object.freeze({
  DEPOSIT: '存入活存',
  WITHDRAW: '從活存領出',
  FIXED_PRINCIPAL_RETURNED: '定存到期返還本金',
  FIXED_INTEREST: '定存到期利息',
  FIXED_CANCEL_PRINCIPAL_RETURNED: '定存解約返還本金',
  FIXED_CANCEL_INTEREST: '定存解約利息',
  RATE_EVENT_EXPIRED: '活動利率到期',
  RATE_EVENT_RESTORED: '活動利率到期，自動恢復',
  DEFAULT_RATE: '預設利率',
});

const LuxuryReason = Object.freeze({
  INITIAL_PRICE: '初始價格',
});

function fixedDepositCreatedReason(termDays) {
  return `建立 ${termDays} 天定存`;
}

function bankInterestReason(payDate) {
  return `活存利息（${payDate}）`;
}

// Rewards paid through the reward coordinator store "<kind>:<reward kind>" as their reason. That key
// stays as it is when written (the reviewed venue-work snapshots pin it); it is named here when shown.
const rewardReasons = Object.freeze({
  'work-settlement:salary': '工作薪資結算',
  'game:completion': '遊戲完成獎勵',
  'owner-campaign:campaign': '活動發幣',
});

// Rewards paid by the daily features and the game server, by reward kind.
const featureRewardReasons = Object.freeze({
  participation: '參與獎勵',
  correct_answer: '答對獎勵',
  completion: '遊戲完成獎勵',
});

function featureRewardReason(rewardKind) {
  return featureRewardReasons[rewardKind] || `功能獎勵（${rewardKind}）`;
}

// The fixed English reasons older versions wrote, word for word.
const legacyReasons = new Map([
  ['bank deposit', BankReason.DEPOSIT],
  ['bank withdraw', BankReason.WITHDRAW],
  ['fixed deposit principal returned', BankReason.FIXED_PRINCIPAL_RETURNED],
  ['fixed deposit interest', BankReason.FIXED_INTEREST],
  ['fixed deposit principal returned after cancellation', BankReason.FIXED_CANCEL_PRINCIPAL_RETURNED],
  ['fixed deposit cancellation interest', BankReason.FIXED_CANCEL_INTEREST],
  ['event expired', BankReason.RATE_EVENT_EXPIRED],
  ['event expired auto restore', BankReason.RATE_EVENT_RESTORED],
  ['default rate', BankReason.DEFAULT_RATE],
  ['initial price', LuxuryReason.INITIAL_PRICE],
  ['initial price migration', '初始價格（資料升級時補記）'],
  ...Object.entries(rewardReasons),
]);

function describeTransactionReason(reason) {
  if (reason === null || reason === undefined) return '';
  const text = String(reason);
  if (legacyReasons.has(text)) return legacyReasons.get(text);
  const created = /^(\d+)-day fixed deposit created$/u.exec(text);
  if (created) return fixedDepositCreatedReason(created[1]);
  const interest = /^bank interest \(([^()]+)\)$/u.exec(text);
  if (interest) return bankInterestReason(interest[1]);
  const feature = /^feature reward: ([a-z_]+)$/u.exec(text);
  if (feature && Object.hasOwn(featureRewardReasons, feature[1])) return featureRewardReasons[feature[1]];
  return text;
}

module.exports = {
  BankReason,
  LuxuryReason,
  bankInterestReason,
  describeTransactionReason,
  featureRewardReason,
  fixedDepositCreatedReason,
};
