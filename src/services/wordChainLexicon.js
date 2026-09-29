// Both corpora are closed: no external service or generative model judges a move.
// Existing sessions without a stored version belong to the original curated corpus.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const legacyCorpusVersion = '2026.09.03-1';
const corpusVersion = 'moe-revised-2015_20260625+project-curated-2026.09.03-1';
const source = 'MOE revised dictionary original headwords + separately sourced project-curated words';

const legacyWords = Object.freeze([
  '安靜', '安全', '安心', '安慰', '愛心', '愛好', '愛情', '白天', '白雲', '白紙',
  '班級', '幫忙', '報告', '寶貝', '保護', '北方', '本來', '本人', '筆記', '變化',
  '表情', '標準', '冰箱', '餅乾', '病人', '播放', '博物館', '不安', '不錯', '不怕',
  '不行', '彩虹', '參加', '參考', '餐點', '草地', '測試', '成長', '成功', '城市',
  '誠實', '程式', '吃飯', '出發', '出門', '春天', '詞語', '聰明', '答應', '打招呼',
  '打掃', '大海', '大家', '大門', '大雨', '代表', '地點', '地方', '地圖', '電話',
  '電影', '動物', '讀書', '對話', '燈光', '等候', '風景', '風箏', '分享', '方向',
  '房間', '放學', '飛機', '非常', '分數', '服務', '附近', '父母', '負責', '感謝',
  '高興', '告訴', '哥哥', '歌聲', '公園', '公平', '功課', '工作', '故事', '關心',
  '關係', '觀察', '管理', '規則', '國家', '過去', '海邊', '孩子', '害怕', '好吃',
  '好看', '好玩', '合作', '花園', '畫面', '歡迎', '環境', '回家', '回答', '活動',
  '機會', '機器', '記得', '家人', '加入', '健康', '教室', '教育', '結果', '節日',
  '節目', '解釋', '介紹', '今天', '進步', '經驗', '精彩', '精神', '景色', '警察',
  '決定', '絕對', '開始', '開心', '開學', '看見', '考試', '可愛', '客人', '課本',
  '課程', '空氣', '空間', '口味', '快樂', '困難', '藍天', '老師', '禮物', '力量',
  '理解', '厲害', '歷史', '聯絡', '練習', '涼快', '兩個', '鄰居', '旅行', '綠色',
  '媽媽', '馬路', '滿意', '貓咪', '美麗', '美食', '夢想', '名稱', '明天', '明白',
  '明亮', '面前', '面貌', '朋友', '平安', '平常', '品格', '蘋果', '普通', '期待', '其他', '奇怪',
  '起床', '氣球', '前面', '鉛筆', '清楚', '清潔', '清新', '晴天', '請問', '秋天',
  '球場', '去年', '確定', '群組', '熱情', '認真', '日子', '容易', '如果', '入口',
  '色彩', '森林', '上課', '上學', '少年', '身體', '生活', '聲音', '生日', '時間',
  '世界', '事情', '市場', '食物', '實現', '適合', '收集', '手機', '書包', '舒服',
  '水杯', '水果', '說明', '思考', '四周', '速度', '歲月', '太陽', '天氣', '天空',
  '同學', '圖書館', '團體', '推薦', '外面', '完成', '玩具', '晚上', '忘記', '危險',
  '溫暖', '問題', '文化', '文章', '午餐', '希望', '喜歡', '夏天', '下雨', '相信',
  '想法', '想念', '校園', '笑容', '效果', '新聞', '心情', '心意', '星期', '幸福',
  '行動', '興趣', '需要', '學校', '學生', '學習', '雪花', '尋找', '亞洲', '顏色',
  '眼睛', '陽光', '邀請', '夜晚', '一切', '意見', '音樂', '飲料', '應該', '遊戲',
  '見面',
  '友善', '有趣', '雨傘', '語言', '原來', '遠方', '運動', '再見', '早安', '照片',
  '真正', '整潔', '知道', '植物', '智慧', '中午', '中文', '重要', '準備', '桌子',
  '自己', '自然', '足球', '昨天', '作業', '座位', '尊重', '最近', '最後', '做事',
]);

const assetDirectory = path.resolve(__dirname, '../../assets/word-chain');
const metadata = require('../../assets/word-chain/moe-revised-source.json');
const indexFile = 'moe-revised-2015_20260625.txt';
const usageFile = 'MOE-usage-revised.pdf';
if (metadata.indexFile !== indexFile || metadata.usageInstructionsFile !== usageFile) {
  throw new Error('MOE word-chain corpus metadata names do not match the published assets.');
}
const indexBytes = fs.readFileSync(path.join(assetDirectory, indexFile));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
if (
  metadata.sourceVersion !== '2015_20260625' ||
  hash(indexBytes) !== metadata.indexSha256 ||
  hash(fs.readFileSync(path.join(assetDirectory, usageFile))) !== metadata.usageInstructionsSha256
) {
  throw new Error('MOE word-chain corpus or its required usage instructions failed integrity verification.');
}
const moeWords = Object.freeze(indexBytes.toString('utf8').trimEnd().split('\n'));
const legacyWordSet = new Set(legacyWords);
const words = Object.freeze([...legacyWords, ...moeWords.filter((word) => !legacyWordSet.has(word))]);
const wordSet = new Set(words);

function createCorpusIndex(corpusWords) {
  const byInitial = new Map();
  for (const word of corpusWords) {
    const initial = Array.from(word)[0];
    if (!byInitial.has(initial)) byInitial.set(initial, []);
    byInitial.get(initial).push(word);
  }
  for (const successors of byInitial.values()) Object.freeze(successors);
  return { words: corpusWords, wordSet: new Set(corpusWords), byInitial };
}

const corpora = new Map([
  [legacyCorpusVersion, createCorpusIndex(legacyWords)],
  [corpusVersion, createCorpusIndex(words)],
]);

function getCorpus(version = corpusVersion) {
  const corpus = corpora.get(version);
  if (!corpus) throw new Error(`Unknown word-chain corpus version: ${version}`);
  return corpus;
}

function getSuccessors(word, version = corpusVersion) {
  const requiredInitial = Array.from(word).at(-1);
  return getCorpus(version).byInitial.get(requiredInitial) || [];
}

function assertCorpusInvariant() {
  if (
    legacyWords.length < 150 || legacyWordSet.size !== legacyWords.length ||
    moeWords.length !== metadata.uniqueHeadwords || new Set(moeWords).size !== moeWords.length ||
    wordSet.size !== words.length ||
    !words.every((word) => /^\p{Script=Han}{2,6}$/u.test(word))
  ) {
    throw new Error('Word-chain corpus invariant failed.');
  }
}

assertCorpusInvariant();

module.exports = {
  assertCorpusInvariant,
  corpusVersion,
  createCorpusIndex,
  getCorpus,
  getSuccessors,
  legacyCorpusVersion,
  legacyWords,
  metadata,
  moeWords,
  source,
  words,
  wordSet,
};
