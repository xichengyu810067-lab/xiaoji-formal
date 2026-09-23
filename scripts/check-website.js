const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const publicStatusWorkerBase = 'https://xiaoji-public-status.xichengyu810067.workers.dev';
const publicReleasesUrl = 'https://github.com/xichengyu810067-lab/xiaoji-formal/releases';
const requiredFiles = [
  'website/index.html',
  'website/styles.css',
  'website/app.js',
  'website/assets/xiaoji-hero.png',
  'website/status.html',
  'website/status.css',
  'website/statusData.js',
  'website/publicFeatureCatalog.js',
  'website/status.js',
  'website/games/game.css',
  'website/games/gameClientCore.js',
  'website/games/gameClient.js',
  'website/games/tetris/index.html',
  'website/games/number-match/index.html',
  'website/games/sudoku/index.html',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readWorkerBase(html, pageName) {
  const match = html.match(/<meta name="xiaoji-api-base" content="([^"]+)" \/>/);
  assert(match, `${pageName} must declare the public status Worker base`);
  return match[1];
}

for (const file of requiredFiles) {
  assert(fs.existsSync(path.join(root, file)), `Missing website file: ${file}`);
}

const html = read('website/index.html');
const css = read('website/styles.css');
const app = read('website/app.js');
const statusHtml = read('website/status.html');
const statusCss = read('website/status.css');
const statusData = read('website/statusData.js');
const publicFeatureCatalog = read('website/publicFeatureCatalog.js');
const statusApp = read('website/status.js');
const gameCore = read('website/games/gameClientCore.js');
const gameApp = read('website/games/gameClient.js');
const gameCss = read('website/games/game.css');
const gamePages = [
  read('website/games/tetris/index.html'),
  read('website/games/number-match/index.html'),
  read('website/games/sudoku/index.html'),
];

