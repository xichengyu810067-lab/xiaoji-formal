'use strict';

const { createTestControlRuntimeController } = require('./testControlRuntimeController');

const GLOBAL_KEY = Symbol.for('xiaoji.testControlRuntimeController');

if (!globalThis[GLOBAL_KEY]) {
  globalThis[GLOBAL_KEY] = createTestControlRuntimeController();
}

if (globalThis[GLOBAL_KEY].invalid) process.exit(1);

module.exports = globalThis[GLOBAL_KEY];
