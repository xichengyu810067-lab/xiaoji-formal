const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// docs/WEBSITE_ARCHITECTURE.md lets people and AI maintain the website without screenshots, so it
// has to describe the pages as they are: the sections of each page and the palette values.

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/gu, '\n');
const guide = read('docs/WEBSITE_ARCHITECTURE.md');

function tableRows(text) {
  return text.split('\n')
    .filter((line) => /^\| `/u.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

// The "### `website/<page>.html`" subsections of section 3, each with its rows.
function documentedPages() {
  const section = guide.slice(guide.indexOf('## 3.'), guide.indexOf('## 4.'));
  return [...section.matchAll(/^### `(website\/[^`]+\.html)`\n([\s\S]*?)(?=^### |(?![\s\S]))/gmu)]
    .map(([, file, body]) => ({ file, rows: tableRows(body) }));
}

function pageSections(html) {
  return [...html.matchAll(/<section\b([^>]*)>/gu)]
    .map(([, attributes]) => ({
      id: attributes.match(/\bid="([^"]+)"/u)?.[1],
      scene: attributes.match(/\bdata-scene="([^"]+)"/u)?.[1] || '—',
      companion: attributes.match(/\bdata-companion="([^"]+)"/u)?.[1] || '—',
    }))
    .filter((section) => section.id);
}

test('every official page is described, section by section', () => {
  const pages = documentedPages();
  assert.deepEqual(pages.map((page) => page.file).sort(), [
    'website/guide.html', 'website/index.html', 'website/policies.html', 'website/status.html',
  ]);
  for (const page of pages) {
    const actual = pageSections(read(page.file));
    const written = page.rows.map(([id, scene, , companion]) => ({ id: id.replaceAll('`', ''), scene, companion }));
    assert.deepEqual(written, actual, `${page.file}: section 3 of docs/WEBSITE_ARCHITECTURE.md does not match the page`);
  }
});

function cssBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `styles.css has no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)].map(([, name, value]) => [name, value.trim()]));
}

test('the palette table matches both palettes in styles.css', () => {
  const css = read('website/styles.css');
  const day = cssBlock(css, ':root');
  const night = cssBlock(css, 'html[data-theme="night"]');
  const darkPreference = cssBlock(css, '  html:not([data-theme])');
  assert.deepEqual(darkPreference, night, 'the no-JavaScript dark preference repeats the night palette');

  const section = guide.slice(guide.indexOf('## 5.'), guide.indexOf('## 6.'));
  const written = Object.fromEntries(tableRows(section).map(([name, dayValue, nightValue]) => [
    name.replaceAll('`', ''), { day: dayValue.replaceAll('`', ''), night: nightValue.replaceAll('`', '') },
  ]));
  assert.deepEqual(Object.keys(written).sort(), Object.keys(night).sort(), 'every palette token is documented once');
  for (const [name, values] of Object.entries(written)) {
    assert.equal(values.day, day[name], `${name} (day)`);
    assert.equal(values.night, night[name], `${name} (night)`);
  }
});

test('every generated block the guide names exists in its page', () => {
  const section = guide.slice(guide.indexOf('## 4.'), guide.indexOf('## 5.'));
  const blocks = tableRows(section).map(([block, page]) => [block.replaceAll('`', ''), page.replaceAll('`', '')]);
  assert.ok(blocks.length >= 4);
  for (const [block, page] of blocks) {
    assert.ok(read(page).includes(`<!-- generated:${block}:start -->`), `${page} has no generated:${block}`);
  }
});

test('the files the guide lists exist', () => {
  const section = guide.slice(guide.indexOf('## 2.'), guide.indexOf('## 3.'));
  for (const [cell] of tableRows(section)) {
    for (const [, file] of cell.matchAll(/`([^`]+)`/gu)) assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});
