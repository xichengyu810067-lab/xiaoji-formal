const { BoardCoreError, requireIdentifier, requireRevision } = require('../../../../games/contracts');

const CUSTOM_ID_PREFIX = 'board|1|';
const CUSTOM_ID_LIMIT = 100;

function requireCustomPart(value, label, maxLength, pattern) {
  const text = requireIdentifier(value, label, maxLength);
  if (!pattern.test(text)) throw new BoardCoreError('INVALID_CUSTOM_ID', `${label} contains unsupported characters.`);
  return text;
}

function buildBoardCustomId({ sessionId, revision, verb }) {
  const id = requireCustomPart(sessionId, 'sessionId', 64, /^[A-Za-z0-9_-]+$/u);
  const version = requireRevision(revision);
  const action = requireCustomPart(verb, 'verb', 32, /^[a-z][a-z0-9.-]*$/u);
  const customId = `${CUSTOM_ID_PREFIX}${id}|${version}|${action}`;
  if (customId.length > CUSTOM_ID_LIMIT) throw new BoardCoreError('INVALID_CUSTOM_ID', 'Board custom ID exceeds Discord limits.');
  return customId;
}

function parseBoardCustomId(value) {
  const customId = String(value || '');
  if (!customId.startsWith(CUSTOM_ID_PREFIX) || customId.length > CUSTOM_ID_LIMIT) {
    throw new BoardCoreError('INVALID_CUSTOM_ID', 'This is not a supported board interaction.');
  }
  const parts = customId.split('|');
  if (parts.length !== 5 || parts[0] !== 'board' || parts[1] !== '1') {
    throw new BoardCoreError('INVALID_CUSTOM_ID', 'Board custom ID shape is invalid.');
  }
  const revision = Number(parts[3]);
  return {
    sessionId: requireCustomPart(parts[2], 'sessionId', 64, /^[A-Za-z0-9_-]+$/u),
    revision: requireRevision(revision),
    verb: requireCustomPart(parts[4], 'verb', 32, /^[a-z][a-z0-9.-]*$/u),
  };
}

module.exports = { CUSTOM_ID_LIMIT, CUSTOM_ID_PREFIX, buildBoardCustomId, parseBoardCustomId };
