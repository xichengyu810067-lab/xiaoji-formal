const { GameError } = require('./soloGameError');

let runtime = null;

function configureSoloRuntime(value) {
  if (!value || typeof value.executeCommand !== 'function' || typeof value.handleInteraction !== 'function') {
    throw new GameError('RUNTIME_NOT_CONFIGURED', 'Solo game runtime is invalid.');
  }
  runtime = value;
  return runtime;
}

function getSoloRuntime() {
  if (!runtime) throw new GameError('RUNTIME_NOT_CONFIGURED', 'Solo game runtime has not started.');
  return runtime;
}

module.exports = { configureSoloRuntime, getSoloRuntime };
