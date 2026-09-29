const { createHash, randomUUID } = require('node:crypto');
const { ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { isGuildApproved } = require('./auditService');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  getGuildFeatureSetting,
  recordFeatureUsage,
  setFeatureHealth,
} = require('./featurePlatformService');

const FEATURE_KEY = 'release_announcements';
const DEFAULT_REPOSITORY = 'xichengyu810067-lab/xiaoji-formal';
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const RELEASES_PER_PAGE = 50;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERIES_PER_POLL = 10;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

class ReleaseAnnouncementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseAnnouncementError';
    this.code = code;
  }
}

function boundedText(value, maxLength, fallback = '') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!text) return fallback;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parseRepository(value = DEFAULT_REPOSITORY) {
  const repository = String(value || DEFAULT_REPOSITORY).trim();
  const match = repository.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!match || match[2].startsWith('.') || match[2].endsWith('.') || match[2].includes('..')) {
    throw new ReleaseAnnouncementError('CONFIG_INVALID', 'GitHub release repository is invalid.');
  }
  return { owner: match[1], repo: match[2], repository: `${match[1]}/${match[2]}` };
}

function parsePollInterval(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(value);
  return Number.isSafeInteger(interval) && interval >= MIN_POLL_INTERVAL_MS && interval <= MAX_POLL_INTERVAL_MS
    ? interval
    : DEFAULT_POLL_INTERVAL_MS;
}

function readReleaseAnnouncementConfig(env = process.env) {
  const requestedRepository = String(env.GITHUB_RELEASE_REPOSITORY || '').trim();
  if (requestedRepository && parseRepository(requestedRepository).repository !== DEFAULT_REPOSITORY) {
    throw new ReleaseAnnouncementError('CONFIG_INVALID', 'Release announcements must use the approved public repository.');
  }
  const repository = parseRepository(DEFAULT_REPOSITORY);
  const token = String(env.GITHUB_RELEASE_TOKEN || '').trim();
  if (token && (token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token))) {
    throw new ReleaseAnnouncementError('CONFIG_INVALID', 'GitHub release token is invalid.');
  }
  const dispatchSetting = String(env.XIAOJI_RELEASE_DISPATCH_ENABLED ?? 'true').trim().toLowerCase();
  if (!['true', 'false', '1', '0'].includes(dispatchSetting)) {
    throw new ReleaseAnnouncementError('CONFIG_INVALID', 'Release dispatch setting is invalid.');
  }
  return { ...repository, token: token || null, pollIntervalMs: parsePollInterval(env.GITHUB_RELEASE_POLL_INTERVAL_MS),
    dispatchEnabled: dispatchSetting === 'true' || dispatchSetting === '1' };
}

function parseStableSemver(tagName) {
  const match = String(tagName || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 2_147_483_647) || parts[0] < 1) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2], normalized: `${parts[0]}.${parts[1]}.${parts[2]}` };
}

function validateReleaseUrl(value, { owner, repo }, tagName) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_error) { throw new ReleaseAnnouncementError('RELEASE_INVALID', 'Release URL is invalid.'); }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); }
  catch (_error) { throw new ReleaseAnnouncementError('RELEASE_INVALID', 'Release URL path is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
      url.search || url.hash || decodedPath !== `/${owner}/${repo}/releases/tag/${tagName}`) {
    throw new ReleaseAnnouncementError('RELEASE_INVALID', 'Release URL does not match the configured repository and tag.');
  }
  return `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`;
}

