'use strict';

// A deterministic, offline check of the links in one message for the signs of a phishing or malware lure. It is used
// to tell the Owner (a security alert of kind link-risk, see linkRiskMonitor.js); it deletes, mutes and answers nothing.
//
// It is meant to be quiet: an ordinary link (a video, a repository, an official Discord page) in an ordinary sentence
// never counts, and a rule fires only on a sign that an honest message has almost no reason to carry. It answers
// { risky, reasons, hasLink }: `reasons` holds fixed codes (LINK_RISK_REASONS) and never any text of the message, and
// `hasLink` says whether the message holds a link at all (what Discord would show as one), which decides whether the
// optional second opinion is asked.
//
// Work is bounded: the text is cut to MAX_TEXT_LENGTH characters (before and after NFKC), at most MAX_URLS links are
// read, a host is cut to MAX_HOST_LENGTH, and every pattern below is linear (no nested repeats; bounded gaps).
// Finding the links reuses the link policy of the egress guard (rewriteLinks with a collecting approve function), which
// is what decides what Discord shows as a link; the rules then read each link's host and path.

const { rewriteLinks } = require('../../platform/linkPolicy');

const MAX_TEXT_LENGTH = 4_000;
const MAX_URLS = 10;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 40;

const LINK_RISK_REASONS = Object.freeze({
  PUNYCODE_HOST: 'punycode_host',
  MIXED_SCRIPT_HOST: 'mixed_script_host',
  IP_HOST: 'ip_host',
  USERINFO_HOST: 'userinfo_host',
  BRAND_LOOKALIKE: 'brand_lookalike',
  BRAND_WITH_BAIT_WORD: 'brand_with_bait_word',
  BRAND_AS_SUBDOMAIN: 'brand_as_subdomain',
  BAIT_WITH_LINK: 'bait_with_link',
  SHORTENER_WITH_BAIT: 'shortener_with_bait',
  EXECUTABLE_DOWNLOAD: 'executable_download',
  MASS_MENTION_WITH_LINK: 'mass_mention_with_link',
});

// The brands a lure imitates, with the domains that really are theirs. A host that is one of these domains, or a
// subdomain of one, is never judged by the brand rules.
const BRANDS = Object.freeze([
  { names: ['discord', 'discordapp'], official: ['discord.com', 'discord.gg', 'discord.gift', 'discord.media', 'discord.new',
    'discord.dev', 'discord.design', 'discord.store', 'discord.co', 'discordapp.com', 'discordapp.net', 'discordstatus.com',
    'discordmerch.com', 'dis.gd'] },
  { names: ['steam', 'steampowered', 'steamcommunity'], official: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com',
    'steamgames.com', 'steamcontent.com', 'steam-chat.com', 'steamserver.net', 'valvesoftware.com'] },
  { names: ['roblox'], official: ['roblox.com', 'rbxcdn.com'] },
  { names: ['epicgames', 'fortnite'], official: ['epicgames.com', 'unrealengine.com', 'fortnite.com'] },
  { names: ['paypal'], official: ['paypal.com', 'paypal.me', 'paypalobjects.com'] },
  { names: ['twitch'], official: ['twitch.tv', 'twitchcdn.net', 'ttvnw.net', 'twitch.com'] },
]);
const OFFICIAL_DOMAINS = Object.freeze(BRANDS.flatMap((brand) => brand.official));

// Words that make a brand name in a domain a lure (discord-nitro.com), and the words that go with "nitro".
const BAIT_WORDS = Object.freeze(['nitro', 'gift', 'free', 'verify', 'verification', 'login', 'signin', 'claim', 'promo',
  'airdrop', 'giveaway', 'reward', 'prize', 'bonus', 'auth', 'account', 'security', 'support', 'wallet']);
const NITRO_PARTNER_WORDS = Object.freeze(['free', 'gift', 'claim', 'promo', 'giveaway', 'airdrop', 'reward', 'prize', 'bonus']);
// Real words that sit one letter from a brand name.
const NEAR_WORD_ALLOWLIST = new Set(['discard', 'discords']);

