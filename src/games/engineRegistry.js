const { BoardCoreError, assertEngineContract } = require('./contracts');

class BoardEngineRegistry {
  constructor(engines = []) {
    this.engines = new Map();
    for (const engine of engines) this.register(engine);
  }

  register(engine) {
    assertEngineContract(engine);
    if (this.engines.has(engine.key)) {
      throw new BoardCoreError('ENGINE_ALREADY_REGISTERED', `Engine ${engine.key} is already registered.`);
    }
    this.engines.set(engine.key, engine);
    return this;
  }

  get(gameKey) {
    const engine = this.engines.get(String(gameKey || ''));
    if (!engine) throw new BoardCoreError('GAME_NOT_AVAILABLE', 'This board game is not available.');
    return engine;
  }

  has(gameKey) {
    return this.engines.has(String(gameKey || ''));
  }

  list() {
    return [...this.engines.keys()];
  }
}

module.exports = { BoardEngineRegistry };
