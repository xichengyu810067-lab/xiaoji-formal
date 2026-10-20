'use strict';

// The one set of link rules for text the bot shows. These places use it:
//   - the chat output policy (src/systems/conversation/userFacingOutputPolicy.js), for AI replies;
//   - the egress guard (src/platform/egressGuard.js), for every text a request carries, and the sources
//     of protected text that are cleaned the same way before they reach it (the work reminder, the work
//     penalty notice and the Owner safety notice);
//   - the release notice (src/services/releaseAnnouncementService.js), for its release page URL.
//
// A link approval has one of two scopes:
//   'approved'  the fixed public pages and the one release the chat may name (approvedReleaseTag);
//   'stable'    the same, plus the release page of any stable release tag of the official repository.
// rewriteLinks then keeps approved links and replaces every other one with BLOCKED_LINK_REPLACEMENT.
// It only uses built-in JavaScript (and the URL parser that comes with it), so any layer may load it.

const { domainToASCII, domainToUnicode } = require('node:url');

const BLOCKED_LINK_REPLACEMENT = '[連結已移除]';
const OFFICIAL_RELEASE_REPOSITORY = 'xichengyu810067-lab/xiaoji-formal';
const RELEASE_HOST = 'github.com';
const OFFICIAL_REPOSITORY_PATH = `/${OFFICIAL_RELEASE_REPOSITORY}`;
const RELEASE_TAG_PATH_PREFIX = `${OFFICIAL_REPOSITORY_PATH}/releases/tag/`;
const RELEASE_TAG_SCOPES = new Set(['approved', 'stable']);
const MASKED_LINK_STYLES = new Set(['label', 'label-and-marker']);
// The longest text approve() reads: a longer one is refused. The approve functions that createLinkApproval
// makes are kept here with that limit, so that rewritePlainUrls does not build a text it knows they refuse.
const MAX_APPROVED_URL_LENGTH = 2_048;
const APPROVER_LENGTH_LIMITS = new WeakMap();

