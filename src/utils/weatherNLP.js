const { districts: TAIWAN_DISTRICTS } = require('./taiwanDistricts.json');

const TIME_WORDS = [
  { words: ['未來一週', '未來一周', '一週', '一周', '這週', '本週', '七天', '7天'], time: 'week' },
  { words: ['後天'], time: 'day_after_tomorrow' },
  { words: ['明天', '明日'], time: 'tomorrow' },
  { words: ['今天', '今日', '現在', '目前'], time: 'today' },
];
const WEATHER_INTENT_WORDS = ['天氣', '氣象', '氣溫', '溫度', '降雨', '下雨', 'weather'];
const REMOVABLE_PHRASES = [
  '查詢天氣', '查天氣', '幫我查詢', '幫我查', '幫查', '請問', '想知道',
  '告訴我', '的天氣', '天氣如何', '天氣怎麼樣', '天氣', '氣象',
  '氣溫', '溫度', '降雨', '下雨', 'weather',
];

const COUNTY_NAMES = [...new Set(TAIWAN_DISTRICTS.map((entry) => entry.county))];
const COUNTY_TO_DISTRICTS = new Map(COUNTY_NAMES.map((county) => [
  county, TAIWAN_DISTRICTS.filter((entry) => entry.county === county),
]));
const COUNTY_ALIASES = COUNTY_NAMES.flatMap((county) => {
  const stem = county.slice(0, -1);
  return [county, stem].map((alias) => ({ alias, county }));
}).sort((a, b) => b.alias.length - a.alias.length);
COUNTY_ALIASES.push({ alias: '北市', county: '臺北市' }, { alias: '竹縣', county: '新竹縣' });

function normalizeTaiwanName(value) {
  return String(value || '').normalize('NFC').replace(/台/g, '臺');
}

function removeBotMentions(text) {
  return String(text || '').replace(/<@!?\d+>/g, ' ');
}

function detectWeatherIntent(text) {
  const normalized = String(text || '').toLowerCase();
  return WEATHER_INTENT_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function detectWeatherTime(text) {
  for (const group of TIME_WORDS) {
    if (group.words.some((word) => text.includes(word))) return group.time;
  }
  return 'today';
}

function cleanWeatherLocationText(text) {
  let cleaned = removeBotMentions(text);
  for (const group of TIME_WORDS) {
    for (const word of group.words) cleaned = cleaned.replaceAll(word, ' ');
  }
  for (const phrase of [...REMOVABLE_PHRASES].sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.replace(new RegExp(phrase, 'gi'), ' ');
  }
  return cleaned.replace(/[，。！？!?、,.：；;（）()「」『』【】\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function districtAliases(district) {
  const aliases = [district];
  if (/[區鄉鎮市]$/.test(district)) aliases.push(district.slice(0, -1));
  return aliases;
}

function findDistrictMatches(input, entries) {
  return entries.filter((entry) => districtAliases(entry.district).includes(input));
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

function resolveWeatherLocation(input) {
  const raw = String(input || '');
  const cleaned = cleanWeatherLocationText(raw);
  const normalized = normalizeTaiwanName(cleaned);
  const compact = normalized.replace(/\s+/g, '');
  if (!compact) return result(raw, cleaned, compact, { location: '' });

  const countyMatches = COUNTY_ALIASES.filter(({ alias }) => compact.startsWith(alias));
  if (countyMatches.length) {
    // "新竹東區" can be disambiguated by its district; "新竹" keeps the former city default.
    const resolved = countyMatches.map(({ alias, county }) => {
      const rest = compact.slice(alias.length);
      return { county, rest, matches: findDistrictMatches(rest, COUNTY_TO_DISTRICTS.get(county)) };
    });
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

function debugInfo(raw, resolved, source) {
  return {
    raw, cleaned: resolved.cleaned, normalized: resolved.normalized,
    isWeatherIntent: true, city: resolved.city, district: resolved.district,
    finalLocation: resolved.location, apiLocation: resolved.apiLocation, source,
  };
}

function parseWeatherQuery(text) {
  const raw = String(text || '');
  const withoutMention = removeBotMentions(raw);
  if (!detectWeatherIntent(withoutMention)) return null;
  const time = detectWeatherTime(withoutMention);
  const resolved = resolveWeatherLocation(withoutMention);
  return {
    time, location: resolved.location, apiLocation: resolved.apiLocation,
    city: resolved.city, district: resolved.district,
    ambiguous: resolved.ambiguous, invalid: resolved.invalid,
    candidates: resolved.candidates, suggest: null,
    debug: debugInfo(raw, resolved, 'natural-language'),
  };
}

function normalizeWeatherCommandLocation(city) {
  const resolved = resolveWeatherLocation(city);
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
  parseWeatherQuery,
  resolveWeatherLocation,
  TAIWAN_DISTRICTS,
};
