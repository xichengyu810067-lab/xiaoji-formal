const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  adjustPlayerBalance,
  getTransactions,
  resetPlayerData,
  setGuildEconomyEnabled,
} = require('../services/coinService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { ensureModerationAccess } = require('../utils/moderation');
const {
  formatCoins, formatMemberName, formatTransactionReason, formatTransactionType, replyCoinError,
} = require('../utils/coinPresentation');
const { clipText, fitListText, omittedLine } = require('../utils/replyLengthGuard');
const { CoinCampaignError, applyOwnerCampaign, classifyOwnerCampaignHistoryRecord,
  getOwnerCampaignHistoryReviewPlan, getOwnerCampaignPreview, importOwnerCampaignHistory,
  previewOwnerCampaign, reviewOwnerCampaignHistory } = require('../services/coinCampaignService');
const { authorizeRoleAdd, cancelAddConfirmation, confirmUserAdd, createAddConfirmation,
  recordRoleAddResult, roleAddPaymentGate } = require('../services/coinAdminAddService');

const ADD_COMPONENT_PREFIX = 'coin-admin|1|add|';
const ADD_PREVIEW_TTL_SECONDS = 15 * 60;
const MAX_COIN_AMOUNT = 9_000_000_000;
const HISTORY_USER_REQUIRED =
  '請用 user 選項指定要查詢交易紀錄的成員（可用 limit 調整筆數）。要看全伺服器最近的交易請用 /economy audit；活動歷史對帳請填 campaign-id。';
// The history options that only campaign reconciliation reads, by how each one is read. Without
// campaign-id they would be ignored, so the transaction lookup refuses them and names them instead.
const HISTORY_CAMPAIGN_ONLY_OPTIONS = Object.freeze([
  ['action', 'getString'], ['audience', 'getString'], ['role', 'getRole'], ['page', 'getInteger'],
  ['review-token', 'getString'], ['reason', 'getString'], ['confirm', 'getString'], ['record-type', 'getString'],
  ['record-id', 'getInteger'], ['evidence-mode', 'getString'], ['source-reference', 'getString'],
  ['transaction-id', 'getInteger'],
]);

function campaignOnlyOptionsGiven(options) {
  return HISTORY_CAMPAIGN_ONLY_OPTIONS
    .filter(([name, getter]) => { const value = options[getter](name); return value !== null && value !== undefined; })
    .map(([name]) => name);
}

function historyCampaignIdRequired(names) {
  return `${names.join('、')} 是活動歷史對帳用的選項，需要搭配 campaign-id；只查一般交易紀錄時請只填 user（可加 limit）。`;
}

const campaignErrorReplies = Object.freeze({
  OWNER_ONLY: '只有小吉擁有者可以管理活動發幣。',
  INCOMPLETE_MEMBER_FETCH: '無法取得完整成員名單，活動已停止。',
  INVALID_ARGUMENT: '活動資料不完整，請檢查輸入後重試。',
  INVALID_AUDIENCE: '請確認發放對象與身分組設定。',
  INVALID_AMOUNT: '發放金額不正確，請重新輸入。',
  INVALID_REASON: '請填寫活動原因。',
  INVALID_MEMBERS: '無法確認完整成員名單，活動已停止。',
  MEMBER_NOT_FOUND: '指定成員不在完整名單中。',
  INVALID_CONFIRM: '確認文字不正確，請依指令提示重新輸入。',
  INVALID_PAGE: '查無此頁舊紀錄，請重新選擇頁數。',
  INVALID_HISTORY: '歷史對帳資料不完整，請重新查看對帳預覽。',
  CAMPAIGN_NOT_FOUND: '找不到活動預覽，請重新建立預覽。',
  CAMPAIGN_CONFLICT: '活動識別與既有設定不符，請重新核對。',
  CAMPAIGN_RECEIPT_CONFLICT: '活動收據與設定不符，請先核對帳務。',
  CAMPAIGN_HISTORY_UNRECONCILED: '尚有歷史發款未完成核對，不能發幣。',
  CAMPAIGN_HISTORY_CHANGED: '歷史發款來源已變更，請重新查看並核對。',
  HISTORY_SOURCE_CHANGED: '歷史對帳來源已變更，請重新查看對帳預覽。',
  HISTORY_SOURCE_UNRESOLVED: '歷史紀錄來源尚未核實，不能發幣。',
  HISTORY_EVIDENCE_CONFLICT: '發放結果暫時無法確認，請先核對帳務。',
  HISTORY_REVIEW_CONFLICT: '歷史發款核對結果有衝突，請先核對帳務。',
  PREVIEW_CHANGED: '活動預覽已變更，請重新預覽。',
  PREVIEW_EXPIRED: '這份加幣預覽已過期，請重新執行 /coin-admin add。',
  PREVIEW_SCOPE_MISMATCH: '這份加幣預覽不屬於目前的操作者或伺服器。',
  // The confirm press of a role coin add answers this one itself (roleAddClosedReply); this text covers any other caller.
  ADD_CONFIRMATION_CLOSED: '此加幣操作已取消或已完成，這次確認已停止發放，不會重複入帳。',
  AMOUNT_OVERFLOW: '活動總金額超出可支援範圍。',
});

// What a role confirm press answers when the add was already cancelled or completed.
const ROLE_ADD_CLOSED_REPLIES = Object.freeze({
  cancelled: '此加幣操作已取消，沒有入帳。',
  completed: '此身分組活動已完成，沒有重複入帳。',
});

function roleAddClosedReply(status) {
  return { content: ROLE_ADD_CLOSED_REPLIES[status], embeds: [], components: [], attachments: [] };
}

function campaignErrorReply(error) {
  return Object.hasOwn(campaignErrorReplies, error.code)
    ? campaignErrorReplies[error.code]
    : '活動操作暫時無法完成，請稍後重試。';
}

async function fetchCompleteMembers(guild) {
  const beforeCount = Number(guild?.memberCount);
  if (!Number.isSafeInteger(beforeCount) || beforeCount < 0) {
    throw new CoinCampaignError('INCOMPLETE_MEMBER_FETCH', 'Guild member count is unavailable.');
  }
  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    throw new CoinCampaignError('INCOMPLETE_MEMBER_FETCH', error?.code || 'Member fetch failed.');
  }
  const afterCount = Number(guild.memberCount);
  if (!members || typeof members.values !== 'function' || beforeCount !== afterCount ||
      members.size !== afterCount) {
    throw new CoinCampaignError('INCOMPLETE_MEMBER_FETCH', 'Guild membership changed during the complete fetch.');
  }
  const values = [...members.values()];
  if (values.some((member) => !member?.user || member.partial === true)) {
    throw new CoinCampaignError('INCOMPLETE_MEMBER_FETCH', 'Fetched member data is partial.');
  }
  return values;
}