const DANGEROUS_ENCODED_SEPARATOR = /%(?:00|2e|2f|3f|40|5c)/i;
const MARKDOWN_LINK = /\[([^\]\r\n]{0,300})\]\(\s*(<?https?:\/\/[^\s)>]+>?)\s*(?:["'][^"']*["'])?\s*\)/giu;
const ANGLE_AUTOLINK = /<(https?:\/\/[^\s<>]+)>/giu;
// No word boundary before https: a URL pasted immediately after a letter is still a URL.
// Square brackets remain legal here so an IPv6 literal such as https://[::1]/ is inspected.
const PLAIN_URL = /https?:\/\/[A-Za-z0-9._~:%?#[\]@!$&'*+=,;\/\\\uFF0E-]+/giu;
const BARE_WWW = /\bwww\.[\p{L}\p{N}.-]+(?:\/[^\s<>{}\[\]"'()，。！？；：、（）]*)?/giu;
const URL_CANDIDATE = /https?:\/\/[^\s<>{}\[\]"']+/giu;
// A Discord invite or gift link written without a scheme, which Discord still turns into a card. The
// first alternative is the plain URL pattern above: a URL the earlier steps kept (so an approved one, in
// its normalized ASCII form) is matched whole and left alone, and an approved https://discord.gg/ link is
// never cut in two. It stops where the plain URL stops, so text after a kept URL is still checked. It has no
// word boundary in front, as the plain URL has none: a kept URL that follows a letter (xhttps://discord.gg/...)
// is matched whole too, and its invite is not cut out of it (which would leave "xhttps://[連結已移除]", a
// text the plain URL step then reads as a URL again).
const BARE_INVITE_OR_URL = new RegExp(
  String.raw`(${PLAIN_URL.source})|discord(?:(?:app)?\.com\/invite|\.gg(?:\/invite)?|\.gift)\/[\w-]+`, 'giu');
// Discord keeps a link going up to the next whitespace or "<", while PLAIN_URL stops at the first
// character outside its ASCII set. What an approved URL is directly followed by therefore still belongs
// to the link Discord shows, unless it is one of these ordinary ends of a link in running text: Chinese
// and full-width punctuation, a closing ASCII parenthesis or quote, the backtick of inline code, the bar
// of a ||spoiler||, or the ">" of an <angle> link.
const LINK_RUN_END = /[\s<]/u;
const LINK_SOFT_END = /[，。、；：！？（）［］｛｝「」『』【】《》〈〉〔〕〖〗“”‘’…—～〜·・＂＇)"`|]/u;
// Zero-width characters neither end a link nor count as its text; they are removed before judging.
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/gu;
// A separator followed by a dot (or its encoding) can climb out of the approved path.
const PATH_DOT_SEGMENT = /[\/\\](?:\.|%2e)/iu;
// An encoded "%": decoded once more, %252e is a dot and %252f a separator.
const ENCODED_PERCENT = /%25/iu;

// An address with a scheme whose first character is not ASCII (https://аpple.com/login, https://🎁.ws/nitro,
// https://ⓔⓥⓘⓛ.com/claim, https://★領獎.台灣/x): PLAIN_URL reads ASCII characters only, so the plain URL step
// leaves it (see rewriteSchemeAddresses). Whether such a run is an address is decided by the parser a browser
// opens it with (see runIsHost), not by reading its dots here: a browser maps an ideographic full stop, a
// full-width, circled or squared letter, a hexadecimal or decimal number written in any digits to the host it
// opens, and drops invisible characters.
const SCHEME_PREFIX = /https?:\/\//giu;
const SCHEME_AT_END = /https?:\/\/$/iu;
const SCHEME_RUN_END = new RegExp(String.raw`[\s<>{}\[\]'(]|${LINK_SOFT_END.source}`, 'u');
// White space except U+FEFF, which is an invisible character of a name (see INVISIBLE) as well.
const NON_BOM_SPACE = /^[^\S\u{feff}]$/u;
// What ends the host of an address: white space, "<", and the start of the path, the query or the fragment
// (a backslash is read as a slash).
const HOST_END = /[\s<\/\\?#]/u;
const PATH_START = new Set(['/', '\\', '?', '#']);
// The dots of a host as a browser reads them. The ideographic full stop is the full stop of Chinese text as
// well, and the run is not cut at it: https://開頭。這是常識 is a host of two labels for the parser, and a
// sentence for nobody who cannot tell it from https://領獎。台灣 (a limit, pinned in the tests).
const HOST_DOTS = new Set(['.', '\u{ff0e}', '\u{ff61}', '\u{3002}']);
// The punctuation of Chinese text that ends a host in running text (網址要以https://開頭，版本v1.1.2以後都
// 支援; https://後接「discord.gg」是邀請) when at least one character of the host stands in front of it and
// the dots behind it are not a host of their own (see readSchemeAddress). The parser refuses some of them in
// a host, so that a link holding one is none for a browser: there the run is cut at any rate.
const CLAUSE_PUNCTUATION = new Set([...'，、；：！？「」『』（）《》“”‘’…']);
const REFUSED_IN_A_HOST = new Set([...'：？…']);
// The closing mark that goes with an opening one at the start of a run: 「evil」.com is a host.
const CLOSING_PARTNER = new Map([['「', '」'], ['『', '』'], ['（', '）'], ['【', '】'], ['《', '》'], ['〈', '〉'],
  ['〔', '〕'], ['〖', '〗'], ['“', '”'], ['‘', '’'], ['［', '］'], ['｛', '｝']]);
// Punctuation behind a host that is no part of it: what Discord leaves out of a link at its end, the closing
// characters of Markdown, and the ordinary ends of a link in running text.
const TRAILING_PUNCTUATION = new Set([...'.,:;!?\'")]}>*_~|`\u{ff0e}\u{ff61}', ...'，。、；：！？（）［］｛｝「」『』【】《》〈〉〔〕〖〗“”‘’…—～〜·・＂＇']);
// A host that holds more than this many characters, invisible ones aside, is none a name server resolves (the
// user in front of it may be of any length). The parser takes time in step with a host made of many kinds of
// characters, which would add up in a text of many such hosts: it is not asked about one.
const MAX_HOST_LENGTH = 512;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
// A "%" that the parser cannot decode stays in the host, which it refuses.
const UNDECODABLE_PERCENT = /%(?![0-9a-f]{2})/iu;
const DOT_OR_ENCODED_DOT = /[.\u{ff0e}\u{ff61}\u{3002}]|%2e/iu;
const NEEDS_THE_PARSER = /[:%[]/u;
// What a host written as a single number looks like once look-alike digits are mapped: decimal, octal or
// hexadecimal, as the parser reads an address. An IPv6 address begins with a bracket.
const NUMBER_HOST = /^(?:0x[0-9a-f]*|[0-9]+)$/iu;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
// What the last label of a host written in ASCII is made of: letters, digits and hyphens. A label of another
// script is an ending only when it is the name of a top-level domain (IDN_TOP_LEVEL_DOMAINS), or is written as
// "xn--" in the text: any word of Chinese would otherwise end a host, and a paragraph with a few full stops
// in it, which a browser reads as dots, would be one address.
const ASCII_ENDING = /^[a-z0-9-]+$/u;
const WRITTEN_PUNYCODE = /^xn--[a-z0-9-]+$/u;
// The top-level domains written in other scripts (the ones of countries, of brands and of generic names, which
// are the ones a link could be at), the traditional spellings of some Chinese ones, and the test names
// reserved for them. It was written from the root zone as it is known, not from the file of IANA (which this
// code cannot read at run time): when a domain is added there, add it here. The parser gives these names as
// "xn--" labels, so the set holds those. A name that is missing is no ending, and the run it ends is text.
const IDN_TOP_LEVEL_DOMAINS = Object.freeze([
  // Chinese: countries, then names
  '中国', '中國', '台湾', '台灣', '香港', '澳门', '澳門', '新加坡',
  '公司', '公益', '八卦', '网站', '網站', '网络', '網絡', '网址', '网店', '在线', '在線', '中文网', '中文網', '集团', '集團',
  '商店', '商城', '商标', '微博', '慈善', '我爱你', '手机', '招聘', '政务', '政府', '新闻', '时尚', '机构', '组织机构',
  '游戏', '娱乐', '购物', '餐厅', '食品', '信息', '企业', '健康', '世界', '珠宝', '点看', '移动', '联通', '谷歌',
  '亚马逊', '飞利浦', '淡马锡', '嘉里', '嘉里大酒店', '大拿', '天主教', '广东', '佛山', '香格里拉', '大众汽车', '電訊盈科',
  '中信', '工行', '家電', '書籍', '通販',
  // Japanese and Korean
  'みんな', 'コム', 'ストア', 'ポイント', 'クラウド', 'セール', 'ファッション', 'アマゾン', 'グーグル',
  '한국', '닷컴', '닷넷', '삼성',
  // Cyrillic, Greek, Georgian, Armenian, Hebrew
  'рф', 'онлайн', 'сайт', 'москва', 'орг', 'дети', 'ком', 'католик', 'бг', 'срб', 'укр', 'қаз', 'мкд', 'мон', 'ею', 'бел',
  'рус', 'ελ', 'ευ', 'გე', 'հայ', 'ישראל', 'קום',
  // Arabic and Persian
  'ایران', 'العربية', 'السعودية', 'امارات', 'مصر', 'الاردن', 'قطر', 'بازار', 'شبكة', 'موقع', 'كوم', 'ثلاثية', 'المغرب',
  'البحرين', 'الجزائر', 'عمان', 'عراق', 'سودان', 'سورية', 'فلسطين', 'تونس', 'موريتانيا', 'مليسيا', 'اليمن', 'ليبيا', 'عرب',
  'همراه', 'اتصالات', 'ارامكو', 'ابوظبي', 'كاثوليك', 'العليان', 'بيتك', 'موبايلي', 'پاکستان', 'بارت', 'بھارت', 'ڀارت',
  // Thai, Lao, and the scripts of South Asia
  'ไทย', 'คอม', 'ລາວ', 'भारत', 'भारतम्', 'भारोत', 'ভারত', 'ভাৰত', 'বাংলা', 'ભારત', 'ਭਾਰਤ', 'ಭಾರತ', 'ଭାରତ', 'ഭാരതം', 'భారత్',
  'संगठन', 'कॉम', 'नेट', 'இந்தியா', 'இலங்கை', 'சிங்கப்பூர்', 'ලංකා',
  // Latin letters with a mark
  'vermögensberater', 'vermögensberatung',
  // the names reserved for tests
  '測試', '测试', 'テスト', '테스트', 'परीक्षा', 'испытание', 'טעסט', 'آزمایشی', 'δοκιμή', 'إختبار', 'பரிட்சை',
]);
const IDN_ENDINGS = new Set(IDN_TOP_LEVEL_DOMAINS.map((name) => domainToASCII(name)));
// URL.parse gives null where new URL throws, which costs a stack trace for each text a parser refuses.
const parseUrl = typeof URL.parse === 'function'
  ? (value) => URL.parse(value)
  : (value) => {
    try { return new URL(value); } catch { return null; }
  };

// Domains written without a scheme (the bareDomains option of rewriteLinks).
//
// Discord may show a name such as free-nitro.com/claim as a link even without "https://". A name is taken
// for a link when it has at least one dot and its last label is one of these top-level domains, in any
// letter case. The list is the endings scam links use, not every TLD, and it leaves out the ones that are
// also file extensions (md, py, sh, rs, so, pl, ps, js, ts, cs) so that README.md or main.py stay text. A
// file name that ends like one that is listed (requirements.in, model.pt, book.mobi, logo.ai) is a name
// like any other.
const BARE_DOMAIN_TLDS = Object.freeze([
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'top', 'site', 'online', 'live', 'click', 'link', 'shop',
  'store', 'club', 'vip', 'life', 'world', 'today', 'tech', 'app', 'dev', 'page', 'cloud', 'fun', 'space',
  'website', 'work', 'rest', 'support', 'help', 'pro', 'name', 'mobi', 'asia', 'icu', 'buzz', 'monster',
  'quest', 'one', 'sbs', 'cyou', 'cfd', 'gift', 'zip', 'mov', 'bond', 'uno', 'wang', 'win', 'bid', 'loan',
  'men', 'date', 'download', 'stream', 'racing', 'review', 'party', 'trade', 'cricket', 'science',
  'accountant', 'faith',
  // country codes
  'io', 'gg', 'me', 'ly', 'to', 'co', 'cc', 'tv', 'ws', 'pw', 'tk', 'ml', 'ga', 'cf', 'gq', 'in', 'us', 'uk',
  'de', 'fr', 'it', 'es', 'nl', 'be', 'se', 'no', 'dk', 'fi', 'cz', 'ru', 'ua', 'cn', 'hk', 'tw', 'jp', 'kr',
  'sg', 'my', 'th', 'vn', 'id', 'ph', 'au', 'nz', 'ca', 'br', 'mx', 'ar', 'cl', 'za', 'ae', 'sa', 'il', 'tr',
  'ir', 'pk', 'bd', 'ng', 'ke', 'eg', 'ch', 'at', 'ie', 'pt', 'gr', 'hu', 'ro', 'bg', 'by', 'kz', 'lt', 'lv',
  'ee', 'is', 'ai', 'fm', 'am', 'la', 'st', 'vc', 'ac', 'im', 'gl', 'cx',
]);
const BARE_DOMAIN_TLD_SET = new Set(BARE_DOMAIN_TLDS);
// Endings that are also ordinary words, names or code: short English words (ok.me, yes.no, again.it),
// property and file names (user.name, config.app, std.io, main.cc, archive.zip) and surnames (Mr.Wang,
// Dr.Hu). A plain "word.ending" is text, so these count only with a port, path, query or fragment, or when
// a label before them holds a digit, a hyphen or an underscore, is a non-ASCII word or has 8 or more
// characters (see isNotPlainEnglishLabel): free-nitro.io/claim, nitro-gift.app and claimyourprize.dev are
// still names. Every one of them is in BARE_DOMAIN_TLDS as well.
const AMBIGUOUS_BARE_DOMAIN_TLDS = Object.freeze([
  'in', 'is', 'it', 'no', 'be', 'me', 'my', 'to', 'at', 'us', 'am', 'id', 'la', 'st',
  'name', 'app', 'dev', 'io', 'one', 'pro', 'zip', 'mov', 'cc', 'wang', 'hu',
]);
const AMBIGUOUS_TLD_SET = new Set(AMBIGUOUS_BARE_DOMAIN_TLDS);
const AMBIGUOUS_LABEL_LENGTH = 8;

// A label is a run of letters, digits and combining marks of any script (a homoglyph domain is one), with
// zero-width characters, which do not break a name, joined by hyphens or underscores. Hyphens and
// underscores at its ends are tolerated, and a label may be nothing else, so Markdown such as _evil.com_
// or a stray dash or underscore in front (_.evil.com) cannot hide a name. The pattern is linear: its parts
// match disjoint characters.
const INVISIBLE = String.raw`\u{ad}\u{200b}-\u{200d}\u{2060}\u{feff}`;
const DOMAIN_LETTERS = String.raw`\p{L}\p{N}\p{M}${INVISIBLE}`;
const DOMAIN_LABEL = String.raw`(?:[_-]*[${DOMAIN_LETTERS}]+(?:[_-]+[${DOMAIN_LETTERS}]+)*[_-]*|[_-]+)`;
// Chinese, Japanese and Korean text has no spaces: letters of these scripts in front of a name are text,
// not part of it (請看example.com), unless the whole first label is written in them (領獎中心.com).
const UNSPACED_SCRIPTS = String.raw`\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}`;
const UNSPACED_PREFIX = new RegExp(String.raw`^[${UNSPACED_SCRIPTS}]+`, 'u');
const UNSPACED_LETTER = new RegExp(String.raw`[${UNSPACED_SCRIPTS}]`, 'u');
const UNSPACED_ONLY_LABEL = new RegExp(String.raw`^[${UNSPACED_SCRIPTS}\p{N}\p{M}${INVISIBLE}_-]+$`, 'u');
const LEADING_JUNK = new RegExp(String.raw`^[_${INVISIBLE}-]+`, 'u');
const JUNK_ONLY = new RegExp(String.raw`^[_${INVISIBLE}-]*$`, 'u');
const INVISIBLE_CHAR = new RegExp(String.raw`^[${INVISIBLE}]$`, 'u');
const NOT_PLAIN_ENGLISH_LABEL = /[\p{N}_-]|[^ -~]/u;
// What may follow the name: a port, then a path, query or fragment of ASCII characters, up to whitespace, a
// bracket, a quote or a bar. A non-ASCII character ends it, so Chinese text after the address stays
// (加入discord.gg/abc123吧), as it does after a bare invite. It is read only after a name is taken for a
// link, so text after a dotted name that is none (1.2?evil.com) is still searched. The pattern has no "i"
// flag on purpose: under /iu a negated class with a non-ASCII range also leaves out "s" and "k" (they fold
// to U+017F and U+212A).
const ADDRESS_END = String.raw`\s<>{}\[\]"'()|\x60\u{80}-\u{10ffff}`;
const ADDRESS_TAIL = new RegExp(String.raw`(?::\d{1,5})?(?:[/?#][^${ADDRESS_END}]*)?`, 'uy');
// Punctuation that ends a sentence or closes Markdown stays outside the replaced text.
const ADDRESS_TRAILING_PUNCTUATION = new Set('.,;:!?*_~-');
// Two alternatives, tried at each position:
//   kept    a URL the earlier steps kept (an approved one, in its normalized ASCII form): matched whole and
//           left alone, so an approved https:// link is never cut in two. Like the plain URL it has no word
//           boundary in front: a URL after a letter is still a URL (xhttps://discord.gg/...);
//   host    a dotted name, from the beginning of its run of letters: a position inside a name (after a
//           letter, a digit, a hyphen, an underscore or a dot that joins labels) never starts one.
// The patterns only find names; rewriteBareDomains decides whether one is a link. BARE_DOMAIN_AT is the
// same without the rule about the position, for the text right after a name that was taken out (it starts
// a new word, though a letter precedes it).
const KEPT_URL = String.raw`(?<kept>${PLAIN_URL.source})`;
const DOTTED_HOST = String.raw`(?<host>${DOMAIN_LABEL}(?:\.${DOMAIN_LABEL})+)`;
const NAME_START = String.raw`(?<![${DOMAIN_LETTERS}_-]|[${DOMAIN_LETTERS}_-]\.)`;
const BARE_DOMAIN_OR_URL = new RegExp(`${KEPT_URL}|${NAME_START}${DOTTED_HOST}`, 'giu');
const BARE_DOMAIN_AT = new RegExp(`${KEPT_URL}|${DOTTED_HOST}`, 'iuy');

// The end of what is written after a name, without the punctuation that closes the sentence or Markdown.
function splitAddressEnd(tail) {
  let end = tail.length;
  while (end > 0 && ADDRESS_TRAILING_PUNCTUATION.has(tail[end - 1])) end -= 1;
  return { body: tail.slice(0, end), suffix: tail.slice(end) };
}

// The ASCII letter a character stands for in a name (a full-width letter is read as its ASCII form), or null.
function asciiLetter(char) {
  if (/^[A-Za-z]$/u.test(char)) return char;
  const code = char.codePointAt(0);
  const isFullWidth = (code >= 0xff21 && code <= 0xff3a) || (code >= 0xff41 && code <= 0xff5a);
  return isFullWidth ? String.fromCharCode(code - 0xfee0) : null;
}

// Reads the top-level domain a label spells, or null; end is the index after its letters. Zero-width
// characters are skipped. The label may go on after the domain with a non-ASCII character (as text goes
// on after a name in Chinese) or an underscore, but not with an ASCII letter or digit, also behind a
// hyphen: com2 and com-x are other names, com-, com_x and com的說明 are not.
function readTopLevelDomain(label) {
  let letters = '';
  let end = 0;
  for (const char of label) {
    if (INVISIBLE_CHAR.test(char)) { end += char.length; continue; }
    const letter = asciiLetter(char);
    if (letter === null) break;
    letters += letter;
    end += char.length;
  }
  const name = letters.toLowerCase();
  if (!BARE_DOMAIN_TLD_SET.has(name)) return null;
  if (label[end] === '_') return { name, end };
  let rest = end;
  while (rest < label.length && (label[rest] === '-' || INVISIBLE_CHAR.test(label[rest]))) rest += 1;
  if (rest < label.length && /^[A-Za-z0-9]$/u.test(label[rest])) return null;
  return { name, end };
}

// True for a label that cannot be a plain word (or a property or file name): a digit, a hyphen or an
// underscore inside it, a non-ASCII character, or AMBIGUOUS_LABEL_LENGTH characters or more. Hyphens and
// underscores at its ends are punctuation, not part of it.
function isNotPlainEnglishLabel(label) {
  let from = 0;
  let to = label.length;
  while (from < to && (label[from] === '_' || label[from] === '-')) from += 1;
  while (to > from && (label[to - 1] === '_' || label[to - 1] === '-')) to -= 1;
  const core = label.slice(from, to);
  return core.length >= AMBIGUOUS_LABEL_LENGTH || NOT_PLAIN_ENGLISH_LABEL.test(core);
}

// True for a label of letters of Chinese, Japanese or Korean (at least one), with at most digits, combining
// marks, invisible characters, hyphens and underscores besides.
function isUnspacedLabel(label) {
  return UNSPACED_ONLY_LABEL.test(label) && UNSPACED_LETTER.test(label);
}

// What follows a name from index at: its port, path, query and fragment, or '' when there is none.
function readAddressTail(text, at) {
  ADDRESS_TAIL.lastIndex = at;
  return ADDRESS_TAIL.exec(text)[0];
}

// True when run (what follows "https://", up to where the host ends) is the host of an address a browser opens:
// the parser of a browser reads it, and the answer is an IP address (it turns hexadecimal, octal, decimal and
// full-width forms, and the ideographic stop of 93。184。216。34, into one) or a name of two labels or more
// whose last label is an ending (see isEnding). It is no host, and the run is text, when the parser refuses it
// (a "%", a bracket, a colon with no port) or reads a single label (網址要以https://開頭 is one: https://localhost
// is none either, and nobody can open it from another place), or when the last label is a word of a language
// that no top-level domain is (https://開頭。這是常識).
//
// The characters that make a parser refuse a name a client of an older kind opens (a zero width joiner outside
// the script that needs one, a tag character, a mark of direction) are invisible: when the parser refuses the
// run, the run without them is given to it once more, as a client that drops them would, and its answer counts.
function runIsHost(run) {
  // What stands in front of the last "@" is the user: it may be of any length and hold any character (a "%"
  // of any kind as well), and only what stands behind it is the host that is looked at below.
  const host = run.slice(run.lastIndexOf('@') + 1);
  if (UNDECODABLE_PERCENT.test(host)) return false;
  // (Invisible characters are no part of the length: a host padded with them is still the host.)
  const plain = host.replace(IGNORABLE, '');
  if (plain === '' || plain.length > MAX_HOST_LENGTH) return false;
  // A run of letters with no dot is a single label, which is no host: the parser is not asked. It is asked when
  // there is a dot, a port, an encoded character or a bracket, or when the host is a number alone (the user in
  // front of it does not matter: https://甲@2130706433 is an address).
  if (!DOT_OR_ENCODED_DOT.test(plain) && !NEEDS_THE_PARSER.test(plain) && !NUMBER_HOST.test(plain.normalize('NFKC'))) {
    return false;
  }
  let parsed = parseUrl(`https://${run}`);
  if (parsed === null) {
    const visible = run.replace(IGNORABLE, '');
    if (visible !== run) parsed = parseUrl(`https://${visible}`);
  }
  if (parsed === null) return false;
  const { hostname } = parsed;
  if (hostname.startsWith('[') || IPV4_HOST.test(hostname)) return true;
  const labels = hostname.split('.');
  if (labels.at(-1) === '') labels.pop();
  const joined = labels.some((label, index) => label !== '' && labels[index + 1] !== undefined && labels[index + 1] !== '');
  return joined && isEnding(labels.at(-1), plain);
}

// True when label, the last one of a hostname the parser gave (in ASCII: a label of other letters is its
// "xn--" form), can be the last label of a host: a label of letters, digits and hyphens of ASCII (com, zone,
// a look-alike spelling of one), the name of a top-level domain written in other letters (台灣, рф), or any
// "xn--" label that is written so in the text. A word of Chinese, Japanese or Korean that is no top-level
// domain is none, nor is a mix of ASCII letters and other letters (不要用http), nor digits and letters
// (2以後都支援): sentences with a full stop, which a browser reads as a dot, would be one address otherwise.
function isEnding(label, plain) {
  const unicode = domainToUnicode(label) || label;
  if (ASCII_ENDING.test(unicode) || IDN_ENDINGS.has(label)) return true;
  if (!label.startsWith('xn--')) return false;
  // The last label as it is written: the dots and look-alike letters read as the parser reads them.
  const written = plain.normalize('NFKC').toLowerCase().replace(/\u{3002}/gu, '.').replace(/%2e/gu, '.')
    .replace(/:\d*$/u, '').replace(/\.+$/u, '');
  return WRITTEN_PUNYCODE.test(written.slice(written.lastIndexOf('.') + 1));
}

// The answer of runIsHost, remembered for the runs of one text: a text of one address over and over (a list
// of hosts, a pasted block) asks the parser once. A run is long at most MAX_REMEMBERED_RUN characters, and no
// more than MAX_REMEMBERED_RUNS are kept (the memory is emptied when it is full).
const MAX_REMEMBERED_RUN = 256;
const MAX_REMEMBERED_RUNS = 2_048;

function runIsHostOnce(run, verdicts) {
  if (run.length > MAX_REMEMBERED_RUN) return runIsHost(run);
  let verdict = verdicts.get(run);
  if (verdict === undefined) {
    if (verdicts.size >= MAX_REMEMBERED_RUNS) verdicts.clear();
    verdict = runIsHost(run);
    verdicts.set(run, verdict);
  }
  return verdict;
}

// Where the address ends that begins at index start, directly after "https://" (its first character is not
// ASCII and not white space, which the caller has judged), or -1 when the run there is no address.
//
// The run is the host: from its first character up to white space, "<", or the "/", "\", "?" or "#" that
// starts the path (what stands in front of an "@" is the user, and is no part of what is looked at below).
// The first character is a character of it whatever it is (a mark of punctuation as well: 「evil。com), and
// the ideographic full stop and the other dots never end it. It is cut earlier at a mark of Chinese
// punctuation (CLAUSE_PUNCTUATION) that stands behind at least one character of the host (開頭，存到
// config.json; 後接「discord.gg」是邀請), unless:
//   - the mark is the closing one of the opening mark the run began with (「evil」.com);
//   - or two dots or more stand behind it, which is a host with a subdomain (https://★，a.evil.com: a zone
//     of its own may hold any label) and no sentence with a dotted word in it (開頭，版本v1.1.2以後都支援:
//     the last label of that one is judged by runIsHost, and is none).
// With at most one dot behind it, such a mark would stand in the label a name is registered by, or in the
// ending: registries do not take a mark of punctuation there, so the cut loses no host that a browser
// opens. A mark that the parser refuses in a host cuts the run at any rate: no browser opens a link that
// holds it.
// Punctuation at the end of what is left (a full stop, a closing bracket, the closing characters of Markdown)
// is no part of the host. What is left is judged by runIsHost, and goes whole when it is an address.
//
// An address that ended where its host did, at a "/", "\", "?" or "#", goes on over the path, the query and
// the fragment up to an ordinary end of a link, as before.
function readSchemeAddress(text, start, verdicts) {
  const firstLength = text.codePointAt(start) > 0xffff ? 2 : 1;
  let limit = start + firstLength;
  while (limit < text.length && !HOST_END.test(text[limit])) limit += 1;
  // The next scheme (https://是加密的。http://不是) is no label of this host: its "//" ended the run, and the run
  // ends in front of its letters, so that what is read is the host and not "…。http".
  if (text[limit] === '/' && text[limit + 1] === '/' && limit - start > firstLength) {
    const scheme = /https?:$/iu.exec(text.slice(Math.max(start + firstLength, limit - 6), limit));
    if (scheme !== null) limit -= scheme[0].length;
  }
  // What stands in front of the last "@" is the user, which may hold any character: only what follows is the
  // host the marks of punctuation below are looked for in.
  let hostStart = start;
  for (let index = start; index < limit; index += 1) if (text[index] === '@') hostStart = index + 1;
  const hostFirstLength = hostStart < limit && text.codePointAt(hostStart) > 0xffff ? 2 : 1;
  // The last two dots of the host: a mark in front of the second last is inside a host with a subdomain.
  // And the bracket that closes an IPv6 address (https://甲@[::1]/x), which is no punctuation behind the host.
  let lastDot = -1;
  let dotBefore = -1;
  let closeBracket = -1;
  for (let index = hostStart; index < limit; index += 1) {
    const char = text[index];
    const encoded = char === '%' && text[index + 1] === '2' && (text[index + 2] === 'e' || text[index + 2] === 'E');
    if (HOST_DOTS.has(char) || encoded) {
      dotBefore = lastDot;
      lastDot = index;
    } else if (char === ']' && closeBracket < 0) {
      closeBracket = index;
    }
  }
  const floor = text[hostStart] === '[' && closeBracket >= 0 ? closeBracket + 1 : start;
  const closing = CLOSING_PARTNER.get(text[hostStart]);
  let end = limit;
  let seen = !TRAILING_PUNCTUATION.has(text[hostStart]) && !CLAUSE_PUNCTUATION.has(text[hostStart]);
  for (let index = hostStart + hostFirstLength; index < limit; index += 1) {
    const char = text[index];
    if (seen && CLAUSE_PUNCTUATION.has(char) && char !== closing && (REFUSED_IN_A_HOST.has(char) || index > dotBefore)) {
      end = index;
      break;
    }
    if (!TRAILING_PUNCTUATION.has(char) && !CLAUSE_PUNCTUATION.has(char) && !HOST_DOTS.has(char)) seen = true;
  }
  while (end > floor && TRAILING_PUNCTUATION.has(text[end - 1])) end -= 1;
  if (end <= start || !runIsHostOnce(text.slice(start, end), verdicts)) return -1;
  if (end !== limit || limit >= text.length || !PATH_START.has(text[limit])) return end;
  let address = limit;
  while (address < text.length && !SCHEME_RUN_END.test(text[address])) address += 1;
  return address;
}

// Replaces the addresses with a scheme whose first character is not ASCII, which the plain URL step cannot
// read. Such an address is never approved: a page the approval knows is written in ASCII, and the plain URL
// step has already given it in that form. It goes whole, up to where it ends (see readSchemeAddress), with
// the sentence punctuation or Markdown that closes it left outside; the text after it is checked by the
// steps that follow. A run that is no host is text.
// Each host is read once, and it ends at the "//" of the next scheme at the latest, so that a text of many
// schemes takes time in step with its length.
function rewriteSchemeAddresses(text, onRewrite) {
  // A copy, so that nothing called from here can move the position of the scan.
  const schemes = new RegExp(SCHEME_PREFIX);
  const verdicts = new Map();
  let output = '';
  let last = 0;
  for (let match = schemes.exec(text); match !== null; match = schemes.exec(text)) {
    const start = match.index + match[0].length;
    const first = text.codePointAt(start);
    // Nothing, or an ASCII character, is the business of the plain URL step, or of the step for names; white
    // space except U+FEFF ends the link before it begins.
    if (first === undefined || first < 0x80) continue;
    if (NON_BOM_SPACE.test(String.fromCodePoint(first))) continue;
    const end = readSchemeAddress(text, start, verdicts);
    if (end < 0) continue;
    const addressEnd = start + splitAddressEnd(text.slice(start, end)).body.length;
    onRewrite();
    output += `${text.slice(last, match.index)}${BLOCKED_LINK_REPLACEMENT}`;
    last = addressEnd;
    schemes.lastIndex = addressEnd;
  }
  return output + text.slice(last);
}

// Finds the name in a dotted host, or returns null when the host is no link. start and end are indexes in
// host: what lies outside them is text. ownsTail is true when the name ends where the host does, so that
// the port, path, query and fragment after the host belong to it; readTail() gives them.
function findBareDomain(host, readTail) {
  const labels = host.split('.');
  const offsets = [];
  let position = 0;
  for (const label of labels) {
    offsets.push(position);
    position += label.length + 1;
  }
  // What stands in front of the name is text: labels of hyphens, underscores and zero-width characters
  // only, the same characters in front of the first real label, and letters of an unspaced script that
  // come before that label's own letters (請看example.com, but not 領獎中心.com).
  const first = labels.findIndex((label) => !JUNK_ONLY.test(label));
  if (first < 0 || first >= labels.length - 1) return null;
  let start = offsets[first] + (LEADING_JUNK.exec(labels[first])?.[0].length ?? 0);
  const firstLetters = host.slice(start, offsets[first] + labels[first].length);
  const unspaced = UNSPACED_PREFIX.exec(firstLetters)?.[0];
  if (unspaced) {
    const remainder = firstLetters.slice(unspaced.length).replace(LEADING_JUNK, '');
    if (remainder) start += firstLetters.length - remainder.length;
  }
  // The first label that cannot be a plain English word.
  let signal = labels.findIndex((label, index) => index >= first && isNotPlainEnglishLabel(label));
  if (signal < 0) signal = labels.length;
  // The name ends at the last label that is a top-level domain: in evil.com.Then it is evil.com, and in
  // evil.com.me, whose .me alone would be a word, it is evil.com again.
  for (let index = labels.length - 1; index > first; index -= 1) {
    const read = readTopLevelDomain(labels[index]);
    if (!read) continue;
    const end = offsets[index] + read.end;
    const ownsTail = index === labels.length - 1 && end === host.length;
    const hasTail = () => ownsTail && splitAddressEnd(readTail()).body !== '';
    if (AMBIGUOUS_TLD_SET.has(read.name) && signal >= index && !hasTail()) continue;
    // Chinese, Japanese and Korean text has no spaces, and a full stop typed as "." runs the next word into
    // it (我今天很累.Today is bad, 謝謝.Life). When the label right in front of the ending is made of letters
    // of these scripts alone (digits, marks and hyphens aside) the name is so often such a sentence that it is
    // a link only with a port, path, query or fragment (領獎.com/x). A Latin letter in that label, or any
    // label in front of it (免費領取.evil.com, evil領獎.com), makes a name that is no sentence.
    if (!hasTail() && isUnspacedLabel(host.slice(Math.max(start, offsets[index - 1]), offsets[index] - 1))) continue;
    return { start, end, ownsTail };
  }
  return null;
}

// Where the "http://" or "https://" that ends right in front of index at starts, or -1. It is not looked for
// in front of from, where text that was already replaced ends.
function schemeBefore(text, at, from) {
  const begin = Math.max(from, at - 8);
  const match = SCHEME_AT_END.exec(text.slice(begin, at));
  return match === null ? -1 : begin + match.index;
}

// Replaces the dotted names that are links. approve decides on "https://" + the name with its port, path,
// query and fragment. The text is scanned once, left to right; what is read as a name's tail is not
// searched again.
function rewriteBareDomains(text, approve, onRewrite) {
  // A copy, so that nothing called from here can move the position of the scan.
  const names = new RegExp(BARE_DOMAIN_OR_URL);
  const runAfter = createLinkRunReader(text);
  let output = '';
  let last = 0;
  let from = 0;
  let resumed = false;
  for (;;) {
    let match = null;
    if (resumed) {
      BARE_DOMAIN_AT.lastIndex = from;
      match = BARE_DOMAIN_AT.exec(text);
    }
    if (match === null) {
      names.lastIndex = from;
      match = names.exec(text);
      if (match === null) break;
    }
    from = match.index + match[0].length;
    resumed = true;
    const { kept, host } = match.groups;
    if (kept !== undefined) continue;
    const hostEnd = from;
    let tail = null;
    const readTail = () => { tail ??= readAddressTail(text, hostEnd); return tail; };
    const found = findBareDomain(host, readTail);
    if (found === null) continue;
    const { body } = found.ownsTail ? splitAddressEnd(readTail()) : { body: '' };
    const nameStart = match.index + found.start;
    const nameEnd = found.ownsTail ? hostEnd + body.length : match.index + found.end;
    const consumedEnd = found.ownsTail ? hostEnd + tail.length : match.index + found.end;
    const candidate = `https://${host.slice(found.start, found.end)}${body}`;
    const stripped = found.start > 0;
    // Directly after "@", "/" or "%" a name belongs to an e-mail address, a file path or an encoded
    // text, unless it brings its own path, port, query or fragment. A name with letters of an unspaced
    // script is no such token: Chinese text runs into it from either side. Right after a name that was
    // taken out, what stands before it in the result is the replacement, whatever the text had there.
    let before = stripped ? host[found.start - 1] : text[match.index - 1];
    if (!stripped && last > 0 && match.index === last) before = ']';
    if ((before === '@' || before === '/' || before === '%') && !(found.ownsTail && body) &&
        !UNSPACED_LETTER.test(host)) continue;
    from = consumedEnd;
    // An approved name stays only when it stands alone and its link ends where the name does: nothing was
    // cut off in front of it (a link would then start earlier, at a host that is not the approved one),
    // and what follows up to the next space ends the link by itself (see createLinkRunReader).
    if (!stripped && approve(candidate) && runAfter(match.index, consumedEnd).ends) continue;
    onRewrite();
    // A scheme that stands directly in front of the name goes with it. It is still there when the scheme step
    // found no host in the run (the parser refuses a combining mark first: "https://" + U+0301 + evil.com/x),
    // and "https://" in front of the replacement would read as the start of a URL in the next pass.
    const schemeStart = schemeBefore(text, nameStart, last);
    output += `${text.slice(last, schemeStart < 0 ? nameStart : schemeStart)}${BLOCKED_LINK_REPLACEMENT}`;
    last = nameEnd;
  }
  return output + text.slice(last);
}

// Major, minor and patch with no leading zeros, an optional "v" and optional build metadata; no
// pre-release part, and a major version of at least 1.
function parseStableSemverTag(tagName) {
  const match = String(tagName || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 2_147_483_647) || parts[0] < 1) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2], normalized: `${parts[0]}.${parts[1]}.${parts[2]}` };
}

// Checks that value is the release page of tagName in repository and returns its canonical URL. A refusal
// says why: 'unparsable' (not a URL), 'undecodable' (a broken percent-encoding in the path) or 'mismatch'.
function inspectReleaseUrl(value, { owner, repo }, tagName) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_error) { return Object.freeze({ href: null, problem: 'unparsable' }); }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); }
  catch (_error) { return Object.freeze({ href: null, problem: 'undecodable' }); }
  if (url.protocol !== 'https:' || url.hostname !== RELEASE_HOST || url.port || url.username || url.password ||
      url.search || url.hash || decodedPath !== `/${owner}/${repo}/releases/tag/${tagName}`) {
    return Object.freeze({ href: null, problem: 'mismatch' });
  }
  return Object.freeze({
    href: `https://${RELEASE_HOST}/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`,
    problem: null,
  });
}

