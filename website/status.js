(function bootstrapStatusSite() {
  'use strict';

  const REFRESH_INTERVAL_MS = 60_000;
  const OVERALL_STATUS = Object.freeze({
    operational: { label: '運作正常', detail: '核心服務目前可使用', className: 'is-operational' },
    degraded: { label: '部分異常', detail: '部分功能正在維護或發生異常', className: 'is-degraded' },
    outage: { label: '服務中斷', detail: '核心服務目前無法正常使用', className: 'is-outage' },
  });

  let refreshTimer = null;

  function getWorkerBase() {
    const configured = document.querySelector('meta[name="xiaoji-api-base"]')?.content?.trim();
    if (!configured) throw new Error('public_status_worker_base_missing');
    return configured.replace(/\/$/, '');
  }

  function getPublicSystems() {
    const catalog = window.XiaojiPublicFeatureCatalog?.PUBLIC_SYSTEM_CATALOG;
    return Array.isArray(catalog) ? catalog : [];
  }

  function normalizeOverallStatus(value) {
    return Object.hasOwn(OVERALL_STATUS, value) ? value : null;
  }

  function formatUpdatedAt(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '更新時間未知';
    return `最後更新 ${new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(timestamp)}`;
  }

  function setCatalogSummary() {
    const systems = getPublicSystems();
    const featureCount = systems.reduce((count, system) => count + system.features.length, 0);
    document.querySelector('[data-summary="systems"]').textContent = systems.length ? String(systems.length) : '—';
    document.querySelector('[data-summary="features"]').textContent = featureCount ? String(featureCount) : '—';
    document.querySelector('[data-summary="verification"]').textContent = '未逐項驗證';
  }

  function renderSnapshot(payload) {
    const overallStatus = normalizeOverallStatus(payload?.bot?.status);
    if (payload?.schemaVersion !== 1 || !overallStatus) throw new Error('unsupported_status_payload');

    const overall = OVERALL_STATUS[overallStatus];
    const card = document.querySelector('[data-overall-card]');
    card.classList.remove('is-operational', 'is-degraded', 'is-outage');
    card.classList.add(overall.className);
    document.querySelector('[data-overall-label]').textContent = overall.label;
    document.querySelector('[data-overall-detail]').textContent = overall.detail;
    document.querySelector('[data-last-updated]').textContent = formatUpdatedAt(payload.updatedAt);

    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-degraded', 'is-outage');
    navDot.classList.add(overall.className);
    document.querySelector('[data-status-unavailable]').hidden = true;
    setCatalogSummary();
  }

  function renderUnavailable() {
    const card = document.querySelector('[data-overall-card]');
    card.classList.remove('is-operational', 'is-degraded', 'is-outage');
    card.classList.add('is-degraded');
    document.querySelector('[data-overall-label]').textContent = '狀態未知';
    document.querySelector('[data-overall-detail]').textContent = '暫時無法確認小吉的服務狀態';
    document.querySelector('[data-last-updated]').textContent = '尚未取得更新';
    document.querySelector('[data-status-unavailable]').hidden = false;
    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-outage');
    navDot.classList.add('is-degraded');
    setCatalogSummary();
  }

  const statusLoader = window.XiaojiStatusData.createStatusLoader({
    fetchImpl: window.fetch.bind(window),
    urlProvider: () => `${getWorkerBase()}/api/public/status`,
    renderSuccess: renderSnapshot,
    renderFailure: renderUnavailable,
    setLoading: (loading) => {
      document.querySelector('[data-refresh]').disabled = loading;
    },
    setTimeoutImpl: window.setTimeout.bind(window),
    clearTimeoutImpl: window.clearTimeout.bind(window),
    AbortControllerImpl: window.AbortController,
  });
  const refreshStatus = statusLoader.refresh;

  function scheduleRefresh() {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
    if (document.hidden) return;
    refreshTimer = window.setInterval(refreshStatus, REFRESH_INTERVAL_MS);
  }

  document.querySelector('[data-current-year]').textContent = String(new Date().getFullYear());
  document.querySelector('[data-refresh]').addEventListener('click', refreshStatus);
  document.addEventListener('visibilitychange', () => {
    scheduleRefresh();
    if (!document.hidden) refreshStatus();
  });
  setCatalogSummary();
  scheduleRefresh();
  refreshStatus();
})();
