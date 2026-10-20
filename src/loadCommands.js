const fs = require('node:fs');
const path = require('node:path');
const { ApplicationCommandOptionType, Collection } = require('discord.js');
const defaultCommandCatalog = require('../website/commandCatalog');
const { createExtensionHost } = require('./extensions/extensionHost');
const logger = require('./utils/logger');

const SUBCOMMAND = ApplicationCommandOptionType.Subcommand;
const SUBCOMMAND_GROUP = ApplicationCommandOptionType.SubcommandGroup;
const COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const REMOVED_PATH_PATTERN = /^[a-z0-9_-]{1,32}(?: [a-z0-9_-]{1,32}){0,2}$/u;
// Help marks every usage line as `/command sub/sub`; only these backticked tokens are usage lines.
const HELP_USAGE_PATTERN = /`\/([a-z0-9_-]+)(?: ([^`]*))?`/gu;
const MAX_CATALOG_WARNINGS = 10;

function getCommandFiles(commandsPath = path.join(__dirname, 'commands')) {
  if (!fs.existsSync(commandsPath)) throw new Error(`Commands directory does not exist: ${commandsPath}`);
  return fs.readdirSync(commandsPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(commandsPath, entry.name);
    if (entry.isDirectory()) return getCommandFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

function loadCommandModule(filePath) {
  const command = require(filePath);
  if (!command.data || !command.execute || !command.data.name || typeof command.execute !== 'function') {
    throw new Error(`Invalid command module: ${filePath}`);
  }
  return command;
}

function addCommandDirectory(commands, commandsPath, source) {
  for (const filePath of getCommandFiles(commandsPath)) {
    const command = loadCommandModule(filePath);
    if (commands.has(command.data.name)) throw new Error(`Duplicate slash command name: ${command.data.name}`);
    Object.defineProperty(command, 'xiaojiCommandSource', {
      configurable: false,
      enumerable: false,
      value: source,
      writable: false,
    });
    commands.set(command.data.name, command);
  }
}

function loadCommands(commandsPath, {
  extensionHost = createExtensionHost(),
  catalog = defaultCommandCatalog,
  warn = logger.warn,
} = {}) {
  const commands = new Collection();
  addCommandDirectory(commands, commandsPath || path.join(__dirname, 'commands'), 'public-core');
  for (const descriptor of extensionHost.getCommandDirectories()) {
    addCommandDirectory(commands, descriptor.path, descriptor.extensionId);
  }
  // Catalog drift must never stop the bot, so startup only reports it. Deployment and
  // `npm run check` are where drift is rejected. A custom commands path is not the public set.
  if (!commandsPath && typeof warn === 'function') warnOnCommandCatalogDrift(commands, { catalog, warn });
  return commands;
}

function loadPrivateCommandGroups(extensionHost = createExtensionHost()) {
  const commandOwners = new Map();
  return extensionHost.getCommandDirectories().map((descriptor) => {
    const commands = serializeCommandDirectory(descriptor.path, descriptor.transformCommandData);
    for (const command of commands) {
      if (commandOwners.has(command.name)) {
        throw new Error(`Duplicate private slash command name: ${command.name}`);
      }
      commandOwners.set(command.name, descriptor.commandGroupId);
    }
    return Object.freeze({
      extensionId: descriptor.extensionId,
      commandGroupId: descriptor.commandGroupId,
      guildIds: Object.freeze([...(descriptor.guildIds || [])]),
      commands: Object.freeze(commands),
    });
  });
}

function serializeCommandDirectory(commandsPath, transformCommandData = (value) => value) {
  return getCommandFiles(commandsPath).map((filePath) => {
    const command = loadCommandModule(filePath);
    return transformCommandData(command.data.toJSON(), command);
  });
}

function loadCommandData(commandsPath, { scope = 'public', extensionHost = createExtensionHost() } = {}) {
  if (scope === 'public') {
    return serializeCommandDirectory(commandsPath || path.join(__dirname, 'commands'));
  }
  if (scope === 'private') {
    return loadPrivateCommandGroups(extensionHost).flatMap((group) => group.commands);
  }
  if (scope === 'all') {
    const publicCommands = loadCommandData(commandsPath, { scope: 'public', extensionHost });
    const privateCommands = loadCommandData(commandsPath, { scope: 'private', extensionHost });
    assertNoPublicPrivateCommandCollisions(publicCommands, privateCommands);
    return [...publicCommands, ...privateCommands];
  }
  throw new Error(`Unknown command scope: ${scope}`);
}

// A private command may not reuse a public command name. loadCommands already refuses this
// at runtime, so deployment must refuse it too.
function assertNoPublicPrivateCommandCollisions(publicCommands, privateCommands) {
  const publicNames = new Set(publicCommands.map((command) => command.name));
  const collisions = [...new Set(privateCommands.map((command) => command.name))]
    .filter((name) => publicNames.has(name));
  if (collisions.length > 0) {
    throw new Error(`Private slash commands collide with public commands: ${collisions.map((name) => `/${name}`).join(', ')}`);
  }
}

// ---- Command catalog validation -------------------------------------------------------

// Two commands whose descriptions match once case, spacing, punctuation and full-width forms
// are ignored must be declared as aliases of each other.
function normalizeDescription(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

// Flattens serialized builder data into slash paths: "ping", "shop buy", "group sub".
function indexCommandData(commandData) {
  if (!Array.isArray(commandData)) throw new TypeError('Command data must be an array.');
  const commands = new Map();
  const paths = new Set();
  const descriptions = new Map();
  const duplicates = [];
  for (const command of commandData) {
    if (commands.has(command.name)) duplicates.push(command.name);
    const subcommands = [];
    const visit = (options, parents) => {
      for (const option of options || []) {
        const route = [...parents, option.name];
        if (option.type === SUBCOMMAND_GROUP) {
          paths.add([command.name, ...route].join(' '));
          visit(option.options, route);
        } else if (option.type === SUBCOMMAND) {
          const subcommandPath = route.join(' ');
          subcommands.push(subcommandPath);
          paths.add(`${command.name} ${subcommandPath}`);
          descriptions.set(`${command.name} ${subcommandPath}`, option.description);
        }
      }
    };
    visit(command.options, []);
    commands.set(command.name, { description: command.description, subcommands });
    paths.add(command.name);
    descriptions.set(command.name, command.description);
  }
  return { commands, paths, descriptions, duplicates };
}

function isListedInHelp(entry) {
  return entry.listInHelp === true && entry.audience !== 'owner';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A subcommand audience is one of the command audiences and may only narrow its command:
// public commands can hold admin or owner subcommands, admin commands only admin or owner ones.
// A command is as wide as its widest subcommand, so a public command keeps one public subcommand.
// COMMAND_AUDIENCES runs from the widest audience to the narrowest.
function checkSubcommandAudiences(catalog, entry, label, issues) {
  const audiences = catalog.COMMAND_AUDIENCES;
  const subcommands = Array.isArray(entry.subcommands) ? entry.subcommands : [];
  const marks = entry.subcommandAudiences === undefined ? {} : entry.subcommandAudiences;
  if (!isPlainObject(marks)) {
    issues.push(`Catalog entry ${label} must list subcommandAudiences as an object.`);
    return;
  }
  for (const [subcommand, audience] of Object.entries(marks)) {
    if (!subcommands.includes(subcommand)) {
      issues.push(`Catalog entry ${label} marks ${JSON.stringify(subcommand)}, which is not one of its subcommands.`);
    }
    if (!audiences.includes(audience)) {
      issues.push(`Catalog entry ${label} ${subcommand} uses unknown audience ${JSON.stringify(audience)}.`);
    }
  }

  const commandRank = audiences.indexOf(entry.audience);
  if (commandRank < 0 || subcommands.length === 0) return;
  let widestRank = audiences.length;
  for (const subcommand of subcommands) {
    const audience = defaultCommandCatalog.getSubcommandAudience(entry, subcommand);
    const rank = audiences.indexOf(audience);
    if (rank < 0) continue; // already reported as an unknown audience
    if (rank < commandRank) {
      issues.push(`Catalog entry ${label} ${subcommand} is ${audience}, which is wider than its command (${entry.audience}).`);
    }
    widestRank = Math.min(widestRank, rank);
  }
  if (widestRank < audiences.length && widestRank > commandRank) {
    issues.push(`Catalog entry ${label} is ${entry.audience}, but its widest subcommand is ${audiences[widestRank]}.`);
  }
}

function checkCatalogEntries(catalog, issues) {
  const groupIds = new Set(catalog.COMMAND_GROUPS.map((group) => group.id));
  const audiences = new Set(catalog.COMMAND_AUDIENCES);
  const seen = new Set();
  for (const entry of catalog.COMMAND_CATALOG) {
    if (typeof entry.name !== 'string' || !COMMAND_NAME_PATTERN.test(entry.name)) {
      issues.push(`Catalog entry has an invalid command name: ${JSON.stringify(entry.name)}.`);
      continue;
    }
    const label = `/${entry.name}`;
    if (seen.has(entry.name)) issues.push(`Catalog lists ${label} more than once.`);
    seen.add(entry.name);
    if (typeof entry.description !== 'string' || !entry.description.trim()) {
      issues.push(`Catalog entry ${label} has no description.`);
    }
    if (!groupIds.has(entry.group)) issues.push(`Catalog entry ${label} uses unknown group ${JSON.stringify(entry.group)}.`);
    if (!audiences.has(entry.audience)) {
      issues.push(`Catalog entry ${label} uses unknown audience ${JSON.stringify(entry.audience)}.`);
    }
    if (typeof entry.listInHelp !== 'boolean') issues.push(`Catalog entry ${label} must set listInHelp to true or false.`);
    if (entry.audience === 'owner' && entry.listInHelp === true) {
      issues.push(`Owner-only ${label} must not be listed in help.`);
    }
    if (!Array.isArray(entry.subcommands) || entry.subcommands.some((name) => typeof name !== 'string' || !name)) {
      issues.push(`Catalog entry ${label} must list subcommands as non-empty strings.`);
    } else if (new Set(entry.subcommands).size !== entry.subcommands.length) {
      issues.push(`Catalog entry ${label} lists a subcommand more than once.`);
    }
    checkSubcommandAudiences(catalog, entry, label, issues);
  }
}

function checkCatalogAgainstBuilders(catalog, live, issues) {
  for (const name of live.duplicates) issues.push(`Builders define /${name} more than once.`);
  const entries = new Map(catalog.COMMAND_CATALOG.map((entry) => [entry.name, entry]));
  for (const [name, command] of live.commands) {
    const entry = entries.get(name);
    if (!entry) {
      issues.push(`Builder command /${name} is missing from the catalog.`);
      continue;
    }
    if (entry.description !== command.description) {
      issues.push(`/${name} description differs: catalog ${JSON.stringify(entry.description)}, builder ${JSON.stringify(command.description)}.`);
    }
    const catalogSubcommands = Array.isArray(entry.subcommands) ? entry.subcommands : [];
    const missing = command.subcommands.filter((subcommand) => !catalogSubcommands.includes(subcommand));
    const unknown = catalogSubcommands.filter((subcommand) => !command.subcommands.includes(subcommand));
    if (missing.length > 0) issues.push(`/${name} subcommands missing from the catalog: ${missing.join(', ')}.`);
    if (unknown.length > 0) issues.push(`/${name} catalog subcommands not defined by the builder: ${unknown.join(', ')}.`);
  }
  for (const entry of catalog.COMMAND_CATALOG) {
    if (!live.commands.has(entry.name)) issues.push(`Catalog lists /${entry.name} but no public builder defines it.`);
  }
}

function checkRemovedPaths(catalog, live, issues) {
  // Every prefix of a catalog path counts, so removing a whole group is also caught.
  const catalogPaths = new Set();
  for (const entry of catalog.COMMAND_CATALOG) {
    catalogPaths.add(entry.name);
    for (const subcommand of Array.isArray(entry.subcommands) ? entry.subcommands : []) {
      const parts = String(subcommand).split(' ');
      for (let length = 1; length <= parts.length; length += 1) {
        catalogPaths.add(`${entry.name} ${parts.slice(0, length).join(' ')}`);
      }
    }
  }
  const seen = new Set();
  for (const removed of catalog.REMOVED_COMMANDS) {
    if (typeof removed !== 'string' || !REMOVED_PATH_PATTERN.test(removed)) {
      issues.push(`Removed path is malformed: ${JSON.stringify(removed)}.`);
      continue;
    }
    if (seen.has(removed)) issues.push(`Removed path /${removed} is listed more than once.`);
    seen.add(removed);
    if (live.paths.has(removed)) issues.push(`Removed path /${removed} exists again in a builder.`);
    if (catalogPaths.has(removed)) issues.push(`Removed path /${removed} is listed as live in the catalog.`);
  }
}

function checkAliases(catalog, live, issues) {
  const aliasOf = new Map();
  const ids = new Set();
  for (const group of catalog.COMMAND_ALIASES) {
    if (typeof group.id !== 'string' || !group.id) {
      issues.push('Alias group has no id.');
      continue;
    }
    if (ids.has(group.id)) issues.push(`Alias group "${group.id}" is declared more than once.`);
    ids.add(group.id);
    if (!Array.isArray(group.members) || group.members.length < 2) {
      issues.push(`Alias group "${group.id}" needs at least two members.`);
      continue;
    }
    for (const member of group.members) {
      if (!live.paths.has(member)) issues.push(`Alias group "${group.id}" names /${member}, which no builder defines.`);
      if (aliasOf.has(member)) {
        issues.push(`/${member} appears in alias groups "${aliasOf.get(member)}" and "${group.id}".`);
      }
      aliasOf.set(member, group.id);
    }
  }

  const buckets = new Map();
  for (const [commandPath, description] of live.descriptions) {
    const key = normalizeDescription(description);
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) || []), commandPath]);
  }
  for (const sharing of buckets.values()) {
    if (sharing.length < 2) continue;
    const groupIds = new Set(sharing.map((commandPath) => aliasOf.get(commandPath) ?? null));
    if (groupIds.size !== 1 || groupIds.has(null)) {
      issues.push(
        `Commands share the description ${JSON.stringify(live.descriptions.get(sharing[0]))} ` +
        `but are not declared as aliases of each other: ${sharing.map((commandPath) => `/${commandPath}`).join(', ')}.`
      );
    }
  }
}

function parseHelpUsages(helpText) {
  return [...String(helpText).matchAll(HELP_USAGE_PATTERN)].map((match) => ({
    name: match[1],
    subcommands: match[2] ? match[2].split('/') : [],
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// A removed path is "mentioned" when help names it as /command, as /command sub, or lists the
// subcommand inside a usage line.
function findRemovedMentions(helpText, removedPaths, usages) {
  const mentioned = [];
  for (const removed of removedPaths) {
    if (typeof removed !== 'string' || !REMOVED_PATH_PATTERN.test(removed)) continue;
    const [command, ...rest] = removed.split(' ');
    const subcommand = rest.join(' ');
    const slashForm = new RegExp(`(?<![A-Za-z0-9_/-])/${escapeRegExp(command)}${subcommand ? ` ${escapeRegExp(subcommand)}` : ''}(?![A-Za-z0-9_-])`, 'u');
    const listed = subcommand !== '' && usages.some((usage) => usage.name === command && usage.subcommands.includes(subcommand));
    if (slashForm.test(helpText) || listed) mentioned.push(removed);
  }
  return mentioned;
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

// The usage lines /help must show for one listed command, one list of subcommands per line:
// first what members can use, then what needs a server permission. Owner-only subcommands never
// appear. A command without subcommands has one line with none.
function expectedHelpUsages(entry) {
  const subcommands = Array.isArray(entry.subcommands) ? entry.subcommands : [];
  if (subcommands.length === 0) return [[]];
  return ['public', 'admin']
    .map((audience) => defaultCommandCatalog.listSubcommands(entry, audience))
    .filter((group) => group.length > 0);
}

function checkHelpText(catalog, helpText, issues) {
  const usages = parseHelpUsages(helpText);
  const expected = new Map(catalog.COMMAND_CATALOG.filter(isListedInHelp).map((entry) => [entry.name, entry]));
  const shown = new Map();
  for (const usage of usages) {
    if (!expected.has(usage.name)) {
      issues.push(`Help lists /${usage.name}, which the catalog does not list in help.`);
      continue;
    }
    shown.set(usage.name, [...(shown.get(usage.name) || []), usage]);
  }
  for (const [name, entry] of expected) {
    const lines = shown.get(name) || [];
    if (lines.length === 0) {
      issues.push(`Help does not list /${name}.`);
      continue;
    }
    const wanted = expectedHelpUsages(entry);
    if (lines.length > wanted.length) issues.push(`Help lists /${name} ${lines.length} times.`);
    const unmatched = [...lines];
    const missing = wanted.filter((group) => {
      const index = unmatched.findIndex((usage) => sameMembers(usage.subcommands, group));
      if (index < 0) return true;
      unmatched.splice(index, 1);
      return false;
    });
    // A repeated line is already reported above; a line that matches no expected group is a leak.
    const unexpected = unmatched.some((usage) => !wanted.some((group) => sameMembers(usage.subcommands, group)));
    if (missing.length > 0 || unexpected) {
      const wantedText = wanted.map((group) => (group.length > 0 ? `/${name} ${group.join('/')}` : `/${name}`)).join(', ');
      issues.push(`Help usage for /${name} differs from the catalog subcommands. Expected ${wantedText}.`);
    }
  }
  for (const removed of findRemovedMentions(helpText, catalog.REMOVED_COMMANDS, usages)) {
    issues.push(`Help mentions removed path /${removed}.`);
  }
}

// Renders the /help embed (title, description and fields) as one string for text checks.
function renderPublicHelpText(catalog = defaultCommandCatalog) {
  const { buildHelpEmbed } = require('./commands/help');
  const embed = buildHelpEmbed(catalog).toJSON();
  return [embed.title, embed.description, ...(embed.fields || []).flatMap((field) => [field.name, field.value])]
    .filter(Boolean)
    .join('\n');
}

/**
 * Compares the command catalog with serialized builder data and the /help output.
 * It never throws for catalog problems; it returns every issue it finds.
 * helpText: undefined renders the real /help, null skips the help checks, a string is used as given.
 */
function validateCommandCatalog(commandData, { catalog = defaultCommandCatalog, helpText } = {}) {
  const issues = [];
  const live = indexCommandData(commandData);
  const required = ['COMMAND_CATALOG', 'COMMAND_GROUPS', 'COMMAND_AUDIENCES', 'COMMAND_ALIASES', 'REMOVED_COMMANDS'];
  const missingParts = required.filter((key) => !Array.isArray(catalog?.[key]));
  if (missingParts.length > 0) {
    issues.push(`Command catalog is missing required lists: ${missingParts.join(', ')}.`);
    return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  }

  try {
    checkCatalogEntries(catalog, issues);
    checkCatalogAgainstBuilders(catalog, live, issues);
    checkRemovedPaths(catalog, live, issues);
    checkAliases(catalog, live, issues);

    let resolvedHelpText = helpText;
    if (resolvedHelpText === undefined) {
      try {
        resolvedHelpText = renderPublicHelpText(catalog);
      } catch (error) {
        resolvedHelpText = null;
        issues.push(`Help output could not be built: ${error.message}`);
      }
    }
    if (typeof resolvedHelpText === 'string') checkHelpText(catalog, resolvedHelpText, issues);
  } catch (error) {
    // A malformed catalog fails closed instead of crashing the caller.
    issues.push(`Catalog validation could not finish: ${error.message}`);
  }
  return Object.freeze({ ok: issues.length === 0, issues: Object.freeze(issues) });
}

// Deployment and `npm run check` call this: any disagreement stops the run.
function assertPublicCommandCatalog(
  commandData = loadCommandData(undefined, { scope: 'public' }),
  options = {},
) {
  const result = validateCommandCatalog(commandData, options);
  if (!result.ok) {
    const error = new Error(`Command catalog validation failed:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`);
    error.code = 'COMMAND_CATALOG_INVALID';
    error.issues = result.issues;
    throw error;
  }
  return result;
}

function warnOnCommandCatalogDrift(commands, { catalog, warn }) {
  try {
    const commandData = [...commands.values()]
      .filter((command) => command.xiaojiCommandSource === 'public-core')
      .map((command) => command.data.toJSON());
    const { issues } = validateCommandCatalog(commandData, { catalog });
    for (const issue of issues.slice(0, MAX_CATALOG_WARNINGS)) warn(`[COMMAND_CATALOG] ${issue}`);
    if (issues.length > MAX_CATALOG_WARNINGS) {
      warn(`[COMMAND_CATALOG] ${issues.length - MAX_CATALOG_WARNINGS} more issue(s) not shown.`);
    }
  } catch (error) {
    warn(`[COMMAND_CATALOG] Catalog validation could not run: ${error.message}`);
  }
}

module.exports = {
  assertNoPublicPrivateCommandCollisions,
  assertPublicCommandCatalog,
  getCommandFiles,
  loadCommandData,
  loadCommandModule,
  loadCommands,
  loadPrivateCommandGroups,
  normalizeDescription,
  validateCommandCatalog,
};
