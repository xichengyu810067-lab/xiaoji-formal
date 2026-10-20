const fs = require('node:fs');
const path = require('node:path');
const { assertPublicCommandCatalog, loadCommandData, loadCommands } = require('../src/loadCommands');
const { findCommandDocsIssues, findReadmeIssues, findWebsiteIssues } = require('./command-doc-checks');
const { buildPublicExportPlan } = require('./create-public-export');
const { findPublicTextIssues } = require('./check-public-text');

const projectRoot = path.join(__dirname, '..');
const requiredFiles = [
  '.env.example',
  '.gitignore',
  'README.md',
  'deploy-commands.js',
  'src/index.js',
  'src/loadCommands.js',
  'src/extensions/extensionHost.js',
  'website/commandCatalog.js',
  'website/statusData.js',
];
const requiredWordChainExportFiles = [
  'assets/word-chain/NOTICE.txt',
  'assets/word-chain/MOE-usage-revised.pdf',
  'assets/word-chain/moe-revised-source.json',
  'assets/word-chain/moe-revised-2015_20260625.txt',
];

function resolveLocalModule(parentFile, request) {
  const basePath = path.resolve(path.dirname(path.join(projectRoot, parentFile)), request);
  const candidates = [basePath, `${basePath}.js`, `${basePath}.json`, path.join(basePath, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function findMissingPublicDependencies(exportFiles) {
  const exported = new Set(exportFiles);
  const missing = [];
  for (const relativePath of exportFiles.filter((file) => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    const requests = [
      ...source.matchAll(/\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu),
      ...source.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gu),
    ].map((match) => match[1]);
    for (const request of new Set(requests)) {
      const dependency = resolveLocalModule(relativePath, request);
      if (!dependency) {
        missing.push(`${relativePath} -> ${request} (cannot resolve)`);
        continue;
      }
      const dependencyPath = path.relative(projectRoot, dependency).replaceAll('\\', '/');
      if (dependencyPath.startsWith('../') || !exported.has(dependencyPath)) {
        missing.push(`${relativePath} -> ${dependencyPath}`);
      }
    }
  }
  return missing;
}

// readmePath, commandDocsPath and websiteRoot let tests point the document checks at copies; they
// default to the real README.md, docs/COMMANDS.md and website/.
function checkProject({
  commandCatalog,
  readmePath = path.join(projectRoot, 'README.md'),
  commandDocsPath,
  websiteRoot = path.join(projectRoot, 'website'),
} = {}) {
  const failures = [];
  for (const relativePath of requiredFiles) {
    if (!fs.existsSync(path.join(projectRoot, relativePath))) failures.push(`Missing required file: ${relativePath}`);
  }

  // The catalog is checked below and fails this run, so the startup warning would only repeat it.
  const commands = loadCommands(undefined, { warn: null });
  const commandData = loadCommandData();
  if (commands.size !== commandData.length) failures.push('Public runtime and deployment command counts differ.');
  if (!commands.has('help') || !commands.has('set-welcome')) failures.push('Required public commands are missing.');
  try {
    assertPublicCommandCatalog(commandData, { catalog: commandCatalog });
  } catch (error) {
    failures.push(error.message);
  }

  // The generated command document, the README command section and the website text follow the same
  // catalog. They are only read here: regenerate a stale docs/COMMANDS.md with
  // `node scripts/render-command-docs.js`.
  failures.push(...findCommandDocsIssues({ docsPath: commandDocsPath, catalog: commandCatalog }));
  try {
    const readme = fs.readFileSync(readmePath, 'utf8').replace(/\r\n/gu, '\n');
    const readmeIssues = findReadmeIssues(readme, commandCatalog);
    if (readmeIssues.length > 0) {
      failures.push(`README.md does not match the command catalog:\n${readmeIssues.map((issue) => `- ${issue}`).join('\n')}`);
    }
  } catch (error) {
    failures.push(`README.md could not be checked against the command catalog: ${error.message}`);
  }
  try {
    const websiteIssues = findWebsiteIssues({ websiteRoot, catalog: commandCatalog });
    if (websiteIssues.length > 0) {
      failures.push(`Website text names commands that do not exist or were removed:\n${websiteIssues.map((issue) => `- ${issue}`).join('\n')}`);
    }
  } catch (error) {
    failures.push(`Website text could not be checked against the command catalog: ${error.message}`);
  }

  const coinDatabase = fs.readFileSync(path.join(projectRoot, 'src/services/coinDatabase.js'), 'utf8');
  if (!coinDatabase.includes('const schemaVersion = 24;')) {
    failures.push('Persistent coin-admin confirmations require coin schema v24.');
  }

  const exportFiles = buildPublicExportPlan({ sourceRoot: projectRoot });
  if (!exportFiles.includes('src/index.js')) failures.push('Public export manifest omits the core entrypoint.');
  for (const requiredAsset of requiredWordChainExportFiles) {
    if (!exportFiles.includes(requiredAsset)) failures.push(`Public export omits required word-chain asset: ${requiredAsset}`);
  }
  for (const dependency of findMissingPublicDependencies(exportFiles)) {
    failures.push(`Public export omits a local dependency: ${dependency}`);
  }
  if (exportFiles.some((file) => file === '.env' || file.startsWith('data/'))) {
    failures.push('Public export includes protected runtime data.');
  }

  const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  for (const pattern of ['.env', '*.sqlite', 'data/*']) {
    if (!gitignore.includes(pattern)) failures.push(`.gitignore is missing ${pattern}`);
  }
  failures.push(...require('./check-boundaries').findBoundaryFailures({ projectRoot }));
  // docs/ARCHITECTURE.md recounts its numbers with this helper; it is only asked to still run here. Whether the
  // guide itself is current is `node scripts/architecture-facts.js doc`.
  failures.push(...require('./architecture-facts').findFactsFailures({ projectRoot }));
  failures.push(...findPublicTextIssues({ sourceRoot: projectRoot }));

  if (failures.length) throw new Error(failures.join('\n'));
  return { publicCommands: commands.size, publicExportFiles: exportFiles.length };
}

if (require.main === module) {
  try {
    const result = checkProject();
    console.log(`Project check passed: ${result.publicCommands} commands, ${result.publicExportFiles} export files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkProject, findMissingPublicDependencies };