function selectNonBotRoleMembers(members, roleId) {
  const selected = [];
  for (const member of members) {
    if (member.user.bot) continue;
    if (typeof member.roles?.cache?.has !== 'function') {
      throw new CoinCampaignError('INCOMPLETE_MEMBER_FETCH', 'Fetched role data is incomplete.');
    }
    if (member.roles.cache.has(roleId)) selected.push(member);
  }
  return selected.sort((left, right) => left.id.localeCompare(right.id));
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

function addCoinAddOptions(subcommand) {
  return subcommand
    .addIntegerOption((option) => option.setName('amount').setDescription('每位增加數量')
      .setRequired(true).setMinValue(1).setMaxValue(MAX_COIN_AMOUNT))
    .addStringOption((option) => option.setName('reason').setDescription('操作原因')
      .setRequired(true).setMaxLength(300))
    .addUserOption((option) => option.setName('user').setDescription('單一目標使用者；與 role 二選一'))
    .addRoleOption((option) => option.setName('role').setDescription('目標身分組；與 user 二選一'))
    .addStringOption((option) => option.setName('campaign-id')
      .setDescription('身分組發幣的固定活動識別；重試時使用相同值').setMaxLength(160));
}

function addHistoryOptions(subcommand) {
  return subcommand
    .addUserOption((option) => option.setName('user').setDescription('一般交易目標，或活動內的單一成員'))
    .addIntegerOption((option) => option.setName('limit').setDescription('一般交易筆數，預設 10').setMinValue(1).setMaxValue(25))
    .addStringOption((option) => option.setName('campaign-id').setDescription('活動歷史對帳識別').setMaxLength(160))
    .addStringOption((option) => option.setName('action').setDescription('活動歷史操作')
      .addChoices(
        { name: '查看來源', value: 'plan' },
        { name: '記錄已核對未發', value: 'review' },
        { name: '標記其他來源', value: 'classify' },
        { name: '匯入既有發放收據', value: 'import' },
      ))
    .addStringOption((option) => option.setName('audience').setDescription('活動對象類型')
      .addChoices({ name: '成員', value: 'member' }, { name: '身分組', value: 'role' }))
    .addRoleOption((option) => option.setName('role').setDescription('身分組活動需指定原身分組'))
    .addIntegerOption((option) => option.setName('page').setDescription('單人成交來源頁數').setMinValue(1))
    .addStringOption((option) => option.setName('review-token').setDescription('來源預覽提供的 SHA-256').setMaxLength(64))
    .addStringOption((option) => option.setName('reason').setDescription('核對依據').setMaxLength(300))
    .addStringOption((option) => option.setName('confirm').setDescription('依操作提示輸入確認文字').setMaxLength(20))
    .addStringOption((option) => option.setName('record-type').setDescription('舊紀錄類型')
      .addChoices({ name: '交易', value: 'transaction' }, { name: '舊獎勵', value: 'legacy_grant' },
        { name: '管理紀錄', value: 'admin_log' }))
    .addIntegerOption((option) => option.setName('record-id').setDescription('舊紀錄編號').setMinValue(1))
    .addStringOption((option) => option.setName('evidence-mode').setDescription('來源判定方式')
      .addChoices({ name: '紀錄已有其他來源識別', value: 'record' },
        { name: 'OWNER 核對外部憑證與管理加款紀錄', value: 'owner_evidence' }))
    .addStringOption((option) => option.setName('source-reference').setDescription('其他活動或操作來源').setMaxLength(200))
    .addIntegerOption((option) => option.setName('transaction-id').setDescription('已核實的舊交易編號').setMinValue(1));
}

// The member an owner command acts on is named the same way in every reply (see formatMemberName).
function displayTargetName(interaction, user) {
  return formatMemberName(user, interaction.options.getMember?.('user'));
}

// The add button carries only the user ID, so the member is looked up when the add is confirmed.
// A member who has left the server is named by the account instead.
async function confirmedTargetName(interaction, userId) {
  const member = (await interaction.guild?.members.fetch(userId).catch(() => null)) ?? null;
  const user = member?.user ?? (await interaction.client?.users.fetch(userId).catch(() => null)) ?? null;
  return formatMemberName(user, member);
}

function formatAdminResult(actionLabel, targetName, result, reason) {
  return [
    `${actionLabel}完成。`,
    `目標：${targetName}`,
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

function buildAddCustomId(action, preview) {
  const mode = preview.mode === 'user' ? 'u' : 'r';
  const customId = `${ADD_COMPONENT_PREFIX}${action}|${mode}|${preview.operationId}|${preview.expiresAt}|${preview.payloadHash.slice(0, 24)}`;
  if (customId.length > 100) throw new CoinCampaignError('INVALID_ARGUMENT', 'Add preview custom ID exceeds Discord limits.');
  return customId;
}

function buildPreviewEmbed(preview) {
  const fields = [
    { name: '模式', value: preview.mode, inline: true },
    { name: '操作者', value: preview.actorUserId, inline: true },
    { name: '伺服器', value: preview.guildId, inline: true },
    { name: '操作識別', value: preview.operationId, inline: false },
    { name: '每人毛額', value: String(preview.amount), inline: true },
    { name: '預計抵扣', value: String(preview.debtOffset || 0), inline: true },
    { name: '預計淨額', value: String(preview.netAmount), inline: true },
    { name: '原因', value: preview.reason, inline: false },
    // expiresAt is a Unix time in seconds; the timestamp tag shows it as a relative time in the client.
    { name: '到期時間', value: `<t:${preview.expiresAt}:R>`, inline: true },
  ];
  if (preview.mode === 'user') {
    fields.push({ name: '使用者', value: preview.targetUserId, inline: true });
  } else {
    fields.push(
      { name: '活動識別', value: preview.campaignId, inline: false },
      { name: '身分組', value: preview.roleId, inline: true },
      { name: '預覽識別', value: preview.previewToken, inline: false },
      { name: '本次非 bot 名單', value: String(preview.snapshotCount), inline: true },
      { name: '累積名單', value: String(preview.cumulativeRecipients), inline: true },
      { name: '待領人數', value: String(preview.pending), inline: true },
      { name: '歷史待核對', value: String(preview.historyUnreviewed), inline: true },
    );
  }
  return { title: '吉幣加幣預覽', description: preview.mode === 'user'
    ? '單人管理加幣：不抵扣欠款，伺服器吉幣停用時仍可執行。'
    : '身分組活動發幣：入帳時先抵扣欠款，且伺服器吉幣系統必須啟用。',
  color: 0xf5b642, fields };
}

function buildPreviewComponents(preview) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(buildAddCustomId('confirm', preview)).setLabel('確認加幣').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(buildAddCustomId('cancel', preview)).setLabel('取消').setStyle(ButtonStyle.Secondary),
  )];
}

