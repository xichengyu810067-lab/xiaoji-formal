// The error the coin database throws for everything it refuses or cannot do. coinDatabase.js
// re-exports it, so callers keep loading it from there.
class CoinDatabaseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CoinDatabaseError';
    this.cause = cause;
  }
}

module.exports = {
  CoinDatabaseError,
};
