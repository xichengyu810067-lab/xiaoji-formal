'use strict';

// The shared link policy (src/platform/linkPolicy.js): its two approval scopes, the two masked link
// styles, invites and domains written without a scheme, and that rewriting twice changes nothing more.
// How the chat output and the release notice behave on top of it is pinned in
// test/linkApprovalPins.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { domainToASCII, domainToUnicode } = require('node:url');

const linkPolicy = require('../src/platform/linkPolicy');
const { approvedUrl, sanitizeUserFacingOutput } = require('../src/systems/conversation/userFacingOutputPolicy');
const { getApprovedPublicRelease } = require('../src/systems/conversation/publicFacts');
const { buildReleaseMessage } = require('../src/services/releaseAnnouncementService');
const { LINK_CASES } = require('./fixtures/linkApprovalCorpus');
const {
  ADDRESSES: PARSER_ADDRESSES,
  REMOVED_BY_DESIGN,
  TEXT: PARSER_TEXT,
  TEXT_WITH_A_NAME,
  WITH_CONTEXT,
} = require('./fixtures/schemeAddressCases');

const {
  AMBIGUOUS_BARE_DOMAIN_TLDS,
  BARE_DOMAIN_TLDS,
  BLOCKED_LINK_REPLACEMENT,
  IDN_TOP_LEVEL_DOMAINS,
  OFFICIAL_RELEASE_REPOSITORY,
  createLinkApproval,
  matchOfficialReleaseUrl,
  rewriteLinks,
} = linkPolicy;

const APPROVED_TAG = getApprovedPublicRelease().tag;
const RELEASES = `https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`;
const chat = createLinkApproval({ approvedReleaseTag: APPROVED_TAG, releaseTags: 'approved' });
const wide = createLinkApproval({ approvedReleaseTag: APPROVED_TAG, releaseTags: 'stable' });
const chatRewrite = (text) => rewriteLinks(text, { approve: chat.approve, maskedLink: 'label' });
const wideRewrite = (text) => rewriteLinks(text, { approve: wide.approve, maskedLink: 'label-and-marker', bareInvites: true });
// What the egress guard and the chat output policy ask for: names written without a scheme as well.
const egressRewrite = (text) => rewriteLinks(text, {
  approve: wide.approve, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true,
});
const chatDomainRewrite = (text) => rewriteLinks(text, { approve: chat.approve, maskedLink: 'label', bareDomains: true });
const corpusInputs = LINK_CASES.map(([input]) => input);

const STABLE_RELEASE_PAGES = Object.freeze([
  `${RELEASES}/tag/v1.1.2`,
  `${RELEASES}/tag/v1.1.0`,
  `${RELEASES}/tag/1.4.0`,
  `${RELEASES}/tag/v2.0.0`,
  `${RELEASES}/tag/v10.20.30`,
  `${RELEASES}/tag/v1.1.2%2Bbuild.5`,
  `${RELEASES}/tag/v1.0.0%2Bexp.sha.5114f85`,
  `https://GitHub.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
  `https://github.com:443/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
]);

const REFUSED_RELEASE_PAGES = Object.freeze([
  `${RELEASES}/tag/v1.2.0-beta.1`,
  `${RELEASES}/tag/v1.2.3-rc.1%2Bbuild`,
  `${RELEASES}/tag/v0.9.0`,
  `${RELEASES}/tag/V1.1.2`,
  `${RELEASES}/tag/v01.1.2`,
  `${RELEASES}/tag/nightly`,
  `${RELEASES}/tag/unapproved-build`,
  `${RELEASES}/tag/`,
  `${RELEASES}/tag/v1.1.2/`,
  `${RELEASES}/tag/v1.1.2/assets`,
  `${RELEASES}/tag/v1.1.2+build.5`,
  `${RELEASES}/tag/v1.1.2%2bbuild.5`,
  `${RELEASES}/tag/%76${'1.1.2'}`,
  `${RELEASES}/tag/v1%2E1%2E2`,
  `${RELEASES}/tag/v1.1.2%2Fx`,
  `${RELEASES}/latest`,
  `https://github.com/other-owner/xiaoji-formal/releases/tag/v1.1.2`,
  `https://github.com/${OFFICIAL_RELEASE_REPOSITORY.toUpperCase()}/releases/tag/v1.1.2`,
  `http://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
  `https://www.github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
  `https://github.com.evil.example/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
  `${RELEASES}/tag/v1.1.2?x=1`,
  `${RELEASES}/tag/v1.1.2#top`,
  `https://user@github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
  `https://github.com:8443/${OFFICIAL_RELEASE_REPOSITORY}/releases/tag/v1.1.2`,
]);

test('the stable scope approves everything the approved scope does, with the same result and hosts', () => {
  assert.deepEqual(wide.rules.map((rule) => rule.hostname), chat.rules.map((rule) => rule.hostname));
  const candidates = [...corpusInputs, ...STABLE_RELEASE_PAGES, ...REFUSED_RELEASE_PAGES,
    `${RELEASES}/tag/${APPROVED_TAG}/`];
  let approvedByChat = 0;
  for (const candidate of candidates) {
    const fromChat = chat.approve(candidate);
    if (fromChat === null) continue;
    approvedByChat += 1;
    assert.equal(wide.approve(candidate), fromChat, candidate);
  }
  assert.ok(approvedByChat >= 20, `only ${approvedByChat} corpus links are approved`);
  // The approved scope is the chat output policy's own approval.
  for (const candidate of candidates) assert.equal(chat.approve(candidate), approvedUrl(candidate), candidate);
});

test('the stable scope adds the release page of any stable tag of the official repository, and nothing else', () => {
  for (const page of STABLE_RELEASE_PAGES) {
    assert.ok(wide.approve(page), page);
    if (!page.includes(`/tag/${APPROVED_TAG}`)) assert.equal(chat.approve(page), null, page);
  }
  assert.equal(wide.approve(`${RELEASES}/tag/v1.1.2%2Bbuild.5`), `${RELEASES}/tag/v1.1.2%2Bbuild.5`);
  for (const page of REFUSED_RELEASE_PAGES) {
    assert.equal(wide.approve(page), null, page);
    assert.equal(chat.approve(page), null, page);
  }
});

test('every release notice the bot builds links to a page the stable scope approves', () => {
  for (const tagName of ['v1.1.2', '1.4.0', 'v2.0.0+build.7', 'v10.20.30']) {
    for (const htmlUrl of [`${RELEASES}/tag/${tagName}`, `${RELEASES}/tag/${encodeURIComponent(tagName)}`]) {
      const message = buildReleaseMessage({ tag_name: tagName, html_url: htmlUrl, published_at: '2026-10-01T00:00:00.000Z', nonce: 'n' });
      const { url } = message.embeds[0].toJSON();
      assert.equal(url, matchOfficialReleaseUrl(htmlUrl, tagName), htmlUrl);
      assert.equal(wide.approve(url), url, htmlUrl);
    }
  }
});

test('a link approval needs the approved tag and a known scope', () => {
  for (const options of [{}, { approvedReleaseTag: '' }, { approvedReleaseTag: 7 }, { approvedReleaseTag: 'v1.1.1', releaseTags: 'any' }]) {
    assert.throws(() => createLinkApproval(options), TypeError, JSON.stringify(options));
  }
  assert.throws(() => rewriteLinks('x', {}), TypeError);
  assert.throws(() => rewriteLinks('x', { approve: chat.approve, maskedLink: 'drop' }), TypeError);
  assert.throws(() => linkPolicy.containsUnapprovedXiaojiReleaseUrl('x'), TypeError);
  assert.ok(Object.isFrozen(chat) && Object.isFrozen(chat.rules));
});

test('rewriting the result again changes nothing and reports nothing, in both styles', () => {
  const extra = [
    `[x](https://evil.example)(https://evil.example/y)`,
    `[[x](https://evil.example)](${RELEASES})`,
    `discord.gg/abc https://discord.gg/TqkCx9kYmk discord.com/invite/xyz`,
    `[discord.gg/abc](https://evil.example)`,
  ];
  for (const input of [...corpusInputs, ...extra]) {
    for (const [name, rewrite] of [['label', chatRewrite], ['label-and-marker', wideRewrite]]) {
      const once = rewrite(input);
      const twice = rewrite(once.text);
      assert.equal(twice.text, once.text, `${name} ${JSON.stringify(input)}`);
      assert.equal(twice.rewritten, false, `${name} ${JSON.stringify(input)}`);
    }
  }
});

test('an AI reply that went through the chat policy comes through the stable scope unchanged, except an approved bare invite', () => {
  // An invite not written right after "://" is a bare one; the approved https invite link is not. The chat
  // policy already removes every bare name that is not approved, so the egress scope has one thing left to do
  // here: the approved invite written without a scheme is still an invite there.
  const bareInvite = /(?<!:\/\/)discord(?:(?:app)?\.com\/invite|\.gg(?:\/invite)?)\/[\w-]+/giu;
  let changed = 0;
  for (const input of corpusInputs) {
    const aiText = sanitizeUserFacingOutput(input, { emit: () => {} });
    const passed = wideRewrite(aiText);
    assert.equal(passed.text, aiText.replace(bareInvite, BLOCKED_LINK_REPLACEMENT), JSON.stringify(input));
    if (passed.text !== aiText) changed += 1;
    // With names written without a scheme asked for as well, the stable scope adds nothing but that invite.
    assert.equal(egressRewrite(aiText).text, passed.text, JSON.stringify(input));
  }
  // Only the corpus entry that holds the approved invite without a scheme changes.
  assert.equal(changed, 1);
});

test('a refused masked link keeps its label alone, or its label and the marker', () => {
  const cases = [
    ['[安全標籤](https://evil.example/redirect)', '安全標籤', `安全標籤 ${BLOCKED_LINK_REPLACEMENT}`],
    ['[](https://evil.example/empty)', BLOCKED_LINK_REPLACEMENT, BLOCKED_LINK_REPLACEMENT],
    ['看[這裡](<https://evil.example/angle>)吧', '看這裡吧', `看這裡 ${BLOCKED_LINK_REPLACEMENT}吧`],
    ['[標籤](https://evil.example "title")', '標籤', `標籤 ${BLOCKED_LINK_REPLACEMENT}`],
    ['[a](https://evil.example/1)[b](http://evil.example/2)', 'ab', `a ${BLOCKED_LINK_REPLACEMENT}b ${BLOCKED_LINK_REPLACEMENT}`],
    [`[https://evil.example/label](https://evil.example)`, BLOCKED_LINK_REPLACEMENT,
      `${BLOCKED_LINK_REPLACEMENT} ${BLOCKED_LINK_REPLACEMENT}`],
  ];
  for (const [input, labelOnly, withMarker] of cases) {
    assert.deepEqual(chatRewrite(input), { text: labelOnly, rewritten: true }, input);
    assert.deepEqual(wideRewrite(input), { text: withMarker, rewritten: true }, input);
  }
  // An approved target is kept in both styles, normalized.
  for (const rewrite of [chatRewrite, wideRewrite]) {
    assert.deepEqual(rewrite(`[版本](<https://GitHub.com/${OFFICIAL_RELEASE_REPOSITORY}/releases>)`),
      { text: `[版本](${RELEASES})`, rewritten: false });
  }
  assert.deepEqual(wideRewrite(`[新版](${RELEASES}/tag/v1.1.2)`), { text: `[新版](${RELEASES}/tag/v1.1.2)`, rewritten: false });
  assert.deepEqual(chatRewrite(`[新版](${RELEASES}/tag/v1.1.2)`), { text: '新版', rewritten: true });
});

test('invites written without a scheme are replaced in the stable scope wherever they stand', () => {
  const cases = [
    ['discord.gg/abc123', BLOCKED_LINK_REPLACEMENT],
    ['discord.com/invite/abc123', BLOCKED_LINK_REPLACEMENT],
    ['discordapp.com/invite/abc123', BLOCKED_LINK_REPLACEMENT],
    ['discord.gg/invite/abc123', BLOCKED_LINK_REPLACEMENT],
    ['DISCORD.GG/ABC123', BLOCKED_LINK_REPLACEMENT],
    ['Discord.com/Invite/abc-123_x', BLOCKED_LINK_REPLACEMENT],
    ['DiscordApp.Com/INVITE/abc', BLOCKED_LINK_REPLACEMENT],
    ['加入discord.gg/abc123吧', `加入${BLOCKED_LINK_REPLACEMENT}吧`],
    ['來玩 discord.gg/abc123 一起', `來玩 ${BLOCKED_LINK_REPLACEMENT} 一起`],
    ['(discord.gg/abc123)', `(${BLOCKED_LINK_REPLACEMENT})`],
    ['「discord.com/invite/abc」。', `「${BLOCKED_LINK_REPLACEMENT}」。`],
    ['xdiscord.gg/abc', `x${BLOCKED_LINK_REPLACEMENT}`],
    ['https:/discord.gg/abc', `https:/${BLOCKED_LINK_REPLACEMENT}`],
    ['discord.gg/TqkCx9kYmk', BLOCKED_LINK_REPLACEMENT],
    ['[點我](discord.gg/abc)', `[點我](${BLOCKED_LINK_REPLACEMENT})`],
    ['[discord.gg/abc](https://evil.example)', `${BLOCKED_LINK_REPLACEMENT} ${BLOCKED_LINK_REPLACEMENT}`],
    ['一 discord.gg/a 二 discord.com/invite/b 三', `一 ${BLOCKED_LINK_REPLACEMENT} 二 ${BLOCKED_LINK_REPLACEMENT} 三`],
    ['https://discord.gg/TqkCx9kYmk，discord.gg/abc', `https://discord.gg/TqkCx9kYmk，${BLOCKED_LINK_REPLACEMENT}`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, input);
    // Without bareInvites (the chat output policy's way) text that holds no other link is left alone.
    if (!/https?:\/\//u.test(input)) {
      assert.deepEqual(rewriteLinks(input, { approve: wide.approve, maskedLink: 'label-and-marker' }),
        { text: input, rewritten: false }, input);
      assert.deepEqual(chatRewrite(input), { text: input, rewritten: false }, input);
    }
  }
});