function parseAddCustomId(customId) {
  const parts = String(customId || '').split('|');
  if (parts.length !== 8 || parts[0] !== 'coin-admin' || parts[1] !== '1' || parts[2] !== 'add' ||
      !['confirm', 'cancel'].includes(parts[3]) || !['u', 'r'].includes(parts[4]) ||
      !parts[5] || !/^\d+$/.test(parts[6]) || !/^[a-f0-9]{24}$/.test(parts[7])) {
    throw new CoinCampaignError('PREVIEW_CHANGED', 'Add preview button is invalid.');
  }
  return { action: parts[3], mode: parts[4] === 'u' ? 'user' : 'role',
    operationId: parts[5], expiresAt: Number(parts[6]), digest: parts[7] };
}

function componentControl(interaction, decoded) {
  return {
    operationId: decoded.operationId,
    mode: decoded.mode,
    actorUserId: interaction.user.id,
    guildId: interaction.guildId,
    expiresAt: decoded.expiresAt,
    digest: decoded.digest,
    nowSeconds: Math.floor(Date.now() / 1000),
  };
}

function safeMemberLine(member) {
  const name = String(member.displayName || member.user.globalName || member.user.username || member.id)
    .replace(/[\r\n\t]/g, ' ').slice(0, 100);
  return `${name} (${member.id})`;
}

