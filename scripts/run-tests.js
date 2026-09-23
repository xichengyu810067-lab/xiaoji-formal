const fs = require('node:fs');
const path = require('node:path');

const testDirectory = path.join(__dirname, '..', 'test');
for (const fileName of fs.readdirSync(testDirectory).filter((file) => file.endsWith('.test.js')).sort()) {
  require(path.join(testDirectory, fileName));
}