test('ordinary text and approved invite links are not taken for bare invites', () => {
  const untouched = [
    '我在 discord 上',
    'discord',
    'discord.gg',
    'discord.gg/',
    'discord.gg/ 是邀請網域',
    'discord.com',
    'discord.com/channels/123/456',
    'discord.com/developers/docs',
    'discord.com/invite',
    'discord.com/invite/',
    'discordgg/abc',
    'discord_gg/abc',
    'discord.gg abc',
    'discord．gg/abc',
    'mydiscord.com/invite',
    'https://discord.gg/TqkCx9kYmk',
    '<https://discord.gg/TqkCx9kYmk>',
    '[伺服器](https://discord.gg/TqkCx9kYmk)',
    '看 https://discord.gg/TqkCx9kYmk！',
  ];
  for (const input of untouched) {
    assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, input);
  }
  assert.deepEqual(rewriteLinks('discord.gg/abc', { approve: wide.approve }), { text: 'discord.gg/abc', rewritten: false });
});

test('an approved link followed by more link text is judged together with it', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const B = BLOCKED_LINK_REPLACEMENT;
  const cases = [
    // Discord keeps a link going up to the next space, so these would carry the approval along.
    [`${invite}中discord.gg/evil`, `${B}中${B}`],
    [`${RELEASES}|/../../../attacker/repo`, `${B}|/../../../attacker/repo`],
    [`${invite}^discord.gg/evil`, `${B}^${B}`],
    // Zero-width characters are removed before the link is judged; they do not end it.
    [`${invite}\u200bdiscord.gg/evil`, `${B}\u200b${B}`],
    [`${invite}\u200c\u200d\u2060discord.gg/evil`, `${B}\u200c\u200d\u2060${B}`],
    // A link that ends at Chinese punctuation is kept, and what follows is still checked.
    [`${invite}」discord.gg/evil`, `${invite}」${B}`],
    [`${RELEASES}，/../../attacker/repo`, `${B}，/../../attacker/repo`],
    [`(${RELEASES})/../../attacker/repo`, `(${B})/../../attacker/repo`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
  // The chat output policy refuses the same continuation; it leaves bare invites to the egress scope.
  assert.deepEqual(chatRewrite(`${RELEASES}|/../../../attacker/repo`),
    { text: `${B}|/../../../attacker/repo`, rewritten: true });
  assert.deepEqual(chatRewrite(`${invite}中discord.gg/evil`), { text: `${B}中discord.gg/evil`, rewritten: true });
  // A continuation that still resolves to an approved page is kept in its normalized form.
  assert.deepEqual(wideRewrite(`${RELEASES}/tag/v1.1.2|/../../../releases 好`), { text: `${RELEASES} 好`, rewritten: false });
});

test('an approved link still ends at spaces, line breaks, quotes and Chinese or full-width punctuation', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  for (const after of ['', '，好', '，問題/建議', '。', '）', '」', '！', '？', '：資料', '、', '；', '…', '\n下一行', ' 空白', '\t',
    ')', '"', '\u200b', '\u3000全形空白']) {
    for (const input of [`看 ${invite}${after}`, `看 ${RELEASES}${after}`]) {
      assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
      assert.deepEqual(chatRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
    }
  }
  for (const input of [`(${invite})`, `<${invite}>`, `"${invite}"`, `[伺服器](${invite})，歡迎`, `<${RELEASES}>。`]) {
    assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, input);
  }
});

