const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  FIXED_TERMS,
  MIN_FIXED_DEPOSIT,
  cancelFixedDeposit,
  claimFixedDeposit,
  createFixedDeposit,
  deposit,
  getAllBalanceSummaries,
  getBalanceSummary,
  getBankRates,
  getRateHistory,
  listFixedDeposits,
  readBalanceSummary,
  setDemandRate,
  setFixedRate,
  withdraw,
} = require('../services/bankService');
const { ensureModerationAccess } = require('../utils/moderation');
const { reportInteractionSecurityAlert } = require('../utils/securityAlert');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { formatCoins, formatFixedDepositStatus, formatMemberName, formatRateKey, replyCoinError } = require('../utils/coinPresentation');
const { fitListText, omittedLine } = require('../utils/replyLengthGuard');

const sourceLabels = Object.freeze({ wallet: '錢包', bank: '活存' });

function formatRate(rate) {
  return `${(Number(rate || 0) * 100).toFixed(4)}%`;
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:F>`;
}

function formatBalance(summary) {
  return [
    `使用者：<@${summary.userId}>`,
    `錢包吉幣：${formatCoins(summary.walletBalance)}`,
    `活存金額：${formatCoins(summary.bankBalance)}`,
    `活存小數利息：${Number(summary.interestRemainder || 0).toFixed(4)} 吉幣`,
    `定存本金：${formatCoins(summary.fixedPrincipal)}`,
    `定存預估利息：${formatCoins(summary.fixedExpectedInterest)}`,
    `已到期可領：${formatCoins(summary.fixedClaimable)}`,
    `總資產：${formatCoins(summary.totalAssets)}`,
  ].join('\n');
}

function formatFixedDeposit(item) {
  const lines = [
    `#${item.id} <@${item.userId}>`,
    `本金：${formatCoins(item.principal)}｜期間：${item.termDays} 天｜利率：${formatRate(item.rate)}`,
    `狀態：${formatFixedDepositStatus(item.displayStatus)}｜來源：${sourceLabels[item.source] || item.source}`,
    `建立：${formatTimestamp(item.createdAt)}｜到期：${formatTimestamp(item.maturityAt)}`,
  ];
  // A cancelled deposit no longer earns interest or pays anything out, so its estimate lines are left out.
  if (item.status !== 'cancelled') {
    lines.push(`預估利息：${formatCoins(item.expectedInterest)}｜可領合計：${formatCoins(item.claimableAmount)}`);
  }
  return lines.join('\n');
}

// A list of blocks (one per member or deposit) or lines (one per rate change) in one message. Nothing in a row is free
// text, so when the rows do not fit, the last ones are left out with a line that says how many and where to read them.
function rowsText({ header, rows, render, unit, hint, separator = '\n' }) {
  return fitListText({
    header,
    items: rows,
    render: (row) => render(row),
    separator,
    note: (count) => omittedLine(count, { unit, hint }),
  });
}

function formatRateList(rates) {
  return [
    `活存每日利率：${formatRate(rates.demandRate)}`,
    ...FIXED_TERMS.map((term) => `${term} 天定存整期利率：${formatRate(rates.fixedRates[term])}`),
    rates.activeEvents.length
      ? `活動利率：${rates.activeEvents
          .map((event) => `${formatRateKey(event.rateKey)} 到 ${formatTimestamp(event.eventEndsAt)}`)
          .join('；')}`
      : '活動利率：無',
  ].join('\n');
}

async function requireBankAdmin(interaction) {
  const access = await ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });

  return access.ok;
}

// Wallet, bank and fixed deposits are one person's global data, so a lookup of one user is only for a member of
// this server. Answers the command with the refusal and returns false when the user is not one.
async function requireGuildMember(interaction, user) {
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (member) {
    return true;
  }

  reportInteractionSecurityAlert('personal-data', interaction);
  await interaction.reply({ content: '只能查詢目前在此伺服器的成員。', ephemeral: true });
  return false;
}

