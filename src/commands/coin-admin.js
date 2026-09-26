const crypto = require('node:crypto');
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  adjustPlayerBalance,
  getTransactions,
  resetPlayerData,
  setGuildEconomyEnabled,
} = require('../services/coinService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { ensureModerationAccess } = require('../utils/moderation');
const { formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');
const { CoinCampaignError, applyOwnerCampaign, classifyOwnerCampaignHistoryRecord,
  getOwnerCampaignHistoryReviewPlan, getOwnerCampaignPreview, importOwnerCampaignHistory,
  previewOwnerCampaign, reviewOwnerCampaignHistory } = require('../services/coinCampaignService');

async function fetchCompleteMembers(guild) {
  const members = await guild.members.fetch();
  if (!members || members.size < guild.memberCount) {
    throw new CoinCampaignError('INCOMPLETE_MEMBER_FETCH', '無法取得完整成員名單，活動已停止。');
  }
  return [...members.values()];
}

function addUserAmountReasonOptions(subcommand, amountDescription, minValue = 1) {
  return subcommand
    .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    .addIntegerOption((option) =>
      option.setName('amount').setDescription(amountDescription).setRequired(true).setMinValue(minValue)
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('操作原因').setRequired(true).setMaxLength(300)
    );
}

function formatAdminResult(actionLabel, target, result, reason) {
  return [
    `${actionLabel}完成。`,
    `目標：${formatUser(target)}`,
    `原本餘額：${formatCoins(result.before)}`,
    `變動：${formatCoins(result.amount)}`,
    `最新餘額：${formatCoins(result.after)}`,
    `原因：${reason}`,
  ].join('\n');
}

const historicalRewardTypes = new Set(['admin_add', 'system_reward', 'event_reward']);

function hasHistoricalCandidates(plan, userId) {
  return plan.transactions.some((row) => row.user_id === userId && historicalRewardTypes.has(row.type)) ||
    plan.legacyGrants.some((row) => row.user_id === userId) ||
    plan.adminLogs.some((row) => row.target_user_id === userId);
}

function historyDecisions(plan, userIds, priorGrant = false, reviewReason = 'OWNER 已檢視來源') {
  return userIds.map((userId) => ({
    userId, priorGrant,
    reviewedTransactionIds: plan.transactions.filter((row) => row.user_id === userId).map((row) => row.id),
    reviewedLegacyGrantIds: plan.legacyGrants.filter((row) => row.user_id === userId).map((row) => row.id),
    reviewedAdminLogIds: plan.adminLogs.filter((row) => row.target_user_id === userId).map((row) => row.id),
    reviewReason,
  }));
}

function botReviewId(interaction, campaignId, sourceSha256) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([interaction.id || crypto.randomUUID(), campaignId, sourceSha256])).digest('hex');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coin-admin')
    .setDescription('管理吉幣系統（全域錢包變更限小吉擁有者）')
    .addSubcommand((subcommand) =>
      addUserAmountReasonOptions(subcommand.setName('add').setDescription('替使用者增加全域吉幣（限 owner）'), '增加數量').setName('add')
    )
    .addSubcommand((subcommand) =>
      addUserAmountReasonOptions(subcommand.setName('remove').setDescription('扣除使用者全域吉幣（限 owner）'), '扣除數量').setName('remove')
    )
    .addSubcommand((subcommand) =>
      addUserAmountReasonOptions(subcommand.setName('set').setDescription('設定使用者全域吉幣餘額（限 owner）'), '新的餘額', 0).setName('set')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查詢使用者最近吉幣交易紀錄')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reset-user')
        .setDescription('重置單一使用者吉幣資料，限 owner')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addStringOption((option) =>
          option.setName('confirm').setDescription('請輸入 RESET 才會執行').setRequired(true).setMaxLength(20)
        )
        .addStringOption((option) => option.setName('reason').setDescription('操作原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) => subcommand.setName('enable').setDescription('啟用目前伺服器吉幣系統'))
    .addSubcommand((subcommand) => subcommand.setName('disable').setDescription('停用目前伺服器吉幣系統'))
    .addSubcommand((subcommand) => subcommand
      .setName('campaign-preview').setDescription('預覽全域活動發幣名單（限 owner）')
      .addStringOption((option) => option.setName('campaign-id').setDescription('固定活動識別').setRequired(true).setMaxLength(160))
      .addStringOption((option) => option.setName('audience').setDescription('發給成員或身分組').setRequired(true)
        .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
      .addIntegerOption((option) => option.setName('amount').setDescription('每人吉幣數').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('活動說明，不作識別鍵').setRequired(true).setMaxLength(300))
      .addRoleOption((option) => option.setName('role').setDescription('發給身分組時必填'))
      .addUserOption((option) => option.setName('user').setDescription('成員模式可指定單人；未填為全體成員')))
    .addSubcommand((subcommand) => subcommand
      .setName('campaign-apply').setDescription('按預覽逐人發放，可重跑補發（限 owner）')
      .addStringOption((option) => option.setName('campaign-id').setDescription('固定活動識別').setRequired(true).setMaxLength(160))
      .addStringOption((option) => option.setName('audience').setDescription('與預覽相同').setRequired(true)
        .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
      .addStringOption((option) => option.setName('preview-token').setDescription('預覽回覆提供的完整識別碼').setRequired(true).setMaxLength(64))
      .addStringOption((option) => option.setName('confirm').setDescription('輸入 發幣 才執行').setRequired(true).setMaxLength(10))
      .addRoleOption((option) => option.setName('role').setDescription('身分組模式需與預覽相同')))
    .addSubcommand((subcommand) => subcommand
      .setName('campaign-history-plan').setDescription('查看活動歷史對帳來源與核對識別（限 owner）')
      .addStringOption((option) => option.setName('campaign-id').setDescription('固定活動識別').setRequired(true).setMaxLength(160))
      .addStringOption((option) => option.setName('audience').setDescription('與預覽相同').setRequired(true)
        .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
      .addRoleOption((option) => option.setName('role').setDescription('身分組模式需與預覽相同'))
      .addUserOption((option) => option.setName('user').setDescription('查看單人舊紀錄；不填則查看可批次核對名單'))
      .addIntegerOption((option) => option.setName('page').setDescription('單人舊紀錄頁數').setMinValue(1)))
    .addSubcommand((subcommand) => subcommand
      .setName('campaign-history-review').setDescription('確認已核對且未發過的活動收件人（限 owner）')
      .addStringOption((option) => option.setName('campaign-id').setDescription('固定活動識別').setRequired(true).setMaxLength(160))
      .addStringOption((option) => option.setName('audience').setDescription('與預覽相同').setRequired(true)
        .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
      .addStringOption((option) => option.setName('review-token').setDescription('對帳預覽提供的來源識別碼').setRequired(true).setMaxLength(64))
      .addStringOption((option) => option.setName('reason').setDescription('核對判定與依據').setRequired(true).setMaxLength(300))
      .addStringOption((option) => option.setName('confirm').setDescription('輸入 已核對未發 才會記錄').setRequired(true).setMaxLength(20))
      .addRoleOption((option) => option.setName('role').setDescription('身分組模式需與預覽相同'))
      .addUserOption((option) => option.setName('user').setDescription('核對單人；不填則批次核對無舊發款候選者')))
    .addSubcommand((subcommand) => subcommand
      .setName('campaign-history-classify').setDescription('將舊紀錄對應到其他來源（限 owner）')
      .addStringOption((option) => option.setName('campaign-id').setDescription('固定活動識別').setRequired(true).setMaxLength(160))
      .addStringOption((option) => option.setName('audience').setDescription('與預覽相同').setRequired(true)
        .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
      .addUserOption((option) => option.setName('user').setDescription('舊紀錄所屬成員').setRequired(true))
      .addStringOption((option) => option.setName('review-token').setDescription('單人對帳預覽提供的來源識別碼').setRequired(true).setMaxLength(64))
      .addStringOption((option) => option.setName('record-type').setDescription('舊紀錄類型').setRequired(true)
        .addChoices({ name: '交易', value: 'transaction' }, { name: '舊獎勵', value: 'legacy_grant' },
          { name: '管理紀錄', value: 'admin_log' }))
      .addIntegerOption((option) => option.setName('record-id').setDescription('舊紀錄編號').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('evidence-mode').setDescription('來源判定方式').setRequired(true)
        .addChoices({ name: '紀錄已有其他來源識別', value: 'record' },
          { name: 'OWNER 核對外部憑證與管理加款紀錄', value: 'owner_evidence' }))
      .addStringOption((option) => option.setName('source-reference').setDescription('可核對的其他活動或操作來源').setRequired(true).setMaxLength(200))
      .addStringOption((option) => option.setName('reason').setDescription('為何確認不屬本活動').setRequired(true).setMaxLength(300))
      .addStringOption((option) => option.setName('confirm').setDescription('紀錄來源：不屬於本活動；外證：已核外證非本活動').setRequired(true).setMaxLength(20))
      .addRoleOption((option) => option.setName('role').setDescription('身分組模式需與預覽相同')))
    .addSubcommand((subcommand) => subcommand
      .setName('campaign-history-import').setDescription('對應已發且來源明確的舊交易，不再次入帳（限 owner）')
      .addStringOption((option) => option.setName('campaign-id').setDescription('固定活動識別').setRequired(true).setMaxLength(160))
      .addStringOption((option) => option.setName('audience').setDescription('與預覽相同').setRequired(true)
        .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
      .addUserOption((option) => option.setName('user').setDescription('已領取成員').setRequired(true))
      .addStringOption((option) => option.setName('review-token').setDescription('單人對帳預覽提供的來源識別碼').setRequired(true).setMaxLength(64))
      .addIntegerOption((option) => option.setName('transaction-id').setDescription('核實過的舊交易編號').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('對應來源及證據').setRequired(true).setMaxLength(300))
      .addStringOption((option) => option.setName('confirm').setDescription('輸入 已發對應').setRequired(true).setMaxLength(20))
      .addRoleOption((option) => option.setName('role').setDescription('身分組模式需與預覽相同'))),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '吉幣管理只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (['add', 'remove', 'set', 'reset-user', 'campaign-preview', 'campaign-apply',
        'campaign-history-plan', 'campaign-history-review',
        'campaign-history-classify', 'campaign-history-import'].includes(subcommand)) {
        if (!(await ensureBotOwner(interaction))) {
          return;
        }
      } else {
        const access = await ensureModerationAccess(interaction, {
          userPermission: PermissionFlagsBits.Administrator,
          userPermissionName: 'Administrator',
        });

        if (!access.ok) {
          return;
        }
      }

      if (subcommand.startsWith('campaign-')) {
        const campaignId = interaction.options.getString('campaign-id', true);
        const audienceType = interaction.options.getString('audience', true);
        const role = interaction.options.getRole('role');
        if (audienceType === 'role' && !role) {
          await interaction.reply({ content: '身分組模式必須指定身分組。', ephemeral: true });
          return;
        }
        if (audienceType === 'member' && role) {
          await interaction.reply({ content: '成員模式不可指定身分組。', ephemeral: true });
          return;
        }
        if (subcommand === 'campaign-apply' && interaction.options.getString('confirm', true) !== '發幣') {
          await interaction.reply({ content: '未輸入 發幣，沒有發放吉幣。', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const common = { campaignId, sourceGuildId: interaction.guildId,
          audienceType, roleId: role?.id || null, actorUserId: interaction.user.id };
        if (subcommand.startsWith('campaign-history-')) {
          const preview = await getOwnerCampaignPreview(common);
          const target = interaction.options.getUser('user');
          if (target && !preview.recipients.includes(target.id)) {
            throw new CoinCampaignError('MEMBER_NOT_FOUND', '指定成員不在此活動的已預覽名單。');
          }
          const fullPlan = await getOwnerCampaignHistoryReviewPlan({
            campaignId, actorUserId: interaction.user.id, userIds: target ? [target.id] : preview.recipients,
          });
          const bulkUserIds = target ? [] : preview.recipients.filter((userId) =>
            !hasHistoricalCandidates(fullPlan, userId));
          const selectedUserIds = target ? [target.id] : bulkUserIds;
          const plan = selectedUserIds.length ? await getOwnerCampaignHistoryReviewPlan({
            campaignId, actorUserId: interaction.user.id, userIds: selectedUserIds,
          }) : null;
          const token = interaction.options.getString('review-token');
          if (subcommand === 'campaign-history-plan') {
            if (!target) {
              await interaction.editReply([
                `活動：${campaignId}｜累積名單 ${preview.recipients.length} 人`,
                `可批次核對且無舊發款候選：${bulkUserIds.length} 人`,
                `需逐人檢視舊交易：${preview.recipients.length - bulkUserIds.length} 人`,
                plan ? `批次核對識別碼：${plan.sourceSha256}` : '沒有可批次核對的成員。',
                '有舊交易者請用同指令指定 user 查看明細；來源不明者保持阻擋。',
              ].join('\n'));
            } else {
              const entries = [
                ...fullPlan.transactions.filter((row) => historicalRewardTypes.has(row.type)).map((row) => {
                  let source = '未標記來源';
                  let gross = Number(row.amount);
                  let offset = 0;
                  try {
                    const metadata = JSON.parse(row.metadata || '{}');
                    source = metadata.ownerCampaignId || metadata.canonicalSourceId || source;
                    gross = Number(metadata.debtOffset?.gross ?? row.amount);
                    offset = Number(metadata.debtOffset?.offset ?? 0);
                  } catch { /* Invalid metadata remains visibly unresolved. */ }
                  return `交易 #${row.id}｜${String(row.created_at).slice(0, 16)}｜${String(row.guild_id).slice(0, 20)}｜${row.type}｜毛${gross}/抵${offset}/淨${row.amount}｜${String(source).slice(0, 200)}｜${String(row.reason || '').slice(0, 25)}`;
                }),
                ...fullPlan.legacyGrants.map((row) =>
                  `舊獎勵 #${row.id}｜${String(row.created_at).slice(0, 16)}｜${String(row.guild_id).slice(0, 20)}｜${row.source_type}:${String(row.source_id).slice(0, 200)}｜${row.amount}`),
                ...fullPlan.adminLogs.map((row) =>
                  `管理紀錄 #${row.id}｜${String(row.created_at).slice(0, 16)}｜${String(row.guild_id).slice(0, 20)}｜${row.action}｜${String(row.reason || '').slice(0, 35)}`),
              ];
              const page = interaction.options.getInteger('page') || 1;
              const pages = Math.max(1, Math.ceil(entries.length / 3));
              if (page > pages) throw new CoinCampaignError('INVALID_PAGE', `此成員舊紀錄只有 ${pages} 頁。`);
              await interaction.editReply([
                `活動：${campaignId}｜成員：${target.id}｜舊紀錄 ${entries.length} 筆（第 ${page}/${pages} 頁）`,
                `單人核對識別碼：${fullPlan.sourceSha256}`,
                ...(entries.slice((page - 1) * 3, page * 3).length
                  ? entries.slice((page - 1) * 3, page * 3) : ['沒有舊發款候選。']),
                '舊紀錄需逐筆判定其他來源或核實已發交易；無法辨明者保持阻擋。',
              ].join('\n'));
            }
            return;
          }
          if (!plan || token !== plan.sourceSha256) {
            throw new CoinCampaignError('HISTORY_SOURCE_CHANGED', '核對識別碼不符或來源已變，請重新查看對帳預覽。');
          }
          if (subcommand === 'campaign-history-review') {
            if (interaction.options.getString('confirm', true) !== '已核對未發') {
              throw new CoinCampaignError('INVALID_CONFIRM', '必須輸入 已核對未發 才會記錄判定。');
            }
            const reason = interaction.options.getString('reason', true);
            const result = await reviewOwnerCampaignHistory({ campaignId,
              actorUserId: interaction.user.id,
              reviewId: botReviewId(interaction, campaignId, plan.sourceSha256),
              sourceSha256: plan.sourceSha256,
              decisions: historyDecisions(plan, selectedUserIds, false, reason) });
            await interaction.editReply(`已記錄 ${result.reviewed} 人的未發判定；來源識別碼 ${result.sourceSha256}。請再用 campaign-apply 發放。`);
            return;
          }
          if (!target) throw new CoinCampaignError('INVALID_HISTORY', '此核對操作必須指定單一成員。');
          if (subcommand === 'campaign-history-classify') {
            const evidenceMode = interaction.options.getString('evidence-mode', true);
            const expectedConfirm = evidenceMode === 'owner_evidence' ? '已核外證非本活動' : '不屬於本活動';
            if (interaction.options.getString('confirm', true) !== expectedConfirm) {
              throw new CoinCampaignError('INVALID_CONFIRM', `必須輸入 ${expectedConfirm} 才會記錄來源判定。`);
            }
            const result = await classifyOwnerCampaignHistoryRecord({ campaignId,
              actorUserId: interaction.user.id, userId: target.id,
              sourceSha256: plan.sourceSha256,
              recordType: interaction.options.getString('record-type', true),
              recordId: interaction.options.getInteger('record-id', true),
              evidenceMode,
              evidenceReference: interaction.options.getString('source-reference', true),
              reviewReason: interaction.options.getString('reason', true) });
            const basis = result.evidenceMode === 'owner_evidence'
              ? `OWNER 人工外證判定（連結管理紀錄 #${result.linkedAdminLogId}）`
              : '紀錄來源判定';
            await interaction.editReply(`已記錄${result.recordType} #${result.recordId} 的${basis}：${result.evidenceReference}。仍須用 campaign-history-review 完成此成員核對。`);
            return;
          }
          if (interaction.options.getString('confirm', true) !== '已發對應') {
            throw new CoinCampaignError('INVALID_CONFIRM', '必須輸入 已發對應 才會建立防重收據。');
          }
          const transactionId = interaction.options.getInteger('transaction-id', true);
          const transaction = plan.transactions.find((row) => Number(row.id) === transactionId);
          if (!transaction) throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', '指定交易不在此成員核對來源內。');
          const evidenceHash = crypto.createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
          const imported = await importOwnerCampaignHistory({ campaignId,
            actorUserId: interaction.user.id, amount: preview.amount,
            reason: interaction.options.getString('reason', true),
            recipientRecords: [{ userId: target.id, transactionId, evidenceHash }] });
          const reviewed = await reviewOwnerCampaignHistory({ campaignId,
            actorUserId: interaction.user.id,
            reviewId: botReviewId(interaction, campaignId, plan.sourceSha256),
            sourceSha256: plan.sourceSha256,
            decisions: historyDecisions(plan, [target.id], true,
              interaction.options.getString('reason', true)) });
          await interaction.editReply(`已對應成員 ${target.id} 的舊交易 #${transactionId}，新增收據 ${imported.imported} 筆、對帳 ${reviewed.reviewed} 人；沒有再次入帳。`);
          return;
        }
        const members = await fetchCompleteMembers(interaction.guild);
        if (subcommand === 'campaign-preview') {
          const target = interaction.options.getUser('user');
          if (audienceType === 'role' && target) throw new CoinCampaignError('INVALID_AUDIENCE', '身分組模式不可同時指定單一成員。');
          const selected = audienceType === 'role'
            ? members.filter((member) => member.roles.cache.has(role.id))
            : target ? members.filter((member) => member.id === target.id) : members;
          if (target && selected.length !== 1) throw new CoinCampaignError('MEMBER_NOT_FOUND', '指定成員未在完整名單中。');
          const preview = await previewOwnerCampaign({ ...common,
            amount: interaction.options.getInteger('amount', true),
            reason: interaction.options.getString('reason', true),
            memberIds: selected.map((member) => member.id) });
          await interaction.editReply([
            `活動：${campaignId}｜本次名單 ${preview.snapshotCount} 人`,
            `累積名單：${preview.cumulativeRecipients} 人｜新增 ${preview.newRecipients} 人`,
            `已領：${preview.alreadyGranted} 人｜待領：${preview.pending} 人`,
            `歷史對帳待確認：${preview.historyUnreviewed} 人；未完成前不能發幣。`,
            `待發金額：${formatCoins(preview.pendingAmount)}`,
            `預覽識別碼：${preview.previewToken}`,
            '請先用 campaign-history-plan 查看來源並完成核對，再用 campaign-apply；名單更新需重新預覽。',
          ].join('\n'));
        } else {
          const result = await applyOwnerCampaign({ ...common,
            previewToken: interaction.options.getString('preview-token', true),
            presentMemberIds: members.map((member) => member.id) });
          await interaction.editReply([
            `活動：${campaignId}｜本輪新發 ${result.granted} 人、${formatCoins(result.amountGranted)}`,
            `已領未重發：${result.alreadyGranted} 人｜歷史待核對：${result.historyBlocked.length} 人｜離群：${result.leftGuild.length} 人｜失敗：${result.failed.length} 人｜待續跑：${result.remaining} 人`,
            result.historyBlocked.length ? `歷史待核對：${result.historyBlocked.slice(0, 10).map((item) => `${item.userId}(${item.code})`).join(', ')}` : '',
            result.leftGuild.length ? `離群：${result.leftGuild.slice(0, 10).join(', ')}` : '',
            result.failed.length ? `失敗：${result.failed.slice(0, 10).map((item) => `${item.userId}(${item.code})`).join(', ')}` : '',
          ].filter(Boolean).join('\n'));
        }
        return;
      }

      if (['add', 'remove', 'set'].includes(subcommand)) {
        const target = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount', true);
        const reason = interaction.options.getString('reason', true);
        const result = await adjustPlayerBalance(interaction.guildId, target.id, {
          action: subcommand,
          amount,
          operatorId: interaction.user.id,
          reason,
          operationId: interaction.id,
        });
        const label = subcommand === 'add' ? '加幣' : subcommand === 'remove' ? '扣幣' : '設定餘額';

        await interaction.reply({
          content: `${result.alreadyApplied ? '此操作已處理。\n' : ''}${formatAdminResult(label, target, result, reason)}`,
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const target = interaction.options.getUser('user', true);
        const limit = interaction.options.getInteger('limit') || 10;
        const transactions = await getTransactions(interaction.guildId, target.id, { limit });

        if (transactions.length === 0) {
          await interaction.reply({ content: `${formatUser(target)} 目前沒有吉幣交易紀錄。`, ephemeral: true });
          return;
        }

        const lines = transactions.map((transaction) => {
          const timestamp = Math.floor(new Date(transaction.createdAt).getTime() / 1000);
          return `#${transaction.id} <t:${timestamp}:R> ${transaction.type} ${formatCoins(transaction.amount)}：${formatCoins(transaction.balanceBefore)} -> ${formatCoins(transaction.balanceAfter)}｜${transaction.reason}`;
        });

        await interaction.reply({
          content: [`**${formatUser(target)} 最近交易紀錄**`, ...lines].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'reset-user') {
        const confirm = interaction.options.getString('confirm', true);

        if (confirm !== 'RESET') {
          await interaction.reply({ content: '未輸入 RESET，重置已取消。', ephemeral: true });
          return;
        }

        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'owner 重置使用者吉幣資料';
        const result = await resetPlayerData(interaction.guildId, target.id, {
          operatorId: interaction.user.id,
          reason,
        });

        await interaction.reply({
          content: [
            '使用者全域吉幣錢包、一般債務、簽到與一般商店庫存紀錄已重置。',
            `目標：${formatUser(target)}`,
            `原本餘額：${formatCoins(result.before)}`,
            `最新餘額：${formatCoins(result.after)}`,
            `原因：${reason}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'enable' || subcommand === 'disable') {
        const enabled = subcommand === 'enable';
        const settings = await setGuildEconomyEnabled(interaction.guildId, enabled, { operatorId: interaction.user.id });

        await interaction.reply({
          content: `目前伺服器吉幣系統已${settings.enabled ? '啟用' : '停用'}。`,
          ephemeral: true,
        });
      }
    } catch (error) {
      if (error instanceof CoinCampaignError) {
        if (interaction.deferred && !interaction.replied) await interaction.editReply(error.message);
        else await interaction.reply({ content: error.message, ephemeral: true });
        return;
      }
      await replyCoinError(interaction, error);
    }
  },
};
