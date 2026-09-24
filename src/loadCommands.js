const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');
const { createExtensionHost } = require('./extensions/extensionHost');

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

function loadCommands(commandsPath, { extensionHost = createExtensionHost() } = {}) {
  const commands = new Collection();
  addCommandDirectory(commands, commandsPath || path.join(__dirname, 'commands'), 'public-core');
  for (const descriptor of extensionHost.getCommandDirectories()) {
    addCommandDirectory(commands, descriptor.path, descriptor.extensionId);
  }
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
    return [
      ...loadCommandData(commandsPath, { scope: 'public', extensionHost }),
      ...loadCommandData(commandsPath, { scope: 'private', extensionHost }),
    ];
  }
  throw new Error(`Unknown command scope: ${scope}`);
}

module.exports = {
  getCommandFiles,
  loadCommandData,
  loadCommandModule,
  loadCommands,
  loadPrivateCommandGroups,
};
