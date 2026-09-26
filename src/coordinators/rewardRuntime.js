const { createRewardCoordinator } = require('./rewardCoordinator');
const { grantRewardOnceV2, getRewardReceiptV2, grantRewardOnceV2WithApi } = require('../services/featurePlatformService');

function createRuntimeRewardCoordinator() {
  return createRewardCoordinator({ grantRewardOnceV2, getRewardReceiptV2, grantRewardOnceV2WithApi });
}

module.exports = { createRuntimeRewardCoordinator };