const OFFICIAL_REPOSITORY_PARTS = Object.freeze({
  owner: OFFICIAL_RELEASE_REPOSITORY.split('/')[0],
  repo: OFFICIAL_RELEASE_REPOSITORY.split('/')[1],
});

// The canonical URL of the official repository's release page for tagName, or null.
function matchOfficialReleaseUrl(value, tagName) {
  return inspectReleaseUrl(value, OFFICIAL_REPOSITORY_PARTS, tagName).href;
}

// A release page path whose one tag segment is a stable release tag in canonical percent-encoding:
// the form encodeURIComponent gives, so a "+" in build metadata is written %2B.
function isStableReleaseTagPath(pathname) {
  if (!pathname.startsWith(RELEASE_TAG_PATH_PREFIX)) return false;
  const segment = pathname.slice(RELEASE_TAG_PATH_PREFIX.length);
  if (!segment || segment.includes('/')) return false;
  let decoded;
  try { decoded = decodeURIComponent(segment); } catch (_error) { return false; }
  return parseStableSemverTag(decoded) !== null && encodeURIComponent(decoded) === segment;
}

// Builds the approval for one scope. The result:
//   rules    the approved hosts in order, each with acceptsPath(pathname)
//   approve  (value) => the normalized https URL when value is an approved link, otherwise null
function createLinkApproval({ approvedReleaseTag, releaseTags = 'approved' } = {}) {
  if (typeof approvedReleaseTag !== 'string' || !approvedReleaseTag) {
    throw new TypeError('A link approval needs the approved release tag.');
  }
  if (!RELEASE_TAG_SCOPES.has(releaseTags)) throw new TypeError('Unknown release tag scope.');
  const approvedReleasePaths = new Set([
    `${OFFICIAL_REPOSITORY_PATH}/releases`,
    `${OFFICIAL_REPOSITORY_PATH}/releases/`,
    `${OFFICIAL_REPOSITORY_PATH}/releases/tag/${approvedReleaseTag}`,
    `${OFFICIAL_REPOSITORY_PATH}/releases/tag/${approvedReleaseTag}/`,
  ]);
  const acceptsReleasePath = releaseTags === 'stable'
    ? (pathname) => approvedReleasePaths.has(pathname) || isStableReleaseTagPath(pathname)
    : (pathname) => approvedReleasePaths.has(pathname);
  const rules = Object.freeze([
    Object.freeze({ hostname: RELEASE_HOST, acceptsPath: acceptsReleasePath }),
    Object.freeze({ hostname: 'discord.gg', acceptsPath: (pathname) => /^\/TqkCx9kYmk\/?$/.test(pathname) }),
    Object.freeze({
      hostname: 'opendata.cwa.gov.tw',
      acceptsPath: (pathname) => /^\/dist\/opendata-swagger\.html$/.test(pathname),
    }),
    Object.freeze({ hostname: 'data.gov.tw', acceptsPath: (pathname) => /^\/dataset\/102011\/?$/.test(pathname) }),
    Object.freeze({
      hostname: 'xiaoji-public-status.xichengyu810067.workers.dev',
      acceptsPath: (pathname) => pathname === '/',
    }),
  ]);

  function approve(value) {
    const raw = String(value || '').trim().replace(/^<|>$/g, '');
    if (!raw || raw.length > MAX_APPROVED_URL_LENGTH || /[\u0000-\u0020\\]/u.test(raw) ||
        DANGEROUS_ENCODED_SEPARATOR.test(raw)) {
      return null;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    const rule = rules.find((candidate) => candidate.hostname === hostname);
    if (!rule || !rule.acceptsPath(parsed.pathname)) return null;
    return parsed.href;
  }

  APPROVER_LENGTH_LIMITS.set(approve, MAX_APPROVED_URL_LENGTH);
  return Object.freeze({ releaseTags, rules, approve });
}

// The punctuation that ends a sentence and is not part of a URL written in running text.
const TRAILING_URL_PUNCTUATION = new Set([...")，.'],。!！?？;；:："]);
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;

// Splits a token into its body and the punctuation at its end. The suffix is the longest run of the
// characters above at the end. (The pattern this replaces, /^(.*?)([),.'\]，。!！?？;；:：]*)$/u, did the
// same, and nothing at all with a line terminator in the token; it took time quadratic in a long run of such
// characters followed by a letter.)
function splitTrailingPunctuation(token) {
  const value = String(token);
  if (LINE_TERMINATOR.test(value)) return { body: '', suffix: '' };
  let end = value.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION.has(value[end - 1])) end -= 1;
  return { body: value.slice(0, end), suffix: value.slice(end) };
}

