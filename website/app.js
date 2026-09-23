(function bootstrapOfficialSite() {
  'use strict';

  const API_TIMEOUT_MS = 5000;
  const STATUS_COPY = Object.freeze({
    operational: { label: '正常運作', detail: '小吉已連線，核心功能可使用' },
    maintenance: { label: '維護中', detail: '部分功能正在保養，很快回來' },
    degraded: { label: '部分異常', detail: '部分功能可能較慢或無法使用' },
    outage: { label: '服務中斷', detail: '小吉目前無法正常提供服務' },
    unknown: { label: '狀態未知', detail: '暫時無法確認服務狀態' },
  });

  function getWorkerBase() {
    const configured = document.querySelector('meta[name="xiaoji-api-base"]')?.content?.trim();
    if (!configured) throw new Error('public_status_worker_base_missing');
    return configured.replace(/\/$/, '');
  }

  function safeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function formatCount(value) {
    const safe = safeInteger(value);
    return safe === null ? '—' : new Intl.NumberFormat('zh-TW').format(safe);
  }

  function normalizeStatus(value) {
    return Object.hasOwn(STATUS_COPY, value) ? value : 'unknown';
  }

  function setStatusClass(element, status) {
    if (!element) return;
    element.classList.remove('is-operational', 'is-degraded', 'is-outage');
    if (status === 'operational') element.classList.add('is-operational');
    if (status === 'maintenance' || status === 'degraded') element.classList.add('is-degraded');
    if (status === 'outage') element.classList.add('is-outage');
  }

  function renderOverview(payload) {
    const guilds = document.querySelector('[data-metric="guilds"]');
    const interactions = document.querySelector('[data-metric="interactions"]');
    const statusLabel = document.querySelector('[data-metric="status"]');
    const statusDetail = document.querySelector('[data-metric="status-detail"]');
    const freshness = document.querySelector('[data-freshness]');
    const navStatusDot = document.querySelector('[data-nav-status-dot]');
    const dataNotice = document.querySelector('[data-data-notice]');

    const status = normalizeStatus(payload?.bot?.status);
    const copy = STATUS_COPY[status];
    guilds.textContent = formatCount(payload?.guilds?.adoptedCount);
    interactions.textContent = formatCount(payload?.usage?.todayInteractions);
    statusLabel.textContent = copy.label;
    statusDetail.textContent = copy.detail;
    setStatusClass(statusLabel, status);
    setStatusClass(navStatusDot, status);
    if (dataNotice) dataNotice.hidden = true;

    const updatedAt = Date.parse(payload?.updatedAt);
    freshness.textContent = Number.isFinite(updatedAt)
      ? `最後更新：${new Intl.DateTimeFormat('zh-TW', {
          timeZone: 'Asia/Taipei',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(updatedAt)}`
      : '更新時間未提供';
  }

  function renderUnavailable() {
    renderOverview({ bot: { status: 'unknown' } });
    document.querySelector('[data-freshness]').textContent = '即時資料尚未連線';
    document.querySelector('[data-data-notice]').hidden = false;
  }

  async function loadOverview() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(`${getWorkerBase()}/api/public/overview`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('overview_unavailable');
      const payload = await response.json();
      if (payload?.schemaVersion !== 1) throw new Error('overview_schema_unsupported');
      renderOverview(payload);
    } catch (_error) {
      renderUnavailable();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function setupNavigation() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.querySelector('[data-nav]');
    if (!toggle || !nav) return;

    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isOpen));
      nav.classList.toggle('is-open', !isOpen);
    });

    nav.addEventListener('click', (event) => {
      if (!event.target.closest('a')) return;
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
    });
  }

  function setupReveal() {
    const items = [...document.querySelectorAll('.reveal')];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12 }
    );
    items.forEach((item) => observer.observe(item));
  }

  document.querySelector('[data-current-year]').textContent = String(new Date().getFullYear());
  setupNavigation();
  setupReveal();
  loadOverview();
})();
