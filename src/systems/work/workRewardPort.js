'use strict';

// The reward coordinator the work system pays salaries through. The work system is a set of module functions with no
// place where it is built, so the assembly root (src/index.js) hands it the one reward coordinator of the process here,
// once. The work system never builds a coordinator of its own: with none configured, payroll pauses (the transaction
// that would pay is rolled back and the next run tries again) until one is.
let rewardCoordinator = null;

// coinService is loaded when a refusal is made, not when this module is: the assembly root requires this module early
// and it should stay light.
function refusal(code, message) {
  const { CoinServiceError } = require('../../services/coinService');
  return new CoinServiceError(code, message);
}

// Takes the process's reward coordinator. Handing over the same one again is fine; a different one is refused, so that
// two coordinators in one process cannot go unnoticed.
function configureWorkRewardCoordinator(coordinator) {
  if (typeof coordinator?.grantInTransaction !== 'function') {
    throw refusal('WORK_REWARD_COORDINATOR_INVALID', 'The work reward coordinator needs a grantInTransaction function.');
  }
  if (rewardCoordinator !== null && rewardCoordinator !== coordinator) {
    throw refusal('WORK_REWARD_COORDINATOR_CONFLICT',
      'The work system already has a reward coordinator; the process has exactly one.');
  }
  rewardCoordinator = coordinator;
  return coordinator;
}

// The coordinator payroll pays through. The code and the message are those the work system already uses when the
// reward interface is not ready.
function getWorkRewardCoordinator() {
  if (rewardCoordinator === null) {
    throw refusal('WORK_REWARD_API_REQUIRED', '全域結算介面尚未就緒，暫停發薪。');
  }
  return rewardCoordinator;
}

// For tests only: a running process configures the coordinator once and keeps it.
function resetWorkRewardCoordinatorForTests() {
  rewardCoordinator = null;
}

module.exports = { configureWorkRewardCoordinator, getWorkRewardCoordinator, resetWorkRewardCoordinatorForTests };