// The Markdown emphasis characters (* _ ~) at the end of a token, which belong to the text around a link.
// A walk back from the end: a pattern for this takes time quadratic in a long run of them.
const EMPHASIS_CHARACTERS = new Set('*_~');

function trailingEmphasis(token) {
  let start = token.length;
  while (start > 0 && EMPHASIS_CHARACTERS.has(token[start - 1])) start -= 1;
  return token.slice(start);
}

// What follows an approved link, up to the next space or "<": Discord keeps a link going that far, so the
// text after an approved plain URL token or name may still belong to the link it shows. For the link that
// ends at end in text, whose token starts at start, the reader answers:
//   ends           true when the link ends there: nothing visible follows, or what follows starts with an
//                  ordinary end of a link (see LINK_SOFT_END) and holds no dot segment, no encoded separator
//                  approve() refuses and no encoded "%" (a separator encoded twice);
//   stop           where the run ends in the text, so that the run is text.slice(end, stop);
//   visibleLength  how many characters of the run are visible (zero-width characters are not counted).
// A run is read once, however many approved links stand in it, and every other link inside it is answered
// from what was found: where the last separator pattern starts, and where each character stands once
// zero-width characters are left out. Without that, a long paragraph with no space in it and many approved
// links would be read again from each of them (time quadratic in its length).
const DOT_SEGMENTS = new RegExp(PATH_DOT_SEGMENT.source, 'giu');
const ENCODED_SEPARATORS = new RegExp(DANGEROUS_ENCODED_SEPARATOR.source, 'gi');
const ENCODED_PERCENTS = new RegExp(ENCODED_PERCENT.source, 'giu');
const ZERO_WIDTH_CHAR = /[\u{200b}-\u{200d}\u{2060}\u{feff}]/u;

