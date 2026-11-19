// Source of truth: src/platform/catalogs/statusData.js, loaded by the bot with require(). website/statusData.js is a byte-for-byte
// copy that the status page loads with a <script> tag; `npm run site:render` writes it and `npm run check` refuses a stale
// copy. Edit this file, never the copy.
(function exposeStatusData(root, factory) {
  const gameCatalog = typeof module === 'object' && module.exports
    ? require('./gameCatalog')
    : root.XiaojiGameCatalog;
  const api = factory(gameCatalog);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XiaojiStatusData = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function createStatusDataApi(gameCatalog) {
  'use strict';

  const gameStatusFeatures = (gameCatalog?.GAME_CATALOG || [])
    .filter((game) => game.publicFeatureKey)
    .map((game) => Object.freeze({
      key: game.publicFeatureKey,
      name: game.name.replace(/（.*$/u, ''),
      category: game.launcher === 'daily-riddle' ? '每日活動'
        : ['word-chain', 'number-chain'].includes(game.launcher) ? '社群互動' : '吉幣與遊戲',
    }));

  // This is intentionally limited to public labels and categories. It is used
  // when the live status API cannot be reached, so visitors can still see what
  // Xiaoji offers without treating an unavailable status as a healthy one.
  const PUBLIC_FEATURE_CATALOG = Object.freeze([
    { key: 'core_chat', name: '小吉聊天', category: '核心服務' },
    { key: 'welcome', name: '新人歡迎', category: '社群服務' },
    { key: 'reminder', name: '提醒服務', category: '實用工具' },
    { key: 'calendar', name: '行事曆', category: '實用工具' },
    { key: 'poll', name: '投票', category: '社群互動' },
    { key: 'weather', name: '天氣查詢', category: '實用工具' },
    { key: 'economy', name: '吉幣系統', category: '吉幣與遊戲' },
    ...gameStatusFeatures.filter((feature) => ['word_chain', 'number_chain', 'daily_riddle'].includes(feature.key)),
    { key: 'daily_discussion', name: '每日議題', category: '每日活動' },
    { key: 'chat_style', name: '對話風格', category: '聊天個人化' },
    { key: 'romance', name: '情侶模式', category: '聊天個人化' },
    { key: 'student', name: '好奇寶寶 /student', category: 'AI 聊天' },
    { key: 'memory', name: '聊天記憶', category: 'AI 聊天' },
    { key: 'image_reading', name: '看圖', category: 'AI 聊天' },
    { key: 'web_search', name: '上網搜尋', category: 'AI 聊天' },
    ...gameStatusFeatures.filter((feature) => ['tetris', 'number_match', 'sudoku'].includes(feature.key)),
    { key: 'official_website', name: '小吉官網', category: '網站服務' },
    { key: 'status_website', name: '即時狀態網站', category: '網站服務' },
  ].map((feature) => Object.freeze(feature)));

  const STATUS_LABELS = Object.freeze({ normal: '正常', maintenance: '維護中', broken: '異常', unknown: '未知' });
  const ITEM_STATUSES = new Set(['normal', 'maintenance', 'broken']);

  // Why a command is not normal, in words. The worker only passes these words on; any other is shown as no reason.
  const REASON_LABELS = Object.freeze({
    offline: { maintenance: '小吉離線中' },
    not_loaded: { broken: '指令沒有載入' },
    errors: { broken: '最近連續執行失敗' },
    feature: { broken: '所屬功能異常', maintenance: '所屬功能維護中' },
    service: { broken: '依賴的外部服務異常', maintenance: '外部服務尚未設定' },
    database: { maintenance: '資料庫暫時無法讀取' },
    stale: { maintenance: '狀態資料過期，等待更新' },
  });

  function describeReason(status, reason) {
    if (status === 'normal' || typeof reason !== 'string' || !Object.hasOwn(REASON_LABELS, reason)) return '';
    return REASON_LABELS[reason][status] || '';
  }

  function readEntry(entry) {
    const status = ITEM_STATUSES.has(entry?.status) ? entry.status : 'unknown';
    return { status, reason: describeReason(status, entry?.reason) };
  }

  // The live statuses of a public status payload by key: features, and commands with their subcommands. A command the
  // payload does not list (a bot of the release before command statuses) is simply missing, and so unknown.
  function indexStatusPayload(payload) {
    const features = new Map();
    const commands = new Map();
    for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
      if (typeof feature?.key === 'string') features.set(feature.key, readEntry(feature));
    }
    for (const command of Array.isArray(payload?.commands) ? payload.commands : []) {
      if (typeof command?.key !== 'string') continue;
      const subcommands = new Map();
      for (const sub of Array.isArray(command.subcommands) ? command.subcommands : []) {
        if (typeof sub?.key === 'string') subcommands.set(sub.key, readEntry(sub));
      }
      commands.set(command.key, { ...readEntry(command), subcommands });
    }
    return { features, commands, reportsCommands: Array.isArray(payload?.commands) && payload.commands.length > 0 };
  }

  // Whether one row stays visible: its search text has the query, and with issuesOnly it is under maintenance or broken.
  function matchesStatusFilter({ search = '', status = 'unknown' }, { query = '', issuesOnly = false } = {}) {
    const needle = String(query).trim().toLowerCase();
    if (needle && !String(search).toLowerCase().includes(needle)) return false;
    return !issuesOnly || status === 'maintenance' || status === 'broken';
  }

  // The last release's offline health check of one command or subcommand (website/statusHealthCheck.js), in words,
  // for the status page to show only when it has no live command statuses at all. '' when it was not checked.
  // The check ran the release's code in a fake Discord: it tells whether the code worked, not whether the bot is up.
  function describeHealthCheck(healthCheck, command, subcommand = null) {
    const entry = healthCheck?.commands && Object.hasOwn(healthCheck.commands, command) ? healthCheck.commands[command] : null;
    if (!entry) return '';
    const subStatuses = Object.values(entry.subcommands || {});
    let status;
    if (subcommand) status = Object.hasOwn(entry.subcommands || {}, subcommand) ? entry.subcommands[subcommand] : null;
    else if (subStatuses.includes('fail') || entry.status === 'fail') status = 'fail';
    else if (subStatuses.length || entry.status === 'pass') status = 'pass';
    if (status !== 'pass' && status !== 'fail') return '';
    const time = Date.parse(healthCheck.checkedAt);
    const date = Number.isFinite(time)
      ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' }).format(time)
      : '日期不明';
    const version = typeof healthCheck.version === 'string' ? `v${healthCheck.version}，` : '';
    return `上次版本健檢（${version}${date}）：${status === 'pass' ? '通過' : '未通過'}`;
  }

  function createStatusLoader({
    fetchImpl,
    urlProvider,
    renderSuccess,
    renderFailure,
    setLoading,
    timeoutMs = 5000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    AbortControllerImpl = AbortController,
  }) {
    let activeController = null;

    async function refresh() {
      activeController?.abort();
      const controller = new AbortControllerImpl();
      activeController = controller;
      setLoading(true);
      const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(urlProvider(), {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('status_unavailable');
        const payload = await response.json();
        if (activeController !== controller) return { stale: true };
        renderSuccess(payload);
        return { ok: true };
      } catch (_error) {
        if (activeController !== controller) return { stale: true };
        renderFailure();
        return { ok: false };
      } finally {
        clearTimeoutImpl(timeout);
        if (activeController === controller) {
          activeController = null;
          setLoading(false);
        }
      }
    }

    return { refresh };
  }

  return {
    PUBLIC_FEATURE_CATALOG,
    STATUS_LABELS,
    createStatusLoader,
    describeHealthCheck,
    describeReason,
    indexStatusPayload,
    matchesStatusFilter,
  };
});
