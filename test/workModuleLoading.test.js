'use strict';

// How the work system loads its parts. workService takes the job cycle functions and the payroll
// functions from their own modules. Each test file runs in a process of its own, so the module cache below shows what
// loading workService alone pulls in.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-module-loading-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('workService loads the job cycle and payroll modules itself, and the old economy/workSystem path is gone', () => {
  require('../src/systems/work/workService');

  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'systems', 'economy', 'workSystem.js')), false);
  assert.ok(require.cache[require.resolve('../src/systems/work/jobCycle')], 'jobCycle.js was not loaded');
  assert.ok(require.cache[require.resolve('../src/systems/work/payroll')], 'payroll.js was not loaded');
});

test('loading workService loads no reward coordinator: the work system gets it from the assembly root', () => {
  const rewardRuntimePath = require.resolve('../src/coordinators/rewardRuntime');
  const rewardCoordinatorPath = require.resolve('../src/coordinators/rewardCoordinator');

  require('../src/systems/work/workService');

  assert.equal(require.cache[rewardRuntimePath], undefined, 'rewardRuntime.js was loaded');
  assert.equal(require.cache[rewardCoordinatorPath], undefined, 'rewardCoordinator.js was loaded');
  assert.ok(require.cache[require.resolve('../src/systems/work/workRewardPort')], 'workRewardPort.js was not loaded');
});

test('loading workService loads no work role coordinator: the work system gets it from the assembly root', () => {
  const coordinatorPath = require.resolve('../src/coordinators/workRoleCoordinator');

  require('../src/systems/work/workService');

  assert.equal(require.cache[coordinatorPath], undefined, 'workRoleCoordinator.js was loaded');
  assert.ok(require.cache[require.resolve('../src/systems/work/workRolePort')], 'workRolePort.js was not loaded');
});