function normalizeRelease(raw, repositoryConfig) {
  if (!raw || raw.draft !== false || raw.prerelease !== false) return null;
  const version = parseStableSemver(raw.tag_name);
  if (!version) return null;
  const rawId = String(raw.id ?? '');
  const releaseId = /^\d{1,30}$/.test(rawId) && (typeof raw.id !== 'number' || Number.isSafeInteger(raw.id))
    ? String(BigInt(rawId)) : null;
  const publishedAt = new Date(raw.published_at);
  if (!releaseId || Number.isNaN(publishedAt.getTime())) return null;
  let htmlUrl;
  try { htmlUrl = validateReleaseUrl(raw.html_url, repositoryConfig, raw.tag_name); }
  catch (_error) { return null; }
  const releaseName = boundedText(raw.name, 200, `Release ${raw.tag_name}`);
  const bodySummary = boundedText(raw.body, 3_500, '此版本未提供變更摘要。');
  const digest = createHash('sha256').update(JSON.stringify({
    releaseId, tagName: raw.tag_name, releaseName, bodySummary, htmlUrl, publishedAt: publishedAt.toISOString(),
  })).digest('hex');
  return {
    releaseId,
    repository: repositoryConfig.repository,
    tagName: raw.tag_name,
    ...version,
    releaseName,
    bodySummary,
    htmlUrl,
    metadataDigest: digest,
    publishedAt: publishedAt.toISOString(),
  };
}

