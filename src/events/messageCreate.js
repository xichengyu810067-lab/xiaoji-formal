const { Events } = require('discord.js');
const { handleMentionMessage, isPublicPersistenceSuppressed } = require('../services/mentionService');
const { routeMessageFeatures } = require('../services/messageFeatureRouter');
const { handleStudentMessage } = require('../systems/conversation/student');
const { recordPublicMessage } = require('../services/memoryService');
const { recordPublicInteraction } = require('../services/publicStatusService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { captureIngressVisibility } = require('../systems/conversation/publicVisibility');
const { inspectMessageLinkRisk } = require('../systems/conversation/linkRiskMonitor');
const { createConversationPorts } = require('../coordinators/conversationCoordinator');

const conversationPorts = createConversationPorts();
const { authorizeMessage } = require('../platform/testControlIngress');

module.exports = {
  name: Events.MessageCreate,

  async execute(message) {
    if (
      !message?.author ||
      message.author.bot ||
      message.author.id === message.client.user?.id ||
      message.webhookId ||
      message.system
    ) {
      return;
    }

    const testIngress = authorizeMessage(message);
    if (!testIngress.allowed) return;

    // 在任何 await 前固定來源可見性；未知或私人狀態不可事後升級。
    captureIngressVisibility(message);

    // A message that looks like a phishing or malware lure is told to the Owner (a security alert); nothing is
    // deleted, muted or answered. This only reads the message and never waits for the optional second opinion.
    try {
      inspectMessageLinkRisk(message);
    } catch (error) {
      logger.error('link risk check failed', error);
    }

    try {
      const extensionResults = await getClientExtensionHost(message.client).runHook(
        'messageCreate',
        { message },
        { stopOnHandled: true }
      );
      if (extensionResults.some((item) => item.result?.handled)) return;
    } catch (error) {
      logger.error('private message hook failed', error);
    }

    // An answer in a running /student round (student.js); every other message goes on.
    try {
      if ((!message.client.testControlPolicy || message.client.testControlPolicy.allowsMessageFeature('conversation')) &&
          await handleStudentMessage(message)) {
        await recordPublicInteraction();
        return;
      }
    } catch (error) {
      logger.error('student message handling failed', error);
    }

    try {
      const featureResult = await routeMessageFeatures(message);
      if (featureResult.handled) {
        await recordPublicInteraction();
        return;
      }
      if (message.client.testControlPolicy && !testIngress.mention &&
          !message.client.testControlPolicy.allowsMessageFeature('conversation')) return;
    } catch (error) {
      logger.error('message feature routing failed', error);
    }

    let mentionResult;
    try {
      mentionResult = await handleMentionMessage(message, conversationPorts);
    } catch (error) {
      logger.error('mention message handling failed', error);
    }

    if (isPublicPersistenceSuppressed(mentionResult)) return;

    try {
      recordPublicMessage(message);
    } catch (error) {
      logger.error('public memory recording failed', error);
    }
  },
};
