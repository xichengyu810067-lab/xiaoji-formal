const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ai-command-list-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  INTERNAL_REPLY,
  PUBLIC_COMMAND_LIST_PREFIX,
  buildPublicCommandListLine,
  decideAssistantOutput,
  decideRequestIngress,
  finalizePublicAssistantText,
  getConversationDecisionPayload,
  listPublicCommandNames,
} = require('../src/systems/conversation/disclosurePolicy');
const { developerInstructions, getProtectedPromptTexts } = require('../src/systems/conversation/provider');
const { listPublicFactIds, resolvePublicFactId } = require('../src/systems/conversation/publicFacts');
const { buildHelpSections } = require('../src/commands/help');
const commandCatalog = require('../website/commandCatalog');

const ADMIN_PART = 'Commands that need a server permission (Manage Server or Administrator):';
const GAME_NOTE = 'All new games start from /board start.';

// Slash commands named in a text, without duplicates, in order ("/board start" names /board).
const namedCommands = (text) => [...new Set([...String(text).matchAll(/(?<![\w.:/])\/([a-z][\w-]*)/gi)].map((match) => match[1]))];
const promptCommandLine = () => {
  const lines = developerInstructions.split('\n').filter((line) => line.startsWith(PUBLIC_COMMAND_LIST_PREFIX));
  assert.equal(lines.length, 1, 'the system prompt has exactly one public command list line');
  return lines[0];
};
// The member and admin parts of a command list line ("" when a part is absent).
function splitLine(line) {
  assert.ok(line.startsWith(PUBLIC_COMMAND_LIST_PREFIX));
  const rest = line.slice(PUBLIC_COMMAND_LIST_PREFIX.length);
  const adminAt = rest.indexOf(ADMIN_PART);
  const member = adminAt < 0 ? rest : rest.slice(0, adminAt);
  const admin = adminAt < 0 ? '' : rest.slice(adminAt + ADMIN_PART.length);
  return { member: member.replace(GAME_NOTE, ''), admin: admin.replace(GAME_NOTE, '') };
}
// Written out here rather than taken from listPublicCommandNames, so the test does not check the code with itself.
const catalogNames = (catalog, audience) => catalog.COMMAND_CATALOG
  .filter((command) => command.listInHelp === true && command.audience === audience)
  .map((command) => command.name);

// A stand-in catalog with the shape of website/commandCatalog.js.
function stubCatalog(changes = {}) {
  const { add = [], remove = [] } = changes;
  const entries = commandCatalog.COMMAND_CATALOG
    .filter((command) => !remove.includes(command.name))
    .map((command) => ({ ...command, subcommands: [...command.subcommands] }));
  for (const [name, audience, subcommands = [], listInHelp = audience !== 'owner'] of add) {
    entries.push({ name, description: `${name} 測試指令`, group: 'general', audience, listInHelp, subcommands, subcommandAudiences: {} });
  }
  return { COMMAND_CATALOG: entries, REMOVED_COMMANDS: [...commandCatalog.REMOVED_COMMANDS] };
}

test('the system prompt lists the member and the admin commands of the catalog apart, as /help does', () => {
  const line = promptCommandLine();
  assert.equal(line, buildPublicCommandListLine(), 'provider builds the line from the catalog');
  assert.ok(!line.includes('\n'));
  const members = catalogNames(commandCatalog, 'public');
  const admins = catalogNames(commandCatalog, 'admin');
  assert.ok(members.length >= 20 && admins.length >= 5);
  const parts = splitLine(line);
  assert.deepEqual(namedCommands(parts.member), members, 'member commands in catalog order');
  assert.deepEqual(namedCommands(parts.admin), admins, 'commands that need a server permission in catalog order');
  assert.deepEqual(listPublicCommandNames(undefined, 'public'), members);
  assert.deepEqual(listPublicCommandNames(undefined, 'admin'), admins);
  // Together they are what /help shows to members and admins, and the admin marks match /help's.
  const helpEntries = buildHelpSections().flatMap((section) => section.entries);
  assert.deepEqual([...new Set(helpEntries.map((entry) => entry.name))].sort(), [...members, ...admins].sort());
  for (const name of admins) {
    assert.ok(helpEntries.filter((entry) => entry.name === name).every((entry) => entry.audience === 'admin'), `/${name}`);
  }
  const list = String.raw`\/[a-z-]+(?:, \/[a-z-]+)*,? (?:and )?\/[a-z-]+`;
  assert.match(line, new RegExp(String.raw`^小吉 supports these public slash commands: ${list}\. Commands that need a server permission \(Manage Server or Administrator\): ${list}\. All new games start from \/board start\.$`));
});

