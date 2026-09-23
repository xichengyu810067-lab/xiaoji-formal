(function exposeStatusData(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XiaojiStatusData = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function createStatusDataApi() {
  'use strict';

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
    { key: 'word_chain', name: '文字接龍', category: '社群互動' },
    { key: 'number_chain', name: '數字接龍', category: '社群互動' },
    { key: 'daily_riddle', name: '每日猜謎', category: '每日活動' },
    { key: 'daily_discussion', name: '每日議題', category: '每日活動' },
    { key: 'chat_style', name: '對話風格', category: '聊天個人化' },
    { key: 'romance', name: '情侶模式', category: '聊天個人化' },
    { key: 'tetris', name: '俄羅斯方塊', category: '吉幣與遊戲' },
    { key: 'number_match', name: '數字配對', category: '吉幣與遊戲' },
    { key: 'sudoku', name: '數獨', category: '吉幣與遊戲' },
    { key: 'official_website', name: '小吉官網', category: '網站服務' },
    { key: 'status_website', name: '即時狀態網站', category: '網站服務' },
  ].map((feature) => Object.freeze(feature)));

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

  return { PUBLIC_FEATURE_CATALOG, createStatusLoader };
});
