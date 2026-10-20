const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { validateWord } = require('../src/services/wordChainService');
const {
  assertCorpusInvariant,
  corpusVersion,
  createCorpusIndex,
  getCorpus,
  getSuccessors,
  hasWord,
  legacyCorpusVersion,
  legacyWords,
  moeWords,
  supplementWords,
  variantForms,
  wordKey,
  words,
} = require('../src/services/wordChainLexicon');

const HAN_WORD = /^\p{Script=Han}{2,6}$/u;

// Everyday words the MOE dictionary does not list. Each of them used to be answered with "not a common word".
const FORMERLY_REJECTED = Object.freeze([
  '雞排', '滷肉飯', '義大利麵', '鹹酥雞', '珍珠奶茶', '鬆餅',
  '褲子', '便利貼', '筆記本', '小狗', '小貓', '狗狗', '畫畫',
  '伺服器', '帳號', '充電器', '藍牙', '無線', '社群', '手遊', '下載', '上傳', '大數據', '區塊鏈', '行動電源',
  '筆電', '自拍', '線上',
  '臺北', '高雄', '臺南', '超市', '咖啡廳', '山上', '民宿',
  '網紅', '追劇', '外送', '珍奶', '按讚', '貼文', '私訊', '迷因', '梗圖', '直播主', '開箱', '團購', '悠遊卡',
  '行動支付', '加密貨幣', '比特幣', '電競', '社畜', '內捲', '斜槓', '宅配',
]);

// The same word written with the other form of a character: [as a player types it, as the dictionary spells it].
const WRITTEN_VARIANTS = Object.freeze([
  ['台灣', '臺灣'], ['台北', '臺北'], ['台中', '臺中'], ['台南', '臺南'], ['舞台', '舞臺'], ['平台', '平臺'],
  ['月台', '月臺'], ['櫃台', '櫃臺'], ['台燈', '臺燈'], ['周末', '週末'], ['周圍', '週圍'], ['周邊', '週邊'],
  ['秘密', '祕密'], ['温度', '溫度'], ['裏面', '裡面'], ['着急', '著急'], ['爲什麼', '為什麼'], ['証據', '證據'],
  ['麪包', '麵包'], ['户外', '戶外'], ['喫飯', '吃飯'], ['羣組', '群組'], ['啓動', '啟動'], ['大衆', '大眾'],
  ['山峯', '山峰'], ['脚踏車', '腳踏車'], ['綫上', '線上'], ['恒星', '恆星'], ['污染', '汙染'], ['兇手', '凶手'],
  ['事蹟', '事跡'], ['品嚐', '品嘗'], ['勳章', '勛章'], ['公佈', '公布'], ['佈置', '布置'], ['潮濕', '潮溼'],
  ['濕度', '溼度'], ['曬黑', '晒黑'], ['棟樑', '棟梁'], ['雇用', '僱用'], ['吧檯', '吧臺'],
]);

// Groups of headwords that share a key although they are not the same word in everyday use. They are the price of
// folding 檯 and 台 into 臺, which is what makes 台燈 and 吧台 words (the dictionary has 檯燈 and 吧檯, not 臺燈 and
// 吧臺), and the price is accepted on purpose:
//   轉檯 (a turntable, a revolving table) and 轉臺 (changing the channel);
//   上檯 and 上臺, which the dictionary lists as two separate words;
//   天台 (as in 天台山 and 天台宗) and 天臺 (a rooftop terrace).
// After one word of a pair has been used in a round the other counts as used. Do not shorten this list to make a
// test pass: either the table changes on purpose or the pair stays here.
const KNOWN_DIFFERENT_MEANING_GROUPS = Object.freeze([
  ['上檯', '上臺'], ['天台', '天臺'], ['轉檯', '轉臺'],
]);