test('an approved link in inline code or a spoiler ends at the backtick or bar, and what follows is still checked', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const B = BLOCKED_LINK_REPLACEMENT;
  for (const link of [invite, RELEASES, `${RELEASES}/tag/${APPROVED_TAG}`]) {
    for (const input of [`\`${link}\``, `||${link}||`, `看 \`${link}\` 和 ||${link}||。`, `\`\`\`\n${link}\n\`\`\``]) {
      assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
      assert.deepEqual(chatRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
    }
  }
  const cases = [
    // A bare invite after the end is still replaced by the later step.
    [`${invite}\`discord.gg/evil`, `${invite}\`${B}`],
    [`${invite}|discord.gg/evil`, `${invite}|${B}`],
    [`||${invite}||discord.gg/evil||`, `||${invite}||${B}||`],
    // A dot segment after the end still climbs out of the approved path, so the link is judged whole.
    [`${RELEASES}|/../../../attacker/repo`, `${B}|/../../../attacker/repo`],
    [`\`${RELEASES}\`/../../attacker/repo`, `\`${B}\`/../../attacker/repo`],
    [`||${RELEASES}||\\..\\..\\attacker`, `||${B}||\\..\\..\\attacker`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
});

test('an approved link that ends normally is still judged whole when an encoded separator follows', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const B = BLOCKED_LINK_REPLACEMENT;
  const cases = [
    [`${invite})%2f%2e%2e%2fevil`, `${B})%2f%2e%2e%2fevil`],
    [`${RELEASES}，%2F..%2Fattacker%2Frepo`, `${B}，%2F..%2Fattacker%2Frepo`],
    [`||${invite}||%5c..%5cevil`, `||${B}||%5c..%5cevil`],
    [`\`${RELEASES}\`%3f%40evil.example`, `\`${B}\`%3f%40evil.example`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    assert.deepEqual(chatRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
});

test('an approved link that ends normally is still judged whole when an encoded percent sign follows', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const B = BLOCKED_LINK_REPLACEMENT;
  // %25 is an encoded "%": decoded once more, %252e%252e becomes a dot segment.
  const cases = [
    [`${RELEASES}\`/%252e%252e/%252e%252e/evil`, `${B}\`/%252e%252e/%252e%252e/evil`],
    [`||${RELEASES}||%252f..%252fevil`, `||${B}||%252f..%252fevil`],
    [`${invite}）/%252E%252E/evil`, `${B}）/%252E%252E/evil`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    assert.deepEqual(chatRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
  for (const link of [invite, RELEASES]) {
    for (const input of [`\`${link}\``, `||${link}||`]) {
      assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
      assert.deepEqual(chatRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
    }
  }
});

test('an approved link given without a path keeps its host when an ideographic full stop follows', () => {
  const status = 'https://xiaoji-public-status.xichengyu810067.workers.dev';
  const host = new URL(status).hostname;
  // Written as is, the full stop would continue the host name: browsers map it to ".".
  assert.equal(new URL(`${status}。evil.com`).hostname, `${host}.evil.com`);
  // The kept link is the normalized one, whose "/" ends the host before the full stop.
  for (const after of ['。evil.com', '|.evil.com', '`.evil.com']) {
    for (const rewrite of [wideRewrite, chatRewrite]) {
      const { text, rewritten } = rewrite(`${status}${after}`);
      assert.deepEqual({ text, rewritten }, { text: `${status}/${after}`, rewritten: false }, after);
      assert.equal(new URL(text).hostname, host, after);
    }
  }
});

test('an approved link that ends normally is still judged whole when a dot segment follows', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const B = BLOCKED_LINK_REPLACEMENT;
  const cases = [
    [`${invite}」/%2e%2e/evil`, `${B}」/%2e%2e/evil`],
    [`(${invite})/%2E%2E/evil`, `(${B})/%2E%2E/evil`],
    [`${RELEASES}，\\..\\attacker`, `${B}，\\..\\attacker`],
    [`<${RELEASES}>\\.\\..\\attacker`, `<${B}>\\.\\..\\attacker`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    assert.deepEqual(chatRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
});

test('gift links written without a scheme are replaced in the stable scope like bare invites', () => {
  for (const [input, expected] of [
    ['discord.gift/abc123', BLOCKED_LINK_REPLACEMENT],
    ['領取 discord.gift/Abc-123_x 吧', `領取 ${BLOCKED_LINK_REPLACEMENT} 吧`],
    ['DISCORD.GIFT/abc', BLOCKED_LINK_REPLACEMENT],
  ]) {
    assert.deepEqual(wideRewrite(input), { text: expected, rewritten: true }, input);
    assert.deepEqual(chatRewrite(input), { text: input, rewritten: false }, input);
  }
  for (const input of ['discord.gift', 'discord.gift/', 'discord.gifts/abc']) {
    assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, input);
  }
});

test('the stable egress scope catches a URL pasted after a letter and an IPv6 literal', () => {
  assert.deepEqual(wideRewrite('xhttps://evil.example/'), { text: `x${BLOCKED_LINK_REPLACEMENT}`, rewritten: true });
  assert.deepEqual(wideRewrite('https://[::1]/'), { text: BLOCKED_LINK_REPLACEMENT, rewritten: true });
});

// ---------------------------------------------------------------------------------------------
// Names written without a scheme (the bareDomains option)
// ---------------------------------------------------------------------------------------------

const B = BLOCKED_LINK_REPLACEMENT;
// U+0430 CYRILLIC SMALL LETTER A: it looks like the Latin "a".
const CYRILLIC_A = '\u{430}';
const ZERO_WIDTH_SPACE = '\u{200b}';
const fullWidth = (text) => text.replace(/[a-z]/gu, (letter) => String.fromCodePoint(letter.codePointAt(0) + 0xfee0));
// The endings that are also ordinary words, property or file names and surnames: short English words, then
// name app dev io one pro zip mov cc wang hu. A plain "word.ending" with one of them is text.
const AMBIGUOUS_ENDINGS = Object.freeze([
  'in', 'is', 'it', 'no', 'be', 'me', 'my', 'to', 'at', 'us', 'am', 'id', 'la', 'st',
  'name', 'app', 'dev', 'io', 'one', 'pro', 'zip', 'mov', 'cc', 'wang', 'hu',
]);

// [what is written, what the egress scope makes of it]: a name that is a link goes, with its port, path,
// query and fragment, and what stands around it stays.
const NAMES_THAT_ARE_LINKS = Object.freeze([
  ['free-nitro.com/claim', B],
  ['bit.ly/abc', B],
  ['EVIL.COM', B],
  ['evil-site.xyz', B],
  ['paypa1-secure.top/login?x=1', B],
  ['請看example.com的說明', `請看${B}的說明`],
  ['example.com.tw', B],
  ['xn--80ak6aa92e.com', B],
  [`${CYRILLIC_A}pple.com`, B],
  ['discord.gg/abc', B],
  ['免費領取 nitro-gift.xyz。快來！', `免費領取 ${B}。快來！`],
  ['看這個：evil.com，不要點', `看這個：${B}，不要點`],
  ['(evil.com)', `(${B})`],
  ['（evil.com）', `（${B}）`],
  ['**evil.com**', `**${B}**`],
  ['`evil.com`', `\`${B}\``],
  ['||evil.com||', `||${B}||`],
  ['~~evil.com~~', `~~${B}~~`],
  ['_evil.com_', `_${B}_`],
  ['"evil.com"', `"${B}"`],
  ['<evil.com>', `<${B}>`],
  ['[點我](evil.com)', `[點我](${B})`],
  ['第一行\nevil.com\n第三行', `第一行\n${B}\n第三行`],
  ['evil.com evil.net', `${B} ${B}`],
  ['evil.com,evil.net', `${B},${B}`],
  ['evil.com/a。evil.net/b！', `${B}。${B}！`],
  ['Visit EVIL.com/Claim now!', `Visit ${B} now!`],
  ['evil.com.', `${B}.`],
  ['evil.com!?', `${B}!?`],
  ['evil.com:8080', B],
  ['evil.com:8080/path?q=1#frag', B],
  ['sub.evil.co.uk/a/b.html', B],
  ['evil.com/path/(x)', `${B}(x)`],
  // the letters s and k are path characters like any other (a case-folding trap of negated classes)
  ['evil.com/skate/kiosk?s=k#sk', B],
  // letters of Chinese, Japanese or Korean in front of the ending: a link with a port, path, query or fragment
  ['領獎中心.com/x', B],
  ['領獎.com:8080', B],
  ['免費領取.xyz?x=1', B],
  ['請看領獎中心.com/abc，謝謝', `${B}，謝謝`],
  ['領獎center.com', `領獎${B}`],
  [fullWidth('evil') + '.' + fullWidth('com'), B],
  [`evil${ZERO_WIDTH_SPACE}.com`, B],
  [`evil.${ZERO_WIDTH_SPACE}com`, B],
  ['evil.com.me', `${B}.me`],
  ['amazon.co.in', `${B}.in`],
  ['t.me/channel', B],
  ['win10.me', B],
  ['yesterday.no', B],
  ['steam-gift.to', B],
  ['ok.me/claim', B],
  ['ok.me:8080', B],
  ['steam-gift.zip', B],
  // an ending that is also a property or file name still counts with a hyphen, a path or a long name
  ['nitro-gift.app', B],
  ['free-nitro.io/claim', B],
  ['claimyourprize.dev', B],
  ['mr-wang-login.wang', B],
  ['evil.app/x', B],
  ['free-nitro.name', B],
  ['nitro_gift.pro', B],
  ['evil.cc:8080', B],
  ['discord-gift.one', B],
  ['video-share.mov', B],
  ['szabo-gift.hu', B],
  ['discord.com/channels/1/2/3', B],
  ['user@evil.com/claim', `user@${B}`],
  ['a/evil.com/claim', `a/${B}`],
  ['..evil.com', `..${B}`],
  ['-evil.com', `-${B}`],
  ['a_b.evil.com', B],
  ['evil.com-', `${B}-`],
  ['1.2?evil.com/x', `1.2?${B}`],
  ['evil.com的說明.謝謝', `${B}的說明.謝謝`],
  // an unapproved page of the official repository: a pre-release is refused in both scopes
  ['github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.2.0-beta.1', B],
  ['GitHub.com', B],
  // a name with a path right after "https://" that the parser refuses (a combining mark first, so the step for
  // schemes leaves the run, and no client drops the mark): the name goes, and the scheme in front of it goes
  // with it
  ['https://\u{301}evil.com/x', B],
]);

// Written like this, nothing is a link: versions, numbers, file names, e-mail addresses, sentences without a
// space after the full stop, and ordinary Chinese and English text.
const TEXT_THAT_IS_NOT_A_LINK = Object.freeze([
  'v1.1.2', 'v24.21.0', '3.14', '1,000.50', '12.5%', '0.5x', '2026-10-12', '2026.10.12', '2026-10-12T00:00:00.000Z',
  'e.g.', 'i.e.', 'U.S.A.', 'etc.', 'a.m.', 'Mr.Chen', 'a.b', 'a.b.c', 'foo.bar', 'foo.example', 'localhost',
  '192.168.0.1',
  'README.md', 'main.py', 'index.js', 'Node.js', 'app.config.ts', 'main.rs', 'lib.so', 'run.sh', 'util.pl',
  'data.json', 'notes.txt', 'photo.png', 'members.csv', 'index.html',
  'user@example.com', 'first.last@company.example', 'someone@example.com',
  '12:30', '1.5倍', '第3.5名', 'OK.Fine', 'ok.me', 'yes.no', 'again.it', 'this.is', 'what.in', 'go.to', 'me.at',
  'so.be.it',
  '我在 discord 上', 'discord', '一般中英夾雜 hello world 的句子。', '版本 1.1.2 已發布，請看 /work submit',
  'evil.com-based', 'evil.com2', 'evilcom', 'com.evil', '.com', 'evil.', 'evil..com',
  '@evil.com', '100%evil.com', 'docs/app.dev', 'src/main.cc',
  // property names, file names and surnames that end like a top-level domain
  'user.name', 'config.app', 'window.app.dev', 'std.io', 'os.name', 'main.cc', 'archive.zip', 'Mr.Wang', 'Dr.Hu',
  'self.id', 'item.type', 'node.dev', 'a.pro', 'x.one', 'clip.mov', 'console.log(user.name)', 'Ms.Wang 說 std.io 很好用',
  // a sentence of Chinese, Japanese or Korean whose full stop is typed as "." and runs into the next word
  '我今天很累.Today is bad', '謝謝.Life', '你好.World 今天天氣好', '今天好累.Work 太多', '我用.NET 寫的', '領獎中心.com',
  '免費領取.xyz', '小吉.me', '日本語.jp', '한국어.kr',
  // "https://" written about, with the text going on: no address follows it
  '（需包含 https://）', '網址要以 https://，不要用 http://', 'https://…', 'https://（網址）', 'https://。',
  `${RELEASES}/tag/v1.1.2`, 'https://discord.gg/TqkCx9kYmk', '<https://discord.gg/TqkCx9kYmk>',
  '[伺服器](https://discord.gg/TqkCx9kYmk)', 'https://data.gov.tw/dataset/102011',
  'https://opendata.cwa.gov.tw/dist/opendata-swagger.html', 'https://xiaoji-public-status.xichengyu810067.workers.dev/',
]);

test('the endings that make a name a link are the listed ones, and file extensions are not among them', () => {
  const general = ('com net org info biz xyz top site online live click link shop store club vip life world today ' +
    'tech app dev page cloud fun space website work rest support help pro name mobi asia icu buzz monster quest one ' +
    'sbs cyou cfd gift zip mov bond uno wang win bid loan men date download stream racing review party trade ' +
    'cricket science accountant faith').split(' ');
  const countries = ('io gg me ly to co cc tv ws pw tk ml ga cf gq in us uk de fr it es nl be se no dk fi cz ru ua ' +
    'cn hk tw jp kr sg my th vn id ph au nz ca br mx ar cl za ae sa il tr ir pk bd ng ke eg ch at ie pt gr hu ro ' +
    'bg by kz lt lv ee is ai fm am la st vc ac im gl cx').split(' ');
  assert.deepEqual([...BARE_DOMAIN_TLDS].sort(), [...general, ...countries].sort());
  assert.equal(new Set(BARE_DOMAIN_TLDS).size, BARE_DOMAIN_TLDS.length);
  assert.ok(Object.isFrozen(BARE_DOMAIN_TLDS));
  for (const extension of ['md', 'py', 'sh', 'rs', 'so', 'pl', 'ps', 'js', 'ts', 'cs', 'json', 'txt', 'html', 'png', 'csv']) {
    assert.equal(BARE_DOMAIN_TLDS.includes(extension), false, extension);
    assert.deepEqual(egressRewrite(`file.${extension}`), { text: `file.${extension}`, rewritten: false }, extension);
  }
  // The ambiguous endings are listed in the order of the module, which this pins as well: the 14 short
  // English words, then name app dev io one pro zip mov cc wang hu. Each of them is also a link ending.
  assert.deepEqual([...AMBIGUOUS_BARE_DOMAIN_TLDS], [...AMBIGUOUS_ENDINGS]);
  assert.ok(Object.isFrozen(AMBIGUOUS_BARE_DOMAIN_TLDS));
  assert.equal(new Set(AMBIGUOUS_BARE_DOMAIN_TLDS).size, AMBIGUOUS_BARE_DOMAIN_TLDS.length);
  for (const ending of AMBIGUOUS_BARE_DOMAIN_TLDS) assert.ok(BARE_DOMAIN_TLDS.includes(ending), ending);
  // The endings that stay unambiguous, whatever stands in front of them: the ones scam names use most.
  for (const ending of ['com', 'net', 'org', 'xyz', 'top', 'site', 'online', 'live', 'click', 'link', 'shop', 'store',
    'club', 'vip', 'life', 'world', 'today', 'tech', 'page', 'cloud', 'fun', 'space', 'ly', 'co', 'gg', 'tv', 'tk']) {
    assert.equal(AMBIGUOUS_BARE_DOMAIN_TLDS.includes(ending), false, ending);
  }
  for (const ending of BARE_DOMAIN_TLDS) {
    // An ambiguous ending needs more than "abc." in front (see the next tests).
    const ambiguous = AMBIGUOUS_ENDINGS.includes(ending);
    assert.equal(egressRewrite(`abc.${ending}`).text, ambiguous ? `abc.${ending}` : B, ending);
    assert.equal(egressRewrite(`ABC.${ending.toUpperCase()}`).text,
      ambiguous ? `ABC.${ending.toUpperCase()}` : B, ending);
    // With a path or a hyphen in the name, every ending counts.
    assert.equal(egressRewrite(`abc.${ending}/x`).text, B, ending);
    assert.equal(egressRewrite(`free-abc.${ending}`).text, B, ending);
  }
});

test('a name written without a scheme is replaced with its port, path, query and fragment; the text around it stays', () => {
  assert.ok(NAMES_THAT_ARE_LINKS.length >= 40);
  for (const [input, expected] of NAMES_THAT_ARE_LINKS) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    // The chat output policy asks for names without the bare invite step: an invite is a name with a path.
    assert.equal(chatDomainRewrite(input).text, expected, JSON.stringify(input));
  }
});

test('text that only looks like a name is left alone, and so is an approved link', () => {
  assert.ok(TEXT_THAT_IS_NOT_A_LINK.length >= 40);
  for (const input of TEXT_THAT_IS_NOT_A_LINK) {
    assert.deepEqual(egressRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
  }
});

test('the corpus of the chat output policy holds names written without a scheme, both kinds', () => {
  // The rows of test/fixtures/linkApprovalCorpus.js that carry no scheme: removed ones and kept ones.
  const names = LINK_CASES.filter(([input]) => !/https?:\/\//iu.test(input) && /[\p{L}\p{N}]\.[\p{L}]/u.test(input));
  assert.ok(names.filter(([, , , sanitized]) => sanitized.includes(B)).length >= 30);
  assert.ok(names.filter(([input, , , sanitized]) => sanitized === input).length >= 15);
});

test('without bareDomains no name is touched, whatever the other options are', () => {
  for (const [input] of NAMES_THAT_ARE_LINKS) {
    for (const rewrite of [
      (text) => rewriteLinks(text, { approve: wide.approve }),
      (text) => rewriteLinks(text, { approve: wide.approve, maskedLink: 'label-and-marker' }),
      (text) => rewriteLinks(text, { approve: wide.approve, bareDomains: false }),
      chatRewrite,
    ]) {
      assert.deepEqual(rewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
    }
    // The bare invite step alone knows invites and nothing else.
    const isInvite = /^discord\.gg\/|^discord\.com\/invite\//iu.test(input);
    assert.equal(wideRewrite(input).text, isInvite ? B : input, JSON.stringify(input));
  }
});

test('an approved page written without a scheme is kept as written, and only as written', () => {
  const releases = `github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`;
  const kept = [
    releases, `${releases}/`, `${releases}/tag/${APPROVED_TAG}`, `${releases}/tag/v1.1.2`,
    'data.gov.tw/dataset/102011', 'opendata.cwa.gov.tw/dist/opendata-swagger.html',
    'xiaoji-public-status.xichengyu810067.workers.dev', 'GitHub.com/' + `${OFFICIAL_RELEASE_REPOSITORY}/releases`,
    `詳見 ${releases}，謝謝`, `(${releases})`, `請看 \`${releases}\``, `<${releases}>`, `${releases}。`, `${releases}\n下一行`,
  ];
  for (const input of kept) assert.deepEqual(egressRewrite(input), { text: input, rewritten: false }, input);
  // The chat policy approves one release only.
  assert.deepEqual(chatDomainRewrite(`${releases}/tag/${APPROVED_TAG}`),
    { text: `${releases}/tag/${APPROVED_TAG}`, rewritten: false });
  assert.deepEqual(chatDomainRewrite(`${releases}/tag/v1.1.2`), { text: B, rewritten: true });
  const refused = [
    [`${releases}?x=1`, B],
    [`${releases}#notes`, B],
    [`${releases}/../../evil/repo`, B],
    [`${releases}%2F..%2Fevil`, B],
    [`${releases}/tag/v1.1.2/assets`, B],
    [`${releases}中文`, `${B}中文`],
    [`${releases}|/../../../attacker/repo`, `${B}|/../../../attacker/repo`],
    [`${releases}]`, `${B}]`],
    // Something in front of the name: a link would then start earlier, at another host.
    [`領獎${releases}`, `領獎${B}`],
    [`-${releases}`, `-${B}`],
    [`${CYRILLIC_A}${releases}`, B],
    [`x${releases}`, B],
    [`github.com.evil.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`, B],
    [`github.com:8443/${OFFICIAL_RELEASE_REPOSITORY}/releases`, B],
    [`github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases@evil.com`, B],
    ['github.com', B],
  ];
  for (const [input, expected] of refused) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, input);
  }
});

test('an https:// link that is kept is not cut in two by the step for names', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const cases = [
    [`看 ${invite} 和 evil.com 與 https://data.gov.tw/dataset/102011，還有 bit.ly/x`,
      `看 ${invite} 和 ${B} 與 https://data.gov.tw/dataset/102011，還有 ${B}`],
    [`[伺服器](${invite}) evil.com`, `[伺服器](${invite}) ${B}`],
    [`<${invite}>evil.com`, `<${invite}>${B}`],
    [`||${invite}|| 與 \`${RELEASES}\``, `||${invite}|| 與 \`${RELEASES}\``],
    [`${RELEASES}/tag/v1.1.2 和 data.gov.tw/dataset/102011`, `${RELEASES}/tag/v1.1.2 和 data.gov.tw/dataset/102011`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: expected !== input }, JSON.stringify(input));
  }
});

test('the endings that are also words, property or file names count only with a path, a port, a query or a name that is no word', () => {
  assert.equal(AMBIGUOUS_ENDINGS.every((ending) => BARE_DOMAIN_TLDS.includes(ending)), true);
  for (const ending of AMBIGUOUS_ENDINGS) {
    for (const input of [
      `word.${ending}`, `Word.${ending.toUpperCase()}`, `word.${ending}.`, `word.${ending}?`, `word.${ending}!`,
      `word.${ending},`, `abcdefg.${ending}`, `a.b.${ending}`, `word.${ending}-`,
    ]) {
      assert.deepEqual(egressRewrite(input), { text: input, rewritten: false }, input);
    }
    for (const input of [
      `word.${ending}/`, `word.${ending}/x`, `word.${ending}:80`, `word.${ending}?x=1`, `word.${ending}#top`,
      `my-word.${ending}`, `my_word.${ending}`, `word2.${ending}`, `abcdefgh.${ending}`, `小吉.${ending}/x`,
      `a.my-word.${ending}`,
    ]) {
      assert.deepEqual(egressRewrite(input), { text: B, rewritten: true }, input);
    }
  }
  // Every other listed ending counts whatever stands in front of it.
  for (const input of ['ok.com', 'yes.xyz', 'again.top', 'this.de', 'what.fr', 'go.co', 'me.ai']) {
    assert.deepEqual(egressRewrite(input), { text: B, rewritten: true }, input);
  }
});

test('property names, file names and surnames are left alone, and the same endings still make scam names links', () => {
  const alone = ['user.name', 'config.app', 'window.app.dev', 'std.io', 'os.name', 'main.cc', 'archive.zip', 'Mr.Wang',
    'Dr.Hu', 'console.log(user.name)', 'import std.io 來讀檔', '請看 config.app 的設定', 'Dr.Hu 與 Mr.Wang 都來了'];
  for (const input of alone) assert.deepEqual(egressRewrite(input), { text: input, rewritten: false }, input);
  const links = [
    ['nitro-gift.app', B], ['free-nitro.io/claim', B], ['claimyourprize.dev', B], ['steam-gift.zip', B],
    ['mr-wang-login.wang', B], ['evil.app/x', B], ['請點 nitro-gift.app 領獎', `請點 ${B} 領獎`],
    ['config.app/login', B], ['user.name:8080', B], ['std.io?x=1', B], ['archive.zip#top', B],
  ];
  for (const [input, expected] of links) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, input);
  }
});

test('a name begins where its word begins: e-mail, path and version prefixes are not cut', () => {
  const cases = [
    ['user@evil.com', 'user@evil.com'],
    ['user.smith@evil.com', 'user.smith@evil.com'],
    ['a/evil.com', 'a/evil.com'],
    ['%evil.com', '%evil.com'],
    ['a/evil.com/x', `a/${B}`],
    ['a/evil.com:80', `a/${B}`],
    ['@evil.com/x', `@${B}`],
    ['v1.2.com', B],
    ['x1.evil.com', B],
    ['a-evil.com', B],
    ['_evil.com', `_${B}`],
    ['evil.com_', `${B}_`],
    ['evil.com_x', `${B}_x`],
    ['evil.com2', 'evil.com2'],
    ['evil.comx', 'evil.comx'],
    ['evil.com-x', 'evil.com-x'],
    ['evil.com--x', 'evil.com--x'],
    ['evil.com的說明', `${B}的說明`],
    ['evil.com.Then', `${B}.Then`],
    ['evil.com.tw.', `${B}.`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: expected !== input }, input);
  }
});

test('Chinese text runs into a name from both sides without becoming part of it', () => {
  const cases = [
    ['請看example.com', `請看${B}`],
    ['請看example.com/abc的說明', `請看${B}的說明`],
    ['加入discord.gg/abc123吧', `加入${B}吧`],
    ['網址是example.com。謝謝', `網址是${B}。謝謝`],
    ['「evil.com」', `「${B}」`],
    ['【evil.com】', `【${B}】`],
    ['請看領獎中心.com/x', B],
    ['日本語example.jp/ページ', `日本語${B}ページ`],
    ['한국어example.kr', `한국어${B}`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, input);
  }
  // Two names with nothing but a Chinese word between them are one run of letters: both go.
  const both = egressRewrite('看evil.com和evil.net');
  assert.doesNotMatch(both.text, /evil/u);
  assert.equal(both.rewritten, true);
});

test('a name with Chinese, Japanese or Korean letters in front of its ending is a link only with a port, path, query or fragment', () => {
  // Such text has no spaces, and a full stop typed as "." runs the next word into it: a sentence, not a name.
  const sentences = [
    '我今天很累.Today is bad', '謝謝.Life', '好累.Work 太多', '你好.World', '今天.Live 開始', '不錯.Shop 開張',
    '小吉.Online 上線', '이름.Today', 'ありがとう.Life', '我用.NET 寫的', '「領獎.com」', '請看領獎中心.com',
    '領獎中心.com', '免費領取.xyz', '日本語.jp', '한국어.kr', '小吉.me', '小吉.tw',
  ];
  for (const input of sentences) assert.deepEqual(egressRewrite(input), { text: input, rewritten: false }, input);
  // The same with a port, a path, a query or a fragment is an address, whatever the letter case.
  const addresses = [
    ['領獎.com/x', B], ['領獎中心.com:8080', B], ['免費領取.xyz?x=1', B], ['謝謝.Life/', B], ['我今天很累.Today#top', B],
    ['謝謝.LIFE/x', B], ['小吉.ME/x', B], ['請看領獎.com/x的說明', `${B}的說明`], ['sub.領獎.com/x', B],
  ];
  for (const [input, expected] of addresses) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, input);
  }
  // Latin letters in the label in front of the ending make a name of their own, with or without Chinese text
  // next to it or in a label before it (a subdomain of Chinese letters is a host the writer chose).
  const names = [
    ['請看example.com', `請看${B}`], ['領獎center.com', `領獎${B}`], ['日本語example.jp', `日本語${B}`], ['Evil.Com', B],
    ['EVIL.COM', B], ['evil.com 謝謝', `${B} 謝謝`], ['謝謝 evil.life', `謝謝 ${B}`], ['謝謝.evil.com', B],
    ['免費領取.evil.com', B], ['請看這個網站.evil.xyz', B], ['evil領獎.com', B], ['領獎evil.life', `領獎${B}`],
  ];
  for (const [input, expected] of names) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, input);
  }
});

