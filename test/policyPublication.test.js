const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publication } = require('../website/policyPublication');
const { ARCHIVE_POLICY_VERSION } = require('../src/services/aiArchiveService');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function hasLongFormDocuments() {
  return fs.existsSync(path.join(root, 'xiaoji_privacy.md')) && fs.existsSync(path.join(root, 'xiaoji_terms.md'));
}

function siteSupportBlocks() {
  const blocks = [];
  for (const line of read('website/siteSupport.js').split('\n')) {
    const match = /^\s+\['([^']+)', '([^']+)'\],$/u.exec(line);
    if (match) blocks.push([match[1], match[2]]);
  }
  return blocks;
}

test('the published policy version equals the archive policy version the code checks', () => {
  // A mismatch silently turns AI conversation archiving off, so the two must move together.
  assert.equal(publication.version, ARCHIVE_POLICY_VERSION);
  assert.match(read('docs/releases/1.2.0.md'),
    new RegExp(`XIAOJI_ARCHIVE_POLICY_VERSION=${ARCHIVE_POLICY_VERSION.replaceAll('.', '\\.')}`));
});

test('both no-JavaScript fallbacks in the policy page show the shared publication text', () => {
  const page = read('website/policies.html');
  const fallbacks = [...page.matchAll(/data-policy-publication><noscript>(.*?)<\/noscript>/gs)].map((match) => match[1]);
  assert.equal(fallbacks.length, 2);
  for (const text of fallbacks) assert.equal(text, publication.displayText);
  if (!publication.effectiveDate) assert.match(publication.displayText, /尚未生效/);
});

test('the policy page and the support dialog carry the same policy blocks', () => {
  const page = read('website/policies.html');
  const blocks = siteSupportBlocks();
  assert.ok(blocks.length >= 12, `expected the policy blocks, found ${blocks.length}`);
  for (const [heading, text] of blocks) {
    assert.ok(page.includes(`<h3>${heading}</h3><p>${text}</p>`), `policies.html is missing or differs on: ${heading}`);
  }
});

test('policy text no longer describes guild review, approval, or allow and deny lists', () => {
  const checked = {
    'website/policies.html': read('website/policies.html'),
    'website/siteSupport.js': read('website/siteSupport.js'),
  };
  // The long-form documents are not part of the public export, so check them only where they exist.
  if (hasLongFormDocuments()) {
    const legacyRecordBullet = /^- 升級前舊版留下的伺服器審核紀錄與邀請者白名單.*$/mu;
    const privacy = read('xiaoji_privacy.md');
    assert.match(privacy, legacyRecordBullet, 'the legacy-record disclosure must stay in the privacy policy');
    checked['xiaoji_privacy.md'] = privacy.replace(legacyRecordBullet, '');
    checked['xiaoji_terms.md'] = read('xiaoji_terms.md');
  }
  for (const [file, text] of Object.entries(checked)) {
    assert.doesNotMatch(text, /審核|核准|白名單|黑名單/u, `${file} still mentions review, approval, or allow and deny lists`);
  }
});

test('the policy states the 1.2.0 facts in the website and the privacy document', () => {
  const documents = [read('website/policies.html'), read('website/siteSupport.js')];
  if (hasLongFormDocuments()) documents.push(read('xiaoji_privacy.md'));
  const facts = [
    /以固定格式私訊擁有者，內容只有遭受攻擊的伺服器名稱與類別，不含成員的文字內容、帳號或任何 ID/u,
    /同一伺服器、同一類別每小時最多通知一則/u,
    /使用小吉本機內建的規則，不連網；偵測結果只通知擁有者/u,
    /吉幣帳戶是跨伺服器共用的/u,
    /擁有者可以用專用指令查詢全體成員的吉幣帳戶資料；成員只能查看自己的吉幣資料/u,
    /看不到該成員在其他伺服器的主職或薪資/u,
    /TypeSafe AI（Jev）/u,
    /預設關閉，須由擁有者明確啟用/u,
    /託管於美國/u,
    /每段上限約 1500 字/u,
  ];
  for (const document of documents) {
    for (const fact of facts) assert.match(document, fact);
  }
  if (hasLongFormDocuments()) assert.match(read('xiaoji_terms.md'), /TypeSafe AI（Jev）/u);
});
