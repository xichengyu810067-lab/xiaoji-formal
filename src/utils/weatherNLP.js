const TIME_WORDS = [
  { words: ['一週', '一周', '未來一週', '未來一周', '這週', '本週', '七天', '7天'], time: 'week' },
  { words: ['明天', '明日'], time: 'tomorrow' },
  { words: ['後天'], time: 'day_after_tomorrow' },
  { words: ['今天', '今日', '現在', '目前'], time: 'today' },
];

const WEATHER_INTENT_WORDS = [
  '天氣',
  '氣象',
  '氣溫',
  '溫度',
  '降雨',
  '下雨',
  '會不會下雨',
  '會下雨嗎',
  'weather',
];

const REMOVABLE_PHRASES = [
  '查詢天氣',
  '查天氣',
  '幫我查詢',
  '幫我查',
  '幫查',
  '請問',
  '想知道',
  '告訴我',
  '的天氣',
  '天氣如何',
  '天氣怎麼樣',
  '天氣',
  '氣象',
  '氣溫',
  '溫度',
  '降雨',
  '下雨',
  'weather',
];

const CITY_DEFINITIONS = [
  {
    city: '臺北市',
    aliases: ['臺北市', '台北市', '臺北', '台北', '北市'],
    apiCity: 'Taipei',
    districts: {
      大同區: ['大同區', '大同'],
      中正區: ['中正區', '中正'],
      中山區: ['中山區', '中山'],
      松山區: ['松山區', '松山'],
      大安區: ['大安區', '大安'],
      萬華區: ['萬華區', '萬華'],
      信義區: ['信義區', '信義'],
      士林區: ['士林區', '士林'],
      北投區: ['北投區', '北投'],
      內湖區: ['內湖區', '內湖'],
      南港區: ['南港區', '南港'],
      文山區: ['文山區', '文山'],
    },
  },
  {
    city: '新北市',
    aliases: ['新北市', '新北'],
    apiCity: 'New Taipei',
    districts: {
      新莊區: ['新莊區', '新莊'],
      板橋區: ['板橋區', '板橋'],
      三重區: ['三重區', '三重'],
      中和區: ['中和區', '中和'],
      永和區: ['永和區', '永和'],
      新店區: ['新店區', '新店'],
      土城區: ['土城區', '土城'],
      蘆洲區: ['蘆洲區', '蘆洲'],
      汐止區: ['汐止區', '汐止'],
      樹林區: ['樹林區', '樹林'],
      淡水區: ['淡水區', '淡水'],
      林口區: ['林口區', '林口'],
      五股區: ['五股區', '五股'],
      泰山區: ['泰山區', '泰山'],
      鶯歌區: ['鶯歌區', '鶯歌'],
      三峽區: ['三峽區', '三峽'],
      瑞芳區: ['瑞芳區', '瑞芳'],
    },
  },
  {
    city: '臺中市',
    aliases: ['臺中市', '台中市', '臺中', '台中'],
    apiCity: 'Taichung',
    districts: {
      西屯區: ['西屯區', '西屯'],
      北屯區: ['北屯區', '北屯'],
      南屯區: ['南屯區', '南屯'],
      中區: ['中區'],
      東區: ['東區', '東'],
      西區: ['西區', '西'],
      南區: ['南區', '南'],
      北區: ['北區', '北'],
      太平區: ['太平區', '太平'],
      大里區: ['大里區', '大里'],
      豐原區: ['豐原區', '豐原'],
      沙鹿區: ['沙鹿區', '沙鹿'],
      清水區: ['清水區', '清水'],
      大甲區: ['大甲區', '大甲'],
    },
  },
  {
    city: '臺南市',
    aliases: ['臺南市', '台南市', '臺南', '台南'],
    apiCity: 'Tainan',
    districts: {
      東區: ['東區', '東'],
      中西區: ['中西區', '中西'],
      南區: ['南區', '南'],
      北區: ['北區', '北'],
      安平區: ['安平區', '安平'],
      安南區: ['安南區', '安南'],
      永康區: ['永康區', '永康'],
      新營區: ['新營區', '新營'],
      善化區: ['善化區', '善化'],
      仁德區: ['仁德區', '仁德'],
    },
  },
  {
    city: '臺東縣',
    aliases: ['臺東縣', '台東縣', '臺東', '台東'],
    apiCity: 'Taitung',
    districts: {
      臺東市: ['臺東市', '台東市', '臺東', '台東'],
    },
  },
  {
    city: '高雄市',
    aliases: ['高雄市', '高雄'],
    apiCity: 'Kaohsiung',
    districts: {
      苓雅區: ['苓雅區', '苓雅'],
      前鎮區: ['前鎮區', '前鎮'],
      左營區: ['左營區', '左營'],
      三民區: ['三民區', '三民'],
      鼓山區: ['鼓山區', '鼓山'],
      新興區: ['新興區', '新興'],
      前金區: ['前金區', '前金'],
      鹽埕區: ['鹽埕區', '鹽埕'],
      楠梓區: ['楠梓區', '楠梓'],
      小港區: ['小港區', '小港'],
      鳳山區: ['鳳山區', '鳳山'],
    },
  },
  {
    city: '新竹市',
    aliases: ['新竹市', '新竹'],
    apiCity: 'Hsinchu',
    districts: {
      東區: ['東區', '東'],
      北區: ['北區', '北'],
      香山區: ['香山區', '香山'],
    },
  },
  {
    city: '新竹縣',
    aliases: ['新竹縣', '竹縣', '新竹'],
    apiCity: 'Hsinchu County',
    districts: {
      竹北市: ['竹北市', '竹北'],
      竹東鎮: ['竹東鎮', '竹東'],
      湖口鄉: ['湖口鄉', '湖口'],
      新豐鄉: ['新豐鄉', '新豐'],
      新埔鎮: ['新埔鎮', '新埔'],
      關西鎮: ['關西鎮', '關西'],
    },
  },
  {
    city: '桃園市',
    aliases: ['桃園市', '桃園'],
    apiCity: 'Taoyuan',
    districts: {
      中壢區: ['中壢區', '中壢'],
      桃園區: ['桃園區', '桃園'],
      平鎮區: ['平鎮區', '平鎮'],
      八德區: ['八德區', '八德'],
      楊梅區: ['楊梅區', '楊梅'],
      蘆竹區: ['蘆竹區', '蘆竹'],
      龜山區: ['龜山區', '龜山'],
      龍潭區: ['龍潭區', '龍潭'],
      大溪區: ['大溪區', '大溪'],
    },
  },
  {
    city: '嘉義市',
    aliases: ['嘉義市', '嘉義'],
    apiCity: 'Chiayi',
    districts: {
      東區: ['東區', '東'],
      西區: ['西區', '西'],
    },
  },
];

