'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const test = require('node:test');

const project = path.resolve(__dirname, '..');
const resolver = path.join(project, 'src/platform/retainedDataSource.js');
function child(body, args = []) {
  const script = `const assert = require('node:assert/strict');
    const fs = require('node:fs'); const path = require('node:path');
    const source = require(${JSON.stringify(resolver)});
    const project = ${JSON.stringify(project)};
    ${body}`;
  const result = spawnSync(process.execPath, ['-e', script, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-retained-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'old');
  fs.mkdirSync(path.join(old, 'src/data'), { recursive: true });
  return { root, old };
}

test('ordinary startup keeps its existing origin and seals it on first access', () => {
  child(`assert.equal(source.getRetainedDataSourceRoot(), project);
    assert.equal(source.retainedDataFile('guildConfig.json'), path.join(project, 'src/data/guildConfig.json'));
    assert.throws(() => source.configureRetainedDataSourceRoot(project), /before stores/);`);
});

test('protected personal provenance stays bound to the retained origin, including after current records change', (t) => {
  const { root, old } = fixture(t);
  const protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(protectedRoot);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const evidence = (file) => {
    const stat = fs.statSync(file);
    return {filePath: file, realPath: fs.realpathSync(file), fileIdentity: `${stat.dev}:${stat.ino}`, sha256: hash(file)};
  };
  for (const [kind, name, envPath, envPin] of [
    ['reminders', 'reminders.json', 'XIAOJI_REMINDERS_PATH', 'XIAOJI_REMINDERS_PROVENANCE_SHA256'],
    ['calendar', 'calendarEvents.json', 'XIAOJI_CALENDAR_PATH', 'XIAOJI_CALENDAR_PROVENANCE_SHA256'],
  ]) {
    const origin = path.join(old, 'src/data', name);
    const target = path.join(protectedRoot, name);
    fs.writeFileSync(origin, '{}');
    fs.writeFileSync(target, '{}');
    fs.writeFileSync(`${target}.source-snapshot.json`, '{}');
    const ev = evidence(target);
    const receipt = {schemaVersion:1, state:'active', kind, migrationId:crypto.randomUUID(),
      activatedAt:'2026-09-26T00:00:00.000Z', origin:evidence(origin), source:evidence(`${target}.source-snapshot.json`),
      target:{filePath:target,realPath:target,initialFileIdentity:ev.fileIdentity,initialSha256:ev.sha256}};
    fs.writeFileSync(`${target}.provenance.json`, JSON.stringify(receipt));
    fs.writeFileSync(target, '{"changed":{"synthetic":true}}');
    const env = {[envPath]:target,[envPin]:hash(`${target}.provenance.json`)};
    child(`source.configureRetainedDataSourceRoot(process.argv[1]);
      const personal = require(path.join(project, 'src/platform/personalDataPaths'));
      const env = JSON.parse(process.argv[2]);
      assert.equal(personal.resolvePersonalDataPath(process.argv[3], {env}).filePath, process.argv[4]);
      env[process.argv[5]] = '0'.repeat(64);
      assert.throws(() => personal.resolvePersonalDataPath(process.argv[3], {env}), {code:'PERSONAL_DATA_PROVENANCE_MISMATCH'});`,
    [old, JSON.stringify(env), kind, target, envPin]);
  }
});

test('configured origin is one-shot, canonical, and cannot accept filenames with traversal', (t) => {
  const { root, old } = fixture(t);
  child(`assert.throws(() => source.configureRetainedDataSourceRoot('relative'), /absolute/);
    source.configureRetainedDataSourceRoot(process.argv[1]);
    assert.throws(() => source.configureRetainedDataSourceRoot(process.argv[1]), /reconfigured/);
    assert.equal(source.getRetainedDataSourceRoot(), process.argv[1]);
    for (const name of ['../secret.json', '.env', 'a/b.json', 'a\\\\b.json', 'a:evil.json'])
      assert.throws(() => source.retainedDataFile(name), /plain JSON/);`, [old]);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(old, linked, process.platform === 'win32' ? 'junction' : 'dir');
  child(`assert.throws(() => source.configureRetainedDataSourceRoot(process.argv[1]), /without links/);`, [linked]);
  child(`assert.throws(() => source.configureRetainedDataSourceRoot(process.argv[1]), /without links/);`,
    [path.join(linked, 'src')]);
});

test('configuration, quota, polls and personal paths use the retained origin across fresh processes', (t) => {
  const { old } = fixture(t);
  const data = path.join(old, 'src/data');
  fs.writeFileSync(path.join(data, 'guildConfig.json'), '{"fixture":{"welcomeChannelId":"original"}}');
  fs.writeFileSync(path.join(data, 'guildQuotas.json'), '{"fixture":{"limit":20,"used":3}}');
  fs.writeFileSync(path.join(data, 'polls.json'), '{"fixture":{"question":"synthetic"}}');
  fs.writeFileSync(path.join(data, 'reminders.json'), '{}');
  fs.writeFileSync(path.join(data, 'calendarEvents.json'), '{}');
  child(`source.configureRetainedDataSourceRoot(process.argv[1]);
    const config = require(path.join(project, 'src/utils/guildConfig'));
    const quota = require(path.join(project, 'src/services/quotaService'));
    const polls = require(path.join(project, 'src/services/pollService'));
    const personal = require(path.join(project, 'src/platform/personalDataPaths'));
    assert.equal(config.getGuildConfig('fixture').welcomeChannelId, 'original');
    config.setGuildWelcomeChannel('fixture', 'updated');
    assert.equal(quota.getGuildQuota('fixture').used, 3);
    quota.setGuildQuota('fixture', 21, 4);
    assert.equal(polls.readPolls().fixture.question, 'synthetic');
    for (const [kind, name] of [['reminders', 'reminders.json'], ['calendar', 'calendarEvents.json']]) {
      const selected = personal.resolvePersonalDataPath(kind, {env:{}});
      assert.equal(selected.filePath, path.join(process.argv[1], 'src/data', name));
    }`, [old]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'guildConfig.json'))).fixture.welcomeChannelId, 'updated');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'guildQuotas.json'))).fixture.used, 4);
  child(`source.configureRetainedDataSourceRoot(process.argv[1]);
    assert.equal(require(path.join(project, 'src/utils/guildConfig')).getGuildConfig('fixture').welcomeChannelId, 'updated');
    assert.equal(require(path.join(project, 'src/services/quotaService')).getGuildQuota('fixture').used, 4);`, [old]);
});
