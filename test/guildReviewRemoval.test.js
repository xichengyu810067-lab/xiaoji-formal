'use strict';

// Guilds are no longer reviewed. These tests pin what that means for the code that is left: the audit service only
// reads what earlier versions recorded (and a recorded status decides nothing), nothing in the public core can ask
// Discord to leave a guild on its own, the event modules carry no review step, and no source file names the review
// state as a reason to hold a guild back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-guild-review-removal-');
const AUDIT_PATH = path.join(root, 'guildAudit.json');
const WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.XIAOJI_AUDIT_DATA_PATH = AUDIT_PATH;
process.env.XIAOJI_INVITER_WHITELIST_PATH = WHITELIST_PATH;

const auditService = require('../src/services/auditService');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const adapter = require('../src/platform/publicEffectAdapter');

const SRC = path.join(__dirname, '..', 'src');
const RECORDS = Object.freeze({
  '10000000000000801': { guildId: '10000000000000801', name: '核准', status: 'approved', manualAudit: false },
  '10000000000000802': { guildId: '10000000000000802', name: '拒絕', status: 'denied', reason: 'Audit timeout (24h)' },
  '10000000000000803': { guildId: '10000000000000803', name: '未知', status: 'unknown', manualAudit: true },
  '10000000000000804': { guildId: '10000000000000804', name: '待審', status: 'pending' },
});

test.after(() => {
  removeRealTempDir(root);
});

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return entry.name.endsWith('.js') ? [filePath] : [];
  });
}

function relative(filePath) {
  return path.relative(path.join(__dirname, '..'), filePath).replaceAll('\\', '/');
}

test('the audit service only reads: what earlier versions recorded stays as it was, whatever the status says', () => {
  const text = `${JSON.stringify(RECORDS, null, 2)}\n`;
  fs.writeFileSync(AUDIT_PATH, text);
  fs.writeFileSync(WHITELIST_PATH, '[]\n');

  for (const [guildId, record] of Object.entries(RECORDS)) {
    assert.deepEqual(auditService.getGuildAudit(guildId), record, guildId);
  }
  assert.equal(auditService.getGuildAudit('10000000000000899'), null);
  assert.deepEqual(auditService.getWhitelist(), []);
  assert.equal(auditService.getAuditDataPath(), AUDIT_PATH);
  assert.equal(fs.readFileSync(AUDIT_PATH, 'utf8'), text);

  // What it exports is the read side and the whitelist helpers the private commands still use: no way to
  // approve, deny, record a join, sync, check a status, or leave.
  assert.deepEqual(Object.keys(auditService).sort(), [
    'AuditStatus', 'addToWhitelist', 'getAuditDataPath', 'getGuildAudit', 'getWhitelist', 'getWhitelistDataPath',
    'isWhitelisted', 'removeFromWhitelist',
  ]);
  assert.deepEqual({ ...auditService.AuditStatus },
    { APPROVED: 'approved', PENDING: 'pending', DENIED: 'denied', UNKNOWN: 'unknown' });
});

test('the grant issuer and the effect adapter have no way to authorize a guild leave', () => {
  assert.deepEqual(Object.keys(createPublicEffectAuthority().createIssuer()).sort(),
    ['issueChainReaction', 'issuePenalty', 'issueStoredChainReaction', 'issueWorkReminder']);
  assert.equal(Object.hasOwn(adapter, 'issueAuditLeaveGrant'), false);
});

test('no source file builds a request that leaves a guild, or schedules a review of one', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    const name = relative(file);
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gmu, '');
    if (/userGuild\s*\(|users\/@me\/guilds\/|\bguild\.leave\s*\(|guilds\.leave\s*\(/u.test(text)) offenders.push(`${name}: leave`);
    if (/checkAndAutoLeave|syncExistingGuilds|recordTrustedGuildJoin|isGuildApproved|setGuildAudit|GUILD_NOT_APPROVED/u.test(text)) {
      offenders.push(`${name}: review`);
    }
  }
  // The test-control egress only names the route to classify it; it builds nothing.
  assert.deepEqual(offenders.filter((offender) => !offender.startsWith('src/platform/testControlEgress.js')), []);
});

test('the event modules carry no review step: ready starts nothing about guilds, and the join only tells the Owner', () => {
  const ready = require('../src/events/ready');
  assert.deepEqual(Object.keys(ready).sort(), ['execute', 'name', 'once']);
  assert.equal(ready.execute.length, 1, 'ready takes the client alone, with no guild-join grants');
  for (const file of ['ready', 'guildCreate', 'guildMemberAdd', 'messageCreate', 'interactionCreate']) {
    const text = fs.readFileSync(path.join(SRC, 'events', `${file}.js`), 'utf8');
    assert.equal(/auditService|isGuildApproved|AuditStatus|recordTrustedGuildJoin/u.test(text), false, file);
  }
  assert.equal(fs.existsSync(path.join(SRC, 'platform', 'unapprovedGuildReplyCooldown.js')), false);
});
