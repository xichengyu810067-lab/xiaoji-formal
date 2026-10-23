const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'public-export', 'manifest.json');
// "live-test" holds the private live-test tooling (tools/live-test): hard-coded private guild IDs
// and a message deletion tool. It must never be exported, even if the manifest lists it by mistake.
// The "live_test" spelling is refused too, and so is any file whose name starts with "livetest"
// (the tests and fixtures of that tooling, such as test/liveTestCleanup.test.js).
// ".wrangler" is Wrangler's local state (a cached account ID, the local database) and ".cookies" holds
// browser cookies; .gitignore keeps both out of Git, and an export refuses them even where there is no git.
const FORBIDDEN_SEGMENTS = new Set([
  '.cookies', '.git', '.wrangler', 'data', 'database', 'deploy', 'live-test', 'live_test', 'logs', 'private',
  'storage',
]);
const LIVE_TEST_FILE_NAME_PATTERN = /^livetest/i;
const BOARD_STORAGE_SOURCES = new Set([
  'src/games/storage/boardSchema.js',
  'src/games/storage/sqliteBoardStore.js',
  'src/systems/games/board/storage/boardSchema.js',
  'src/systems/games/board/storage/sqliteBoardStore.js',
]);
// Files that hold local secrets, refused by name. .env and .env.* (but not .env.example) are handled
// separately below. The others are the names .gitignore keeps out of Git for the same reason, so that a
// copy without git, which cannot ask what git ignores, still refuses them: Wrangler's .dev.vars, the
// private extension's runtime.env, and cookie files. A template named .dev.vars.example is not a secret.
const FORBIDDEN_FILE_NAMES = new Set([
  '.env',
  'ecosystem.config.cjs',
  'render.yaml',
  'deployment_evidence_b98b25f.md',
  'website_question.md',
  '.dev.vars',
  'runtime.env',
  'cookies.txt',
]);
const SECRET_FILE_NAME_PATTERNS = [
  /^\.dev\.vars\.(?!example$)/, // .dev.vars.production: Wrangler's local secrets for one environment
  /\.cookies\.txt$/,
  /^youtube-cookies.*\.txt$/,
];
const FORBIDDEN_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /SYNTHETIC[_-]SECRET[_-]CANARY/i,
  // Spaces and tabs only around "=": an empty value must not run on into the next line's key.
  /^(?:[ \t]*export[ \t]+)?(?:DISCORD_TOKEN|OPENAI_API_KEY|GROQ_API_KEY|ANTHROPIC_API_KEY|TURSO_AUTH_TOKEN|JEV_API_KEY)[ \t]*=[ \t]*(?!your_|optional_|$)[^\s]+/gmi,
];

