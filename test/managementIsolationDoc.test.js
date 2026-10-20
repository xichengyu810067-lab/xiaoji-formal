'use strict';

// docs/MANAGEMENT_ISOLATION.md tells server administrators which bot permissions the public features need and what
// the permission integers are. The numbers are checked here against discord.js and against the code, so the document
// cannot drift from either:
//   - every permission in its table is a real Discord permission with the value written there;
//   - the three integers it gives are the sums of the permissions it says they are;
//   - the bot permissions that src/ checks (PermissionFlagsBits) are all in the table, and the table holds nothing the
//     code does not use but Attach Files (files are sent as attachments, which is not a permission check);
//   - none of the permissions it says are not needed is in any of the integers, and the document links are in place.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const ROOT = path.join(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'MANAGEMENT_ISOLATION.md'), 'utf8');

// The permissions of the user who runs a command (checked against the member, not the bot), and the one the bot only
// looks at to tell who invited it.
const USER_SIDE = new Set(['Administrator', 'ManageGuild']);
const OPTIONAL = new Set(['ViewAuditLog']);
const NOT_A_CHECK = new Set(['AttachFiles']);
const NOT_NEEDED = ['Administrator', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageGuild', 'ManageRoles', 'ManageMessages', 'ManageChannels'];

function nameOfBit(value) {
  const found = Object.entries(PermissionFlagsBits).filter(([, bit]) => bit === BigInt(value));
  assert.equal(found.length, 1, `${value} is one Discord permission`);
  return found[0][0];
}

// The rows of the table in the document: | English name（中文名） | value | use |
function tableRows() {
  return [...DOC.matchAll(/^\| ([A-Za-z ]+)（[^）]+） \| (\d+) \|/gmu)].map((match) => ({ label: match[1].trim(), value: match[2] }));
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'extensions' || entry.name === 'data' ? [] : sourceFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

test('the permission table names real Discord permissions with the values written next to them', () => {
  const rows = tableRows();
  assert.equal(rows.length, 8);
  for (const { label, value } of rows) {
    const name = nameOfBit(value);
    assert.equal(name.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase().replace(/ /gu, '').replace(/s$/u, ''),
      label.toLowerCase().replace(/ /gu, '').replace(/s$/u, ''), `${label} is permission ${name}`);
  }
});

test('the integers in the document are the sums of the permissions it lists', () => {
  const rows = tableRows().map((row) => nameOfBit(row.value));
  const sum = (names) => new PermissionsBitField(names.map((name) => PermissionFlagsBits[name])).bitfield.toString();
  const all = sum(rows);
  const basic = sum(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory']);
  const withReactions = sum(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions']);
  assert.deepEqual([all, basic, withReactions], ['309237763136', '117760', '117824']);
  for (const value of [all, basic, withReactions]) assert.ok(DOC.includes(`\`${value}\``), `the document gives ${value}`);
  assert.ok(DOC.includes(`permissions=${all}`), 'the invite example uses the full integer');
});

test('the table holds the bot permissions the code checks, and Attach Files besides', () => {
  const used = new Set();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/PermissionFlagsBits\.([A-Za-z]+)/gu)) used.add(match[1]);
  }
  const botChecks = [...used].filter((name) => !USER_SIDE.has(name) && !OPTIONAL.has(name)).sort();
  const listed = tableRows().map((row) => nameOfBit(row.value)).sort();
  assert.deepEqual(listed.filter((name) => !NOT_A_CHECK.has(name)), botChecks,
    'the table lists exactly the permissions the code checks for the bot (a new check has to be documented)');
  assert.deepEqual(listed.filter((name) => NOT_A_CHECK.has(name)), ['AttachFiles']);
  // The optional audit-log look-up is documented as not needed.
  assert.ok(used.has('ViewAuditLog'));
  assert.match(DOC, /View Audit Log/u);
});

test('no integer in the document grants a permission the document says is not needed', () => {
  const all = new PermissionsBitField(BigInt('309237763136'));
  for (const name of NOT_NEEDED) {
    assert.equal(all.has(PermissionFlagsBits[name]), false, `${name} is not in the integer`);
    const english = name === 'ManageGuild' ? 'Manage Server' : name.replace(/([a-z])([A-Z])/gu, '$1 $2');
    assert.ok(DOC.includes(english) || (name === 'BanMembers' && DOC.includes('Ban Members')), `the document names ${english} as not needed`);
  }
  assert.match(DOC, /不需要，也不建議授予/u);
});

test('the document is linked from the README and the user guide, and the public export lists it', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /\]\(docs\/MANAGEMENT_ISOLATION\.md\)/u);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'USER_GUIDE.md'), 'utf8'), /\]\(MANAGEMENT_ISOLATION\.md\)/u);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public-export', 'manifest.json'), 'utf8'));
  assert.ok(manifest.paths.includes('docs/MANAGEMENT_ISOLATION.md'));
  assert.ok(manifest.paths.includes('test/managementIsolationDoc.test.js'));
});