function lastMatchStart(pattern, value) {
  let last = -1;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) last = match.index;
  return last;
}

function createLinkRunReader(text) {
  let runFrom = -1;
  let runStop = -1;
  let visible = '';
  let visibleAt = null;
  let lastPatternStart = -1;

  function readRun(from) {
    let stop = from;
    while (stop < text.length && !LINK_RUN_END.test(text[stop])) stop += 1;
    runFrom = from;
    runStop = stop;
    const run = text.slice(from, stop);
    visibleAt = null;
    if (ZERO_WIDTH_CHAR.test(run)) {
      visibleAt = new Int32Array(run.length + 1);
      let count = 0;
      for (let index = 0; index < run.length; index += 1) {
        visibleAt[index] = count;
        if (!ZERO_WIDTH_CHAR.test(run[index])) count += 1;
      }
      visibleAt[run.length] = count;
    }
    visible = run.replace(ZERO_WIDTH, '');
    lastPatternStart = Math.max(lastMatchStart(DOT_SEGMENTS, visible),
      lastMatchStart(ENCODED_SEPARATORS, visible), lastMatchStart(ENCODED_PERCENTS, visible));
  }

  return function readRunAfter(start, end) {
    if (runFrom < 0 || end < runFrom || end > runStop) readRun(end);
    const offset = end - runFrom;
    const at = visibleAt === null ? offset : visibleAt[offset];
    const visibleLength = visible.length - at;
    if (visibleLength === 0) return { ends: true, stop: runStop, visibleLength };
    const softEnd = LINK_SOFT_END.test(visible[at]) || (visible[at] === '>' && text[start - 1] === '<');
    return { ends: softEnd && lastPatternStart < at, stop: runStop, visibleLength };
  };
}

