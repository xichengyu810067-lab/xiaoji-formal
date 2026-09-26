const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'public-export', 'manifest.json');
const FORBIDDEN_SEGMENTS = new Set(['.git', 'data', 'database', 'deploy', 'logs', 'private', 'storage']);
const BOARD_STORAGE_SOURCES = new Set([
  'src/games/storage/boardSchema.js',
  'src/games/storage/sqliteBoardStore.js',
  'src/systems/games/board/storage/boardSchema.js',
  'src/systems/games/board/storage/sqliteBoardStore.js',
]);
const FORBIDDEN_FILE_NAMES = new Set([
  '.env',
  'ecosystem.config.cjs',
  'render.yaml',
  'deployment_evidence_b98b25f.md',
  'website_question.md',
]);
const FORBIDDEN_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /SYNTHETIC[_-]SECRET[_-]CANARY/i,
  /^(?:\s*export\s+)?(?:DISCORD_TOKEN|OPENAI_API_KEY|GROQ_API_KEY)\s*=\s*(?!your_|optional_|$)[^\s]+/gmi,
];

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe public export path: ${value}`);
  }
  return normalized;
}

function assertAllowedPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split('/');
  const isBoardStorageSource = BOARD_STORAGE_SOURCES.has(normalized);
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part.toLowerCase()) &&
      !(isBoardStorageSource && part.toLowerCase() === 'storage'))) {
    throw new Error(`Public export refuses protected path: ${normalized}`);
  }
  const baseName = parts.at(-1).toLowerCase();
  const isProtectedEnvironmentFile = baseName !== '.env.example'
    && (baseName === '.env' || baseName.startsWith('.env.'));
  if (FORBIDDEN_FILE_NAMES.has(baseName) || isProtectedEnvironmentFile) {
    throw new Error(`Public export refuses protected file: ${normalized}`);
  }
  if (/private-control|internal-report|production-check|deploy-to-vps|smoke-login/i.test(normalized)) {
    throw new Error(`Public export refuses internal operation file: ${normalized}`);
  }
  return normalized;
}

function walkFiles(rootPath, relativeRoot) {
  const absolute = path.join(rootPath, relativeRoot);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Public export refuses symbolic links: ${relativeRoot}`);
  if (stat.isFile()) return [assertAllowedPath(relativeRoot)];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    walkFiles(rootPath, path.posix.join(relativeRoot.replaceAll('\\', '/'), entry.name))
  );
}

function assertSafeContent(sourceRoot, relativePath) {
  const absolute = path.join(sourceRoot, relativePath);
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return;
  const text = buffer.toString('utf8');
  for (const pattern of FORBIDDEN_CONTENT) {
    if (pattern.test(text)) throw new Error(`Public export rejected sensitive content in ${relativePath}`);
  }
}

function buildPublicExportPlan({ sourceRoot = path.join(__dirname, '..'), manifestPath = DEFAULT_MANIFEST_PATH, manifest } = {}) {
  const resolvedManifest = manifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    resolvedManifest.version !== 1
    || !Array.isArray(resolvedManifest.paths)
    || (resolvedManifest.excludePaths !== undefined && !Array.isArray(resolvedManifest.excludePaths))
  ) {
    throw new Error('Unsupported public export manifest.');
  }
  const excludedFiles = new Set((resolvedManifest.excludePaths || []).map((entry) => {
    const relativePath = assertAllowedPath(entry);
    const absolutePath = path.join(sourceRoot, relativePath);
    if (fs.existsSync(absolutePath) && !fs.lstatSync(absolutePath).isFile()) {
      throw new Error(`Public export exclusion may name only a file: ${relativePath}`);
    }
    return relativePath;
  }));
  const files = [...new Set(resolvedManifest.paths.flatMap((entry) => {
    const relativePath = assertAllowedPath(entry);
    const absolutePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`Allowlisted path is missing: ${relativePath}`);
    return walkFiles(sourceRoot, relativePath);
  }))].filter((file) => !excludedFiles.has(file)).sort();
  for (const file of files) assertSafeContent(sourceRoot, file);
  return files;
}

function sanitizePublicPackage(outputPath) {
  const packagePath = path.join(outputPath, 'package.json');
  if (!fs.existsSync(packagePath)) return;
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const privateOperationScripts = [
    'smoke:login',
    'prod:check',
    'pm2:start',
    'pm2:restart',
    'pm2:status',
    'pm2:logs',
    'admission:init',
    'admission:before-update',
    'admission:after-update',
  ];
  for (const scriptName of privateOperationScripts) delete packageJson.scripts?.[scriptName];
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

function exportPublicFiles({ sourceRoot = path.join(__dirname, '..'), outputPath, manifestPath, manifest, dryRun = false } = {}) {
  const files = buildPublicExportPlan({ sourceRoot, manifestPath, manifest });
  if (dryRun) return { dryRun: true, files };
  if (!outputPath) throw new Error('An output path is required unless --dry-run is used.');
  const resolvedOutput = path.resolve(outputPath);
  if (fs.existsSync(resolvedOutput)) throw new Error(`Public export output already exists: ${resolvedOutput}`);
  fs.mkdirSync(resolvedOutput);
  for (const relativePath of files) {
    const destination = path.join(resolvedOutput, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relativePath), destination, fs.constants.COPYFILE_EXCL);
  }
  sanitizePublicPackage(resolvedOutput);
  return { dryRun: false, files, outputPath: resolvedOutput };
}

function parseCli(argv) {
  const dryRun = argv.includes('--dry-run');
  const outputIndex = argv.indexOf('--output');
  return { dryRun, outputPath: outputIndex >= 0 ? argv[outputIndex + 1] : null };
}

if (require.main === module) {
  try {
    const result = exportPublicFiles(parseCli(process.argv.slice(2)));
    console.log(`Public export ${result.dryRun ? 'dry run' : 'prepared'}: ${result.files.length} files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  assertAllowedPath,
  buildPublicExportPlan,
  exportPublicFiles,
};
