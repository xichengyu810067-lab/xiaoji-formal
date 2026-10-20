if (process.env.XIAOJI_RUNTIME_MODE !== 'test-control') require('dotenv').config({ quiet: true });

const { REST, Routes } = require('discord.js');
const defaultCommandCatalog = require('./website/commandCatalog');
const {
  assertNoPublicPrivateCommandCollisions,
  assertPublicCommandCatalog,
  loadCommandData,
  loadPrivateCommandGroups,
} = require('./src/loadCommands');
const { loadPrivateExtensionHost } = require('./src/extensions/extensionHost');
const {
  DIGEST_PATTERN,
  PROTECTED_GUILDS_ENV,
  SNOWFLAKE_PATTERN,
  computeRegistryDiff,
  createSafeWriter,
  describeCause,
  formatRegistryItem,
  formatRegistryReport,
  listJoinedGuildIds,
  parseProtectedGuildIds,
  readRegisteredCommands,
  scopeLabel,
  selectCleanupTargets,
  selectProtectedExtras,
} = require('./src/platform/commandRegistryAudit');
const { getDiscordClientId, getDiscordToken, requireEnvValue } = require('./src/utils/env');
const { loadTestControlPolicy, preflightTestIdentity } = require('./src/platform/testControlPolicy');

const AUDIT_PREFIX = '[COMMAND_AUDIT]';
const CLEANUP_PREFIX = '[COMMAND_CLEANUP]';
const READBACK_PREFIX = '[COMMAND_READBACK]';
const OWNER_PREFIX = '[OWNER_COMMANDS]';
// One Discord guild ID (not a secret): the only place a whole owner-only command is deployed.
const OWNER_GUILD_ENV = 'XIAOJI_OWNER_GUILD_ID';
const USAGE = [
  'Usage: node deploy-commands.js [--public-only|--test-control]',
  '       node deploy-commands.js --audit [--all-guilds] [--public-only|--test-control]',
  '       node deploy-commands.js --cleanup <digest> [--yes] [--all-guilds] [--public-only|--test-control]',
].join('\n');
const REGISTRY_FLAGS = new Set(['--all-guilds', '--yes', '--public-only', '--test-control']);
const SCOPE_KIND_BY_PLAN_KIND = Object.freeze({
  'public-global': 'public-global',
  'private-guild': 'private-guild',
  'owner-guild': 'owner-guild',
  'legacy-cleanup': 'cleanup-guild',
  'test-guild': 'test-guild',
});
const CLEANUP_EXIT_CODES = Object.freeze({
  'digest-mismatch': 1,
  'nothing-to-delete': 0,
  'dry-run': 0,
  deleted: 0,
  incomplete: 1,
});

function defaultReport(line) {
  console.log(line);
}

function shouldAutoDeployCommands(env = process.env) {
  if (env.XIAOJI_RUNTIME_MODE === 'test-control') return false;
  return String(env.AUTO_DEPLOY_COMMANDS || '').trim().toLowerCase() === 'true';
}

function usageError(detail) {
  const error = new Error(detail ? `${detail}\n${USAGE}` : USAGE);
  error.code = 'DEPLOY_USAGE';
  return error;
}

// --audit and --cleanup forms. Unknown values are never echoed back, in case a secret was
// pasted into the command line by mistake.
function parseRegistryArgs(args) {
  const seen = new Set();
  let action = null;
  let expectedDigest = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const known = arg === '--audit' || arg === '--cleanup' || REGISTRY_FLAGS.has(arg);
    if (!known) throw usageError('Unknown option.');
    if (seen.has(arg)) throw usageError(`${arg} is given more than once.`);
    seen.add(arg);
    if (arg !== '--audit' && arg !== '--cleanup') continue;
    if (action) throw usageError('Choose only one of --audit or --cleanup.');
    action = arg.slice(2);
    if (action === 'cleanup') {
      const value = String(args[index + 1] || '').toLowerCase();
      if (!DIGEST_PATTERN.test(value)) throw usageError('--cleanup needs the 64-character digest printed by --audit.');
      expectedDigest = value;
      index += 1;
    }
  }
  if (!action) throw usageError();
  const publicOnly = seen.has('--public-only');
  const testControl = seen.has('--test-control');
  const allGuilds = seen.has('--all-guilds');
  const confirm = seen.has('--yes');
  if (publicOnly && testControl) throw usageError('--public-only and --test-control cannot be combined.');
  if (allGuilds && (publicOnly || testControl)) {
    throw usageError('--all-guilds cannot be combined with --public-only or --test-control.');
  }
  if (confirm && action !== 'cleanup') throw usageError('--yes is only valid with --cleanup.');
  if (action === 'audit') return { action, publicOnly, testControl, allGuilds };
  return { action, publicOnly, testControl, allGuilds, expectedDigest, confirm };
}

