const { SlashCommandBuilder } = require('discord.js');
const { getAllBalanceSummaries } = require('../services/bankService');
const { CoinServiceError, getGuildCoinSettings, getLeaderboard } = require('../services/coinService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

const LEADERBOARD_COINS = 'coins';
const LEADERBOARD_ASSETS = 'assets';
// Coin balances are paged ten to a page, and the rank of a row follows its real place in that order.
const COIN_PAGE_SIZE = 10;
// getAllBalanceSummaries has no paging and never returns more than 25 rows, so the assets board
// is always the top 25.
const ASSETS_BOARD_SIZE = 25;
// What getLeaderboard says when the guild turned its coin system off. The assets board refuses the
// same way, so neither board shows anything for a guild that has the coin system off.
const COIN_DISABLED_MESSAGE = '這個伺服器的吉幣系統目前停用。';

// Looks up the Discord user behind each row so bots can be left out. A row whose user cannot be
// fetched stays on the board and is shown by id. position is the row's place in the order the service
// returned, so a skipped bot leaves a gap in the ranks instead of shifting everyone after it.
async function withoutBots(interaction, rows) {
  const users = await Promise.all(rows.map((row) => interaction.client.users.fetch(row.userId).catch(() => null)));
  return rows
    .map((row, position) => ({ row, user: users[position], position }))
    .filter(({ user }) => !user?.bot);
}

// Boards name people with mentions so the names are clickable, but a leaderboard must never ping them.
function boardReply(content, extra = {}) {
  return { content, allowedMentions: { parse: [] }, ...extra };
}

function nameOf(user, userId) {
  return user ? `${user}` : `<@${userId}>`;
}

// Coin balances, paged: the board is public, an empty board is a private notice.
async function replyCoinBoard(interaction) {
  const page = interaction.options.getInteger('page') || 1;
  const leaderboard = await getLeaderboard(interaction.guildId, { page, limit: COIN_PAGE_SIZE });
  const visible = await withoutBots(interaction, leaderboard.players);

  if (visible.length === 0) {
    await interaction.reply(boardReply('目前還沒有吉幣排行榜資料。', { ephemeral: true }));
    return;
  }

  // The service says which page and page size it really used, so a rank is the row's true offset + 1.
  const offset = ((leaderboard.page ?? page) - 1) * (leaderboard.limit ?? COIN_PAGE_SIZE);
  const lines = visible.map(({ row, user, position }) =>
    `${offset + position + 1}. ${nameOf(user, row.userId)} - ${formatCoins(row.balance)}（連續 ${row.dailyStreak} 天）`);

  await interaction.reply(boardReply([`**${interaction.guild.name} 吉幣排行榜**`, ...lines].join('\n')));
}

// Total assets (wallet, bank and fixed deposits), top 25 only: the board is public, and so is the
// notice when there is no data. Each line is short so that 25 of them always fit in one message.
async function replyAssetsBoard(interaction) {
  // getAllBalanceSummaries does not look at the guild's settings, so check them first. A guild with the
  // coin system off is still refused with the private reply below, before anything is acknowledged.
  const settings = await getGuildCoinSettings(interaction.guildId);
  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', COIN_DISABLED_MESSAGE);
  }

  // withoutBots may look up 25 users. With a cold cache each lookup is a network request, and requests
  // to the same route are sent one at a time, so the lookups alone can outlast the three seconds Discord
  // gives a command to answer. Acknowledge the command first, publicly like the board itself. From here
  // on the answer is an editReply, and an error is shown by replyCoinError, which edits the reply of a
  // command that was already acknowledged.
  await interaction.deferReply();

  const rows = await getAllBalanceSummaries(interaction.guildId, { limit: ASSETS_BOARD_SIZE });
  const visible = await withoutBots(interaction, rows);

  if (visible.length === 0) {
    await interaction.editReply(boardReply('目前沒有經濟資料。'));
    return;
  }

  const lines = visible.map(({ row, user, position }) =>
    `${position + 1}. ${nameOf(user, row.userId)} - ${formatCoins(row.totalAssets)}`);

  await interaction.editReply(boardReply([`**${interaction.guild.name} 總資產排行榜**`, ...lines].join('\n')));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('查看吉幣餘額或總資產排行榜')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('排行榜類型；未填為吉幣餘額')
        .addChoices(
          { name: '吉幣餘額（coins，預設）', value: LEADERBOARD_COINS },
          { name: '總資產（assets）', value: LEADERBOARD_ASSETS }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('頁數（每頁 10 名）；只適用吉幣餘額，總資產固定顯示前 25 名')
        .setMinValue(1)
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '排行榜只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const type = interaction.options.getString('type') || LEADERBOARD_COINS;

      if (type === LEADERBOARD_ASSETS) {
        await replyAssetsBoard(interaction);
        return;
      }

      await replyCoinBoard(interaction);
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
