const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PUBLIC_SYSTEM_CATALOG } = require('../website/publicFeatureCatalog');

const root = path.resolve(__dirname, '..');
const PUBLIC_STATUS_WORKER_BASE = 'https://xiaoji-public-status.xichengyu810067.workers.dev';
const PUBLIC_RELEASES_URL = 'https://github.com/xichengyu810067-lab/xiaoji-formal/releases';

function readWorkerBase(html) {
  const match = html.match(/<meta name="xiaoji-api-base" content="([^"]+)" \/>/);
  assert.ok(match, 'public status Worker base metadata must be present');
  return match[1];
}

test('official website is localized, responsive, and honest when live data is unavailable', () => {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'website/styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/app.js'), 'utf8');

  new vm.Script(app, { filename: 'website/app.js' });
  assert.match(html, /lang="zh-Hant"/);
  assert.match(html, /rel="icon" href="\.\/assets\/xiaoji-hero\.png"/);
  assert.match(html, /採用伺服器/);
  assert.match(html, new RegExp(PUBLIC_RELEASES_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /今日互動/);
  assert.match(html, /目前狀態/);
  assert.match(html, /\.\/status\.html/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(app, /schemaVersion !== 1/);
  assert.match(app, /dataNotice\.hidden = true/);
  assert.match(css, /\.data-notice\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(html + app, /小吉不會用猜測的數字/);
});

test('public website provides local text support and no-JavaScript policy pages without exposing private operations', () => {
  const pages = [
    'website/index.html',
    'website/status.html',
    'website/games/tetris/index.html',
    'website/games/number-match/index.html',
    'website/games/sudoku/index.html',
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  const policies = fs.readFileSync(path.join(root, 'website/policies.html'), 'utf8');
  const support = fs.readFileSync(path.join(root, 'website/siteSupport.js'), 'utf8');
  const supportCss = fs.readFileSync(path.join(root, 'website/support.css'), 'utf8');
  const gameClient = fs.readFileSync(path.join(root, 'website/games/gameClient.js'), 'utf8');

  new vm.Script(support, { filename: 'website/siteSupport.js' });
  assert.ok(pages.every((page) => page.includes('siteSupport.js') && page.includes('data-support-footer-links')));
  assert.match(policies, /<link rel="canonical" href="\/policies\.html"/);
  assert.match(policies, /id="terms"/);
  assert.match(policies, /id="privacy"/);
  assert.match(policies, /id="public-data"/);
  assert.match(policies, /Google Fonts/);
  assert.match(policies, /非機器人、非系統的公開頻道文字訊息可能被記錄為公開頻道記憶，即使未提及小吉/);
  assert.match(policies, /不宣稱所有記憶都會在 30 天後自動刪除/);
  assert.match(support, /COMMUNITY_INVITE_URL = 'https:\/\/discord\.gg\/TqkCx9kYmk'/);
  assert.match(support, /非機器人、非系統的公開頻道文字訊息可能被記錄為公開頻道記憶，即使未提及小吉/);
  assert.match(support, /return `\/policies\.html#\$\{id\}`/);
  assert.match(support, /xichengyu810067@gmail\.com/);
  assert.match(support, /小吉服務詢問/);
  assert.match(support, /maxLength = 500/);
  assert.match(support, /event\.isComposing/);
  assert.doesNotMatch(support, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(/);
  assert.match(supportCss, /support-bubble\.agent/);
  assert.match(supportCss, /support-bubble\.user/);
  assert.match(gameClient, /support-modal-open/);
  assert.ok(pages.every((page) => page.includes('href="/policies.html#terms"')
    && page.includes('href="/policies.html#privacy"')
    && page.includes('href="/policies.html#public-data"')
    && page.includes('mailto:xichengyu810067@gmail.com?subject=')));
  assert.doesNotMatch(pages.join('\n') + policies + support, /菇湯集團 Discord 邀請連結待正式核實/);
});

test('official website public data contract contains no Discord identity fields', () => {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/app.js'), 'utf8');

  assert.doesNotMatch(html + app, /guildId|userId|discordId|ownerId/);
  assert.match(app, /guilds\?\.adoptedCount/);
  assert.match(app, /usage\?\.todayInteractions/);
  assert.doesNotMatch(app, /last24hInteractions/);
  assert.match(app, /bot\?\.status/);
});

test('homepage and status page use the deployed Worker public endpoints without a same-origin fallback', () => {
  const homepageHtml = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const homepageApp = fs.readFileSync(path.join(root, 'website/app.js'), 'utf8');
  const statusHtml = fs.readFileSync(path.join(root, 'website/status.html'), 'utf8');
  const statusApp = fs.readFileSync(path.join(root, 'website/status.js'), 'utf8');

  assert.equal(readWorkerBase(homepageHtml), PUBLIC_STATUS_WORKER_BASE);
  assert.equal(readWorkerBase(statusHtml), PUBLIC_STATUS_WORKER_BASE);
  assert.equal(new URL('/api/public/overview', readWorkerBase(homepageHtml)).toString(), `${PUBLIC_STATUS_WORKER_BASE}/api/public/overview`);
  assert.equal(new URL('/api/public/status', readWorkerBase(statusHtml)).toString(), `${PUBLIC_STATUS_WORKER_BASE}/api/public/status`);
  assert.match(homepageApp, /\$\{getWorkerBase\(\)\}\/api\/public\/overview/);
  assert.match(statusApp, /\$\{getWorkerBase\(\)\}\/api\/public\/status/);
  assert.doesNotMatch(homepageApp + statusApp, /: '\/api\/public'/);
});

test('realtime status site renders only allowlisted states with text-safe DOM operations', () => {
  const html = fs.readFileSync(path.join(root, 'website/status.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'website/status.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/status.js'), 'utf8');

  new vm.Script(app, { filename: 'website/status.js' });
  assert.match(html, /正常/);
  assert.match(html, /rel="icon" href="\.\/assets\/xiaoji-hero\.png"/);
  assert.match(html, /維護中/);
  assert.match(html, /損壞/);
  assert.match(app, /OVERALL_STATUS/);
  assert.match(app, /replaceChildren/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(html + app, /沒有資料.*正常|狀態未知/s);
  assert.doesNotMatch(html + app, /guildId|userId|discordId|ownerId/);
});

test('realtime status site keeps the static public feature catalog visible when live data is unavailable', () => {
  const html = fs.readFileSync(path.join(root, 'website/status.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'website/status.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/status.js'), 'utf8');

  assert.equal(PUBLIC_SYSTEM_CATALOG.length, 10);
  assert.ok(PUBLIC_SYSTEM_CATALOG.every((system) => system.features.length > 0));
  assert.equal(PUBLIC_SYSTEM_CATALOG.reduce((count, system) => count + system.features.length, 0), 48);
  assert.equal(PUBLIC_SYSTEM_CATALOG.find((system) => system.name === '音樂播放').features.length, 11);
  assert.equal(PUBLIC_SYSTEM_CATALOG.find((system) => system.name === '棋盤與推理遊戲').features.length, 7);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /僅限機器人擁有者使用/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /五次同局面或 75 步自動和棋/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /只有本局結束後，曾參與該局的玩家才能查看答案/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /xiaoji-formal/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /官網的「公開版本資訊」連結/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /\/fortune 或 \/roll/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /個人記憶僅供本人查詢/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /於可使用小吉的伺服器間共用/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /新商品不能附 Discord 身分組/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /商品上架與調整僅限小吉擁有者/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /一般使用者可查看自己的帳務與目前利率/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /一般使用者可借款、還款並查看自己的賭場借款/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /\/coin-db status 僅限小吉擁有者/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /\/economy leaderboard 可公開查看/);
  assert.match(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /\/?ping 只顯示小吉回應與連線延遲/);
  assert.match(html, /publicFeatureCatalog\.js/);
  assert.match(app, /PUBLIC_SYSTEM_CATALOG/);
  assert.match(app, /aria-expanded/);
  assert.match(app, /expandedSystems/);
  assert.match(app, /renderPublicSystems\(/);
  assert.match(app, /window\.XiaojiPublicFeatureCatalog\?\.PUBLIC_SYSTEM_CATALOG/);
  assert.match(css, /\.service-panel/);
  assert.match(css, /\.accordion-trigger/);
  assert.doesNotMatch(JSON.stringify(PUBLIC_SYSTEM_CATALOG), /guildId|userId|discordId|ownerId/);
});