// Hosts of ordinary, well-known places: a bait phrase or an @everyone next to a link to one of these is no lure.
const TRUSTED_DOMAINS = Object.freeze([
  ...OFFICIAL_DOMAINS,
  'youtube.com', 'youtu.be', 'github.com', 'githubusercontent.com', 'gitlab.com', 'google.com', 'google.com.tw',
  'wikipedia.org', 'wikimedia.org', 'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'threads.net',
  'tiktok.com', 'spotify.com', 'netflix.com', 'imgur.com', 'tenor.com', 'giphy.com', 'bilibili.com', 'line.me', 'medium.com',
  'notion.so', 'stackoverflow.com', 'npmjs.com', 'nodejs.org', 'python.org', 'mozilla.org', 'microsoft.com', 'apple.com',
  'amazon.com', 'twitch.tv', 'pixiv.net', 'wikihow.com', 'bahamut.com.tw', 'gamer.com.tw', 'ptt.cc', 'cwa.gov.tw',
]);
const TRUSTED_SUFFIXES = Object.freeze(['.gov', '.edu', '.gov.tw', '.edu.tw']);

// Hosts of link shorteners.
const SHORTENER_DOMAINS = Object.freeze(['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'v.gd', 'cutt.ly', 'rb.gy', 'shorturl.at',
  'shorturl.asia', 'goo.gl', 'ow.ly', 'buff.ly', 'tiny.cc', 'rebrand.ly', 't.ly', 's.id', 'reurl.cc', 'lihi.cc', 'lnkd.in',
  'clck.ru', 'tr.ee', 'qr.ae', '0rz.tw']);

// A direct download of a program. The places that publish programs honestly are exempt; Discord's own file host is not.
const EXECUTABLE_EXTENSION = /\.(?:exe|scr|bat|cmd|msi|apk|jar|vbs|ps1|lnk|iso|dmg|com)$/u;
const DOWNLOAD_EXEMPT_DOMAINS = Object.freeze(['github.com', 'githubusercontent.com', 'gitlab.com', 'sourceforge.net',
  'microsoft.com', 'python.org', 'nodejs.org', 'mozilla.org', 'mozilla.net', 'videolan.org', '7-zip.org',
  'notepad-plus-plus.org', 'jetbrains.com', 'apple.com', 'google.com', 'archive.org', 'ubuntu.com', 'debian.org',
  'archlinux.org', 'fedoraproject.org', 'linuxmint.com']);