// Turtle-soup scenarios, their answers, and the retrieval index are private. Three layers keep
// them out of a public export: a file-name rule, a JSON-key rule, and one explicit exception list.
const JSON_FAMILY = '(?:json[c5l]?|ndjson)';
// Not anchored to the start and not tied to an extension, so copies are refused too:
// backup-retrieval-index.json, retrieval-index.v1.json.bak, and the .tmp file the index builder
// itself leaves behind when a write fails.
const SCENARIO_INDEX_FILE_PATTERN = /retrieval-index/i;
const SCENARIO_DOCUMENT_FILE_PATTERN = new RegExp(`scenario.*\\.${JSON_FAMILY}$`, 'i');
const JSON_FAMILY_FILE_PATTERN = new RegExp(`\\.${JSON_FAMILY}$`, 'i');
// Key names compare after lower-casing and dropping separators, so revealText, reveal_text and
// Reveal-Text are one rule. Bare words such as "reveal" are deliberately not listed.
const FORBIDDEN_SCENARIO_KEYS = new Set([
  'revealtext',
  'solution',
  'solutions',
  'solutiontext',
  'solutionfactids',
  'answer',
  'answers',
  'answertext',
  'correctanswer',
  '湯底',
  '答案',
  '解答',
]);
// Written as code, not as an invisible character, so editors cannot strip it.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const SYNTHETIC_FIXTURE_ROOT = 'test/fixtures/';
// The ONLY way a scenario-shaped file may be exported: a hand-written, synthetic test fixture
// named here by its exact path under test/fixtures/. Never list a real corpus file. The repository
// has no such fixture today (the runtime tests build theirs in memory), so the list is empty.
const SYNTHETIC_SCENARIO_FIXTURES = Object.freeze([]);

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe public export path: ${value}`);
  }
  return normalized;
}

// Builds the exact-path exception set. Entries outside test/fixtures/ or that are not JSON files
// are rejected so the list cannot be used to exempt production or data paths.
function normalizeSyntheticFixtures(entries = SYNTHETIC_SCENARIO_FIXTURES) {
  return new Set(Array.from(entries, (entry) => {
    const normalized = normalizeRelativePath(entry);
    if (!normalized.startsWith(SYNTHETIC_FIXTURE_ROOT) || !JSON_FAMILY_FILE_PATTERN.test(normalized)) {
      throw new Error(`Synthetic scenario fixture must be a JSON file under ${SYNTHETIC_FIXTURE_ROOT}: ${normalized}`);
    }
    return normalized;
  }));
}

function resolveSyntheticFixtures(syntheticFixtures) {
  return syntheticFixtures instanceof Set ? syntheticFixtures : normalizeSyntheticFixtures(syntheticFixtures);
}

function assertAllowedPath(relativePath, { syntheticFixtures } = {}) {
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
  if (FORBIDDEN_FILE_NAMES.has(baseName) || isProtectedEnvironmentFile || LIVE_TEST_FILE_NAME_PATTERN.test(baseName)
      || SECRET_FILE_NAME_PATTERNS.some((pattern) => pattern.test(baseName))) {
    throw new Error(`Public export refuses protected file: ${normalized}`);
  }
  if (baseName === 'agents.md' || /(?:^|[-_])(?:plan|planning|test[-_]report|local[-_]record|development[-_]log)(?:[-_.]|$)/i.test(baseName) && baseName.endsWith('.md')) {
    throw new Error(`Public export refuses internal document: ${normalized}`);
  }
  if (/private-control|internal-report|production-check|deploy-to-vps|smoke-login/i.test(normalized)) {
    throw new Error(`Public export refuses internal operation file: ${normalized}`);
  }
  if ((SCENARIO_INDEX_FILE_PATTERN.test(baseName) || SCENARIO_DOCUMENT_FILE_PATTERN.test(baseName))
      && !resolveSyntheticFixtures(syntheticFixtures).has(normalized)) {
    throw new Error(`Public export refuses scenario corpus file: ${normalized}`);
  }
  return normalized;
}

// The variables git reads to find a repository, its index and its objects. A command that runs inside a
// git hook, or inside `git rebase -x`, inherits them, and a git command started there then works on that
// repository instead of the directory it was pointed at: `git add` in a throwaway test repository would
// stage into the real index. Every git command of this script, and of the tests that build such a
// repository, runs without them. git lists them itself (git rev-parse --local-env-vars); the names below
// are the ones that hold when git cannot say. The variables that only pass configuration (GIT_CONFIG,
// GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT) are kept, so a `git -c ...` of the caller still applies.
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
];
const GIT_CONFIGURATION_VARIABLES = new Set(['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']);
let gitLocationVariables = null;

function withoutVariables(environment, names) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !names.has(name.toUpperCase())));
}

// A copy of `environment` (the process's own by default) for a git command: without the variables above.
function gitEnvironment(environment = process.env) {
  if (gitLocationVariables === null) {
    const names = new Set(GIT_LOCATION_VARIABLES);
    const listed = spawnSync('git', ['rev-parse', '--local-env-vars'], {
      encoding: 'utf8',
      windowsHide: true,
      env: withoutVariables(process.env, names),
    });
    if (!listed.error && listed.status === 0) {
      for (const name of listed.stdout.split(/\s+/u)) {
        if (/^GIT_[A-Z0-9_]+$/u.test(name) && !GIT_CONFIGURATION_VARIABLES.has(name)) names.add(name);
      }
    }
    gitLocationVariables = names;
  }
  return withoutVariables(environment, gitLocationVariables);
}

// The files git ignores and does not track, as paths below sourceRoot ("dir/" for a whole directory):
// local secrets, build output, caches, the bot's runtime data. A manifest directory is read from disk, so
// without this such files would be exported along with the sources, and read by the content screen.
// Returns null when sourceRoot is not a git work tree (an exported copy, an archive): there every file
// on disk counts, as it always did. `.git` is a directory, or a file in a linked work tree. Only the
// repository's own .gitignore files decide, never a global or per-clone exclude file. (git's core.ignorecase
// differs between operating systems, so how a pattern matches letter case can too; the secret file names
// are compared in lower case, so that cannot let one through.) When git cannot answer, the export fails
// instead of guessing.
function listIgnoredUntracked(sourceRoot) {
  return listUntrackedFiles(sourceRoot, ['--ignored', '--directory'], 'ignored');
}

// The files git does not track and does not ignore: nobody has decided about them (a scratch note, a
// draft). The paths are relative to sourceRoot; null when sourceRoot is not a git work tree.
function listUntrackedUnignored(sourceRoot) {
  return listUntrackedFiles(sourceRoot, [], 'untracked');
}

function listUntrackedFiles(sourceRoot, flags, what) {
  if (!fs.existsSync(path.join(sourceRoot, '.git'))) return null;
  const result = spawnSync('git', [
    'ls-files', '-z', '--others', '--exclude-per-directory=.gitignore', ...flags,
  ], { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: gitEnvironment() });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : String(result.stderr || '').trim().split('\n')[0];
    throw new Error(`Public export could not ask git which files are ${what}: ${reason}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

