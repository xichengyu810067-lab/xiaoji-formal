const crypto = require('node:crypto');
const { withCoinDatabase, withCoinTransaction } = require('../../services/coinDatabase');
const { grantRewardOnceV2WithApi, getRewardReceiptV2, makeRewardKey } = require('../../services/featurePlatformService');
const { isBotOwner } = require('../../utils/ownerOnly');

class CoinCampaignError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoinCampaignError';
    this.code = code;
  }
}

function textId(value, name) {
  const text = String(value || '').trim();
  if (!text || text.length > 160) throw new CoinCampaignError('INVALID_ARGUMENT', `${name} is required.`);
  return text;
}

function requireOwner(actorUserId) {
  const actor = textId(actorUserId, 'actorUserId');
  if (!isBotOwner(actor)) throw new CoinCampaignError('OWNER_ONLY', '只有小吉擁有者可以管理活動發幣。');
  return actor;
}

function audienceKey(input) {
  const campaignId = textId(input.campaignId, 'campaignId');
  const sourceGuildId = textId(input.sourceGuildId, 'sourceGuildId');
  const audienceType = input.audienceType;
  if (!['member', 'role'].includes(audienceType)) throw new CoinCampaignError('INVALID_AUDIENCE', 'Audience must be member or role.');
  const roleId = audienceType === 'role' ? textId(input.roleId, 'roleId') : '';
  return { campaignId, sourceGuildId, audienceType, roleId };
}

function getAudienceRecipients(api, key) {
  return api.all(`SELECT user_id FROM coin_owner_campaign_audience_members
    WHERE campaign_id = ? AND source_guild_id = ? AND audience_type = ? AND role_id = ?
    ORDER BY user_id`, [key.campaignId, key.sourceGuildId, key.audienceType, key.roleId]);
}

function previewToken(campaignId, amount, userIds) {
  return crypto.createHash('sha256').update(JSON.stringify([campaignId, amount, userIds])).digest('hex');
}

function campaignReceiptKey(campaignId, userId) {
  return makeRewardKey({ kind: 'owner-campaign', canonicalSourceId: campaignId, rewardKind: 'campaign', userId });
}

function unresolvedHistoryForUser(source, campaignId, userId) {
  const rewardTypes = new Set(['admin_add', 'system_reward', 'event_reward']);
  const transactions = source.transactions.filter((row) => row.user_id === userId && rewardTypes.has(row.type))
    .filter((row) => {
      try { return JSON.parse(row.metadata || '{}').ownerCampaignId !== campaignId; }
      catch { return true; }
    });
  const legacyGrants = source.legacyGrants.filter((row) => row.user_id === userId);
  const adminLogs = source.adminLogs.filter((row) => row.target_user_id === userId)
    .filter((row) => {
      let details;
      try { details = JSON.parse(row.details || '{}'); }
      catch { return true; }
      return !source.transactions.some((transaction) => transaction.user_id === userId &&
        transaction.guild_id === row.guild_id && transaction.operator_id === row.operator_id &&
        transaction.reason === row.reason && transaction.created_at === row.created_at &&
        Number(transaction.amount) === Number(details.amount) &&
        Number(transaction.balance_before) === Number(details.before) &&
        Number(transaction.balance_after) === Number(details.after));
    });
  return { transactions, legacyGrants, adminLogs };
}

function historyRowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

function matchingAdminLogForTransaction(logs, row) {
  return logs.find((log) => {
    let details;
    try { details = JSON.parse(log.details || '{}'); }
    catch { return false; }
    return log.target_user_id === row.user_id && log.guild_id === row.guild_id &&
      log.operator_id === row.operator_id && log.reason === row.reason &&
      log.created_at === row.created_at && log.action === 'coin_admin:add' &&
      Number(row.amount) === Number(details.amount) &&
      Number(row.balance_before) === Number(details.before) &&
      Number(row.balance_after) === Number(details.after);
  });
}