function compareReleases(left, right) {
  const byPublication = left.publishedAt.localeCompare(right.publishedAt);
  if (byPublication) return byPublication;
  const leftId = BigInt(left.releaseId);
  const rightId = BigInt(right.releaseId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

async function readBoundedResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ReleaseAnnouncementError('RESPONSE_TOO_LARGE', 'GitHub response is too large.');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ReleaseAnnouncementError('RESPONSE_TOO_LARGE', 'GitHub response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new ReleaseAnnouncementError('RESPONSE_TOO_LARGE', 'GitHub response is too large.');
  return text;
}

async function fetchGithubReleases(config, {
  fetchImpl = globalThis.fetch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new ReleaseAnnouncementError('FETCH_UNAVAILABLE', 'GitHub fetch is unavailable.');
  const releases = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint = `https://api.github.com/repos/${config.owner}/${config.repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
    const controller = new AbortController();
    const timeout = setTimeoutFn(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout?.unref?.();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'xiaoji-release-announcements/1.0',
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
      });
    } catch (error) {
      throw new ReleaseAnnouncementError(error?.name === 'AbortError' ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', 'GitHub release request failed.');
    } finally {
      clearTimeoutFn(timeout);
    }
    if (response.url !== endpoint) throw new ReleaseAnnouncementError('REDIRECT_REJECTED', 'GitHub response endpoint changed.');
    if (!response.ok || response.status !== 200) throw new ReleaseAnnouncementError('FETCH_STATUS', 'GitHub release request returned an invalid status.');
    if (!String(response.headers?.get?.('content-type') || '').toLowerCase().includes('application/json')) {
      throw new ReleaseAnnouncementError('RESPONSE_INVALID', 'GitHub release response is not JSON.');
    }
    let pageRows;
    try { pageRows = JSON.parse(await readBoundedResponse(response)); }
    catch (error) {
      if (error instanceof ReleaseAnnouncementError) throw error;
      throw new ReleaseAnnouncementError('RESPONSE_INVALID', 'GitHub release response JSON is invalid.');
    }
    if (!Array.isArray(pageRows) || pageRows.length > RELEASES_PER_PAGE) {
      throw new ReleaseAnnouncementError('RESPONSE_INVALID', 'GitHub release response shape is invalid.');
    }
    for (const row of pageRows) {
      const normalized = normalizeRelease(row, config);
      if (normalized) releases.push(normalized);
    }
    if (pageRows.length < RELEASES_PER_PAGE) break;
    if (page === MAX_PAGES) {
      throw new ReleaseAnnouncementError('PAGE_LIMIT', 'GitHub release pagination exceeded the safety limit.');
    }
  }
  const unique = new Map(releases.map((release) => [`${release.repository}:${release.releaseId}`, release]));
  return [...unique.values()].sort(compareReleases);
}

function deliveryNonce(repository, releaseId, guildId) {
  return createHash('sha256').update(`${repository}:${releaseId}:${guildId}`).digest('hex').slice(0, 24);
}

async function persistReleasesAndDeliveries(releases, guildIds, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => {
    if (!releases.length) return { releases: 0, guilds: guildIds.length, authoritativeCurrent: false };
    const ordered = [...releases].sort(compareReleases);
    const latest = ordered.at(-1);
    const previous = api.get(`SELECT * FROM release_announcement_state WHERE repository = ?`, [DEFAULT_REPOSITORY]);
    if (previous && compareReleases(latest, {
      releaseId: previous.cursor_release_id, publishedAt: previous.cursor_published_at,
    }) < 0) return { releases: releases.length, guilds: guildIds.length, authoritativeCurrent: false };
    for (const release of releases) {
      api.run(`INSERT INTO github_releases
        (release_id, repository, tag_name, version_major, version_minor, version_patch, release_name,
         body_summary, html_url, metadata_digest, published_at, discovered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(release_id) DO UPDATE SET
          repository = excluded.repository, tag_name = excluded.tag_name,
          version_major = excluded.version_major, version_minor = excluded.version_minor,
          version_patch = excluded.version_patch, release_name = excluded.release_name,
          body_summary = excluded.body_summary, html_url = excluded.html_url,
          metadata_digest = excluded.metadata_digest, published_at = excluded.published_at,
          updated_at = excluded.updated_at`, [
        release.releaseId, release.repository, release.tagName, release.major, release.minor, release.patch,
        release.releaseName, release.bodySummary, release.htmlUrl, release.metadataDigest, release.publishedAt,
        timestamp, timestamp,
      ]);
    }
    if (!previous) {
      // Old delivery rows may already have been announced by the private scheduler.
      // A pending row with zero attempts was never claimed and remains eligible if it is current.
      api.run(`UPDATE release_announcement_deliveries SET status = 'suppressed',
        last_error = CASE WHEN release_id = ? THEN 'MIGRATION_REVIEW_REQUIRED' ELSE 'OUTDATED_RELEASE' END,
        lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE (status = 'processing' OR (status = 'pending' AND (attempt_count > 0 OR release_id <> ?)))
          AND release_id IN
          (SELECT release_id FROM github_releases WHERE repository = ? AND
            (published_at < ? OR (published_at = ? AND
              (length(release_id) < length(?) OR (length(release_id) = length(?) AND release_id <= ?)))))`,
      [latest.releaseId, timestamp, latest.releaseId, DEFAULT_REPOSITORY,
        latest.publishedAt, latest.publishedAt, latest.releaseId, latest.releaseId, latest.releaseId]);
      api.run(`INSERT INTO release_announcement_state
        (repository, baseline_release_id, baseline_published_at, cursor_release_id, cursor_published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [DEFAULT_REPOSITORY, latest.releaseId, latest.publishedAt,
        latest.releaseId, latest.publishedAt, timestamp, timestamp]);
    } else if (compareReleases(latest, { releaseId: previous.cursor_release_id, publishedAt: previous.cursor_published_at }) > 0) {
      api.run(`UPDATE release_announcement_state SET cursor_release_id = ?, cursor_published_at = ?, updated_at = ?
        WHERE repository = ?`, [latest.releaseId, latest.publishedAt, timestamp, DEFAULT_REPOSITORY]);
    }
    const state = api.get(`SELECT * FROM release_announcement_state WHERE repository = ?`, [DEFAULT_REPOSITORY]);
    const eligible = ordered.filter((release) =>
      release.releaseId === state.cursor_release_id ||
      (previous && compareReleases(release, { releaseId: previous.cursor_release_id, publishedAt: previous.cursor_published_at }) > 0));
    for (const guildId of guildIds) for (const release of eligible) {
      api.run(`INSERT INTO release_announcement_deliveries
        (release_id, guild_id, status, attempt_count, next_attempt_at, nonce, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(release_id, guild_id) DO UPDATE SET
          status = 'pending', attempt_count = 0, next_attempt_at = excluded.next_attempt_at,
          lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = excluded.updated_at
        WHERE release_announcement_deliveries.status = 'suppressed'
          AND release_announcement_deliveries.last_error IN ('GUILD_NOT_APPROVED', 'DESTINATION_NOT_CONFIGURED')`, [
        release.releaseId, guildId, timestamp, deliveryNonce(release.repository, release.releaseId, guildId), timestamp, timestamp,
      ]);
    }
    return { releases: releases.length, guilds: guildIds.length, authoritativeCurrent: true };
  });
}

async function claimNextDelivery(workerId, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  const leaseUntil = new Date(new Date(now).getTime() + DELIVERY_LEASE_MS).toISOString();
  return withCoinTransaction((api) => {
    const candidate = api.get(`SELECT delivery.*, release.repository, release.tag_name, release.release_name,
        release.body_summary, release.html_url, release.published_at
      FROM release_announcement_deliveries AS delivery
      JOIN github_releases AS release ON release.release_id = delivery.release_id
      JOIN release_announcement_state AS state ON state.repository = release.repository
      WHERE delivery.attempt_count < ? AND delivery.status = 'pending' AND delivery.next_attempt_at <= ?
        AND (release.published_at > state.baseline_published_at OR
        (release.published_at = state.baseline_published_at AND
          (length(release.release_id) > length(state.baseline_release_id) OR
            (length(release.release_id) = length(state.baseline_release_id) AND release.release_id >= state.baseline_release_id))))
        AND (release.published_at < state.cursor_published_at OR
        (release.published_at = state.cursor_published_at AND
          (length(release.release_id) < length(state.cursor_release_id) OR
            (length(release.release_id) = length(state.cursor_release_id) AND release.release_id <= state.cursor_release_id))))
      ORDER BY release.published_at, length(release.release_id), release.release_id, delivery.guild_id
      LIMIT 1`, [MAX_DELIVERY_ATTEMPTS, timestamp]);
    if (!candidate) return null;
    api.run(`UPDATE release_announcement_deliveries
      SET status = 'processing', attempt_count = attempt_count + 1, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE release_id = ? AND guild_id = ? AND attempt_count = ? AND status = 'pending' AND next_attempt_at <= ?`,
    [workerId, leaseUntil, timestamp, candidate.release_id, candidate.guild_id, candidate.attempt_count, timestamp]);
    if (Number(api.get('SELECT changes() AS count').count) !== 1) return null;
    return { ...candidate, attempt_count: Number(candidate.attempt_count) + 1, lease_owner: workerId, lease_until: leaseUntil };
  });
}

async function markDeliveryDelivered(delivery, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(`UPDATE release_announcement_deliveries SET status = 'delivered', lease_owner = NULL,
      lease_until = NULL, last_error = NULL, delivered_at = ?, updated_at = ?
      WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`,
    [timestamp, timestamp, delivery.release_id, delivery.guild_id, delivery.lease_owner]);
    if (Number(api.get('SELECT changes() AS count').count) !== 1) {
      throw new ReleaseAnnouncementError('LEASE_LOST', 'Release delivery lease was lost.');
    }
  });
}

