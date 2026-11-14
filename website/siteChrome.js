(function bootstrapSiteChrome() {
  'use strict';

  // Shared page behaviour for every official page: the menu button, the day/night switch, the
  // header that settles once the page scrolls, the section the menu marks as current, the
  // background tint each section asks for (data-scene), what the companion bubble says
  // (data-companion), and the fade-in of .reveal blocks (played again whenever a block scrolls back into view). Load it after siteSupport.js.

  const html = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const THEME_LABELS = Object.freeze({
    auto: { icon: '◐', text: '配色：跟著台北時間' },
    day: { icon: '☀', text: '配色：白天' },
    night: { icon: '☾', text: '配色：夜晚' },
  });

  function setupNavigation() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.querySelector('[data-nav]');
    if (!toggle || !nav) return;
    const close = () => {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
    };
    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isOpen));
      nav.classList.toggle('is-open', !isOpen);
    });
    nav.addEventListener('click', (event) => { if (event.target.closest('a')) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  }

  function setupThemeToggle() {
    const theme = window.XiaojiTheme;
    const button = document.querySelector('[data-theme-toggle]');
    if (!theme || !button) return;
    const render = () => {
      const label = THEME_LABELS[html.dataset.themeChoice] || THEME_LABELS.auto;
      button.querySelector('[data-theme-icon]').textContent = label.icon;
      button.setAttribute('aria-label', `${label.text}（按一下切換）`);
      button.title = label.text;
    };
    button.hidden = false;
    render();
    button.addEventListener('click', () => {
      theme.setChoice(document, window, theme.nextChoice(html.dataset.themeChoice || 'auto'));
      render();
    });
    // Following Taipei time means switching at 08:00 and 18:00 even on a page left open.
    window.setInterval(() => {
      if ((html.dataset.themeChoice || 'auto') === 'auto') theme.applyTheme(document, window, 'auto');
    }, 5 * 60 * 1000);
  }

  function setupHeader() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    let queued = false;
    const update = () => {
      queued = false;
      header.classList.toggle('is-scrolled', window.scrollY > 24);
    };
    window.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    update();
  }

  // One observer decides which section is "current": the menu link, the background tint and the
  // companion line all follow it.
  function setupSections() {
    const sections = [...document.querySelectorAll('main [data-scene], main [data-companion], main section[id]')];
    if (!sections.length || !('IntersectionObserver' in window)) return;
    const navLinks = [...document.querySelectorAll('[data-nav] a[href^="#"]')];
    let current = null;

    const activate = (section) => {
      if (section === current) return;
      current = section;
      if (section.dataset.scene) html.dataset.scene = section.dataset.scene;
      navLinks.forEach((link) => {
        const active = section.id && link.getAttribute('href') === `#${section.id}`;
        link.classList.toggle('is-active', Boolean(active));
        if (active) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
      if (section.dataset.companion) window.XiaojiSiteSupport?.say?.(section.dataset.companion);
    };

    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) visible.set(entry.target, entry.intersectionRatio);
        else visible.delete(entry.target);
      });
      const best = sections.find((section) => visible.has(section) && visible.get(section) >= 0.35)
        || [...visible.keys()].sort((a, b) => visible.get(b) - visible.get(a))[0];
      if (best) activate(best);
    }, { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.35, 0.7] });
    sections.forEach((section) => observer.observe(section));
  }

  function setupReveal() {
    const items = [...document.querySelectorAll('.reveal')];
    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }
    // The fade-in plays every time a block comes into view, scrolling down or up: a block that leaves the
    // screen is reset, and one coming back in from above rises from above instead of below.
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const fromAbove = entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
        } else {
          entry.target.classList.toggle('from-above', fromAbove);
          entry.target.classList.remove('is-visible');
        }
      });
    }, { threshold: 0.12 });
    items.forEach((item) => observer.observe(item));
  }

  setupNavigation();
  setupThemeToggle();
  setupHeader();
  setupSections();
  setupReveal();
})();
