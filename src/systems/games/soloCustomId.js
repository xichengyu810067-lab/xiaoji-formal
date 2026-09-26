const { GameError } = require('./soloGameError');

const PREFIX = 'solo|1|';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const VERBS = new Set(['move.t', 'move.n', 'move.s', 'refresh']);

function buildSoloCustomId({ sessionId, revision, verb }) {
  if (!ID_PATTERN.test(String(sessionId || '')) || !Number.isSafeInteger(revision) || revision < 0 ||
      !VERBS.has(verb)) throw new GameError('INVALID_CUSTOM_ID', 'Invalid solo game control.');
  const value = `${PREFIX}${sessionId}|${revision}|${verb}`;
  if (value.length > 100) throw new GameError('INVALID_CUSTOM_ID', 'Solo game control exceeds Discord limits.');
  return value;
}

function parseSoloCustomId(value) {
  const text = String(value || '');
  if (!text.startsWith(PREFIX) || text.length > 100) throw new GameError('INVALID_CUSTOM_ID', 'Unsupported solo game control.');
  const parts = text.split('|');
  if (parts.length !== 5 || parts[0] !== 'solo' || parts[1] !== '1') {
    throw new GameError('INVALID_CUSTOM_ID', 'Malformed solo game control.');
  }
  const revision = Number(parts[3]);
  if (!ID_PATTERN.test(parts[2]) || !Number.isSafeInteger(revision) || revision < 0 || !VERBS.has(parts[4])) {
    throw new GameError('INVALID_CUSTOM_ID', 'Malformed solo game control.');
  }
  return { sessionId: parts[2], revision, verb: parts[4] };
}

module.exports = { PREFIX, buildSoloCustomId, parseSoloCustomId };
