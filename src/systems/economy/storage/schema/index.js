// The coin database schema, put together from the table families in schema/<family>.js.
//
// schemaSql is executed on every open (CREATE ... IF NOT EXISTS), and again by several of the
// migrations. The order of its statements is the order the coin database has always used:
// every table first, then the indexes and triggers. Changing a table needs a migration and a new
// schemaVersion (see docs/ARCHITECTURE.md); scripts/check-project.js pins the version below.
const metadata = require('./metadata');
const economy = require('./economy');
const work = require('./work');
const casino = require('./casino');
const featurePlatform = require('./featurePlatform');
const conversation = require('./conversation');
const games = require('./games');
const releaseAnnouncements = require('./releaseAnnouncements');
const community = require('./community');

const schemaVersion = 24;

// Created by the v22 migration (global bank, chips, campaigns, primary work cycles, reward grants v2).
const globalEconomyV22Sql = `
${[
  economy.globalBankAndChipTablesV22Sql,
  featurePlatform.rewardGrantsV2TableSql,
  economy.operationAndCampaignTablesV22Sql,
  work.primaryJobAndLegacyWorkTablesV22Sql,
  games.discordGameTablesV22Sql,
  economy.globalEconomyMigrationsTableV22Sql,
  featurePlatform.rewardGrantsV2IndexesSql,
  economy.globalLedgerIndexesV22Sql,
].join('\n')}
`;

const schemaSql = `
PRAGMA foreign_keys = ON;

${[
  metadata.metadataTableSql,
  economy.walletShopAndBankTablesSql,
  work.jobTablesSql,
  casino.gameTablesSql,
  economy.casinoLoanTablesSql,
  casino.venueTablesSql,
  economy.chipAndLuxuryTablesSql,
  casino.lodgingAndDuelTowerTablesSql,
  featurePlatform.featureTablesSql,
  conversation.preferenceTablesSql,
  games.gameSessionTablesSql,
  releaseAnnouncements.releaseTablesSql,
  community.chainAndDailyEventTablesSql,
  economy.walletShopAndArchiveIndexesSql,
  work.jobIndexesSql,
  economy.bankIndexesSql,
  work.taskPayrollAndPenaltyIndexesSql,
  casino.gameIndexesSql,
  economy.casinoLoanIndexesSql,
  casino.venueIndexesSql,
  economy.chipAndLuxuryIndexesSql,
  casino.lodgingAndDuelTowerIndexesSql,
  featurePlatform.outboxIndexesSql,
  community.chainAndDailyEventIndexesSql,
  releaseAnnouncements.releaseIndexesSql,
  community.dailyEventMessageIndexesSql,
  featurePlatform.rewardAndUsageIndexesSql,
].join('\n\n')}
`;

module.exports = {
  schemaVersion,
  schemaSql,
  globalEconomyV22Sql,
  gameLaunchReceiptsV23Sql: games.gameLaunchReceiptsV23Sql,
  coinAdminAddConfirmationsV24Sql: economy.coinAdminAddConfirmationsV24Sql,
  wordChainActiveSessionIndexSql: community.wordChainActiveSessionIndexSql,
  numberChainActiveSessionIndexSql: community.numberChainActiveSessionIndexSql,
  globalWalletRevisionIndexSql: economy.globalWalletRevisionIndexSql,
};
