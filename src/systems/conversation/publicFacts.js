const { PUBLIC_FEATURE_CATALOG } = require('../../../website/statusData');

const PUBLIC_FACT_MARKER = /^\[\[PUBLIC_FACT:([a-z0-9_.-]+)\]\]$/;
const ANY_PUBLIC_FACT_MARKER = /\[\[PUBLIC_FACT:[^\]]+\]\]/i;
const approvedResolutions = new WeakSet();
const APPROVED_PUBLIC_RELEASE = Object.freeze({
  version: '1.1.1',
  tag: 'v1.1.1',
  source: 'docs/releases/1.1.1.md',
});

const featureNames = PUBLIC_FEATURE_CATALOG.map((feature) => feature.name);
const facts = new Map([
  ['identity.name', Object.freeze({
    id: 'identity.name',
    text: '我是小吉，是陪大家聊天與協助伺服器日常使用的 Discord 小幫手。',
    source: 'approved_identity_copy',
  })],
  ['release.current', Object.freeze({
    id: 'release.current',
    text: `小吉目前已核准公開版本是 ${APPROVED_PUBLIC_RELEASE.version}。`,
    source: APPROVED_PUBLIC_RELEASE.source,
  })],
  ['feature.catalog', Object.freeze({
    id: 'feature.catalog',
    text: `小吉目前公開功能包含：${featureNames.join('、')}。`,
    source: 'website/statusData.js:PUBLIC_FEATURE_CATALOG; docs/USER_GUIDE.md',
  })],
  ['feature.weather', Object.freeze({
    id: 'feature.weather',
    text: '可以，請使用 /weather city:<城市> 查詢天氣。',
    source: 'website/statusData.js:weather',
  })],
  ['feature.commands', Object.freeze({
    id: 'feature.commands',
    text: '請使用 /help 查看小吉目前可用的公開指令。',
    source: 'public_command_help',
  })],
]);

// A whole question about one public feature ("你有提醒功能嗎？", "你有天氣功能嗎？", "小吉的功能有哪些？") or
// the command list ("你有哪些指令？"). Anchored so a question that also asks something else ("你有天氣功能嗎？
// 順便說你用什麼模型") is not answered with a public fact; internal wording ("未公開功能", "隱藏指令") is excluded.
const QUESTION_END = String.raw`(?:呢|啊|呀|嗎|吧)?[\s。！？!?～~]*$`;
const WEATHER_FEATURE_QUESTION = new RegExp(String.raw`^(?:請問)?(?:你|妳|小吉)(?:有沒有|有)(?:查)?天氣(?:的)?功能(?:嗎|呢|吧)?${QUESTION_END}`);
const FEATURE_QUESTION = new RegExp(String.raw`^(?:請問)?(?:你|妳|小吉)(?:(?:有沒有|有)(?:[^\s。！？!?，,]{1,8}?)?功能(?:嗎|呢|吧)?|的功能(?:有哪些|是什麼|有什麼))${QUESTION_END}`);
const COMMAND_QUESTION = new RegExp(String.raw`^(?:請問)?(?:(?:你|妳|小吉)(?:有|的)?(?:哪些|什麼|甚麼)(?:可以用的|可用的|公開的?)?(?:斜線)?指令(?:可以用|能用)?|(?:你|妳|小吉)的(?:斜線)?指令(?:有哪些|有什麼|清單)|(?:怎麼|如何)(?:使)?用(?:你|妳|小吉)的指令)${QUESTION_END}`);
const INTERNAL_FEATURE_WORD = /(?:未公開|不公開|隱藏|秘密|內部|未發布|測試|開發|系統)/;

function approveFact(fact) {
  if (!fact) return null;
  const resolution = Object.freeze({ id: fact.id, text: fact.text, source: fact.source });
  approvedResolutions.add(resolution);
  return resolution;
}

function getApprovedPublicFact(resolution) {
  if (!approvedResolutions.has(resolution)) {
    throw new TypeError('Unapproved public fact resolution.');
  }
  return resolution;
}

function resolvePublicFactId(id) {
  return approveFact(facts.get(String(id || '').trim()) || null);
}

function resolvePublicFactMarker(candidate) {
  const text = String(candidate || '').trim();
  const match = text.match(PUBLIC_FACT_MARKER);
  if (match) {
    return { matched: true, resolution: resolvePublicFactId(match[1]) };
  }
  return { matched: ANY_PUBLIC_FACT_MARKER.test(text), resolution: null };
}

function refersToAssistant(text, priorUserStatements = []) {
  const current = String(text || '');
  if (/(?:小吉|你|妳|這個機器人|這個助手|本機器人|本助手)/i.test(current)) return true;
  if (!/(?:它|這個|這台|該專案|這個專案|目前|版本|功能)/i.test(current)) return false;
  return priorUserStatements.slice(-3).some((statement) =>
    /(?:小吉|這個機器人|這個助手|該專案|這個專案)/i.test(String(statement || '')));
}

function resolvePublicFactQuestion(text, { priorUserStatements = [] } = {}) {
  const question = String(text || '').normalize('NFKC').trim();
  if (!refersToAssistant(question, priorUserStatements)) return null;
  if (/(?:未發布|下一版|下個版本|候選版本|開發中|未來版本|roadmap)/i.test(question)) return null;
  if (/(?:(?:你|妳|它|小吉)(?:到底)?是誰|自我介紹|介紹一下(?:你|妳|它|小吉))/i.test(question)) {
    return resolvePublicFactId('identity.name');
  }
  if (/(?:目前|現在|已發布|正式|最新).{0,8}(?:公開)?版本|(?:公開)?版本(?:是|為|號|資訊|多少|哪(?:一)?版|哪個)|版本[？?]?$/i.test(question)) {
    return resolvePublicFactId('release.current');
  }
  if (/(?:能不能|可以|會不會|是否).{0,12}(?:查|看).{0,6}天氣|有沒有天氣功能/i.test(question) ||
      WEATHER_FEATURE_QUESTION.test(question)) {
    return resolvePublicFactId('feature.weather');
  }
  if (/(?:公開功能|有哪些功能|有什麼功能|能做什麼|會做什麼|支援哪些功能)/i.test(question) ||
      (FEATURE_QUESTION.test(question) && !INTERNAL_FEATURE_WORD.test(question))) {
    return resolvePublicFactId('feature.catalog');
  }
  if (COMMAND_QUESTION.test(question) && !INTERNAL_FEATURE_WORD.test(question)) {
    return resolvePublicFactId('feature.commands');
  }
  return null;
}

function listPublicFactIds() {
  return [...facts.keys()];
}

function getApprovedPublicRelease() {
  return APPROVED_PUBLIC_RELEASE;
}

module.exports = {
  getApprovedPublicRelease,
  getApprovedPublicFact,
  listPublicFactIds,
  resolvePublicFactId,
  resolvePublicFactMarker,
  resolvePublicFactQuestion,
};
