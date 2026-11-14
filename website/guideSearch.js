(function exposeGuideSearch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XiaojiGuideSearch = api;
    if (root.document) api.bootGuidePage(root.document, root);
  }
})(typeof globalThis === 'object' ? globalThis : this, function createGuideSearch() {
  'use strict';

  // The feature and command lists are already in guide.html (scripts/render-website-guide.js writes
  // them). This script only hides what does not match, so the page still reads in full without it.

  const AUDIENCES = Object.freeze(['public', 'admin']);
  const MAX_QUERY_LENGTH = 60;

  // Full-width letters, case and repeated spaces do not change what someone is looking for.
  function normalizeText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  }

  // "/remind" asks for the command itself, so it keeps its slash; "remind" matches any text.
  function queryTokens(query) {
    return normalizeText(query).split(' ').map((token) => token.replace(/^\/{2,}/u, '/')).filter((token) => token && token !== '/');
  }

  // The search state as the address bar keeps it: ?q=天氣&cat=實用工具&who=public.
  function parseState(search, categories = []) {
    const params = new URLSearchParams(String(search || ''));
    const q = String(params.get('q') || '').slice(0, MAX_QUERY_LENGTH);
    const cat = String(params.get('cat') || '');
    const who = String(params.get('who') || '');
    return {
      q,
      cat: categories.includes(cat) ? cat : '',
      who: AUDIENCES.includes(who) ? who : '',
    };
  }

  function serializeState(state) {
    const params = new URLSearchParams();
    if (state.q && state.q.trim()) params.set('q', state.q.trim());
    if (state.cat) params.set('cat', state.cat);
    if (state.who) params.set('who', state.who);
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  // item: { text, categories: string[], audiences: string[] }
  function matchesItem(item, state) {
    if (state.cat && !item.categories.includes(state.cat)) return false;
    if (state.who && !item.audiences.includes(state.who)) return false;
    const haystack = normalizeText(item.text);
    return queryTokens(state.q).every((token) => haystack.includes(token));
  }

  function readItem(element) {
    return {
      element,
      kind: element.dataset.kind,
      text: element.textContent,
      categories: String(element.dataset.cat || '').split('|').filter(Boolean),
      audiences: String(element.dataset.who || '').split(' ').filter(Boolean),
    };
  }

  function bootGuidePage(document, window) {
    const form = document.querySelector('[data-guide-form]');
    if (!form) return null;
    const input = form.querySelector('input[name="q"]');
    const items = [...document.querySelectorAll('[data-guide-item]')].map(readItem);
    const groups = [...document.querySelectorAll('[data-guide-group]')];
    const categories = [...form.querySelectorAll('input[name="cat"]')].map((radio) => radio.value).filter(Boolean);
    const counts = new Map([...document.querySelectorAll('[data-guide-count]')].map((node) => [node.dataset.guideCount, node]));
    const empties = new Map([...document.querySelectorAll('[data-guide-empty]')].map((node) => [node.dataset.guideEmpty, node]));
    const summary = document.querySelector('[data-guide-summary]');
    const totals = { feature: 0, command: 0 };
    items.forEach((item) => { totals[item.kind] = (totals[item.kind] || 0) + 1; });

    function readForm() {
      return {
        q: input.value.slice(0, MAX_QUERY_LENGTH),
        cat: form.querySelector('input[name="cat"]:checked')?.value || '',
        who: form.querySelector('input[name="who"]:checked')?.value || '',
      };
    }

    function writeForm(state) {
      input.value = state.q;
      for (const name of ['cat', 'who']) {
        form.querySelectorAll(`input[name="${name}"]`).forEach((radio) => { radio.checked = radio.value === state[name]; });
      }
    }

    function apply(state, { updateUrl = true } = {}) {
      const shown = { feature: 0, command: 0 };
      const searching = queryTokens(state.q).length > 0;
      for (const item of items) {
        const visible = matchesItem(item, state);
        item.element.hidden = !visible;
        if (visible) shown[item.kind] += 1;
        // A match in the how-to or limitation text is only useful when that text is open.
        const details = item.element.querySelector('details');
        if (details && visible && searching) details.open = true;
      }
      groups.forEach((group) => { group.hidden = !group.querySelector('[data-guide-item]:not([hidden])'); });
      for (const kind of ['feature', 'command']) {
        counts.get(kind)?.replaceChildren(document.createTextNode(
          shown[kind] === totals[kind] ? `共 ${totals[kind]} 項` : `${shown[kind]} ／ ${totals[kind]} 項`,
        ));
        if (empties.has(kind)) empties.get(kind).hidden = shown[kind] > 0;
      }
      if (summary) {
        summary.textContent = shown.feature + shown.command === 0
          ? '找不到符合的功能或指令，換個關鍵字或分類試試看。'
          : `找到 ${shown.feature} 項功能、${shown.command} 個指令。`;
      }
      if (updateUrl) {
        const next = `${window.location.pathname}${serializeState(state)}${window.location.hash}`;
        window.history.replaceState(null, '', next);
      }
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); apply(readForm()); });
    form.addEventListener('input', () => apply(readForm()));
    form.addEventListener('change', () => apply(readForm()));
    form.addEventListener('reset', () => window.setTimeout(() => apply(readForm()), 0));

    const initial = parseState(window.location.search, categories);
    writeForm(initial);
    form.hidden = false;
    document.documentElement.classList.add('guide-ready');
    apply(initial, { updateUrl: false });
    return { apply, readForm };
  }

  return Object.freeze({ bootGuidePage, matchesItem, normalizeText, parseState, queryTokens, serializeState });
});
