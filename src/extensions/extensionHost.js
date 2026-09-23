const fs = require('node:fs');
const path = require('node:path');
const { verifyAssemblyManifest } = require('./assemblyManifest');

const EXTENSION_API_VERSION = 1;
const PRIVATE_EXTENSION_PATH_ENV = 'XIAOJI_PRIVATE_EXTENSION_PATH';
const EXTENSION_ASSEMBLY_MANIFEST_ENV = 'XIAOJI_EXTENSION_ASSEMBLY_MANIFEST_PATH';

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
  return validateExtension(extension, assembly.extensionEntry, assembly);
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

  return Object.freeze({
    extensions: Object.freeze([...loadedExtensions]),
    getCommandDirectories() {
      return loadedExtensions.flatMap((extension) =>
        asArray(extension.commandDirectories).map((descriptor) => ({ ...descriptor, extensionId: extension.id }))
      );
    },
    getDeploymentTargets() {
      return loadedExtensions.map((extension) => ({
        extensionId: extension.id,
        guildIds: uniqueStrings(extension.deployment?.guildIds),
        cleanupGuildIds: uniqueStrings(extension.deployment?.cleanupGuildIds),
      }));
    },
    ownsCommand(commandName) {
      return commandOwners.has(commandName);
    },
    async guardInteraction(context) {
      for (const extension of loadedExtensions) {
        const guard = getNestedFunction(extension, 'guards.interaction');
        if (!guard) continue;
        const result = await guard(context);
        if (result?.handled) return result;
      }
      return { handled: false };
    },
    async runHook(hookName, context = {}, { stopOnHandled = false } = {}) {
      const results = [];
      for (const extension of loadedExtensions) {
        const hook = getNestedFunction(extension, `hooks.${hookName}`);
        if (!hook) continue;
        const result = await hook(context);
        results.push({ extensionId: extension.id, result });
        if (stopOnHandled && result?.handled) break;
      }
      return results;
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