async function markDeliveryFailed(delivery, errorCode, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  const dead = Number(delivery.attempt_count) >= MAX_DELIVERY_ATTEMPTS;
  const nextAttempt = new Date(new Date(now).getTime() + RETRY_DELAY_MS).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ?
    WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`, [
    dead ? 'dead_letter' : 'pending', nextAttempt, boundedText(errorCode, 80, 'delivery_failed'), timestamp,
    delivery.release_id, delivery.guild_id, delivery.lease_owner,
  ]));
}

async function markDeliveryUncertain(delivery, reason = 'SEND_RESULT_UNKNOWN', now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = 'dead_letter', lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ?
    WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`,
  [reason, timestamp, delivery.release_id, delivery.guild_id, delivery.lease_owner]));
}

async function quarantineExpiredProcessing(now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = 'dead_letter', lease_owner = NULL, lease_until = NULL,
      last_error = 'IN_FLIGHT_RESULT_UNKNOWN', updated_at = ?
    WHERE status = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`, [timestamp, timestamp]));
}

async function markDeliverySuppressed(delivery, reason = 'GUILD_NOT_APPROVED', now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = 'suppressed', lease_owner = NULL, lease_until = NULL,
      last_error = ?, updated_at = ?
    WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`, [
    reason === 'DESTINATION_NOT_CONFIGURED' ? reason : 'GUILD_NOT_APPROVED',
    timestamp, delivery.release_id, delivery.guild_id, delivery.lease_owner,
  ]));
}