function rewritePlainUrls(text, approve, onRewrite) {
  const runAfter = createLinkRunReader(text);
  const approvedLimit = APPROVER_LENGTH_LIMITS.get(approve);
  let output = '';
  let last = 0;
  for (const match of text.matchAll(PLAIN_URL)) {
    const start = match.index;
    // Part of a continuation that an approved whole already replaced.
    if (start < last) continue;
    const end = start + match[0].length;
    const { body, suffix } = splitTrailingPunctuation(match[0]);
    // The Markdown emphasis that closes around an address (**https://discord.gg/...**) is no part of it: when
    // the token is refused with the markers, it is judged again without them, and what is approved is kept
    // with them written after it. (Without a marker in front of the address they would be a part of the link
    // Discord shows, which is still a page of the same host.)
    const emphasis = trailingEmphasis(body);
    output += text.slice(last, start);
    last = end;
    let safe = approve(body);
    let kept = '';
    if (!safe && emphasis) {
      safe = approve(body.slice(0, body.length - emphasis.length));
      if (safe) kept = emphasis;
    }
    // What follows an approved token up to the next space, when it must be judged together with the token.
    const run = safe ? runAfter(start, end) : null;
    if (safe && run.ends) {
      output += `${safe}${kept}${suffix}`;
      continue;
    }
    if (run !== null) {
      // The token and its run as one link. approve() refuses a text over its length limit, once zero-width
      // characters and a leading "<" or trailing ">" are taken off: it is not asked about one that is
      // certainly over it, which would mean building and reading the whole run for every token.
      const certainlyTooLong = approvedLimit !== undefined &&
        match[0].length + run.visibleLength - 2 > approvedLimit;
      const whole = certainlyTooLong
        ? null
        : approve(`${match[0]}${text.slice(end, run.stop)}`.replace(ZERO_WIDTH, ''));
      if (whole) {
        output += whole;
        last = run.stop;
        continue;
      }
    }
    onRewrite();
    // Only the token is replaced; text after it stays and is checked by the later steps, and so does the
    // emphasis that closes around the address (**https://evil.com**).
    output += `${BLOCKED_LINK_REPLACEMENT}${emphasis}${suffix}`;
  }
  return output + text.slice(last);
}