test('a name cannot be hidden with punctuation, Markdown, invisible characters or look-alike letters', () => {
  const hidden = [
    ['_.evil.com', `_.${B}`],
    ['-.evil.com', `-.${B}`],
    ['..evil.com', `..${B}`],
    ['a-.evil.com', B],
    ['a._evil.com', B],
    ['__evil.com__', `__${B}__`],
    ['*evil.com*', `*${B}*`],
    [`ev${ZERO_WIDTH_SPACE}il.com`, B],
    [`evil.com${ZERO_WIDTH_SPACE}/claim`, B],
    [`${ZERO_WIDTH_SPACE}evil.com`, `${ZERO_WIDTH_SPACE}${B}`],
    [`evil.c${ZERO_WIDTH_SPACE}om`, B],
    [fullWidth('evil') + '.com', B],
    ['evil.' + fullWidth('com'), B],
    [`e${CYRILLIC_A}il.com`, B],
    ['http://例子.測試/x', B],
    ['1.2?evil.com', `1.2?${B}`],
    ['3.5#evil.com', `3.5#${B}`],
    ['x/1.2/evil.com/y', `x/1.2/${B}`],
  ];
  for (const [input, expected] of hidden) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: expected !== input }, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------------------------
// Addresses with a scheme whose first character is not ASCII: a symbol, an emoji, a look-alike letter
// ---------------------------------------------------------------------------------------------

const GIFT = '\u{1F381}';
const ZWJ = '\u{200d}';
// [what is written, what the egress scope makes of it]. Discord takes everything after "https://" up to the
// next white space for the link, and a browser maps look-alike letters back to ASCII ones, so each of these
// is a link to a host the writer chose. None of them is approved, whatever it maps to.
const SCHEME_ADDRESSES = Object.freeze([
  // the host starts with an emoji or a symbol
  [`https://${GIFT}.ws/nitro`, B],
  [`https://${GIFT}${GIFT}.to/gift`, B],
  [`https://${GIFT}.${GIFT}.ws`, B],
  ['https://\u{2764}\u{fe0f}.ws/claim', B],
  ['https://\u{1F1FA}\u{1F1F8}.ws/x', B],
  ['https://\u{2605}領獎.台灣/x', B],
  ['https://\u{2122}.com/x', B],
  ['https://\u{33c4}.com/x', B],
  // look-alike letters: circled, squared, full-width
  ['https://\u{24d4}\u{24e5}\u{24d8}\u{24db}.com/claim', B],
  ['https://\u{24d4}\u{24e5}\u{24d8}\u{24db}.\u{24d2}\u{24de}\u{24dc}', B],
  ['https://\u{24b6}\u{24c5}\u{24c5}\u{24c1}\u{24ba}.com/login', B],
  ['https://\u{1f134}\u{1f145}\u{1f138}\u{1f13b}.com/x', B],
  ['https://\u{24d5}\u{24e1}\u{24d4}\u{24d4}-nitro.com/claim', B],
  ['https://\u{ff45}\u{ff56}\u{ff49}\u{ff4c}.com/x', B],
  // a letter of another script, and an address that has always been read
  [`https://${CYRILLIC_A}pple.com/login`, B],
  ['https://例子.com/x', B],
  ['https://領獎.台灣', B],
  ['http://例子.測試/x', B],
  // an invisible character first (a combining mark is refused by the parser: see PARSER_TEXT)
  ['https://\u{200b}evil.com/x', B],
  ['https://\u{feff}evil.com/x', B],
  // a punctuation mark first, with a host after it
  ['https://。evil.com', B],
  ['https://·evil.zone/x', B],
  // the dot of the host is an ideographic full stop, which a browser reads as ".": a host a browser opens
  ['https://\u{30fb}領獎。jp/x', B],
  ['https://「evil。com/x', B],
  ['https://\u{b7}evil。com', B],
  ['https://\u{2014}evil。com/x', B],
  ['https://「領獎。台灣', B],
  ['https://（evil。com/x', B],
  ['https://，a。evil。com', B],
  ['https://「evil。ｃｏｍ', B],
  ['https://「evil。zone', B],
  ['https://「領獎。香港', B],
  ['https://「領獎。한국', B],
  ['https://「領獎。網站/x', B],
  // an encoded dot, and a host of numbers written with full-width digits
  [`https://${GIFT}%2ews/x`, B],
  [`https://${GIFT}%2Ews/x`, B],
  ['https://\u{ff11}\u{ff12}\u{ff17}.0.0.1/x', B],
  // a number alone (a decimal address of the network, 2130706433 is 127.0.0.1) has no dot in it
  ['https://\u{ff12}\u{ff11}\u{ff13}0706433:8080/x', B],
  // a number the parser reads as an address, however short: 1234 is 0.0.4.210
  ['https://\u{ff11}\u{ff12}\u{ff13}\u{ff14}', B],
  // the closing bracket that goes with the opening one the run began with is a part of the host
  ['https://「evil」.com/x', B],
  ['https://（evil）.com', B],
  // an approved page spelled with look-alike characters is no approved page
  [`https://\u{ff47}\u{ff49}\u{ff54}\u{ff48}\u{ff55}\u{ff42}.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`, B],
  [`https://\u{24d6}\u{24d8}\u{24e3}\u{24d7}\u{24e4}\u{24d1}.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`, B],
  ['https://\u{ff44}\u{ff49}\u{ff53}\u{ff43}\u{ff4f}\u{ff52}\u{ff44}.gg/TqkCx9kYmk', B],
  // what stands around the address stays: spaces, brackets, quotes, Markdown and sentence punctuation
  [`領獎 https://${GIFT}.ws/nitro 快`, `領獎 ${B} 快`],
  [`請看https://${GIFT}.ws/nitro，謝謝`, `請看${B}，謝謝`],
  [`https://${GIFT}.ws/nitro。快來`, `${B}。快來`],
  [`(https://${GIFT}.ws/nitro)`, `(${B})`],
  [`「https://${GIFT}.ws/nitro」`, `「${B}」`],
  [`||https://${GIFT}.ws/nitro||`, `||${B}||`],
  [`**https://${GIFT}.ws/nitro**`, `**${B}**`],
  [`\`https://${GIFT}.ws/nitro\``, `\`${B}\``],
  [`"https://${GIFT}.ws/nitro"`, `"${B}"`],
  [`https://${GIFT}.ws/nitro.`, `${B}.`],
  [`https://${GIFT}.ws/nitro?x=1&y=2#top`, B],
  [`https://${GIFT}.ws:8080/x`, B],
  [`https://${GIFT}.ws/nitro\nhttps://${GIFT}.to/x`, `${B}\n${B}`],
  [`https://${GIFT}.ws/nitro https://${GIFT}.to/x`, `${B} ${B}`],
  // the URL after the emoji goes, and "https://" + emoji is no address: it has no dot between two labels
  [`https://${GIFT}https://evil.example`, `https://${GIFT}${B}`],
  // text glued on without punctuation belongs to the address, as it does for Discord
  [`請看https://${GIFT}.ws/nitro的說明`, `請看${B}`],
  // wrapped forms
  [`<https://${GIFT}.ws/nitro>`, B],
  [`[點我](https://${GIFT}.ws/nitro)`, `點我 ${B}`],
  [`[https://${GIFT}.ws/nitro](https://${GIFT}.to/x)`, `${B} ${B}`],
  // the rows of test/fixtures/schemeAddressCases.js, which the egress guard and the AI reply tests read too:
  // each run is one the parser of a browser reads as a host (an IP address in any of its spellings, or a name
  // of two labels or more), whatever it is made of
  ...PARSER_ADDRESSES.map((address) => [address, B]),
]);

test('an https:// address whose first character is not ASCII is replaced whole, and what stands around it stays', () => {
  assert.ok(SCHEME_ADDRESSES.length >= 80);
  for (const [input, expected] of SCHEME_ADDRESSES) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    // This is the scheme step, not the step for names: no option is needed, and an approval that refuses
    // everything and one that approves a lot give the same answer.
    for (const approve of [wide.approve, chat.approve, () => null]) {
      assert.deepEqual(rewriteLinks(input, { approve, maskedLink: 'label-and-marker' }),
        { text: expected, rewritten: true }, JSON.stringify(input));
    }
    // The chat output policy differs only in the label of a masked link.
    if (!input.includes('](')) assert.equal(chatDomainRewrite(input).text, expected, JSON.stringify(input));
    // The chat output policy itself: the same text, reported like any URL.
    if (!input.includes('](') && !input.includes('\n')) {
      const events = [];
      const text = sanitizeUserFacingOutput(input, { context: { actorId: 'actor-a' }, emit: (code) => events.push(code) });
      assert.equal(text, expected, JSON.stringify(input));
      assert.deepEqual(events, ['AI_OUTPUT_URL_BLOCKED'], JSON.stringify(input));
    }
    // Rewritten once, it is final.
    assert.deepEqual(egressRewrite(expected), { text: expected, rewritten: false }, JSON.stringify(input));
  }
});

// Text that is written about "https://", with what goes on right after it, in Chinese, Japanese or Korean (which
// has no spaces). The parser of a browser finds no host in the run after "https://" up to the next space (no dot
// between two labels, a character it refuses, or a last label that is no ending), so nothing is an address. All
// of it comes through as it is written.
const TEXT_ABOUT_SCHEMES = Object.freeze([
  '網址要以https://開頭', '請輸入以https://開頭的網址', '支援 http://、https://等協定', '用https://的網址比較安全',
  'https://から始まるURL', 'https://로 시작하는 주소', '把 http://→https:// 改好', '格式是 https://＜你的網域＞/api',
  '網址要以https://開頭。', '網址要以https://開頭.', '網址要以https://開頭...',
  '網址要以https://開頭，請看清楚', '請改用https://（安全連線）', '網址必須以https://為開頭；否則無法開啟',
  '（需包含 https://）', '網址要以 https://，不要用 http://', 'https://（範例）', 'https://。', '請用https://。',
  'https://…', 'https://⋯', 'https://', 'https:// 空白後', 'https://\n換行', 'https://\u{3000}全形空白',
  '以「https://」開頭', '網址必須以 `https://` 開頭', '(例如 https://)',
  // "." and "。" with nothing after them, or a text of digits, are no host either: the parser reads a number
  // as the last label, and a name whose last label is a number is no name
  'https://開頭。', 'https://開頭。\n下一行', 'https://開頭。2026 年', 'https://開頭。3 個步驟',
  // a dot after the "/", "?" or "#" is the dot of a path, a query or a fragment, not of a host
  'https://開頭/index.html', 'https://開頭?x=a.b', 'https://開頭#a.b', 'https://例子/說明.md',
  // a number with a letter of the text behind it is no address of the network
  'https://１２３４５６７年', 'https://２０２６年度報告',
  // the rows of test/fixtures/schemeAddressCases.js (the sentences the reviewers wrote about "https://", and the
  // runs a parser refuses or reads as a single label)
  ...PARSER_TEXT.map(([text]) => text),
]);