function historyReviewSource(api, campaignId, userIds) {
  const ids = [...new Set(userIds)].sort();
  const transactions = [];
  const legacyGrants = [];
  const adminLogs = [];
  const recipientSourceSha256 = {};
  for (const userId of ids) {
    const ownReceipt = api.get(`SELECT transaction_id, metadata_json FROM reward_grants_v2
      WHERE kind = 'owner-campaign' AND canonical_source_id = ?
        AND reward_kind = 'campaign' AND user_id = ?`, [campaignId, userId]);
    let ownNewTransactionId = null;
    if (ownReceipt) {
      let metadata;
      try { metadata = JSON.parse(ownReceipt.metadata_json || '{}'); }
      catch { throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Campaign receipt metadata is invalid.'); }
      if (metadata.imported !== true) ownNewTransactionId = Number(ownReceipt.transaction_id);
    }
    const userTransactions = api.all('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY id', [userId])
      .filter((row) => Number(row.id) !== ownNewTransactionId);
    const userLegacyGrants = api.all('SELECT * FROM reward_grants WHERE user_id = ? ORDER BY id', [userId]);
    const userAdminLogs = api.all('SELECT * FROM coin_admin_logs WHERE target_user_id = ? ORDER BY id', [userId]);
    transactions.push(...userTransactions);
    legacyGrants.push(...userLegacyGrants);
    adminLogs.push(...userAdminLogs);
    recipientSourceSha256[userId] = crypto.createHash('sha256')
      .update(JSON.stringify([campaignId, userId, userTransactions, userLegacyGrants, userAdminLogs])).digest('hex');
  }
  return {
    campaignId, userIds: ids, transactions, legacyGrants, adminLogs, recipientSourceSha256,
    unresolvedByUser: Object.fromEntries(ids.map((userId) =>
      [userId, unresolvedHistoryForUser({ transactions, legacyGrants, adminLogs }, campaignId, userId)])),
    sourceSha256: crypto.createHash('sha256')
      .update(JSON.stringify([campaignId, ids, transactions, legacyGrants, adminLogs])).digest('hex'),
  };
}

async function getOwnerCampaignHistoryReviewPlan(input) {
  requireOwner(input.actorUserId);
  const campaignId = textId(input.campaignId, 'campaignId');
  if (!Array.isArray(input.userIds) || input.userIds.length === 0) {
    throw new CoinCampaignError('INVALID_HISTORY', 'Review recipients are required.');
  }
  const userIds = [...new Set(input.userIds.map((id) => textId(id, 'userId')))].sort();
  return withCoinDatabase((api) => {
    if (!api.get('SELECT 1 FROM coin_owner_campaigns WHERE campaign_id = ?', [campaignId])) {
      throw new CoinCampaignError('CAMPAIGN_NOT_FOUND', 'Campaign preview does not exist.');
    }
    for (const userId of userIds) {
      if (!api.get('SELECT 1 FROM coin_owner_campaign_recipients WHERE campaign_id = ? AND user_id = ?',
        [campaignId, userId])) throw new CoinCampaignError('INVALID_HISTORY', 'Recipient is not in the campaign snapshot.');
    }
    return historyReviewSource(api, campaignId, userIds);
  });
}

async function classifyOwnerCampaignHistoryRecord(input) {
  const actorUserId = requireOwner(input.actorUserId);
  const campaignId = textId(input.campaignId, 'campaignId');
  const userId = textId(input.userId, 'userId');
  const recordType = input.recordType;
  const recordId = Number(input.recordId);
  const evidenceReference = String(input.evidenceReference || '').trim();
  const reviewReason = String(input.reviewReason || '').trim();
  const evidenceMode = input.evidenceMode || 'record';
  if (!['transaction', 'legacy_grant', 'admin_log'].includes(recordType) ||
      !Number.isSafeInteger(recordId) || recordId <= 0 ||
      !evidenceReference || evidenceReference.length > 200 ||
      !reviewReason || reviewReason.length > 300 || evidenceReference === campaignId ||
      !['record', 'owner_evidence'].includes(evidenceMode)) {
    throw new CoinCampaignError('INVALID_HISTORY', 'An exact other source and review reason are required.');
  }
  return withCoinTransaction((api) => {
    const source = historyReviewSource(api, campaignId, [userId]);
    if (source.sourceSha256 !== input.sourceSha256) {
      throw new CoinCampaignError('HISTORY_SOURCE_CHANGED', 'Reviewed transaction source has changed.');
    }
    if (!api.get('SELECT 1 FROM coin_owner_campaign_recipients WHERE campaign_id = ? AND user_id = ?',
      [campaignId, userId])) throw new CoinCampaignError('INVALID_HISTORY', 'Recipient is not in the campaign snapshot.');
    const candidates = source.unresolvedByUser[userId];
    const rows = recordType === 'transaction' ? candidates.transactions :
      recordType === 'legacy_grant' ? candidates.legacyGrants : candidates.adminLogs;
    const row = rows.find((item) => Number(item.id) === recordId);
    if (!row) throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Source record is not a reviewable candidate.');
    let linkedAdminLogId = null;
    if (recordType === 'transaction') {
      let metadata;
      try { metadata = JSON.parse(row.metadata || '{}'); }
      catch { metadata = null; }
      const namedSources = [metadata?.ownerCampaignId, metadata?.canonicalSourceId].filter(Boolean);
      if (namedSources.includes(campaignId) || namedSources.some((named) => named !== evidenceReference)) {
        throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED',
          `交易 #${recordId} 已標記本活動或與核對來源不符。`);
      }
      if (namedSources.length && evidenceMode !== 'record') {
        throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED', '已有交易來源識別時須按紀錄來源核對。');
      }
      if (!namedSources.length && evidenceMode === 'owner_evidence') {
        const linkedLog = row.type === 'admin_add' && matchingAdminLogForTransaction(source.adminLogs, row);
        if (!linkedLog) {
          throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED',
            `交易 #${recordId} 沒有可連結的管理加款紀錄，不能以人工外部憑證判定。`);
        }
        linkedAdminLogId = linkedLog.id;
      } else if (!namedSources.length) {
        throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED',
          `交易 #${recordId} 未標記來源；須由 OWNER 選擇人工外部憑證並核對管理紀錄。`);
      }
    } else if (recordType === 'legacy_grant') {
      if (evidenceMode !== 'record') throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED', '舊獎勵須按既有來源欄位核對。');
      if (row.source_id === campaignId || row.source_type === 'owner-campaign' ||
          `${row.source_type}:${row.source_id}` !== evidenceReference) {
        throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED',
          `舊獎勵 #${recordId} 的來源與核對依據不符。`);
      }
    } else {
      if (evidenceMode !== 'record') throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED', '管理紀錄須按既有來源欄位核對。');
      let details;
      try { details = JSON.parse(row.details || '{}'); }
      catch { details = null; }
      const namedSource = details?.sourceId || details?.campaignId;
      if (!namedSource || namedSource !== evidenceReference) {
        throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED',
          `管理紀錄 #${recordId} 缺少可核對的其他活動來源，不能判為未發。`);
      }
    }
    const timestamp = new Date().toISOString();
    const rowSha256 = historyRowHash(row);
    api.run(`INSERT INTO coin_owner_campaign_history_classifications
      (campaign_id, user_id, record_type, record_id, row_sha256, source_sha256,
       evidence_reference, review_reason, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, user_id, record_type, record_id) DO UPDATE SET
        row_sha256 = excluded.row_sha256, source_sha256 = excluded.source_sha256,
        evidence_reference = excluded.evidence_reference, review_reason = excluded.review_reason,
        reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
    [campaignId, userId, recordType, recordId, rowSha256,
      source.recipientSourceSha256[userId],
      evidenceMode === 'owner_evidence'
        ? JSON.stringify({ mode: 'owner_evidence', reference: evidenceReference, linkedAdminLogId })
        : evidenceReference,
      reviewReason, actorUserId, timestamp]);
    return { campaignId, userId, recordType, recordId, rowSha256,
      evidenceReference, evidenceMode, linkedAdminLogId };
  });
}

async function reviewOwnerCampaignHistory(input) {
  const actorUserId = requireOwner(input.actorUserId);
  const campaignId = textId(input.campaignId, 'campaignId');
  const reviewId = textId(input.reviewId, 'reviewId');
  const sourceSha256 = String(input.sourceSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || !/^[a-f0-9]{64}$/.test(reviewId) ||
      !Array.isArray(input.decisions) || input.decisions.length === 0) {
    throw new CoinCampaignError('INVALID_HISTORY', 'Exact source, review manifest SHA-256, and recipient decisions are required.');
  }
  const decisions = input.decisions.map((item) => ({
    userId: textId(item.userId, 'userId'), priorGrant: item.priorGrant,
    reviewedTransactionIds: item.reviewedTransactionIds,
    reviewedLegacyGrantIds: item.reviewedLegacyGrantIds,
    reviewedAdminLogIds: item.reviewedAdminLogIds,
    reviewReason: String(item.reviewReason || '').trim(),
  }));
  if (new Set(decisions.map((item) => item.userId)).size !== decisions.length ||
      decisions.some((item) => typeof item.priorGrant !== 'boolean' ||
        !Array.isArray(item.reviewedTransactionIds) || !Array.isArray(item.reviewedLegacyGrantIds) ||
        !Array.isArray(item.reviewedAdminLogIds) ||
        !item.reviewReason || item.reviewReason.length > 300)) {
    throw new CoinCampaignError('INVALID_HISTORY', 'Every recipient needs a reviewed source inventory and decision.');
  }
  return withCoinTransaction((api) => {
    const source = historyReviewSource(api, campaignId, decisions.map((item) => item.userId));
    if (source.sourceSha256 !== sourceSha256) {
      throw new CoinCampaignError('HISTORY_SOURCE_CHANGED', 'Reviewed transaction source has changed.');
    }
    const campaign = api.get('SELECT amount FROM coin_owner_campaigns WHERE campaign_id = ?', [campaignId]);
    if (!campaign) throw new CoinCampaignError('CAMPAIGN_NOT_FOUND', 'Campaign preview does not exist.');
    const timestamp = new Date().toISOString();
    for (const decision of decisions) {
      const actualTransactions = source.transactions.filter((row) => row.user_id === decision.userId);
      const actualLegacyGrants = source.legacyGrants.filter((row) => row.user_id === decision.userId);
      const actualAdminLogs = source.adminLogs.filter((row) => row.target_user_id === decision.userId);
      const listedTransactions = [...decision.reviewedTransactionIds].map(Number).sort((a, b) => a - b);
      const listedLegacyGrants = [...decision.reviewedLegacyGrantIds].map(Number).sort((a, b) => a - b);
      const listedAdminLogs = [...decision.reviewedAdminLogIds].map(Number).sort((a, b) => a - b);
      if (JSON.stringify(listedTransactions) !== JSON.stringify(actualTransactions.map((row) => Number(row.id)).sort((a, b) => a - b)) ||
          JSON.stringify(listedLegacyGrants) !== JSON.stringify(actualLegacyGrants.map((row) => Number(row.id)).sort((a, b) => a - b)) ||
          JSON.stringify(listedAdminLogs) !== JSON.stringify(actualAdminLogs.map((row) => Number(row.id)).sort((a, b) => a - b))) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Reviewed transaction inventory is incomplete.');
      }
      if (!decision.priorGrant && actualTransactions.some((row) => {
        try {
          const metadata = JSON.parse(row.metadata || '{}');
          return metadata.ownerCampaignId === campaignId || metadata.canonicalSourceId === campaignId;
        }
        catch { return false; }
      })) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'A transaction names this campaign but has no imported receipt.');
      }
      if (!decision.priorGrant && actualLegacyGrants.some((row) =>
        row.source_id === campaignId || row.source_type === 'owner-campaign')) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT',
          'A legacy grant names this campaign and cannot be marked unrelated.');
      }
      const unresolved = source.unresolvedByUser[decision.userId];
      if (!decision.priorGrant) {
        const records = [
          ...unresolved.transactions.map((row) => ({ type: 'transaction', row })),
          ...unresolved.legacyGrants.map((row) => ({ type: 'legacy_grant', row })),
          ...unresolved.adminLogs.map((row) => ({ type: 'admin_log', row })),
        ];
        for (const record of records) {
          const classification = api.get(`SELECT * FROM coin_owner_campaign_history_classifications
            WHERE campaign_id = ? AND user_id = ? AND record_type = ? AND record_id = ?`,
          [campaignId, decision.userId, record.type, record.row.id]);
          if (!classification || classification.row_sha256 !== historyRowHash(record.row) ||
              classification.source_sha256 !== source.recipientSourceSha256[decision.userId]) {
            throw new CoinCampaignError('HISTORY_SOURCE_UNRESOLVED',
              `${decision.userId} 的 ${record.type} #${record.row.id} 尚未核實其他來源，該成員不能發幣。`);
          }
        }
      }
      if (!api.get('SELECT 1 FROM coin_owner_campaign_recipients WHERE campaign_id = ? AND user_id = ?',
        [campaignId, decision.userId])) {
        throw new CoinCampaignError('INVALID_HISTORY', 'Recipient is not in the campaign snapshot.');
      }
      const receipt = api.get(`SELECT * FROM reward_grants_v2 WHERE kind = 'owner-campaign'
        AND canonical_source_id = ? AND reward_kind = 'campaign' AND user_id = ?`,
      [campaignId, decision.userId]);
      let imported = false;
      if (receipt) {
        let metadata;
        try { metadata = JSON.parse(receipt.metadata_json || '{}'); }
        catch { throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Campaign receipt metadata is invalid.'); }
        imported = metadata.imported === true;
      }
      if (decision.priorGrant !== imported ||
          (receipt && Number(receipt.amount) !== Number(campaign.amount))) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT',
          'Prior grant decision requires a matching imported campaign receipt.');
      }
      const existing = api.get(`SELECT * FROM coin_owner_campaign_history_reviews
        WHERE campaign_id = ? AND user_id = ?`, [campaignId, decision.userId]);
      if (existing) {
        if (Number(existing.prior_grant) === 1 && !decision.priorGrant) {
          throw new CoinCampaignError('HISTORY_REVIEW_CONFLICT', 'A prior grant cannot be cleared by a later review.');
        }
        api.run(`UPDATE coin_owner_campaign_history_reviews SET prior_grant = ?, source_sha256 = ?,
          review_batch_sha256 = ?, review_id = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?
          WHERE campaign_id = ? AND user_id = ?`,
        [Number(decision.priorGrant), source.recipientSourceSha256[decision.userId],
          sourceSha256, reviewId, decision.reviewReason, actorUserId, timestamp,
          campaignId, decision.userId]);
        continue;
      }
      api.run(`INSERT INTO coin_owner_campaign_history_reviews
        (campaign_id, user_id, prior_grant, source_sha256, review_batch_sha256,
         review_id, review_reason, reviewed_by, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [campaignId, decision.userId, Number(decision.priorGrant),
        source.recipientSourceSha256[decision.userId], sourceSha256,
        reviewId, decision.reviewReason, actorUserId, timestamp]);
    }
    return { campaignId, reviewed: decisions.length, reviewId, sourceSha256 };
  });
}

async function previewOwnerCampaign(input) {
  const key = audienceKey(input);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 9_000_000_000) {
    throw new CoinCampaignError('INVALID_AMOUNT', 'Campaign amount must be a positive safe integer.');
  }
  const reason = String(input.reason || '').trim().slice(0, 300);
  if (!reason) throw new CoinCampaignError('INVALID_REASON', 'Campaign reason is required.');
  const actorUserId = requireOwner(input.actorUserId);
  if (!Array.isArray(input.memberIds)) throw new CoinCampaignError('INVALID_MEMBERS', 'Complete member snapshot is required.');
  const memberIds = [...new Set(input.memberIds.map((id) => textId(id, 'memberId')))].sort();
  const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(memberIds)).digest('hex');
  return withCoinTransaction((api) => {
    const timestamp = new Date().toISOString();
    const existing = api.get('SELECT * FROM coin_owner_campaigns WHERE campaign_id = ?', [key.campaignId]);
    if (existing && Number(existing.amount) !== amount) {
      throw new CoinCampaignError('CAMPAIGN_CONFLICT', 'Campaign ID already has a different amount.');
    }
    if (!existing) {
      api.run(`INSERT INTO coin_owner_campaigns
        (campaign_id, amount, reason, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [key.campaignId, amount, reason, actorUserId, timestamp, timestamp]);
    }
    api.run(`INSERT INTO coin_owner_campaign_audiences
      (campaign_id, source_guild_id, audience_type, role_id, audience_hash, snapshot_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, source_guild_id, audience_type, role_id) DO UPDATE SET
        audience_hash = excluded.audience_hash,
        snapshot_count = excluded.snapshot_count,
        updated_at = excluded.updated_at`,
    [key.campaignId, key.sourceGuildId, key.audienceType, key.roleId,
      snapshotHash, memberIds.length, timestamp]);
    let newRecipients = 0;
    for (const userId of memberIds) {
      api.run(`INSERT INTO coin_owner_campaign_recipients
        (campaign_id, user_id, first_source_guild_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [key.campaignId, userId, key.sourceGuildId, timestamp, timestamp]);
      newRecipients += Number(api.get('SELECT changes() AS count').count) === 1 &&
        !api.get('SELECT 1 FROM coin_owner_campaign_audience_members WHERE campaign_id = ? AND source_guild_id = ? AND audience_type = ? AND role_id = ? AND user_id = ?',
          [key.campaignId, key.sourceGuildId, key.audienceType, key.roleId, userId]) ? 1 : 0;
      api.run(`INSERT INTO coin_owner_campaign_audience_members
        (campaign_id, source_guild_id, audience_type, role_id, user_id, first_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, source_guild_id, audience_type, role_id, user_id) DO NOTHING`,
      [key.campaignId, key.sourceGuildId, key.audienceType, key.roleId, userId, timestamp]);
    }
    const recipients = getAudienceRecipients(api, key).map((row) => row.user_id);
    const claimed = api.all(`SELECT user_id, amount FROM reward_grants_v2
      WHERE kind = 'owner-campaign' AND canonical_source_id = ? AND reward_kind = 'campaign'`,
    [key.campaignId]);
    if (claimed.some((row) => Number(row.amount) !== amount)) {
      throw new CoinCampaignError('CAMPAIGN_RECEIPT_CONFLICT', '活動收據金額與活動設定不同，必須先對帳。');
    }
    const claimedSet = new Set(claimed.map((row) => row.user_id));
    const alreadyGranted = recipients.filter((userId) => claimedSet.has(userId)).length;
    const reviewed = new Set(api.all(`SELECT user_id FROM coin_owner_campaign_history_reviews
      WHERE campaign_id = ?`, [key.campaignId]).map((row) => row.user_id));
    const pendingAmount = (recipients.length - alreadyGranted) * amount;
    if (!Number.isSafeInteger(pendingAmount)) throw new CoinCampaignError('AMOUNT_OVERFLOW', 'Campaign total exceeds the supported range.');
    return {
      ...key, amount, snapshotCount: memberIds.length, cumulativeRecipients: recipients.length,
      newRecipients, alreadyGranted, pending: recipients.length - alreadyGranted,
      historyUnreviewed: recipients.filter((userId) => !reviewed.has(userId)).length,
      pendingAmount,
      previewToken: previewToken(key.campaignId, amount, recipients),
    };
  });
}

async function getOwnerCampaignPreview(input) {
  requireOwner(input.actorUserId);
  const key = audienceKey(input);
  return withCoinDatabase((api) => {
    const campaign = api.get('SELECT * FROM coin_owner_campaigns WHERE campaign_id = ?', [key.campaignId]);
    const audience = api.get(`SELECT * FROM coin_owner_campaign_audiences
      WHERE campaign_id = ? AND source_guild_id = ? AND audience_type = ? AND role_id = ?`,
    [key.campaignId, key.sourceGuildId, key.audienceType, key.roleId]);
    if (!campaign || !audience) throw new CoinCampaignError('CAMPAIGN_NOT_FOUND', 'Campaign preview does not exist.');
    const recipients = getAudienceRecipients(api, key).map((row) => row.user_id);
    return { ...key, amount: Number(campaign.amount), reason: campaign.reason,
      recipients, previewToken: previewToken(key.campaignId, Number(campaign.amount), recipients) };
  });
}

async function applyOwnerCampaign(input) {
  const preview = await getOwnerCampaignPreview(input);
  const historyState = await withCoinDatabase((api) => {
    const unreviewed = [];
    const stale = [];
    const pending = [];
    for (const userId of preview.recipients) {
      const receipt = api.get(`SELECT 1 FROM reward_grants_v2 WHERE kind = 'owner-campaign'
        AND canonical_source_id = ? AND reward_kind = 'campaign' AND user_id = ?`,
      [preview.campaignId, userId]);
      if (!receipt) pending.push(userId);
      const review = api.get(`SELECT source_sha256 FROM coin_owner_campaign_history_reviews
        WHERE campaign_id = ? AND user_id = ?`, [preview.campaignId, userId]);
      if (!review) {
        if (!receipt) unreviewed.push(userId);
        continue;
      }
      if (!receipt && historyReviewSource(api, preview.campaignId, [userId])
        .recipientSourceSha256[userId] !== review.source_sha256) stale.push(userId);
    }
    return { unreviewed, stale, pending };
  });
  if (historyState.pending.length > 0 &&
      historyState.unreviewed.length + historyState.stale.length === historyState.pending.length &&
      historyState.unreviewed.length) {
    throw new CoinCampaignError('CAMPAIGN_HISTORY_UNRECONCILED',
      `${historyState.unreviewed.length} 人尚未完成歷史發幣核對，不能發幣。`);
  }
  if (historyState.pending.length > 0 &&
      historyState.stale.length === historyState.pending.length) {
    throw new CoinCampaignError('CAMPAIGN_HISTORY_CHANGED',
      `${historyState.stale.length} 人的交易來源在核對後變更，須重新查看並核對。`);
  }
  if (input.previewToken !== preview.previewToken) {
    throw new CoinCampaignError('PREVIEW_CHANGED', 'Campaign preview changed. Run preview again.');
  }
  if (!Array.isArray(input.presentMemberIds)) {
    throw new CoinCampaignError('INVALID_MEMBERS', 'Complete current member snapshot is required.');
  }
  const present = new Set(input.presentMemberIds.map((id) => textId(id, 'memberId')));
  const existingRecipients = await withCoinDatabase((api) => api.all(
    `SELECT user_id, amount FROM reward_grants_v2 WHERE kind = 'owner-campaign'
     AND canonical_source_id = ? AND reward_kind = 'campaign'`, [preview.campaignId]
  ));
  if (existingRecipients.some((row) => Number(row.amount) !== preview.amount)) {
    throw new CoinCampaignError('CAMPAIGN_RECEIPT_CONFLICT', '活動收據金額與活動設定不同，必須先對帳。');
  }
  const alreadyClaimed = new Set(existingRecipients.map((row) => row.user_id));
  const result = { campaignId: preview.campaignId, audienceType: preview.audienceType,
    total: preview.recipients.length, granted: 0, alreadyGranted: 0, leftGuild: [],
    historyBlocked: [], failed: [], amountGranted: 0, remaining: 0 };
  const unreviewedSet = new Set(historyState.unreviewed);
  const staleSet = new Set(historyState.stale);
  let attempted = 0;
  for (const userId of preview.recipients) {
    if (alreadyClaimed.has(userId)) {
      result.alreadyGranted += 1;
      continue;
    }
    if (unreviewedSet.has(userId) || staleSet.has(userId)) {
      result.historyBlocked.push({ userId, code: unreviewedSet.has(userId)
        ? 'CAMPAIGN_HISTORY_UNRECONCILED' : 'CAMPAIGN_HISTORY_CHANGED' });
      continue;
    }
    if (!present.has(userId)) {
      result.leftGuild.push(userId);
      continue;
    }
    if (attempted >= 100) {
      result.remaining += 1;
      continue;
    }
    attempted += 1;
    const rewardKey = campaignReceiptKey(preview.campaignId, userId);
    const rewardInput = { kind: 'owner-campaign', canonicalSourceId: preview.campaignId,
      rewardKind: 'campaign', userId, sourceGuildId: preview.sourceGuildId,
      amount: preview.amount, operationId: rewardKey,
      actorUserId: input.actorUserId, metadata: { audienceType: preview.audienceType } };
    try {
      const grant = await withCoinTransaction((api) => {
        const review = api.get(`SELECT source_sha256 FROM coin_owner_campaign_history_reviews
          WHERE campaign_id = ? AND user_id = ?`, [preview.campaignId, userId]);
        if (!review || historyReviewSource(api, preview.campaignId, [userId])
          .recipientSourceSha256[userId] !== review.source_sha256) {
          throw new CoinCampaignError('CAMPAIGN_HISTORY_CHANGED', `${userId} 的交易來源在發幣前變更。`);
        }
        return grantRewardOnceV2WithApi(api, rewardInput);
      });
      if (grant.alreadyGranted) result.alreadyGranted += 1;
      else {
        result.granted += 1;
        result.amountGranted += preview.amount;
      }
    } catch (error) {
      try {
        const receipt = await getRewardReceiptV2({ rewardKey });
        if (receipt && receipt.amount === preview.amount && receipt.userId === userId) {
          result.alreadyGranted += 1;
          continue;
        }
      } catch { /* An unknown outcome is reported for manual review. */ }
      result.failed.push({ userId, code: error.code || 'UNKNOWN_OUTCOME' });
    }
  }
  return result;
}

async function importOwnerCampaignHistory(input) {
  const campaignId = textId(input.campaignId, 'campaignId');
  const actorUserId = requireOwner(input.actorUserId);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 9_000_000_000) {
    throw new CoinCampaignError('INVALID_AMOUNT', 'Campaign amount is invalid.');
  }
  if (!Array.isArray(input.recipientRecords) || input.recipientRecords.length === 0) {
    throw new CoinCampaignError('INVALID_HISTORY', 'Reviewed recipient records are required.');
  }
  const reason = String(input.reason || '').trim().slice(0, 300);
  if (!reason) throw new CoinCampaignError('INVALID_REASON', 'Campaign reason is required.');
  const records = input.recipientRecords.map((record) => ({
    userId: textId(record.userId, 'userId'),
    transactionId: Number(record.transactionId),
    evidenceHash: String(record.evidenceHash || '').toLowerCase(),
  }));
  if (new Set(records.map((record) => record.userId)).size !== records.length ||
      records.some((record) => !Number.isSafeInteger(record.transactionId) || record.transactionId <= 0 ||
        !/^[a-f0-9]{64}$/.test(record.evidenceHash))) {
    throw new CoinCampaignError('INVALID_HISTORY', 'Each recipient needs unique, verifiable transaction evidence.');
  }
  return withCoinTransaction((api) => {
    const timestamp = new Date().toISOString();
    const campaign = api.get('SELECT * FROM coin_owner_campaigns WHERE campaign_id = ?', [campaignId]);
    if (campaign && Number(campaign.amount) !== amount) {
      throw new CoinCampaignError('CAMPAIGN_CONFLICT', 'Campaign amount differs from the recorded campaign.');
    }
    if (!campaign) {
      api.run(`INSERT INTO coin_owner_campaigns
        (campaign_id, amount, reason, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [campaignId, amount, reason, actorUserId, timestamp, timestamp]);
    }
    let imported = 0;
    for (const record of records) {
      const transaction = api.get(`SELECT * FROM coin_transactions
        WHERE id = ? AND user_id = ? AND wallet_scope = 'global'`, [record.transactionId, record.userId]);
      if (!transaction || !['admin_add', 'system_reward', 'event_reward'].includes(transaction.type) ||
        Number(transaction.amount) < 0) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Transaction evidence does not match the recipient.');
      }
      const actualHash = crypto.createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
      if (actualHash !== record.evidenceHash) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Transaction evidence hash has changed.');
      }
      let metadata;
      try { metadata = JSON.parse(transaction.metadata || '{}'); }
      catch { metadata = null; }
      const debtOffset = metadata?.debtOffset;
      const offset = debtOffset == null ? 0 : Number(debtOffset.offset);
      const gross = debtOffset == null ? Number(transaction.amount) : Number(debtOffset.gross);
      const net = Number(transaction.amount);
      if (metadata?.ownerCampaignId !== campaignId ||
          !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(gross) || gross !== amount ||
          !Number.isSafeInteger(net) || net < 0 || net + offset !== gross ||
          (debtOffset != null && Number(debtOffset.net) !== net)) {
        throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT',
          'Transaction does not prove this campaign and its gross, debt-offset, and net amounts.');
      }
      const rewardKey = campaignReceiptKey(campaignId, record.userId);
      const payloadHash = crypto.createHash('sha256')
        .update(JSON.stringify(['owner-campaign', campaignId, 'campaign', record.userId, amount])).digest('hex');
      const existing = api.get('SELECT * FROM reward_grants_v2 WHERE reward_key = ?', [rewardKey]);
      if (existing) {
        if (existing.payload_hash !== payloadHash || Number(existing.transaction_id) !== record.transactionId) {
          throw new CoinCampaignError('HISTORY_EVIDENCE_CONFLICT', 'Existing receipt differs from reviewed evidence.');
        }
        continue;
      }
      api.run(`INSERT INTO reward_grants_v2
        (reward_key, operation_id, kind, canonical_source_id, reward_kind, user_id,
         source_guild_id, amount, payload_hash, metadata_json, debt_offset, net_amount,
         transaction_id, created_at)
        VALUES (?, ?, 'owner-campaign', ?, 'campaign', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rewardKey, rewardKey, campaignId, record.userId, transaction.guild_id, amount,
        payloadHash, JSON.stringify({ imported: true, evidenceHash: record.evidenceHash }),
        offset, net, record.transactionId, timestamp]);
      imported += 1;
    }
    return { campaignId, imported, alreadyRecorded: records.length - imported };
  });
}

module.exports = { CoinCampaignError, applyOwnerCampaign, getOwnerCampaignPreview,
  classifyOwnerCampaignHistoryRecord, getOwnerCampaignHistoryReviewPlan,
  importOwnerCampaignHistory, previewOwnerCampaign,
  reviewOwnerCampaignHistory };
