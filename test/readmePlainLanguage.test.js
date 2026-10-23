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

test('the README stays short enough to read in about thirty seconds', () => {
  assert.ok(readme.length <= 2600, `README.md has ${readme.length} characters`);
  assert.match(readme, /\n## 30 秒看懂 1\.3\.0 大更新\n/u);
});

test('the README has no setup, code or engineering words', () => {
  assert.ok(!readme.includes('```'), 'no code blocks');
  for (const word of ['npm', '.env', 'sqlite', 'SQLite', 'discord.js', 'Node.js', 'fsync', 'token', 'TOKEN', 'git ', 'JSON', 'API', 'XIAOJI_', 'COIN_DB']) {
    assert.ok(!readme.includes(word), `README.md must not contain "${word}"`);
  }
});

test('every local link in the README points at a file the public export ships', () => {
  const shipped = new Set(buildPublicExportPlan());
  const targets = [...readme.matchAll(/\]\(([^)#\s]+)\)/gu)].map((match) => match[1]).filter((target) => !/^[a-z]+:/iu.test(target));
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
