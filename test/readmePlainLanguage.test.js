'use strict';

// The README is the front door for people with no technical background: it must be short, free of
// setup and engineering words, and send anyone who wants the technical documents to them by link.
// Setup, upgrade, repair and test instructions live in docs/OPERATIONS.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPublicExportPlan } = require('../scripts/create-public-export');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/gu, '\n');

test('the README opens with the 30-second summary of the current release and a table of contents', () => {
  // The section titles are pictures in the website's handwriting font (scripts/build-readme-art.py); their alt
  // text carries the words.
  assert.match(readme, /<h2><a id="new"><\/a><img src="docs\/images\/readme\/titles\/new\.svg" alt="30 秒看懂 1\.3\.4 更新"><\/h2>/u);
  assert.match(readme, /<h2><a id="toc"><\/a><img src="docs\/images\/readme\/titles\/toc\.svg" alt="目錄"><\/h2>/u);
});

test('every in-page link in the README points at an anchor or a heading it has', () => {
  // GitHub's heading anchors: lower case, punctuation removed, spaces turned into hyphens.
  const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-');
  const anchors = new Set([
    ...[...readme.matchAll(/^#{1,6} (.+)$/gmu)].map((match) => slug(match[1])),
    ...[...readme.matchAll(/<a id="([^"]+)"><\/a>/gu)].map((match) => match[1]),
  ]);
  const targets = [...readme.matchAll(/(?:\]\(|href=")#([^)"]+)/gu)].map((match) => match[1]);
  assert.ok(targets.length >= 13, 'the table of contents links its sections');
  for (const target of targets) assert.ok(anchors.has(target), `#${target} is an anchor of the README`);
});

test('every picture title in the README has its picture and says its words in the alt text', () => {
  const titles = [...readme.matchAll(/<h[23]><a id="([^"]+)"><\/a><img src="(docs\/images\/readme\/titles\/[^"]+\.svg)" alt="([^"]+)"><\/h[23]>/gu)];
  assert.equal(titles.length, 14, 'six section titles and eight feature titles');
  for (const [, id, picture, words] of titles) {
    const svg = fs.readFileSync(path.join(ROOT, picture), 'utf8');
    assert.ok(svg.includes(`aria-label="${words}"`), `${picture} is the picture of "${words}" (#${id})`);
  }
});

test('the README has no setup, code or engineering words', () => {
  const fences = [...readme.matchAll(/^```(.*)$/gmu)].map((match) => match[1]);
  assert.ok(fences.every((info) => info === 'mermaid' || info === ''), 'the only fenced blocks are diagrams');
  for (const word of ['npm', '.env', 'sqlite', 'SQLite', 'discord.js', 'Node.js', 'fsync', 'token', 'TOKEN', 'git ', 'JSON', 'API', 'XIAOJI_', 'COIN_DB']) {
    assert.ok(!readme.includes(word), `README.md must not contain "${word}"`);
  }
});

test('every local link in the README points at a file the public export ships', () => {
  const shipped = new Set(buildPublicExportPlan());
  const targets = [...readme.matchAll(/(?:\]\(|(?:src|srcset)=")([^)"#\s]+)/gu)].map((match) => match[1]).filter((target) => !/^[a-z]+:/iu.test(target));
  assert.ok(targets.length >= 12, 'the README links its images and the technical documents');
  for (const target of targets) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), `${target} exists`);
    assert.ok(shipped.has(target), `${target} is in the public export`);
  }
});

test('the technical documents the README links to are the ones that carry the setup and repair steps', () => {
  for (const target of ['docs/OPERATIONS.md', 'docs/ARCHITECTURE.md', 'docs/COMMANDS.md', 'docs/EXTENSION_CONTRACT.md', 'docs/JEV_SETUP.md', 'docs/MANAGEMENT_ISOLATION.md']) {
    assert.ok(readme.includes(`](${target})`), `${target} is linked`);
  }
  const operations = fs.readFileSync(path.join(ROOT, 'docs', 'OPERATIONS.md'), 'utf8');
  for (const heading of ['## 安裝', '## 受保護的副作用與安全帳本', '### 升級與資料位置', '## 公開指令', '## 部署與驗證', '## 本機隔離測試（test-control）']) {
    assert.ok(operations.includes(`\n${heading}\n`), `${heading} is in docs/OPERATIONS.md`);
  }
});
