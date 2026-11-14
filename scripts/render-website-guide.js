const fs = require('node:fs');
const path = require('node:path');
const defaultCommandCatalog = require('../website/commandCatalog');
const { PUBLIC_SYSTEM_CATALOG } = require('../website/publicFeatureCatalog');
const { ADMIN_MARKER, buildHelpSections } = require('../src/commands/help');
const { PUBLIC_FEATURE_CATALOG } = require('../website/statusData');
const { listPublicCommands } = require('../src/platform/publicCommandStatus');

// The website writes its feature and command lists into the HTML ahead of time, so the lists can be
// read without JavaScript (search engines, link previews and AI readers). The parts between the
// "generated" markers below come from website/publicFeatureCatalog.js and website/commandCatalog.js;
// edit those catalogs and run `npm run site:render`, never the generated HTML.
// scripts/check-project.js fails when a page no longer matches what this script renders.

const WEBSITE_ROOT = path.resolve(__dirname, '..', 'website');

const AUDIENCE_LABELS = Object.freeze({ public: '一般成員', admin: '需管理權限' });

// Commands that no feature mentions still belong to one category: the one their /help group is
// closest to. Every value must be a system name in the public feature catalog.
const GROUP_FALLBACK_CATEGORY = Object.freeze({
  general: '實用工具',
  economy: '吉幣、工作與銀行',
  community: '社群互動',
});

// A closer category for commands that no feature mentions yet, checked before the group fallback.
const UNMENTIONED_COMMAND_CATEGORY = Object.freeze({
  memory: 'AI 與聊天',
  student: 'AI 與聊天',
  'release-announcements': '網站與公開資訊',
});

// The homepage highlight cards. Each one names a system of the public feature catalog; the card
// lists that system's features, so a new feature shows up on the homepage without editing it.
const HOMEPAGE_HIGHLIGHTS = Object.freeze([
  { system: 'AI 與聊天', glyph: '☁', wide: true, tagline: '會記得你的喜好與聊天風格，也能自由開關親暱模式，全部保留安全與隱私界線。' },
  { system: '吉幣、工作與銀行', glyph: '⌁', tagline: '台灣日期簽到、全域商店、工作與銀行，跟著你的帳號跨伺服器共用。' },
  { system: '社群互動', glyph: '✓', tagline: '投票、接龍與每日活動各有清楚的規則，讓大家自然地聊起來。' },
  { system: '棋盤與推理遊戲', glyph: '▦', wide: true, tagline: '在同一個頻道開一局，和朋友下棋或一起玩海龜湯；輪到誰、怎麼操作都清楚可見。' },
]);

