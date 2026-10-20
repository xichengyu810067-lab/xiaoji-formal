'use strict';

// The invariant of the optional Jev second opinion: it may relax only a block that soft output rules caused. A judge
// that ALWAYS says safe is the worst case (the service failing open, or fooled by invented policy text). With it,
// every reply of the policy corpora that a hard rule refuses must stay refused, byte for byte as without the judge,
// and nothing that was delivered may change. The replies that only the soft rules refuse are the exposure when the
// judge fails open: they are counted, listed by group and pinned here, so that the exposure cannot grow unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-jev-invariants-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  INTERNAL_REPLY,
  createSoftWaiver,
  getConversationDecisionPayload,
} = require('../src/systems/conversation/disclosurePolicy');
const { resolveProviderOutput } = require('../src/systems/conversation/jevOutputGate');
const { parseJevConfig } = require('../src/systems/conversation/jevClient');
const { loadReplyCorpora } = require('./support/corpusLoader');
const { buildReplySamples, classifySample, decisionKind } = require('./support/jevCorpusSupport');

const GUILD = '111111111111111111';
const corpora = loadReplyCorpora(__dirname);
test.after(() => corpora.dispose());
const samples = buildReplySamples(corpora);

function alwaysSafeRuntime() {
  const calls = [];
  return {
    calls,
    config: parseJevConfig({
      JEV_MODE: 'enforce', JEV_API_KEY: 'synthetic-jev-key-0123456789', JEV_POLICY_ACK: 'yes', JEV_GUILD_IDS: GUILD,
    }, { loggerImpl: { warn() {} }, warned: new Set() }),
    judgeAssistantReply: async (input) => {
      calls.push(input);
      return { ok: true, safe: true, scores: { discloses_internals: 0, counterfeit_policy: 0 } };
    },
  };
}

const textOf = (result) => getConversationDecisionPayload(result.decision).text;

// Everything is evaluated once and shared by the tests below. A reply that is delivered anyway goes through the
// full path with the judge for every 8th sample only (it costs one more evaluation each); every refused reply does.
let evaluated = null;
async function evaluateAll() {
  if (evaluated) return evaluated;
  const rows = [];
  for (const [index, sample] of samples.entries()) {
    const classified = classifySample(sample);
    if (classified.kind === 'ingress') { rows.push({ sample, kind: 'ingress' }); continue; }
    const baseline = classified.classification.baseline;
    const row = {
      sample,
      kind: classified.kind,
      baselineKind: decisionKind(baseline),
      baselineText: textOf(baseline),
      checkedWithJudge: classified.kind !== 'pass' || index % 8 === 0,
    };
    if (row.checkedWithJudge) {
      const runtime = alwaysSafeRuntime();
      const withJudge = await resolveProviderOutput({
        evaluate: classified.evaluate, userText: sample.userText, replyText: sample.replyText, guildId: GUILD, runtime,
      });
      row.judgeCalls = runtime.calls.length;
      row.withJudgeKind = decisionKind(withJudge);
      row.withJudgeText = textOf(withJudge);
      // Independent of classifyOutputBlock: the same reply with every soft rule waived, run directly.
      row.waivedKind = decisionKind(classified.evaluate(createSoftWaiver()));
    }
    rows.push(row);
  }
  evaluated = rows;
  return rows;
}

test('the corpora are loaded in full', () => {
  const byGroup = Object.groupBy(samples, (sample) => sample.group);
  assert.ok(byGroup['reply-block'].length >= 278, `reply block ${byGroup['reply-block'].length}`);
  assert.ok(byGroup['reply-allow'].length >= 292, `reply allow ${byGroup['reply-allow'].length}`);
  assert.ok(samples.filter((sample) => sample.group.startsWith('ordinary-')).length >= 200);
  assert.ok(samples.filter((sample) => sample.group.startsWith('attack-')).length >= 120 * 7);
});

test('a hard refusal stays refused, with the same text, and the judge is never asked', async () => {
  const rows = (await evaluateAll()).filter((row) => row.kind === 'hard');
  assert.ok(rows.length > 500, `hard rows ${rows.length}`);
  const changed = rows.filter((row) => row.withJudgeKind !== 'refusal' || row.withJudgeText !== INTERNAL_REPLY ||
    row.withJudgeText !== row.baselineText || row.judgeCalls !== 0 || row.waivedKind !== 'refusal');
  assert.deepEqual(changed.map((row) => `${row.sample.id}: ${row.sample.replyText.slice(0, 60)}`), []);
});

test('a reply that was delivered is delivered unchanged and the judge is never asked', async () => {
  const rows = (await evaluateAll()).filter((row) => row.kind === 'pass' && row.checkedWithJudge);
  assert.ok(rows.length > 500, `delivered rows ${rows.length}`);
  const changed = rows.filter((row) => row.withJudgeKind !== 'allowed' || row.withJudgeText !== row.baselineText || row.judgeCalls !== 0);
  assert.deepEqual(changed.map((row) => row.sample.id), []);
});