function parseDeploymentArgs(args = []) {
  if (args.length === 0) return { publicOnly: false };
  if (args.length === 1 && args[0] === '--public-only') return { publicOnly: true };
  if (args.length === 1 && args[0] === '--test-control') return { publicOnly: false, testControl: true };
  return parseRegistryArgs(args);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// ---- Owner-only commands -----------------------------------------------------------------------

// Reads XIAOJI_OWNER_GUILD_ID. Blank is "unset"; anything that is not exactly one Discord guild ID is
// "invalid". The value is never echoed, in case a secret was pasted into it.
function parseOwnerGuildId(value) {
  if (value === undefined || value === null) return Object.freeze({ state: 'unset', guildId: null });
  if (typeof value !== 'string') return Object.freeze({ state: 'invalid', guildId: null });
  const text = value.trim();
  if (text === '') return Object.freeze({ state: 'unset', guildId: null });
  return SNOWFLAKE_PATTERN.test(text)
    ? Object.freeze({ state: 'valid', guildId: text })
    : Object.freeze({ state: 'invalid', guildId: null });
}

// The catalog decides who a command is for. A whole command whose audience is "owner" is never one of the
// global commands: it can only go to the owner guild.
function splitPublicCommands(publicCommands, commandCatalog) {
  const catalog = commandCatalog || defaultCommandCatalog;
  const ownerNames = new Set(catalog.COMMAND_CATALOG
    .filter((entry) => entry.audience === 'owner')
    .map((entry) => entry.name));
  return Object.freeze({
    globalCommands: publicCommands.filter((command) => !ownerNames.has(command.name)),
    ownerCommands: publicCommands.filter((command) => ownerNames.has(command.name)),
  });
}

// What a run does with the owner-only commands. They go to the owner guild or nowhere, never to the global
// commands: an unset or malformed XIAOJI_OWNER_GUILD_ID, and --public-only (which never touches guild routes),
// both leave them undeployed and say so. The notice never echoes the value.
function planOwnerCommands({ ownerGuildId, ownerCommands, publicOnly }) {
  if (ownerCommands.length === 0) return Object.freeze({ status: 'none', guildId: null, commands: [], notice: null });
  const subject = `the ${ownerCommands.length} owner-only commands (${ownerCommands.map((command) => `/${command.name}`).join(', ')})`;
  if (publicOnly) {
    return Object.freeze({
      status: 'public-only',
      guildId: null,
      commands: [],
      notice: `${OWNER_PREFIX} notice: --public-only never touches guild routes, so ${subject} were not deployed. `
        + `Deploy without --public-only to send them to the owner guild (${OWNER_GUILD_ENV}).`,
    });
  }
  const parsed = parseOwnerGuildId(ownerGuildId);
  if (parsed.state === 'valid') {
    return Object.freeze({ status: 'guild', guildId: parsed.guildId, commands: ownerCommands, notice: null });
  }
  const reason = parsed.state === 'unset'
    ? `${OWNER_GUILD_ENV} is not set`
    : `${OWNER_GUILD_ENV} is not a Discord guild ID (one number of 16 to 22 digits)`;
  return Object.freeze({
    status: parsed.state,
    guildId: null,
    commands: [],
    notice: `${OWNER_PREFIX} warning: ${reason}, so ${subject} are not deployed anywhere. `
      + `They are never deployed globally; set ${OWNER_GUILD_ENV} to the owner guild ID to deploy them there.`,
  });
}

// publicCommands are the global commands (the owner-only ones are passed apart as ownerCommands). One request
// replaces a guild's whole command list, so the owner guild gets its private commands and the owner commands
// in the same operation; two requests would overwrite each other.
function buildDeploymentPlan({
  clientId,
  publicCommands,
  privateCommands = [],
  privateCommandGroups = [],
  deploymentTargets,
  cleanupGuildIds = [],
  ownerGuildId = null,
  ownerCommands = [],
}) {
  const groups = privateCommandGroups.length > 0
    ? privateCommandGroups
    : [{
        commandGroupId: 'legacy-private',
        guildIds: unique(deploymentTargets.flatMap((target) => target.guildIds)),
        commands: privateCommands,
      }];
  const commandsByGuild = new Map();
  for (const group of groups) {
    for (const guildId of unique(group.guildIds)) {
      if (!commandsByGuild.has(guildId)) commandsByGuild.set(guildId, new Map());
      const guildCommands = commandsByGuild.get(guildId);
      for (const command of group.commands || []) {
        if (guildCommands.has(command.name)) {
          throw new Error(`Multiple private command groups register /${command.name} in guild ${guildId}.`);
        }
        guildCommands.set(command.name, command);
      }
    }
  }
  // The guilds a private command group or deployment target declares, with the private commands each carries.
  const privateCommandCounts = new Map([...commandsByGuild].map(([guildId, commands]) => [guildId, commands.size]));
  const ownerGuildCommands = ownerGuildId && ownerCommands.length > 0 ? ownerCommands : [];
  if (ownerGuildCommands.length > 0) {
    const guildCommands = commandsByGuild.get(ownerGuildId) || new Map();
    const clashing = ownerGuildCommands.filter((command) => guildCommands.has(command.name))
      .map((command) => `/${command.name}`);
    // deployCommands and prepareCommandRegistry already refuse any private command that shares a name with a
    // public one (assertNoPublicPrivateCommandCollisions) before they get here, so this guard only fires when
    // buildDeploymentPlan is called directly. It stays as the last line of defense for the one-request merge.
    if (clashing.length > 0) {
      const error = new Error(`Owner commands collide with private commands in guild ${ownerGuildId}: ${clashing.join(', ')}. `
        + 'Nothing was deployed; rename the private commands.');
      error.code = 'COMMAND_OWNER_GUILD_COLLISION';
      throw error;
    }
    for (const command of ownerGuildCommands) guildCommands.set(command.name, command);
    commandsByGuild.set(ownerGuildId, guildCommands);
  }
  const allowedGuildIds = [...commandsByGuild.keys()];
  const cleanupRequests = unique([
    ...cleanupGuildIds,
    ...deploymentTargets.flatMap((target) => target.cleanupGuildIds),
  ]);
  // A guild that a private group declares is never cleared, even when it is listed for cleanup. An owner guild
  // that no group declares would be cleared by the legacy cleanup, which reads before it clears and needs the
  // protected list; the owner commands would replace that cleanup without any of those checks. The two
  // instructions contradict each other, so the plan refuses them instead of picking one.
  if (ownerGuildCommands.length > 0 && !privateCommandCounts.has(ownerGuildId) && cleanupRequests.includes(ownerGuildId)) {
    const error = new Error(`Owner guild ${ownerGuildId} is also listed for legacy cleanup (deployment.cleanupGuildIds). `
      + 'A cleanup clears the commands of a guild, while the owner guild is where the owner commands go, so both cannot apply. '
      + `Remove the guild from deployment.cleanupGuildIds, or unset ${OWNER_GUILD_ENV}. Nothing was deployed.`);
    error.code = 'COMMAND_OWNER_GUILD_CLEANUP_CONFLICT';
    throw error;
  }
  const requestedCleanup = cleanupRequests.filter((guildId) => !allowedGuildIds.includes(guildId));

  return [
    { kind: 'public-global', route: Routes.applicationCommands(clientId), body: publicCommands },
    // A guild that a private group or target declares stays a private guild when owner commands are added to it.
    ...allowedGuildIds.map((guildId) => ({
      kind: privateCommandCounts.has(guildId) ? 'private-guild' : 'owner-guild',
      guildId,
      route: Routes.applicationGuildCommands(clientId, guildId),
      body: [...commandsByGuild.get(guildId).values()],
      privateCommandCount: privateCommandCounts.get(guildId) ?? 0,
      includesOwnerCommands: ownerGuildCommands.length > 0 && guildId === ownerGuildId,
    })),
    ...requestedCleanup.map((guildId) => ({
      kind: 'legacy-cleanup',
      guildId,
      route: Routes.applicationGuildCommands(clientId, guildId),
      body: [],
      requiresReadback: true,
    })),
  ];
}

function buildTestDeploymentPlan({ policy, publicCommands }) {
  if (!policy || policy.allowedGuildIds.size === 0) throw new Error('Test-control deployment requires trusted guild targets.');
  const commands = publicCommands.filter((command) => policy.allowsCommand(command.name));
  if (commands.length === 0) throw new Error('Test-control deployment requires at least one allowed public command.');
  return [...policy.allowedGuildIds].map((guildId) => ({
    kind: 'test-guild',
    guildId,
    route: Routes.applicationGuildCommands(policy.expectedApplicationId, guildId),
    body: commands,
  }));
}

function assertCleanupReadback(commands, clientId, guildId) {
  if (!Array.isArray(commands)) {
    throw new Error(`Legacy cleanup readback is invalid for guild ${guildId}.`);
  }
  for (const command of commands) {
    if (String(command?.application_id || '') !== String(clientId)) {
      throw new Error(`Legacy cleanup readback does not belong to this bot in guild ${guildId}.`);
    }
  }
  return commands;
}

const commandKeyOf = (command) => `${Number(command?.type ?? 1)}:${String(command?.name ?? '')}`;

// Names only, never an ID, and nothing but plain characters from Discord's answer.
function describeHeldCommand(command) {
  const name = String(command?.name ?? '').replace(/[^\p{L}\p{N}\p{M}_' -]/gu, '?').slice(0, 100);
  return Number(command?.type ?? 1) === 1 ? `/${name}` : `${name} (type ${Number(command.type)})`;
}

function ownerGuildRefusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// One request replaces a guild's whole command list. When no private command group declares the owner guild (for
// example the private extension is not loaded in this run), sending only the owner commands there would delete
// every other command the bot holds in it, such as private moderation commands. They would come back with new
// IDs, and the permission overrides that administrators set on them would be gone for good: the bot token cannot
// restore those. So the guild is read before the first request of the deployment, the global one included, and
// the deployment stops if Discord holds a command that the plan does not carry, or if the guild cannot be read at
// all (a wrong ID, or the bot is not in the guild). A guild that a private group declares is not read: a private
// guild keeps its own semantics, where the plan replaces the list and a removal is the extension's decision.
async function assertOwnerGuildHoldsOnlyPlannedCommands({ rest, operation, clientId }) {
  const label = scopeLabel(operation.guildId);
  let held;
  try {
    held = await readRegisteredCommands({
      rest, route: operation.route, applicationId: clientId, guildId: operation.guildId, label,
    });
  } catch (error) {
    if (error?.code !== 'COMMAND_REGISTRY_READ_FAILED' && error?.code !== 'COMMAND_REGISTRY_READ_UNAVAILABLE') throw error;
    const status = Number.isInteger(error.status) ? error.status : null;
    throw ownerGuildRefusal('COMMAND_OWNER_GUILD_UNREADABLE', status === 403 || status === 404
      ? `Deployment refused: Discord would not let the bot read the commands of the owner guild ${label} (status ${status}). `
        + `Check that ${OWNER_GUILD_ENV} is the right guild ID and that the bot is in that guild with the applications.commands scope. `
        + 'Nothing was deployed.'
      : `Deployment refused: the commands of the owner guild ${label} could not be read (${describeCause(error.cause)}), `
        + 'so replacing them is not safe. Nothing was deployed.');
  }
  const planned = new Set(operation.body.map(commandKeyOf));
  const others = held.filter((command) => !planned.has(commandKeyOf(command)));
  if (others.length === 0) return;
  const shown = others.slice(0, 20).map(describeHeldCommand).join(', ');
  throw ownerGuildRefusal('COMMAND_OWNER_GUILD_HOLDS_OTHER_COMMANDS',
    `Deployment refused: the owner guild ${label} already holds ${others.length} command(s) that this deployment does not carry: `
    + `${shown}${others.length > 20 ? ` and ${others.length - 20} more` : ''}. `
    + 'Sending the owner commands there would delete them, and the IDs and permission overrides they have now would be lost. '
    + 'If they are private commands, load the private extension so they go out in the same request, '
    + 'or use --public-only to deploy the global commands alone. '
    + 'If they are leftovers you no longer need, note that the server settings cannot delete a command, only change its permission overrides: '
    + `unset ${OWNER_GUILD_ENV}, run --audit --all-guilds, then --cleanup <digest> --yes --all-guilds, and set it again. `
    + `Cleanup needs the private extension loaded and ${PROTECTED_GUILDS_ENV} set (list your private guilds, not this one), `
    + 'and it deletes every extra command the audit lists. Nothing was deployed.');
}

// Turns deployment plan operations into the scopes the registry audit reads.
function planToScopes(plan) {
  return plan.map((operation) => {
    const guildId = operation.guildId ? String(operation.guildId) : null;
    return Object.freeze({
      scope: scopeLabel(guildId),
      kind: SCOPE_KIND_BY_PLAN_KIND[operation.kind],
      guildId,
      route: operation.route,
      expected: operation.body,
      // Guild operations only: how many private commands the plan carries for the guild, and whether the
      // owner commands are sent along with them.
      privateCommandCount: operation.privateCommandCount,
      includesOwnerCommands: operation.includesOwnerCommands === true,
    });
  });
}

// A deployment operation that leaves a guild with none of its commands: a legacy cleanup, or a private
// guild whose plan carries no private command (the legacy-private fallback). Owner commands sent to such
// a guild do not change that: the private commands Discord holds there would still be replaced.
function clearsGuild(scope) {
  return scope.guildId !== null && (scope.kind === 'cleanup-guild' || scope.expected.length === 0
    || (scope.kind === 'private-guild' && scope.privateCommandCount === 0));
}

function clearingFix(scope) {
  return scope.kind === 'cleanup-guild'
    ? 'remove it from deployment.cleanupGuildIds'
    : 'give it private commands or remove it from the deployment guild IDs';
}

// The clearing operations a deployment may not run. Without a protected list (null) every
// clearing operation is refused, because nothing tells private guilds apart; with the
// list, clearing a listed guild is refused.
function findRefusedClearing(scopes, protectedList) {
  const clearing = scopes.filter(clearsGuild);
  if (protectedList === null) return clearing;
  const protectedSet = new Set(protectedList);
  return clearing.filter((scope) => protectedSet.has(scope.guildId));
}

// The owner guild that the protected list names while the plan carries none of its private commands. One
// request replaces a guild's whole command list, so sending only the owner commands there would remove the
// private commands that Discord holds (for example when the private extension is not loaded). Without a list
// nothing tells private guilds apart, so this refuses nothing; a guild that the plan itself declares as
// private is judged by clearsGuild instead.
function findRefusedOwnerGuild(scopes, protectedList) {
  if (protectedList === null) return [];
  const protectedSet = new Set(protectedList);
  return scopes.filter((scope) => scope.kind === 'owner-guild' && scope.includesOwnerCommands === true
    && scope.privateCommandCount === 0 && protectedSet.has(scope.guildId));
}

function describeScopes(scopes) {
  return scopes.map((scope) => `${scope.scope} (${scope.kind})`).join(', ');
}

// Runs before any Discord request, so dry runs and AUTO_DEPLOY_COMMANDS refuse as well. A
// malformed list fails here too. A plan that clears no guild deploys with or without a list.
function assertDeploymentKeepsProtectedGuilds(plan, protectedGuildIds) {
  const protectedList = parseProtectedGuildIds(protectedGuildIds);
  const scopes = planToScopes(plan);
  const blocked = findRefusedClearing(scopes, protectedList);
  if (blocked.length > 0) {
    const error = new Error(protectedList === null
      ? `Deployment refused: it would clear every command in ${describeScopes(blocked)}, but ${PROTECTED_GUILDS_ENV} `
        + `is not set. Set ${PROTECTED_GUILDS_ENV} first (list every private guild).`
      : `Deployment refused: it would clear every command in protected guilds ${describeScopes(blocked)}. `
        + 'Remove them from deployment.cleanupGuildIds; a protected guild without private commands '
        + 'must not be a deployment target either.');
    error.code = 'COMMAND_CLEANUP_REFUSED';
    throw error;
  }
  const replaced = findRefusedOwnerGuild(scopes, protectedList);
  if (replaced.length > 0) {
    // Taking the guild off the protected list would be no fix: the owner commands would still replace its private commands.
    const error = new Error(`Deployment refused: the owner commands would replace every command of ${describeScopes(replaced)}, `
      + `which ${PROTECTED_GUILDS_ENV} lists as protected, but this deployment carries none of its private commands. `
      + 'Load the private extension so its commands go out in the same request, or use --public-only to deploy the global commands alone.');
    error.code = 'COMMAND_CLEANUP_REFUSED';
    throw error;
  }
}

function removedPathsOf(commandCatalog) {
  const catalog = commandCatalog || defaultCommandCatalog;
  return Array.isArray(catalog?.REMOVED_COMMANDS) ? catalog.REMOVED_COMMANDS : [];
}

async function readScopes({ rest, applicationId, scopes, removedPaths, protectedGuildIds = null }) {
  const registered = [];
  for (const scope of scopes) {
    const actual = await readRegisteredCommands({
      rest, route: scope.route, applicationId, guildId: scope.guildId, label: scope.scope,
    });
    registered.push({ ...scope, actual });
  }
  return {
    registered,
    diff: computeRegistryDiff({ applicationId, scopes: registered, removedPaths, protectedGuildIds }),
  };
}

// After a deployment, read the same routes back and report any difference. This only
// reports: it never retries, corrects or deletes, and a failed read never fails the deploy.
async function readBackDeployment({ rest, applicationId, scopes, removedPaths, write }) {
  try {
    const { diff } = await readScopes({ rest, applicationId, scopes, removedPaths });
    if (diff.items.length === 0) {
      write(`${READBACK_PREFIX} Discord matches the deployment in ${diff.scopes.length} scope(s). digest ${diff.digest}`);
    } else {
      write(`${READBACK_PREFIX} Discord differs from the deployment; nothing was changed automatically.`);
      for (const line of formatRegistryReport(diff, { prefix: READBACK_PREFIX })) write(line);
    }
    return Object.freeze({ ok: diff.items.length === 0, diff });
  } catch (error) {
    const code = error?.code || 'COMMAND_READBACK_FAILED';
    write(`${READBACK_PREFIX} Readback failed (${code}); the deployment itself was sent.`);
    return Object.freeze({ ok: false, error: code });
  }
}

async function deployCommands({
  token = getDiscordToken(),
  clientId = getDiscordClientId(),
  rest,
  extensionHost,
  publicOnly = false,
  cleanupGuildIds = [],
  dryRun = false,
  testControlPolicy = loadTestControlPolicy(),
  testControl = false,
  commandCatalog,
  protectedGuildIds = process.env[PROTECTED_GUILDS_ENV],
  ownerGuildId = process.env[OWNER_GUILD_ENV],
  report = defaultReport,
} = {}) {
  requireEnvValue('DISCORD_CLIENT_ID', clientId, ['CLIENT_ID']);
  if (!dryRun && !rest) requireEnvValue('DISCORD_TOKEN', token);
  if (publicOnly && cleanupGuildIds.length > 0) throw new Error('Public-only deployment cannot clean up guild commands.');

  if (testControl && !testControlPolicy) throw new Error('Test-control deployment requires the trusted launcher.');
  if (testControlPolicy && !testControl) throw new Error('Test-control deployment requires the explicit test-control action.');
  const publicCommands = loadCommandData(undefined, { scope: 'public' });
  // Refuse to deploy when the command catalog, the builders and /help disagree. This runs
  // before any Discord request, including dry runs.
  assertPublicCommandCatalog(publicCommands, { catalog: commandCatalog });
  if (testControlPolicy) {
    if (publicOnly || cleanupGuildIds.length > 0 || extensionHost) {
      throw new Error('Test-control deployment cannot use production or private deployment options.');
    }
    const restClient = rest || new REST({ version: '10' }).setToken(token);
    if (!dryRun) {
      await preflightTestIdentity({ policy: testControlPolicy, rest: restClient, configuredClientId: clientId, Routes });
    } else {
      testControlPolicy.assertIdentity({
        configuredClientId: clientId,
        applicationId: testControlPolicy.expectedApplicationId,
        botUserId: testControlPolicy.expectedApplicationId,
      });
    }
    const plan = buildTestDeploymentPlan({ policy: testControlPolicy, publicCommands });
    let readback = null;
    if (!dryRun) {
      for (const operation of plan) await restClient.put(operation.route, { body: operation.body });
      readback = await readBackDeployment({
        rest: restClient,
        applicationId: testControlPolicy.expectedApplicationId,
        scopes: planToScopes(plan),
        removedPaths: removedPathsOf(commandCatalog),
        write: createSafeWriter(report, [token]),
      });
    }
    return {
      dryRun,
      publicOnly: false,
      testControl: true,
      globalCount: 0,
      privateCommandCount: 0,
      privateGuildCount: 0,
      testGuildCount: plan.length,
      cleanupCount: 0,
      plan,
      readback,
    };
  }
  // A public-only run must not load a configured private extension or touch guild routes.
  const host = publicOnly ? null : extensionHost || loadPrivateExtensionHost();
  const privateCommandGroups = publicOnly ? [] : loadPrivateCommandGroups(host);
  const privateCommands = privateCommandGroups.flatMap((group) => group.commands);
  assertNoPublicPrivateCommandCollisions(publicCommands, privateCommands);
  // Owner-only commands are never global: they go to the owner guild or nowhere (see planOwnerCommands).
  const { globalCommands, ownerCommands } = splitPublicCommands(publicCommands, commandCatalog);
  const owner = planOwnerCommands({ ownerGuildId, ownerCommands, publicOnly });
  const write = createSafeWriter(report, [token]);
  if (owner.notice) write(owner.notice);
  const deploymentTargets = publicOnly ? [] : host.getDeploymentTargets();
  const plan = buildDeploymentPlan({
    clientId,
    publicCommands: globalCommands,
    privateCommands,
    privateCommandGroups,
    deploymentTargets,
    cleanupGuildIds,
    ownerGuildId: owner.guildId,
    ownerCommands: owner.commands,
  });
  assertDeploymentKeepsProtectedGuilds(plan, protectedGuildIds);
  // A dry run reads nothing from Discord, so it cannot make the check that a real run makes first.
  if (dryRun && plan.some((item) => item.kind === 'owner-guild')) {
    write(`${OWNER_PREFIX} notice: a real deployment first reads the commands Discord holds in the owner guild and stops, `
      + 'before sending anything, if it holds a command other than the owner commands; this dry run read nothing.');
  }

  let readback = null;
  if (!dryRun) {
    const restClient = rest || new REST({ version: '10' }).setToken(token);
    // Before the first request of the deployment, the global one included: if this refuses, nothing has been sent.
    for (const operation of plan.filter((item) => item.kind === 'owner-guild')) {
      await assertOwnerGuildHoldsOnlyPlannedCommands({ rest: restClient, operation, clientId });
    }
    const cleanupReadbacks = new Map();
    for (const operation of plan.filter((item) => item.kind === 'legacy-cleanup')) {
      if (typeof restClient.get !== 'function') {
        throw new Error('Legacy cleanup requires Discord command readback before mutation.');
      }
      cleanupReadbacks.set(
        operation.guildId,
        assertCleanupReadback(await restClient.get(operation.route), clientId, operation.guildId),
      );
    }
    for (const operation of plan) {
      if (operation.kind === 'legacy-cleanup' && cleanupReadbacks.get(operation.guildId).length === 0) continue;
      await restClient.put(operation.route, { body: operation.body });
    }
    readback = await readBackDeployment({
      rest: restClient,
      applicationId: clientId,
      scopes: planToScopes(plan),
      removedPaths: removedPathsOf(commandCatalog),
      write: createSafeWriter(report, [token]),
    });
  }

  return {
    dryRun,
    publicOnly,
    globalCount: globalCommands.length,
    privateCommandCount: privateCommands.length,
    privateGuildCount: plan.filter((item) => item.kind === 'private-guild').length,
    cleanupCount: plan.filter((item) => item.kind === 'legacy-cleanup').length,
    // status: guild (sent to the owner guild), unset, invalid, public-only or none (no owner command exists).
    ownerDeployment: Object.freeze({ status: owner.status, guildId: owner.guildId, commandCount: owner.commands.length }),
    plan,
    readback,
  };
}

// ---- Registry audit and cleanup --------------------------------------------------------------

/**
 * Validates the catalog and builds the scopes an audit or cleanup may read, before any
 * Discord request. Production reads the global commands, the private guilds of the
 * deployment plan, the owner guild (when XIAOJI_OWNER_GUILD_ID is valid) and the declared
 * cleanup guilds. Test-control reads only the trusted test guilds of the test application.
 */
function prepareCommandRegistry({
  token,
  clientId,
  rest,
  extensionHost,
  publicOnly,
  allGuilds,
  cleanupGuildIds,
  testControlPolicy,
  testControl,
  commandCatalog,
  protectedGuildIds,
  ownerGuildId,
}) {
  requireEnvValue('DISCORD_CLIENT_ID', clientId, ['CLIENT_ID']);
  if (!rest) requireEnvValue('DISCORD_TOKEN', token);
  // null when unset: cleanup then judges private guilds by the deployment plan only.
  const protectedList = parseProtectedGuildIds(protectedGuildIds);
  if (publicOnly && (allGuilds || cleanupGuildIds.length > 0)) {
    throw new Error('A public-only command audit reads only global commands.');
  }
  if (testControl && !testControlPolicy) throw new Error('Test-control command audit requires the trusted launcher.');
  if (testControlPolicy && !testControl) {
    throw new Error('Test-control command audit requires the explicit test-control action.');
  }
  const publicCommands = loadCommandData(undefined, { scope: 'public' });
  // Same refusal as deployment: a drifted catalog has no trustworthy expected state.
  assertPublicCommandCatalog(publicCommands, { catalog: commandCatalog });
  const removedPaths = removedPathsOf(commandCatalog);

  let context;
  if (testControlPolicy) {
    if (publicOnly || allGuilds || cleanupGuildIds.length > 0 || extensionHost) {
      throw new Error('Test-control command audit can read only the trusted test guilds.');
    }
    const plan = buildTestDeploymentPlan({ policy: testControlPolicy, publicCommands });
    context = {
      applicationId: String(testControlPolicy.expectedApplicationId),
      testControlPolicy,
      privatePlanLoaded: false,
      privateGuildIds: new Set(),
      removedPaths,
      scopes: planToScopes(plan),
    };
  } else {
    // A public-only run must not load a configured private extension or touch guild routes.
    const host = publicOnly ? null : extensionHost || loadPrivateExtensionHost();
    const privateCommandGroups = publicOnly ? [] : loadPrivateCommandGroups(host);
    const privateCommands = privateCommandGroups.flatMap((group) => group.commands);
    assertNoPublicPrivateCommandCollisions(publicCommands, privateCommands);
    // The same split as a deployment: the owner-only commands belong to the owner guild, not to the global scope.
    const { globalCommands, ownerCommands } = splitPublicCommands(publicCommands, commandCatalog);
    const owner = planOwnerCommands({ ownerGuildId, ownerCommands, publicOnly });
    const plan = buildDeploymentPlan({
      clientId,
      publicCommands: globalCommands,
      privateCommands,
      privateCommandGroups,
      deploymentTargets: publicOnly ? [] : host.getDeploymentTargets(),
      cleanupGuildIds,
      ownerGuildId: owner.guildId,
      ownerCommands: owner.commands,
    });
    context = {
      applicationId: String(clientId),
      testControlPolicy: null,
      // Without a loaded private extension nobody can tell which guilds are private.
      privatePlanLoaded: Array.isArray(host?.extensions) && host.extensions.length > 0,
      privateGuildIds: new Set(plan.filter((item) => item.kind === 'private-guild').map((item) => String(item.guildId))),
      removedPaths,
      scopes: planToScopes(plan),
    };
  }
  if (!SNOWFLAKE_PATTERN.test(context.applicationId)) throw new Error('The application ID is not a Discord ID.');
  for (const scope of context.scopes) {
    if (scope.guildId !== null && !SNOWFLAKE_PATTERN.test(scope.guildId)) {
      throw new Error('The deployment plan contains an invalid guild ID.');
    }
  }
  context.protectedConfigured = protectedList !== null;
  context.protectedGuildIds = new Set(protectedList || []);
  return Object.freeze(context);
}

// Reads every scope of the context. With allGuilds, every joined guild that the plan does
// not declare is read as an other-guild scope. Passing scopes re-reads exactly those.
async function readCommandRegistry({ context, rest, allGuilds = false, scopes: fixedScopes = null }) {
  let scopes = fixedScopes || context.scopes;
  if (!fixedScopes && allGuilds) {
    const declared = new Set(scopes.filter((scope) => scope.guildId !== null).map((scope) => scope.guildId));
    const joined = await listJoinedGuildIds({ rest, route: Routes.userGuilds() });
    scopes = [...scopes, ...joined.filter((guildId) => !declared.has(guildId)).map((guildId) => Object.freeze({
      scope: scopeLabel(guildId),
      kind: 'other-guild',
      guildId,
      route: Routes.applicationGuildCommands(context.applicationId, guildId),
      expected: [],
    }))];
  }
  const { registered, diff } = await readScopes({
    rest,
    applicationId: context.applicationId,
    scopes,
    removedPaths: context.removedPaths,
    protectedGuildIds: [...context.protectedGuildIds],
  });
  const registeredIds = new Map(registered.map((scope) => [scope.scope, new Set(scope.actual.map((command) => String(command.id)))]));
  return { scopes, registeredIds, diff };
}

function cleanupRefused(reason) {
  const error = new Error(`Cleanup refused: ${reason}`);
  error.code = 'COMMAND_CLEANUP_REFUSED';
  return error;
}

// Checked for every target before the preview and before any deletion.
function assertCleanupTarget(target, scope, context) {
  if (!scope || scope.kind !== target.scopeKind) throw cleanupRefused(`${target.scope} was not part of this audit.`);
  if (target.type !== 'extra') throw cleanupRefused('only extra commands can be deleted.');
  if (!SNOWFLAKE_PATTERN.test(String(target.commandId))) throw cleanupRefused('a command ID is invalid.');
  if (scope.kind === 'private-guild' || (scope.guildId !== null && context.privateGuildIds.has(scope.guildId))) {
    throw cleanupRefused(`${scope.scope} is a private guild in the deployment plan.`);
  }
  // The owner guild holds the owner-only commands of the plan; nothing there is ever deleted.
  if (scope.kind === 'owner-guild') {
    throw cleanupRefused(`${scope.scope} is the owner guild in the deployment plan.`);
  }
  // Independent of the plan and of the scope kind.
  if (scope.guildId !== null && context.protectedGuildIds?.has(scope.guildId)) {
    throw cleanupRefused(`${scope.scope} is protected by ${PROTECTED_GUILDS_ENV}.`);
  }
  if (context.testControlPolicy) {
    if (scope.kind !== 'test-guild' || !context.testControlPolicy.allowsGuild(scope.guildId)) {
      throw cleanupRefused(`${scope.scope} is not a trusted test guild.`);
    }
    return;
  }
  // Without an explicit protected list no guild command is ever deleted.
  if (scope.guildId !== null && !context.protectedConfigured) {
    throw cleanupRefused(`${PROTECTED_GUILDS_ENV} is not set, so guild commands are never deleted. `
      + 'Use --public-only for global commands only.');
  }
  if (scope.kind === 'test-guild') throw cleanupRefused('test guilds can be cleaned only in test-control mode.');
  if (scope.guildId !== null && !context.privatePlanLoaded) {
    throw cleanupRefused('no private deployment plan is loaded, so private guilds cannot be protected. '
      + 'Use --public-only for global commands only.');
  }
}

function deletionRoute(target, scope, context) {
  return scope.guildId === null
    ? Routes.applicationCommand(context.applicationId, target.commandId)
    : Routes.applicationGuildCommand(context.applicationId, scope.guildId, target.commandId);
}

// Printed by --audit and --cleanup (with or without --yes) when the protected list is unset
// and guild scopes were read.
function writeProtectionReminder(write, prefix, context, scopes) {
  if (context.protectedConfigured || context.testControlPolicy) return;
  if (!scopes.some((scope) => scope.guildId !== null)) return;
  write(`${prefix} reminder: ${PROTECTED_GUILDS_ENV} is not set, so --cleanup deletes no guild command. `
    + 'Set it to every private guild ID to allow guild cleanup; --public-only cleans global commands only.');
}

async function openCommandRegistry(options) {
  const context = prepareCommandRegistry(options);
  const restClient = options.rest || new REST({ version: '10' }).setToken(options.token);
  if (context.testControlPolicy) {
    // The token must belong to the trusted test application, never to the formal bot.
    await preflightTestIdentity({
      policy: context.testControlPolicy, rest: restClient, configuredClientId: options.clientId, Routes,
    });
  }
  return { context, restClient };
}

/**
 * Read-only: compares Discord with the expected commands and prints every difference with
 * its scope and command ID, then the digest. It never sends PUT, PATCH, POST or DELETE.
 */
async function auditCommandRegistrations({
  token = getDiscordToken(),
  clientId = getDiscordClientId(),
  rest,
  extensionHost,
  publicOnly = false,
  allGuilds = false,
  cleanupGuildIds = [],
  testControlPolicy = loadTestControlPolicy(),
  testControl = false,
  commandCatalog,
  protectedGuildIds = process.env[PROTECTED_GUILDS_ENV],
  ownerGuildId = process.env[OWNER_GUILD_ENV],
  report = defaultReport,
} = {}) {
  const options = {
    token, clientId, rest, extensionHost, publicOnly, allGuilds, cleanupGuildIds, testControlPolicy, testControl, commandCatalog, protectedGuildIds, ownerGuildId,
  };
  const { context, restClient } = await openCommandRegistry(options);
  const write = createSafeWriter(report, [token]);
  const registry = await readCommandRegistry({ context, rest: restClient, allGuilds });
  const candidates = selectCleanupTargets(registry.diff);
  if (!context.testControlPolicy && !context.privatePlanLoaded && candidates.some((item) => item.scopeKind !== 'public-global')) {
    write(`${AUDIT_PREFIX} warning: no private deployment plan is loaded; --cleanup will refuse to delete guild commands.`);
  }
  if (context.protectedConfigured && !context.testControlPolicy) {
    for (const scope of context.scopes) {
      if (scope.kind === 'private-guild' && !context.protectedGuildIds.has(scope.guildId)) {
        write(`${AUDIT_PREFIX} warning: private guild ${scope.scope} of the deployment plan is not in ${PROTECTED_GUILDS_ENV}.`);
      }
    }
  }
  if (!context.testControlPolicy) {
    // Same rule as assertDeploymentKeepsProtectedGuilds.
    const protectedList = context.protectedConfigured ? [...context.protectedGuildIds] : null;
    for (const scope of findRefusedClearing(context.scopes, protectedList)) {
      write(protectedList === null
        ? `${AUDIT_PREFIX} warning: npm run deploy will refuse to clear ${scope.scope} (${scope.kind}) until `
          + `${PROTECTED_GUILDS_ENV} is set (list every private guild).`
        : `${AUDIT_PREFIX} warning: ${scope.scope} (${scope.kind}) is protected; npm run deploy will refuse `
          + `to run until you ${clearingFix(scope)}.`);
    }
    for (const scope of findRefusedOwnerGuild(context.scopes, protectedList)) {
      write(`${AUDIT_PREFIX} warning: owner guild ${scope.scope} is protected and the plan carries none of its private commands; `
        + 'npm run deploy will refuse to send the owner commands there until you load the private extension; '
        + '--public-only deploys the global commands alone.');
    }
  }
  writeProtectionReminder(write, AUDIT_PREFIX, context, registry.scopes);
  for (const line of formatRegistryReport(registry.diff, { prefix: AUDIT_PREFIX, cleanupCandidates: candidates.length })) {
    write(line);
  }
  return Object.freeze({
    action: 'audit',
    testControl: Boolean(context.testControlPolicy),
    applicationId: context.applicationId,
    digest: registry.diff.digest,
    diff: registry.diff,
    cleanupCandidates: Object.freeze(candidates),
  });
}

/**
 * Deletes leftovers found by an audit. It re-reads Discord and continues only when the
 * digest still matches; it deletes only extra commands in global and non-private,
 * unprotected guild scopes, one command ID at a time and only with confirm (--yes); then
 * it reads again. Guilds in XIAOJI_PROTECTED_GUILD_IDS are never touched, and without that
 * list no guild command is deleted at all.
 */
async function cleanupCommandRegistrations({
  token = getDiscordToken(),
  clientId = getDiscordClientId(),
  rest,
  extensionHost,
  publicOnly = false,
  allGuilds = false,
  cleanupGuildIds = [],
  testControlPolicy = loadTestControlPolicy(),
  testControl = false,
  commandCatalog,
  protectedGuildIds = process.env[PROTECTED_GUILDS_ENV],
  ownerGuildId = process.env[OWNER_GUILD_ENV],
  expectedDigest,
  confirm = false,
  report = defaultReport,
} = {}) {
  const digest = String(expectedDigest || '').toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) throw new Error('Cleanup needs the 64-character digest printed by --audit.');
  const options = {
    token, clientId, rest, extensionHost, publicOnly, allGuilds, cleanupGuildIds, testControlPolicy, testControl, commandCatalog, protectedGuildIds, ownerGuildId,
  };
  const { context, restClient } = await openCommandRegistry(options);
  const write = createSafeWriter(report, [token]);
  const result = (fields) => Object.freeze({ action: 'cleanup', testControl: Boolean(context.testControlPolicy), ...fields });

  const before = await readCommandRegistry({ context, rest: restClient, allGuilds });
  writeProtectionReminder(write, CLEANUP_PREFIX, context, before.scopes);
  if (before.diff.digest !== digest) {
    const candidates = selectCleanupTargets(before.diff).length;
    for (const line of formatRegistryReport(before.diff, { prefix: CLEANUP_PREFIX, cleanupCandidates: candidates })) write(line);
    write(`${CLEANUP_PREFIX} digest mismatch: Discord or the options changed since the audit. Nothing was deleted.`);
    write(`${CLEANUP_PREFIX} current digest ${before.diff.digest}`);
    return result({ status: 'digest-mismatch', currentDigest: before.diff.digest, diff: before.diff, targets: [], deleted: [] });
  }

  const scopeByLabel = new Map(before.scopes.map((scope) => [scope.scope, scope]));
  const targets = selectCleanupTargets(before.diff);
  for (const target of targets) assertCleanupTarget(target, scopeByLabel.get(target.scope), context);
  // Leftovers in protected guilds are listed but never become targets.
  const protectedSkipped = selectProtectedExtras(before.diff);
  for (const item of protectedSkipped) write(`${CLEANUP_PREFIX} skip ${formatRegistryItem(item)}`);
  if (targets.length === 0) {
    write(`${CLEANUP_PREFIX} nothing to delete. digest ${digest}`);
    return result({
      status: 'nothing-to-delete', currentDigest: digest, diff: before.diff, targets: [], deleted: [], protectedSkipped,
    });
  }
  for (const target of targets) write(`${CLEANUP_PREFIX} ${confirm ? 'delete' : 'would delete'} ${formatRegistryItem(target)}`);
  if (!confirm) {
    write(`${CLEANUP_PREFIX} preview only: add --yes to delete ${targets.length} command(s). Nothing was deleted.`);
    return result({ status: 'dry-run', currentDigest: digest, diff: before.diff, targets, deleted: [], protectedSkipped });
  }

  const deleted = [];
  let failure = null;
  for (const target of targets) {
    try {
      await restClient.delete(deletionRoute(target, scopeByLabel.get(target.scope), context));
      deleted.push(target);
      write(`${CLEANUP_PREFIX} deleted ${formatRegistryItem(target)}`);
    } catch (cause) {
      const status = Number.isInteger(cause?.status) ? cause.status : null;
      failure = Object.freeze({ target, status });
      write(`${CLEANUP_PREFIX} delete failed (status ${status ?? 'unknown'}); stopping. ${formatRegistryItem(target)}`);
      break;
    }
  }

  // Read the same scopes again to confirm what is left.
  let after = null;
  let verifyError = null;
  try {
    after = await readCommandRegistry({ context, rest: restClient, scopes: before.scopes });
  } catch (error) {
    verifyError = error?.code || 'COMMAND_REGISTRY_READ_FAILED';
    write(`${CLEANUP_PREFIX} verification read failed (${verifyError}).`);
  }
  const remaining = after
    ? targets.filter((target) => after.registeredIds.get(target.scope)?.has(target.commandId))
    : [...targets];
  const residue = after ? selectCleanupTargets(after.diff) : [];
  for (const target of remaining) write(`${CLEANUP_PREFIX} still registered ${formatRegistryItem(target)}`);
  for (const item of residue.filter((entry) => !remaining.some((target) => target.commandId === entry.commandId))) {
    write(`${CLEANUP_PREFIX} residue ${formatRegistryItem(item)}`);
  }
  const status = !failure && !verifyError && remaining.length === 0 && residue.length === 0 ? 'deleted' : 'incomplete';
  write(`${CLEANUP_PREFIX} result ${status} deleted=${deleted.length}/${targets.length} remaining=${remaining.length} residue=${residue.length}`
    + (after ? ` digest ${after.diff.digest}` : ''));
  return result({
    status,
    currentDigest: after ? after.diff.digest : null,
    diff: before.diff,
    after: after ? after.diff : null,
    targets,
    deleted,
    failure,
    remaining,
    residue,
    verifyError,
    protectedSkipped,
  });
}

// ---- Command line ------------------------------------------------------------------------

async function runDeploymentCli(args = [], { log = defaultReport, dependencies = {} } = {}) {
  const { action, ...options } = parseDeploymentArgs(args);
  if (action === 'audit') {
    await auditCommandRegistrations({ ...options, ...dependencies, report: log });
    return 0;
  }
  if (action === 'cleanup') {
    const result = await cleanupCommandRegistrations({ ...options, ...dependencies, report: log });
    return CLEANUP_EXIT_CODES[result.status] ?? 1;
  }
  const result = await deployCommands({ ...options, ...dependencies, report: log });
  log(result.testControl
    ? formatTestDeployment(result)
    : `Slash commands deployed: ${result.globalCount} public, ${result.privateCommandCount} private.`);
  const ownerLine = formatOwnerDeployment(result);
  if (ownerLine) log(ownerLine);
  return 0;
}

// The owner-only commands, when a guild received them. Why they were not deployed (no guild ID, a malformed
// one, --public-only) was already said as a warning or notice while the deployment was planned.
function formatOwnerDeployment(result) {
  const owner = result.ownerDeployment;
  if (!owner || owner.status !== 'guild') return null;
  return `Owner commands ${result.dryRun ? 'planned (dry run)' : 'deployed'} to ${scopeLabel(owner.guildId)} only: ${owner.commandCount}.`;
}

// Test-control deploys only to the trusted test guilds; report what each one received,
// as guild IDs and counts only.
function formatTestDeployment(result) {
  const guilds = result.plan.map((operation) => `${scopeLabel(operation.guildId)}=${operation.body.length}`);
  const verb = result.dryRun ? 'planned (dry run)' : 'deployed';
  return `Test commands ${verb} to ${guilds.length} test guild(s): ${guilds.join(', ')}.`;
}

function isRegistryInvocation(args) {
  return args.includes('--audit') || args.includes('--cleanup');
}

function reportCliFailure(error, args = [], { env = process.env, logError = (line) => console.error(line) } = {}) {
  if (env.XIAOJI_RUNTIME_MODE === 'test-control') {
    logError(`[TEST_CONTROL] code=${error?.code || 'TEST_DEPLOY_FAILED'}`);
  } else if (isRegistryInvocation(args)) {
    // Audit and cleanup print only the message, never the error object or its request.
    const token = typeof env.DISCORD_TOKEN === 'string' ? env.DISCORD_TOKEN.trim() : '';
    createSafeWriter(logError, [token])(`Command registry check failed: ${error?.message}`);
  } else {
    logError(error);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => runDeploymentCli(args)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    reportCliFailure(error, args);
    process.exitCode = 1;
  });
}

module.exports = {
  OWNER_GUILD_ENV,
  buildDeploymentPlan,
  buildTestDeploymentPlan,
  assertCleanupReadback,
  assertCleanupTarget,
  auditCommandRegistrations,
  cleanupCommandRegistrations,
  deployCommands,
  parseDeploymentArgs,
  parseOwnerGuildId,
  planToScopes,
  reportCliFailure,
  runDeploymentCli,
  shouldAutoDeployCommands,
  splitPublicCommands,
};