test('the command list line is delivered when it is repeated as it is', () => {
  const line = promptCommandLine();
  assert.notEqual(finalizePublicAssistantText(line), INTERNAL_REPLY);
  for (const userText of ['你好', 'What can you do?']) {
    const payload = getConversationDecisionPayload(decideAssistantOutput({
      ingressDecision: decideRequestIngress({ userText }), rawCandidate: line, styledCandidate: line, source: 'provider',
      historyAllowed: true, protectedInstructions: getProtectedPromptTexts('cute', false),
    }));
    assert.equal(payload.kind, 'allowed', userText);
  }
});

test('removed, owner-only and private commands are never listed', () => {
  const listed = namedCommands(promptCommandLine().slice(PUBLIC_COMMAND_LIST_PREFIX.length));
  for (const name of ['buy', 'quota-list', 'quota-reset', 'quota-set', 'music']) assert.ok(!listed.includes(name), name);
  assert.ok(!promptCommandLine().includes('/economy leaderboard'));
  for (const name of commandCatalog.REMOVED_COMMANDS.filter((entry) => !entry.includes(' '))) {
    assert.ok(!listed.includes(name), `removed /${name}`);
  }
  const ownerOnly = commandCatalog.COMMAND_CATALOG.filter((command) => command.audience === 'owner').map((command) => command.name);
  // The public core ships no whole owner command (they are private now), so the list is empty today; the loop
  // keeps the guard for any owner-only entry a later change adds to the catalog.
  for (const name of ownerOnly) assert.ok(!listed.includes(name), `owner-only /${name}`);
  // Every listed command exists in the catalog; private extensions such as /music never do.
  for (const name of listed) assert.ok(commandCatalog.getCommand(name), `/${name} is in the catalog`);
});

test('both parts follow the catalog when commands are added or removed (stub catalog)', () => {
  const members = catalogNames(commandCatalog, 'public');
  const admins = catalogNames(commandCatalog, 'admin');

  const added = splitLine(buildPublicCommandListLine(stubCatalog({ add: [['karaoke', 'public'], ['setup-karaoke', 'admin']] })));
  assert.deepEqual(namedCommands(added.member), [...members, 'karaoke']);
  assert.deepEqual(namedCommands(added.admin), [...admins, 'setup-karaoke']);

  const removedLine = buildPublicCommandListLine(stubCatalog({ remove: ['weather', 'daily-discussion'] }));
  const removed = splitLine(removedLine);
  assert.deepEqual(namedCommands(removed.member), members.filter((name) => name !== 'weather'));
  assert.deepEqual(namedCommands(removed.admin), admins.filter((name) => name !== 'daily-discussion'));
  assert.ok(removedLine.endsWith(`, and /daily-riddle. ${GAME_NOTE}`));

  // Owner-only, hidden from help, and tombstoned names stay out even if a catalog lists them.
  const hidden = stubCatalog({ add: [['owner-tool', 'owner'], ['secret-public', 'public', [], false], ['buy', 'public']] });
  assert.equal(buildPublicCommandListLine(hidden), buildPublicCommandListLine());

  // Without admin commands there is no admin part; without /board start there is no game note.
  const noAdmin = buildPublicCommandListLine(stubCatalog({ remove: admins }));
  assert.ok(!noAdmin.includes(ADMIN_PART));
  assert.deepEqual(namedCommands(splitLine(noAdmin).member), members);
  const noBoard = buildPublicCommandListLine(stubCatalog({ remove: ['board'] }));
  assert.ok(!noBoard.includes('/board') && !noBoard.includes(GAME_NOTE));
  assert.ok(noBoard.endsWith('/daily-discussion.'));
});

test('every slash command the system prompt and the public facts name is public', () => {
  const publicNames = new Set(listPublicCommandNames());
  for (const name of namedCommands(developerInstructions)) assert.ok(publicNames.has(name), `prompt names /${name}`);
  for (const id of listPublicFactIds()) {
    for (const name of namedCommands(resolvePublicFactId(id).text)) assert.ok(publicNames.has(name), `${id} names /${name}`);
  }
  // feature.commands points to /help, which lists the same commands as the system prompt.
  assert.deepEqual(namedCommands(resolvePublicFactId('feature.commands').text), ['help']);
});
