'use strict';

// The states a daily event (the daily riddle, the daily discussion) can be in, as the status commands show them to an
// administrator. The stored values are the English words of the event table; a state this list does not know is shown
// as it is stored.
const dailyEventStatusLabels = Object.freeze({
  claimed: '已建立，等待發布',
  published: '已發布，進行中',
  published_late: '已發布（比預定時間晚），進行中',
  settling: '結算中',
  rewarding: '發放獎勵中',
  settled: '已結算',
  blocked: '已停止處理，需要管理員檢查',
  missed: '已錯過今天的發布時段',
  failed: '發布失敗，已停止重試',
});

function formatDailyEventStatus(status) {
  if (typeof status === 'string' && Object.hasOwn(dailyEventStatusLabels, status)) return dailyEventStatusLabels[status];
  return status || '尚未建立';
}

module.exports = { dailyEventStatusLabels, formatDailyEventStatus };
