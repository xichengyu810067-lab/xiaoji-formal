const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDirectory = path.join(__dirname, '..', 'test');
const testFiles = fs.readdirSync(testDirectory)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.join(testDirectory, file));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
