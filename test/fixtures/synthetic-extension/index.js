'use strict';

// A synthetic stand-in for a private extension, used only by test/extensionScopePins.test.js.
// It carries no real extension code and no real identifiers. It declares three command groups
// with different guild scopes, an interaction guard and hooks that record what the host passes
// them, so the contract in docs/EXTENSION_CONTRACT.md can be pinned without a private checkout.

const path = require('node:path');

// Synthetic guild IDs. A guild is "owned" when at least one command group declares it.
const GUILDS = Object.freeze({
  first: '710000000000000001', // owned by alpha
  second: '710000000000000002', // owned by alpha and beta
  third: '710000000000000003', // owned by beta and gamma
  fourth: '710000000000000004', // owned by gamma
  cleanup: '710000000000000005', // owned by no group; a cleanup target with leftover commands
  emptied: '710000000000000006', // owned by no group; a cleanup target with nothing left
  outsider: '710000000000000007', // declared nowhere
});

const COMMANDS_ROOT = path.join(__dirname, 'commands');

// Three command groups, each with its own directory, one command and one guild scope.
const GROUPS = Object.freeze([
  Object.freeze({
    id: 'synthetic:alpha',
    directory: path.join(COMMANDS_ROOT, 'alpha'),
    commandName: 'synthetic-alpha',
    guildIds: Object.freeze([GUILDS.first, GUILDS.second]),
  }),
  Object.freeze({
    id: 'synthetic:beta',
    directory: path.join(COMMANDS_ROOT, 'beta'),
    commandName: 'synthetic-beta',
    guildIds: Object.freeze([GUILDS.second, GUILDS.third]),
  }),
  Object.freeze({
    id: 'synthetic:gamma',
    directory: path.join(COMMANDS_ROOT, 'gamma'),
    commandName: 'synthetic-gamma',
    guildIds: Object.freeze([GUILDS.third, GUILDS.fourth]),
  }),
]);

// Every workRole hook the core calls.
const WORK_ROLE_HOOKS = Object.freeze([
  'syncJobRoleForMember',
  'syncPrimaryJobRoleForMember',
  'removeJobRoleForMember',
  'removeJobRolesForMember',
  'clearPrimaryJobRoleForMember',
  'syncAllJobRoles',
]);

// Builds an extension object in the shape docs/EXTENSION_CONTRACT.md describes.
//   record(name, payload)  called by the guard and by every hook with what the host passed
//   guard(context)         result of the interaction guard; null leaves the extension without one
//   hookResults            hook name ("workRole.syncAllJobRoles", "interactionCreate", ...) to a
//                          result, or to a function (payload) => result; unset returns undefined
//   groups                 command groups; a group without guildIds inherits deployment.guildIds
//   deployment             the extension-level deployment targets
function createSyntheticExtension({
  id = 'synthetic-scope-pins',
  record = () => {},
  guard = null,
  hookResults = {},
  groups = GROUPS,
  deployment = {},
} = {}) {
  const hook = (name) => async (payload) => {
    record(name, payload);
    const configured = hookResults[name];
    return typeof configured === 'function' ? configured(payload) : configured;
  };
  const workRole = {};
  for (const name of WORK_ROLE_HOOKS) workRole[name] = hook(`workRole.${name}`);
  const guards = guard
    ? { interaction: async (context) => { record('guards.interaction', context); return guard(context); } }
    : undefined;
  return {
    apiVersion: 1,
    id,
    commandDirectories: groups.map((group) => ({
      id: group.id,
      path: group.directory,
      ...(group.guildIds === undefined ? {} : { guildIds: [...group.guildIds] }),
    })),
    deployment: { ...deployment },
    ...(guards ? { guards } : {}),
    hooks: {
      interactionCreate: hook('interactionCreate'),
      publicCommandCompleted: hook('publicCommandCompleted'),
      workRole,
    },
  };
}

module.exports = { COMMANDS_ROOT, GROUPS, GUILDS, WORK_ROLE_HOOKS, createSyntheticExtension };