// Lure phrases, in English and Chinese. Bounded gaps only; matched on the normalized, lower-cased text.
const BAIT_PATTERNS = Object.freeze([
  /free\s{0,3}(?:discord\s{0,3})?nitro/u,
  /nitro\s{0,3}(?:gift|giveaway|for\s{1,3}free)/u,
  /steam\s{0,3}(?:gift|giveaway|wallet\s{0,3}code)/u,
  /free\s{0,3}(?:robux|v-?bucks|steam\s{0,3}(?:gift|key|wallet|game))/u,
  /claim\s{0,3}(?:your\s{0,3})?(?:free\s{0,3})?(?:gift|nitro|reward|prize|airdrop|bonus)/u,
  /verify\s{0,3}your\s{0,3}(?:discord\s{0,3})?account/u,
  /you(?:'ve|\s{0,3}have)\s{0,3}(?:been\s{0,3})?(?:won|selected|chosen)/u,
  /congratulations?.{0,30}(?:won|winner|selected|prize)/u,
  /(?:account|discord).{0,30}(?:will\s{0,3}be|has\s{0,3}been|is)\s{0,3}(?:suspended|banned|disabled|terminated)/u,
  /\bairdrop\b/u,
  /免費\s{0,3}(?:discord\s{0,3})?nitro/u,
  /(?:nitro|尼特羅).{0,6}(?:禮物|禮包|免費|贈送|礼物|礼包|免费|赠送)/u,
  /steam\s{0,3}(?:禮物|禮品|贈送|禮包|免費|礼物|礼品|赠送|礼包|免费)/u,
  /(?:領取|領|免費領|限時領|领取|领|免费领|限时领)\s{0,3}(?:禮物|禮包|獎勵|獎品|獎金|紅包|礼物|礼包|奖励|奖品|奖金|红包)/u,
  /驗證\s{0,3}(?:你的|您的)?\s{0,3}(?:discord\s{0,3})?帳號|验证\s{0,3}(?:你的|您的)?\s{0,3}(?:discord\s{0,3})?账号/u,
  /恭喜\s{0,3}(?:你|您)?\s{0,3}(?:中獎|獲得|抽中|被選中|中奖|获得|被选中)/u,
  /(?:帳號|賬號|账号).{0,10}(?:將被|即將|已被|被)\s{0,3}(?:停用|封鎖|封號|停權|凍結|封锁|封号|停权|冻结)/u,
  /空投/u,
]);
const MASS_MENTION = /@(?:everyone|here)/u;

// Zero-width, bidirectional, tag and other format characters, and the soft hyphen: they split a word without showing.
const INVISIBLE = /[\p{Cf}­]/gu;
// A link written with the "hxxp" disguise, or "www.", which the link policy reads only as a name; read here too.
const EXTRA_URL = /(?:h(?:tt|xx)ps?:\/\/|www\.)[^\s<>"'`()[\]{}|]+/giu;
// The characters of unspaced scripts end an address in running text (請看https://youtube.com/watch很好看).
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}，。、；：！？「」『』（）《》“”‘’…]/u;
const SCHEME_PREFIX = /^h(?:tt|xx)ps?:\/\//iu;
const NUMBER_PART = '(?:0x[0-9a-f]+|[0-9]+)';
const DOTTED_DECIMAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const NUMERIC_HOST = new RegExp(`^${NUMBER_PART}(?:\\.${NUMBER_PART}){0,3}$`, 'u');

