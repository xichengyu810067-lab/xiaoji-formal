const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSEMBLY_SCHEMA_VERSION = 1;
const ASSEMBLY_CONTRACT_VERSION = 2;
const HASH_ALGORITHM = 'sha256';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function hashText(value) {
  return crypto.createHash(HASH_ALGORITHM).update(value).digest('hex');
}

function hashFile(filePath) {
  return crypto.createHash(HASH_ALGORITHM).update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeRelativePath(value, label = 'path') {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (
    !normalized
    || normalized === '.'
    || path.posix.isAbsolute(normalized)
    || parts.some((part) => !part || part === '.' || part === '..')
    || /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Assembly ${label} must be a safe relative path: ${value}`);
  }
  return normalized;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Assembly contract ${label} must be an array.`);
  return [...new Set(value.map((item) => normalizeRelativePath(item, label)))].sort();
}

function resolveRoot(deploymentRoot) {
  if (!deploymentRoot) throw new Error('Assembly deployment root is required.');
  const resolved = fs.realpathSync(path.resolve(deploymentRoot));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Assembly deployment root must be a directory.');
  return resolved;
}

function resolveInsideRoot(deploymentRoot, relativePath, { type = 'file' } = {}) {
  const root = resolveRoot(deploymentRoot);
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(root, ...normalized.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Assembly path escapes deployment root: ${normalized}`);
  if (!fs.existsSync(target)) throw new Error(`Assembly source is missing: ${normalized}`);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`Assembly source must not be a symbolic link: ${normalized}`);
  if (type === 'file' && !stat.isFile()) throw new Error(`Assembly source must be a file: ${normalized}`);
  if (type === 'directory' && !stat.isDirectory()) throw new Error(`Assembly source must be a directory: ${normalized}`);
  const realTarget = fs.realpathSync(target);
  if (!realTarget.startsWith(`${root}${path.sep}`)) throw new Error(`Assembly source resolves outside deployment root: ${normalized}`);
  return realTarget;
}

function walkJavaScriptFiles(deploymentRoot, relativeRoot) {
  const normalizedRoot = normalizeRelativePath(relativeRoot, 'JavaScript root');
  const absoluteRoot = resolveInsideRoot(deploymentRoot, normalizedRoot, { type: 'directory' });
  const files = [];

  function walk(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Assembly source must not be a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(normalizeRelativePath(relativePath));
      }
    }
  }

  walk(absoluteRoot, normalizedRoot);
  return files.sort();
}

function readAssemblyContract(deploymentRoot, contractPath) {
  const normalizedContractPath = normalizeRelativePath(contractPath, 'contract path');
  const absoluteContractPath = resolveInsideRoot(deploymentRoot, normalizedContractPath);
  const contract = JSON.parse(fs.readFileSync(absoluteContractPath, 'utf8'));
  if (contract.version !== ASSEMBLY_CONTRACT_VERSION) {
    throw new Error(`Unsupported assembly contract version: ${contract.version}`);
  }
  if (!contract.extensionId || typeof contract.extensionId !== 'string') {
    throw new Error('Assembly contract must declare an extension id.');
  }

  const extensionRelativePath = normalizeRelativePath(contract.extensionRelativePath, 'extension root');
  const extensionEntryPath = normalizeRelativePath(contract.extensionEntryPath, 'extension entry');
  if (!extensionEntryPath.startsWith(`${extensionRelativePath}/`)) {
    throw new Error('Assembly extension entry must stay inside the extension root.');
  }

  return Object.freeze({
    version: contract.version,
    extensionId: contract.extensionId,
    extensionRelativePath,
    extensionEntryPath,
    publicJavaScriptRoots: normalizeStringArray(contract.publicJavaScriptRoots, 'publicJavaScriptRoots'),
    publicRuntimeFiles: normalizeStringArray(contract.publicRuntimeFiles, 'publicRuntimeFiles'),
    extensionJavaScriptRoots: normalizeStringArray(contract.extensionJavaScriptRoots, 'extensionJavaScriptRoots'),
    extensionRuntimeFiles: normalizeStringArray(contract.extensionRuntimeFiles, 'extensionRuntimeFiles'),
    privateRuntimeFiles: normalizeStringArray(contract.privateRuntimeFiles || [], 'privateRuntimeFiles'),
    requiredSharedFiles: normalizeStringArray(contract.requiredSharedFiles, 'requiredSharedFiles'),
    contractPath: normalizedContractPath,
  });
}

function buildAssemblyFilePlan(deploymentRoot, contractPath) {
  const contract = readAssemblyContract(deploymentRoot, contractPath);
  const publicFiles = new Set([...contract.publicRuntimeFiles, ...contract.requiredSharedFiles]);
  const extensionFiles = new Set([...contract.extensionRuntimeFiles, ...contract.privateRuntimeFiles, contract.contractPath]);

  for (const root of contract.publicJavaScriptRoots) {
    for (const file of walkJavaScriptFiles(deploymentRoot, root)) publicFiles.add(file);
  }
  for (const root of contract.extensionJavaScriptRoots) {
    if (!root.startsWith(`${contract.extensionRelativePath}/`) && root !== contract.extensionRelativePath) {
      throw new Error(`Extension JavaScript root is outside the extension: ${root}`);
    }
    for (const file of walkJavaScriptFiles(deploymentRoot, root)) extensionFiles.add(file);
  }

  for (const file of publicFiles) {
    if (file === contract.extensionRelativePath || file.startsWith(`${contract.extensionRelativePath}/`)) {
      throw new Error(`Public assembly source overlaps the extension: ${file}`);
    }
    resolveInsideRoot(deploymentRoot, file);
  }
  for (const file of extensionFiles) {
    if (!file.startsWith(`${contract.extensionRelativePath}/`) &&
      !(contract.privateRuntimeFiles.includes(file) && file.startsWith('private/'))) {
      throw new Error(`Extension assembly source is outside the extension: ${file}`);
    }
    resolveInsideRoot(deploymentRoot, file);
  }
  if (!extensionFiles.has(contract.extensionEntryPath)) {
    throw new Error('Assembly plan does not include the extension entry.');
  }

  return Object.freeze({
    contract,
    publicFiles: Object.freeze([...publicFiles].sort()),
    extensionFiles: Object.freeze([...extensionFiles].sort()),
  });
}

function createFileRecords(deploymentRoot, files) {
  return files.map((relativePath) => ({
    path: relativePath,
    sha256: hashFile(resolveInsideRoot(deploymentRoot, relativePath)),
  }));
}

function normalizeFileRecords(records, label) {
  if (!Array.isArray(records) || !records.length) throw new Error(`Assembly ${label} file list is empty.`);
  const normalized = records.map((record) => {
    const relativePath = normalizeRelativePath(record?.path, `${label} source`);
    const sha256 = String(record?.sha256 || '').toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`Assembly ${label} source hash is invalid: ${relativePath}`);
    return { path: relativePath, sha256 };
  }).sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  if (new Set(normalized.map((record) => record.path)).size !== normalized.length) {
    throw new Error(`Assembly ${label} source list contains duplicates.`);
  }
  return normalized;
}

function computeSourceDigest(records) {
  return hashText(JSON.stringify(normalizeFileRecords(records, 'source')));
}

function normalizeManifest(manifest) {
  if (manifest?.schemaVersion !== ASSEMBLY_SCHEMA_VERSION) {
    throw new Error(`Unsupported assembly manifest version: ${manifest?.schemaVersion}`);
  }
  if (manifest.algorithm !== HASH_ALGORITHM) throw new Error(`Unsupported assembly hash algorithm: ${manifest.algorithm}`);
  const publicFiles = normalizeFileRecords(manifest.sources?.public?.files, 'public');
  const extensionFiles = normalizeFileRecords(manifest.sources?.extension?.files, 'extension');
  const normalized = {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    algorithm: HASH_ALGORITHM,
    contractPath: normalizeRelativePath(manifest.contractPath, 'contract path'),
    extension: {
      id: String(manifest.extension?.id || ''),
      relativePath: normalizeRelativePath(manifest.extension?.relativePath, 'extension root'),
      entryPath: normalizeRelativePath(manifest.extension?.entryPath, 'extension entry'),
    },
    requiredSharedFiles: normalizeStringArray(manifest.requiredSharedFiles, 'requiredSharedFiles'),
    sources: {
      public: { digest: String(manifest.sources?.public?.digest || '').toLowerCase(), files: publicFiles },
      extension: { digest: String(manifest.sources?.extension?.digest || '').toLowerCase(), files: extensionFiles },
    },
  };
  if (!normalized.extension.id) throw new Error('Assembly manifest extension id is missing.');
  if (!SHA256_PATTERN.test(normalized.sources.public.digest)) throw new Error('Assembly public source digest is invalid.');
  if (!SHA256_PATTERN.test(normalized.sources.extension.digest)) throw new Error('Assembly extension source digest is invalid.');
  return normalized;
}

function computeAssemblyHash(manifest) {
  return hashText(JSON.stringify(normalizeManifest(manifest)));
}

function createAssemblyManifest({ deploymentRoot, contractPath }) {
  const root = resolveRoot(deploymentRoot);
  const plan = buildAssemblyFilePlan(root, contractPath);
  const publicFiles = createFileRecords(root, plan.publicFiles);
  const extensionFiles = createFileRecords(root, plan.extensionFiles);
  const manifest = {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    algorithm: HASH_ALGORITHM,
    contractPath: plan.contract.contractPath,
    extension: {
      id: plan.contract.extensionId,
      relativePath: plan.contract.extensionRelativePath,
      entryPath: plan.contract.extensionEntryPath,
    },
    requiredSharedFiles: plan.contract.requiredSharedFiles,
    sources: {
      public: { digest: computeSourceDigest(publicFiles), files: publicFiles },
      extension: { digest: computeSourceDigest(extensionFiles), files: extensionFiles },
    },
  };
  return Object.freeze({ ...manifest, assemblyHash: computeAssemblyHash(manifest) });
}

function writeAssemblyManifest({ deploymentRoot, contractPath, outputPath }) {
  if (!path.isAbsolute(outputPath || '')) throw new Error('Assembly manifest output path must be absolute.');
  const manifest = createAssemblyManifest({ deploymentRoot, contractPath });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function assertSamePaths(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Assembly ${label} source list does not match the contract.`);
  }
}

