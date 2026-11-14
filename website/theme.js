(function exposeSiteTheme(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XiaojiTheme = api;
    if (root.document) api.applyTheme(root.document, root);
  }
})(typeof globalThis === 'object' ? globalThis : this, function createSiteTheme() {
  'use strict';

  // Loaded without defer in <head>, before the stylesheets paint, so the page never flashes the
  // wrong palette. Day (草莓牛奶) runs 08:00–17:59 Taipei time, night (晚安小夜燈) the rest; a visitor
  // can pin either one, kept only in this browser. Without JavaScript, styles.css follows the
  // system light or dark preference instead.

  const STORAGE_KEY = 'xiaoji-theme';
  const DAY_START_HOUR = 8;
  const NIGHT_START_HOUR = 18;
  const CHOICES = Object.freeze(['auto', 'day', 'night']);
  const THEME_COLORS = Object.freeze({ day: '#fff7f2', night: '#241923' });

  function themeForHour(hour) {
    return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? 'day' : 'night';
  }

  function taipeiHour(date = new Date()) {
    try {
      const text = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hourCycle: 'h23' }).format(date);
      const hour = Number.parseInt(text, 10);
      return Number.isInteger(hour) ? hour % 24 : date.getHours();
    } catch (_error) {
      return date.getHours();
    }
  }

  function resolveTheme(choice, date = new Date()) {
    return choice === 'day' || choice === 'night' ? choice : themeForHour(taipeiHour(date));
  }

  function readChoice(window) {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return CHOICES.includes(stored) ? stored : 'auto';
    } catch (_error) {
      return 'auto';
    }
  }

  function writeChoice(window, choice) {
    try {
      if (choice === 'auto') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, choice);
    } catch (_error) {
      // Private windows may refuse storage; the choice then lasts until the page closes.
    }
  }

  function nextChoice(choice) {
    return CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
  }

  function applyTheme(document, window, choice = readChoice(window)) {
    const html = document.documentElement;
    const theme = resolveTheme(choice);
    html.classList.add('js');
    html.dataset.theme = theme;
    html.dataset.themeChoice = choice;
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => { meta.content = THEME_COLORS[theme]; });
    return theme;
  }

  function setChoice(document, window, choice) {
    const safeChoice = CHOICES.includes(choice) ? choice : 'auto';
    writeChoice(window, safeChoice);
    return applyTheme(document, window, safeChoice);
  }

  return Object.freeze({
    CHOICES,
    applyTheme,
    nextChoice,
    readChoice,
    resolveTheme,
    setChoice,
    taipeiHour,
    themeForHour,
  });
});