new vm.Script(app, { filename: 'website/app.js' });
new vm.Script(statusApp, { filename: 'website/status.js' });
new vm.Script(statusData, { filename: 'website/statusData.js' });
new vm.Script(publicFeatureCatalog, { filename: 'website/publicFeatureCatalog.js' });
new vm.Script(gameCore, { filename: 'website/games/gameClientCore.js' });
new vm.Script(gameApp, { filename: 'website/games/gameClient.js' });
assert(html.includes('lang="zh-Hant"'), 'Official website must declare Traditional Chinese');
assert(html.includes('data-metric="guilds"'), 'Official website must show adopted guild count');
assert(html.includes('data-metric="interactions"'), 'Official website must show usage frequency');
assert(html.includes('今日互動'), 'Official website must label calendar-day usage without false rolling precision');
assert(html.includes('data-metric="status"'), 'Official website must show current status');
assert(html.includes('./status.html'), 'Official website must link to the realtime status page');
assert(html.includes('小吉'), 'Official website must consistently identify Xiaoji');
assert(css.includes('@media (max-width: 620px)'), 'Official website must include a mobile layout');
assert(css.includes('prefers-reduced-motion'), 'Official website must respect reduced-motion preferences');
assert(app.includes('/overview'), 'Official website must load the public overview endpoint');
assert(readWorkerBase(html, 'Official website') === publicStatusWorkerBase, 'Official website must use the deployed Worker base');
assert(`${readWorkerBase(html, 'Official website')}/api/public/overview` === `${publicStatusWorkerBase}/api/public/overview`, 'Official website must compose the Worker overview URL');
assert(app.includes('${getWorkerBase()}/api/public/overview'), 'Official website must not fall back to a same-origin public API');
assert(app.includes('todayInteractions'), 'Official website must use the Taipei calendar-day usage aggregate');
assert(!app.includes('last24hInteractions'), 'Official website must not claim unsupported rolling 24-hour precision');
assert(app.includes('schemaVersion !== 1'), 'Official website must fail closed on unknown API schema');
assert((html + app).includes('小吉不會用猜測的數字'), 'Official website must disclose unavailable live data');
assert(!/guildId|userId|discordId|ownerId/.test(html + app), 'Public website must not expose raw Discord identifiers');
assert(statusHtml.includes('正常'), 'Status website must explain the normal state');
assert(statusHtml.includes('維護中'), 'Status website must explain the maintenance state');
assert(statusHtml.includes('損壞'), 'Status website must explain the broken state');
assert(statusApp.includes('/status'), 'Status website must load the public status endpoint');
assert(readWorkerBase(statusHtml, 'Status website') === publicStatusWorkerBase, 'Status website must use the deployed Worker base');
assert(`${readWorkerBase(statusHtml, 'Status website')}/api/public/status` === `${publicStatusWorkerBase}/api/public/status`, 'Status website must compose the Worker status URL');
assert(statusApp.includes('${getWorkerBase()}/api/public/status'), 'Status website must not fall back to a same-origin public API');
assert(statusHtml.indexOf('statusData.js') < statusHtml.indexOf('publicFeatureCatalog.js'), 'Status data loader must load before the public catalog');
assert(statusHtml.indexOf('publicFeatureCatalog.js') < statusHtml.indexOf('status.js'), 'Public catalog must load before status rendering');
assert(statusData.includes('activeController !== controller'), 'Status loader must ignore stale responses');
assert(publicFeatureCatalog.includes('PUBLIC_SYSTEM_CATALOG'), 'Status website must define a static public system catalog');
assert(publicFeatureCatalog.includes('僅限機器人擁有者使用'), 'Public catalog must disclose owner-only music limits');
assert(publicFeatureCatalog.includes('棋盤與推理遊戲'), 'Public catalog must include the approved board and deduction games');
assert(publicFeatureCatalog.includes('/fortune') && publicFeatureCatalog.includes('/roll'), 'Public catalog must include the public fortune and dice commands');
assert(publicFeatureCatalog.includes('個人記憶僅供本人查詢'), 'Public catalog must disclose private memory visibility');
assert(publicFeatureCatalog.includes('新商品不能附 Discord 身分組'), 'Public catalog must disclose global shop role restrictions');
assert(publicFeatureCatalog.includes('商品上架與調整僅限小吉擁有者'), 'Public catalog must disclose owner-only global shop changes');
assert(publicFeatureCatalog.includes('一般使用者可查看自己的帳務與目前利率'), 'Public catalog must preserve public bank rate visibility');
assert(publicFeatureCatalog.includes('一般使用者可借款、還款並查看自己的賭場借款'), 'Public catalog must preserve player casino loan access');
assert(publicFeatureCatalog.includes('/coin-db status 僅限小吉擁有者'), 'Public catalog must disclose owner-only coin database status');
assert(publicFeatureCatalog.includes('/economy leaderboard 可公開查看'), 'Public catalog must preserve public economy leaderboard access');
assert(publicFeatureCatalog.includes('xiaoji-formal'), 'Public catalog must use the formal public release source');
assert(html.includes(publicReleasesUrl), 'Official website must provide a navigable formal release link');
assert(publicFeatureCatalog.includes('官網的「公開版本資訊」連結'), 'Public catalog must describe the formal release link');
assert(statusApp.includes('replaceChildren'), 'Status website must render remote data without HTML injection');
assert(!/innerHTML|outerHTML|insertAdjacentHTML/.test(statusApp), 'Status website must not inject remote HTML');
assert(statusCss.includes('@media (max-width: 620px)'), 'Status website must include a mobile layout');
assert(!/guildId|userId|discordId|ownerId/.test(statusHtml + statusApp), 'Status website must not expose raw Discord identifiers');
assert(!/guildId|userId|discordId|ownerId/.test(publicFeatureCatalog), 'Public catalog must not expose raw Discord identifiers');
assert(gamePages.every((page) => page.includes('lang="zh-Hant"')), 'All game pages must declare Traditional Chinese');
assert(gamePages.every((page) => page.includes('gameClientCore.js') && page.includes('gameClient.js')), 'All game pages must use the secure shared client');
assert(gameCore.includes('consumeLaunchToken') && gameCore.includes('historyLike.replaceState'), 'Game token must be consumed from the fragment and removed');
assert(gameCore.includes("'/session/exchange'") && gameCore.includes("'/action'"), 'Game client must use only the authoritative action API');
assert(!/innerHTML|outerHTML|insertAdjacentHTML/.test(gameCore + gameApp), 'Game pages must not inject remote HTML');
assert(!/guildId|userId|discordId|ownerId/.test(gamePages.join('') + gameCore + gameApp), 'Game pages must not expose Discord identifiers');
assert(!/score\s*:|reward\s*:/.test(gameCore), 'Game API requests must not submit score or reward fields');
assert(gameCss.includes('@media (max-width:520px)'), 'Game website must include a mobile layout');
assert(gameCss.includes('prefers-reduced-motion'), 'Game website must respect reduced-motion preferences');

const hero = fs.statSync(path.join(root, 'website/assets/xiaoji-hero.png'));
assert(hero.size >= 20_000, 'Xiaoji hero artwork appears to be missing or incomplete');

console.log('Official website checks passed.');
