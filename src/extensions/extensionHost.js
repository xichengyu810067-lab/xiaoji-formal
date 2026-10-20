const fs = require('node:fs');
const path = require('node:path');
const { claimExtensionContextRunner } = require('../platform/extensionContext');
const { verifyAssemblyManifest } = require('./assemblyManifest');

const EXTENSION_API_VERSION = 1;
const PRIVATE_EXTENSION_PATH_ENV = 'XIAOJI_PRIVATE_EXTENSION_PATH';
const EXTENSION_ASSEMBLY_MANIFEST_ENV = 'XIAOJI_EXTENSION_ASSEMBLY_MANIFEST_PATH';
const SNOWFLAKE = /^\d{17,20}$/u;

// The host is the only code that opens the private extension context (src/platform/extensionContext.js),
// and it claims the runner once, when this module loads.
const extensionContextRunner = claimExtensionContextRunner();
// The extensions loadConfiguredPrivateExtension verified against the assembly manifest. Only these run in
// the private extension context; any other extension object, however it was built, runs without it.
const verifiedExtensions = new WeakSet();

// Where the guild a call came from is read, in this order; the first one the payload holds decides.
const SOURCE_GUILD_READERS = Object.freeze([
  ['interaction', (value) => value.guildId ?? value.guild?.id],
  ['message', (value) => value.guildId ?? value.guild?.id],
  ['member', (value) => value.guildId ?? value.guild?.id],
  ['channel', (value) => value.guildId ?? value.guild?.id],
  ['newState', (value) => value.guildId ?? value.guild?.id],
  ['oldState', (value) => value.guildId ?? value.guild?.id],
  ['guild', (value) => value.id],
  ['sourceGuildId', (value) => value],
]);

function sourceGuildIdOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const [key, read] of SOURCE_GUILD_READERS) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    let guildId;
    try { guildId = read(value); } catch { return null; }
    const normalized = typeof guildId === 'string' ? guildId : '';
    return SNOWFLAKE.test(normalized) ? normalized : null;
  }
  return null;
}

// What the context of a command records about the interaction it runs for: who ran it, and which
// interaction it is (extensionContext.js keeps only a digest of the token). Each field is read once; a
// payload whose reads fail gives none of them.
function commandBindingOf(interaction) {
  if (!interaction || typeof interaction !== 'object') return {};
  try {
    return { actorId: interaction.user?.id, interactionId: interaction.id, interactionToken: interaction.token };
  } catch {
    return {};
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || '').trim()).filter(Boolean))];
}

function getNestedFunction(target, dottedName) {
  let cursor = target;
  for (const part of dottedName.split('.')) cursor = cursor?.[part];
  return typeof cursor === 'function' ? cursor : null;
}

function validateExtension(extension, sourcePath, assembly = null) {
  if (!extension || typeof extension !== 'object') {
    throw new Error(`Private extension must export an object: ${sourcePath}`);
  }
  if (extension.apiVersion !== EXTENSION_API_VERSION) {
    throw new Error(`Unsupported private extension API version: ${sourcePath}`);
  }
  if (!extension.id || typeof extension.id !== 'string') {
    throw new Error(`Private extension must declare a stable id: ${sourcePath}`);
  }
  if (assembly && extension.id !== assembly.extensionId) {
    throw new Error(`Private extension id does not match the verified assembly: ${sourcePath}`);
  }
  for (const descriptor of asArray(extension.commandDirectories)) {
    if (!descriptor || !path.isAbsolute(descriptor.path) || !fs.existsSync(descriptor.path)) {
      throw new Error(`Private extension command directory is invalid: ${extension.id}`);
    }
    if (descriptor.guildIds !== undefined && !Array.isArray(descriptor.guildIds)) {
      throw new Error(`Private extension command directory guild scope is invalid: ${extension.id}`);
    }
    if (assembly) {
      const realDirectory = fs.realpathSync(descriptor.path);
      if (realDirectory !== assembly.extensionRoot && !realDirectory.startsWith(`${assembly.extensionRoot}${path.sep}`)) {
        throw new Error(`Private extension command directory is outside the verified assembly: ${extension.id}`);
      }
    }
  }
  return Object.freeze({ ...extension, sourcePath, assembly });
}