// Every other group of headwords that share a key: one word written in two forms. A new group means a character was
// added to the table that merges more than spellings of one word, so it has to be reviewed.
const SAME_WORD_GROUPS = Object.freeze([
  ['事跡', '事蹟'], ['佈擺', '布擺'], ['佈散', '布散'], ['佈施', '布施'], ['佈菜', '布菜'], ['僱農', '雇農'],
  ['古跡', '古蹟'], ['吃力不討好', '喫力不討好'], ['名勝古跡', '名勝古蹟'], ['周年', '週年'], ['周歲', '週歲'],
  ['品嘗', '品嚐'], ['坐吃山崩', '坐喫山崩'], ['大吃一驚', '大喫一驚'], ['奇跡', '奇蹟'], ['抓周', '抓週'],
  ['擺佈', '擺布'], ['檯布', '臺布'], ['櫃檯', '櫃臺'], ['浸溼', '浸濕'], ['淺嘗', '淺嚐'], ['溼漉漉', '濕漉漉'],
  ['遺跡', '遺蹟'],
]);

// Words that are not words in any spelling.
const NOT_WORDS = Object.freeze([
  '球貓', '貓球', '天球貓', '亂碼詞', '台臺', '週周', '嗯嗯嗯', '台台', '北臺方', '臺北臺', '山山水水水',
]);

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('words people write with another form of a character are accepted as the same word', () => {
  for (const [typed, headword] of WRITTEN_VARIANTS) {
    const result = validateWord(typed);
    assert.equal(result.ok, true, `${typed} should be accepted`);
    // The answer keeps the spelling that was typed; only the comparison folds it.
    assert.equal(result.word, typed);
    assert.equal(wordKey(typed), wordKey(headword), `${typed} and ${headword} should share a key`);
    assert.equal(validateWord(headword).ok, true, `${headword} should be accepted`);
  }
});

test('the written-form table lists single characters, has no chains and does not merge other characters', () => {
  const entries = Object.entries(variantForms);
  assert.ok(entries.length >= 17 && entries.length <= 40, `unexpected table size ${entries.length}`);
  for (const [variant, standard] of entries) {
    assert.match(variant, /^\p{Script=Han}$/u);
    assert.match(standard, /^\p{Script=Han}$/u);
    assert.notEqual(variant, standard);
    assert.equal(Object.hasOwn(variantForms, standard), false, `${variant} -> ${standard} must not chain`);
    assert.equal(wordKey(variant), standard);
    assert.equal(wordKey(standard), standard);
  }
  // Characters with words and meanings of their own are never folded.
  for (const character of ['里', '后', '後', '妳', '你', '他', '她', '牠', '它', '份', '分', '面', '麵', '才', '纔']) {
    assert.equal(wordKey(character), character, character);
  }
  assert.equal(wordKey('里長'), '里長');
  assert.equal(wordKey('皇后'), '皇后');
  assert.equal(wordKey('妳們'), '妳們');
  assert.equal(wordKey(''), '');
  assert.equal(wordKey('球體'), '球體');
});

