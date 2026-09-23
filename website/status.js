(function bootstrapStatusSite() {
  'use strict';

  const REFRESH_INTERVAL_MS = 60_000;
  const OVERALL_STATUS = Object.freeze({
    operational: { label: '運作正常', detail: '核心服務目前可使用', className: 'is-operational' },
    degraded: { label: '部分異常', detail: '部分功能正在維護或發生異常', className: 'is-degraded' },
    outage: { label: '服務中斷', detail: '核心服務目前無法正常使用', className: 'is-outage' },
  });

  let refreshTimer = null;
  const expandedSystems = new Set();

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

  function setAccordionState({ panel, trigger, content, indicator, expanded }) {
    trigger.setAttribute('aria-expanded', String(expanded));
    content.hidden = !expanded;
    panel.classList.toggle('is-open', expanded);
    indicator.textContent = expanded ? '－' : '＋';
  }

  function createFeatureDetail(feature) {
    const item = document.createElement('li');
    item.className = 'feature-detail';

    const name = document.createElement('h3');
    name.textContent = feature.name;
    const details = document.createElement('dl');
    [
      ['用途', feature.purpose],
      ['如何使用', feature.howTo],
      ['使用限制', feature.limitation],
    ].forEach(([label, value]) => {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
    });
    item.append(name, details);
    return item;
  }

  function createSystemPanel(system, index) {
    const panel = document.createElement('article');
    panel.className = 'service-panel system-panel';

    const trigger = document.createElement('button');
    trigger.className = 'accordion-trigger';
    trigger.type = 'button';
    trigger.id = `public-system-trigger-${index}`;
    trigger.setAttribute('aria-controls', `public-system-panel-${index}`);

    const title = document.createElement('span');
    title.className = 'system-title';
    title.textContent = system.name;
    const indicator = document.createElement('span');
    indicator.className = 'accordion-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    trigger.append(title, indicator);

    const content = document.createElement('div');
    content.className = 'accordion-content system-content';
    content.id = `public-system-panel-${index}`;
    content.setAttribute('role', 'region');
    content.setAttribute('aria-labelledby', trigger.id);

    const list = document.createElement('ul');
    list.className = 'feature-detail-list';
    system.features.forEach((feature) => list.append(createFeatureDetail(feature)));
    content.append(list);

    const applyState = (expanded) => setAccordionState({ panel, trigger, content, indicator, expanded });
    applyState(expandedSystems.has(system.name));
    trigger.addEventListener('click', () => {
      const expanded = trigger.getAttribute('aria-expanded') !== 'true';
      if (expanded) expandedSystems.add(system.name);
      else expandedSystems.delete(system.name);
      applyState(expanded);
    });

    panel.append(trigger, content);
    return panel;
  }

  function renderPublicSystems() {
    const container = document.querySelector('[data-status-groups]');
    const systems = getPublicSystems();
    container.replaceChildren();
    if (systems.length === 0) {
      const message = document.createElement('p');
      message.className = 'catalog-load-error';
      message.textContent = '公開功能清冊暫時無法載入。';
      container.append(message);
    } else {
      systems.forEach((system, index) => container.append(createSystemPanel(system, index + 1)));
    }
    container.setAttribute('aria-busy', 'false');
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
    const latency = Number.isFinite(payload?.bot?.latencyMs) && payload.bot.latencyMs >= 0
      ? `${Math.round(payload.bot.latencyMs)} ms`
      : '—';
    document.querySelector('[data-latency]').textContent = `延遲 ${latency}`;

    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-degraded', 'is-outage');
    navDot.classList.add(overall.className);
    document.querySelector('[data-status-unavailable]').hidden = true;
    setCatalogSummary();
    renderPublicSystems();
  }

  function renderUnavailable() {
    const card = document.querySelector('[data-overall-card]');
    card.classList.remove('is-operational', 'is-degraded', 'is-outage');
    card.classList.add('is-degraded');
    document.querySelector('[data-overall-label]').textContent = '狀態未知';
    document.querySelector('[data-overall-detail]').textContent = '暫時無法確認小吉的服務狀態';
    document.querySelector('[data-last-updated]').textContent = '尚未取得更新';
    document.querySelector('[data-latency]').textContent = '延遲 —';
    document.querySelector('[data-status-unavailable]').hidden = false;
    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-outage');
    navDot.classList.add('is-degraded');
    setCatalogSummary();
    renderPublicSystems();
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
  renderPublicSystems();
  scheduleRefresh();
  refreshStatus();
})();