function loadConfiguredPrivateExtension({
  env = process.env,
  requireModule = require,
  projectRoot = path.join(__dirname, '..', '..'),
} = {}) {
  const configuredPath = String(env[PRIVATE_EXTENSION_PATH_ENV] || '').trim();
  if (!configuredPath) return null;
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`${PRIVATE_EXTENSION_PATH_ENV} must be an absolute path.`);
  }

  const resolvedPath = fs.existsSync(configuredPath) && fs.statSync(configuredPath).isDirectory()
    ? path.join(configuredPath, 'index.js')
    : configuredPath;
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configured private extension does not exist: ${resolvedPath}`);
  }

  const manifestPath = String(env[EXTENSION_ASSEMBLY_MANIFEST_ENV] || '').trim();
  if (!manifestPath) {
    throw new Error(`${EXTENSION_ASSEMBLY_MANIFEST_ENV} is required when a private extension is configured.`);
  }
  const assembly = verifyAssemblyManifest({
    deploymentRoot: projectRoot,
    configuredExtensionPath: configuredPath,
    manifestPath,
  });

  const loaded = requireModule(assembly.extensionEntry);
  const hostContext = Object.freeze({
    projectRoot: assembly.deploymentRoot,
    publicSrcRoot: assembly.publicSrcRoot,
    extensionRoot: assembly.extensionRoot,
    assemblyHash: assembly.assemblyHash,
  });
  const extension = typeof loaded?.createExtension === 'function'
    ? loaded.createExtension({ env, hostContext })
    : loaded;
  const verified = validateExtension(extension, assembly.extensionEntry, assembly);
  verifiedExtensions.add(verified);
  return verified;
}

function createExtensionHost(extensions = []) {
  const loadedExtensions = asArray(extensions).filter(Boolean);
  const commandOwners = new Map();

  for (const extension of loadedExtensions) {
    for (const commandName of uniqueStrings(extension.commandNames)) {
      if (commandOwners.has(commandName)) throw new Error(`Multiple private extensions own /${commandName}.`);
      commandOwners.set(commandName, extension.id);
    }
  }

  // Calls fn for extension: inside the private extension context when the extension was verified,
  // directly otherwise. The result, a thrown error included, is fn's own.
  function callExtension(extension, entry, name, payload, fn) {
    if (!verifiedExtensions.has(extension)) return fn();
    return extensionContextRunner.run({
      extensionId: extension.id,
      entry,
      name,
      sourceGuildId: sourceGuildIdOf(payload),
      ...(entry === 'command' ? commandBindingOf(payload?.interaction) : {}),
    }, fn);
  }

  return Object.freeze({
    extensions: Object.freeze([...loadedExtensions]),
    getCommandDirectories() {
      return loadedExtensions.flatMap((extension) => {
        const fallbackGuildIds = uniqueStrings(extension.deployment?.guildIds);
        return asArray(extension.commandDirectories).map((descriptor, index) => ({
          ...descriptor,
          extensionId: extension.id,
          commandGroupId: String(descriptor.id || `${extension.id}:${index}`),
          guildIds: uniqueStrings(descriptor.guildIds === undefined ? fallbackGuildIds : descriptor.guildIds),
        }));
      });
    },
    getDeploymentTargets() {
      return loadedExtensions.map((extension) => ({
        extensionId: extension.id,
        guildIds: uniqueStrings([
          ...uniqueStrings(extension.deployment?.guildIds),
          ...asArray(extension.commandDirectories).flatMap((descriptor) => uniqueStrings(descriptor.guildIds)),
        ]),
        cleanupGuildIds: uniqueStrings(extension.deployment?.cleanupGuildIds),
      }));
    },
    ownsCommand(commandName) {
      return commandOwners.has(commandName);
    },
    // The names of every command the loaded extensions own (none without an extension).
    ownedCommandNames() {
      return Object.freeze([...commandOwners.keys()]);
    },
    async preflight(context = {}) {
      for (const extension of loadedExtensions) {
        const check = getNestedFunction(extension, 'preflight');
        if (check) await callExtension(extension, 'preflight', 'preflight', context, () => check(context));
      }
    },
    async guardInteraction(context) {
      for (const extension of loadedExtensions) {
        const guard = getNestedFunction(extension, 'guards.interaction');
        if (!guard) continue;
        const result = await callExtension(extension, 'guard', 'guards.interaction', context, () => guard(context));
        if (result?.handled) return result;
      }
      return { handled: false };
    },
    async runHook(hookName, context = {}, { stopOnHandled = false } = {}) {
      const results = [];
      for (const extension of loadedExtensions) {
        const hook = getNestedFunction(extension, `hooks.${hookName}`);
        if (!hook) continue;
        const result = await callExtension(extension, 'hook', `hooks.${hookName}`, context, () => hook(context));
        results.push({ extensionId: extension.id, result });
        if (stopOnHandled && result?.handled) break;
      }
      return results;
    },
    // Runs command[method](interaction), where method is 'execute' or 'autocomplete'. A command runs in
    // the private extension context only when the command loader marked it as coming from a verified
    // extension of this host and that extension also owns the command name; any other command, the public
    // ones included, is called directly.
    async runCommand(command, method, interaction) {
      if (method !== 'execute' && method !== 'autocomplete') {
        throw new TypeError('runCommand runs a command\'s execute or autocomplete.');
      }
      const commandName = interaction?.commandName;
      const source = command?.xiaojiCommandSource;
      const owner = loadedExtensions.find((extension) => extension.id === source);
      if (owner && verifiedExtensions.has(owner) && commandOwners.get(commandName) === owner.id) {
        return callExtension(owner, 'command', `${commandName}.${method}`, { interaction },
          () => command[method](interaction));
      }
      return command[method](interaction);
    },
  });
}

function loadPrivateExtensionHost(options = {}) {
  const extension = loadConfiguredPrivateExtension(options);
  return createExtensionHost(extension ? [extension] : []);
}

function getClientExtensionHost(client) {
  return client?.extensionHost || createExtensionHost();
}

module.exports = {
  EXTENSION_API_VERSION,
  EXTENSION_ASSEMBLY_MANIFEST_ENV,
  PRIVATE_EXTENSION_PATH_ENV,
  createExtensionHost,
  getClientExtensionHost,
  loadConfiguredPrivateExtension,
  loadPrivateExtensionHost,
  validateExtension,
};
