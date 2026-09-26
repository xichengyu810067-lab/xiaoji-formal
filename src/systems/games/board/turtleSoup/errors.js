class TurtleSoupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'TurtleSoupError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

module.exports = { TurtleSoupError };