const MAX_REWRITE_PASSES = 3;

// Replaces every link approve() refuses, in five steps: masked links, angle-bracket links, plain URLs,
// addresses with a scheme whose first character is not ASCII (https://🎁.ws/x, https://ⓔⓥⓘⓛ.com/: they never
// are approved) and bare www. addresses; the options below add invites and other names written without a
// scheme. Options:
//   approve      the approve function of a link approval
//   maskedLink   'label': a refused [label](url) becomes its label alone;
//                'label-and-marker': it becomes "label [連結已移除]".
//                With an empty label both give the replacement text.
//   bareInvites  also replace Discord invites written without a scheme (discord.gg/..., discord.com/invite/...,
//                discordapp.com/invite/...), whatever their letter case.
//   bareDomains  also replace every other name written without a scheme that Discord would show as a link: a
//                dotted name whose last label is in BARE_DOMAIN_TLDS, with its port, path, query and
//                fragment (free-nitro.com/claim, bit.ly/abc, EVIL.COM). A name is kept when approve()
//                accepts "https://" + the name, as written. Off by default, so a caller that does not ask
//                sees no change.
// Returns { text, rewritten }; rewritten is true when a link was replaced. An approved link is kept in its
// normalized form, which may change its letter case without counting as a rewrite. The steps are run again
// over their answer until it does not change (three times at most): a step that comes late may replace
// something that an earlier one has read (the marker of a replaced invite, glued to "@127", becomes the user
// and the host of an address), and a text that is rewritten twice by two layers must be what one pass gives.
function rewriteLinks(value, { approve, maskedLink = 'label', bareInvites = false, bareDomains = false } = {}) {
  if (typeof approve !== 'function') throw new TypeError('rewriteLinks needs an approve function.');
  if (!MASKED_LINK_STYLES.has(maskedLink)) throw new TypeError('Unknown masked link style.');
  let text = String(value ?? '');
  let rewritten = false;
  for (let pass = 0; pass < MAX_REWRITE_PASSES; pass += 1) {
    const result = rewriteLinksOnce(text, { approve, maskedLink, bareInvites, bareDomains });
    rewritten = rewritten || result.rewritten;
    const settled = result.text === text;
    text = result.text;
    if (settled) break;
  }
  return { text, rewritten };
}

