'use strict';

// A refused AI request (AI_REQUEST_REFUSED, AI_PROMPT_INJECTION_BLOCKED) is a routine, member-caused event, and no
// Owner DM of its own: the catalogue does not send these two codes (notifiesOwner). The Owner hears of the attempt
// through a security alert (OWNER_EVENT_SECURITY_ALERT, raised by chatFlow.js), one fixed notice per guild and kind an
// hour. What is left here is the refusal's trace: a fixed-code log line (at most one per code a minute, the lines
// left out counted on the next one) and a test-control observation. It sends nothing and keeps no count per member.

const { SAFETY_EVENT_CODES } = require('../../platform/safetyEventCatalog');
const { observe: defaultObserve } = require('../../platform/testControlObservation');
const defaultLogger = require('../../utils/logger');
const { createFixedCodeLog } = require('./fixedCodeLog');

const REFUSAL_LOG_INTERVAL_MS = 60_000;
const REFUSAL_CODES = new Set([SAFETY_EVENT_CODES.AI_REQUEST_REFUSED, SAFETY_EVENT_CODES.AI_PROMPT_INJECTION_BLOCKED]);

class RefusalNoticeCap {
  constructor({ now = () => Date.now(), logger = defaultLogger, observe = defaultObserve } = {}) {
    this.now = now;
    this.observe = observe;
    this.codeLog = createFixedCodeLog({ intervalMs: REFUSAL_LOG_INTERVAL_MS, now: () => Number(this.now()), logger });
  }

  // Records one refused request; returns nothing, and no event leaves from here.
  report(code) {
    if (!REFUSAL_CODES.has(code)) throw new TypeError('Only refused AI requests are recorded here.');
    this.observe(`TEST_OBS_${code}`);
    this.codeLog.write(code, 'info', `[AI_SAFETY] code=${code}`);
  }

  resetForTests() {
    this.codeLog.clear();
  }
}

const refusalNoticeCap = new RefusalNoticeCap();

module.exports = {
  REFUSAL_LOG_INTERVAL_MS,
  RefusalNoticeCap,
  refusalNoticeCap,
};
