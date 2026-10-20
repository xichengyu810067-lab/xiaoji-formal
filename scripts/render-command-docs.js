const fs = require('node:fs');
const path = require('node:path');
const defaultCatalog = require('../website/commandCatalog');
const { ADMIN_MARKER, buildHelpSections } = require('../src/commands/help');

const COMMAND_DOCS_PATH = path.resolve(__dirname, '..', 'docs', 'COMMANDS.md');

// Prose that belongs to a catalog group but cannot be derived from it. Keys are catalog group ids.
const GROUP_NOTES = Object.freeze({
  community: '活動設定沿用各指令既有的 Discord 權限檢查；它們不是私有伺服器管理模組。',
  economy: '具設定能力的子指令仍會檢查其既有 owner 或伺服器權限。工作資料可在所有伺服器運作；額外 Discord role 副作用由可選擴充決定。',
});

// docs/COMMANDS.md lists what /help lists, so the two never disagree: the catalog decides the
// commands, the subcommands and who may use them, and src/commands/help.js writes each line.
function renderCommandDocs(catalog = defaultCatalog) {
  const lines = [
    '# 公開指令',
    '',
    '<!-- 此檔由 scripts/render-command-docs.js 依 website/commandCatalog.js 產生；請修改目錄後執行 node scripts/render-command-docs.js，不要直接編輯。 -->',
    '',
    '公開指令以 global commands 部署，小吉所在的每個伺服器都能執行。',
    '',
    '- 子指令接在指令後面並以 `/` 分隔，例如 `/remind add/list/delete`。',
    `- 標示「${ADMIN_MARKER}」的指令或子指令，需具備 Manage Server 或 Administrator 權限（依指令而定）；小吉擁有者只在執行時不受此限，指令選單是否看得到仍取決於擁有者在該伺服器的權限。`,
    `- 整個指令都標示「${ADMIN_MARKER}」的，一般成員在指令選單看不到。`,
    '- 只供小吉擁有者使用的指令與子指令不列在此處。',
    '',
  ];
  for (const section of buildHelpSections(catalog)) {
    lines.push(`## ${section.title}`, '');
    for (const { usage, text } of section.entries) lines.push(`- \`${usage}\` - ${text}`);
    if (GROUP_NOTES[section.id]) lines.push('', GROUP_NOTES[section.id]);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function synchronizeCommandDocs({ docsPath = COMMAND_DOCS_PATH, catalog = defaultCatalog } = {}) {
  const rendered = renderCommandDocs(catalog);
  fs.writeFileSync(docsPath, rendered, 'utf8');
  console.log(`Synchronized ${path.basename(docsPath)} from the command catalog.`);
  return rendered;
}

if (require.main === module) synchronizeCommandDocs();

module.exports = { COMMAND_DOCS_PATH, renderCommandDocs, synchronizeCommandDocs };