test('a refusal is lifted only if it is gone once just the soft rules are waived, and only after one call', async () => {
  const rows = await evaluateAll();
  for (const row of rows.filter((entry) => entry.kind !== 'ingress' && entry.checkedWithJudge)) {
    const lifted = row.baselineKind === 'refusal' && row.withJudgeKind === 'allowed';
    if (lifted) {
      assert.equal(row.waivedKind, 'allowed', row.sample.id);
      assert.equal(row.judgeCalls, 1, row.sample.id);
      assert.equal(row.kind, 'soft', row.sample.id);
    } else {
      assert.equal(row.withJudgeKind, row.baselineKind, row.sample.id);
      assert.equal(row.withJudgeText, row.baselineText, row.sample.id);
    }
    if (row.waivedKind === 'refusal') assert.equal(row.withJudgeKind, 'refusal', `a hard rule was relaxed: ${row.sample.id}`);
    // Waiving soft rules never makes a delivered reply refused: the waiver is only ever less strict.
    if (row.baselineKind === 'allowed') assert.equal(row.waivedKind, 'allowed', `the waiver was stricter: ${row.sample.id}`);
  }
});

test('waiving names that are not soft rules, or in a form that is not a set, changes nothing', async () => {
  // 100 hard rows spread evenly over the whole list (reply block, attacks and every disguise), not the first 100.
  const allHard = (await evaluateAll()).filter((row) => row.kind === 'hard');
  const hardRows = Array.from({ length: 100 }, (_, index) => allHard[Math.floor((index * allHard.length) / 100)]);
  const forms = [
    new Set(['OUT_HARD', 'ALL', '*', 'SECRET', 'MODEL', 'PROMPT']), ['OUT_BOT_GENERIC', 'OUT_DEICTIC_FACT'], 'OUT_BOT_GENERIC',
    { has: () => true }, new Map([['OUT_BOT_GENERIC', true]]), new (class extends Set { has() { return true; } })(),
  ];
  const { evaluateProviderReply } = require('../src/systems/conversation/chatFlow');
  const { decideRequestIngress } = require('../src/systems/conversation/disclosurePolicy');
  for (const row of hardRows) {
    const ingressDecision = decideRequestIngress({ userText: row.sample.userText, priorUserStatements: row.sample.prior });
    for (const waiveSoft of forms) {
      const result = evaluateProviderReply({
        ingressDecision, reply: row.sample.replyText, displayName: row.sample.displayName, userId: 'sample-user',
        chatStyle: 'cute', romanceEnabled: false, waiveSoft,
        ...(row.sample.modelIds ? { protectedModelIds: row.sample.modelIds } : {}),
      });
      assert.equal(decisionKind(result), 'refusal', `${row.sample.id} ${String(waiveSoft)}`);
    }
  }
});

// The exposure: replies that only the soft rules refuse. If the judge fails open they are delivered.
// A group with a count here is listed on purpose; a new entry in the corpora that is soft only changes a count
// and fails this test, so that someone reads it before it ships.
const EXPECTED_ATTACK_EXPOSURE = Object.freeze({
  'reply-block': 0,
  'attack-as-reply': 0,
  'attack-base64-as-reply': 0,
  'attack-hex-as-reply': 0,
  'attack-percent-as-reply': 0,
  'attack-fullWidth-as-reply': 0,
  'attack-zeroWidth-as-reply': 0,
  'attack-spaced-as-reply': 0,
});

test('exposure: the replies of the attack corpora that only a soft rule refuses are exactly the pinned ones', async () => {
  const rows = (await evaluateAll()).filter((row) => row.sample.label === 'attack' && row.kind === 'soft');
  const counts = Object.fromEntries(Object.keys(EXPECTED_ATTACK_EXPOSURE).map((group) => [group, 0]));
  for (const row of rows) counts[row.sample.group] = (counts[row.sample.group] ?? 0) + 1;
  assert.deepEqual(counts, EXPECTED_ATTACK_EXPOSURE);
  assert.equal(Object.values(EXPECTED_ATTACK_EXPOSURE).reduce((sum, count) => sum + count, 0), 0, 'the exposure is zero');
  assert.deepEqual(rows.map((row) => row.sample.replyText), []);
});

test('exposure: no reply of the confidentiality corpus that must be blocked is soft only', async () => {
  const rows = (await evaluateAll()).filter((row) => row.sample.group === 'reply-block');
  assert.ok(rows.length >= 278);
  assert.deepEqual(rows.filter((row) => row.kind === 'soft').map((row) => row.sample.replyText), []);
  // Replies of that list that are delivered today are the corpus's known limitations; they do not change.
  const delivered = rows.filter((row) => row.kind === 'pass').map((row) => row.sample.id);
  assert.ok(delivered.length <= 2, `delivered: ${delivered.join(', ')}`);
  assert.ok(rows.every((row) => row.kind !== 'pass' || !row.checkedWithJudge || row.withJudgeText === row.baselineText));
});

// The corpora hold almost no ordinary text that a soft rule refuses. The one there was ("這個專案的設定檔裡有 token 嗎")
// names a token beside a bare pronoun, which is now a hard rule: the price of keeping every strong topic hard.
test('the ordinary corpus text that a soft rule refuses is the part the judge can win back (none is left)', async () => {
  const rows = (await evaluateAll()).filter((row) => row.sample.label === 'legit' && row.kind === 'soft');
  assert.deepEqual(rows.map((row) => row.sample.replyText), []);
  for (const row of rows) assert.equal(row.withJudgeKind, 'allowed');
});
