'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The website's handwriting font is a subset of 辰宇落雁體 that holds only the characters the website's own files
// use (scripts/build-site-font.py). A character the subset lacks still shows, in the fallback font, so the test
// asks for the subset to be rebuilt rather than letting the page mix two handwritings.
const ROOT = path.join(__dirname, '..');
const FONTS = path.join(ROOT, 'website', 'assets', 'fonts');

function websiteText(dir = path.join(ROOT, 'website')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'games' ? [] : websiteText(full);
    return /\.(html|js|css)$/u.test(entry.name) ? [fs.readFileSync(full, 'utf8')] : [];
  });
}

test('the website font was built from every character the website uses', () => {
  const covered = new Set(fs.readFileSync(path.join(FONTS, 'xiaoji-hand.chars.txt'), 'utf8'));
  const missing = new Set();
  for (const text of websiteText()) {
    for (const char of text) {
      if (char.codePointAt(0) >= 0x3000 && !covered.has(char)) missing.add(char);
    }
  }
  assert.deepEqual([...missing].join(''), '', 'run python scripts/build-site-font.py --source <ChenYuluoyan-2.0-Thin.ttf>');
});

test('the website font ships renamed, with the licence and the original copyright notice', () => {
  const font = fs.readFileSync(path.join(FONTS, 'xiaoji-hand.woff2'));
  assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2');
  const licence = fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8');
  assert.match(licence, /Reserved Font Name "辰宇落雁" and "Chenyuluoyan"/u);
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/u);
  const css = fs.readFileSync(path.join(ROOT, 'website', 'styles.css'), 'utf8');
  assert.match(css, /font-family: "Xiaoji Hand";\s*src: url\("\.\/assets\/fonts\/xiaoji-hand\.woff2"\)/u);
  assert.doesNotMatch(css, /font-family:[^;]*(Chenyuluoyan|辰宇落雁)/iu, 'the reserved names stay off the modified font');
});