test('the words that share a key are pinned: spellings of one word and the known different-meaning pairs', () => {
  const groups = new Map();
  for (const word of words) {
    const key = wordKey(word);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  const shared = [...groups.values()].filter((group) => group.length > 1).map((group) => [...group].sort());
  const sortGroups = (list) => list.map((group) => [...group].sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(sortGroups(shared), sortGroups([...SAME_WORD_GROUPS, ...KNOWN_DIFFERENT_MEANING_GROUPS]));
});

test('the known different-meaning pairs are separate headwords that share a key on purpose', () => {
  const headwords = new Set(words);
  for (const [first, second] of KNOWN_DIFFERENT_MEANING_GROUPS) {
    assert.equal(headwords.has(first) && headwords.has(second), true, `${first} and ${second} are both headwords`);
    assert.equal(wordKey(first), wordKey(second), `${first} and ${second} share a key`);
    assert.equal(validateWord(first).ok && validateWord(second).ok, true);
  }
});

test('the former rejections are accepted', () => {
  for (const word of FORMERLY_REJECTED) {
    assert.equal(validateWord(word).ok, true, `${word} should be accepted`);
  }
});

test('words that are not words in any spelling are still refused', () => {
  for (const word of NOT_WORDS) {
    assert.equal(validateWord(word).ok, false, `${word} should be refused`);
    assert.equal(hasWord(word), false);
  }
  // Two random Han characters are almost never a word, and one that is accepted is a headword in some spelling.
  const random = createRandom(20261012);
  const pool = [...new Set([...supplementWords, ...moeWords.slice(0, 3000)].flatMap((word) => Array.from(word)))]
    .concat(Object.keys(variantForms));
  const headwordKeys = new Set(words.map(wordKey));
  let accepted = 0;
  const attempts = 6000;
  for (let index = 0; index < attempts; index += 1) {
    const pair = pool[Math.floor(random() * pool.length)] + pool[Math.floor(random() * pool.length)];
    const result = validateWord(pair);
    if (result.ok) {
      accepted += 1;
      assert.ok(headwordKeys.has(wordKey(pair)), `${pair} was accepted without being a word`);
    } else {
      assert.equal(result.code, 'UNKNOWN_WORD');
    }
  }
  assert.ok(accepted / attempts < 0.04, `${accepted} of ${attempts} random pairs were accepted`);
});

test('the supplement is its own list of valid, new words', () => {
  assert.ok(supplementWords.length >= 1500, `supplement has ${supplementWords.length} words`);
  assert.ok(supplementWords.every((word) => HAN_WORD.test(word)));
  assert.equal(new Set(supplementWords).size, supplementWords.length);
  assert.equal(new Set(supplementWords.map(wordKey)).size, supplementWords.length, 'one spelling per word');
  const legacySet = new Set(legacyWords);
  const headwordKeys = new Set([...legacyWords, ...moeWords].map(wordKey));
  for (const word of supplementWords) {
    assert.equal(legacySet.has(word), false, `${word} repeats a legacy word`);
    assert.equal(headwordKeys.has(wordKey(word)), false, `${word} is already a headword`);
    // Typed by a player, it is the word the supplement lists (no normalization or segmentation changes it).
    assert.equal(validateWord(word).word, word);
    assert.equal(validateWord(word).ok, true, `${word} should be accepted`);
  }
  assert.doesNotThrow(() => assertCorpusInvariant());
});

test('the supplement belongs to the current corpus only; the legacy corpus keeps its exact words', () => {
  const legacy = getCorpus(legacyCorpusVersion);
  const current = getCorpus(corpusVersion);
  assert.deepEqual(legacy.words, legacyWords);
  assert.equal(
    crypto.createHash('sha256').update(legacyWords.join('\n')).digest('hex'),
    '7f8e47afc46c2dac054994aa9adcf95d077ff20fc6dcff75da5be8906474e18b'
  );
  for (const word of supplementWords) {
    assert.equal(legacy.wordSet.has(word), false);
    assert.equal(current.wordSet.has(word), true);
  }
  for (const word of ['臺北', '高雄', '伺服器', '網紅']) {
    assert.equal(validateWord(word, legacyCorpusVersion).code, 'UNKNOWN_WORD', word);
    assert.equal(validateWord(word, corpusVersion).ok, true, word);
  }
  assert.deepEqual(current.words.slice(0, legacyWords.length), legacyWords);
  assert.deepEqual(current.words.slice(-supplementWords.length), supplementWords);
});

test('the words that may follow are found whichever form ends the previous word', () => {
  const standardForm = getSuccessors('舞臺');
  assert.ok(standardForm.length > 100);
  assert.deepEqual(getSuccessors('舞台'), standardForm);
  assert.deepEqual(getSuccessors('舞檯'), standardForm);
  assert.ok(standardForm.includes('臺北'));
  assert.ok(standardForm.includes('臺灣'));
  assert.deepEqual(getSuccessors('看着'), getSuccessors('看著'));
  assert.ok(getSuccessors('看著').includes('著名'));
  assert.deepEqual(getSuccessors('累垮'), ['垮臺']);
  // No word starts with a character that no word has.
  assert.deepEqual(getSuccessors('球\u{20000}'), []);
});

test('an index built from other words groups them by the key of the first character', () => {
  const index = createCorpusIndex(['台北', '臺中', '週年', '周歲', '北方']);
  assert.deepEqual(index.byInitial.get('臺'), ['台北', '臺中']);
  assert.deepEqual(index.byInitial.get('週'), ['週年', '周歲']);
  assert.equal(index.keySet.has('臺北'), true);
  assert.equal(index.keySet.has('台北'), false);
  assert.equal(index.wordSet.has('台北'), true);
  assert.equal(index.words.length, 5);
});
