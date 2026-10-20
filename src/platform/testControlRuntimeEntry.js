'use strict';

const runtimeControl = require('./testControlRuntimeBootstrap');
const { getTestControlStartupDiagnostics } = require('./testControlStartupDiagnostics');

async function runRuntimeEntry({
  control = runtimeControl,
  diagnostics = getTestControlStartupDiagnostics({
    active: runtimeControl.active,
    isStopping: () => runtimeControl.isStopping(),
  }),
  loadMain = () => require('../index'),
  exit = (code) => process.exit(code),
} = {}) {
  control.bindShutdown(() => exit(1));
  try {
    await control.awaitBound();
    control.assertRunning();
    diagnostics.enterPhase('DEPENDENCY_LOAD');
    loadMain();
    return true;
  } catch (error) {
    diagnostics.reportFailure(error);
    control.requestStop('START_FAILED');
    return false;
  }
}

if (require.main === module) void runRuntimeEntry();

module.exports = { runRuntimeEntry };
