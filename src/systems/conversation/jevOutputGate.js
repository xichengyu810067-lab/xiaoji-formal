'use strict';

// Where the optional second opinion (jevClient.js) meets the output check of a model reply.
//
// The reply is first checked exactly as before. Only when that check refuses it, and a second run with just the soft
// output rules waived (disclosurePolicy.js, classifyOutputBlock) lets it through, can the second opinion matter at all:
// a reply that a hard rule refuses never reaches the service and is refused whatever the service would say. In
// "shadow" mode the verdict is only logged; in "enforce" mode a verdict of safe means the second run's decision (made
// by decideAssistantOutput, with every hard rule applied) is used. Any other outcome (risky, an error, a timeout, a
// server not on the list, the feature off) leaves the first decision untouched.

const { classifyOutputBlock } = require('./disclosurePolicy');
const { getDefaultJevClient, isGuildEnabled } = require('./jevClient');
const defaultLogger = require('../../utils/logger');

const VERDICTS = Object.freeze({ SAFE: 'safe', RISKY: 'risky', ERROR: 'error' });

function verdictOf(result) {
  if (!result || result.ok !== true) return VERDICTS.ERROR;
  return result.safe === true ? VERDICTS.SAFE : VERDICTS.RISKY;
}

// The client used when none is passed in: the one made from the environment, once.
function getDefaultJevRuntime() {
  return getDefaultJevClient();
}

// evaluate(waiveSoft) -> { decision, ... } is the whole output check of one reply (see classifyOutputBlock).
// Resolves to one of its results; the caller sends that result's decision.
async function resolveProviderOutput({
  evaluate,
  userText,
  replyText,
  displayNames = [],
  guildId,
  runtime = getDefaultJevRuntime(),
  loggerImpl = defaultLogger,
}) {
  const config = runtime?.config;
  const enabled = Boolean(config) && config.mode !== 'off' && isGuildEnabled(config, guildId) &&
    typeof runtime.judgeAssistantReply === 'function';
  if (!enabled) return evaluate(null);

  const classification = classifyOutputBlock(evaluate);
  if (!classification.softOnly) return classification.baseline;

  const log = (mode, verdict) => {
    try { loggerImpl.info(`[JEV_${mode}] verdict=${verdict}`); } catch { /* logging never changes a decision */ }
  };
  const ask = async () => {
    try {
      return verdictOf(await runtime.judgeAssistantReply({ userText, replyText, displayNames }));
    } catch {
      return VERDICTS.ERROR;
    }
  };

  if (config.mode === 'shadow') {
    // Observation only: the reply does not wait for it and its result changes nothing.
    const settled = ask().then((verdict) => log('SHADOW', verdict));
    return { ...classification.baseline, shadowSettled: settled };
  }

  const verdict = await ask();
  log('ENFORCE', verdict);
  return verdict === VERDICTS.SAFE ? classification.relaxed : classification.baseline;
}

module.exports = { VERDICTS, getDefaultJevRuntime, resolveProviderOutput };
