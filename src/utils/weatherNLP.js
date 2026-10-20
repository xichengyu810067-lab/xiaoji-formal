const { districts: TAIWAN_DISTRICTS } = require('./taiwanDistricts.json');

// ---------------------------------------------------------------------------
// Taiwan counties, cities and districts
// ---------------------------------------------------------------------------

const COUNTY_NAMES = [...new Set(TAIWAN_DISTRICTS.map((entry) => entry.county))];
const COUNTY_TO_DISTRICTS = new Map(COUNTY_NAMES.map((county) => [
  county, TAIWAN_DISTRICTS.filter((entry) => entry.county === county),
]));
const COUNTY_ALIASES = COUNTY_NAMES.flatMap((county) => {
  const stem = county.slice(0, -1);
  return [county, stem].map((alias) => ({ alias, county }));
}).sort((a, b) => b.alias.length - a.alias.length);
COUNTY_ALIASES.push({ alias: '北市', county: '臺北市' }, { alias: '竹縣', county: '新竹縣' });

// Common English names of Taiwan's counties and cities (and the two districts the old overseas
// lookup knew by name), written the way older settings and members type them. A bare city name
// means the city, as the overseas provider read it: Hsinchu is 新竹市, Hsinchu County is 新竹縣.
const TAIWAN_ENGLISH_NAMES = new Map([
  ['taipei', '臺北市'], ['new taipei', '新北市'], ['newtaipei', '新北市'], ['xinbei', '新北市'],
  ['taoyuan', '桃園市'], ['taichung', '臺中市'], ['tainan', '臺南市'], ['kaohsiung', '高雄市'],
  ['keelung', '基隆市'], ['jilong', '基隆市'], ['hsinchu', '新竹市'], ['xinzhu', '新竹市'],
  ['hsinchu county', '新竹縣'], ['miaoli', '苗栗縣'], ['changhua', '彰化縣'], ['nantou', '南投縣'],
  ['yunlin', '雲林縣'], ['chiayi', '嘉義市'], ['jiayi', '嘉義市'], ['chiayi county', '嘉義縣'],
  ['pingtung', '屏東縣'], ['yilan', '宜蘭縣'], ['ilan', '宜蘭縣'], ['hualien', '花蓮縣'],
  ['taitung', '臺東縣'], ['penghu', '澎湖縣'], ['kinmen', '金門縣'], ['lienchiang', '連江縣'],
  ['matsu', '連江縣'], ['zhubei', '新竹縣竹北市'], ['jhubei', '新竹縣竹北市'], ['zhongli', '桃園市中壢區'],
]);

// The Chinese name for an English Taiwan place name, or null. Case, a trailing country (TW,
// Taiwan) and a trailing City, County or District are ignored, so "Hsinchu, TW" and "Taipei City"
// are found too.
function resolveTaiwanEnglishName(input) {
  let key = String(input || '').normalize('NFKC').toLowerCase()
    .replace(/[,._\-()]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/ (tw|taiwan|roc)$/u, '');
  if (TAIWAN_ENGLISH_NAMES.has(key)) return TAIWAN_ENGLISH_NAMES.get(key);
  key = key.replace(/ (city|district|county)$/u, '');
  return TAIWAN_ENGLISH_NAMES.get(key) || null;
}

function normalizeTaiwanName(value) {
  return String(value || '').normalize('NFC').replace(/台/g, '臺');
}

// Simplified characters that turn up in a weather question, each with the traditional character
// every word list in this file is written in. A sentence is converted before it is read, so
// 天气 / 气温 / 预报 / 吗 / 怎么样 / 广州 are read as 天氣 / 氣溫 / 預報 / 嗎 / 怎麼樣 / 廣州. Only
// characters that are simplified-only are listed (后 is handled apart: 后里 is a district).
const SIMPLIFIED_TO_TRADITIONAL = new Map(
  ('气氣 温溫 预預 报報 吗嗎 么麼 样樣 会會 几幾 热熱 带帶 伞傘 没沒 点點 东東 广廣 义義 区區 镇鎮 乡鄉 县縣 '
    + '湾灣 门門 岛島 兰蘭 园園 莲蓮 连連 马馬 观觀 龙龍 凤鳳 头頭 员員 势勢 万萬 华華 荣榮 来來 乌烏 鸟鳥 '
    + '绿綠 屿嶼 铜銅 锣鑼 桥橋 莺鶯 冈岡 丰豐 内內 阴陰 云雲 雾霧 风風 湿濕 凉涼 冻凍 间間 时時 现現 '
    + '请請 问問 谢謝 帮幫 诉訴 个個 这這 还還 对對 为為 说說 话話 觉覺 应應 该該 别別 关關 礼禮 纽紐 约約 '
    + '旧舊 矶磯 '
    // The characters of Taiwan's district names that have a simplified form (庄 is left out:
    // 南庄 is written with it).
    + '坜壢 树樹 峡峽 栖棲 营營 盐鹽 归歸 庙廟 学學 恒恆 峦巒 兴興 坛壇 壮壯 寿壽 宁寧 宝寶 将將 仑崙 弥彌 '
    + '复復 爱愛 杨楊 乐樂 横橫 满滿 浓濃 滨濱 狮獅 玛瑪 线線 罗羅 脚腳 芦蘆 苏蘇 贡貢 车車 军軍 达達 边邊 '
    + '长長 双雙 馆館 鱼魚 麦麥 龟龜').split(' ').map((pair) => [pair[0], pair[1]]),
);
const SIMPLIFIED_PATTERN = new RegExp(`[${[...SIMPLIFIED_TO_TRADITIONAL.keys()].join('')}]`, 'gu');

function toTraditional(value) {
  return String(value || '')
    .replace(SIMPLIFIED_PATTERN, (character) => SIMPLIFIED_TO_TRADITIONAL.get(character))
    .replace(/概率/gu, '機率')
    .replace(/后(?!里)/gu, '後');
}

function districtAliases(district) {
  const aliases = [district];
  if (/[區鄉鎮市]$/.test(district)) aliases.push(district.slice(0, -1));
  return aliases;
}

function findDistrictMatches(input, entries) {
  return entries.filter((entry) => districtAliases(entry.district).includes(input));
}

// ---------------------------------------------------------------------------
// Overseas cities
// ---------------------------------------------------------------------------

