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
    const version = document.querySelector('[data-metric="version"]');
    const statusLabel = document.querySelector('[data-metric="status"]');
    const statusDetail = document.querySelector('[data-metric="status-detail"]');
    const freshness = document.querySelector('[data-freshness]');
    const navStatusDot = document.querySelector('[data-nav-status-dot]');
    const dataNotice = document.querySelector('[data-data-notice]');

    const status = normalizeStatus(payload?.bot?.status);
    const copy = STATUS_COPY[status];
    version.textContent = typeof payload?.bot?.version === 'string' && /^\d+\.\d+\.\d+$/u.test(payload.bot.version)
      ? `v${payload.bot.version}` : '—';
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

  // The hero portrait looks toward the pointer while it is inside the frame and smiles when clicked or
  // activated with the keyboard. Both are layers over the unchanged base art (docs/WEBSITE_ARCHITECTURE.md):
  // the eye layer is shown only once all of its images have loaded, so a half-loaded layer never leaves
  // blank white eyes, and the smile layer fades in through the is-happy class.
  const HAPPY_LINES = Object.freeze([
    { title: '嘿嘿～被你發現了', detail: '今天也謝謝你來看小吉！' },
    { title: '摸摸頭，收到了♡', detail: '小吉會更努力陪大家聊天' },
    { title: '要一起玩遊戲嗎？', detail: '在 Discord 用 /board start 開一局' },
    { title: '小吉在這裡喔～', detail: '有問題可以找右下角的小吉' },
  ]);

  function setupPortrait() {
    const button = document.querySelector('[data-portrait]');
    const frame = button?.querySelector('.portrait-frame');
    const eyes = frame?.querySelector('[data-eye-layer]');
    const speechTitle = document.querySelector('[data-speech-title]');
    const speechDetail = document.querySelector('[data-speech-detail]');
    if (!button || !frame) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let happyTimer = null;
    let lineIndex = 0;

    if (finePointer && !reduceMotion) {
      const layers = eyes ? [...eyes.querySelectorAll('img')] : [];
      const loaded = (layer) => new Promise((resolve, reject) => {
        if (layer.complete) {
          if (layer.naturalWidth > 0) resolve();
          else reject(new Error('eye_layer_missing'));
          return;
        }
        layer.addEventListener('load', resolve, { once: true });
        layer.addEventListener('error', reject, { once: true });
      });
      Promise.all(layers.map(loaded))
        .then(() => { if (layers.length) eyes.hidden = false; })
        .catch(() => { if (eyes) eyes.hidden = true; });
      button.addEventListener('pointermove', (event) => {
        const rect = button.getBoundingClientRect();
        const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
        const y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
        button.style.setProperty('--look-x', x.toFixed(3));
        button.style.setProperty('--look-y', y.toFixed(3));
        button.classList.add('is-looking');
      });
      button.addEventListener('pointerleave', () => {
        button.classList.remove('is-looking');
        button.style.setProperty('--look-x', '0');
        button.style.setProperty('--look-y', '0');
      });
    }

    function spawnHearts() {
      if (reduceMotion) return;
      for (let index = 0; index < 5; index += 1) {
        const heart = document.createElement('span');
        heart.className = 'portrait-heart';
        heart.setAttribute('aria-hidden', 'true');
        heart.textContent = index % 2 ? '♡' : '✦';
        heart.style.setProperty('--heart-x', `${Math.round((Math.random() - 0.5) * 220)}px`);
        heart.style.setProperty('--heart-delay', `${index * 90}ms`);
        button.append(heart);
        window.setTimeout(() => heart.remove(), 1600 + index * 90);
      }
    }

    button.addEventListener('click', () => {
      const line = HAPPY_LINES[lineIndex % HAPPY_LINES.length];
      lineIndex += 1;
      if (speechTitle) speechTitle.textContent = line.title;
      if (speechDetail) speechDetail.textContent = line.detail;
      button.classList.remove('is-happy');
      void button.offsetWidth;
      button.classList.add('is-happy');
      spawnHearts();
      window.clearTimeout(happyTimer);
      happyTimer = window.setTimeout(() => {
        button.classList.remove('is-happy');
      }, 1800);
    });
  }

  document.querySelector('[data-current-year]').textContent = String(new Date().getFullYear());
  setupPortrait();
  loadOverview();
})();
