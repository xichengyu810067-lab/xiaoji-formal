const corpusVersion = 'daily-riddles-v1';

const riddles = Object.freeze([
  ['r001', '一年共有幾個月？', '12', ['十二', '十二個月'], '一年由十二個月組成。'],
  ['r002', '一般所說的彩虹共有幾種顏色？', '7', ['七', '七種'], '常見分類把彩虹分為七種顏色。'],
  ['r003', '在標準大氣壓下，水的攝氏冰點是多少度？', '0', ['零', '0度', '零度'], '標準大氣壓下，水在攝氏零度結冰。'],
  ['r004', '一天共有幾小時？', '24', ['二十四', '二十四小時'], '一天共有二十四小時。'],
  ['r005', '三角形共有幾條邊？', '3', ['三', '三條'], '三角形由三條邊構成。'],
  ['r006', '章魚一般有幾隻腕足？', '8', ['八', '八隻'], '章魚具有八隻腕足。'],
  ['r007', '一星期共有幾天？', '7', ['七', '七天'], '一星期共有七天。'],
  ['r008', '一打物品代表多少個？', '12', ['十二', '十二個'], '一打等於十二個。'],
  ['r009', '正常人類心臟共有幾個腔室？', '4', ['四', '四個'], '心臟有左右心房與左右心室，共四個腔室。'],
  ['r010', '太陽系目前公認共有幾顆行星？', '8', ['八', '八顆'], '依現行分類，太陽系有八顆行星。'],
  ['r011', '臺灣最高的山峰是哪一座？', '玉山', ['玉山主峰'], '玉山主峰海拔 3,952 公尺，是臺灣最高峰。'],
  ['r012', '水的化學式是什麼？', 'H2O', ['H₂O'], '一個水分子由兩個氫原子與一個氧原子組成。'],
  ['r013', '地球唯一的天然衛星叫什麼？', '月球', ['月亮'], '月球是地球唯一的天然衛星。'],
  ['r014', '地球面積最大的海洋是哪一個？', '太平洋', [], '太平洋是地球面積最大的海洋。'],
  ['r015', '最小的質數是多少？', '2', ['二'], '二只能被一和自身整除，也是最小的質數。'],
  ['r016', '一公里等於多少公尺？', '1000', ['一千', '1000公尺', '一千公尺'], '一公里等於一千公尺。'],
  ['r017', '正方形共有幾個直角？', '4', ['四', '四個'], '正方形的四個內角都是直角。'],
  ['r018', '現代英文字母表共有幾個字母？', '26', ['二十六', '二十六個'], '現代英文字母表共有二十六個字母。'],
  ['r019', '閏年共有幾天？', '366', ['三百六十六', '366天', '三百六十六天'], '閏年二月有二十九天，全年共三百六十六天。'],
  ['r020', '十二生肖共有幾種動物？', '12', ['十二', '十二種'], '十二生肖由十二種動物組成。'],
  ['r021', '東、西、南、北合稱幾個基本方位？', '4', ['四', '四個'], '東西南北是四個基本方位。'],
  ['r022', '化學元素金的元素符號是什麼？', 'Au', ['Ａｕ'], '金的化學元素符號是 Au。'],
  ['r023', '在傳統顏料混色中，紅色加藍色通常得到什麼顏色？', '紫色', ['紫'], '傳統顏料混色中，紅色與藍色通常混成紫色。'],
  ['r024', '水結冰後形成的固體叫什麼？', '冰', ['冰塊'], '液態水凝固後形成冰。'],
  ['r025', '一百的一半是多少？', '50', ['五十'], '一百除以二等於五十。'],
  ['r026', '九乘以九等於多少？', '81', ['八十一'], '九乘以九等於八十一。'],
  ['r027', '羅馬數字 X 代表多少？', '10', ['十'], '羅馬數字 X 代表十。'],
  ['r028', '一般說太陽從哪個方位升起？', '東方', ['東', '東邊'], '由於地球自西向東自轉，太陽看起來從東方升起。'],
  ['r029', '標準現代鋼琴通常有幾個琴鍵？', '88', ['八十八', '八十八個'], '標準現代鋼琴通常有八十八個琴鍵。'],
  ['r030', '依常見七大洲分類，地球共有幾大洲？', '7', ['七', '七大洲'], '常見地理分類將陸地分為七大洲。'],
  ['r031', '奧林匹克五環共有幾個環？', '5', ['五', '五個'], '奧林匹克標誌由五個相扣的環組成。'],
  ['r032', '六邊形共有幾條邊？', '6', ['六', '六條'], '六邊形由六條邊構成。'],
].map(([id, question, canonicalAnswer, acceptedAliases, explanation]) =>
  Object.freeze({
    id,
    question,
    canonicalAnswer,
    acceptedAliases: Object.freeze([...acceptedAliases]),
    explanation,
  })
));

function assertDailyRiddleCorpus() {
  if (riddles.length < 31) throw new Error('Daily riddle corpus requires at least 31 entries.');
  const ids = new Set();
  for (const riddle of riddles) {
    if (!/^r\d{3}$/.test(riddle.id) || ids.has(riddle.id)) throw new Error(`Invalid duplicate riddle id: ${riddle.id}`);
    ids.add(riddle.id);
    if (![riddle.question, riddle.canonicalAnswer, riddle.explanation].every((value) => typeof value === 'string' && value.trim())) {
      throw new Error(`Incomplete riddle: ${riddle.id}`);
    }
  }
  return true;
}

function selectRiddleForDate(localDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate))) throw new TypeError('localDate must use YYYY-MM-DD.');
  const dayNumber = Math.floor(Date.parse(`${localDate}T00:00:00.000Z`) / 86_400_000);
  if (!Number.isSafeInteger(dayNumber)) throw new TypeError('localDate is invalid.');
  return riddles[((dayNumber % riddles.length) + riddles.length) % riddles.length];
}

assertDailyRiddleCorpus();

module.exports = {
  assertDailyRiddleCorpus,
  corpusVersion,
  riddles,
  selectRiddleForDate,
};