// [the name the weather provider finds, Chinese names (Traditional and Simplified), other English
// names]. A Chinese name found in a sentence is replaced by the first, English, name.
const OVERSEAS_CITIES = Object.freeze([
  ['Tokyo', ['東京', '東京都', '东京'], []],
  ['Osaka', ['大阪'], []],
  ['Kyoto', ['京都'], []],
  ['Nagoya', ['名古屋'], []],
  ['Fukuoka', ['福岡', '福冈'], []],
  ['Sapporo', ['札幌'], []],
  ['Naha', ['沖繩', '沖縄', '冲绳', '那霸'], ['okinawa']],
  ['Yokohama', ['橫濱', '横濱', '横浜', '横滨'], []],
  ['Kobe', ['神戶', '神户'], []],
  ['Sendai', ['仙台'], []],
  ['Hiroshima', ['廣島', '广岛'], []],
  ['Nara', ['奈良'], []],
  ['Seoul', ['首爾', '首尔', '漢城'], []],
  ['Busan', ['釜山'], []],
  ['Bangkok', ['曼谷'], []],
  ['Chiang Mai', ['清邁', '清迈'], []],
  ['Phuket', ['普吉島', '普吉岛'], []],
  ['Singapore', ['新加坡'], []],
  ['Kuala Lumpur', ['吉隆坡'], []],
  ['Hong Kong', ['香港'], ['hk']],
  ['Macau', ['澳門', '澳门'], ['macao']],
  ['Shanghai', ['上海'], []],
  ['Beijing', ['北京'], []],
  ['Shenzhen', ['深圳'], []],
  ['Guangzhou', ['廣州', '广州'], []],
  ['Chengdu', ['成都'], []],
  ['Hangzhou', ['杭州'], []],
  ['Hanoi', ['河內', '河内'], []],
  ['Da Nang', ['峴港', '岘港'], []],
  ['Ho Chi Minh City', ['胡志明市', '胡志明'], ['ho chi minh', 'saigon']],
  ['Denpasar', ['峇里島', '峇里岛', '巴里島', '巴厘島', '巴厘岛', '峇里'], ['bali']],
  ['Manila', ['馬尼拉', '马尼拉'], []],
  ['Jakarta', ['雅加達', '雅加达'], []],
  ['New York', ['紐約', '纽约'], ['nyc', 'new york city']],
  ['Los Angeles', ['洛杉磯', '洛杉矶'], []],
  ['San Francisco', ['舊金山', '旧金山'], []],
  ['Seattle', ['西雅圖', '西雅图'], []],
  ['Chicago', ['芝加哥'], []],
  ['Boston', ['波士頓', '波士顿'], []],
  ['Miami', ['邁阿密', '迈阿密'], []],
  ['Washington, US', ['華盛頓', '华盛顿'], ['washington', 'washington dc']],
  ['Las Vegas', ['拉斯維加斯', '拉斯维加斯'], []],
  ['Honolulu', ['夏威夷'], ['hawaii']],
  ['Vancouver', ['溫哥華', '温哥华'], []],
  ['Toronto', ['多倫多', '多伦多'], []],
  ['Mexico City', ['墨西哥城'], []],
  ['London', ['倫敦', '伦敦'], []],
  ['Paris', ['巴黎'], []],
  ['Berlin', ['柏林'], []],
  ['Munich', ['慕尼黑'], []],
  ['Frankfurt', ['法蘭克福', '法兰克福'], []],
  ['Rome', ['羅馬', '罗马'], []],
  ['Milan', ['米蘭', '米兰'], []],
  ['Madrid', ['馬德里', '马德里'], []],
  ['Barcelona', ['巴塞隆納', '巴塞羅那', '巴賽隆納', '巴塞罗那'], []],
  ['Lisbon', ['里斯本'], []],
  ['Amsterdam', ['阿姆斯特丹'], []],
  ['Copenhagen', ['哥本哈根'], []],
  ['Vienna', ['維也納', '维也纳'], []],
  ['Prague', ['布拉格'], []],
  ['Zurich', ['蘇黎世', '苏黎世'], []],
  ['Athens', ['雅典'], []],
  ['Moscow', ['莫斯科'], []],
  ['Istanbul', ['伊斯坦堡', '伊斯坦布爾', '伊斯坦布尔'], []],
  ['Dubai', ['杜拜', '迪拜'], []],
  ['Cairo', ['開羅', '开罗'], []],
  ['Mumbai', ['孟買', '孟买'], []],
  ['New Delhi', ['新德里'], ['delhi']],
  ['Sydney', ['雪梨', '悉尼'], []],
  ['Melbourne', ['墨爾本', '墨尔本'], []],
  ['Brisbane', ['布里斯本', '布里斯班'], []],
  ['Auckland', ['奧克蘭', '奥克兰'], []],
].map(([english, chinese, others]) => Object.freeze([english, Object.freeze(chinese), Object.freeze(others)])));

// Chinese name -> English name, and lower-case English name -> English name.
const OVERSEAS_CHINESE_LOOKUP = new Map();
const OVERSEAS_ENGLISH_LOOKUP = new Map();
for (const [english, chinese, others] of OVERSEAS_CITIES) {
  // A name is looked up in the form a sentence is read in (see toTraditional).
  for (const name of chinese) OVERSEAS_CHINESE_LOOKUP.set(toTraditional(normalizeTaiwanName(name)), english);
  for (const name of [english, ...others]) {
    OVERSEAS_ENGLISH_LOOKUP.set(name.toLowerCase().replace(/, [a-z]+$/u, ''), english);
  }
}
const MAX_OVERSEAS_NAME_LENGTH = Math.max(...[...OVERSEAS_CHINESE_LOOKUP.keys()].map((name) => name.length));

// The English name the weather provider knows for a Chinese overseas city name ("東京" ->
// "Tokyo"), or null. The whole input must be the name; a trailing 市 is tolerated.
function resolveOverseasCityName(input) {
  const key = toTraditional(normalizeTaiwanName(String(input || '').normalize('NFKC')))
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!key) return null;
  if (OVERSEAS_CHINESE_LOOKUP.has(key)) return OVERSEAS_CHINESE_LOOKUP.get(key);
  if (key.length > 2 && key.endsWith('市')) return OVERSEAS_CHINESE_LOOKUP.get(key.slice(0, -1)) || null;
  return null;
}

// ---------------------------------------------------------------------------
// Words of a weather question
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// A literal phrase as a pattern. Phrases that start or end with a Latin letter or digit must not
// sit inside a longer Latin word ("rain" in "train").
function phrasePattern(phrase) {
  const head = /^[a-z0-9]/u.test(phrase) ? '(?<![a-z0-9])' : '';
  const tail = /[a-z0-9]$/u.test(phrase) ? '(?![a-z0-9])' : '';
  return `${head}${escapeRegExp(phrase)}${tail}`;
}

// The longer phrase is listed first, so "這週末" is read before "這週" and "週末".
function phraseAlternation(phrases) {
  return [...new Set(phrases)].sort((a, b) => b.length - a.length).map(phrasePattern).join('|');
}