const MARKERS = Object.freeze({
  filters: 'guide-filters',
  features: 'guide-features',
  commands: 'guide-commands',
  highlights: 'home-highlights',
  statusFeatures: 'status-features',
  statusCommands: 'status-commands',
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function indent(lines, spaces) {
  const pad = ' '.repeat(spaces);
  return lines.map((line) => (line ? `${pad}${line}` : line));
}

// The command lines exactly as /help lists them; owner-only commands and subcommands never appear.
function listCommandLines(catalog = defaultCommandCatalog) {
  return buildHelpSections(catalog).map((section) => ({
    ...section,
    entries: section.entries.map((entry) => ({
      ...entry,
      subcommands: entry.usage.includes(' ') ? entry.usage.split(' ')[1].split('/') : [],
      // The badge already says who may use it, so the marker is not repeated in the text.
      text: entry.text.split('；').filter((part) => part !== ADMIN_MARKER).join('；'),
    })),
  }));
}

// "/bank deposit" or "/coins" mentioned in a feature's how-to text, as [command, subcommand|null].
function findCommandMentions(text, commandNames) {
  const mentions = [];
  for (const match of String(text).matchAll(/\/([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/gu)) {
    if (commandNames.has(match[1])) mentions.push([match[1], match[2] || null]);
  }
  return mentions;
}

// Who can use a feature: the audience of every command line its how-to text mentions. A mention
// with a known subcommand takes that subcommand's line; a bare command counts as members' when any
// part of it is for members. A feature that names no command (such as mentioning 小吉) is for members.
function featureAudiences(feature, linesByCommand) {
  const audiences = new Set();
  for (const [name, subcommand] of findCommandMentions(feature.howTo, new Set(linesByCommand.keys()))) {
    const lines = linesByCommand.get(name);
    const exact = subcommand && lines.find((line) => line.subcommands.includes(subcommand));
    if (exact) audiences.add(exact.audience);
    else audiences.add(lines.some((line) => line.audience === 'public') ? 'public' : 'admin');
  }
  if (audiences.size === 0) audiences.add('public');
  return ['public', 'admin'].filter((audience) => audiences.has(audience));
}

// One model of everything the guide shows, so the page, the homepage and the tests agree.
function buildGuideModel({ systems = PUBLIC_SYSTEM_CATALOG, catalog = defaultCommandCatalog } = {}) {
  const sections = listCommandLines(catalog);
  const linesByCommand = new Map();
  for (const entry of sections.flatMap((section) => section.entries)) {
    if (!linesByCommand.has(entry.name)) linesByCommand.set(entry.name, []);
    linesByCommand.get(entry.name).push(entry);
  }
  const systemNames = systems.map((system) => system.name);
  for (const category of [...Object.values(GROUP_FALLBACK_CATEGORY), ...Object.values(UNMENTIONED_COMMAND_CATEGORY)]) {
    if (!systemNames.includes(category)) throw new Error(`Guide fallback category is not a public system: ${category}`);
  }

  const commandCategories = new Map();
  const featureSystems = systems.map((system) => ({
    name: system.name,
    features: system.features.map((feature) => {
      for (const [name] of findCommandMentions(feature.howTo, new Set(linesByCommand.keys()))) {
        if (!commandCategories.has(name)) commandCategories.set(name, new Set());
        commandCategories.get(name).add(system.name);
      }
      return { ...feature, category: system.name, audiences: featureAudiences(feature, linesByCommand) };
    }),
  }));

  const commandGroups = sections.map((section) => ({
    id: section.id,
    title: section.title,
    entries: section.entries.map((entry) => {
      const mentioned = commandCategories.get(entry.name);
      const categories = mentioned
        ? systemNames.filter((name) => mentioned.has(name))
        : [UNMENTIONED_COMMAND_CATEGORY[entry.name] || GROUP_FALLBACK_CATEGORY[section.id]];
      return { ...entry, categories };
    }),
  }));

  return { categories: systemNames, featureSystems, commandGroups };
}

function renderBadges(audiences) {
  return audiences
    .map((audience) => `<span class="who-badge is-${audience}">${AUDIENCE_LABELS[audience]}</span>`)
    .join('');
}

// A chip shows the category without its trailing note in full-width brackets.
function shortCategoryLabel(category) {
  return category.replace(/（[^（）]*）$/u, '');
}

function renderFilters(model) {
  const chip = (name, value, label, checked) => [
    `<label class="filter-chip"><input type="radio" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''} /><span>${escapeHtml(label)}</span></label>`,
  ];
  return [
    '<fieldset class="guide-filter" data-guide-filter="cat">',
    '  <legend>分類</legend>',
    '  <div class="filter-chips">',
    ...indent(chip('cat', '', '全部', true), 4),
    ...indent(model.categories.flatMap((category) => chip('cat', category, shortCategoryLabel(category), false)), 4),
    '  </div>',
    '</fieldset>',
    '<fieldset class="guide-filter" data-guide-filter="who">',
    '  <legend>可用對象</legend>',
    '  <div class="filter-chips">',
    ...indent(chip('who', '', '全部', true), 4),
    ...indent(chip('who', 'public', AUDIENCE_LABELS.public, false), 4),
    ...indent(chip('who', 'admin', AUDIENCE_LABELS.admin, false), 4),
    '  </div>',
    '</fieldset>',
  ];
}

function renderFeatures(model) {
  const lines = [];
  for (const system of model.featureSystems) {
    lines.push('<div class="guide-group" data-guide-group>');
    lines.push(`  <h3 class="guide-group-title">${escapeHtml(system.name)}</h3>`);
    lines.push('  <ul class="guide-list">');
    for (const feature of system.features) {
      lines.push(
        `    <li class="guide-item" data-guide-item data-kind="feature" data-cat="${escapeHtml(feature.category)}" data-who="${feature.audiences.join(' ')}">`,
        '      <details>',
        `        <summary><span class="guide-item-head"><strong class="guide-item-name">${escapeHtml(feature.name)}</strong>${renderBadges(feature.audiences)}</span><span class="guide-item-purpose">${escapeHtml(feature.purpose)}</span></summary>`,
        '        <dl class="guide-item-detail">',
        `          <dt>如何使用</dt><dd>${escapeHtml(feature.howTo)}</dd>`,
        `          <dt>使用限制</dt><dd>${escapeHtml(feature.limitation)}</dd>`,
        '        </dl>',
        '      </details>',
        '    </li>',
      );
    }
    lines.push('  </ul>', '</div>');
  }
  return lines;
}

function renderCommands(model) {
  const lines = [];
  for (const group of model.commandGroups) {
    lines.push('<div class="guide-group" data-guide-group>');
    lines.push(`  <h3 class="guide-group-title">${escapeHtml(group.title)}</h3>`);
    lines.push('  <ul class="guide-list guide-command-list">');
    for (const entry of group.entries) {
      lines.push(
        `    <li class="guide-item guide-command" data-guide-item data-kind="command" data-cat="${escapeHtml(entry.categories.join('|'))}" data-who="${entry.audience}">`,
        `      <span class="guide-item-head"><code class="guide-usage">${escapeHtml(entry.usage)}</code>${renderBadges([entry.audience])}</span>`,
        `      <span class="guide-item-purpose">${escapeHtml(entry.text)}</span>`,
        '    </li>',
      );
    }
    lines.push('  </ul>', '</div>');
  }
  return lines;
}

function renderHighlights(model) {
  const systems = new Map(model.featureSystems.map((system) => [system.name, system]));
  const lines = [];
  HOMEPAGE_HIGHLIGHTS.forEach((highlight, index) => {
    const system = systems.get(highlight.system);
    if (!system) throw new Error(`Homepage highlight names a system that is not public: ${highlight.system}`);
    const href = `./guide.html?cat=${encodeURIComponent(system.name)}`;
    lines.push(
      `<article class="feature-card${highlight.wide ? ' feature-wide' : ''} reveal">`,
      `  <span class="feature-number">${String(index + 1).padStart(2, '0')}</span>`,
      `  <div class="feature-glyph" aria-hidden="true">${escapeHtml(highlight.glyph)}</div>`,
      `  <h3>${escapeHtml(system.name)}</h3>`,
      `  <p>${escapeHtml(highlight.tagline)}</p>`,
      `  <ul class="style-chips" aria-label="${escapeHtml(system.name)}的功能">`,
      ...system.features.map((feature) => `    <li>${escapeHtml(feature.name)}</li>`),
      '  </ul>',
      `  <a class="feature-link" href="${escapeHtml(href)}">看 ${system.features.length} 項功能怎麼用 <span aria-hidden="true">→</span></a>`,
      '</article>',
    );
  });
  return lines;
}

// The status page lists every feature and every public command with an unknown status; status.js fills in the live
// one. Feature groups follow the categories of website/statusData.js, command groups the /help groups.
const UNKNOWN_PILL = '<span class="status-pill is-unknown" data-status-pill>未知</span><span class="status-reason" data-status-reason></span>';

function renderStatusGroup(title, kind, items) {
  return [
    `<div class="status-group" data-status-group data-kind="${kind}">`,
    '  <details data-status-group-details>',
    `    <summary><span class="status-group-title">${escapeHtml(title)}</span><span class="status-group-count" data-status-group-count>${items.length} 項</span></summary>`,
    `    <ul class="status-list">`,
    ...indent(items.flat(), 6),
    '    </ul>',
    '  </details>',
    '</div>',
  ];
}

function renderStatusFeatures({ features = PUBLIC_FEATURE_CATALOG } = {}) {
  const categories = [];
  for (const feature of features) {
    let category = categories.find((entry) => entry.name === feature.category);
    if (!category) categories.push(category = { name: feature.category, features: [] });
    category.features.push(feature);
  }
  return categories.flatMap((category) => renderStatusGroup(category.name, 'feature', category.features.map((feature) => [
    `<li class="status-row" data-status-item data-kind="feature" data-key="${escapeHtml(feature.key)}" data-search="${escapeHtml(`${feature.name} ${category.name}`.toLowerCase())}">`,
    `  <span class="status-row-head"><strong class="status-row-name">${escapeHtml(feature.name)}</strong></span>`,
    `  <span class="status-row-state">${UNKNOWN_PILL}</span>`,
    '</li>',
  ])));
}

function renderStatusCommands({ catalog = defaultCommandCatalog } = {}) {
  const commands = listPublicCommands(catalog);
  return catalog.COMMAND_GROUPS.flatMap((group) => {
    const entries = commands.filter((command) => command.group === group.id);
    if (!entries.length) return [];
    return renderStatusGroup(group.title, 'command', entries.map((command) => {
      const description = catalog.getCommand(command.name).description;
      const search = [`/${command.name}`, description, ...command.subcommands].join(' ').toLowerCase();
      const head = `<span class="status-row-head"><code class="status-usage">/${escapeHtml(command.name)}</code><span class="status-row-purpose">${escapeHtml(description)}</span></span>`;
      const open = `<li class="status-row status-command" data-status-item data-kind="command" data-key="${escapeHtml(command.name)}" data-search="${escapeHtml(search)}">`;
      if (!command.subcommands.length) return [open, `  ${head}`, `  <span class="status-row-state">${UNKNOWN_PILL}</span>`, '</li>'];
      return [
        open,
        '  <details>',
        `    <summary>${head}<span class="status-row-state">${UNKNOWN_PILL}</span><span class="status-sub-toggle">${command.subcommands.length} 個子指令</span></summary>`,
        '    <ul class="status-sublist">',
        ...command.subcommands.map((sub) => `      <li class="status-subrow" data-status-sub data-key="${escapeHtml(sub)}"><code class="status-usage">/${escapeHtml(command.name)} ${escapeHtml(sub)}</code><span class="status-row-state">${UNKNOWN_PILL}</span></li>`),
        '    </ul>',
        '  </details>',
        '</li>',
      ];
    }));
  });
}

// Each page and the generated blocks it carries, with the indentation of the marker line.
const PAGES = Object.freeze([
  { file: 'guide.html', blocks: [[MARKERS.filters, renderFilters], [MARKERS.features, renderFeatures], [MARKERS.commands, renderCommands]] },
  { file: 'index.html', blocks: [[MARKERS.highlights, renderHighlights]] },
  { file: 'status.html', blocks: [[MARKERS.statusFeatures, () => renderStatusFeatures()], [MARKERS.statusCommands, () => renderStatusCommands()]] },
]);

function replaceBlock(source, marker, lines, file) {
  const pattern = new RegExp(`([ \\t]*)<!-- generated:${marker}:start -->[\\s\\S]*?<!-- generated:${marker}:end -->`, 'u');
  const match = source.match(pattern);
  if (!match) throw new Error(`website/${file} is missing the generated:${marker} markers.`);
  const pad = match[1];
  const body = lines.map((line) => (line ? `${pad}${line}` : line)).join('\n');
  const block = `${pad}<!-- generated:${marker}:start -->\n${body}\n${pad}<!-- generated:${marker}:end -->`;
  return source.replace(pattern, () => block);
}

function renderPage(source, page, model) {
  let output = source.replace(/\r\n/gu, '\n');
  for (const [marker, render] of page.blocks) output = replaceBlock(output, marker, render(model), page.file);
  return output;
}

// The pages as they should read. Throws when a marker is missing or a catalog name does not fit.
function renderWebsitePages({ websiteRoot = WEBSITE_ROOT, systems, catalog } = {}) {
  const model = buildGuideModel({ systems, catalog });
  return PAGES.map((page) => {
    const current = fs.readFileSync(path.join(websiteRoot, page.file), 'utf8');
    return { file: page.file, current, rendered: renderPage(current, page, model) };
  });
}

function findWebsiteGuideIssues(options = {}) {
  try {
    return renderWebsitePages(options)
      .filter((page) => page.current.replace(/\r\n/gu, '\n') !== page.rendered)
      .map((page) => `website/${page.file} is out of date with the public catalogs; run npm run site:render.`);
  } catch (error) {
    return [error.message];
  }
}

function synchronizeWebsitePages(options = {}) {
  const pages = renderWebsitePages(options);
  const websiteRoot = options.websiteRoot || WEBSITE_ROOT;
  for (const page of pages) {
    if (page.current.replace(/\r\n/gu, '\n') === page.rendered) continue;
    fs.writeFileSync(path.join(websiteRoot, page.file), page.rendered, 'utf8');
    console.log(`Rendered website/${page.file} from the public catalogs.`);
  }
  return pages;
}

if (require.main === module) synchronizeWebsitePages();

module.exports = {
  AUDIENCE_LABELS,
  GROUP_FALLBACK_CATEGORY,
  HOMEPAGE_HIGHLIGHTS,
  UNMENTIONED_COMMAND_CATEGORY,
  buildGuideModel,
  findCommandMentions,
  findWebsiteGuideIssues,
  renderStatusCommands,
  renderStatusFeatures,
  renderWebsitePages,
  synchronizeWebsitePages,
};