// Is the path, or a directory above it, in the list listIgnoredUntracked returned?
function isIgnoredUntracked(relativePath, ignored) {
  if (!ignored) return false;
  return ignored.some((entry) => (entry.endsWith('/')
    ? relativePath.startsWith(entry) || `${relativePath}/` === entry
    : relativePath === entry));
}

function walkFiles(rootPath, relativeRoot, options) {
  if (isIgnoredUntracked(relativeRoot.replaceAll('\\', '/'), options.ignored)) return [];
  const absolute = path.join(rootPath, relativeRoot);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Public export refuses symbolic links: ${relativeRoot}`);
  if (stat.isFile()) return [assertAllowedPath(relativeRoot, options)];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    walkFiles(rootPath, path.posix.join(relativeRoot.replaceAll('\\', '/'), entry.name), options)
  );
}

// Returns the normalized name of the first scenario-shaped key anywhere in parsed JSON, or null.
// Iterative on purpose: a hostile, deeply nested file must not overflow the stack.
function findForbiddenScenarioKey(root) {
  const pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = normalizeScenarioKey(key);
        if (FORBIDDEN_SCENARIO_KEYS.has(normalizedKey)) return normalizedKey;
        pending.push(child);
      }
    }
  }
  return null;
}

function normalizeScenarioKey(key) {
  return String(key).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// JSON that does not parse (JSON Lines, comments, truncation) is still screened: every quoted
// string followed by a colon is treated as a key, with JSON string escapes decoded first.
function findForbiddenScenarioKeyInText(text) {
  for (const match of text.matchAll(/"((?:[^"\\\r\n]|\\.)*)"\s*:/gu)) {
    let key = match[1];
    try {
      key = JSON.parse(`"${key}"`);
    } catch {
      // Keep the raw text; an undecodable escape cannot hide a plain-text key.
    }
    const normalizedKey = normalizeScenarioKey(key);
    if (FORBIDDEN_SCENARIO_KEYS.has(normalizedKey)) return normalizedKey;
  }
  return null;
}

function assertNoScenarioContent(buffer, relativePath) {
  // A NUL byte means UTF-16 or binary data the text screen below cannot read. For a JSON file
  // that is a way to hide a corpus, so fail closed instead of skipping it.
  if (buffer.includes(0)) {
    throw new Error(`Public export refuses unreadable JSON content in ${relativePath}`);
  }
  const decoded = buffer.toString('utf8');
  const text = decoded.startsWith(BYTE_ORDER_MARK) ? decoded.slice(BYTE_ORDER_MARK.length) : decoded;
  let forbiddenKey;
  try {
    forbiddenKey = findForbiddenScenarioKey(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    forbiddenKey = findForbiddenScenarioKeyInText(text);
  }
  // Only the rule name is reported, never any value from the file.
  if (forbiddenKey) throw new Error(`Public export rejected scenario-shaped JSON (key "${forbiddenKey}") in ${relativePath}`);
}

function assertSafeContent(sourceRoot, relativePath, { syntheticFixtures } = {}) {
  const absolute = path.join(sourceRoot, relativePath);
  const buffer = fs.readFileSync(absolute);
  if (JSON_FAMILY_FILE_PATTERN.test(relativePath) && !resolveSyntheticFixtures(syntheticFixtures).has(relativePath)) {
    assertNoScenarioContent(buffer, relativePath);
  }
  if (buffer.includes(0)) return;
  const text = buffer.toString('utf8');
  for (const pattern of FORBIDDEN_CONTENT) {
    pattern.lastIndex = 0; // a global pattern keeps its position between files
    if (pattern.test(text)) throw new Error(`Public export rejected sensitive content in ${relativePath}`);
  }
}

function buildPublicExportPlan({
  sourceRoot = path.join(__dirname, '..'),
  manifestPath = DEFAULT_MANIFEST_PATH,
  manifest,
  syntheticFixtures = SYNTHETIC_SCENARIO_FIXTURES,
} = {}) {
  const resolvedManifest = manifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    resolvedManifest.version !== 1
    || !Array.isArray(resolvedManifest.paths)
    || (resolvedManifest.excludePaths !== undefined && !Array.isArray(resolvedManifest.excludePaths))
  ) {
    throw new Error('Unsupported public export manifest.');
  }
  const options = {
    syntheticFixtures: normalizeSyntheticFixtures(syntheticFixtures),
    ignored: listIgnoredUntracked(sourceRoot),
  };
  const excludedFiles = new Set((resolvedManifest.excludePaths || []).map((entry) => {
    const relativePath = assertAllowedPath(entry, options);
    const absolutePath = path.join(sourceRoot, relativePath);
    if (fs.existsSync(absolutePath) && !fs.lstatSync(absolutePath).isFile()) {
      throw new Error(`Public export exclusion may name only a file: ${relativePath}`);
    }
    return relativePath;
  }));
  const files = [...new Set(resolvedManifest.paths.flatMap((entry) => {
    const relativePath = assertAllowedPath(entry, options);
    const absolutePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`Allowlisted path is missing: ${relativePath}`);
    if (isIgnoredUntracked(relativePath, options.ignored)) {
      throw new Error(`Public export refuses a path that git ignores: ${relativePath}`);
    }
    return walkFiles(sourceRoot, relativePath, options);
  }))].filter((file) => !excludedFiles.has(file)).sort();
  for (const file of files) assertSafeContent(sourceRoot, file, options);
  return files;
}

// The npm scripts a public package may carry. Any other script is left out of the exported package.json,
// so a script added for local operations never leaves with the sources unless it is added here on purpose.
const PUBLIC_PACKAGE_SCRIPTS = Object.freeze([
  'start',
  'dev',
  'deploy',
  'safety:ledger',
  'test-control:start',
  'test-control:owner',
  'test-control:deploy',
  'check',
  'ci:runtime',
  'test',
  'audit',
  'site:preview',
  'site:check',
  'games:preview',
]);

// Keeps only the allowed scripts of the exported package.json. A package that holds no other script is left
// exactly as it was copied, byte for byte.
function sanitizePublicPackage(outputPath) {
  const packagePath = path.join(outputPath, 'package.json');
  if (!fs.existsSync(packagePath)) return;
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== 'object') return;
  const unlisted = Object.keys(scripts).filter((name) => !PUBLIC_PACKAGE_SCRIPTS.includes(name));
  if (!unlisted.length) return;
  for (const name of unlisted) delete scripts[name];
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

// An export copies what the repository holds. A file that git neither tracks nor ignores, a scratch note or
// a half-written draft, is one nobody has decided about, and would leave with the sources. The plan and
// the dry run still list such a file, so that a new file can be checked before it is staged (the dry run on
// the command line warns about it); only a real export stops. Without a git work tree there is nothing to
// compare with, and nothing is checked. Only relative paths are named, never any content.
const MAX_NAMED_UNTRACKED = 50;

// The files of a plan that git neither tracks nor ignores, relative to sourceRoot; none without a work tree.
function untrackedFilesOf(sourceRoot, files) {
  const untracked = listUntrackedUnignored(sourceRoot);
  if (!untracked) return [];
  const known = new Set(untracked);
  return files.filter((file) => known.has(file));
}

function nameFiles(files) {
  const named = files.slice(0, MAX_NAMED_UNTRACKED).join(', ');
  return files.length > MAX_NAMED_UNTRACKED ? `${named} and ${files.length - MAX_NAMED_UNTRACKED} more` : named;
}

function assertNothingUntracked(sourceRoot, files) {
  const offending = untrackedFilesOf(sourceRoot, files);
  if (!offending.length) return;
  throw new Error(`Public export refuses files that git does not track: ${nameFiles(offending)}. `
    + 'Commit them, remove them, or add them to .gitignore.');
}

// What the command line prints after a dry run: a warning, never a failure.
function warnAboutUntracked(sourceRoot, files) {
  try {
    const offending = untrackedFilesOf(sourceRoot, files);
    if (offending.length) {
      console.warn(`Warning: ${offending.length} file(s) in the plan are not tracked by git, so a real export would refuse them: ${nameFiles(offending)}.`);
    }
  } catch (error) {
    console.warn(`Warning: could not check which files git tracks: ${error.message}`);
  }
}

function exportPublicFiles({
  sourceRoot = path.join(__dirname, '..'),
  outputPath,
  manifestPath,
  manifest,
  syntheticFixtures,
  dryRun = false,
} = {}) {
  const files = buildPublicExportPlan({ sourceRoot, manifestPath, manifest, syntheticFixtures });
  if (dryRun) return { dryRun: true, files };
  if (!outputPath) throw new Error('An output path is required unless --dry-run is used.');
  assertNothingUntracked(sourceRoot, files);
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
    if (result.dryRun) warnAboutUntracked(path.join(__dirname, '..'), result.files);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  PUBLIC_PACKAGE_SCRIPTS,
  SYNTHETIC_SCENARIO_FIXTURES,
  assertAllowedPath,
  buildPublicExportPlan,
  exportPublicFiles,
  gitEnvironment,
  isIgnoredUntracked,
  listIgnoredUntracked,
  listUntrackedUnignored,
};