const termChoices = FIXED_TERMS.map((term) => ({ name: `${term} 天`, value: term }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bank')
    .setDescription('小吉銀行：活存、定存與利率')
    .addSubcommand((subcommand) => subcommand.setName('balance').setDescription('查看自己的錢包、活存與定存概況'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('balance-user')
        .setDescription('管理員查看指定使用者銀行概況')
        .addUserOption((option) => option.setName('user').setDescription('要查詢的使用者').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('balance-all')
        .setDescription('管理員查看所有人的銀行概況')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('deposit')
        .setDescription('將錢包吉幣存入活存')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('存入金額').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('withdraw')
        .setDescription('從活存領出到錢包')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('領出金額').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('interest').setDescription('查看目前活存利率與規則'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('fixed-create')
        .setDescription('建立定存')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription(`最低 ${MIN_FIXED_DEPOSIT} 吉幣`).setRequired(true).setMinValue(MIN_FIXED_DEPOSIT)
        )
        .addIntegerOption((option) =>
          option.setName('term-days').setDescription('定存期間').setRequired(true).addChoices(...termChoices)
        )
        .addStringOption((option) =>
          option
            .setName('source')
            .setDescription('扣款來源')
            .addChoices({ name: '錢包', value: 'wallet' }, { name: '活存', value: 'bank' })
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('fixed-list').setDescription('查看自己的定存'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('fixed-user')
        .setDescription('管理員查看指定使用者定存')
        .addUserOption((option) => option.setName('user').setDescription('要查詢的使用者').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('fixed-all')
        .setDescription('管理員查看所有人的定存')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('fixed-claim')
        .setDescription('領取已到期定存')
        .addIntegerOption((option) => option.setName('fixed-id').setDescription('定存 ID').setRequired(true).setMinValue(1))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('fixed-cancel')
        .setDescription('提前解約定存')
        .addIntegerOption((option) => option.setName('fixed-id').setDescription('定存 ID').setRequired(true).setMinValue(1))
    )
    .addSubcommand((subcommand) => subcommand.setName('fixed-rates').setDescription('查看定存利率'))
    .addSubcommand((subcommand) => subcommand.setName('rate-list').setDescription('查看目前活存與定存利率'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('rate-set-demand')
        .setDescription('設定活存每日利率（限小吉擁有者）')
        .addNumberOption((option) =>
          option.setName('rate-percent').setDescription('百分比，例如 0.03 代表 0.03%').setRequired(true).setMinValue(0).setMaxValue(1)
        )
        .addIntegerOption((option) => option.setName('duration-days').setDescription('活動天數；不填代表永久').setMinValue(1).setMaxValue(365))
        .addStringOption((option) => option.setName('reason').setDescription('調整原因').setMaxLength(200))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('rate-set-fixed')
        .setDescription('設定定存整期利率（限小吉擁有者）')
        .addIntegerOption((option) => option.setName('term-days').setDescription('定存期間').setRequired(true).addChoices(...termChoices))
        .addNumberOption((option) =>
          option.setName('rate-percent').setDescription('百分比，例如 2 代表 2%').setRequired(true).setMinValue(0).setMaxValue(30)
        )
        .addIntegerOption((option) => option.setName('duration-days').setDescription('活動天數；不填代表永久').setMinValue(1).setMaxValue(365))
        .addStringOption((option) => option.setName('reason').setDescription('調整原因').setMaxLength(200))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('rate-history')
        .setDescription('管理員查看利率調整紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '銀行功能只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'balance') {
        const summary = await getBalanceSummary(interaction.guildId, interaction.user.id);
        await interaction.reply({ content: `**小吉銀行概況**\n${formatBalance(summary)}`, ephemeral: true });
        return;
      }

      if (subcommand === 'balance-user') {
        if (!(await requireBankAdmin(interaction))) return;
        const user = interaction.options.getUser('user', true);
        if (!(await requireGuildMember(interaction, user))) return;
        // Looking at somebody else must not file them under this guild, so the read-only summary is used.
        const summary = await readBalanceSummary(interaction.guildId, user.id);
        await interaction.reply({ content: `**使用者銀行概況**\n${formatBalance(summary)}`, ephemeral: true });
        return;
      }

      if (subcommand === 'balance-all') {
        if (!(await requireBankAdmin(interaction))) return;
        const rows = await getAllBalanceSummaries(interaction.guildId, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rowsText({
            header: '**全服銀行概況**',
            rows,
            render: formatBalance,
            unit: '位成員的概況',
            hint: '可用 /bank balance-user 查看指定成員',
            separator: '\n\n',
          }),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'deposit') {
        const amount = interaction.options.getInteger('amount', true);
        const result = await deposit(interaction.guildId, interaction.user.id, amount);
        await interaction.reply({
          content: `已存入 ${formatCoins(amount)}。\n錢包：${formatCoins(result.walletAfter)}\n活存：${formatCoins(result.bankAfter)}`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'withdraw') {
        const amount = interaction.options.getInteger('amount', true);
        const result = await withdraw(interaction.guildId, interaction.user.id, amount);
        await interaction.reply({
          content: `已領出 ${formatCoins(amount)}。\n錢包：${formatCoins(result.walletAfter)}\n活存：${formatCoins(result.bankAfter)}`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'interest' || subcommand === 'fixed-rates' || subcommand === 'rate-list') {
        const rates = await getBankRates(interaction.guildId);
        await interaction.reply({ content: `**目前銀行利率**\n${formatRateList(rates)}`, ephemeral: true });
        return;
      }

      if (subcommand === 'fixed-create') {
        const item = await createFixedDeposit(interaction.guildId, interaction.user.id, {
          amount: interaction.options.getInteger('amount', true),
          termDays: interaction.options.getInteger('term-days', true),
          source: interaction.options.getString('source') || 'wallet',
        });
        await interaction.reply({ content: `**定存建立成功**\n${formatFixedDeposit(item)}`, ephemeral: true });
        return;
      }

      if (subcommand === 'fixed-list') {
        const rows = await listFixedDeposits(interaction.guildId, { userId: interaction.user.id, limit: 10 });
        await interaction.reply({
          content: rows.length ? ['**你的定存列表**', ...rows.map(formatFixedDeposit)].join('\n\n') : '你目前沒有定存紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'fixed-user') {
        if (!(await requireBankAdmin(interaction))) return;
        const user = interaction.options.getUser('user', true);
        if (!(await requireGuildMember(interaction, user))) return;
        const rows = await listFixedDeposits(interaction.guildId, { userId: user.id, limit: 10 });
        await interaction.reply({
          content: rows.length
            ? [`**${formatMemberName(user, interaction.options.getMember?.('user'))} 的定存列表**`, ...rows.map(formatFixedDeposit)].join('\n\n')
            : '查無定存紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'fixed-all') {
        if (!(await requireBankAdmin(interaction))) return;
        const rows = await listFixedDeposits(interaction.guildId, { limit: interaction.options.getInteger('limit') || 10 });
        await interaction.reply({
          content: rows.length
            ? rowsText({
              header: '**全服定存列表**',
              rows,
              render: formatFixedDeposit,
              unit: '筆定存',
              hint: '可用 /bank fixed-user 查看指定成員的定存',
              separator: '\n\n',
            })
            : '查無定存紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'fixed-claim') {
        const item = await claimFixedDeposit(interaction.guildId, interaction.user.id, interaction.options.getInteger('fixed-id', true));
        await interaction.reply({
          content: `已領取定存 #${item.id}，本金與利息共 ${formatCoins(item.grossAmount)}；利息抵欠款 ${formatCoins(item.debtOffset)}，錢包入帳 ${formatCoins(item.paidAmount)}。\n目前錢包：${formatCoins(item.walletAfter)}`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'fixed-cancel') {
        const item = await cancelFixedDeposit(interaction.guildId, interaction.user.id, interaction.options.getInteger('fixed-id', true));
        await interaction.reply({
          content: `已提前解約定存 #${item.id}，本金與利息共 ${formatCoins(item.grossAmount)}，其中利息 ${formatCoins(item.interestPaid)}；利息抵欠款 ${formatCoins(item.debtOffset)}，錢包入帳 ${formatCoins(item.paidAmount)}。\n目前錢包：${formatCoins(item.walletAfter)}`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'rate-set-demand') {
        if (!(await ensureBotOwner(interaction))) return;
        const result = await setDemandRate(interaction.guildId, interaction.options.getNumber('rate-percent', true), {
          operatorId: interaction.user.id,
          reason: interaction.options.getString('reason') || '',
          durationDays: interaction.options.getInteger('duration-days'),
        });
        await interaction.reply({
          content: `活存利率已由 ${formatRate(result.oldRate)} 調整為 ${formatRate(result.newRate)}${result.eventEndsAt ? `，活動到 ${formatTimestamp(result.eventEndsAt)}` : ''}。`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'rate-set-fixed') {
        if (!(await ensureBotOwner(interaction))) return;
        const result = await setFixedRate(
          interaction.guildId,
          interaction.options.getInteger('term-days', true),
          interaction.options.getNumber('rate-percent', true),
          {
            operatorId: interaction.user.id,
            reason: interaction.options.getString('reason') || '',
            durationDays: interaction.options.getInteger('duration-days'),
          }
        );
        await interaction.reply({
          content: `定存利率已由 ${formatRate(result.oldRate)} 調整為 ${formatRate(result.newRate)}${result.eventEndsAt ? `，活動到 ${formatTimestamp(result.eventEndsAt)}` : ''}。`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'rate-history') {
        if (!(await requireBankAdmin(interaction))) return;
        const rows = await getRateHistory(interaction.guildId, { limit: interaction.options.getInteger('limit') || 10 });
        await interaction.reply({
          content: rows.length
            ? rowsText({
              header: '**利率調整紀錄**',
              rows,
              render: (row) =>
                `#${row.id} ${formatRateKey(row.rateKey)}：${formatRate(row.oldRate)} -> ${formatRate(row.newRate)}｜操作者 <@${row.operatorId}>｜${formatTimestamp(row.createdAt)}${row.isEvent ? `｜活動到 ${formatTimestamp(row.eventEndsAt)}` : ''}`,
              unit: '筆調整紀錄',
            })
            : '尚無利率調整紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