const DISTRICT_API_NAMES = {
  '臺北市:大同區': 'Datong District, Taipei, TW',
  '新北市:新莊區': 'Xinzhuang District, New Taipei, TW',
  '臺南市:東區': 'East District, Tainan, TW',
  '臺中市:西屯區': 'Xitun District, Taichung, TW',
  '新竹縣:竹北市': 'Zhubei, TW',
  '桃園市:中壢區': 'Zhongli District, Taoyuan, TW',
};

const AMBIGUOUS_DISTRICT_ONLY_NAMES = new Set(['東區', '北區', '中正區', '大同區']);

const CITY_ALIAS_TO_CITY = new Map();
const CITY_ALIAS_ENTRIES = [];
for (const cityDef of CITY_DEFINITIONS) {
  for (const alias of cityDef.aliases) {
    const normalizedAlias = normalizeTaiwanName(alias);
    CITY_ALIAS_TO_CITY.set(normalizedAlias, cityDef);
    CITY_ALIAS_ENTRIES.push({ alias: normalizedAlias, cityDef });
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTaiwanName(text) {
  return String(text || '')
    .replace(/台北/g, '臺北')
    .replace(/台中/g, '臺中')
    .replace(/台南/g, '臺南')
    .replace(/台東/g, '臺東');
}

function detectWeatherIntent(text) {
  const normalized = normalizeTaiwanName(text).toLowerCase();
  return WEATHER_INTENT_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function detectWeatherTime(text) {
  for (const group of TIME_WORDS) {
    if (group.words.some((word) => text.includes(word))) {
      return group.time;
    }
  }

  return 'today';
}

function removeBotMentions(text) {
  return String(text || '').replace(/<@!?\d+>/g, ' ');
}

function cleanWeatherLocationText(text) {
  let cleaned = removeBotMentions(text);

  for (const group of TIME_WORDS) {
    for (const word of group.words) {
      cleaned = cleaned.replace(new RegExp(escapeRegExp(word), 'g'), ' ');
    }
  }

  const phrases = [...REMOVABLE_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' ');
  }

  return cleaned
    .replace(/[，。！？!?、,.。:：；;（）()「」『』【】\[\]<>]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function findCity(normalizedLocation) {
  const entries = [...CITY_ALIAS_ENTRIES].sort((a, b) => b.alias.length - a.alias.length);
  const matches = [];

  for (const { alias, cityDef } of entries) {
    if (normalizedLocation.startsWith(alias)) {
      matches.push({
        cityDef,
        alias,
        rest: normalizedLocation.slice(alias.length),
      });
    }
  }

  if (matches.length <= 1) {
    return matches[0] || null;
  }

  return matches.find((match) => findDistrictInCity(match.cityDef, match.rest)) || matches[0];
}

function findDistrictInCity(cityDef, districtInput) {
  if (!cityDef || !districtInput) {
    return null;
  }

  const normalizedDistrict = normalizeTaiwanName(districtInput);

  for (const [district, aliases] of Object.entries(cityDef.districts)) {
    if (district === normalizedDistrict || aliases.includes(normalizedDistrict)) {
      return district;
    }
  }

  const withSuffix = normalizedDistrict.endsWith('區') || normalizedDistrict.endsWith('市')
    ? normalizedDistrict
    : `${normalizedDistrict}區`;

  if (cityDef.districts[withSuffix]) {
    return withSuffix;
  }

  for (const [district, aliases] of Object.entries(cityDef.districts)) {
    if (district.includes(normalizedDistrict) || aliases.some((alias) => alias.includes(normalizedDistrict))) {
      return district;
    }
  }

  return null;
}

function findDistrictGlobally(location) {
  const matches = [];
  const normalizedLocation = normalizeTaiwanName(location);
  const withSuffix = normalizedLocation.endsWith('區') || normalizedLocation.endsWith('市')
    ? normalizedLocation
    : `${normalizedLocation}區`;

  for (const cityDef of CITY_DEFINITIONS) {
    const district = findDistrictInCity(cityDef, normalizedLocation) || findDistrictInCity(cityDef, withSuffix);
    if (district) {
      matches.push({ cityDef, district });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const key = `${match.cityDef.city}:${match.district}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(match);
    }
  }

  return unique;
}

function toApiLocation(city, district = null) {
  if (!district) {
    const cityDef = CITY_DEFINITIONS.find((entry) => entry.city === city);
    return cityDef?.apiCity ? `${cityDef.apiCity}, TW` : city;
  }

  const mapped = DISTRICT_API_NAMES[`${city}:${district}`];
  if (mapped) {
    return mapped;
  }

  const cityDef = CITY_DEFINITIONS.find((entry) => entry.city === city);
  return cityDef?.apiCity ? `${cityDef.apiCity}, TW` : `${city}${district}`;
}

function resolveWeatherLocation(input) {
  const raw = String(input || '');
  const cleaned = cleanWeatherLocationText(raw);
  const normalized = normalizeTaiwanName(cleaned);

  if (!normalized) {
    return {
      raw,
      cleaned,
      normalized,
      city: null,
      district: null,
      location: '',
      apiLocation: '',
      ambiguous: null,
      candidates: [],
    };
  }

  const cityMatch = findCity(normalized);
  if (cityMatch) {
    const district = findDistrictInCity(cityMatch.cityDef, cityMatch.rest);
    const location = district ? `${cityMatch.cityDef.city}${district}` : cityMatch.cityDef.city;

    return {
      raw,
      cleaned,
      normalized,
      city: cityMatch.cityDef.city,
      district,
      location,
      apiLocation: toApiLocation(cityMatch.cityDef.city, district),
      ambiguous: null,
      candidates: [],
    };
  }

  const districtMatches = findDistrictGlobally(normalized);
  const districtOnlyName = normalized.endsWith('區') ? normalized : `${normalized}區`;

  if (AMBIGUOUS_DISTRICT_ONLY_NAMES.has(districtOnlyName)) {
    const candidates = districtMatches.length > 1
      ? districtMatches.map((match) => `${match.cityDef.city}${match.district}`)
      : [
          ...districtMatches.map((match) => `${match.cityDef.city}${match.district}`),
          `請補上縣市再查${districtOnlyName}`,
        ];

    return {
      raw,
      cleaned,
      normalized,
      city: null,
      district: districtOnlyName,
      location: normalized,
      apiLocation: '',
      ambiguous: districtOnlyName,
      candidates,
    };
  }

  if (districtMatches.length === 1) {
    const match = districtMatches[0];
    return {
      raw,
      cleaned,
      normalized,
      city: match.cityDef.city,
      district: match.district,
      location: `${match.cityDef.city}${match.district}`,
      apiLocation: toApiLocation(match.cityDef.city, match.district),
      ambiguous: null,
      candidates: [],
    };
  }

  if (districtMatches.length > 1) {
    return {
      raw,
      cleaned,
      normalized,
      city: null,
      district: normalized.endsWith('區') ? normalized : `${normalized}區`,
      location: normalized,
      apiLocation: '',
      ambiguous: normalized,
      candidates: districtMatches.map((match) => `${match.cityDef.city}${match.district}`),
    };
  }

  return {
    raw,
    cleaned,
    normalized,
    city: null,
    district: null,
    location: normalized,
    apiLocation: normalized,
    ambiguous: null,
    candidates: [],
  };
}

function parseWeatherQuery(text) {
  const raw = String(text || '');
  const normalizedRaw = normalizeTaiwanName(removeBotMentions(raw));
  const isWeatherIntent = detectWeatherIntent(normalizedRaw);

  if (!isWeatherIntent) {
    return null;
  }

  const time = detectWeatherTime(normalizedRaw);
  const resolved = resolveWeatherLocation(normalizedRaw);

  return {
    time,
    location: resolved.location,
    apiLocation: resolved.apiLocation,
    city: resolved.city,
    district: resolved.district,
    ambiguous: resolved.ambiguous,
    candidates: resolved.candidates,
    suggest: null,
    debug: {
      raw,
      cleaned: resolved.cleaned,
      normalized: resolved.normalized,
      isWeatherIntent,
      city: resolved.city,
      district: resolved.district,
      finalLocation: resolved.location,
      apiLocation: resolved.apiLocation,
      source: 'natural-language',
    },
  };
}

function normalizeWeatherCommandLocation(city) {
  const resolved = resolveWeatherLocation(city);
  return {
    input: city,
    location: resolved.location,
    apiLocation: resolved.apiLocation || resolved.location,
    city: resolved.city,
    district: resolved.district,
    ambiguous: resolved.ambiguous,
    candidates: resolved.candidates,
    debug: {
      raw: String(city || ''),
      cleaned: resolved.cleaned,
      normalized: resolved.normalized,
      isWeatherIntent: true,
      city: resolved.city,
      district: resolved.district,
      finalLocation: resolved.location,
      apiLocation: resolved.apiLocation || resolved.location,
      source: 'slash-command',
    },
  };
}

module.exports = {
  cleanWeatherLocationText,
  detectWeatherIntent,
  normalizeTaiwanName,
  normalizeWeatherCommandLocation,
  parseWeatherQuery,
  resolveWeatherLocation,
};
