'use strict';

// The status of every public slash command and subcommand on the public status page.
//
// Only the commands of src/platform/catalogs/commandCatalog.js are listed, so a command of an optional extension never appears, not
// even by name. Owner-only subcommands are left out, as in /help and the website guide.
//
// Each command and subcommand takes the worst of these, in this order:
// - offline (maintenance): the bot is not connected to Discord;
// - not_loaded (broken): the command is not loaded;
// - errors (broken): its last runs kept throwing (commandHealth.js);
// - feature: a public feature it belongs to is broken or under maintenance (src/services/publicStatusService.js);
// - service: an outside service it needs keeps failing, or is not configured (serviceHealth.js);
// - database (maintenance): the bot cannot read its database.
// A command is as bad as its worst subcommand. Only the status and this one word are published: never when a command
// ran, how often, by whom, or any error text.

const defaultCatalog = require('./catalogs/commandCatalog');
const { commandOutcomeStatus } = require('./commandHealth');
const { serviceStatus } = require('./serviceHealth');

const COMMAND_STATUS_REASONS = Object.freeze(['offline', 'not_loaded', 'errors', 'feature', 'service', 'database']);
const SEVERITY = Object.freeze({ normal: 0, maintenance: 1, broken: 2 });

// What each public command needs besides being loaded. Every command of the catalog has an entry, even an empty one
// (test/publicCommandStatus.test.js checks it), so a new command makes someone decide what it depends on.
// features: public feature keys (src/services/publicStatusService.js PUBLIC_FEATURES); services: serviceHealth.js names;
// serviceBrokenOnly: the command still answers without the service (another AI provider), so only a failing service
// lowers it; database: it reads or writes the bot's database. subcommands adds needs for single subcommands.
const ECONOMY = Object.freeze({ database: true });
const COMMAND_DEPENDENCIES = Object.freeze({
  ping: {},
  fortune: {},
  roll: {},
  weather: { features: ['weather'] },
  stock: { services: ['market_data'], subcommands: { watchlist: { database: true }, 'watch-add': { database: true }, 'watch-remove': { database: true } } },
  food: {
    subcommands: {
      recipe: { services: ['claude'], serviceBrokenOnly: true },
      nearby: { services: ['claude'], serviceBrokenOnly: true },
      add: { database: true },
      list: { database: true },
      remove: { database: true },
    },
  },
  poll: { features: ['poll'] },
  remind: { features: ['reminder'] },
  calendar: { features: ['calendar'] },
  'set-welcome': { features: ['welcome'] },
  'release-announcements': { database: true },
  server: {},
  status: {},
  'chat-style': { features: ['chat_style'] },
  romance: { features: ['romance'] },
  memory: { features: ['memory'] },
  student: { features: ['student'] },
  about: {},
  help: {},
  coins: { features: ['economy'] },
  daily: { features: ['economy'] },
  leaderboard: ECONOMY,
  shop: ECONOMY,
  inventory: ECONOMY,
  work: ECONOMY,
  bank: ECONOMY,
  exchange: ECONOMY,
  'casino-lobby': ECONOMY,
  'duel-tower': ECONOMY,
  casino: ECONOMY,
  'casino-venue': ECONOMY,
  luxury: ECONOMY,
  pawn: ECONOMY,
  board: ECONOMY,
  farm: ECONOMY,
  kitchen: ECONOMY,
  economy: { features: ['economy'] },
  'coin-admin': ECONOMY,
  'word-chain': { features: ['word_chain'] },
  'number-chain': { features: ['number_chain'] },
  'daily-riddle': { features: ['daily_riddle'] },
  'daily-discussion': { features: ['daily_discussion'] },
  'spark-relay': { database: true },
});

// The commands and subcommands the status page lists, in catalog order: [{ name, group, subcommands: [name] }].
function listPublicCommands(catalog = defaultCatalog) {
  return catalog.COMMAND_CATALOG
    .filter((command) => command.audience !== 'owner')
    .map((command) => ({
      name: command.name,
      group: command.group,
      subcommands: command.subcommands.filter((sub) => catalog.getSubcommandAudience(command, sub) !== 'owner'),
    }));
}

function worse(current, candidate) {
  return SEVERITY[candidate.status] > SEVERITY[current.status] ? candidate : current;
}

const NORMAL = Object.freeze({ status: 'normal', reason: null });

// The status of one command or subcommand path from its needs, the loaded state and the feature statuses.
function pathStatus({ command, subcommand, needs, ready, loaded, featureStatuses, databaseAvailable, nowMs }) {
  if (!ready) return { status: 'maintenance', reason: 'offline' };
  if (!loaded) return { status: 'broken', reason: 'not_loaded' };
  let result = NORMAL;
  if (commandOutcomeStatus(command, subcommand, nowMs) === 'broken') result = worse(result, { status: 'broken', reason: 'errors' });
  for (const feature of needs.features) {
    const status = featureStatuses.get(feature);
    if (status === 'broken' || status === 'maintenance') result = worse(result, { status, reason: 'feature' });
  }
  for (const { service, brokenOnly } of needs.services) {
    const status = serviceStatus(service, nowMs);
    if (status === 'broken') result = worse(result, { status, reason: 'service' });
    else if (status === 'maintenance' && !brokenOnly) result = worse(result, { status, reason: 'service' });
  }
  if (needs.database && !databaseAvailable) result = worse(result, { status: 'maintenance', reason: 'database' });
  return result;
}

function mergeNeeds(...entries) {
  const needs = { features: [], services: [], database: false };
  for (const entry of entries) {
    if (!entry) continue;
    needs.features.push(...(entry.features || []));
    needs.services.push(...(entry.services || []).map((service) => ({ service, brokenOnly: Boolean(entry.serviceBrokenOnly) })));
    needs.database ||= Boolean(entry.database);
  }
  return needs;
}

function isClientReady(client) {
  try {
    return typeof client?.isReady === 'function' ? client.isReady() : Boolean(client?.readyAt);
  } catch {
    return false;
  }
}

function isLoaded(client, name) {
  try {
    return Boolean(client?.commands?.has?.(name));
  } catch {
    return false;
  }
}

// features: the public feature statuses of the same snapshot ([{ key, status }]).
function buildCommandStatuses(client, features, {
  databaseAvailable = true,
  now = new Date(),
  catalog = defaultCatalog,
  dependencies = COMMAND_DEPENDENCIES,
} = {}) {
  const ready = isClientReady(client);
  const nowMs = now.getTime();
  const featureStatuses = new Map((features || []).map((feature) => [feature.key, feature.status]));

  return listPublicCommands(catalog).map((command) => {
    const own = dependencies[command.name] || {};
    const loaded = isLoaded(client, command.name);
    const context = { command: command.name, ready, loaded, featureStatuses, databaseAvailable, nowMs };
    let result = pathStatus({ ...context, subcommand: null, needs: mergeNeeds(own) });
    const subcommands = command.subcommands.map((subcommand) => {
      const status = pathStatus({ ...context, subcommand, needs: mergeNeeds(own, own.subcommands?.[subcommand]) });
      result = worse(result, status);
      return { key: subcommand, status: status.status, reason: status.reason };
    });
    return { key: command.name, status: result.status, reason: result.reason, subcommands };
  });
}

function summarizeCommands(commands) {
  return commands.reduce((summary, command) => {
    summary[command.status] += 1;
    return summary;
  }, { normal: 0, maintenance: 0, broken: 0 });
}

module.exports = {
  COMMAND_DEPENDENCIES,
  COMMAND_STATUS_REASONS,
  buildCommandStatuses,
  listPublicCommands,
  summarizeCommands,
};