test('an https:// followed by text, a punctuation mark or an ASCII character is no such address', () => {
  assert.ok(TEXT_ABOUT_SCHEMES.length >= 70);
  for (const input of TEXT_ABOUT_SCHEMES) {
    for (const rewrite of [egressRewrite, wideRewrite, chatDomainRewrite]) {
      assert.deepEqual(rewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
    }
    const events = [];
    const text = sanitizeUserFacingOutput(input, { context: { actorId: 'actor-a' }, emit: (code) => events.push(code) });
    assert.equal(text, input, JSON.stringify(input));
    assert.deepEqual(events, [], JSON.stringify(input));
  }
  // A dotted name in the text is a name of its own (a.com is a link, and the step for names takes it,
  // whatever stands in front of it). With a space in front of it, "https://" stays. Glued to "https://",
  // behind a bracket, a dot makes the run an address, because nothing tells 「https://（例如a.com）」 from
  // 「https://（x.evil.com」: a host that begins with a bracket is one a browser opens (a limit, pinned here).
  assert.deepEqual(egressRewrite('請用 https://（例如 a.com）'), { text: `請用 https://（例如 ${B}）`, rewritten: true });
  assert.deepEqual(egressRewrite('請用https://（例如a.com）'), { text: `請用${B}）`, rewritten: true });
  // An ASCII character after "https://" that the plain URL step does not read leaves the name step as it
  // was: the name goes, what stood before it stays.
  const ascii = [
    ['https://(evil.com)', `https://(${B})`],
    ['https://"evil.com"', `https://"${B}"`],
    ['https://|evil.com|', `https://|${B}|`],
    ['https:// evil.com', `https:// ${B}`],
  ];
  for (const [input, expected] of ascii) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
});

// What a run is made of is decided by the parser a browser opens it with. These are the facts about that
// parser (Node's URL, which follows the same standard) the rules of linkPolicy.js rest on: if a new version of
// Node changes one, this test says which, instead of a row of another test failing for no visible reason.
test('the parser facts the scheme step relies on', () => {
  const host = (run) => {
    try { return new URL(`https://${run}`).hostname; } catch { return null; }
  };
  // three characters are dots, and the other full stops and dot leaders are not
  for (const dot of ['.', '\u{3002}', '\u{ff0e}', '\u{ff61}']) assert.equal(host(`evil${dot}com`), 'evil.com', dot);
  for (const notDot of ['\u{2024}', '\u{fe52}', '\u{2488}', '\u{2025}']) assert.equal(host(`evil${notDot}com`), null, notDot);
  assert.equal(host('evil\u{ff65}com'), 'xn--evilcom-6b5f');
  // look-alike letters and digits are the ASCII ones; invisible characters are gone
  assert.equal(host('\u{24d4}\u{24e5}\u{24d8}\u{24db}.\u{24d2}\u{24de}\u{24dc}'), 'evil.com');
  assert.equal(host('\u{ff45}\u{ff56}\u{ff49}\u{ff4c}.com'), 'evil.com');
  assert.equal(host('ev\u{200b}i\u{ad}l\u{34f}.c\u{fe0f}om'), 'evil.com');
  // a number is an address in decimal, octal and hexadecimal, whatever it is written in; a name with a
  // number for its last label is no host at all
  for (const number of ['2130706433', '0x7f000001', '017700000001', '127.1', '\u{ff12}\u{ff11}\u{ff13}\u{ff10}\u{ff17}\u{ff10}\u{ff16}\u{ff14}\u{ff13}\u{ff13}',
    '\u{ff11}\u{ff12}\u{ff17}\u{3002}\u{ff10}\u{3002}\u{ff10}\u{3002}\u{ff11}']) {
    assert.equal(host(number), '127.0.0.1', number);
  }
  assert.equal(host('\u{ff11}\u{ff12}\u{ff13}\u{ff14}'), '0.0.4.210');
  assert.equal(host('\u{958b}\u{982d}.2026'), null);
  assert.equal(host('\u{300c}2130706433'), 'xn--2130706433-rk3i');
  // a mark of Chinese punctuation is part of a name for the parser, except the ones it refuses
  for (const mark of '，、；！「」『』（）《》“”‘’') assert.notEqual(host(`甲${mark}乙.com`), null, mark);
  for (const mark of '：？…') assert.equal(host(`甲${mark}乙.com`), null, mark);
  // a user may hold anything, a bracket opens an address of the sixth version, a backslash ends the host
  assert.equal(host('\u{300c}a@evil.com'), 'evil.com');
  assert.equal(host('\u{300c}a@[::1]'), '[::1]');
  assert.equal(host('\u{300c}evil\\.com'), 'xn--evil-4x3c');
  // what it refuses: a joiner with no script that needs one, a label that begins with a combining mark,
  // full-width brackets, a "%" that is no encoding
  assert.equal(host('\u{200d}evil.com'), null);
  assert.equal(host('\u{1F468}\u{200d}\u{1F469}.ws'), null);
  assert.equal(host('\u{301}evil.com'), null);
  assert.equal(host('\u{ff3b}::1\u{ff3d}'), null);
  assert.equal(host('開頭的比例是99.5%'), null);
});

test('a mark of Chinese punctuation ends the run behind at least one character of the host, and not in the host of a zone', () => {
  // The rule for a mark: cut there when at most one dot stands behind it (the mark would be in the label a
  // name is registered by, or in the ending, where no registry takes a mark of punctuation) and the mark
  // is no closing one that goes with the opening one the run began with. With more dots behind it the host
  // has a subdomain, and a zone may hold any label.
  const cases = [
    // [input, expected]
    ['https://甲，乙.com', 'https://甲，乙.com'],
    ['https://甲、乙.com', 'https://甲、乙.com'],
    ['https://甲「乙.com', 'https://甲「乙.com'],
    ['https://甲」乙.com', 'https://甲」乙.com'],
    ['https://甲（乙.com', 'https://甲（乙.com'],
    ['https://甲“乙.com', 'https://甲“乙.com'],
    ['https://甲，乙.a.com', B],
    ['https://甲、乙.a.com', B],
    ['https://甲「乙.a.com', B],
    ['https://甲”乙.a.com', B],
    // a mark the parser refuses cuts the run at any rate: the name behind it is what the step for names finds
    ['https://甲：乙.a.com', `https://甲：${B}`],
    ['https://甲？乙.a.com', `https://甲？${B}`],
    ['https://甲…乙.a.com', `https://甲…${B}`],
    // a leading mark is no cut, and neither is the closing one that goes with it
    ['https://「evil。com', B],
    ['https://，a。evil。com', B],
    ['https://「evil」.com', B],
    ['https://『evil』.com/x', B],
    ['https://“evil”.com', B],
    // a mark behind a host that is complete ends the run there, and the mark stays outside
    ['https://甲.com，請看', `${B}，請看`],
    ['https://甲.com」請看', `${B}」請看`],
    ['https://甲.com（備註）', `${B}（備註）`],
    // the user of the address may hold a mark: the host is what stands behind the last "@"
    ['https://甲「乙@evil.com', B],
    ['https://甲，乙@evil.com/x', B],
    // the sentences that are written about "https://" and hold a dotted word behind a mark
    ['要用https://開頭，版本v1.1.2以後都支援', '要用https://開頭，版本v1.1.2以後都支援'],
    ['請在設定裡填https://開頭的網址，存到config.json', '請在設定裡填https://開頭的網址，存到config.json'],
    ['以https://開頭，下午3.30開會', '以https://開頭，下午3.30開會'],
    ['https://後接「discord.gg」是邀請', `https://後接「${B}」是邀請`],
  ];
  for (const [input, expected] of cases) {
    const result = egressRewrite(input);
    assert.deepEqual(result, { text: expected, rewritten: expected !== input }, JSON.stringify(input));
    assert.deepEqual(egressRewrite(result.text), { text: result.text, rewritten: false }, JSON.stringify(input));
  }
});

test('the last label decides: ASCII, the name of a top-level domain or "xn--" as written is an ending, a sentence or a mix is none', () => {
  // The direction that is text: the label behind the dot is a sentence or a word of the language (any word of
  // Chinese, Japanese or Korean is no top-level domain), or mixes scripts or digits with letters.
  for (const input of ['要用https://開頭.不要用http', '要用https://開頭。不要用http', '網址以https://開頭．不用www',
    '網址以https://開頭｡不用www', 'https://開頭。123也可以', 'https://開頭.2以後都支援', 'https://開頭.v2版',
    '要用https://開頭。這是常識', 'https://開頭。記住了嗎', '請輸入以https://開頭的網址。請注意大小寫',
    '要用https://開頭。みんなでやる', 'https://開頭。公司名稱', 'https://開頭。台灣人', 'https://開頭。網站設定']) {
    assert.deepEqual(egressRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
  }
  // The direction that is an address: ASCII alone (letters, digits and hyphens, in any case), the name of a
  // top-level domain written in its own letters, and any label that is written as "xn--".
  for (const [input, expected] of [
    ['要用https://開頭.OK', `要用${B}`],
    ['要用https://開頭.ok', `要用${B}`],
    ['要用https://開頭。com', `要用${B}`],
    ['要用https://開頭.xn--p1ai', `要用${B}`],
    ['要用https://開頭.XN--P1AI', `要用${B}`],
    ['要用https://開頭.xn--rut30ppp6a97d', `要用${B}`],
    ['要用https://開頭。xn--rut30ppp6a97d:8443', `要用${B}`],
    ['要用https://開頭.co-op', `要用${B}`],
    ['要用https://開頭.рф', `要用${B}`],
    ['要用https://開頭.РФ', `要用${B}`],
    ['要用https://開頭.みんな', `要用${B}`],
    ['要用https://開頭。台灣', `要用${B}`],
    ['要用https://開頭。中國/x', `要用${B}`],
    ['要用https://開頭。香港', `要用${B}`],
    ['要用https://開頭。한국', `要用${B}`],
    ['要用https://開頭。ไทย', `要用${B}`],
    ['要用https://開頭。vermögensberater', `要用${B}`],
  ]) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
  }
});

test('the names of the top-level domains written in other letters are the endings: every one converts, and an address that ends in one goes', () => {
  assert.ok(IDN_TOP_LEVEL_DOMAINS.length >= 150, `${IDN_TOP_LEVEL_DOMAINS.length} names`);
  assert.equal(new Set(IDN_TOP_LEVEL_DOMAINS).size, IDN_TOP_LEVEL_DOMAINS.length, 'no name is listed twice');
  const converted = new Set();
  for (const name of IDN_TOP_LEVEL_DOMAINS) {
    const ascii = domainToASCII(name);
    assert.match(ascii, /^xn--[a-z0-9-]+$/u, name);
    assert.equal(domainToUnicode(ascii), name, name);
    converted.add(ascii);
    // an address of the name, written with a stop between two words of Chinese
    assert.deepEqual(egressRewrite(`https://領獎。${name}/x`), { text: B, rewritten: true }, name);
  }
  assert.equal(converted.size, IDN_TOP_LEVEL_DOMAINS.length, 'every name has a form of its own');
  // some of them as the root zone has them
  for (const [name, ascii] of Object.entries({
    台灣: 'xn--kpry57d', 中国: 'xn--fiqs8s', 香港: 'xn--j6w193g', рф: 'xn--p1ai', みんな: 'xn--q9jyb4c', コム: 'xn--tckwe',
    한국: 'xn--3e0b707e', ไทย: 'xn--o3cw4h', ایران: 'xn--mgba3a4f16a', भारत: 'xn--h2brj9c', онлайн: 'xn--80asehdb',
  })) {
    assert.ok(IDN_TOP_LEVEL_DOMAINS.includes(name), name);
    assert.equal(domainToASCII(name), ascii, name);
  }
});

test('addresses and sentences that are read as an address by design are removed whole, and said so', () => {
  assert.ok(REMOVED_BY_DESIGN.length >= 10);
  for (const [input, expected] of REMOVED_BY_DESIGN) {
    for (const rewrite of [egressRewrite, chatDomainRewrite]) {
      assert.deepEqual(rewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    }
    const events = [];
    const text = sanitizeUserFacingOutput(input, { context: { actorId: 'actor-a' }, emit: (code) => events.push(code) });
    assert.equal(text, expected, JSON.stringify(input));
    assert.deepEqual(events, ['AI_OUTPUT_URL_BLOCKED'], JSON.stringify(input));
    assert.deepEqual(egressRewrite(expected), { text: expected, rewritten: false }, JSON.stringify(input));
  }
  // The scheme text that holds a name keeps the text about "https://", and the name goes.
  for (const [input, expected] of TEXT_WITH_A_NAME) {
    for (const rewrite of [egressRewrite, chatDomainRewrite]) {
      assert.deepEqual(rewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    }
    assert.deepEqual(egressRewrite(expected), { text: expected, rewritten: false }, JSON.stringify(input));
    // without the option for names, only the scheme step runs, and the sentence is text
    assert.deepEqual(wideRewrite(input), { text: input, rewritten: false }, JSON.stringify(input));
  }
});

test('an address keeps what stands around it, and a character the scheme step does not read as a host leaves the name to the step for names', () => {
  assert.ok(WITH_CONTEXT.length >= 10);
  for (const [input, expected] of WITH_CONTEXT) {
    for (const rewrite of [egressRewrite, chatDomainRewrite]) {
      assert.deepEqual(rewrite(input), { text: expected, rewritten: true }, JSON.stringify(input));
    }
    const events = [];
    const text = sanitizeUserFacingOutput(input, { context: { actorId: 'actor-a' }, emit: (code) => events.push(code) });
    assert.equal(text, expected, JSON.stringify(input));
    assert.deepEqual(events, ['AI_OUTPUT_URL_BLOCKED'], JSON.stringify(input));
    assert.deepEqual(egressRewrite(expected), { text: expected, rewritten: false }, JSON.stringify(input));
  }
});

test('a scheme right in front of a name that the step for names replaces goes with it, and the result is no URL', () => {
  // The parser refuses a combining mark first, so the scheme step leaves the run; the name step then finds
  // the name. Without the scheme going too, "https://" stood in front of the marker, and the plain URL step
  // read that as the start of a URL in the next pass.
  const input = 'https://\u{301}evil.com/x';
  assert.deepEqual(rewriteLinks(input, { approve: wide.approve }), { text: input, rewritten: false });
  assert.deepEqual(egressRewrite(input), { text: B, rewritten: true });
  assert.deepEqual(egressRewrite(`請看${input}。`), { text: `請看${B}。`, rewritten: true });
  assert.deepEqual(egressRewrite(`${input} https://\u{301}evil.net/y`), { text: `${B} ${B}`, rewritten: true });
  // not in front of the name: a space, a bracket
  assert.deepEqual(egressRewrite('https:// evil.com/x'), { text: `https:// ${B}`, rewritten: true });
  assert.deepEqual(egressRewrite('https://(evil.com/x)'), { text: `https://(${B})`, rewritten: true });
  for (const text of ['https:// evil.com/x', 'https://(evil.com/x)', 'https://\u{301}evil.com/x']) {
    const once = egressRewrite(text);
    assert.deepEqual(egressRewrite(once.text), { text: once.text, rewritten: false }, JSON.stringify(text));
  }
});

test('a name the parser refuses for an invisible character is read without it, as a client of an older kind reads it', () => {
  // A zero width joiner outside the script that needs one, a tag character and a mark of direction make the
  // parser refuse a run that IDNA2003 clients, which drop them, open. The run goes whole, in front of or inside
  // the name, with a path or without one, as a name of look-alike letters or as an address of numbers.
  for (const run of [
    '\u{200d}evil\u{3002}com', '\u{200d}evil.com', '\u{200d}evil.com/x', '\u{24d4}\u{200d}\u{24e5}\u{24d8}\u{24db}.com',
    '\u{24d4}\u{24e5}\u{200d}\u{24d8}\u{24db}\u{3002}\u{24d2}\u{24de}\u{24dc}', '\u{200c}evil\u{ff0e}com',
    '\u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467}.ws/x', '\u{1F3F4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}.ws',
    '\u{e0041}evil\u{3002}com', '\u{202e}evil.com/x', '\u{200e}evil.com/x', '\u{200d}2130706433', '\u{200d}0x7f000001/x',
    '\u{200d}\u{ff11}\u{ff12}\u{ff17}\u{3002}0\u{3002}0\u{3002}1',
  ]) {
    const input = `https://${run}`;
    assert.equal(parseUrlOrNull(input), null, `${JSON.stringify(run)} is refused by the parser`);
    for (const text of [input, `請看${input}，謝謝`, `(${input})`, `**${input}**`]) {
      const expected = text.replace(input, B);
      assert.deepEqual(rewriteLinks(text, { approve: wide.approve }), { text: expected, rewritten: true }, JSON.stringify(text));
      assert.deepEqual(egressRewrite(text), { text: expected, rewritten: true }, JSON.stringify(text));
    }
  }
  // A name that starts with an ASCII character is the business of the plain URL step, which reads the ASCII
  // token only: the scheme goes with it, and what is left of the name is no link (no scheme, no dot).
  for (const input of ['https://ev\u{200c}il\u{3002}com', 'https://1\u{fe0f}\u{20e3}.ws/x']) {
    for (const text of [input, `請看${input}，謝謝`]) {
      const { text: output, rewritten } = egressRewrite(text);
      assert.equal(rewritten, true, JSON.stringify(text));
      assert.doesNotMatch(output, /https?:\/\//iu, JSON.stringify(text));
      assert.deepEqual(egressRewrite(output), { text: output, rewritten: false }, JSON.stringify(text));
    }
  }
  // Nothing to drop, nothing to read: a label that begins with a combining mark is refused by every client,
  // and a run of ordinary text with a joiner in it and no dot stays text.
  for (const text of ['https://\u{301}evil.com', 'https://\u{301}evil\u{3002}com', 'https://\u{200d}\u{200d}', 'https://\u{200d}evil',
    '網址要以https://\u{200d}開頭', 'https://\u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467}']) {
    assert.deepEqual(rewriteLinks(text, { approve: wide.approve }), { text, rewritten: false }, JSON.stringify(text));
  }
});

function parseUrlOrNull(value) {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

test('the next scheme ends the run: its letters are no label of the host in front of it', () => {
  const E = '\u{24d4}\u{24e5}\u{24d8}\u{24db}';
  for (const [input, expected] of [
    // each address is read for itself
    [`https://${E}\u{3002}comhttps://\u{7532}.net`, `${B}${B}`],
    [`https://${E}\u{3002}comhttp://\u{7532}.net/x`, `${B}${B}`],
    ['https://甲https://乙.com', `https://甲${B}`],
    // the scheme word is no ending of the host in front of it
    ['https://是加密的。http://不是。所以要用前者。', 'https://是加密的。http://不是。所以要用前者。'],
    ['https://開頭。HTTPS://這樣比較安全。', 'https://開頭。HTTPS://這樣比較安全。'],
    // a "http" that is no scheme (no "//" behind it) is a label like any other
    [`https://${E}\u{3002}http`, B],
    [`https://${E}\u{3002}http/x`, B],
  ]) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: expected !== input }, JSON.stringify(input));
  }
});

test('a user of any length, and invisible characters in any number, do not hide a host; a host no name server resolves is text', () => {
  const user = '甲'.repeat(1_500);
  assert.deepEqual(egressRewrite(`https://${user}@evil.com/x`), { text: B, rewritten: true });
  assert.deepEqual(egressRewrite(`請看https://${user}@2130706433，謝謝`), { text: `請看${B}，謝謝`, rewritten: true });
  const padding = '\u{200b}'.repeat(1_500);
  assert.deepEqual(egressRewrite(`https://甲.com${padding}`), { text: B, rewritten: true });
  assert.deepEqual(egressRewrite(`https://甲${padding}.com/x`), { text: B, rewritten: true });
  assert.deepEqual(egressRewrite(`https://${padding}2130706433`), { text: B, rewritten: true });
  // more than 512 characters of host, invisible ones aside, is no name a server resolves
  const long = `https://${'甲乙丙丁戊己庚辛壬癸'.repeat(60)}.com`;
  assert.deepEqual(egressRewrite(long), { text: long, rewritten: false });
});

test('a number with a user, a port or an IPv6 bracket is judged by the parser too', () => {
  for (const [input, expected] of [
    ['https://甲@2130706433', B],
    ['https://甲@2130706433/x', B],
    ['https://甲@[::1]/x', B],
    ['https://甲@[::1]。', `${B}。`],
    ['請看https://甲@[::1]）', `請看${B}）`],
    ['https://甲@[::1', 'https://甲@[::1'],
    ['https://甲@[::1]]', `${B}]`],
    ['https://甲.com]', `${B}]`],
  ]) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: expected !== input }, JSON.stringify(input));
  }
});

