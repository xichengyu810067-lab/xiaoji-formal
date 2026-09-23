const corpusVersion = 'daily-discussions-v1';
const safetyReminder = '請尊重不同觀點，勿人身攻擊、騷擾、仇恨、違法教唆或分享個人隱私；內容須遵守 Discord 規範、法律與一般道德界線。';

const topics = Object.freeze([
  ['d001', '如果社區多一處公共空間，你希望它如何被使用？為什麼？'],
  ['d002', '你認為一個讓人願意長期參與的線上社群，需要哪些特質？'],
  ['d003', '面對意見不同的人時，哪些溝通方式最能促進理解？'],
  ['d004', '學習新技能時，你偏好先理解原理還是先動手嘗試？原因是什麼？'],
  ['d005', '你會如何安排一天，讓工作、休息與興趣取得平衡？'],
  ['d006', '一項公共政策在追求效率與公平之間，應如何取捨？'],
  ['d007', '你認為科技產品應如何兼顧便利性與個人隱私？'],
  ['d008', '團隊做決策時，怎樣的流程能讓少數意見也被聽見？'],
  ['d009', '如果能改善居住地的一項交通設計，你會選什麼？'],
  ['d010', '你心目中有品質的休閒時間是什麼樣子？'],
  ['d011', '學校教育可以如何培養媒體識讀與查證習慣？'],
  ['d012', '面對資訊過量時，你用哪些方法判斷內容是否值得相信？'],
  ['d013', '遠距工作與實體辦公各有哪些難以取代的優點？'],
  ['d014', '社群管理規則要如何在清楚與保有彈性之間平衡？'],
  ['d015', '什麼樣的回饋最能幫助你持續進步？'],
  ['d016', '你認為公共圖書館還能增加哪些服務來回應現代需求？'],
  ['d017', '在有限預算下，城市應優先改善哪些生活設施？為什麼？'],
  ['d018', '你會如何向不同年齡的人介紹自己喜歡的一項興趣？'],
  ['d019', '一個好用的數位工具，最重要的設計原則是什麼？'],
  ['d020', '團隊合作中，分工明確與彈性支援應如何並存？'],
  ['d021', '你認為日常生活中有哪些小改變能減少資源浪費？'],
  ['d022', '當計畫臨時改變時，哪些做法有助於保持從容？'],
  ['d023', '博物館或展覽可以怎麼做，讓知識更容易被理解？'],
  ['d024', '你如何看待「慢一點做，但做得更扎實」這種選擇？'],
  ['d025', '什麼因素會讓你願意推薦一個地方或服務給朋友？'],
  ['d026', '線上討論中，如何區分有建設性的辯論與無效爭吵？'],
  ['d027', '如果每週固定留一段沒有螢幕的時間，你會如何運用？'],
  ['d028', '你認為遊戲除了娛樂之外，還可能帶來哪些正面價值？'],
  ['d029', '社區活動要如何設計，才能讓新加入的人也容易參與？'],
  ['d030', '遇到複雜問題時，你通常如何拆解並決定第一步？'],
  ['d031', '你認為理想的公共討論應有哪些基本禮儀？'],
  ['d032', '如果可以為未來保留一項現在的生活習慣，你會選什麼？'],
].map(([id, question]) => Object.freeze({ id, question, safetyReminder })));

function assertDailyDiscussionCorpus() {
  if (topics.length < 31) throw new Error('Daily discussion corpus requires at least 31 entries.');
  const ids = new Set();
  for (const topic of topics) {
    if (!/^d\d{3}$/.test(topic.id) || ids.has(topic.id)) throw new Error(`Invalid duplicate discussion id: ${topic.id}`);
    ids.add(topic.id);
    if (typeof topic.question !== 'string' || topic.question.trim().length < 12 || !/[？?]$/u.test(topic.question)) {
      throw new Error(`Discussion topic must be an open question: ${topic.id}`);
    }
    if (topic.safetyReminder !== safetyReminder) throw new Error(`Discussion safety reminder is missing: ${topic.id}`);
    if ('canonicalAnswer' in topic || 'acceptedAliases' in topic || 'answer' in topic) {
      throw new Error(`Discussion topic must not define a standard answer: ${topic.id}`);
    }
  }
  return true;
}

function selectDiscussionForDate(localDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate))) throw new TypeError('localDate must use YYYY-MM-DD.');
  const dayNumber = Math.floor(Date.parse(`${localDate}T00:00:00.000Z`) / 86_400_000);
  if (!Number.isSafeInteger(dayNumber)) throw new TypeError('localDate is invalid.');
  return topics[((dayNumber % topics.length) + topics.length) % topics.length];
}

assertDailyDiscussionCorpus();

module.exports = {
  assertDailyDiscussionCorpus,
  corpusVersion,
  safetyReminder,
  selectDiscussionForDate,
  topics,
};
