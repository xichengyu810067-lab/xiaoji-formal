const { BoardCoreError } = require('./contracts');

let runtime = null;

function configureBoardRuntime(nextRuntime) {
  if (!nextRuntime || typeof nextRuntime.executeCommand !== 'function' ||
      typeof nextRuntime.handleInteraction !== 'function' ||
      typeof nextRuntime.startLifecycle !== 'function' ||
      typeof nextRuntime.stopLifecycle !== 'function') {
    throw new BoardCoreError('INVALID_REQUEST', 'Board runtime does not expose the required lifecycle and Discord handlers.');
  }
  if (runtime && runtime !== nextRuntime) {
    throw new BoardCoreError('RUNTIME_ALREADY_CONFIGURED', 'Board runtime is already configured.');
  }
  runtime = nextRuntime;
  return runtime;
}

function getBoardRuntime() {
  if (!runtime) throw new BoardCoreError('RUNTIME_NOT_CONFIGURED', 'Board runtime is not configured.');
  return runtime;
}

async function resetBoardRuntimeForTests() {
  if (runtime) await runtime.stopLifecycle();
  runtime = null;
}

module.exports = {
  configureBoardRuntime,
  getBoardRuntime,
  resetBoardRuntimeForTests,
};