test('a look-alike spelling of an approved page is refused, and the ASCII spelling is still kept', () => {
  const page = `https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`;
  assert.deepEqual(egressRewrite(page), { text: page, rewritten: false });
  const lookAlike = page.replace('github', '\u{ff47}\u{ff49}\u{ff54}\u{ff48}\u{ff55}\u{ff42}');
  // The address URL parsing makes of it is the approved page, and still it goes.
  assert.equal(new URL(lookAlike).href, page);
  assert.equal(wide.approve(lookAlike), page);
  assert.deepEqual(egressRewrite(lookAlike), { text: B, rewritten: true });
  assert.deepEqual(egressRewrite(`${page} ${lookAlike}`), { text: `${page} ${B}`, rewritten: true });
});

test('the closing Markdown after such an address stays, and the names after it are still replaced', () => {
  assert.deepEqual(egressRewrite(`https://${GIFT}.ws/x**`), { text: `${B}**`, rewritten: true });
  assert.deepEqual(egressRewrite(`__https://${GIFT}.ws/x__`), { text: `__${B}__`, rewritten: true });
  assert.deepEqual(egressRewrite(`~~https://${GIFT}.ws/x~~ 與 evil.com`), { text: `~~${B}~~ 與 ${B}`, rewritten: true });
});

test('a link that is kept after a letter is kept whole in the invite step, and what is left is stable', () => {
  // The plain URL has no word boundary in front, and neither has the step for invites: an approved link
  // after a letter was once cut at its invite, which left "xhttps://[連結已移除]", and that read as a URL again.
  const kept = ['xhttps://discord.gg/TqkCx9kYmk', '_https://discord.gg/TqkCx9kYmk', '1https://discord.gg/TqkCx9kYmk',
    'abchttps://data.gov.tw/dataset/102011', `x${RELEASES}`, '%2ehttps://discord.gg/TqkCx9kYmk',
    '領獎https://discord.gg/TqkCx9kYmk'];
  for (const input of kept) {
    for (const rewrite of [egressRewrite, wideRewrite, chatDomainRewrite]) {
      assert.deepEqual(rewrite(input), { text: input, rewritten: false }, input);
    }
  }
  for (const input of ['xhttps://discord.gg/abc', 'xhttps://discord.com/invite/abc', 'ahttps://discord.gg/TqkCx9kYmk/evil']) {
    for (const rewrite of [egressRewrite, wideRewrite]) {
      const once = rewrite(input);
      assert.equal(once.rewritten, true, input);
      assert.equal(once.text.includes('discord'), false, input);
      assert.deepEqual(rewrite(once.text), { text: once.text, rewritten: false }, input);
    }
  }
});

test('Markdown emphasis that closes around a refused address stays outside the replacement', () => {
  const cases = [
    ['**https://evil.example/x**', `**${B}**`],
    ['__https://evil.example__', `__${B}__`],
    ['*https://evil.example/path*', `*${B}*`],
    ['~~https://evil.example~~', `~~${B}~~`],
    ['_https://evil.example_', `_${B}_`],
    ['***https://evil.example***', `***${B}***`],
    ['**https://evil.example**.', `**${B}**.`],
    ['**https://evil.example**。', `**${B}**。`],
    ['**https://evil.example/**', `**${B}**`],
    ['請看**https://evil.example**吧', `請看**${B}**吧`],
    // nothing in front: the markers alone stay
    ['https://evil.example/x**', `${B}**`],
    // an approved page with something else after the markers is refused with what follows, as without them
    ['**https://discord.gg/TqkCx9kYmk**/../x', `**${B}`],
    ['**https://discord.gg/TqkCx9kYmk**請看', `**${B}**請看`],
  ];
  for (const [input, expected] of cases) {
    for (const rewrite of [egressRewrite, wideRewrite, chatDomainRewrite]) {
      assert.deepEqual(rewrite(input), { text: expected, rewritten: true }, input);
    }
    assert.deepEqual(egressRewrite(expected), { text: expected, rewritten: false }, input);
  }
});

test('an approved address wrapped in Markdown emphasis is kept, with the markers outside it', () => {
  const invite = 'https://discord.gg/TqkCx9kYmk';
  const page = `${RELEASES}`;
  const data = 'https://data.gov.tw/dataset/102011';
  const swagger = 'https://opendata.cwa.gov.tw/dist/opendata-swagger.html';
  const cases = [
    `**${invite}**`, `__${page}__`, `~~${data}~~`, `*${invite}*`, `_${swagger}_`, `***${invite}***`, `~~**${data}**~~`,
    `**${invite}**.`, `**${invite}**。`, `**${invite}**，謝謝`, `(**${invite}**)`, `||**${invite}**||`, `「**${invite}**」`,
    `加入**${invite}** 吧`, `**${invite}** 與 __${page}__`, `**${RELEASES}/tag/v1.1.2**`, `**${invite}/**`,
    // markers with no opening one in front: the page is the same host, and the markers stay where they are
    `${invite}**`, `${data}__`, `${invite}/**`,
  ];
  for (const input of cases) {
    for (const rewrite of [egressRewrite, wideRewrite]) {
      assert.deepEqual(rewrite(input), { text: input, rewritten: false }, input);
    }
    // The chat scope approves one release only, and everything else the same way.
    if (!input.includes('/tag/')) assert.deepEqual(chatDomainRewrite(input), { text: input, rewritten: false }, input);
  }
  // The text that is kept is the normalized page, with the markers after it.
  assert.deepEqual(egressRewrite('**HTTPS://DISCORD.GG/TqkCx9kYmk**'), { text: `**${invite}**`, rewritten: false });
  assert.deepEqual(egressRewrite('__https://xiaoji-public-status.xichengyu810067.workers.dev__'),
    { text: '__https://xiaoji-public-status.xichengyu810067.workers.dev/__', rewritten: false });
  // Anything that is not an approved page stays refused, with or without markers.
  const refused = [
    ['**https://discord.gg/other**', `**${B}**`],
    ['**https://discord.gg/TqkCx9kYmk/evil**', `**${B}**`],
    ['**https://discord.gg.evil.example/TqkCx9kYmk**', `**${B}**`],
    ['__https://github.com/other-owner/xiaoji-formal/releases__', `__${B}__`],
    ['~~https://data.gov.tw/dataset/102011?x=1~~', `~~${B}~~`],
    ['**https://discord.gg/TqkCx9kYmk**%2e**', `**${B}**`],
  ];
  for (const [input, expected] of refused) {
    assert.deepEqual(egressRewrite(input), { text: expected, rewritten: true }, input);
  }
});

test('a masked link keeps its label, and a name written as the label is replaced too', () => {
  assert.deepEqual(chatDomainRewrite('[evil.com](https://evil.example)'), { text: B, rewritten: true });
  assert.deepEqual(egressRewrite('[evil.com](https://evil.example)'), { text: `${B} ${B}`, rewritten: true });
  assert.deepEqual(chatDomainRewrite('[版本](evil.com/x)'), { text: `[版本](${B})`, rewritten: true });
});

