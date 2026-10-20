'use strict';

// Shared by the second-opinion invariant tests and the evaluation tool: reply samples from the policy corpora, and
// the classification of one sample through the real output check of the chat flow (see evaluateProviderReply).

const { decideRequestIngress, classifyOutputBlock, getConversationDecisionPayload } =
  require('../../src/systems/conversation/disclosurePolicy');
const { evaluateProviderReply } = require('../../src/systems/conversation/chatFlow');

const DEFAULT_USER_TEXT = '你好';
const DISPLAY_NAME = '小明';
const entryOf = (item) => (typeof item === 'string' ? { text: item } : item);

// label: 'attack' for text a reply must never carry, 'legit' for ordinary text. A corpus entry can carry the context
// it is judged in (userText, prior statements, model identifiers, display name).
function buildReplySamples(corpora) {
  const samples = [];
  const add = (group, index, entry, label) => {
    const source = entryOf(entry);
    const replyText = source.text ?? source.reply;
    if (typeof replyText !== 'string' || !replyText) return;
    samples.push({
      id: `${group}-${String(index + 1).padStart(3, '0')}`,
      group,
      label,
      userText: source.userText || DEFAULT_USER_TEXT,
      replyText,
      displayName: source.displayName || DISPLAY_NAME,
      prior: source.prior || [],
      modelIds: source.modelIds || null,
    });
  };
  corpora.REPLY_BLOCK.forEach((entry, index) => add('reply-block', index, entry, 'attack'));
  corpora.REPLY_ALLOW.forEach((entry, index) => add('reply-allow', index, entry, 'legit'));
  for (const [name, sentences] of Object.entries(corpora.ORDINARY_GROUPS)) {
    sentences.forEach((entry, index) => add(`ordinary-${name.toLowerCase()}`, index, entry, 'legit'));
  }
  const attacks = Object.values(corpora.ATTACK_GROUPS).flat();
  attacks.forEach((entry, index) => add('attack-as-reply', index, entry, 'attack'));
  for (const [name, variant] of Object.entries(corpora.VARIANTS)) {
    attacks.map((text) => variant(text)).filter(Boolean)
      .forEach((entry, index) => add(`attack-${name}-as-reply`, index, entry, 'attack'));
  }
  return samples;
}

// kind: 'ingress' (the question itself is not an ordinary one, so no reply is generated), 'pass' (delivered as
// it is), 'hard' (refused by a rule that no second opinion can relax) or 'soft' (refused only by a soft rule).
function classifySample(sample, { chatStyle = 'cute', romanceEnabled = false } = {}) {
  const ingressDecision = decideRequestIngress({ userText: sample.userText, priorUserStatements: sample.prior });
  if (ingressDecision.kind !== 'general') return { kind: 'ingress', classification: null };
  const evaluate = (waiveSoft) => evaluateProviderReply({
    ingressDecision,
    reply: sample.replyText,
    displayName: sample.displayName,
    userId: 'sample-user',
    chatStyle,
    romanceEnabled,
    waiveSoft,
    ...(sample.modelIds ? { protectedModelIds: sample.modelIds } : {}),
  });
  const classification = classifyOutputBlock(evaluate);
  const kind = !classification.blocked ? 'pass' : classification.softOnly ? 'soft' : 'hard';
  return { kind, classification, ingressDecision, evaluate };
}

const decisionKind = (result) => getConversationDecisionPayload(result.decision).kind;

module.exports = { buildReplySamples, classifySample, decisionKind };
