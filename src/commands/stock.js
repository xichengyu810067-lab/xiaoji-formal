const { AttachmentBuilder, SlashCommandBuilder } = require('discord.js');
const { DISCLAIMER, MarketDataError, formatQuote, getMarketData } = require('../systems/stocks/marketData');
const { renderStockChartPng } = require('../systems/stocks/stockChart');
const {
  MAX_WATCHLIST,
  addToWatchlist,
  isWatchlistAvailable,
  listWatchlist,
  removeFromWatchlist,
} = require('../systems/stocks/watchlist');
const { sanitizeUserFacingOutput } = require('../systems/conversation/userFacingOutputPolicy');
const logger = require('../utils/logger');

// /stock: quotes, the last month's trend chart and a personal watchlist of Taiwan stocks and ETFs (listed and OTC),
// US stocks and ETFs, and crypto (src/systems/stocks). Market data for reference, never investment advice.
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });
const UNAVAILABLE = '報價資料暫時無法取得，請稍後再試。';

function symbolOption(option) {
  return option.setName('symbol').setDescription('代號或名稱，例如 2330、台積電、0050、AAPL、QQQ、BTC').setRequired(true).setMaxLength(30);
}

function errorText(error) {
  if (error instanceof MarketDataError) return error.message;
  logger.warn(`[STOCK] code=STOCK_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
  return UNAVAILABLE;
}

function safe(text, interaction) {
  return sanitizeUserFacingOutput(text, { context: { actorId: interaction.user?.id, guildId: interaction.guildId, channelId: interaction.channelId } });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stock')
    .setDescription('查詢台股、美股、ETF 與加密貨幣報價')
    .addSubcommand((subcommand) => subcommand.setName('quote').setDescription('查詢即時報價').addStringOption(symbolOption))
    .addSubcommand((subcommand) => subcommand.setName('chart').setDescription('查看近一個月走勢圖').addStringOption(symbolOption))
    .addSubcommand((subcommand) => subcommand.setName('watchlist').setDescription('查看自選股清單的報價'))
    .addSubcommand((subcommand) => subcommand.setName('watch-add').setDescription('把股票加入自選股清單').addStringOption(symbolOption))
    .addSubcommand((subcommand) => subcommand.setName('watch-remove').setDescription('把股票移出自選股清單').addStringOption(symbolOption)),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const market = getMarketData();
    const personal = subcommand.startsWith('watch');
    await interaction.deferReply({ ephemeral: personal });
    const answer = (content, extra = {}) => interaction.editReply({ content: safe(content, interaction), allowedMentions: NO_MENTIONS, ...extra });

    try {
      if (subcommand === 'quote') {
        const quote = await market.quote(interaction.options.getString('symbol', true));
        await answer(`${formatQuote(quote)}\n${DISCLAIMER}`);
        return;
      }
      if (subcommand === 'chart') {
        const history = await market.history(interaction.options.getString('symbol', true));
        const png = renderStockChartPng(history);
        if (!png) {
          await answer(`${formatQuote(history.quote)}\n目前沒有走勢資料。\n${DISCLAIMER}`);
          return;
        }
        await answer(`${formatQuote(history.quote)}\n${DISCLAIMER}`, {
          files: [new AttachmentBuilder(png, { name: `stock-${history.quote.symbol.replace(/[^A-Za-z0-9]/gu, '_')}.png` })],
        });
        return;
      }

      if (!isWatchlistAvailable()) {
        await answer('自選股清單目前沒有開啟。');
        return;
      }
      const userId = interaction.user.id;
      if (subcommand === 'watch-add' || subcommand === 'watch-remove') {
        const target = await market.resolve(interaction.options.getString('symbol', true));
        if (subcommand === 'watch-remove') {
          const removed = await removeFromWatchlist(userId, target.symbol);
          await answer(removed ? `已把 ${target.symbol} 移出自選股清單。` : `${target.symbol} 不在你的自選股清單裡。`);
          return;
        }
        // Checked before it is kept, so the list holds only symbols that really have a quote.
        const quote = await market.quote(target.symbol);
        const result = await addToWatchlist(userId, target.symbol);
        await answer(result.added ? `已把 ${quote.name}（${target.symbol}）加入自選股清單。`
          : result.reason === 'full' ? `自選股清單最多 ${MAX_WATCHLIST} 檔，請先用 /stock watch-remove 移除一些。`
            : `${target.symbol} 已經在你的自選股清單裡。`);
        return;
      }
      // watchlist
      const symbols = await listWatchlist(userId);
      if (!symbols?.length) {
        await answer('你的自選股清單是空的，用 /stock watch-add 加入想關注的股票。');
        return;
      }
      const lines = [];
      for (const symbol of symbols) {
        try {
          const quote = await market.quote(symbol);
          const sign = quote.change > 0 ? '▲' : quote.change < 0 ? '▼' : '—';
          const percent = quote.changePercent === null ? '' : `（${Math.abs(quote.changePercent).toFixed(2)}%）`;
          lines.push(`**${quote.name}（${quote.symbol}）** ${quote.price ?? '—'} ${quote.currency} ${sign}${percent}`);
        } catch (error) {
          lines.push(`**${symbol}**：${errorText(error)}`);
        }
      }
      await answer(['**你的自選股**', ...lines, DISCLAIMER].join('\n'));
    } catch (error) {
      await answer(errorText(error));
    }
  },
};