function roleMemberAttachment(campaignId, members) {
  const header = `活動 ${campaignId}\n完整非 bot 身分組名單：${members.length} 人\n`;
  return new AttachmentBuilder(Buffer.from(`${header}${members.map(safeMemberLine).join('\n')}\n`, 'utf8'),
    { name: 'coin-role-preview.txt' });
}

async function handleCampaignHistory(interaction) {
  const campaignId = interaction.options.getString('campaign-id', true);
  const audienceType = interaction.options.getString('audience');
  const role = interaction.options.getRole('role');
  if (!audienceType) throw new CoinCampaignError('INVALID_AUDIENCE', '活動歷史操作必須指定 audience。');
  if (audienceType === 'role' && !role) throw new CoinCampaignError('INVALID_AUDIENCE', '身分組活動必須指定原身分組。');
  if (audienceType === 'member' && role) throw new CoinCampaignError('INVALID_AUDIENCE', '成員活動不可指定身分組。');
  const action = interaction.options.getString('action') || 'plan';
  await interaction.deferReply({ ephemeral: true });
  const common = { campaignId, sourceGuildId: interaction.guildId,
    audienceType, roleId: role?.id || null, actorUserId: interaction.user.id };
  const preview = await getOwnerCampaignPreview(common);
  const target = interaction.options.getUser('user');
  if (target && !preview.recipients.includes(target.id)) {
    throw new CoinCampaignError('MEMBER_NOT_FOUND', '指定成員不在此活動的已預覽名單。');
  }
  const fullPlan = await getOwnerCampaignHistoryReviewPlan({
    campaignId, actorUserId: interaction.user.id, userIds: target ? [target.id] : preview.recipients,
  });
  const bulkUserIds = target ? [] : preview.recipients.filter((userId) => !hasHistoricalCandidates(fullPlan, userId));
  const selectedUserIds = target ? [target.id] : bulkUserIds;
  const plan = selectedUserIds.length ? await getOwnerCampaignHistoryReviewPlan({
    campaignId, actorUserId: interaction.user.id, userIds: selectedUserIds,
  }) : null;

  if (action === 'plan') {
    if (!target) {
      await interaction.editReply([
        `活動：${campaignId}｜累積名單 ${preview.recipients.length} 人`,
        `可批次核對且無舊發款候選：${bulkUserIds.length} 人`,
        `需逐人檢視舊交易：${preview.recipients.length - bulkUserIds.length} 人`,
        plan ? `批次核對識別碼：${plan.sourceSha256}` : '沒有可批次核對的成員。',
        '有舊交易者請在 /coin-admin history 指定 user 查看；來源不明者保持阻擋。',
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
          return `交易 #${row.id}｜${String(row.created_at).slice(0, 16)}｜${String(row.guild_id).slice(0, 20)}｜${row.type}｜毛${gross}/抵${offset}/淨${row.amount}｜${String(source).slice(0, 200)}｜${formatTransactionReason(row.reason).slice(0, 25)}`;
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

  const token = interaction.options.getString('review-token');
  if (!plan || token !== plan.sourceSha256) {
    throw new CoinCampaignError('HISTORY_SOURCE_CHANGED', '核對識別碼不符或來源已變，請重新查看對帳預覽。');
  }
  if (action === 'review') {
    if (interaction.options.getString('confirm') !== '已核對未發') {
      throw new CoinCampaignError('INVALID_CONFIRM', '必須輸入 已核對未發 才會記錄判定。');
    }
    const reason = interaction.options.getString('reason');
    if (!reason) throw new CoinCampaignError('INVALID_REASON', '核對必須填寫原因。');
    const result = await reviewOwnerCampaignHistory({ campaignId,
      actorUserId: interaction.user.id,
      reviewId: botReviewId(interaction, campaignId, plan.sourceSha256),
      sourceSha256: plan.sourceSha256,
      decisions: historyDecisions(plan, selectedUserIds, false, reason) });
    await interaction.editReply(`已記錄 ${result.reviewed} 人的未發判定；來源識別碼 ${result.sourceSha256}。可以回到 /coin-admin add 的預覽確認發放。`);
    return;
  }
  if (!target) throw new CoinCampaignError('INVALID_HISTORY', '此核對操作必須指定單一成員。');
  if (action === 'classify') {
    const evidenceMode = interaction.options.getString('evidence-mode');
    const expectedConfirm = evidenceMode === 'owner_evidence' ? '已核外證非本活動' : '不屬於本活動';
    if (!evidenceMode || interaction.options.getString('confirm') !== expectedConfirm) {
      throw new CoinCampaignError('INVALID_CONFIRM', `必須輸入 ${expectedConfirm} 才會記錄來源判定。`);
    }
    const recordType = interaction.options.getString('record-type');
    const recordId = interaction.options.getInteger('record-id');
    const evidenceReference = interaction.options.getString('source-reference');
    const reviewReason = interaction.options.getString('reason');
    if (!recordType || !recordId || !evidenceReference || !reviewReason) {
      throw new CoinCampaignError('INVALID_HISTORY', '來源分類資料不完整。');
    }
    const result = await classifyOwnerCampaignHistoryRecord({ campaignId,
      actorUserId: interaction.user.id, userId: target.id, sourceSha256: plan.sourceSha256,
      recordType, recordId, evidenceMode, evidenceReference, reviewReason });
    const basis = result.evidenceMode === 'owner_evidence'
      ? `OWNER 人工外證判定（連結管理紀錄 #${result.linkedAdminLogId}）` : '紀錄來源判定';
    await interaction.editReply(`已記錄${result.recordType} #${result.recordId} 的${basis}：${result.evidenceReference}。仍須用 /coin-admin history action:記錄已核對未發 完成核對。`);
    return;
  }
  if (action !== 'import') throw new CoinCampaignError('INVALID_HISTORY', '未知的歷史操作。');
  if (interaction.options.getString('confirm') !== '已發對應') {
    throw new CoinCampaignError('INVALID_CONFIRM', '必須輸入 已發對應 才會建立防重收據。');
  }
  const transactionId = interaction.options.getInteger('transaction-id');
  const reason = interaction.options.getString('reason');
  const transaction = plan.transactions.find((row) => Number(row.id) === transactionId);
  if (!transaction || !reason) throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', '指定交易或核對原因不完整。');
  const evidenceHash = crypto.createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
  const imported = await importOwnerCampaignHistory({ campaignId,
    actorUserId: interaction.user.id, amount: preview.amount, reason,
    recipientRecords: [{ userId: target.id, transactionId, evidenceHash }] });
  const reviewed = await reviewOwnerCampaignHistory({ campaignId,
    actorUserId: interaction.user.id,
    reviewId: botReviewId(interaction, campaignId, plan.sourceSha256),
    sourceSha256: plan.sourceSha256,
    decisions: historyDecisions(plan, [target.id], true, reason) });
  await interaction.editReply(`已對應成員 ${target.id} 的舊交易 #${transactionId}，新增收據 ${imported.imported} 筆、對帳 ${reviewed.reviewed} 人；沒有再次入帳。`);
}

async function handleAddCommand(interaction) {
  const target = interaction.options.getUser('user');
  const role = interaction.options.getRole('role');
  if (Boolean(target) === Boolean(role)) {
    throw new CoinCampaignError('INVALID_AUDIENCE', 'user 與 role 必須且只能選一個。');
  }
  const amount = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason', true);
  const expiresAt = Math.floor(Date.now() / 1000) + ADD_PREVIEW_TTL_SECONDS;
  if (target) {
    if (interaction.options.getString('campaign-id')) {
      throw new CoinCampaignError('INVALID_AUDIENCE', '單人加幣不可指定 campaign-id。');
    }
    const preview = await createAddConfirmation({
      mode: 'user', actorUserId: interaction.user.id, guildId: interaction.guildId,
      operationId: interaction.id, expiresAt, targetUserId: target.id, amount, reason,
    });
    const display = { ...preview, debtOffset: 0, netAmount: amount };
    await interaction.reply({ embeds: [buildPreviewEmbed(display)], components: buildPreviewComponents(preview),
      ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  const campaignId = interaction.options.getString('campaign-id');
  if (!campaignId) throw new CoinCampaignError('INVALID_ARGUMENT', '身分組發幣必須指定固定 campaign-id。');
  await interaction.deferReply({ ephemeral: true });
  const members = await fetchCompleteMembers(interaction.guild);
  const selected = selectNonBotRoleMembers(members, role.id);
  if (selected.length === 0) throw new CoinCampaignError('INVALID_MEMBERS', '此身分組沒有可發放的非 bot 成員。');
  const campaign = await previewOwnerCampaign({ campaignId, sourceGuildId: interaction.guildId,
    audienceType: 'role', roleId: role.id, actorUserId: interaction.user.id,
    amount, reason, memberIds: selected.map((member) => member.id) });
  const persistedCampaign = await getOwnerCampaignPreview({ campaignId, sourceGuildId: interaction.guildId,
    audienceType: 'role', roleId: role.id, actorUserId: interaction.user.id });
  const preview = await createAddConfirmation({
    mode: 'role', actorUserId: interaction.user.id, guildId: interaction.guildId,
    operationId: interaction.id, expiresAt, roleId: role.id, campaignId,
    previewToken: campaign.previewToken, amount, reason: persistedCampaign.reason,
  });
  const display = { ...preview,
    debtOffset: campaign.pendingDebtOffset, netAmount: campaign.pendingNetAmount,
    snapshotCount: campaign.snapshotCount, cumulativeRecipients: campaign.cumulativeRecipients,
    pending: campaign.pending, historyUnreviewed: campaign.historyUnreviewed };
  await interaction.editReply({
    content: [
      `完整非 bot 名單已附檔，共 ${selected.length} 人。`,
      `累積名單 ${campaign.cumulativeRecipients} 人；新增 ${campaign.newRecipients} 人；已領 ${campaign.alreadyGranted} 人。`,
      persistedCampaign.reason !== reason ? `活動已存在，沿用原原因：${persistedCampaign.reason}` : '',
      campaign.historyUnreviewed > 0
        ? `尚有 ${campaign.historyUnreviewed} 人需先用 /coin-admin history 完成歷史核對。` : '歷史核對已完成。',
    ].filter(Boolean).join('\n'),
    embeds: [buildPreviewEmbed(display)], components: buildPreviewComponents(preview),
    files: [roleMemberAttachment(campaignId, selected)], allowedMentions: { parse: [] },
  });
}

async function handleComponent(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith(ADD_COMPONENT_PREFIX)) return false;
  try {
    if (!interaction.guildId || !(await ensureBotOwner(interaction))) return true;
    const decoded = parseAddCustomId(interaction.customId);
    const control = componentControl(interaction, decoded);
    if (decoded.action === 'cancel') {
      const cancelled = await cancelAddConfirmation(control);
      const content = cancelled.state === 'cancelled'
        ? '加幣操作已取消，不會發放。'
        : cancelled.state === 'completed'
          ? '加幣已完成，不能取消；已成立帳務不會回滾。'
          : '加幣已開始處理，不能取消；請用確認按鈕安全續跑。';
      await interaction.update({ content, embeds: [],
        components: cancelled.state === 'partial' ? buildPreviewComponents(cancelled.confirmation) : [],
        attachments: [] });
      return true;
    }
    await interaction.deferUpdate();
    if (decoded.mode === 'user') {
      const confirmed = await confirmUserAdd(control);
      if (confirmed.state === 'cancelled') {
        await interaction.editReply({ content: '此加幣操作已取消，沒有入帳。', embeds: [], components: [], attachments: [] });
        return true;
      }
      const preview = confirmed.confirmation;
      const result = confirmed.result;
      const targetName = await confirmedTargetName(interaction, preview.targetUserId);
      await interaction.editReply({
        content: [
          result.alreadyApplied || preview.result?.alreadyApplied
            ? '此操作已處理，沒有重複入帳。' : '單人加幣完成。',
          `目標：${targetName}`,
          `毛額：${formatCoins(preview.amount)}｜抵扣：${formatCoins(0)}｜淨額：${formatCoins(preview.amount)}`,
          `原本餘額：${formatCoins(result.before)}｜最新餘額：${formatCoins(result.after)}`,
          `原因：${preview.reason}`,
        ].join('\n'),
        embeds: [], components: [], attachments: [], allowedMentions: { parse: [] },
      });
      return true;
    }

    // Nothing here changes the add before its first payment: a press stopped before paying anyone leaves it pending,
    // so the preview can still be cancelled (see coinAdminAddService).
    const preview = await authorizeRoleAdd(control);
    if (preview.status === 'cancelled' || preview.status === 'completed') {
      await interaction.editReply(roleAddClosedReply(preview.status));
      return true;
    }
    const members = await fetchCompleteMembers(interaction.guild);
    const presentMemberIds = members.filter((member) => !member.user.bot).map((member) => member.id);
    const campaign = await getOwnerCampaignPreview({ campaignId: preview.campaignId,
      sourceGuildId: preview.guildId, audienceType: 'role', roleId: preview.roleId,
      actorUserId: preview.actorUserId });
    if (campaign.previewToken !== preview.previewToken || campaign.amount !== preview.amount || campaign.reason !== preview.reason) {
      throw new CoinCampaignError('PREVIEW_CHANGED', 'Campaign preview changed before confirmation.');
    }
    let result;
    try {
      result = await applyOwnerCampaign({ campaignId: preview.campaignId,
        sourceGuildId: preview.guildId, audienceType: 'role', roleId: preview.roleId,
        actorUserId: preview.actorUserId, previewToken: preview.previewToken, presentMemberIds,
        paymentGate: roleAddPaymentGate(preview.operationId) });
    } catch (error) {
      // The add was cancelled before any of its payments, or another press completed it, while this press ran.
      if (error?.code !== 'ADD_CONFIRMATION_CLOSED') throw error;
      await interaction.editReply(roleAddClosedReply(error.status));
      return true;
    }
    const retryable = result.failed.length + result.remaining + result.historyBlocked.length + result.leftGuild.length > 0;
    const recorded = await recordRoleAddResult(preview.operationId, result, retryable);
    if (recorded.status === 'cancelled') {
      await interaction.editReply(roleAddClosedReply('cancelled'));
      return true;
    }
    await interaction.editReply({
      content: [
        `活動：${preview.campaignId}｜本輪新發 ${result.granted} 人`,
        `毛額：${formatCoins(result.grossAmountGranted)}｜抵扣：${formatCoins(result.debtOffset)}｜淨額：${formatCoins(result.netAmountGranted)}`,
        `已領未重發：${result.alreadyGranted} 人｜歷史待核對：${result.historyBlocked.length} 人｜離群：${result.leftGuild.length} 人｜失敗：${result.failed.length} 人｜待續跑：${result.remaining} 人`,
        result.historyBlocked.length ? `歷史待核對：${result.historyBlocked.slice(0, 10).map((item) => `${item.userId}(${item.code})`).join(', ')}` : '',
        result.leftGuild.length ? `離群：${result.leftGuild.slice(0, 10).join(', ')}` : '',
        result.failed.length ? `失敗：${result.failed.slice(0, 10).map((item) => `${item.userId}(${item.code})`).join(', ')}` : '',
      ].filter(Boolean).join('\n'),
      components: retryable ? buildPreviewComponents(preview) : [],
      attachments: [], allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    if (error instanceof CoinCampaignError) {
      const content = campaignErrorReply(error);
      const terminal = ['PREVIEW_CHANGED', 'PREVIEW_EXPIRED', 'PREVIEW_SCOPE_MISMATCH', 'ADD_CONFIRMATION_CLOSED']
        .includes(error.code);
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(terminal ? { content, components: [] } : { content });
      }
      else if (!interaction.replied) await interaction.reply({ content, ephemeral: true });
      return true;
    }
    await replyCoinError(interaction, error);
    return true;
  }
}

const data = new SlashCommandBuilder()
  .setName('coin-admin')
  .setDescription('管理吉幣系統（全域錢包變更限小吉擁有者）')
  // Hides the command from members without Administrator. The checks in execute stay the real guard.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // default_member_permissions does not apply in DMs, so a command that is only for servers is kept out of them.
  .setDMPermission(false)
  .addSubcommand((subcommand) => addCoinAddOptions(subcommand.setName('add')
    .setDescription('預覽並替單一使用者或身分組增加吉幣（限 owner）')))
  .addSubcommand((subcommand) =>
    addUserAmountReasonOptions(subcommand.setName('remove').setDescription('扣除使用者全域吉幣（限 owner）'), '扣除數量').setName('remove'))
  .addSubcommand((subcommand) =>
    addUserAmountReasonOptions(subcommand.setName('set').setDescription('設定使用者全域吉幣餘額（限 owner）'), '新的餘額', 0).setName('set'))
  .addSubcommand((subcommand) => addHistoryOptions(subcommand.setName('history')
    .setDescription('查詢交易或執行活動歷史對帳')))
  .addSubcommand((subcommand) => subcommand
    .setName('reset-user').setDescription('重置單一使用者吉幣資料，限 owner')
    .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    .addStringOption((option) => option.setName('confirm').setDescription('請輸入 RESET 才會執行').setRequired(true).setMaxLength(20))
    .addStringOption((option) => option.setName('reason').setDescription('操作原因').setMaxLength(300)))
  .addSubcommand((subcommand) => subcommand.setName('enable').setDescription('啟用目前伺服器吉幣系統'))
  .addSubcommand((subcommand) => subcommand.setName('disable').setDescription('停用目前伺服器吉幣系統'));

async function execute(interaction) {
  try {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: '吉幣管理只能在伺服器內使用。', ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const campaignHistory = subcommand === 'history' && Boolean(interaction.options.getString('campaign-id'));
    if (['add', 'remove', 'set', 'reset-user'].includes(subcommand) || campaignHistory) {
      if (!(await ensureBotOwner(interaction))) return;
    } else {
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.Administrator,
        userPermissionName: 'Administrator',
      });
      if (!access.ok) return;
    }

    if (subcommand === 'add') {
      await handleAddCommand(interaction);
      return;
    }
    if (campaignHistory) {
      await handleCampaignHistory(interaction);
      return;
    }
    if (['remove', 'set'].includes(subcommand)) {
      const target = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason', true);
      const result = await adjustPlayerBalance(interaction.guildId, target.id, {
        action: subcommand, amount, operatorId: interaction.user.id, reason, operationId: interaction.id,
      });
      const label = subcommand === 'remove' ? '扣幣' : '設定餘額';
      await interaction.reply({
        content: `${result.alreadyApplied ? '此操作已處理。\n' : ''}${formatAdminResult(label, displayTargetName(interaction, target), result, reason)}`,
        ephemeral: true,
      });
      return;
    }
    if (subcommand === 'history') {
      // Without campaign-id this is the transaction lookup of one member. These two answers are said
      // here and not through campaignErrorReply, whose fixed campaign texts would read as if campaign
      // data were broken.
      const campaignOnly = campaignOnlyOptionsGiven(interaction.options);
      if (campaignOnly.length) {
        await interaction.reply({ content: historyCampaignIdRequired(campaignOnly), ephemeral: true });
        return;
      }
      const target = interaction.options.getUser('user');
      if (!target) {
        await interaction.reply({ content: HISTORY_USER_REQUIRED, ephemeral: true });
        return;
      }
      const limit = interaction.options.getInteger('limit') || 10;
      const transactions = await getTransactions(interaction.guildId, target.id, { limit });
      if (transactions.length === 0) {
        await interaction.reply({ content: `${displayTargetName(interaction, target)} 目前沒有吉幣交易紀錄。`, ephemeral: true });
        return;
      }
      // A reason can be 300 characters, so up to 25 lines may not fit one message: the reasons are shortened, and
      // the last lines are left out with a line that says how many.
      await interaction.reply({
        content: fitListText({
          header: `**${displayTargetName(interaction, target)} 最近交易紀錄**`,
          items: transactions,
          render: (transaction, { textLimit }) => {
            const timestamp = Math.floor(new Date(transaction.createdAt).getTime() / 1000);
            return `#${transaction.id} <t:${timestamp}:R> ${formatTransactionType(transaction.type)} ${formatCoins(transaction.amount)}：${formatCoins(transaction.balanceBefore)} -> ${formatCoins(transaction.balanceAfter)}｜${clipText(formatTransactionReason(transaction.reason), textLimit)}`;
          },
          note: (count) => omittedLine(count, { unit: '筆交易紀錄' }),
        }),
        ephemeral: true,
      });
      return;
    }
    if (subcommand === 'reset-user') {
      if (interaction.options.getString('confirm', true) !== 'RESET') {
        await interaction.reply({ content: '未輸入 RESET，重置已取消。', ephemeral: true });
        return;
      }
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'owner 重置使用者吉幣資料';
      const result = await resetPlayerData(interaction.guildId, target.id, { operatorId: interaction.user.id, reason });
      await interaction.reply({ content: [
        '使用者全域吉幣錢包、一般債務、簽到與一般商店庫存紀錄已重置。',
        `目標：${displayTargetName(interaction, target)}`,
        `原本餘額：${formatCoins(result.before)}`,
        `最新餘額：${formatCoins(result.after)}`,
        `原因：${reason}`,
      ].join('\n'), ephemeral: true });
      return;
    }
    if (subcommand === 'enable' || subcommand === 'disable') {
      const enabled = subcommand === 'enable';
      const settings = await setGuildEconomyEnabled(interaction.guildId, enabled, { operatorId: interaction.user.id });
      await interaction.reply({ content: `目前伺服器吉幣系統已${settings.enabled ? '啟用' : '停用'}。`, ephemeral: true });
    }
  } catch (error) {
    if (error instanceof CoinCampaignError) {
      const content = campaignErrorReply(error);
      if (interaction.deferred && !interaction.replied) await interaction.editReply(content);
      else await interaction.reply({ content, ephemeral: true });
      return;
    }
    await replyCoinError(interaction, error);
  }
}

module.exports = {
  data,
  execute,
  handleComponent,
  _test: {
    buildAddCustomId,
    buildPreviewEmbed,
    campaignErrorReply,
    componentControl,
    fetchCompleteMembers,
    parseAddCustomId,
    selectNonBotRoleMembers,
  },
};