test('what rewriting a name leaves is stable: a second pass changes and reports nothing', () => {
  for (const [input] of [...NAMES_THAT_ARE_LINKS, ...SCHEME_ADDRESSES, ...TEXT_THAT_IS_NOT_A_LINK.map((text) => [text])]) {
    for (const rewrite of [egressRewrite, chatDomainRewrite]) {
      const once = rewrite(input);
      const twice = rewrite(once.text);
      assert.deepEqual(twice, { text: once.text, rewritten: false }, JSON.stringify(input));
    }
  }
  for (const input of corpusInputs) {
    const once = egressRewrite(input);
    assert.deepEqual(egressRewrite(once.text), { text: once.text, rewritten: false }, JSON.stringify(input));
  }
});

test('an answer is final: what a late step replaces cannot make an early step read it differently the next time', () => {
  // Found by random texts of "https://", a character that is not ASCII, an invite or "www." and "@": the invite
  // is replaced after the scheme step has read its run, and its marker, glued to what follows, became the user
  // and the host of an address that the next call removed. rewriteLinks goes over its answer until it holds.
  const inputs = [
    '「https://\u{ff1b}.ws\u{ff1b}jp\u{ff01}www.0x7f\u{3002}',
    '(https://\u{fe0f}\u{3001}discord.gg/abc\u{5b88}@\u{ff11}\u{ff12}\u{ff17}\n\u{3002}',
    '"https://\u{2605}\u{ff1f}discord.gg/abc@127\u{ff08}||',
    'https://\u{200b}\u{3001}discord.gg/abc\u{7532}@2130706433',
    'https://\u{300c}x.com/\u{7532}@evil.org',
  ];
  for (const input of inputs) {
    for (const rewrite of [egressRewrite, chatDomainRewrite, wideRewrite]) {
      const once = rewrite(input);
      assert.deepEqual(rewrite(once.text), { text: once.text, rewritten: false }, JSON.stringify(input));
    }
  }
  assert.deepEqual(egressRewrite(inputs[0]), { text: `「${B}；jp！${B}。`, rewritten: true });
  assert.deepEqual(egressRewrite(inputs[1]), { text: `(${B}\n。`, rewritten: true });
});

// How the time of a function grows with its input: the best of three runs at four times the size over the best
// of three at the size (after one run on a short text, for the compiler). Code that takes time in step with its
// input gives about 4, a loop over the text inside a loop over the text gives 16. A run shorter than
// GROWTH_FLOOR_MS is too short for a ratio to mean anything, and counts as that long.
const GROWTH_FLOOR_MS = 2;
const MAX_GROWTH_RATIO = 8;

function growth(run, make, size) {
  const best = (input) => {
    let fastest = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = process.hrtime.bigint();
      run(input);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return fastest;
  };
  run(make(Math.ceil(size / 10)));
  const small = best(make(size));
  const big = best(make(size * 4));
  return { small, big, ratio: big / Math.max(small, GROWTH_FLOOR_MS) };
}

test('the growth check tells a loop inside a loop from a loop', () => {
  const quadratic = (text) => {
    let sum = 0;
    for (let i = 0; i < text.length; i += 1) for (let j = 0; j < text.length; j += 1) sum += i ^ j;
    return sum;
  };
  const linear = (text) => {
    let sum = 0;
    for (let i = 0; i < text.length * 400; i += 1) sum += i ^ text.length;
    return sum;
  };
  const make = (size) => 'a'.repeat(size);
  const slow = growth(quadratic, make, 2_000);
  const fast = growth(linear, make, 2_000);
  assert.ok(slow.ratio > MAX_GROWTH_RATIO, `a quadratic function grew ${slow.ratio.toFixed(1)} times`);
  assert.ok(fast.ratio < MAX_GROWTH_RATIO, `a linear function grew ${fast.ratio.toFixed(1)} times`);
});

test('names are found in linear time: four times the text takes about four times as long, and milliseconds', () => {
  const repeat = (unit) => (size) => unit.repeat(Math.ceil(size / unit.length));
  const GIFT_ADDRESS = `https://${GIFT}.`;
  const shapes = {
    'a.': repeat('a.'), 'a-': repeat('a-'), 'a-a.': repeat('a-a.'), '.': repeat('.'), '-': repeat('-'),
    '_-': repeat('_-'), a: repeat('a'), 'a...a.com': (size) => `${'a'.repeat(size)}.com`,
    'a.a.a...com': (size) => `${'a.'.repeat(size / 2)}com`, 'a.a.a...in': (size) => `${'a.'.repeat(size / 2)}in`,
    'x.in.': repeat('x.in.'), 'ok.me?': repeat('ok.me?'), 'ok.me?.-': repeat('ok.me?.-'), '1.2?': repeat('1.2?'),
    'a.com/x請': repeat('a.com/x請'), 'https://例.': repeat('https://例.'), '@a.com': repeat('@a.com'),
    'a.com/xxx': (size) => `a.com/${'x'.repeat(size)}`, 'a.com?a=1&a=1': (size) => `a.com?${'a=1&'.repeat(size / 4)}`,
    '中a.': repeat('中a.'), 'a<ZWSP>.a<ZWSP>.com': (size) => `${'a\u{200b}.'.repeat(size / 3)}com`,
    'a<COMBINING>...com': (size) => `a${'\u{301}'.repeat(size)}.com`, 'http://': repeat('http://'),
    // addresses whose first character is not ASCII, and what ends them
    'https://<GIFT>.': repeat(GIFT_ADDRESS), 'https://<GIFT>aaa': (size) => `https://${GIFT}${'a'.repeat(size)}`,
    'https://<GIFT>.ws/x ': repeat(`${GIFT_ADDRESS}ws/x `), 'https://（': repeat('https://（'),
    'https://（aaa': (size) => `https://（${'a'.repeat(size)}`,
    'https://（https://https://': (size) => `https://（${'https://'.repeat(size / 8)}`,
    'https://<GIFT>https://<GIFT>': repeat(`https://${GIFT}`), 'https://。。。': (size) => `https://${'。'.repeat(size)}`,
    // emphasis around a refused address, and a long run of it
    '**https://evil.example**': repeat('**https://evil.example**'), 'https://x***a': (size) => `https://x${'*'.repeat(size)}a`,
    '***': repeat('*'), 'approved，<GIFT>': repeat(`https://data.gov.tw/dataset/102011，${GIFT_ADDRESS}ws `),
    // approved addresses one after the other in a run with no space (the run after one is read once: the
    // second of these took 139 ms at 20 000 characters and 2.3 s at 80 000 when it was read again from each)
    'approved，approved，': repeat('https://data.gov.tw/dataset/102011，'),
    'approved中approved中': repeat('https://data.gov.tw/dataset/102011中'),
    // "https://" and a word of Chinese, over and over in a paragraph with no space: whether the run holds a
    // dot is found once for the run, not again from each scheme in it (the last dot may be far away)
    'https://開頭': repeat('https://開頭'), 'https://開頭。': repeat('https://開頭。'),
    'https://開頭，': repeat('https://開頭，'), 'https://開頭 x n + .com': (size) => `${'https://開頭'.repeat(size / 8)}.com`,
    'https://「a。': repeat('https://「a。'), 'https://「evil。com': repeat('https://「evil。com'),
    'https://甲。a': repeat('https://甲。a'), 'https://甲.': repeat('https://甲.'), 'https://。': repeat('https://。'),
    'https://甲。aaa': (size) => `https://甲。${'a'.repeat(size)}`, 'https://「+aaa+。com': (size) => `https://「${'a'.repeat(size)}。com`,
    'https://甲+%2e': repeat('https://甲%2e'), 'https://甲+。。': repeat('https://甲。。'),
    // many short runs (white space between them) and no dot in any of them: a search for the next dot in the
    // text, made from each run, would go to the end of the text every time (139 ms became 1.3 s)
    'https://★a*100 ': repeat(`https://★${'a'.repeat(100)} `), 'https://甲a*10 ': repeat('https://甲aaaaaaaaaa '),
    'https://★a*100。 ': repeat(`https://★${'a'.repeat(100)}。 `), 'https://★a*100.com ': repeat(`https://★${'a'.repeat(100)}.com `),
    // runs the parser reads (one parse for each run, and a run of 512 characters at most is given to it): a
    // user in front of a number, a number written with stops, a host of very many labels, a host of 500
    // different characters, an address with a stop behind it and no space before the next, a mark of
    // punctuation in a host with a subdomain, and an IPv6 address
    'https://甲@2130706433 ': repeat('https://甲@2130706433 '),
    'https://１２７。０。０。１ ': repeat('https://１２７。０。０。１ '),
    'https://甲.a.a.a': (size) => `https://甲${'.a'.repeat(size / 2)}`,
    'https://<500 characters>.com ': repeat(`https://${'甲乙丙丁戊己庚辛壬癸'.repeat(50)}.com `),
    'https://<GIFT>.ws。': repeat(`https://${GIFT}.ws。`),
    'https://甲，乙.a.com ': repeat('https://甲，乙.a.com '),
    'https://甲@[::1] ': repeat('https://甲@[::1] '),
    'https://甲，乙，丙，': repeat('https://甲，乙，丙，'),
    // a user of 1 500 characters, and a host padded with 600 invisible characters, in each run
    'https://<user of 1 500>@evil.com ': repeat(`https://${'甲'.repeat(1_500)}@evil.com `),
    'https://甲.com<600 ZWSP> ': repeat(`https://甲.com${'\u{200b}'.repeat(600)} `),
    'https://甲<ZWSP>.com': (size) => `https://甲${'\u{200b}'.repeat(size)}.com`,
    // a run the parser refuses (a joiner first) is read again without it: each of these runs is two parses, and
    // the same run over and over is asked once. The second shape gives each run its own number.
    'https://<ZWJ>evil。com ': repeat('https://\u{200d}evil\u{3002}com '),
    'https://<ZWJ>evil<n>。com ': (size) => {
      let text = '';
      for (let n = 0; text.length < size; n += 1) text += `https://\u{200d}evil${n}\u{3002}com `;
      return text;
    },
    'https://<ZWJ><emoji>.ws/x ': repeat('https://\u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467}.ws/x '),
    'https://<ZWJ>*n': (size) => `https://${'\u{200d}'.repeat(size)}evil.com`,
    // approved and emphasized, over and over, and a long run of emphasis behind one
    '**approved**': repeat('**https://discord.gg/TqkCx9kYmk** '), 'approved+***': (size) => `https://discord.gg/TqkCx9kYmk${'*'.repeat(size)}`,
    'approved+*_~': (size) => `https://data.gov.tw/dataset/102011${'*_~'.repeat(size / 3)}`,
  };
  for (const [name, make] of Object.entries(shapes)) {
    const { small, big, ratio } = growth(egressRewrite, make, 20_000);
    assert.ok(ratio < MAX_GROWTH_RATIO,
      `${name}: ${small.toFixed(1)} ms at 20 000 characters, ${big.toFixed(1)} ms at 80 000: ${ratio.toFixed(1)} times`);
    // And the absolute bounds the check had before it looked at growth.
    assert.ok(small < 250 && big < 1_000, `${name}: ${small.toFixed(0)} ms and ${big.toFixed(0)} ms`);
  }
});

test('many approved names in one unspaced paragraph are judged in linear time too', () => {
  // Each approved name needs to know what follows it up to the next space: that run is read once.
  const units = ['data.gov.tw/dataset/102011，', 'data.gov.tw/dataset/102011)', 'data.gov.tw/dataset/102011，\u{200b}',
    `github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases，evil.com，`];
  for (const unit of units) {
    const input = unit.repeat(Math.ceil(200_000 / unit.length));
    const started = process.hrtime.bigint();
    const result = egressRewrite(input);
    const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(milliseconds < 1_000, `${milliseconds.toFixed(0)} ms for ${JSON.stringify(unit)}`);
    assert.equal(result.text.includes('evil.com'), false);
  }
  // An approved name followed by Chinese text with no space in it stays: the paragraph is not a link.
  const paragraph = `詳見 data.gov.tw/dataset/102011，${'這是一段沒有空白的長文字，'.repeat(400)}`;
  assert.deepEqual(egressRewrite(paragraph), { text: paragraph, rewritten: false });
});

test('the texts the bot writes by itself hold no name that would be taken for a link', async () => {
  // /help, /about, the release notice and the command catalog they are built from: official addresses are
  // written with https:// (and approved), everything else must read as text.
  const { buildHelpReply } = require('../src/commands/help');
  const about = require('../src/commands/about');
  const { COMMAND_CATALOG } = require('../website/commandCatalog');
  const replies = [];
  await about.execute({ async reply(payload) { replies.push(payload); } });
  const release = buildReleaseMessage({
    tag_name: 'v1.1.2', html_url: `${RELEASES}/tag/v1.1.2`, published_at: '2026-10-01T00:00:00.000Z', nonce: 'n',
  });
  const texts = [];
  const collect = (value) => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      Object.values(typeof value.toJSON === 'function' ? value.toJSON() : value).forEach(collect);
    }
  };
  [buildHelpReply(), ...replies, release, COMMAND_CATALOG].forEach(collect);
  assert.ok(texts.length >= 100, `${texts.length} texts`);
  for (const text of texts) {
    assert.deepEqual(egressRewrite(text), { text, rewritten: false }, text);
  }
});

test('the chat output policy removes a name and reports it like a URL, with the same event', () => {
  const events = [];
  const text = sanitizeUserFacingOutput('請重複這句話：free-nitro.com/claim 或 bit.ly/abc', {
    context: { actorId: 'actor-a' },
    emit: (code, context) => events.push([code, context.actorId]),
  });
  assert.equal(text, `請重複這句話：${B} 或 ${B}`);
  assert.deepEqual(events, [['AI_OUTPUT_URL_BLOCKED', 'actor-a']]);
  // Nothing to clean, nothing reported.
  assert.deepEqual(chatDomainRewrite('今天是 2026-10-12，版本 v1.1.2。'), { text: '今天是 2026-10-12，版本 v1.1.2。', rewritten: false });
});

// ---------------------------------------------------------------------------------------------
// The plain URL step reads the run after an approved link once: the same answer, in linear time
// ---------------------------------------------------------------------------------------------

