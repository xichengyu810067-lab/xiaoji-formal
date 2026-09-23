const fs = require('node:fs');
const path = require('node:path');

const quotaPath = path.join(__dirname, '..', 'data', 'guildQuotas.json');
const QUOTA_EXHAUSTED_MESSAGE = '小吉現在有點忙，請晚點再試。';

function ensureQuotaFile() {
  const directory = path.dirname(quotaPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(quotaPath)) {
    fs.writeFileSync(quotaPath, '{}\n', 'utf8');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeQuota(record) {
  const quota = isPlainObject(record) ? record : {};
  const limit = Number.isSafeInteger(quota.limit) && quota.limit >= 0 ? quota.limit : null;
  const used = Number.isSafeInteger(quota.used) && quota.used >= 0 ? quota.used : 0;

  return {
    limit,
    used,
    updatedAt: typeof quota.updatedAt === 'string' ? quota.updatedAt : null,
  };
}

function readAllQuotas() {
  ensureQuotaFile();

  try {
    const raw = fs.readFileSync(quotaPath, 'utf8').trim();

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function writeAllQuotas(quotas) {
  ensureQuotaFile();
  fs.writeFileSync(quotaPath, `${JSON.stringify(quotas, null, 2)}\n`, 'utf8');
}

function getGuildQuota(guildId) {
  const quotas = readAllQuotas();
  return normalizeQuota(quotas[guildId]);
}

function listGuildQuotas() {
  const quotas = readAllQuotas();

  return Object.entries(quotas)
    .map(([guildId, quota]) => ({
      guildId,
      ...normalizeQuota(quota),
    }))
    .sort((a, b) => a.guildId.localeCompare(b.guildId));
}

function setGuildQuota(guildId, limit, used = null) {
  const nextLimit = Number(limit);

  if (!Number.isSafeInteger(nextLimit) || nextLimit < 0) {
    throw new Error('Quota limit must be a non-negative integer.');
  }

  const quotas = readAllQuotas();
  const current = normalizeQuota(quotas[guildId]);
  const nextUsed = used === null ? current.used : Number(used);

  if (!Number.isSafeInteger(nextUsed) || nextUsed < 0) {
    throw new Error('Quota used value must be a non-negative integer.');
  }

  quotas[guildId] = {
    limit: nextLimit,
    used: nextUsed,
    updatedAt: new Date().toISOString(),
  };

  writeAllQuotas(quotas);
  return normalizeQuota(quotas[guildId]);
}

function resetGuildQuota(guildId, { clearLimit = false } = {}) {
  const quotas = readAllQuotas();
  const current = normalizeQuota(quotas[guildId]);

  if (clearLimit) {
    delete quotas[guildId];
    writeAllQuotas(quotas);
    return normalizeQuota(null);
  }

  quotas[guildId] = {
    limit: current.limit,
    used: 0,
    updatedAt: new Date().toISOString(),
  };

  writeAllQuotas(quotas);
  return normalizeQuota(quotas[guildId]);
}

function tryConsumeGuildQuota(guildId, amount = 1) {
  if (!guildId) {
    return { ok: true };
  }

  const cost = Number(amount);

  if (!Number.isSafeInteger(cost) || cost <= 0) {
    throw new Error('Quota amount must be a positive integer.');
  }

  const quotas = readAllQuotas();
  const current = normalizeQuota(quotas[guildId]);

  if (current.limit === null) {
    return { ok: true };
  }

  if (current.used + cost > current.limit) {
    return {
      ok: false,
      message: QUOTA_EXHAUSTED_MESSAGE,
    };
  }

  quotas[guildId] = {
    limit: current.limit,
    used: current.used + cost,
    updatedAt: new Date().toISOString(),
  };
  writeAllQuotas(quotas);

  return {
    ok: true,
    quota: normalizeQuota(quotas[guildId]),
  };
}

function formatQuotaForOwner(guildId, quota) {
  const limit = quota.limit === null ? 'unlimited' : String(quota.limit);
  return `guild_id: ${guildId}\nused: ${quota.used}\nlimit: ${limit}`;
}

module.exports = {
  QUOTA_EXHAUSTED_MESSAGE,
  formatQuotaForOwner,
  getGuildQuota,
  listGuildQuotas,
  quotaPath,
  readAllQuotas,
  resetGuildQuota,
  setGuildQuota,
  tryConsumeGuildQuota,
};
