const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPublicExportPlan } = require('../scripts/create-public-export');

// 遊戲系統只有一個根目錄 src/systems/games。舊的 src/games 轉接層在所有呼叫者改指向 src/systems 後已刪除；
// 棋盤、單人遊戲與股票圖的字型改放在 assets/fonts。
const projectRoot = path.join(__dirname, '..');
const fontDirectory = path.join(projectRoot, 'assets', 'fonts');

function toPosix(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

test('舊的 src/games 轉接層已刪除，也不在公開匯出清單內', () => {
  assert.equal(fs.existsSync(path.join(projectRoot, 'src', 'games')), false);
  const exported = buildPublicExportPlan();
  assert.deepEqual(exported.filter((file) => file.startsWith('src/games/')), []);
});

test('棋盤、單人遊戲與股票圖用的字型都在 assets/fonts，且連同授權檔一起公開匯出', () => {
  const { FONT_FILES } = require('../src/systems/games/board/renderer/svgBoardRenderer');
  // soloPresenter 與 stockChart 沒有匯出自己的字型路徑，所以明確補上它們用的 Cubic_11.ttf。
  const fonts = [...FONT_FILES, path.join(fontDirectory, 'Cubic_11.ttf')];
  const exported = new Set(buildPublicExportPlan());
  for (const font of fonts) {
    assert.equal(path.dirname(font), fontDirectory, `字型必須放在 assets/fonts：${toPosix(font)}`);
    assert.ok(fs.existsSync(font), `字型檔不存在：${toPosix(font)}`);
    assert.ok(exported.has(toPosix(font)), `公開匯出清單缺少字型：${toPosix(font)}`);
  }
  for (const licence of ['Cubic_11-OFL.txt', 'NotoSansSymbols-OFL.txt', 'NotoSansSymbols2-OFL.txt']) {
    assert.ok(exported.has(`assets/fonts/${licence}`), `公開匯出清單缺少授權檔：${licence}`);
  }
  for (const file of ['src/systems/games/soloPresenter.js', 'src/systems/stocks/stockChart.js']) {
    const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    assert.match(source, /'assets', 'fonts', 'Cubic_11\.ttf'/u, `${file} 從 assets/fonts 讀字型`);
  }
});