async function markDeliveryInterrupted(delivery, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = 'pending', attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
      next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
    WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`, [
    timestamp, timestamp, delivery.release_id, delivery.guild_id, delivery.lease_owner,
  ]));
}

function assertTickActive(options) {
  if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
    throw new ReleaseAnnouncementError('SCHEDULER_STOPPED', 'Release announcement scheduler stopped.');
  }
}

function hasChannelPermissions(channel, guild, botMember = guild.members?.me) {
  if (!channel || channel.guildId !== guild.id || channel.isThread?.() ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return false;
  const permissions = channel.permissionsFor?.(botMember);
  return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
    .every((permission) => permissions?.has?.(permission));
}

function isExplicitReleaseDestination(setting) {
  return setting?.persisted === true && setting.enabled === true &&
    typeof setting.channelId === 'string' && setting.channelId.length > 0;
}

async function selectReleaseChannel(guild, { settingReader = getGuildFeatureSetting, setting = null } = {}) {
  const resolvedSetting = setting || await settingReader(guild.id, FEATURE_KEY);
  if (!isExplicitReleaseDestination(resolvedSetting)) return null;
  const preferred = guild.channels?.cache?.get?.(resolvedSetting.channelId) || null;
  let botMember = guild.members?.me;
  if (!botMember && guild.members?.fetchMe) {
    try { botMember = await guild.members.fetchMe(); }
    catch (_error) { return null; }
  }
  return hasChannelPermissions(preferred, guild, botMember) ? preferred : null;
}

function buildReleaseMessage(delivery) {
  const releaseUrl = validateReleaseUrl(delivery.html_url, parseRepository(DEFAULT_REPOSITORY), delivery.tag_name);
  const version = parseStableSemver(delivery.tag_name);
  const embed = new EmbedBuilder()
    .setColor(0xff8fbd)
    .setTitle('小吉正式版本更新')
    .setURL(releaseUrl)
    .setDescription(version ? `版本 v${version.normalized}。點選標題查看公開更新內容。` : '點選標題查看公開更新內容。')
    .setFooter({ text: '小吉正式版本公告' })
    .setTimestamp(new Date(delivery.published_at));
  return {
    content: '小吉帶來新的正式 GitHub Release 公告！',
    embeds: [embed],
    allowedMentions: { parse: [] },
    nonce: delivery.nonce,
    enforceNonce: true,
  };
}

async function processReleaseAnnouncementTick(client, options = {}) {
  const now = options.now instanceof Date ? new Date(options.now) : new Date();
  const healthReporter = options.healthReporter || setFeatureHealth;
  const usageRecorder = options.usageRecorder || recordFeatureUsage;
  const auditChecker = options.auditChecker || isGuildApproved;
  const settingReader = options.settingReader || getGuildFeatureSetting;
  let config;
  try {
    config = options.config || readReleaseAnnouncementConfig(options.env || process.env);
    const releases = await fetchGithubReleases(config, options);
    if (!releases.length) {
      await healthReporter(FEATURE_KEY, 'broken', { detail: 'no_stable_release', now });
      return { ok: false, releases: 0, approvedGuilds: 0, delivered: 0, failed: 0, suppressed: 0 };
    }
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
      return { ok: true, releases: releases.length, approvedGuilds: 0, delivered: 0, failed: 0, suppressed: 0, interrupted: true };
    }
    const guilds = [];
    const candidates = [...(client?.guilds?.cache?.values?.() || [])]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    for (const guild of candidates) {
      if (guild?.available === false || !auditChecker(guild.id)) continue;
      const setting = await settingReader(guild.id, FEATURE_KEY);
      if (isExplicitReleaseDestination(setting)) guilds.push(guild);
    }
    const persistence = await persistReleasesAndDeliveries(releases, guilds.map((guild) => guild.id), now);
    if (!persistence.authoritativeCurrent) {
      await healthReporter(FEATURE_KEY, 'broken', { detail: 'release_cursor_unavailable', now });
      return { ok: false, releases: releases.length, approvedGuilds: guilds.length, delivered: 0, failed: 0, suppressed: 0 };
    }
    const workerId = options.workerId || randomUUID();
    await quarantineExpiredProcessing(now);
    let delivered = 0;
    let failed = 0;
    let suppressed = 0;
    let interrupted = false;
    for (let index = 0; index < (options.deliveryLimit || MAX_DELIVERIES_PER_POLL); index += 1) {
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
        interrupted = true;
        break;
      }
      const delivery = await claimNextDelivery(workerId, now);
      if (!delivery) break;
      const guild = client.guilds.cache.get(delivery.guild_id);
      let sendStarted = false;
      try {
        if (!guild || guild.available === false || !auditChecker(delivery.guild_id)) {
          throw new ReleaseAnnouncementError('GUILD_NOT_APPROVED', 'Guild is not approved.');
        }
        const setting = await settingReader(delivery.guild_id, FEATURE_KEY);
        if (!isExplicitReleaseDestination(setting)) {
          throw new ReleaseAnnouncementError('DESTINATION_NOT_CONFIGURED', 'Release destination is not explicitly configured.');
        }
        const channel = await selectReleaseChannel(guild, { ...options, setting });
        if (!channel) throw new ReleaseAnnouncementError('CHANNEL_UNAVAILABLE', 'No safe release announcement channel is available.');
        const currentGuild = client.guilds.cache.get(delivery.guild_id);
        if (currentGuild !== guild || currentGuild?.available === false || !auditChecker(delivery.guild_id)) {
          throw new ReleaseAnnouncementError('GUILD_NOT_APPROVED', 'Guild is not approved.');
        }
        const currentSetting = await settingReader(delivery.guild_id, FEATURE_KEY);
        if (!isExplicitReleaseDestination(currentSetting) || currentSetting.channelId !== channel.id) {
          throw new ReleaseAnnouncementError('DESTINATION_NOT_CONFIGURED', 'Release destination is not explicitly configured.');
        }
        assertTickActive(options);
        sendStarted = true;
        await channel.send(buildReleaseMessage(delivery));
        await options.afterSend?.(delivery);
        await markDeliveryDelivered(delivery, now);
        delivered += 1;
        try { await usageRecorder(FEATURE_KEY, 'announcement', 1, now); }
        catch (_error) { /* Delivery is already recorded; metrics must not trigger a resend. */ }
      } catch (error) {
        if (sendStarted) {
          await markDeliveryUncertain(delivery, 'SEND_RESULT_UNKNOWN', now).catch(() => {});
          failed += 1;
        } else if (error?.code === 'SCHEDULER_STOPPED') {
          await markDeliveryInterrupted(delivery, now).catch(() => {});
          interrupted = true;
          break;
        } else if (error?.code === 'GUILD_NOT_APPROVED' || error?.code === 'DESTINATION_NOT_CONFIGURED') {
          await markDeliverySuppressed(delivery, error.code, now).catch(() => {});
          suppressed += 1;
        } else {
          await markDeliveryFailed(delivery, error?.code || 'delivery_failed', now).catch(() => {});
          failed += 1;
        }
      }
    }
    const unhealthyBacklog = await withCoinDatabase((api) => Number(api.get(`SELECT COUNT(*) AS count
      FROM release_announcement_deliveries AS delivery
      JOIN github_releases AS release ON release.release_id = delivery.release_id
      JOIN release_announcement_state AS state ON state.repository = release.repository
      WHERE (release.published_at > state.baseline_published_at OR
        (release.published_at = state.baseline_published_at AND
          (length(release.release_id) > length(state.baseline_release_id) OR
            (length(release.release_id) = length(state.baseline_release_id) AND release.release_id >= state.baseline_release_id))))
        AND (delivery.status = 'dead_letter' OR (delivery.status <> 'suppressed' AND delivery.last_error IS NOT NULL))`).count));
    const unhealthy = failed > 0 || unhealthyBacklog > 0;
    await healthReporter(FEATURE_KEY, unhealthy ? 'broken' : 'normal', {
      detail: failed > 0 ? 'delivery_failed' : unhealthyBacklog > 0 ? 'delivery_backlog' : null,
      now,
    });
    return { ok: failed === 0, releases: releases.length, approvedGuilds: guilds.length, delivered, failed, suppressed, interrupted };
  } catch (_error) {
    await healthReporter(FEATURE_KEY, 'broken', { detail: 'github_sync_failed', now }).catch(() => {});
    return { ok: false, releases: 0, approvedGuilds: 0, delivered: 0, failed: 1, suppressed: 0 };
  }
}

let schedulerState = null;

function startReleaseAnnouncementScheduler(client, options = {}) {
  if (schedulerState) return schedulerState;
  const config = options.config || readReleaseAnnouncementConfig(options.env || process.env);
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const state = { timer: null, inFlight: null, stopped: false, clearIntervalFn,
    dispatchEnabled: options.dispatchEnabled ?? config.dispatchEnabled ?? true };
  const run = () => {
    if (state.stopped || !state.dispatchEnabled || state.inFlight) return state.inFlight;
    const callerGuard = options.shouldContinue;
    state.inFlight = Promise.resolve(processReleaseAnnouncementTick(client, {
      ...options,
      config,
      shouldContinue: () => !state.stopped && (typeof callerGuard !== 'function' || callerGuard()),
    }))
      .catch(() => null)
      .finally(() => { state.inFlight = null; });
    return state.inFlight;
  };
  state.run = run;
  state.enableDispatch = () => { if (!state.stopped) { state.dispatchEnabled = true; return run(); } return null; };
  void run();
  state.timer = setIntervalFn(() => { void run(); }, config.pollIntervalMs);
  state.timer?.unref?.();
  schedulerState = state;
  return state;
}

async function stopReleaseAnnouncementScheduler() {
  if (!schedulerState) return false;
  const state = schedulerState;
  state.stopped = true;
  state.clearIntervalFn(state.timer);
  if (state.inFlight) await state.inFlight;
  schedulerState = null;
  return true;
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REPOSITORY,
  FEATURE_KEY,
  MAX_DELIVERIES_PER_POLL,
  MAX_PAGES,
  RELEASES_PER_PAGE,
  ReleaseAnnouncementError,
  buildReleaseMessage,
  claimNextDelivery,
  fetchGithubReleases,
  normalizeRelease,
  parsePollInterval,
  parseRepository,
  parseStableSemver,
  persistReleasesAndDeliveries,
  processReleaseAnnouncementTick,
  readReleaseAnnouncementConfig,
  selectReleaseChannel,
  startReleaseAnnouncementScheduler,
  stopReleaseAnnouncementScheduler,
  validateReleaseUrl,
};
