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
  if (!coinDatabase.includes('const schemaVersion = 22;')) failures.push('Global economy requires coin schema v22.');

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

module.exports = { checkProject };
