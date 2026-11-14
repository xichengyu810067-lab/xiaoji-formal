(function bootstrapStatusSite() {
  'use strict';

  const REFRESH_INTERVAL_MS = 60_000;
  const OVERALL_STATUS = Object.freeze({
    operational: { label: '運作正常', detail: '核心服務目前可使用', className: 'is-operational' },
    degraded: { label: '部分異常', detail: '部分功能或指令正在維護或發生異常', className: 'is-degraded' },
    outage: { label: '服務中斷', detail: '核心服務目前無法正常使用', className: 'is-outage' },
  });
  const ISSUE_STATUSES = new Set(['maintenance', 'broken']);
  const statusData = window.XiaojiStatusData;
  // The last release's offline health check: shown only when no live command status arrived at all.
  const healthCheck = window.XiaojiStatusHealthCheck || null;

  let refreshTimer = null;

  function getWorkerBase() {
    const configured = document.querySelector('meta[name="xiaoji-api-base"]')?.content?.trim();
    if (!configured) throw new Error('public_status_worker_base_missing');
    return configured.replace(/\/$/, '');
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

  // ---- Every feature and command ---------------------------------------------------------------------------------

  const items = Array.from(document.querySelectorAll('[data-status-item]'));
  const groups = Array.from(document.querySelectorAll('[data-status-group]'));
  const filterForm = document.querySelector('[data-status-filter]');
  const filterInput = filterForm?.querySelector('input[name="q"]');
  const issuesInput = filterForm?.querySelector('[data-status-issues]');

  // The pill and reason of one row: the row's own, not those of its subcommands.
  function ownState(element) {
    return element.querySelector(':scope > .status-row-state, :scope > details > summary > .status-row-state');
  }

  function setState(element, state, entry) {
    if (!state) return;
    const status = entry?.status || 'unknown';
    const pill = state.querySelector('[data-status-pill]');
    pill.className = `status-pill is-${status}`;
    pill.replaceChildren(statusData.STATUS_LABELS[status] || statusData.STATUS_LABELS.unknown);
    state.querySelector('[data-status-reason]').replaceChildren(entry?.reason || '');
    element.dataset.status = status;
  }

  // Without any live command status, a command row stays unknown and says what the last release's health check found.
  function fallback(command, subcommand = null) {
    return { status: 'unknown', reason: statusData.describeHealthCheck(healthCheck, command, subcommand) };
  }

  function applyItemStatuses(index) {
    const live = Boolean(index?.reportsCommands);
    for (const item of items) {
      const isFeature = item.dataset.kind === 'feature';
      let entry = isFeature ? index?.features.get(item.dataset.key) : index?.commands.get(item.dataset.key);
      if (!isFeature && !live) entry = fallback(item.dataset.key);
      setState(item, ownState(item), entry);
      for (const sub of item.querySelectorAll('[data-status-sub]')) {
        const subEntry = live ? entry?.subcommands?.get(sub.dataset.key) : fallback(item.dataset.key, sub.dataset.key);
        setState(sub, sub.querySelector('.status-row-state'), subEntry);
      }
    }
  }

  function currentFilter() {
    return { query: filterInput?.value || '', issuesOnly: Boolean(issuesInput?.checked) };
  }

  // Shows the rows that match the filter and opens the groups that need a look: a group with a row under maintenance
  // or broken, or any group with a match while searching. A group the visitor opened or closed keeps that choice.
  function updateGroups() {
    const filter = currentFilter();
    const filtering = Boolean(filter.query.trim()) || filter.issuesOnly;
    let visibleCount = 0;
    for (const group of groups) {
      const rows = Array.from(group.querySelectorAll('[data-status-item]'));
      let visible = 0;
      let issues = 0;
      for (const row of rows) {
        const shown = statusData.matchesStatusFilter({ search: row.dataset.search, status: row.dataset.status }, filter);
        row.hidden = !shown;
        if (shown) visible += 1;
        if (ISSUE_STATUSES.has(row.dataset.status)) issues += 1;
      }
      visibleCount += visible;
      group.hidden = visible === 0;
      group.querySelector('[data-status-group-count]').replaceChildren(
        issues ? `${rows.length} 項・${issues} 項待留意` : `${rows.length} 項`,
      );
      group.classList.toggle('has-issues', issues > 0);
      const details = group.querySelector('[data-status-group-details]');
      if (filtering) details.open = visible > 0;
      else if (details.dataset.userOpen) details.open = details.dataset.userOpen === 'true';
      else details.open = issues > 0;
    }
    const empty = document.querySelector('[data-status-empty]');
    if (empty) empty.hidden = visibleCount > 0;
  }

  function updateSummary(index) {
    const counts = { normal: 0, maintenance: 0, broken: 0, unknown: 0 };
    for (const item of items) counts[item.dataset.status || 'unknown'] += 1;
    for (const key of ['normal', 'maintenance', 'broken']) {
      document.querySelector(`[data-summary="${key}"]`).textContent = index ? String(counts[key]) : '—';
    }
    const features = items.filter((item) => item.dataset.kind === 'feature').length;
    const commands = items.length - features;
    let note = `逐項即時狀態：功能 ${features} 項與指令 ${commands} 個合計（不含子指令）。`;
    const fallbackNote = healthCheck ? '指令旁附上上次版本健檢的結果，那只是那一版程式當時的測試結果，不代表小吉現在的狀態。' : '';
    if (!index) note = `逐項即時狀態暫時無法取得，所有項目先顯示未知。${fallbackNote}`;
    else if (!index.reportsCommands) note += `目前運作的小吉版本還沒有回報指令狀態，指令先顯示未知。${fallbackNote}`;
    else if (counts.unknown) note += `${counts.unknown} 項未知。`;
    document.querySelector('[data-summary-note]').textContent = note;
  }

  function renderItems(index) {
    applyItemStatuses(index);
    updateGroups();
    updateSummary(index);
  }

  for (const group of groups) {
    const details = group.querySelector('[data-status-group-details]');
    details.querySelector('summary').addEventListener('click', () => {
      // The click comes before the toggle, so the choice is the opposite of the current state.
      if (!filterInput?.value.trim() && !issuesInput?.checked) details.dataset.userOpen = String(!details.open);
    });
  }
  if (filterForm) {
    filterForm.hidden = false;
    filterForm.addEventListener('submit', (event) => event.preventDefault());
    filterForm.addEventListener('input', updateGroups);
    filterForm.addEventListener('change', updateGroups);
    filterForm.addEventListener('reset', () => window.setTimeout(updateGroups, 0));
  }

  // ---- Overall card ------------------------------------------------------------------------------------------------

  function setOverall(className, label, detail, updated) {
    const card = document.querySelector('[data-overall-card]');
    card.classList.remove('is-operational', 'is-degraded', 'is-outage');
    card.classList.add(className);
    document.querySelector('[data-overall-label]').textContent = label;
    document.querySelector('[data-overall-detail]').textContent = detail;
    document.querySelector('[data-last-updated]').textContent = updated;
    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-degraded', 'is-outage');
    navDot.classList.add(className);
  }

  function renderSnapshot(payload) {
    const overallStatus = normalizeOverallStatus(payload?.bot?.status);
    if (payload?.schemaVersion !== 1 || !overallStatus) throw new Error('unsupported_status_payload');
    const overall = OVERALL_STATUS[overallStatus];
    setOverall(overall.className, overall.label, overall.detail, formatUpdatedAt(payload.updatedAt));
    document.querySelector('[data-status-unavailable]').hidden = true;
    renderItems(statusData.indexStatusPayload(payload));
  }

  function renderUnavailable() {
    setOverall('is-degraded', '狀態未知', '暫時無法確認小吉的服務狀態', '尚未取得更新');
    document.querySelector('[data-status-unavailable]').hidden = false;
    renderItems(null);
  }

  const statusLoader = statusData.createStatusLoader({
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
  scheduleRefresh();
  refreshStatus();
})();