function resolveConfiguredEntry(configuredExtensionPath) {
  if (!path.isAbsolute(configuredExtensionPath || '')) {
    throw new Error('Configured extension path must be absolute.');
  }
  if (!fs.existsSync(configuredExtensionPath)) throw new Error(`Configured extension does not exist: ${configuredExtensionPath}`);
  const stat = fs.lstatSync(configuredExtensionPath);
  if (stat.isSymbolicLink()) throw new Error('Configured extension path must not be a symbolic link.');
  const entryPath = stat.isDirectory() ? path.join(configuredExtensionPath, 'index.js') : configuredExtensionPath;
  if (!fs.existsSync(entryPath) || !fs.lstatSync(entryPath).isFile()) {
    throw new Error(`Configured extension entry does not exist: ${entryPath}`);
  }
  return fs.realpathSync(entryPath);
}

function verifyAssemblyManifest({ deploymentRoot, configuredExtensionPath, manifestPath }) {
  const root = resolveRoot(deploymentRoot);
  if (!path.isAbsolute(manifestPath || '')) throw new Error('Assembly manifest path must be absolute.');
  if (!fs.existsSync(manifestPath)) throw new Error(`Assembly manifest does not exist: ${manifestPath}`);
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Assembly manifest must not be a symbolic link.');

  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const normalized = normalizeManifest(parsed);
  const declaredAssemblyHash = String(parsed.assemblyHash || '').toLowerCase();
  if (!SHA256_PATTERN.test(declaredAssemblyHash) || computeAssemblyHash(normalized) !== declaredAssemblyHash) {
    throw new Error('Assembly manifest hash does not match its contents.');
  }
  if (computeSourceDigest(normalized.sources.public.files) !== normalized.sources.public.digest) {
    throw new Error('Assembly public source digest does not match its file list.');
  }
  if (computeSourceDigest(normalized.sources.extension.files) !== normalized.sources.extension.digest) {
    throw new Error('Assembly extension source digest does not match its file list.');
  }

  const plan = buildAssemblyFilePlan(root, normalized.contractPath);
  if (
    normalized.extension.id !== plan.contract.extensionId
    || normalized.extension.relativePath !== plan.contract.extensionRelativePath
    || normalized.extension.entryPath !== plan.contract.extensionEntryPath
  ) {
    throw new Error('Assembly extension metadata does not match the contract.');
  }
  assertSamePaths(normalized.requiredSharedFiles, plan.contract.requiredSharedFiles, 'required shared');
  assertSamePaths(normalized.sources.public.files.map((record) => record.path), plan.publicFiles, 'public');
  assertSamePaths(normalized.sources.extension.files.map((record) => record.path), plan.extensionFiles, 'extension');

  const expectedEntry = resolveInsideRoot(root, plan.contract.extensionEntryPath);
  const configuredEntry = resolveConfiguredEntry(configuredExtensionPath);
  if (configuredEntry !== expectedEntry) {
    throw new Error('Configured extension is outside the fixed deployment-root topology.');
  }

  for (const [sourceName, records] of Object.entries({
    public: normalized.sources.public.files,
    extension: normalized.sources.extension.files,
  })) {
    for (const record of records) {
      const actualHash = hashFile(resolveInsideRoot(root, record.path));
      if (actualHash !== record.sha256) {
        throw new Error(`Assembly ${sourceName} source hash mismatch: ${record.path}`);
      }
    }
  }

  return Object.freeze({
    assemblyHash: declaredAssemblyHash,
    publicSourceHash: normalized.sources.public.digest,
    extensionSourceHash: normalized.sources.extension.digest,
    extensionId: normalized.extension.id,
    deploymentRoot: root,
    publicSrcRoot: resolveInsideRoot(root, 'src', { type: 'directory' }),
    extensionRoot: resolveInsideRoot(root, normalized.extension.relativePath, { type: 'directory' }),
    extensionEntry: expectedEntry,
  });
}

module.exports = {
  ASSEMBLY_CONTRACT_VERSION,
  ASSEMBLY_SCHEMA_VERSION,
  HASH_ALGORITHM,
  buildAssemblyFilePlan,
  computeAssemblyHash,
  computeSourceDigest,
  createAssemblyManifest,
  normalizeManifest,
  verifyAssemblyManifest,
  writeAssemblyManifest,
};