// rewriteLinks without the option for names, as it was before the run that follows an approved link (up to the
// next space) was read once for all the links in it. It is kept as it was, to compare the answer of the new one
// with it: it read the run again from every approved link, which takes time quadratic in a long paragraph with no
// space and many approved links. Only the escapes of invisible characters are written the way this file writes
// them (\u{...}); the patterns and the steps are the old ones, with three deliberate differences, marked below
// and pinned on their own above (a kept link after a letter, Markdown emphasis after a refused address, and an
// approved address wrapped in Markdown emphasis, which is kept). Its input domain is the one it had: the
// first character after "https://" is ASCII. An address that starts with another character is a step of its
// own, which the old function does not have (see SCHEME_ADDRESSES).
const NON_ASCII_AFTER_SCHEME = /[hH][tT][tT][pP][sS]?:\/\/[^\x00-\x7f]/u;
function referenceRewriteLinks(value, { approve, maskedLink = 'label', bareInvites = false } = {}) {
  const DANGEROUS_ENCODED_SEPARATOR = /%(?:00|2e|2f|3f|40|5c)/i;
  const MARKDOWN_LINK = /\[([^\]\r\n]{0,300})\]\(\s*(<?https?:\/\/[^\s)>]+>?)\s*(?:["'][^"']*["'])?\s*\)/giu;
  const ANGLE_AUTOLINK = /<(https?:\/\/[^\s<>]+)>/giu;
  const PLAIN_URL = /https?:\/\/[A-Za-z0-9._~:%?#[\]@!$&'*+=,;\/\\\u{FF0E}-]+/giu;
  const BARE_WWW = /\bwww\.[\p{L}\p{N}.-]+(?:\/[^\s<>{}\[\]"'()，。！？；：、（）]*)?/giu;
  // The one deliberate difference from the old function (pinned on its own, further down): the alternative
  // that matches a kept URL has no word boundary in front, as the plain URL has none, so that a kept link
  // after a letter (xhttps://discord.gg/...) is matched whole and its invite is not cut out of it.
  const BARE_INVITE_OR_URL = new RegExp(
    String.raw`(${PLAIN_URL.source})|discord(?:(?:app)?\.com\/invite|\.gg(?:\/invite)?|\.gift)\/[\w-]+`, 'giu');
  const LINK_RUN_END = /[\s<]/u;
  const LINK_SOFT_END = /[，。、；：！？（）［］｛｝「」『』【】《》〈〉〔〕〖〗“”‘’…—～〜·・＂＇)"`|]/u;
  const ZERO_WIDTH = /[\u{200b}-\u{200d}\u{2060}\u{feff}]/gu;
  const PATH_DOT_SEGMENT = /[\/\\](?:\.|%2e)/iu;
  const ENCODED_PERCENT = /%25/iu;

  function splitTrailingPunctuation(token) {
    const matched = String(token).match(/^(.*?)([),.'\]，。!！?？;；:：]*)$/u);
    return { body: matched?.[1] || '', suffix: matched?.[2] || '' };
  }

  function linkContinuation(text, start, end) {
    let stop = end;
    while (stop < text.length && !LINK_RUN_END.test(text[stop])) stop += 1;
    const run = text.slice(end, stop);
    const visible = run.replace(ZERO_WIDTH, '');
    if (!visible) return null;
    const softEnd = LINK_SOFT_END.test(visible[0]) || (visible[0] === '>' && text[start - 1] === '<');
    const judgedWhole = PATH_DOT_SEGMENT.test(visible) || DANGEROUS_ENCODED_SEPARATOR.test(visible) ||
      ENCODED_PERCENT.test(visible);
    return softEnd && !judgedWhole ? null : run;
  }

  function rewritePlainUrls(text, approveUrl, onRewrite) {
    let output = '';
    let last = 0;
    for (const match of text.matchAll(PLAIN_URL)) {
      const start = match.index;
      if (start < last) continue;
      const end = start + match[0].length;
      const { body, suffix } = splitTrailingPunctuation(match[0]);
      // The third deliberate difference from the old function: the Markdown emphasis at the end of a token
      // (**https://discord.gg/...**) is cut off when the token is refused with it, and what is approved
      // without it is kept, with the markers written after it. A refused token keeps them outside as well.
      let emphasisStart = body.length;
      while (emphasisStart > 0 && '*_~'.includes(body[emphasisStart - 1])) emphasisStart -= 1;
      const emphasis = body.slice(emphasisStart);
      output += text.slice(last, start);
      last = end;
      let safe = approveUrl(body);
      let kept = '';
      if (!safe && emphasis) {
        safe = approveUrl(body.slice(0, emphasisStart));
        if (safe) kept = emphasis;
      }
      const continuation = safe ? linkContinuation(text, start, end) : null;
      if (safe && continuation === null) {
        output += `${safe}${kept}${suffix}`;
        continue;
      }
      if (continuation !== null) {
        const whole = approveUrl(`${match[0]}${continuation}`.replace(ZERO_WIDTH, ''));
        if (whole) {
          output += whole;
          last = end + continuation.length;
          continue;
        }
      }
      onRewrite();
      output += `${BLOCKED_LINK_REPLACEMENT}${emphasis}${suffix}`;
    }
    return output + text.slice(last);
  }

  let text = String(value ?? '');
  let rewritten = false;
  text = text.replace(MARKDOWN_LINK, (_whole, label, target) => {
    const safe = approve(target);
    if (safe) return `[${label}](${safe})`;
    rewritten = true;
    if (!label) return BLOCKED_LINK_REPLACEMENT;
    return maskedLink === 'label' ? label : `${label} ${BLOCKED_LINK_REPLACEMENT}`;
  });
  text = text.replace(ANGLE_AUTOLINK, (_whole, target) => {
    const safe = approve(target);
    if (safe) return `<${safe}>`;
    rewritten = true;
    return BLOCKED_LINK_REPLACEMENT;
  });
  text = rewritePlainUrls(text, approve, () => { rewritten = true; });
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
  return { text, rewritten };
}

// Every approval a caller can hand over: the two approvals as they are, the same two wrapped in a function of
// their own (which the module cannot tell from any other function, and so asks as it always did), and one that
// refuses everything (the Owner notice).
const REFERENCE_APPROVERS = Object.freeze([
  ['stable', wide.approve], ['chat', chat.approve],
  ['stable, wrapped', (value) => wide.approve(value)], ['chat, wrapped', (value) => chat.approve(value)],
  ['refuses all', () => null],
]);

function assertSameAnswer(input, approver, maskedLink, bareInvites) {
  const [name, approve] = approver;
  const options = { approve, maskedLink, bareInvites };
  const expected = referenceRewriteLinks(input, options);
  const actual = rewriteLinks(input, options);
  assert.deepEqual(actual, expected,
    `${JSON.stringify(input.length > 300 ? `${input.slice(0, 300)}...` : input)} with ${name}, ${maskedLink}, bareInvites ${bareInvites}`);
}

test('the plain URL step gives the answer it gave before the run was read once, on every row of the link corpus', () => {
  assert.ok(corpusInputs.length >= 200);
  // The rows with a non-ASCII character right after "https://" are out of the old function's domain (their
  // answers are pinned in SCHEME_ADDRESSES and in the corpus itself): some of them, the rows of the host the
  // parser reads included, and no more than that.
  const comparable = corpusInputs.filter((input) => !NON_ASCII_AFTER_SCHEME.test(input));
  assert.ok(comparable.length >= 200 && corpusInputs.length - comparable.length <= 45,
    `${comparable.length} of ${corpusInputs.length} rows compared`);
  for (const input of comparable) {
    for (const approver of REFERENCE_APPROVERS) {
      for (const maskedLink of ['label', 'label-and-marker']) {
        for (const bareInvites of [false, true]) assertSameAnswer(input, approver, maskedLink, bareInvites);
      }
    }
  }
});

test('and on seeded random strings of approved links, dots, encoded separators, zero-width characters and soft ends', () => {
  const approved = [
    'https://discord.gg/TqkCx9kYmk', 'https://discord.gg/TqkCx9kYmk/', `${RELEASES}`, `${RELEASES}/tag/${APPROVED_TAG}`,
    `${RELEASES}/tag/v1.1.2`, 'https://data.gov.tw/dataset/102011', 'https://opendata.cwa.gov.tw/dist/opendata-swagger.html',
    'https://xiaoji-public-status.xichengyu810067.workers.dev', 'HTTPS://DISCORD.GG/TqkCx9kYmk',
    `https://GitHub.com/${OFFICIAL_RELEASE_REPOSITORY}/releases`,
  ];
  const pieces = [
    ...approved, ...approved, 'https://evil.example/x', 'http://evil.example', 'https://discord.gg/other',
    `${RELEASES}/tag/v9.9.9`, '.', '..', '/', '\\', '/./', '/../', '\\..\\', '%2e', '%2E', '%2f', '%2F', '%5c', '%25',
    '%252e', '%00', '%3f', '%40', '%41', '\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{feff}',
    '，', '。', '、', '；', '：', '！', '？', '（', '）', '」', '』', '】', '》', '…', '—', '～', '·', ')', '"', '`', '|',
    "'", ']', '[', ',', ';', ':', '!', '?', '中文', '領獎', '這是一段文字', '日本語', '한국어', 'a', 'b', 'x', 'evil',
    '<', '>', '<https://discord.gg/TqkCx9kYmk>', '[點我](https://discord.gg/TqkCx9kYmk)', '[x](https://evil.example)',
    ' ', ' ', '\n', '\t', '\u{3000}', 'www.', 'www.evil.com', 'discord.gg/abc', 'discord.com/invite/x',
    '?', '#', '=', '&', '@', '+', '*', '~', '_', '-',
  ];
  let seed = 20_261_012;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const configurations = new Set();
  const total = 24_000;
  for (let index = 0; index < total; index += 1) {
    let input = '';
    const parts = 1 + Math.floor(random() * 22);
    for (let part = 0; part < parts; part += 1) {
      input += pick(pieces);
      // An approved link is often followed by what can follow one.
      if (random() < 0.15) input += pick(approved);
    }
    const approver = pick(REFERENCE_APPROVERS);
    const maskedLink = random() < 0.5 ? 'label' : 'label-and-marker';
    const bareInvites = random() < 0.5;
    configurations.add(`${approver[0]}|${maskedLink}|${bareInvites}`);
    assert.equal(NON_ASCII_AFTER_SCHEME.test(input), false, 'the pieces never put a non-ASCII character after a scheme');
    assertSameAnswer(input, approver, maskedLink, bareInvites);
  }
  // Every approval, both styles and both settings of the invite step were asked.
  assert.equal(configurations.size, REFERENCE_APPROVERS.length * 4);
});

test('and on runs of about 2 048 characters, where an approval stops reading a text', () => {
  // An approved release page followed by "|" and segments that climb back: the whole is the approved page again,
  // unless it is longer than approve() reads. The lengths straddle that limit, with and without a closing ">"
  // and with zero-width characters, which count in the text but not in what approve() reads.
  const base = `${RELEASES}/tag/v1.1.2|`;
  const tail = '/../../../releases';
  let near = 0;
  let approvedWhole = 0;
  for (let pairs = 380; pairs <= 400; pairs += 1) {
    for (let dots = 0; dots <= 2; dots += 1) {
      const run = `${'/.'.repeat(dots)}${'/a/..'.repeat(pairs)}${tail}`;
      for (const [before, after] of [['', ''], ['', '>'], ['<', '>'], ['', '\u{200b}'], ['', '>\u{200b}'], ['', ' 好']]) {
        const input = `${before}${base}${run}${after}`;
        for (const approver of REFERENCE_APPROVERS) {
          for (const maskedLink of ['label', 'label-and-marker']) assertSameAnswer(input, approver, maskedLink, true);
        }
        // What approve() would read: the link and its run without zero-width characters, a "<" and a ">".
        const read = `${base}${run}`.length;
        if (read >= 2_044 && read <= 2_054) near += 1;
        if (!after && !before && rewriteLinks(input, { approve: wide.approve }).text === RELEASES) approvedWhole += 1;
      }
    }
  }
  assert.ok(near >= 30, `${near} cases next to the limit`);
  // Below the limit the climbing run makes the approved page again, above it the link goes.
  assert.ok(approvedWhole >= 10 && approvedWhole < 21 * 3, `${approvedWhole} whole links approved`);
});

test('an approved link followed by a run of 400 000 characters with no space is judged in well under a second', () => {
  const size = 400_000;
  const link = 'https://data.gov.tw/dataset/102011';
  const repeat = (unit) => unit.repeat(Math.ceil(size / unit.length));
  // [text, what the answer is, kept as it is or every link replaced]
  const cases = [
    // one approved link, then a Chinese paragraph with no space in it
    [`${link}，${repeat('這是一段沒有空白的長文字，')}`, (input) => input],
    // many approved links in one run, each followed by a soft end
    [repeat(`${link}，`), (input) => input],
    [repeat(`${link}）`), (input) => input],
    // the same with a zero-width character after each soft end
    [repeat(`${link}，\u{200b}`), (input) => input],
    // each followed by a letter: the whole run is judged with the link, is far too long to be approved,
    // so each link goes and the letter stays
    [repeat(`${link}中`), (input) => `${B}中`.repeat(input.split('中').length - 1)],
    // a dot segment far down the run: the link is judged with it and goes
    [`${link}，${repeat('文字，')}/../x`, (input) => `${B}${input.slice(link.length)}`],
  ];
  for (const [input, expected] of cases) {
    for (const approve of [wide.approve, chat.approve]) {
      const started = process.hrtime.bigint();
      const result = rewriteLinks(input, { approve, maskedLink: 'label-and-marker', bareInvites: true });
      const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(milliseconds < 500, `${milliseconds.toFixed(0)} ms for ${JSON.stringify(input.slice(0, 40))}`);
      assert.equal(result.text, expected(input), JSON.stringify(input.slice(0, 40)));
    }
  }
  // Long trailing punctuation does not make the split of a token slow either.
  for (const punctuation of ['.', ',', ';', "'", ':', '!']) {
    const input = `https://x${punctuation.repeat(size / 2)}a`;
    const started = process.hrtime.bigint();
    rewriteLinks(input, { approve: wide.approve, maskedLink: 'label' });
    const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(milliseconds < 500, `${milliseconds.toFixed(0)} ms for a run of ${JSON.stringify(punctuation)}`);
  }
});
