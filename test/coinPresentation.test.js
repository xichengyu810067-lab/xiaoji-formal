const test = require('node:test');
const assert = require('node:assert/strict');

const { formatMemberName, formatUser, isPrimaryPayrollVisibleTo } = require('../src/utils/coinPresentation');

test('formatUser uses guild/member display name and avoids user id', () => {
  assert.equal(formatUser({ displayName: '奶昔女王' }), '奶昔女王');
  assert.equal(formatUser({ globalName: 'global-小吉', username: 'ignored' }), 'global-小吉');
  assert.equal(formatUser({ username: '小吉' }), '小吉');
});

test('formatUser hides mention-like symbols and unknown input', () => {
  assert.equal(formatUser({ displayName: '[@evil]<user>' }), '[evil]user');
  assert.equal(formatUser({ id: '123456789' }), '未知使用者');
  assert.equal(formatUser(null), '未知使用者');
});

test('formatMemberName prefers the server display name, then the global name, then the account tag', () => {
  const user = { globalName: '全域名稱', tag: 'account#0001', username: 'account' };
  assert.equal(formatMemberName(user, { displayName: '伺服器暱稱' }), '伺服器暱稱');
  assert.equal(formatMemberName(user), '全域名稱');
  assert.equal(formatMemberName({ tag: 'account#0001', username: 'account' }), 'account#0001');
  assert.equal(formatMemberName({ username: '小吉' }), '小吉');
});

test('formatMemberName hides mention symbols and falls back to a fixed Chinese label for unknown input', () => {
  assert.equal(formatMemberName(null, { displayName: '[@evil]<user>' }), '[evil]user');
  assert.equal(formatMemberName({ id: '123456789' }), '未知使用者');
  assert.equal(formatMemberName(null, null), '未知使用者');
  assert.equal(formatMemberName(undefined), '未知使用者');
});

test('the pay of a primary job is shown to another member\'s viewer only when its cycle was started in the server asking', () => {
  const guild = '223456789012345678';
  assert.equal(isPrimaryPayrollVisibleTo({ sourceGuildId: guild, paidAmount: 5 }, guild), true);
  // Another server, or a pay that does not say where it comes from (null, undefined, empty): never shown, so an old or
  // odd row cannot leak (the table requires the column, so a real row always has it).
  for (const sourceGuildId of ['323456789012345678', null, undefined, '', 0]) {
    assert.equal(isPrimaryPayrollVisibleTo({ sourceGuildId, paidAmount: 5 }, guild), false, String(sourceGuildId));
  }
  assert.equal(isPrimaryPayrollVisibleTo({ paidAmount: 5 }, guild), false);
  assert.equal(isPrimaryPayrollVisibleTo(null, guild), false);
  assert.equal(isPrimaryPayrollVisibleTo(undefined, guild), false);
  // A viewer without a server never matches a pay without one.
  assert.equal(isPrimaryPayrollVisibleTo({ sourceGuildId: null }, null), false);
  assert.equal(isPrimaryPayrollVisibleTo({ sourceGuildId: undefined }, undefined), false);
});
