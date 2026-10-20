'use strict';

// "輸入 /name 指令…" in an AI reply is the public command list only for a command 小吉 offers to everybody. The commands a
// loaded extension owns are not public, so the reply check must not read them that way, without the public code writing their
// names: the host tells the policy what the extension owns when the bot starts (registerNonPublicCommandNames, called from
// src/index.js with host.ownedCommandNames()), and with no extension nothing changes.
//
// This file uses a synthetic command name. The real names of the private extension are held in the private suite.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-extension-names-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  INTERNAL_REPLY,
  decideAssistantOutput,
  decideRequestIngress,
  finalizePublicAssistantText,
  getConversationDecisionPayload,
  registerNonPublicCommandNames,
} = require('../src/systems/conversation/disclosurePolicy');
const { createExtensionHost } = require('../src/extensions/extensionHost');

// The way chatFlow checks a reply: the final text check, then the output decision. Refused when either refuses.
function refused(text) {
  if (finalizePublicAssistantText(text) === INTERNAL_REPLY) return true;
  const ingressDecision = decideRequestIngress({ userText: '你好' });
  return getConversationDecisionPayload(decideAssistantOutput({
    ingressDecision, rawCandidate: text, styledCandidate: text, source: 'provider', historyAllowed: true,
  })).kind === 'refusal';
}

const reply = (name) => `我是小吉！輸入 /${name} 指令可以做事喔`;

test.afterEach(() => registerNonPublicCommandNames([]));

test('without an extension the list is as it was: a removed command and the known private name are refused, an unknown name is not', () => {
  assert.equal(refused(reply('music')), true);
  assert.equal(refused(reply('quota-set')), true);
  assert.equal(refused(reply('synthetic-tool')), false);
  assert.equal(refused(reply('help')), false);
});

test('the names an extension owns are refused after they are registered, and only those', () => {
  registerNonPublicCommandNames(['synthetic-tool', 'synthetic_other']);
  assert.equal(refused(reply('synthetic-tool')), true);
  assert.equal(refused(reply('synthetic_other')), true);
  assert.equal(refused(reply('synthetic-tool-two')), false, 'a longer name is another name');
  assert.equal(refused(reply('help')), false, 'a public command is still the public list');
  assert.equal(refused(reply('music')), true);
  assert.equal(refused(reply('quota-set')), true);
});

test('registering replaces the earlier names, an empty list or nothing goes back to the plain list, and bad names are ignored', () => {
  registerNonPublicCommandNames(['synthetic-tool']);
  registerNonPublicCommandNames(['synthetic-else']);
  assert.equal(refused(reply('synthetic-tool')), false);
  assert.equal(refused(reply('synthetic-else')), true);
  registerNonPublicCommandNames();
  assert.equal(refused(reply('synthetic-else')), false);
  registerNonPublicCommandNames(['Bad Name', '', 5, null, undefined, '../x', 'a'.repeat(40), '(a|b)', '.*']);
  for (const name of ['help', 'synthetic-tool', 'a', 'b']) assert.equal(refused(reply(name)), false, `/${name}`);
  registerNonPublicCommandNames('synthetic-tool');
  assert.equal(refused(reply('synthetic-tool')), false, 'a string is not a list');
});

test('the host tells which commands its extensions own, and nothing without an extension', () => {
  assert.deepEqual([...createExtensionHost().ownedCommandNames()], []);
  const host = createExtensionHost([{ id: 'one', commandNames: ['synthetic-tool', 'synthetic-tool', 'synthetic-else'] }, { id: 'two', commandNames: ['third'] }]);
  assert.deepEqual([...host.ownedCommandNames()], ['synthetic-tool', 'synthetic-else', 'third']);
  assert.equal(Object.isFrozen(host.ownedCommandNames()), true);
  for (const name of host.ownedCommandNames()) assert.equal(host.ownsCommand(name), true);
});

test('src/index.js registers what the loaded extension owns, right after the host is chosen and before anything is checked', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const chosen = source.indexOf('const extensionHost = selectExtensionHost(');
  const call = source.indexOf('registerNonPublicCommandNames(extensionHost.ownedCommandNames());');
  const used = source.indexOf('client.extensionHost = extensionHost;');
  assert.ok(chosen > 0 && call > chosen && used > call, 'the call sits between choosing the host and giving it to the client');
  assert.match(source, /const \{ registerNonPublicCommandNames \} = require\('\.\/systems\/conversation\/disclosurePolicy'\);/u);
});
