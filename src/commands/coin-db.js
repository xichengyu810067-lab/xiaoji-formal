const { SlashCommandBuilder } = require('discord.js');
const { getCoinDatabaseStats } = require('../services/coinService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coin-db')
    .setDescription('查看吉幣資料庫狀態，限 owner')
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('顯示資料庫狀態')),

  async execute(interaction) {
    try {
      if (!(await ensureBotOwner(interaction))) {
        return;
      }

      const stats = await getCoinDatabaseStats(interaction.guildId);
      const lastTransaction = stats.lastTransaction
        ? `#${stats.lastTransaction.id} ${stats.lastTransaction.type} ${stats.lastTransaction.createdAt}`
        : '沒有交易紀錄';

      await interaction.reply({
        content: [
          '**吉幣資料庫狀態**',
          `路徑：${stats.databaseInfo.path}`,
          `檔案存在：${stats.databaseInfo.exists ? '是' : '否'}`,
          `本次啟動前已存在：${stats.databaseInfo.existed ? '是' : '否'}`,
          `本次是否新建資料庫：${stats.databaseInfo.createdDatabase ? '是' : '否'}`,
          `Schema version：${stats.databaseInfo.schemaVersion}`,
          `玩家資料數：${stats.players}`,
          `商品數：${stats.shopItems}`,
          `交易紀錄數：${stats.transactions}`,
          `購買紀錄數：${stats.purchases}`,
          `管理操作紀錄數：${stats.adminLogs}`,
          `最近交易：${lastTransaction}`,
          stats.settings ? `目前伺服器吉幣系統：${stats.settings.enabled ? '啟用' : '停用'}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
