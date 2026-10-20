const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPublicExportPlan } = require('../scripts/create-public-export');

// 遊戲系統只留一個根目錄 src/systems/games。
// src/games 底下原本有 6 個真正的模組，現在搬到 src/systems/games/board/core。
// 舊路徑保留成一行轉接檔，所以任何舊的 require 路徑拿到的都是同一個物件。
const projectRoot = path.join(__dirname, '..');
const legacyRoot = path.join(projectRoot, 'src', 'games');
const systemsGamesRoot = path.join(projectRoot, 'src', 'systems', 'games');
const coreRoot = path.join(systemsGamesRoot, 'board', 'core');

const MOVED_CORE_MODULES = Object.freeze([
  'boardLifecycle',
  'boardRuntimeRegistry',
  'boardSessionService',
  'contracts',
  'engineRegistry',
  'trustedSystemActions',
]);

// 兩種轉接檔格式：一行的 module.exports，以及命令列入口 turtleSoup/buildIndexCli 的三行寫法。
const ONE_LINE_ADAPTER = /^module\.exports = require\('([^']+)'\);\n$/u;
const CLI_ADAPTER = /^const implementation = require\('([^']+)'\);\nif \(require\.main === module\) process\.exitCode = implementation\.main\(\);\nmodule\.exports = implementation;\n$/u;

function toPosix(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// 讀出轉接檔指向的路徑；不是轉接檔就回傳 null。
function readAdapterTarget(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = ONE_LINE_ADAPTER.exec(source) || CLI_ADAPTER.exec(source);
  return match ? match[1] : null;
}

// src/games 底下所有 .js；字型這類資產目錄不算程式。
function listLegacyJavaScript(directory = legacyRoot) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'assets' ? [] : listLegacyJavaScript(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('搬到 board/core 的 6 個模組：舊路徑與新路徑 require 出來的是同一個物件', () => {
  for (const name of MOVED_CORE_MODULES) {
    const legacy = require(path.join(legacyRoot, name));
    const moved = require(path.join(coreRoot, name));
    // 循環載入會讓人拿到空物件，所以先確認新路徑真的有匯出內容，再比對是不是同一個物件。
    assert.ok(Object.keys(moved).length > 0, `${name} 的新路徑沒有匯出任何東西`);
    assert.strictEqual(legacy, moved, `${name} 的舊路徑與新路徑必須匯出同一個物件`);
  }
});

test('新位置放真正的實作，舊位置是固定格式的一行轉接檔', () => {
  for (const name of MOVED_CORE_MODULES) {
    const moved = path.join(coreRoot, `${name}.js`);
    const legacy = path.join(legacyRoot, `${name}.js`);
    assert.equal(readAdapterTarget(moved), null, `${toPosix(moved)} 不應該是轉接檔`);
    assert.ok(ONE_LINE_ADAPTER.test(fs.readFileSync(legacy, 'utf8')), `${toPosix(legacy)} 必須是只有一行的轉接檔`);
    assert.equal(readAdapterTarget(legacy), `../systems/games/board/core/${name}`, `${toPosix(legacy)} 必須指向 board/core`);
  }
});

test('board/core 的模組不會載入 src/games 底下的舊路徑，避免舊、新、舊的循環載入', () => {
  for (const name of MOVED_CORE_MODULES) {
    const file = path.join(coreRoot, `${name}.js`);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/gu)) {
      const request = match[2];
      if (!request.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), request);
      assert.ok(!isInside(legacyRoot, resolved), `${toPosix(file)} 不可載入舊路徑 ${request}`);
    }
  }
});

test('src/games 底下每個 .js 都是轉接檔，指向 src/systems/games，且和新路徑是同一個物件', () => {
  const files = listLegacyJavaScript();
  assert.ok(files.length > MOVED_CORE_MODULES.length, '應該掃得到 src/games 底下所有的舊路徑檔案');
  for (const file of files) {
    const target = readAdapterTarget(file);
    assert.notEqual(target, null, `${toPosix(file)} 不是轉接檔：src/games 底下不再放真正的模組`);
    const resolved = path.resolve(path.dirname(file), target);
    assert.ok(isInside(systemsGamesRoot, resolved), `${toPosix(file)} 必須指向 src/systems/games：${target}`);
    assert.ok(fs.existsSync(`${resolved}.js`), `${toPosix(file)} 指向的檔案不存在：${target}`);
    assert.strictEqual(require(file), require(resolved), `${toPosix(file)} 與新路徑必須匯出同一個物件`);
  }
});

test('公開匯出清單同時包含 6 個舊轉接檔與 6 個新模組', () => {
  const exported = new Set(buildPublicExportPlan());
  for (const name of MOVED_CORE_MODULES) {
    assert.ok(exported.has(`src/games/${name}.js`), `匯出清單缺少舊轉接檔 src/games/${name}.js`);
    assert.ok(exported.has(`src/systems/games/board/core/${name}.js`), `匯出清單缺少新模組 board/core/${name}.js`);
  }
});

test('字型目錄沒有搬動：棋盤與單人遊戲用 __dirname 推導的字型路徑仍存在，且都在公開匯出清單內', () => {
  const fontDirectory = path.join(legacyRoot, 'assets', 'fonts');
  const { FONT_FILES } = require('../src/systems/games/board/renderer/svgBoardRenderer');
  // soloPresenter 沒有匯出自己的字型路徑，所以明確補上它用的 Cubic_11.ttf。
  const fonts = [...FONT_FILES, path.join(fontDirectory, 'Cubic_11.ttf')];
  const exported = new Set(buildPublicExportPlan());
  for (const font of fonts) {
    assert.ok(isInside(fontDirectory, font), `字型必須留在 src/games/assets/fonts：${toPosix(font)}`);
    assert.ok(fs.existsSync(font), `字型檔不存在：${toPosix(font)}`);
    assert.ok(exported.has(toPosix(font)), `公開匯出清單缺少字型：${toPosix(font)}`);
  }
});
