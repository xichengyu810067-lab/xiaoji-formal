const { Events } = require('discord.js');
const { restoreActivePolls } = require('../services/pollService');
const { restoreActiveReminders } = require('../services/reminderService');
const { processDueJobs, processExpiredWorkTasks, processWorkPenaltyAnnouncements, processWorkReminders } = require('../services/workService');
const { processBankInterest } = require('../services/bankService');
const { processCasinoLoanInterest, processExpiredBlackjackSessions } = require('../services/casinoService');
const { processExpiredVenueOrderItems } = require('../services/venueService');
const { processWordChainReactionOutbox } = require('../services/wordChainService');
const { processNumberChainReactionOutbox } = require('../services/numberChainService');
const { startDailyRiddleScheduler } = require('../services/dailyRiddleService');
const { startDailyDiscussionScheduler } = require('../services/dailyDiscussionService');
const { startPublicStatusServer } = require('../services/publicStatusServer');
const { startStatusSnapshotPublisher } = require('../services/statusSnapshotPublisher');
const { startGameServer } = require('../services/gameServer');
const { startReleaseAnnouncementScheduler } = require('../services/releaseAnnouncementService');
const { resumePendingGameRewards } = require('../services/gameService');
const {
  clearExpiredConversationHistory,
  startConversationHistoryCleanupScheduler,
} = require('../services/conversationHistoryService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { getBoardRuntime } = require('../systems/games/board/core/boardRuntimeRegistry');
const { getTestControlPolicy } = require('../platform/testControlPolicy');
const { enterTestReady } = require('../platform/testControlReady');
const { runWithBackgroundContext, runWithHostOperationContext } = require('../platform/hostOperationContext');

async function runStartupTask(label, task) {
  try {
    await task();
  } catch (error) {
    logger.error(`${label} 失敗。`, error);
  }
}

// Each run of a scheduled job gets its own background context (a fresh sourceEventId,
// no Discord actor and no grant).
function backgroundTask(job, task) {
  return () => runWithBackgroundContext(job, task);
}

// HTTP services and the private extension hook run outside any host context: request handlers
// and anything the hook starts inherit nothing from the ready event.
function withoutHostContext(task) {
  return () => runWithHostOperationContext(null, task);
}

// The interval never inherits the caller's host context. Public jobs pass a
// backgroundTask; tasks scheduled by the private extension run without a host context.
function scheduleStartupTask(label, task, intervalMs) {
  return runWithHostOperationContext(null, () => {
    void runStartupTask(label, task);
    const timer = setInterval(() => {
      void runStartupTask(label, task);
    }, intervalMs);
    timer.unref?.();
    return timer;
  });
}

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const testPolicy = getTestControlPolicy(client);
    if (testPolicy) {
      const runtimeControl = client.testControlRuntimeController;
      const startupDiagnostics = client.testControlStartupDiagnostics;
      runtimeControl?.assertRunning?.();
      startupDiagnostics?.enterPhase?.('READY_ENTRY');
      client.testControlEgress?.setDiagnosticPhase?.('ready_entry');
      try {
        await enterTestReady(client, testPolicy, {
          runtimeControl,
          jobs: {
            poll_restore: () => restoreActivePolls(client),
            reminder_restore: () => restoreActiveReminders(client),
            word_chain_reaction_outbox: backgroundTask('word-chain.reaction-outbox',
              () => processWordChainReactionOutbox(client)),
            number_chain_reaction_outbox: backgroundTask('number-chain.reaction-outbox',
              () => processNumberChainReactionOutbox(client)),
          },
        });
        runtimeControl?.assertRunning?.();
        runtimeControl?.markReady?.();
        startupDiagnostics?.markComplete?.();
      } catch (error) {
        startupDiagnostics?.reportFailure?.(error);
        throw error;
      }
      return;
    }
    logger.info(`小吉已登入：${client.user.tag}`);
    logger.info(`已載入 ${client.commands.size} 個 slash commands。`);
    
    await runStartupTask('AI 對話記憶過期清理', () => clearExpiredConversationHistory());
    await runStartupTask('AI 對話記憶清理排程啟動', () => startConversationHistoryCleanupScheduler());
    await runStartupTask('Discord 桌遊資料恢復', () => getBoardRuntime().startLifecycle());
    await runStartupTask('遊戲獎勵恢復', () => resumePendingGameRewards());
    await runStartupTask('遊戲服務啟動', withoutHostContext(() => startGameServer()));
    await runStartupTask('公開狀態服務啟動', withoutHostContext(() => startPublicStatusServer(client)));
    await runStartupTask('Cloudflare 公開狀態快照上傳啟動', () => startStatusSnapshotPublisher(client));
    await runStartupTask('每日猜謎排程啟動', () => startDailyRiddleScheduler(client));
    await runStartupTask('每日議題排程啟動', () => startDailyDiscussionScheduler(client));
    await runStartupTask('投票資料恢復', () => restoreActivePolls(client));
    await runStartupTask('提醒資料恢復', () => restoreActiveReminders(client));
    await runStartupTask('公開版本公告排程啟動', () => startReleaseAnnouncementScheduler(client));
    await runStartupTask('私有擴充啟動', withoutHostContext(() =>
      getClientExtensionHost(client).runHook('ready', { client, runStartupTask, scheduleStartupTask })
    ));

    // Job processing: Initial check and schedule every 5 minutes
    scheduleStartupTask('工作發薪排程', backgroundTask('work.payroll', () => processDueJobs(client)), 5 * 60 * 1000);

    // Work reminders: check every hour for pending tasks older than 10 hours.
    scheduleStartupTask('工作提醒排程', backgroundTask('work.reminder', () => processWorkReminders(client)),
      60 * 60 * 1000);

    scheduleStartupTask('逾期工作任務處理', backgroundTask('work.expired-tasks',
      () => processExpiredWorkTasks(client)), 15 * 60 * 1000);

    scheduleStartupTask('工作扣薪公告排程', backgroundTask('work.penalty-announcement',
      () => processWorkPenaltyAnnouncements(client)), 15 * 60 * 1000);

    // Bank interest: Initial check and schedule every 15 minutes
    scheduleStartupTask('銀行活存利息排程', backgroundTask('bank.interest', () => processBankInterest()),
      15 * 60 * 1000);

    // Casino loans use daily compounding interest; blackjack sessions are refunded after timeout.
    scheduleStartupTask('賭場貸款利息排程', backgroundTask('casino.loan-interest',
      () => processCasinoLoanInterest()), 15 * 60 * 1000);

    scheduleStartupTask('逾期 21 點退款排程', backgroundTask('casino.blackjack-refund',
      () => processExpiredBlackjackSessions()), 5 * 60 * 1000);

    // Restaurant/bar pending items are taken over by NPC staff after 24 hours.
    scheduleStartupTask('逾期場館訂單處理', backgroundTask('venue.expired-orders',
      () => processExpiredVenueOrderItems()), 15 * 60 * 1000);

    // Retry only bounded word-chain reaction deliveries.  The timer is unref'd by
    // scheduleStartupTask so it never keeps a clean shutdown alive.
    scheduleStartupTask('文字接龍確認反應重試', backgroundTask('word-chain.reaction-outbox',
      () => processWordChainReactionOutbox(client)), 30 * 1000);
    scheduleStartupTask('數字接龍確認反應重試', backgroundTask('number-chain.reaction-outbox',
      () => processNumberChainReactionOutbox(client)), 30 * 1000);
  },
};