// One go over the steps, in order (see rewriteLinks).
function rewriteLinksOnce(input, { approve, maskedLink, bareInvites, bareDomains }) {
  let text = input;
  let rewritten = false;

  // A masked link has "](" in it, and a text without one is not searched: for a long run of "[" that is the
  // difference between one pass and a scan of 300 characters from each of them.
  if (text.includes('](')) {
    text = text.replace(MARKDOWN_LINK, (_whole, label, target) => {
      const safe = approve(target);
      if (safe) return `[${label}](${safe})`;
      rewritten = true;
      if (!label) return BLOCKED_LINK_REPLACEMENT;
      return maskedLink === 'label' ? label : `${label} ${BLOCKED_LINK_REPLACEMENT}`;
    });
  }
  text = text.replace(ANGLE_AUTOLINK, (_whole, target) => {
    const safe = approve(target);
    if (safe) return `<${safe}>`;
    rewritten = true;
    return BLOCKED_LINK_REPLACEMENT;
  });
  text = rewritePlainUrls(text, approve, () => { rewritten = true; });
  text = rewriteSchemeAddresses(text, () => { rewritten = true; });
  text = text.replace(BARE_WWW, () => {
    rewritten = true;
    return BLOCKED_LINK_REPLACEMENT;
  });
  if (bareInvites) {
    text = text.replace(BARE_INVITE_OR_URL, (whole, keptUrl) => {
      if (keptUrl) return whole;
      rewritten = true;
      return BLOCKED_LINK_REPLACEMENT;
    });
  }
  if (bareDomains) text = rewriteBareDomains(text, approve, () => { rewritten = true; });
  return { text, rewritten };
}

function decodedUrlVariants(value) {
  const variants = [String(value || '')];
  for (let count = 0; count < 2; count += 1) {
    try {
      const decoded = decodeURIComponent(variants.at(-1));
      if (decoded === variants.at(-1)) break;
      variants.push(decoded);
    } catch {
      break;
    }
  }
  return variants;
}

function referencesXiaojiRelease(value) {
  for (const variant of decodedUrlVariants(value)) {
    const lower = variant.toLowerCase();
    if (lower.includes(`${RELEASE_HOST}${OFFICIAL_REPOSITORY_PATH}/releases`) ||
        lower.includes(`${RELEASE_HOST}${OFFICIAL_REPOSITORY_PATH}/compare/`)) return true;
    let parsed;
    try {
      parsed = new URL(variant);
    } catch {
      continue;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (parsed.hostname.toLowerCase() === RELEASE_HOST &&
        (pathname.startsWith(`${OFFICIAL_REPOSITORY_PATH}/releases`) ||
          pathname.startsWith(`${OFFICIAL_REPOSITORY_PATH}/compare/`))) return true;
  }
  return false;
}

// For the chat flow only: true when value holds a URL that points at the official repository's
// releases or comparisons (also through one or two layers of percent-encoding) and approve refuses it.
function containsUnapprovedXiaojiReleaseUrl(value, approve) {
  if (typeof approve !== 'function') throw new TypeError('containsUnapprovedXiaojiReleaseUrl needs an approve function.');
  for (const match of String(value || '').matchAll(URL_CANDIDATE)) {
    const { body } = splitTrailingPunctuation(match[0].replace(/[)>]+$/u, ''));
    if (referencesXiaojiRelease(body) && !approve(body)) return true;
  }
  return false;
}

module.exports = {
  AMBIGUOUS_BARE_DOMAIN_TLDS,
  BARE_DOMAIN_TLDS,
  BLOCKED_LINK_REPLACEMENT,
  IDN_TOP_LEVEL_DOMAINS,
  OFFICIAL_RELEASE_REPOSITORY,
  containsUnapprovedXiaojiReleaseUrl,
  createLinkApproval,
  inspectReleaseUrl,
  matchOfficialReleaseUrl,
  parseStableSemverTag,
  rewriteLinks,
};