// A named day of the week ("週五", "禮拜天", "Friday") is read as the week: the weekly forecast
// holds that day, where "today" would be an answer about another day.
const WEEKDAY_WORDS = [
  ...['週', '周', '禮拜', '星期'].flatMap((prefix) => ['一', '二', '三', '四', '五', '六', '日', '天'].map((day) => prefix + day)),
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

// Saturday and Sunday together, with the words that put "this" or "next" in front of them: the
// prefix is a time word of its own ("這個禮拜" is the week), and a sentence is read word by word,
// so the whole phrase has to be listed to be read as the weekend.
const WEEKEND_PAIRS = ['禮拜六日', '星期六日', '週六日', '周六日', '週六週日', '周六周日'];
const THIS_WEEKEND_WORDS = ['', '這個', '這', '本'].flatMap((prefix) => WEEKEND_PAIRS.map((pair) => prefix + pair));
const NEXT_WEEKEND_WORDS = ['下個', '下'].flatMap((prefix) => WEEKEND_PAIRS.map((pair) => prefix + pair));

// The time a question is about. When a sentence names more than one, the first group below wins:
// a range beats a single day, and a later day beats today. The next weekend is the week: it is
// further away than this weekend, and a 7-day forecast may not reach it, so it is never answered
// with this weekend's days.
const TIME_GROUPS = Object.freeze([
  {
    time: 'weekend',
    words: [
      '這個週末', '這個周末', '這週末', '這周末', '本週末', '本周末',
      '週末', '周末', '假日', 'weekend', ...THIS_WEEKEND_WORDS,
    ],
  },
  {
    time: 'week',
    words: [
      '這個禮拜', '這禮拜', '本禮拜', '這個星期', '這星期', '本星期', '這個週', '這個周', '這一週', '這一周',
      '這週', '這周', '本週', '本周', '這幾天', '未來幾天', '近幾天', '接下來幾天', '未來一週', '未來一周',
      '未來七天', '未來7天', '未來一個禮拜', '未來一個星期', '一個禮拜', '一個星期', '一週', '一周', '七天',
      '7天', '下個禮拜', '下禮拜', '下個星期', '下星期', '下週', '下周', '大後天',
      '下個週末', '下個周末', '下週末', '下周末', 'next weekend', ...NEXT_WEEKEND_WORDS,
      'this week', 'next week', 'next 7 days', '7 days', '7-day', 'seven days', ...WEEKDAY_WORDS,
    ],
  },
  { time: 'day_after_tomorrow', words: ['後天', '後日', 'day after tomorrow'] },
  { time: 'tomorrow', words: ['明天', '明日', '明早', '明晚', 'tomorrow'] },
  {
    time: 'today',
    words: ['今天', '今日', '今晚', '今早', '今夜', '今晨', '現在', '目前', '此刻', 'tonight', 'today', 'right now', 'now'],
  },
]);
const TIME_PRIORITY = TIME_GROUPS.map((group) => group.time);

// Days this reading cannot answer: the forecast starts today, and covers about a week. A question
// that names one of them (and no other day) is told so, and is never answered with today.
const UNSUPPORTED_TIME_GROUPS = Object.freeze([
  {
    unsupported: 'past',
    words: [
      '昨天', '昨日', '昨晚', '昨夜', '昨早', '前天', '大前天', '前幾天', '前陣子', '上週末', '上周末',
      '上個週末', '上個周末', '上週', '上周', '上個禮拜', '上禮拜', '上個星期', '上星期', '上個月', '上月', '去年', '前年',
      'yesterday', 'last night', 'last week', 'last weekend', 'last month', 'last year', 'day before yesterday',
    ],
  },
  {
    unsupported: 'far',
    words: [
      '下個月', '下月', '這個月', '本月', '下下週', '下下周', '下下個禮拜', '下下個星期', '下下星期', '明年', '下個季度', '下半年',
      'next month', 'next year',
    ],
  },
]);

// Words that hold a time word by accident ("清明天氣" holds 明天, "目前天氣" holds 前天, "然後天氣"
// holds 後天, "如今天氣" holds 今天). They are read first, and name no time.
const NEUTRAL_TIME_COMPOUNDS = Object.freeze([
  '清明天', '清明日', '聰明天', '文明天', '光明天', '黎明天', '透明天', '鮮明天', '簡明天', '精明天', '賢明天',
  '英明天', '失明天', '嚴明天', '神明天',
  '至今天', '如今天', '現今天', '迄今天', '當今天', '古今天', '而今天',
  '之後天', '然後天', '以後天', '最後天', '隨後天', '爾後天', '此後天', '日後天', '往後天', '其後天', '事後天',
  '午後天', '落後天',
  '目前天', '以前天', '之前天', '從前天', '事前天', '當前天', '眼前天', '提前天', '午前天', '賽前天', '戰前天',
  '空前天', '門前天', '生前天', '向前天', '面前天',
  '以前年', '之前年', '當前年', '目前年', '從前年',
  // 下月台北 is next month in Taipei, and 月台 is left alone for that reason.
  '上月球', '上月亮', '下月球', '下月亮',
]);

// Every time phrase and what it means: { time }, { unsupported } or {} for a compound that names
// none. Case-insensitive because the strict reading of a slash command's city sees the text as typed.
const TIME_PHRASES = new Map();
for (const { time, words } of TIME_GROUPS) for (const word of words) TIME_PHRASES.set(word, { time });
for (const { unsupported, words } of UNSUPPORTED_TIME_GROUPS) {
  for (const word of words) TIME_PHRASES.set(word, { unsupported });
}
for (const word of NEUTRAL_TIME_COMPOUNDS) TIME_PHRASES.set(word, {});
const TIME_PATTERN = new RegExp(phraseAlternation([...TIME_PHRASES.keys()]), 'giu');

// 後天 and 前天 in front of 氣 are mostly 天氣 with a word before it: "颱風過後天氣" is the weather
// after the typhoon, and "節前天氣" the weather before the holiday. They are no day then. At the
// start of a sentence, after a space or a mark, after a word that asks or looks ("請問後天氣如何"),
// after a place name ("台北後天氣如何"), and before 溫 象 候 壓 ("後天氣溫"), they are the day.
const ACCIDENTAL_DAY_PATTERN = /[後前]天氣(?![溫象候壓])/gu;
const DAY_CARRIER_PATTERN = /[問查看想道說講訴我你妳您他她的是在到於去來和跟與從幫]$/u;
function blankAccidentalDays(text) {
  return text.replace(ACCIDENTAL_DAY_PATTERN, (match, offset) => {
    const before = text.slice(Math.max(0, offset - 5), offset);
    if (!before || /[\s\p{P}\p{S}]$/u.test(before) || DAY_CARRIER_PATTERN.test(before)) return match;
    // A place name before it ("台北後天氣如何"): the member left a 天 out, and means the day.
    for (let length = Math.min(5, before.length); length >= 2; length -= 1) {
      if (placeNameEndings().has(normalizeTaiwanName(before.slice(-length)))) return match;
    }
    return ' ';
  });
}

// A day counted from today: "三天前" and "2 days ago" are gone, "三天後" is within the week the
// forecast covers (up to six days), and "十天後", "兩週後", "一個月後" are beyond it.
// A count is at most four characters and starts where a run of count characters starts, so a
// long run of them is not tried from every position (that would be quadratic).
const COUNT_CHARACTERS = '0-9一二兩三四五六七八九十幾半';
const COUNT = `(?<![${COUNT_CHARACTERS}])[${COUNT_CHARACTERS}]{1,4}`;
const AGO_PATTERN = new RegExp(
  `${COUNT}(?:個)?(?:天|日|晚|週|周|星期|禮拜|月|年)前`
  + '|(?<![a-z0-9])(?:\\d+|an?|one|two|three|four|five|six|seven|a few|several) (?:days?|weeks?|months?|years?) ago(?![a-z0-9])',
  'giu',
);
const IN_DAYS_PATTERN = new RegExp(
  `(${COUNT})(?:個)?(天|日|週|周|星期|禮拜|月|年)後`
  + '|(?<![a-z0-9])in (\\d+|an?|one|two|three|four|five|six|seven|a few) (days?|weeks?|months?|years?)(?![a-z0-9])',
  'giu',
);
const SPELLED_COUNTS = new Map([
  ['一', 1], ['二', 2], ['兩', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
  ['十', 10], ['幾', 3], ['半', 1], ['a', 1], ['an', 1], ['one', 1], ['two', 2], ['three', 3], ['four', 4],
  ['five', 5], ['six', 6], ['seven', 7], ['a few', 3],
]);
// The time of one match of IN_DAYS_PATTERN: 'week' when it is up to six days away, 'far' otherwise.
function readCountedDays(match) {
  const count = match[1] || match[3];
  const unit = (match[2] || match[4]).toLowerCase();
  const number = /^[0-9]+$/u.test(count) ? Number(count) : SPELLED_COUNTS.get(count.toLowerCase()) ?? 99;
  return /^(?:天|日|days?)$/u.test(unit) && number <= 6 ? 'week' : 'far';
}

// A word that is a weather question by itself. (A simplified 天气 / 气温 is read as these.) 預報 is
// not one: it is the forecast of anything (股市預報, 地震預報); 天氣預報 holds 天氣.
const STRONG_INTENT_WORDS = ['天氣', '氣象', '氣溫', '溫度', '降雨機率', '下雨機率', 'weather', 'forecast'];
const STRONG_INTENT_PATTERN = new RegExp(phraseAlternation(STRONG_INTENT_WORDS), 'u');

// Words that are a weather question only with a place in the sentence: 預報 ("台北明天預報"), and
// 冷嗎 / 熱嗎, which are as often asked about a person, a room or a cup of tea ("你今天冷嗎").
const PLACE_ONLY_WORD_PATTERN = /預報|[冷熱]嗎/u;

// A word about rain is a weather question when a place is beside it or a question is asked.
// 下雨天 (a rainy day), 雨傘節 (a snake), 有雨傘 (owning an umbrella) and 有帶傘 / 忘記帶傘 (did
// someone bring one) do not count.
const RAIN_WORD_SOURCES = [
  '下雨(?!天)', '降雨', '(?<!有)雨傘(?!節)', '(?<![有沒記忘])帶傘', '有雨(?![傘衣鞋具刷棚量帽披罩靴蓋簾])',
  '(?<![a-z0-9])(?:rain|rains|raining|rainy|umbrella|umbrellas)(?![a-z0-9])',
];
// A word about how hot or cold it is also turns up in chat about a person, a room, a cup of tea or
// an oven (幾度 is a degree of anything), so without a place it counts only with a question and
// a time word ("今天冷不冷", "明天會熱嗎"). 會冷場, 會熱鬧, 會熱舞 and the like are other words.
const TEMPERATURE_WORD_SOURCES = [
  '幾度', '多少度', '冷不冷', '熱不熱',
  '會(?:很|太|有點|超|特別|蠻|挺|更)?冷(?!場|靜|淡|落|漠|卻|血|門|笑話|處理|掉|飲|凍|藏|戰|眼|水|氣|宮|感|清|肅)',
  '會(?:很|太|有點|超|特別|蠻|挺|更)?熱(?!鬧|門|情|愛|心|烈|衷|忱|絡|銷|賣|播|血|狗|線|水|湯|量|身|敷|舞|帶|氣|飲|茶|食|可可|咖啡|牛奶)',
  '(?<![a-z])(?:how (?:hot|cold|warm|chilly)|(?:is|will|would|does) it(?: be| get| feel)? (?:very |so |too |really |gonna be |going to be )?(?:hot|cold|warm|chilly|freezing))(?![a-z])',
  '(?<![a-z0-9])temperature(?![a-z0-9])',
];
// A degree that belongs to a device, water, food or a body, or an angle, and no weather. 冷氣團 and
// 暖氣團 are weather.
const TEMPERATURE_OF_A_THING_PATTERN = new RegExp([
  '冷氣(?!團)', '暖氣(?!團)', '空調', '烤箱', '冰箱', '微波', '洗澡水', '熱水', '開水', '水溫', '油溫', '體溫', '發燒',
  '角度', '三角', '直角', '內角', '火鍋', '熱湯', '咖啡', '牛奶', '便當', '食物', '飲料', '泡麵', '披薩',
  '(?<![a-z])(?:oven|coffee|tea|soup|milk|fridge|freezer|engine|cpu|fever|pizza|bath|pool|boiling|water|food|drink)(?![a-z])',
].join('|'), 'u');
// Someone asked whether another person is cold or hot ("你今天會冷嗎", "他明天會熱嗎"): the pronoun
// is within three characters of the verb, so "你覺得明天會冷嗎" (the weather) is not this.
const PERSON_FEELS_PATTERN = /[你妳您他她牠它](?:們)?[^，,。.!！?？;；、\s嗎呢]{0,3}?(?:不?會(?:很|太|有點|超|特別|蠻|挺|更)?[冷熱]|[冷熱]不[冷熱])/u;
// Clauses end at a mark, a line break, or right after a 嗎 or 呢: "明天會冷嗎我要去咖啡店" is two.
const CLAUSE_BOUNDARY_PATTERN = /[，,。.!！?？;；、\n]+|(?<=[嗎呢])/u;
const RAIN_WORD_PATTERN = new RegExp(RAIN_WORD_SOURCES.join('|'), 'u');
const TEMPERATURE_WORD_PATTERN = new RegExp(TEMPERATURE_WORD_SOURCES.join('|'), 'u');
// Asking why it rains, or whether someone likes rain, is a chat and not a forecast question.
const NON_FORECAST_PATTERN = new RegExp([
  '為什麼', '為甚麼', '為何', '為啥', '怎麼會', '原理', '成因', '什麼是', '喜歡', '討厭', '喜不喜歡', '害怕', '怕不怕',
  '(?<![a-z])(?:why|how does|what causes|do you like|i like|i love|i hate)(?![a-z])',
].join('|'), 'u');
// A question tone. Some words ask by their form (冷不冷, 熱不熱, 幾度, 多少度, "is it hot",
// "what's the temperature"); they are told apart from a plain statement by this pattern too.
const QUESTION_PATTERN = /[嗎呢?]|會不會|要不要|有沒有|是不是/u;
const ASKING_FORM_PATTERN = /冷不冷|熱不熱|幾度|多少度|(?<![a-z])(?:how (?:hot|cold|warm|chilly)|(?:is|will|would|does) it(?: be| get| feel)? (?:very |so |too |really |gonna be |going to be )?(?:hot|cold|warm|chilly|freezing)|what(?:'s|s| is| was) the temperature)(?![a-z])/u;

// Words and particles around the place. They are blanked, never deleted, so two words that were
// apart do not end up next to each other. None of them occurs inside a Taiwan place name.
const NOISE_PHRASES = [
  '幫我查詢', '幫我查一下', '幫我查查', '幫我查', '幫我看一下', '幫我看看', '幫我看', '幫我問', '幫查', '幫忙',
  '請問一下', '請問', '請告訴我', '告訴我', '跟我說', '想要知道', '我想知道', '想知道', '我想問', '想問',
  '查詢天氣', '查天氣', '查詢', '查一下', '查查', '查看', '看一下', '看看', '問一下',
  '天氣預報', '天氣狀況', '天氣情況', '天氣如何', '天氣怎麼樣', '天氣怎樣', '天氣好不好', '天氣好嗎', '的天氣', '天氣',
  '氣象', '氣溫', '溫度', '降雨機率', '下雨機率', '降雨', '下雨天', '下雨', '雨傘', '帶傘', '預報', '預測', '狀況', '情況',
  'weather', 'forecast', 'rain', 'raining', 'umbrella', 'temperature',
  '會不會', '要不要', '有沒有', '好不好', '是不是', '能不能', '可不可以', '怎麼樣', '怎樣', '如何',
  '冷不冷', '熱不熱', '幾度', '多少度', '會冷', '會熱',
  '一下', '那邊', '這邊', '那裡', '這裡', '那一帶', '附近', '一帶', '地區', '當地', '最近', '近期', '這陣子',
  '外面', '外頭', '戶外', '出門',
  // Greetings, hedges and remarks that come with a question. What is left after these is what the
  // question is about, and a question with something left names a place this code does not know.
  '小吉', '你好', '哈囉', '早安', '午安', '晚安', '謝謝', '拜託', '麻煩', '可以', '需要', '需不需要', '應該',
  '可能', '大概', '是否', '感覺', '覺得', '好像', '一直', '等一下', '待會', '稍後', '晚點', '馬上',
  '好熱', '好冷', '好悶', '好濕', '好涼', '好暖', '很熱', '很冷', '太熱', '太冷', '超熱', '超冷', '真熱', '真冷',
  '悶熱', '炎熱', '寒冷', '潮濕', '涼爽', '溫暖', '暖和',
];
const NOISE_PATTERN = new RegExp(phraseAlternation(NOISE_PHRASES), 'giu');
const PARTICLE_PATTERN = /[的在去到於會要有是我你想看查問不還也就請給幫吧嗎呢啊喔哦啦嘛唷耶哇欸呀]/gu;
const SEPARATOR_PATTERN = /[\s\p{P}\p{S}]+/gu;
const DISCORD_MARKUP_PATTERN = /<(?:@[!&]?|#)\d+>|<a?:\w+:\d+>|https?:\/\/\S+|@everyone|@here/giu;

// Words of an English sentence that are not part of a place name.
const ENGLISH_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'will', 'would', 'shall', 'should', 'can',
  'could', 'may', 'might', 'must', 'do', 'does', 'did', 'it', 'its', "it's", 'there', "there's", 'here', 'this',
  'that', 'these', 'those', 'what', "what's", 'whats', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why',
  'how', "how's", 'hows', 'like', 'in', 'at', 'for', 'on', 'of', 'to', 'from', 'by', 'with', 'about', 'around',
  'near', 'over', 'into', 'out', 'up', 'down', 'and', 'or', 'but', 'if', 'so', 'then', 'than', 'not', 'no',
  'yes', 'i', "i'm", 'im', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'tell',
  'show', 'give', 'check', 'get', 'know', 'want', 'need', 'please', 'pls', 'plz', 'thanks', 'thank', 'hi',
  'hello', 'hey', 'yo', 'ok', 'okay', 'lol', 'btw', 'weather', 'forecast', 'forecasts', 'rain', 'raining',
  'rainy', 'rains', 'umbrella', 'temperature', 'temp', 'today', "today's", 'tomorrow', "tomorrow's", 'tonight',
  'now', 'right', 'current', 'currently', 'next', 'week', 'weekend', 'weekly', 'day', 'days', 'morning',
  'afternoon', 'evening', 'night', 'hot', 'cold', 'warm', 'cool', 'sunny', 'cloudy', 'windy', 'humid', 'going',
  'gonna', 'wanna', "let's", 'lets', 'any', 'some', 'much', 'many', 'very', 'really', 'just', 'too', 'also',
  'still', 'again', 'soon', 'later', 'outside', 'taiwan', 'tw', 'roc',
]);
// Words that name no place when they stand alone ("the weather in the city").
const ENGLISH_GENERIC_PLACE_WORDS = new Set([
  'area', 'city', 'town', 'village', 'place', 'location', 'region', 'district', 'county', 'country', 'world',
  'home', 'nearby', 'local', 'outdoors',
]);
// Where a place name that is not in the tables may stand: right after a weather word or "in",
// "at", "for" (or 在 於 到 去), or right before a weather word (a "的" or "那邊" may come between).
const INTENT_WORD_SOURCE = '(?:天氣|氣象|氣溫|溫度|降雨|下雨|雨傘|帶傘|幾度|(?<![a-z])(?:weather|forecast|rain|raining|umbrella|temperature)(?![a-z]))';
const PLACE_CUE_BEFORE_PATTERN = new RegExp(
  `(?:${INTENT_WORD_SOURCE}|(?<![a-z])(?:in|at|for|of|near|around|from)(?![a-z])|[在於到去])[\\s,，、:]*$`,
  'u',
);
const INTENT_AFTER_PATTERN = new RegExp(
  `^[\\s,，、:]*(?:的|那邊|這邊|那裡|這裡|附近|一帶|當地|地區)?[\\s,，、:]*${INTENT_WORD_SOURCE}`,
  'u',
);
// A medium-word question that names no place is read as a question only when no more than this many
// Chinese characters of its own are left (after the question, time and particle words).
const MAX_UNPLACED_QUESTION_TEXT = 8;
const MAX_ENGLISH_WORDS = 200;
const MAX_ENGLISH_NAME_LENGTH = 60;
const LATIN_WORD_PATTERN = /[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*/gu;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// ---------------------------------------------------------------------------
// Place lookup tables
// ---------------------------------------------------------------------------

// alias -> counties ("新竹" is both 新竹縣 and 新竹市).
const COUNTY_ALIAS_LOOKUP = new Map();
for (const { alias, county } of COUNTY_ALIASES) {
  if (!COUNTY_ALIAS_LOOKUP.has(alias)) COUNTY_ALIAS_LOOKUP.set(alias, []);
  const counties = COUNTY_ALIAS_LOOKUP.get(alias);
  if (!counties.includes(county)) counties.push(county);
}
const MAX_COUNTY_ALIAS_LENGTH = Math.max(...[...COUNTY_ALIAS_LOOKUP.keys()].map((alias) => alias.length));

// county -> alias -> district. A district is known by its full name and, when that ends in 區 鄉
// 鎮 市, by the name without it, as long as that keeps two characters ("東區" never becomes "東").
const COUNTY_DISTRICT_LOOKUP = new Map(COUNTY_NAMES.map((county) => {
  const table = new Map();
  for (const entry of COUNTY_TO_DISTRICTS.get(county)) {
    for (const alias of districtAliases(entry.district)) {
      if (alias.length >= 2 && !table.has(alias)) table.set(alias, entry);
    }
  }
  return [county, table];
}));
const MAX_DISTRICT_ALIAS_LENGTH = Math.max(
  ...TAIWAN_DISTRICTS.map((entry) => entry.district.length),
);
// Every district name of two or more characters, with and without its 區 鄉 鎮 市 -> every
// district that has it ("信義" is 臺北市, 基隆市 and 南投縣). A full name of three or more
// characters is also listed alone, for finding a district inside a longer sentence.
const DISTRICT_ALIAS_LOOKUP = new Map();
const DISTRICT_FULL_NAME_LOOKUP = new Map();
function addToLookup(lookup, key, entry) {
  if (!lookup.has(key)) lookup.set(key, []);
  lookup.get(key).push(entry);
}
for (const entry of TAIWAN_DISTRICTS) {
  for (const alias of districtAliases(entry.district)) {
    if (alias.length >= 2) addToLookup(DISTRICT_ALIAS_LOOKUP, alias, entry);
  }
  if (entry.district.length >= 3) addToLookup(DISTRICT_FULL_NAME_LOOKUP, entry.district, entry);
}

// Districts whose name without 區 鄉 鎮 市 is also an everyday word: 暖暖的天氣 is a warm day and
// 成功 is success. Written alone in a sentence they are not taken for the district; the name with
// its 區 鄉 鎮 市, or with its county, is.
const COMMON_WORD_DISTRICT_STEMS = new Set([
  '暖暖', '成功', '中山', '公館', '關西', '和平', '中正', '太平', '光復', '大同', '仁愛', '復興', '長治',
  '安定', '安樂', '新興', '三民', '山上', '大樹', '清水', '鹽水', '將軍', '桃源', '獅子', '牡丹', '琉球',
  '布袋', '六甲', '春日', '龍井', '西湖', '白沙',
]);

// The full name of every district of every county ("樹林區", "鳳山區", "東區"). A rest that is one
// of them, written under a county that has no such district, is a district named wrongly.
const DISTRICT_FULL_NAMES = new Set(TAIWAN_DISTRICTS.map((entry) => entry.district));

// Every name that a place can end a word with: the county names and stems, the district names
// with and without their 區 鄉 鎮 市, and the overseas names. Built on first use.
let knownPlaceNames = null;
function placeNameEndings() {
  if (!knownPlaceNames) {
    knownPlaceNames = new Set([
      ...COUNTY_ALIAS_LOOKUP.keys(), ...DISTRICT_ALIAS_LOOKUP.keys(), ...OVERSEAS_CHINESE_LOOKUP.keys(),
    ]);
  }
  return knownPlaceNames;
}

// Words that end in 區 or 市 but are not a district name: an area of a city, a park, a zone. Real
// district names end like them too (樹林區, 鳳山區, 桃園區), so a rest is looked up in
// DISTRICT_FULL_NAMES first.
const GENERIC_AREA_PATTERN = /^(?:近郊|市內|市中心)$|(?:園區|社區|校區|景區|林區|山區|港區|廠區|特區|災區|商區|住宅區|工業區|商業區|管制區|保護區|禁區|疫區|分區|地區|城區|市區|郊區)$/u;

// ---------------------------------------------------------------------------
// The strict reading of a place, used by slash commands and the weather service
// ---------------------------------------------------------------------------

function removeBotMentions(text) {
  return String(text || '').replace(/<@!?\d+>/g, ' ');
}

function cleanWeatherLocationText(text) {
  const cleaned = removeBotMentions(text).replace(TIME_PATTERN, ' ').replace(NOISE_PATTERN, ' ');
  return cleaned.replace(/[，。！？!?、,.：；;（）()「」『』【】\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function result(raw, cleaned, normalized, options = {}) {
  const county = options.county || null;
  const district = options.district || null;
  const location = options.location ?? (county ? county + (district || '') : normalized);
  return {
    raw, cleaned, normalized,
    city: county,
    district,
    location,
    apiLocation: options.invalid || options.ambiguous ? '' : location,
    ambiguous: options.ambiguous || null,
    invalid: options.invalid || null,
    candidates: options.candidates || [],
  };
}

function resolveCleanedLocation(raw, cleaned) {
  const normalized = normalizeTaiwanName(cleaned);
  const compact = normalized.replace(/\s+/g, '');
  if (!compact) return result(raw, cleaned, compact, { location: '' });

  const countyMatches = COUNTY_ALIASES.filter(({ alias }) => compact.startsWith(alias));
  if (countyMatches.length) {
    // 同名縣市的短名必須要求補齊；帶行政區時則可用行政區消歧。
    const resolved = countyMatches.map(({ alias, county }) => {
      const rest = compact.slice(alias.length);
      return { county, rest, matches: findDistrictMatches(rest, COUNTY_TO_DISTRICTS.get(county)) };
    });
    const exactCounties = [...new Set(resolved.filter((item) => !item.rest).map((item) => item.county))];
    if (exactCounties.length > 1) {
      return result(raw, cleaned, compact, {
        ambiguous: compact,
        candidates: exactCounties,
      });
    }
    const match = resolved.find((item) => item.matches.length === 1) || resolved[0];
    if (!match.rest) return result(raw, cleaned, compact, { county: match.county });
    if (match.matches.length === 1) {
      return result(raw, cleaned, compact, { county: match.county, district: match.matches[0].district });
    }
    const districtOnly = findDistrictMatches(compact, TAIWAN_DISTRICTS);
    if (districtOnly.length === 1) {
      return result(raw, cleaned, compact, {
        county: districtOnly[0].county, district: districtOnly[0].district,
      });
    }
    return result(raw, cleaned, compact, {
      invalid: compact,
      candidates: [`${match.county}${COUNTY_TO_DISTRICTS.get(match.county)[0].district}`],
    });
  }

  const matches = findDistrictMatches(compact, TAIWAN_DISTRICTS);
  if (matches.length === 1) {
    return result(raw, cleaned, compact, { county: matches[0].county, district: matches[0].district });
  }
  if (matches.length > 1) {
    return result(raw, cleaned, compact, {
      ambiguous: compact,
      candidates: matches.map((entry) => entry.county + entry.district),
    });
  }
  // A foreign city may also end in 市. Only a recognized Taiwan county with
  // an invalid district is rejected above; other names keep the overseas path.
  return result(raw, cleaned, normalized);
}

function resolveWeatherLocation(input) {
  const raw = String(input || '');
  return resolveCleanedLocation(raw, cleanWeatherLocationText(raw));
}

// ---------------------------------------------------------------------------
// Finding the place in a sentence
// ---------------------------------------------------------------------------

// The text a sentence is read from: Discord markup and links gone, full-width forms and case
// folded, simplified characters written as traditional. A member's sentence is never used as a
// place unless a place was found in it.
function prepareSentence(text) {
  return toTraditional(String(text || '').normalize('NFKC').toLowerCase().replace(DISCORD_MARKUP_PATTERN, ' '))
    // 新北投 is the hot-spring district of 北投, not 新北市 followed by 投.
    .replace(/新北投(?![資票注])/gu, '北投');
}

// The time a sentence names: { time } for a day the forecast can answer (the first group of
// TIME_GROUPS that has a word in the sentence), { unsupported } for a past or far day when no
// answerable day is named too, and { time: null, unsupported: null } for none. Days counted from
// today ("三天前", "三天後") are read first, so the word inside them ("一週前") is not read again.
function readWeatherTime(sentence) {
  let best = TIME_PRIORITY.length;
  let unsupported = null;
  let rest = blankAccidentalDays(sentence);
  for (const match of rest.matchAll(IN_DAYS_PATTERN)) {
    if (readCountedDays(match) === 'week') best = Math.min(best, TIME_PRIORITY.indexOf('week'));
    else unsupported = unsupported || 'far';
  }
  rest = rest.replace(IN_DAYS_PATTERN, ' ');
  if (rest.search(AGO_PATTERN) >= 0) unsupported = unsupported || 'past';
  rest = rest.replace(AGO_PATTERN, ' ');
  for (const match of rest.matchAll(TIME_PATTERN)) {
    const meaning = TIME_PHRASES.get(match[0].toLowerCase());
    if (!meaning) continue;
    if (meaning.time) best = Math.min(best, TIME_PRIORITY.indexOf(meaning.time));
    else if (meaning.unsupported && !unsupported) unsupported = meaning.unsupported;
  }
  if (best < TIME_PRIORITY.length) return { time: TIME_PRIORITY[best], unsupported: null };
  return { time: null, unsupported };
}

// True when the sentence has a word that can be a weather question, whatever else it says.
function detectWeatherIntent(text) {
  const sentence = prepareSentence(text);
  return STRONG_INTENT_PATTERN.test(sentence)
    || RAIN_WORD_PATTERN.test(sentence)
    || TEMPERATURE_WORD_PATTERN.test(sentence)
    || PLACE_ONLY_WORD_PATTERN.test(sentence);
}

// True when every clause that has a word for heat or cold also has a device, a drink or a body in
// it ("今天冷氣要開幾度"), and none has the word alone ("明天會冷嗎，我要去咖啡店").
function degreeIsOfAThing(sentence) {
  let sawDegree = false;
  for (const clause of sentence.split(CLAUSE_BOUNDARY_PATTERN)) {
    if (!TEMPERATURE_WORD_PATTERN.test(clause)) continue;
    sawDegree = true;
    if (!TEMPERATURE_OF_A_THING_PATTERN.test(clause)) return false;
  }
  return sawDegree;
}

// The longest, and among equals the earliest, name from `lookup` inside `text`. A name is looked
// up at every position for every length, so the work is linear in the length of the text.
function findLongestName(text, lookup, maxLength, minLength = 2) {
  let best = null;
  for (let start = 0; start < text.length; start += 1) {
    for (let length = Math.min(maxLength, text.length - start); length >= minLength; length -= 1) {
      const name = text.slice(start, start + length);
      if (lookup.has(name)) {
        if (!best || length > best.length) best = { start, length, name };
        break;
      }
    }
  }
  return best;
}

function placeFromEntries(raw, label, entries) {
  if (entries.length === 1) {
    return result(raw, label, label, { county: entries[0].county, district: entries[0].district });
  }
  return result(raw, label, label, {
    ambiguous: label,
    candidates: entries.map((entry) => entry.county + entry.district),
  });
}

// A county or city named anywhere in the sentence, then its district: "高雄會下雨嗎" is 高雄市 and
// "台北大安區今天要帶傘嗎" is 臺北市大安區. Without a district only the county is used.
function findCountyPlace(raw, compact) {
  const hit = findLongestName(compact, COUNTY_ALIAS_LOOKUP, MAX_COUNTY_ALIAS_LENGTH);
  if (!hit) return null;
  const counties = COUNTY_ALIAS_LOOKUP.get(hit.name);
  // The county name itself must not be read again as a district ("臺東" of 臺東市).
  const rest = `${compact.slice(0, hit.start)} ${compact.slice(hit.start + hit.length)}`;
  const found = [];
  for (const county of counties) {
    const district = findLongestName(rest, COUNTY_DISTRICT_LOOKUP.get(county), MAX_DISTRICT_ALIAS_LENGTH);
    if (district) found.push(COUNTY_DISTRICT_LOOKUP.get(county).get(district.name));
  }
  if (found.length) return placeFromEntries(raw, hit.name, found);
  if (counties.length === 1) return result(raw, hit.name, hit.name, { county: counties[0] });
  return result(raw, hit.name, hit.name, { ambiguous: hit.name, candidates: counties });
}

// A district named without its county: a whole word of the sentence ("新莊明天會下雨嗎"), or a
// district written with its 區 鄉 鎮 市 of three or more characters anywhere in it. A short name
// inside a longer word ("太平洋") is never read as a district, and neither is one that is an
// everyday word on its own ("暖暖的天氣", "成功").
function findDistrictPlace(raw, tokens, compact) {
  for (const token of tokens) {
    const name = normalizeTaiwanName(token);
    if (COMMON_WORD_DISTRICT_STEMS.has(name)) continue;
    if (DISTRICT_ALIAS_LOOKUP.has(name)) return placeFromEntries(raw, name, DISTRICT_ALIAS_LOOKUP.get(name));
  }
  const hit = findLongestName(compact, DISTRICT_FULL_NAME_LOOKUP, MAX_DISTRICT_ALIAS_LENGTH, 3);
  if (hit) return placeFromEntries(raw, hit.name, DISTRICT_FULL_NAME_LOOKUP.get(hit.name));
  return null;
}

// "高雄" + a rest that is itself written like a district (ends in 區 鄉 鎮 市) is a district the
// member named wrongly; it is told so, and is not answered with the county.
function isDistrictAttempt(compact) {
  const entry = COUNTY_ALIASES.find(({ alias }) => compact.startsWith(alias));
  if (!entry) return false;
  const rest = compact.slice(entry.alias.length);
  if (rest.length < 2 || !/[區鄉鎮市]$/u.test(rest)) return false;
  // A real district of another county ("台北樹林區"): the county has no such district, and the
  // member is told so. Only what is no district at all (a park, a zone) falls back to the county.
  if (DISTRICT_FULL_NAMES.has(rest)) return true;
  return !GENERIC_AREA_PATTERN.test(rest);
}

function latinWords(text) {
  const words = [];
  for (const match of text.matchAll(LATIN_WORD_PATTERN)) {
    const word = match[0].replace(/^['’-]+|['’-]+$/g, '');
    if (word) words.push({ text: word, start: match.index, end: match.index + match[0].length });
    if (words.length >= MAX_ENGLISH_WORDS) break;
  }
  return words;
}

function titleCase(text) {
  return text.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// A place written in English. A known name (a Taiwan place or one of the overseas cities above)
// is taken wherever it stands. Any other name is only taken when it stands where a place stands
// (after "in", "at" or "for", or beside a weather word) and nothing else is left in the sentence,
// so "AI 可以查天氣嗎" does not look up a city called Ai.
function findEnglishPlace(raw, timeBlanked, hasChineseWords) {
  const words = latinWords(timeBlanked);
  if (!words.length) return null;
  const adjacent = (index) => /^\s+$/u.test(timeBlanked.slice(words[index - 1].end, words[index].start));

  let known = null;
  for (let start = 0; start < words.length; start += 1) {
    let joined = '';
    for (let count = 1; count <= 4 && start + count <= words.length; count += 1) {
      const index = start + count - 1;
      if (count > 1 && !adjacent(index)) break;
      joined = count === 1 ? words[start].text : `${joined} ${words[index].text}`;
      const taiwan = resolveTaiwanEnglishName(joined);
      const overseas = OVERSEAS_ENGLISH_LOOKUP.get(joined);
      if ((taiwan || overseas) && (!known || count > known.count)) {
        known = { count, joined, taiwan, overseas };
      }
    }
  }
  if (known) {
    if (known.taiwan) {
      const taiwan = resolveCleanedLocation(raw, known.taiwan);
      // The service still reads the English name, so a deployment without a CWA key keeps asking
      // OpenWeather for it the way it always did.
      return { resolved: { ...taiwan, apiLocation: titleCase(known.joined) }, known: true };
    }
    return { resolved: result(raw, known.overseas, known.overseas, { location: known.overseas }), known: true };
  }

  if (hasChineseWords) return null;
  // The first run of words that are neither function words nor separated by anything else.
  let first = -1;
  let last = -1;
  for (let index = 0; index < words.length; index += 1) {
    const functionWord = ENGLISH_FUNCTION_WORDS.has(words[index].text) || words[index].text.length < 2;
    if (first >= 0 && (functionWord || !adjacent(index))) break;
    if (!functionWord) {
      if (first < 0) first = index;
      last = index;
    }
  }
  if (first < 0) return null;
  const group = words.slice(first, last + 1).map((word) => word.text.replace(/['’]s$/u, ''));
  if (group.length > 3) return null;
  if (group.length === 1 && ENGLISH_GENERIC_PLACE_WORDS.has(group[0])) return null;
  const cueBefore = timeBlanked.slice(Math.max(0, words[first].start - 40), words[first].start);
  const intentAfter = timeBlanked.slice(words[last].end, words[last].end + 40);
  if (!PLACE_CUE_BEFORE_PATTERN.test(cueBefore) && !INTENT_AFTER_PATTERN.test(intentAfter)) return null;
  const candidate = titleCase(group.join(' '));
  // No city name is this long; the text is not a place.
  if (candidate.length > MAX_ENGLISH_NAME_LENGTH) return null;
  return { resolved: result(raw, candidate, candidate, { location: candidate }), known: false };
}

// A sentence taken apart: the text with the time words blanked, and the words that are left when
// the question words, particles and punctuation are blanked too.
function splitSentence(sentence) {
  const timeBlanked = blankAccidentalDays(sentence)
    .replace(IN_DAYS_PATTERN, ' ').replace(AGO_PATTERN, ' ').replace(TIME_PATTERN, ' ');
  const tokens = timeBlanked.replace(NOISE_PATTERN, ' ').replace(PARTICLE_PATTERN, ' ')
    .split(SEPARATOR_PATTERN).filter(Boolean);
  return {
    timeBlanked,
    tokens,
    cleaned: tokens.join(' '),
    // How much is left of the question as Chinese words of two or more characters, and how many
    // English words that are no function word: what the question is about, which may be a place
    // this code does not know.
    otherTextLength: tokens.reduce((sum, token) => {
      const length = CJK_PATTERN.test(token) ? [...token].length : 0;
      return length >= 2 ? sum + length : sum;
    }, 0),
    otherEnglishWords: tokens.filter((token) => (
      token.length >= 2 && /^[\p{Script=Latin}\p{M}'’-]+$/u.test(token)
      && !ENGLISH_FUNCTION_WORDS.has(token) && !ENGLISH_GENERIC_PLACE_WORDS.has(token)
    )).length,
  };
}

// The place a weather sentence is about, as { resolved, known }, or null when it names none.
// `known` is false for an English name that is only a guess.
function findWeatherPlace(sentence, raw, { timeBlanked, tokens, cleaned, otherTextLength }) {
  // 1. What is left of the sentence is a place by itself: the reading a slash command gives it.
  // An everyday word that is also a district's name ("暖暖") is not, unless written with its 區 鄉
  // 鎮 市 or its county.
  const whole = resolveCleanedLocation(raw, cleaned);
  const everydayWord = COMMON_WORD_DISTRICT_STEMS.has(normalizeTaiwanName(tokens.join('')));
  if (!everydayWord && (whole.city || whole.ambiguous)) return { resolved: whole, known: true };
  if (whole.invalid && isDistrictAttempt(normalizeTaiwanName(tokens.join('')))) {
    return { resolved: whole, known: true };
  }

  // 2. A county, then its district, anywhere in the sentence.
  const compact = normalizeTaiwanName(timeBlanked.replace(SEPARATOR_PATTERN, ''));
  const county = findCountyPlace(raw, compact);
  if (county) return { resolved: county, known: true };

  // 3. An overseas city written in Chinese. The sentence is read as it is here, so a name that
  // ends where a time word begins ("胡志明" and "天氣" side by side hold 明天) is still found; the
  // name is handed back so that the time is read without it.
  const overseas = findLongestName(
    normalizeTaiwanName(sentence.replace(SEPARATOR_PATTERN, '')),
    OVERSEAS_CHINESE_LOOKUP,
    MAX_OVERSEAS_NAME_LENGTH,
  );
  if (overseas) {
    const english = OVERSEAS_CHINESE_LOOKUP.get(overseas.name);
    return {
      resolved: result(raw, english, english, { location: english }), known: true, alias: overseas.name,
    };
  }

  // 4. A district named without its county.
  const district = findDistrictPlace(raw, tokens, compact);
  if (district) return { resolved: district, known: true };

  // 5. A place written in English.
  return findEnglishPlace(raw, timeBlanked, otherTextLength > 0);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function debugInfo(raw, resolved, source) {
  return {
    raw, cleaned: resolved.cleaned, normalized: resolved.normalized,
    isWeatherIntent: true, city: resolved.city, district: resolved.district,
    finalLocation: resolved.location, apiLocation: resolved.apiLocation, source,
  };
}

// Reads a member's sentence as a weather question, or returns null when it is not one.
//   - A strong word (天氣, weather, 氣溫, 預報 ...) is a question on its own; without a place the
//     caller asks for one, or uses the server's default city.
//   - A word about rain (下雨, 帶傘, rain ...) is a question with a place in the sentence or a
//     question tone (嗎, 呢, ?, 會不會 ...).
//   - A word about heat or cold (幾度, 冷不冷, 會熱, temperature ...) is a question with a place in the
//     sentence; without one it also needs a time word ("今天冷不冷"), since it is as often about
//     a person, a room or an oven.
//   - A guessed English place name is never taken under a medium word.
//   - The time is today unless the sentence says another (see TIME_GROUPS). A day the forecast
//     cannot answer (yesterday, last week, next month) is `unsupportedTime`, 'past' or 'far',
//     and a past day asked about in a plain statement is no question.
// The result keeps the shape the callers know: `location` is the canonical place ("臺北市大安區",
// "Tokyo") and is empty when the sentence names none.
function parseWeatherQuery(text) {
  const raw = String(text || '');
  const sentence = prepareSentence(raw);
  const strong = STRONG_INTENT_PATTERN.test(sentence);
  const rainWord = !strong && RAIN_WORD_PATTERN.test(sentence);
  const temperatureWord = !strong && TEMPERATURE_WORD_PATTERN.test(sentence);
  const placeOnlyWord = !strong && PLACE_ONLY_WORD_PATTERN.test(sentence);
  const medium = (rainWord || temperatureWord || placeOnlyWord) && !NON_FORECAST_PATTERN.test(sentence);
  if (!strong && !medium) return null;

  const parts = splitSentence(sentence);
  let place = findWeatherPlace(sentence, raw, parts);
  let guessedPlaceDropped = false;
  if (medium && place && !place.known) {
    place = null;
    guessedPlaceDropped = true;
  }
  const time = readWeatherTime(place && place.alias ? sentence.replace(place.alias, ' ') : sentence);
  const namesTime = time.time !== null || time.unsupported !== null;
  const questionTone = QUESTION_PATTERN.test(sentence);
  const askingForm = ASKING_FORM_PATTERN.test(sentence);

  if (medium) {
    // A plain statement about a day that is gone ("昨天台北下雨了") asks for nothing.
    if (time.unsupported === 'past' && !questionTone && !askingForm) return null;
    if (!(place && place.known)) {
      // Without a place: rain asks with a question; heat and cold ask with a question and a time
      // word, and not about a thing or a person; 冷嗎, 熱嗎 and 預報 need a place.
      let asked = false;
      if (rainWord) asked = questionTone || (namesTime && askingForm);
      else if (temperatureWord) {
        asked = namesTime && (questionTone || askingForm)
          && !degreeIsOfAThing(sentence) && !PERSON_FEELS_PATTERN.test(sentence);
      }
      if (!asked) return null;
      // A short question with no place asks for one. A long sentence that only has 下雨 and a 嗎 in
      // it is a story, and is left to the conversation.
      if (!place && parts.otherTextLength > MAX_UNPLACED_QUESTION_TEXT) return null;
    }
  }

  const resolved = place ? place.resolved : result(raw, '', '', { location: '' });
  return {
    time: time.time || 'today',
    unsupportedTime: time.unsupported,
    location: resolved.location, apiLocation: resolved.apiLocation,
    city: resolved.city, district: resolved.district,
    ambiguous: resolved.ambiguous, invalid: resolved.invalid,
    candidates: resolved.candidates, suggest: null,
    // No place was found but the question has words of its own (a Chinese word of two or more
    // characters, an English word that is no function word, or a guessed place name that was set
    // aside): it may name a place this code does not know, so it is no question about the
    // server's default city.
    hasOtherText: !place && (parts.otherTextLength > 0 || parts.otherEnglishWords > 0 || guessedPlaceDropped),
    debug: { ...debugInfo(raw, resolved, 'natural-language'), intent: strong ? 'strong' : 'medium' },
  };
}

// The place of a /weather city option: read strictly (a place, not a sentence), with the Chinese
// name of an overseas city turned into the English name the weather provider knows.
function normalizeWeatherCommandLocation(city) {
  let resolved = resolveWeatherLocation(city);
  if (!resolved.city && !resolved.ambiguous && !resolved.invalid) {
    const english = resolveOverseasCityName(resolved.normalized);
    if (english) resolved = result(resolved.raw, resolved.cleaned, resolved.normalized, { location: english });
  }
  return {
    input: city, location: resolved.location, apiLocation: resolved.apiLocation,
    city: resolved.city, district: resolved.district,
    ambiguous: resolved.ambiguous, invalid: resolved.invalid,
    candidates: resolved.candidates,
    debug: debugInfo(String(city || ''), resolved, 'slash-command'),
  };
}

module.exports = {
  cleanWeatherLocationText,
  detectWeatherIntent,
  normalizeTaiwanName,
  normalizeWeatherCommandLocation,
  OVERSEAS_CITIES,
  parseWeatherQuery,
  resolveOverseasCityName,
  resolveTaiwanEnglishName,
  resolveWeatherLocation,
  TAIWAN_DISTRICTS,
};
