'use strict';

// Discord hides a command from members who lack its default_member_permissions. The command catalog says who
// each command is for, so it also says which builders carry the field:
//   admin   - the lowest permission the command's own checks ask for (Manage Server or Administrator);
//   owner   - "0" for a whole owner-only command, so Discord shows it to Administrators only (the public core
//             ships none: they are private commands, whose permission is held by the private tests);
//   public  - nothing, so members keep seeing it.
// default_member_permissions does not apply in DMs, so an admin command is also kept out of DMs: otherwise anyone
// would see it in the DM command menu. The DM availability of the public commands is not part of this decision.
//
// Hiding is a convenience, not the guard. A server administrator can override it in the server settings, so the
// permission checks inside the commands stay. test/subcommandAccess.test.js runs those checks and proves that the
// permission used here is the lowest one they ask for. Where each command is deployed is covered by
// test/ownerGuildDeployment.test.js and, for the owner-only commands, the private tests. Nothing here talks to Discord.

const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const { deployCommands } = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');
const { loadCommandData } = require('../src/loadCommands');
const { COMMAND_CATALOG } = require('../website/commandCatalog');

const SYNTHETIC_CLIENT_ID = '123456789012345678';
const SYNTHETIC_OWNER_GUILD_ID = '223456789012345678';
// Discord writes a permission set as a decimal string of its bits: Manage Server is bit 5, Administrator bit 3.
const MANAGE_SERVER = '32';
const ADMINISTRATOR = '8';
// No permission at all: only Administrators see the command.
const NOBODY = '0';

// The decision for every admin command, from the permission its own check asks for.
const EXPECTED_DEFAULT_PERMISSIONS = Object.freeze({
  'set-welcome': MANAGE_SERVER,
  'word-chain': MANAGE_SERVER,
  'number-chain': MANAGE_SERVER,
  'release-announcements': ADMINISTRATOR,
  economy: ADMINISTRATOR,
  'coin-admin': ADMINISTRATOR,
  'daily-riddle': ADMINISTRATOR,
  'daily-discussion': ADMINISTRATOR,
});

const namesOf = (audience) => COMMAND_CATALOG.filter((entry) => entry.audience === audience).map((entry) => entry.name);
const hasDefaultPermissions = (command) => Object.hasOwn(command, 'default_member_permissions')
  && command.default_member_permissions !== undefined
  && command.default_member_permissions !== null;
// How Discord reads it: a context list decides when present (1 is the bot's DM), otherwise the deprecated flag does.
const BOT_DM_CONTEXT = 1;
const usableInDirectMessages = (command) => (Array.isArray(command.contexts)
  ? command.contexts.includes(BOT_DM_CONTEXT)
  : command.dm_permission !== false);

// Checks one list of command JSON against the catalog: every entry in `entries` must be there with the permission its
// audience calls for. `label` says what the list is.
function assertPermissions(commands, entries, label) {
  for (const entry of entries) {
    const command = commands.find((candidate) => candidate.name === entry.name);
    assert.ok(command, `/${entry.name} is in ${label}`);
    if (entry.audience === 'admin') {
      assert.equal(command.default_member_permissions, EXPECTED_DEFAULT_PERMISSIONS[entry.name], `/${entry.name} in ${label}`);
      assert.equal(usableInDirectMessages(command), false, `/${entry.name} in ${label} must not be usable in DMs`);
    } else if (entry.audience === 'owner') {
      assert.equal(command.default_member_permissions, NOBODY, `/${entry.name} in ${label} is shown to Administrators only`);
    } else {
      // Discord cannot hide a single subcommand, so a member command with admin or owner-only subcommands
      // (/shop, /work, /bank, /casino-venue) stays visible, and its own check refuses members.
      assert.equal(hasDefaultPermissions(command), false, `/${entry.name} in ${label} is open to members, so it must stay visible`);
    }
  }
}

test('the permission values are the Manage Server and Administrator bits, and zero', () => {
  assert.equal(String(PermissionFlagsBits.ManageGuild), MANAGE_SERVER);
  assert.equal(String(PermissionFlagsBits.Administrator), ADMINISTRATOR);
  assert.equal(NOBODY, '0');
});

test('every admin command carries its permission, every owner-only command carries 0 and no public command does', () => {
  const adminNames = namesOf('admin');
  // A new admin command has to be added to the table above, with the permission its own check asks for.
  assert.deepEqual([...adminNames].sort(), Object.keys(EXPECTED_DEFAULT_PERMISSIONS).sort());
  // The public core ships no whole owner-only command: they are private commands now.
  assert.deepEqual(namesOf('owner'), []);

  assertPermissions(loadCommandData(undefined, { scope: 'public' }), COMMAND_CATALOG, 'the builders');
});

test('a deployment dry run builds JSON that carries the permissions, and sends nothing to Discord', async () => {
  const calls = [];
  const rest = {
    async get(...args) { calls.push(['get', ...args]); return []; },
    async put(...args) { calls.push(['put', ...args]); return []; },
  };
  const result = await deployCommands({
    clientId: SYNTHETIC_CLIENT_ID,
    rest,
    dryRun: true,
    extensionHost: createExtensionHost([]),
    testControlPolicy: null,
    protectedGuildIds: null,
    ownerGuildId: SYNTHETIC_OWNER_GUILD_ID,
  });
  assert.deepEqual(calls, [], 'a dry run makes no Discord request');
  assert.equal(result.dryRun, true);

  // Discord receives the JSON text of this body: the global commands. Without a private extension nothing else
  // is deployed, the owner guild included: the public core has no command of its own for it.
  const global = result.plan.find((item) => item.kind === 'public-global');
  assert.ok(global, 'the plan has the global commands');
  assert.deepEqual(result.plan.map((item) => item.kind), ['public-global']);
  assert.equal(result.plan.some((item) => item.guildId === SYNTHETIC_OWNER_GUILD_ID), false);
  const sentGlobal = JSON.parse(JSON.stringify(global.body));

  assert.deepEqual(sentGlobal.map((command) => command.name).sort(), COMMAND_CATALOG.map((entry) => entry.name).sort());
  assertPermissions(sentGlobal, COMMAND_CATALOG, 'the global body');
});
