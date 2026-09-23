const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCommandData, loadCommands } = require('../src/loadCommands');
const { buildPublicExportPlan } = require('./create-public-export');

const projectRoot = path.join(__dirname, '..');
const requiredFiles = [
  '.env.example',
  '.gitignore',
  'README.md',
  'deploy-commands.js',
  'src/index.js',
  'src/loadCommands.js',
  'src/extensions/extensionHost.js',
  'website/statusData.js',
];

function assertSafeYoutubeCredentialPolicy(applicationText) {
  const forbiddenFragments = ['oauth', 'token', 'cookie', `visitor${'data'}`];
  const keyStack = [];
  const configuredPaths = [];
  let blockScalarParentIndent = null;
  for (const line of String(applicationText).split(/\r?\n/)) {
    const lineIndent = /^(\s*)/.exec(line)[1].length;
    if (blockScalarParentIndent !== null) {
      if (!line.trim() || lineIndent > blockScalarParentIndent) continue;
      blockScalarParentIndent = null;
    }
    const match = /^(\s*)(?:"((?:\\.|[^"\\\r\n])+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_-]*))\s*:/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    while (keyStack.length && keyStack[keyStack.length - 1].indent >= indent) keyStack.pop();
    const quotedKey = match[2] || match[3];
    assert(!quotedKey?.includes('\\'), 'YouTube client policy must not use escaped quoted mapping keys');
    const key = (match[2] || match[3] || match[4]).toLowerCase();
    const pathParts = [...keyStack.map((entry) => entry.key), key];
    configuredPaths.push(pathParts);
    keyStack.push({ indent, key });
    const scalarValue = line.slice(match[0].length);
    if (/^\s*[|>][0-9+-]*\s*(?:#.*)?$/.test(scalarValue)) blockScalarParentIndent = indent;
  }
  const configuredKeys = configuredPaths.map((pathParts) => pathParts[pathParts.length - 1]);
  const hasForbiddenKey = configuredKeys.some(
    (key) => key === 'pot' || forbiddenFragments.some((fragment) => key.includes(fragment))
  );
  const normalizedPaths = configuredPaths.map((pathParts) => pathParts.map((key) => key.replace(/[-_]/g, '')));
  const hasRemoteCipher = normalizedPaths.some((pathParts) => pathParts.some((key) => key.includes('remotecipher')));
  const hasIpRouting = normalizedPaths.some((pathParts) =>
    pathParts.some((key) =>
      key === 'ratelimit' ||
      key === 'ipblocks' ||
      key === 'excludedips' ||
      key.includes('routeplanner') ||
      key.includes('routing') ||
      key.includes('iprotation') ||
      key.includes('rotator')
    )
  );
  assert(!hasForbiddenKey, 'YouTube client policy must not introduce account credentials, OAuth, proof tokens, cookies, or refresh tokens');
  assert(!hasRemoteCipher, 'YouTube client policy must not introduce remote cipher configuration');
  assert(!hasIpRouting, 'YouTube client policy must not introduce IP rotation, route planner, or routing configuration');
}

function checkProject() {
  const failures = [];
  for (const relativePath of requiredFiles) {
    if (!fs.existsSync(path.join(projectRoot, relativePath))) failures.push(`Missing required file: ${relativePath}`);
  }

  const commands = loadCommands();
  const commandData = loadCommandData();
  if (commands.size !== commandData.length) failures.push('Public runtime and deployment command counts differ.');
  if (!commands.has('help') || !commands.has('set-welcome')) failures.push('Required public commands are missing.');

  const coinDatabase = fs.readFileSync(path.join(projectRoot, 'src/services/coinDatabase.js'), 'utf8');
  if (!coinDatabase.includes('const schemaVersion = 21;')) failures.push('Global economy requires coin schema v21.');

  const exportFiles = buildPublicExportPlan({ sourceRoot: projectRoot });
  if (!exportFiles.includes('src/index.js')) failures.push('Public export manifest omits the core entrypoint.');
  if (exportFiles.some((file) => file === '.env' || file.startsWith('data/'))) {
    failures.push('Public export includes protected runtime data.');
  }

  const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  for (const pattern of ['.env', '*.sqlite', 'data/*']) {
    if (!gitignore.includes(pattern)) failures.push(`.gitignore is missing ${pattern}`);
  }

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

module.exports = { assertSafeYoutubeCredentialPolicy, checkProject };
