'use strict';

const logger = require('../../utils/logger');

// While 小吉 prepares an answer (reading images, loading memory, asking the model, which may search the web
// first), the member sees that it is working instead of silence:
//
// 1. Almost right away (THINKING_DELAY_MS), 小吉 replies "小吉思考中…" (the placeholder). The short delay keeps
//    silent what is meant to be silent: a request the provider guard refuses at once (a flood, a burst) gets no
//    placeholder, so a flood is not answered with one message per line. An answer within the delay needs none.
// 2. When the answer is ready, the placeholder itself becomes the answer: the first part of the reply edits it,
//    so the channel gets no extra message (takePlaceholder, used by the reply code).
// 3. If the answer takes longer than a minute, the placeholder is edited to say 小吉 is still working on it and
//    is not ignoring the member.
// 4. If the request ends with no reply at all, the placeholder is edited to say so (finish), so it never stays
//    at "thinking" forever.
//
// Everything here is best effort: a refused or failed request (the output budget, a deleted placeholder) is
// dropped quietly and never fails or delays the reply itself. These texts are fixed program text, not the model's
// words, so they are neither archived nor remembered. Edits of the placeholder run one after another.
const THINKING_TEXT = '小吉思考中…';
const THINKING_DELAY_MS = 1_500;
const LONG_WAIT_AFTER_MS = 60_000;
const LONG_WAIT_TEXT = '小吉還在努力想，這次比較久，請再等我一下～（不是不理你喔！）';
const UNANSWERED_TEXT = '小吉這次沒有想出回覆，請再問我一次 🙏';

const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });

function logDropped(kind, error) {
  logger.info(`[CHAT_WAIT_INDICATOR] ${kind} not sent: ${String(error?.code || error?.name || 'unknown').slice(0, 80)}`);
}

function startReplyWaitIndicator(message, {
  thinkingText = THINKING_TEXT,
  thinkingDelayMs = THINKING_DELAY_MS,
  longWaitAfterMs = LONG_WAIT_AFTER_MS,
  longWaitText = LONG_WAIT_TEXT,
  unansweredText = UNANSWERED_TEXT,
  timers = { setTimeout, clearTimeout },
} = {}) {
  let timersStopped = false;
  let taken = false;
  let finished = false;

  // The placeholder message, or null when it was not sent (cancelled before the delay, or failed).
  let settlePlaceholder;
  const placeholder = new Promise((resolve) => { settlePlaceholder = resolve; });
  let placeholderDecided = false;
  const sendPlaceholder = () => {
    if (placeholderDecided) return;
    placeholderDecided = true;
    if (typeof message?.reply !== 'function') {
      settlePlaceholder(null);
      return;
    }
    Promise.resolve()
      .then(() => message.reply({ content: thinkingText, allowedMentions: NO_MENTIONS }))
      .then((sent) => settlePlaceholder(sent && typeof sent.edit === 'function' ? sent : null), (error) => {
        logDropped('placeholder', error);
        settlePlaceholder(null);
      });
  };
  const thinkingTimer = thinkingDelayMs > 0 ? timers.setTimeout(sendPlaceholder, thinkingDelayMs) : null;
  thinkingTimer?.unref?.();
  if (!thinkingTimer) sendPlaceholder();
  // Before the delay is over: no placeholder at all.
  const cancelPlaceholder = () => {
    if (placeholderDecided) return;
    placeholderDecided = true;
    if (thinkingTimer) timers.clearTimeout(thinkingTimer);
    settlePlaceholder(null);
  };

  // Edits of the placeholder, kept in order so a late "still thinking" never lands after the answer.
  let editChain = Promise.resolve();
  const editPlaceholder = (kind, content) => {
    editChain = editChain
      .then(() => placeholder)
      .then((sent) => (sent ? sent.edit({ content, allowedMentions: NO_MENTIONS }) : undefined))
      .catch((error) => logDropped(kind, error));
    return editChain;
  };

  const longWaitTimer = longWaitAfterMs > 0
    ? timers.setTimeout(() => {
      if (timersStopped || taken || finished) return;
      editPlaceholder('long wait notice', longWaitText);
    }, longWaitAfterMs)
    : null;
  longWaitTimer?.unref?.();

  const stop = () => {
    cancelPlaceholder();
    if (timersStopped) return;
    timersStopped = true;
    if (longWaitTimer) timers.clearTimeout(longWaitTimer);
  };

  return {
    placeholder,
    // The wait is over: no placeholder is sent any more and no long-wait notice; a placeholder already sent stays
    // until it is taken or finished.
    stop,
    // For the reply: the placeholder message to edit into the first part of the answer, once. Resolves to null
    // when there is none (it failed, or was already taken), and the reply is then sent as a new message.
    async takePlaceholder() {
      stop();
      if (taken || finished) return null;
      taken = true;
      await editChain;
      return placeholder;
    },
    // At the end of the request: a placeholder no reply took says that no answer came.
    async finish() {
      stop();
      if (taken || finished) return;
      finished = true;
      await editPlaceholder('unanswered notice', unansweredText);
    },
  };
}

module.exports = {
  LONG_WAIT_AFTER_MS,
  LONG_WAIT_TEXT,
  THINKING_DELAY_MS,
  THINKING_TEXT,
  UNANSWERED_TEXT,
  startReplyWaitIndicator,
};
