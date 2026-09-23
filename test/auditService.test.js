const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auditTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-audit-test-'));
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(auditTestDir, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(auditTestDir, 'inviterWhitelist.json');

const { 
  AuditStatus, 
  getAuditDataPath,
  getWhitelistDataPath,
  isGuildApproved, 
  setGuildAudit, 
  isWhitelisted, 
  addToWhitelist, 
  removeFromWhitelist 
} = require('../src/services/auditService');

test.after(() => {
  fs.rmSync(auditTestDir, { recursive: true, force: true });
  delete process.env.XIAOJI_AUDIT_DATA_PATH;
  delete process.env.XIAOJI_INVITER_WHITELIST_PATH;
});

test('audit service uses isolated test data paths', () => {
  assert.equal(getAuditDataPath(), path.join(auditTestDir, 'guildAudit.json'));
  assert.equal(getWhitelistDataPath(), path.join(auditTestDir, 'inviterWhitelist.json'));
});

test('isGuildApproved returns true only for approved status', () => {
  const guildId = 'test-guild-123';
  
  setGuildAudit(guildId, { status: AuditStatus.APPROVED, name: 'Test Guild' });
  assert.equal(isGuildApproved(guildId), true);
  
  setGuildAudit(guildId, { status: AuditStatus.PENDING });
  assert.equal(isGuildApproved(guildId), false);
  
  setGuildAudit(guildId, { status: AuditStatus.DENIED });
  assert.equal(isGuildApproved(guildId), false);

  const stored = JSON.parse(fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, 'utf8'));
  assert.equal(stored[guildId].status, AuditStatus.DENIED);
});

test('whitelist management adds and removes users', () => {
  const userId = 'test-user-456';
  
  // Clean start
  removeFromWhitelist(userId);
  assert.equal(isWhitelisted(userId), false);
  
  // Add
  const added = addToWhitelist(userId, 'owner-789');
  assert.equal(added, true);
  assert.equal(isWhitelisted(userId), true);
  
  // Duplicate add
  const addedAgain = addToWhitelist(userId, 'owner-789');
  assert.equal(addedAgain, false);
  
  // Remove
  const removed = removeFromWhitelist(userId);
  assert.equal(removed, true);
  assert.equal(isWhitelisted(userId), false);
  
  // Remove non-existent
  const removedAgain = removeFromWhitelist(userId);
  assert.equal(removedAgain, false);
});