// Letters of other scripts that look like Latin ones, and the digits and signs a lure writes for letters.
const CONFUSABLE_LETTERS = new Map(Object.entries({
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ԛ: 'q', ԝ: 'w', ɡ: 'g',
  α: 'a', ε: 'e', ι: 'i', ο: 'o', ρ: 'p', υ: 'u', ν: 'v', τ: 't', κ: 'k', ς: 's',
}));
const SIGN_LETTERS = new Map(Object.entries({ 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' }));

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function inDomains(host, domains) {
  for (const domain of domains) if (hostMatches(host, domain)) return true;
  return false;
}

function isOfficialHost(host) {
  return inDomains(host, OFFICIAL_DOMAINS);
}

function isTrustedHost(host) {
  return inDomains(host, TRUSTED_DOMAINS) || TRUSTED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Optimal string alignment distance (insertions, deletions, substitutions and swaps of neighbours). Both strings are
// short (a label of at most MAX_LABEL_LENGTH and a brand name), and a gap of more than two returns early.
function osaDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows.push(new Array(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

function foldConfusables(label) {
  let out = '';
  for (const char of label) out += CONFUSABLE_LETTERS.get(char) ?? SIGN_LETTERS.get(char) ?? char;
  return out;
}

function collapseRuns(label) {
  return label.replace(/(.)\1+/gu, '$1');
}

function normalizeText(value) {
  let text = String(value ?? '');
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  text = text.normalize('NFKC').replace(INVISIBLE, '');
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

// The links of the text, at most MAX_URLS: what the link policy would replace, and the addresses it reads only as names.
function extractUrls(text) {
  const found = [];
  const seen = new Set();
  const add = (raw) => {
    if (found.length >= MAX_URLS || typeof raw !== 'string' || !raw || seen.has(raw)) return;
    seen.add(raw);
    found.push(raw);
  };
  let hasLink = false;
  try {
    const result = rewriteLinks(text, {
      approve: (raw) => { add(raw); return null; }, maskedLink: 'label', bareInvites: true, bareDomains: true,
    });
    hasLink = result.rewritten;
  } catch {
    hasLink = false;
  }
  for (const match of text.matchAll(EXTRA_URL)) {
    hasLink = true;
    add(match[0]);
    if (found.length >= MAX_URLS) break;
  }
  return { urls: found, hasLink: hasLink || found.length > 0 };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// The user, host and path of one address as written; null when it names no host.
function parseAddress(raw) {
  const rest = raw.replace(SCHEME_PREFIX, '');
  const pathAt = rest.search(/[/\\?#]/u);
  let authority = pathAt < 0 ? rest : rest.slice(0, pathAt);
  const path = pathAt < 0 ? '' : rest.slice(pathAt);
  const cut = authority.search(UNSPACED);
  if (cut >= 0) authority = authority.slice(0, cut);
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : '';
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    host = close < 0 ? hostPort : hostPort.slice(0, close + 1);
  } else {
    host = hostPort.replace(/:\d{0,5}$/u, '');
  }
  host = safeDecode(host).toLowerCase().replace(/\.+$/u, '').slice(0, MAX_HOST_LENGTH);
  if (!host) return null;
  const pathOnly = path.split(/[?#]/u, 1)[0];
  return { userinfo, host, path: safeDecode(pathOnly).toLowerCase() };
}

function isPrivateIpv4(host) {
  if (!DOTTED_DECIMAL.test(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isIpHost(host) {
  if (host.startsWith('[')) return host !== '[::1]';
  if (DOTTED_DECIMAL.test(host)) return !isPrivateIpv4(host);
  return NUMERIC_HOST.test(host);
}

function hasMixedScript(host) {
  if (!/[^\u0000-\u007f]/u.test(host)) return false;
  for (const char of host) if (CONFUSABLE_LETTERS.has(char)) return /[a-z]/u.test(host);
  return false;
}

// Brand rules for one host that is not itself official. Returns the reason codes that apply.
function brandReasons(host) {
  const reasons = new Set();
  // The official domain written inside someone else's host: discord.com.verify-login.xyz, steamcommunity.com-gift.ru.
  for (const domain of OFFICIAL_DOMAINS) {
    const at = host.indexOf(domain);
    if (at < 0) continue;
    const before = at === 0 ? '' : host[at - 1];
    const after = host[at + domain.length] ?? '';
    if ((before === '' || before === '.') && (after === '.' || after === '-' || after === '')) {
      reasons.add(LINK_RISK_REASONS.BRAND_AS_SUBDOMAIN);
      break;
    }
  }
  const labels = host.split('.');
  // The last label is the ending; the labels before it are the names.
  for (const label of labels.slice(0, -1)) {
    if (label.length < 4 || label.length > MAX_LABEL_LENGTH) continue;
    const joined = label.replace(/-/gu, '');
    const candidates = new Set([label, joined, ...label.split('-').filter((part) => part.length >= 4)]);
    for (const candidate of candidates) {
      // A name written with hyphens inside it (dis-cord) is the brand name in disguise.
      const hyphenated = candidate === joined && label !== joined;
      const folded = foldConfusables(candidate);
      const variants = new Set([folded, folded.replace(/rn/gu, 'm'), folded.replace(/vv/gu, 'w'), collapseRuns(folded)]);
      for (const brand of BRANDS) {
        for (const name of brand.names) {
          if (candidate === name && !hyphenated) continue;
          const collapsedName = collapseRuns(name);
          for (const variant of variants) {
            const lookalike = variant === name || variant === collapsedName ||
              (name.length >= 7 && !NEAR_WORD_ALLOWLIST.has(candidate) && osaDistance(variant, name) === 1) ||
              (name.length >= 12 && osaDistance(variant, name) <= 2);
            if (lookalike && !NEAR_WORD_ALLOWLIST.has(candidate)) reasons.add(LINK_RISK_REASONS.BRAND_LOOKALIKE);
          }
          if (folded.includes(name) && BAIT_WORDS.some((word) => folded.includes(word))) {
            reasons.add(LINK_RISK_REASONS.BRAND_WITH_BAIT_WORD);
          }
        }
      }
      if (folded.includes('nitro') && NITRO_PARTNER_WORDS.some((word) => folded.includes(word))) {
        reasons.add(LINK_RISK_REASONS.BRAND_WITH_BAIT_WORD);
      }
    }
  }
  return reasons;
}

function hostReasons(address) {
  const { userinfo, host, path } = address;
  const reasons = new Set();
  if (userinfo) reasons.add(LINK_RISK_REASONS.USERINFO_HOST);
  if (isIpHost(host)) {
    reasons.add(LINK_RISK_REASONS.IP_HOST);
  } else if (!host.startsWith('[')) {
    if (host.split('.').some((label) => label.startsWith('xn--'))) reasons.add(LINK_RISK_REASONS.PUNYCODE_HOST);
    if (hasMixedScript(host)) reasons.add(LINK_RISK_REASONS.MIXED_SCRIPT_HOST);
    if (!isOfficialHost(host)) for (const reason of brandReasons(foldHostForBrand(host))) reasons.add(reason);
  }
  if (EXECUTABLE_EXTENSION.test(path.replace(/\/+$/u, '')) && !inDomains(host, DOWNLOAD_EXEMPT_DOMAINS)) {
    reasons.add(LINK_RISK_REASONS.EXECUTABLE_DOWNLOAD);
  }
  return reasons;
}

// The brand rules read the host with look-alike letters of other scripts already mapped (the original host is what
// the other rules read), so that a Cyrillic "і" is compared as the Latin one.
function foldHostForBrand(host) {
  let out = '';
  for (const char of host) out += CONFUSABLE_LETTERS.get(char) ?? char;
  return out;
}

// `shortener` hosts count as untrusted for the bait rule.
function isShortener(host) {
  return inDomains(host, SHORTENER_DOMAINS);
}

function scanLinkRisk(value) {
  const text = normalizeText(value);
  if (!text) return Object.freeze({ risky: false, reasons: Object.freeze([]), hasLink: false });
  const { urls, hasLink } = extractUrls(text);
  const reasons = new Set();
  const addresses = [];
  for (const raw of urls) {
    const address = parseAddress(raw);
    if (!address) continue;
    // A host is a dotted name that ends in letters (or an IDN or punycode ending), or an address of its own.
    if (!isIpHost(address.host) && !address.host.startsWith('[')) {
      if (!address.host.includes('.')) continue;
      const ending = address.host.slice(address.host.lastIndexOf('.') + 1);
      if (!/^(?:[a-z]{2,24}|xn--[a-z0-9-]+)$/u.test(ending) && !/[^\u0000-\u007f]/u.test(ending)) continue;
    }
    addresses.push(address);
    for (const reason of hostReasons(address)) reasons.add(reason);
  }
  const lowered = text.toLowerCase();
  const untrusted = addresses.filter((address) => !isTrustedHost(address.host));
  if (untrusted.length > 0) {
    if (BAIT_PATTERNS.some((pattern) => pattern.test(lowered))) {
      reasons.add(untrusted.some((address) => isShortener(address.host))
        ? LINK_RISK_REASONS.SHORTENER_WITH_BAIT : LINK_RISK_REASONS.BAIT_WITH_LINK);
    }
    if (MASS_MENTION.test(lowered)) reasons.add(LINK_RISK_REASONS.MASS_MENTION_WITH_LINK);
  }
  const ordered = Object.values(LINK_RISK_REASONS).filter((code) => reasons.has(code));
  return Object.freeze({ risky: ordered.length > 0, reasons: Object.freeze(ordered), hasLink });
}

module.exports = {
  LINK_RISK_REASONS,
  MAX_HOST_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_URLS,
  osaDistance,
  scanLinkRisk,
};
