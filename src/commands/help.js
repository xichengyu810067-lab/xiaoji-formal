const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const commandCatalog = require('../../website/commandCatalog');
const { GAME_CATALOG } = require('../../website/gameCatalog');

// Discord allows 1024 characters per embed field value; stay below it.
const FIELD_VALUE_LIMIT = 1000;
const ADMIN_MARKER = '需管理權限';
const ADMIN_SUBCOMMANDS_LABEL = '管理子指令';

const gameNames = GAME_CATALOG.map((game) => game.name.replace(/（.*$/u, '')).join('、');

// Usage hints that the Discord description does not carry. Keys must be commands that
// the catalog lists in /help; test/commandCatalog.test.js enforces that. Keep command
// mentions in plain text (no backticks) because backticks mark a usage line.
const HELP_NOTES = Object.freeze({
  weather: '可查城市或臺灣縣市行政區',
  'chat-style': '永久變更，跨伺服器共用',
  daily: '依台灣日期每日一次，跨伺服器共用',
  inventory: '跨伺服器共用',
  leaderboard: '用 type 切換；總資產固定顯示前 25 名',
  shop: '購買請用 /shop buy',
  work: '目前不開放辭職（cancel 只顯示說明），工作期滿後自動結算',
  'coin-admin': 'history 指定 campaign-id 的活動對帳限小吉擁有者',
  board: `開始或查看遊戲：${gameNames}；加入、離開或結束適用的公開桌遊與推理遊戲；/board stop 也能結束你自己的個人遊戲`,
  'word-chain': '開局請用 /board start',
  'number-chain': '開局請用 /board start',
  'daily-riddle': '加入或開啟當日題目請用 /board start',
});

// Owner-only commands are never shown, whatever listInHelp says.
function isListedInHelp(command) {
  return command.listInHelp === true && command.audience !== 'owner';
}

function formatUsage(name, subcommands) {
  return subcommands.length > 0 ? `/${name} ${subcommands.join('/')}` : `/${name}`;
}

function joinText(parts) {
  return parts.filter(Boolean).join('；');
}

// One command becomes one line for what members can use and, when it has any, a second line for
// the subcommands that need a server permission. Owner-only subcommands are never shown.
// A command that is admin-only as a whole gets a single line marked as such.
function buildCommandLines(command) {
  const note = HELP_NOTES[command.name];
  if (!Array.isArray(command.subcommands) || command.subcommands.length === 0) {
    return [{
      name: command.name,
      audience: command.audience,
      usage: formatUsage(command.name, []),
      text: joinText([command.description, note, command.audience === 'admin' ? ADMIN_MARKER : null]),
    }];
  }

  const memberSubcommands = commandCatalog.listSubcommands(command, 'public');
  const adminSubcommands = commandCatalog.listSubcommands(command, 'admin');
  const lines = [];
  if (memberSubcommands.length > 0) {
    lines.push({
      name: command.name,
      audience: 'public',
      usage: formatUsage(command.name, memberSubcommands),
      text: joinText([command.description, note]),
    });
  }
  if (adminSubcommands.length > 0) {
    lines.push({
      name: command.name,
      audience: 'admin',
      usage: formatUsage(command.name, adminSubcommands),
      text: memberSubcommands.length > 0
        ? joinText([ADMIN_SUBCOMMANDS_LABEL, ADMIN_MARKER])
        : joinText([command.description, note, ADMIN_MARKER]),
    });
  }
  return lines;
}

// Builds the help content from the catalog: groups in catalog order, commands in catalog order.
function buildHelpSections(catalog = commandCatalog) {
  return catalog.COMMAND_GROUPS
    .map((group) => ({
      id: group.id,
      title: group.title,
      entries: catalog.COMMAND_CATALOG
        .filter((command) => command.group === group.id && isListedInHelp(command))
        .flatMap((command) => buildCommandLines(command)),
    }))
    .filter((section) => section.entries.length > 0);
}

function buildHelpEmbed(catalog = commandCatalog) {
  const embed = new EmbedBuilder()
    .setTitle('小吉指令說明')
    .setDescription(`以下是公開版本目前可用的指令。標示「${ADMIN_MARKER}」的指令或子指令只有具備對應權限的成員能使用。`)
    .setColor(0x57a6ff);

  for (const section of buildHelpSections(catalog)) {
    let chunk = '';
    let part = 1;
    for (const { usage, text } of section.entries) {
      const line = `\`${usage}\` - ${text}\n`;
      if (chunk && chunk.length + line.length > FIELD_VALUE_LIMIT) {
        embed.addFields({ name: part === 1 ? section.title : `${section.title} ${part}`, value: chunk.trim() });
        chunk = '';
        part += 1;
      }
      chunk += line;
    }
    if (chunk) embed.addFields({ name: part === 1 ? section.title : `${section.title} ${part}`, value: chunk.trim() });
  }
  return embed;
}

function buildHelpReply(catalog = commandCatalog) {
  return { embeds: [buildHelpEmbed(catalog)], ephemeral: true };
}

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('列出小吉可用指令'),
  async execute(interaction) {
    await interaction.reply(buildHelpReply());
  },
  ADMIN_MARKER,
  HELP_NOTES,
  buildHelpEmbed,
  buildHelpReply,
  buildHelpSections,
};
