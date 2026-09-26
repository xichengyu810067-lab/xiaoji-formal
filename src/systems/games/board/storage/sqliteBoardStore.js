const { BoardCoreError, cloneJson, stableJson } = require('../../../../games/contracts');
const coinDatabase = require('../../../../services/coinDatabase');
const { installBoardSchema } = require('./boardSchema');

const MAX_SESSION_JSON_BYTES = 1024 * 1024;
const MAX_ACTION_JSON_BYTES = 64 * 1024;
const MAX_EVENTS_JSON_BYTES = 64 * 1024;

function encodeJson(value, label, maxBytes) {
  const json = JSON.stringify(cloneJson(value, label));
  if (Buffer.byteLength(json) > maxBytes) throw new BoardCoreError('PAYLOAD_TOO_LARGE', `${label} is too large.`);
  return json;
}

function decodeJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    throw new BoardCoreError('STORE_CORRUPT', `${label} contains invalid JSON.`);
  }
}

function toRow(session) {
  return {
    id: session.id,
    guildId: session.guildId,
    channelId: session.channelId,
    messageId: session.messageId,
    gameKey: session.gameKey,
    rulesVersion: session.rulesVersion,
    status: session.status,
    hostId: session.hostId,
    playersJson: encodeJson(session.players, 'session players', MAX_SESSION_JSON_BYTES),
    rulesJson: encodeJson(session.rules, 'session rules', MAX_SESSION_JSON_BYTES),
    seed: session.seed,
    stateJson: session.state == null ? null : encodeJson(session.state, 'session state', MAX_SESSION_JSON_BYTES),
    turnJson: session.turn == null ? null : encodeJson(session.turn, 'session turn', MAX_SESSION_JSON_BYTES),
    outcomeJson: session.outcome == null ? null : encodeJson(session.outcome, 'session outcome', MAX_SESSION_JSON_BYTES),
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastProgressAt: session.lastProgressAt,
    expiresAt: session.expiresAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    gameKey: row.game_key,
    rulesVersion: row.rules_version,
    status: row.status,
    hostId: row.host_id,
    players: decodeJson(row.players_json, 'board_sessions.players_json'),
    rules: decodeJson(row.rules_json, 'board_sessions.rules_json'),
    seed: row.seed,
    state: row.state_json == null ? null : decodeJson(row.state_json, 'board_sessions.state_json'),
    turn: row.turn_json == null ? null : decodeJson(row.turn_json, 'board_sessions.turn_json'),
    outcome: row.outcome_json == null ? null : decodeJson(row.outcome_json, 'board_sessions.outcome_json'),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastProgressAt: row.last_progress_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

function replayInteraction(api, interactionId, requestDigest) {
  const row = api.get('SELECT * FROM board_interactions WHERE interaction_id = ?', [interactionId]);
  if (!row) return null;
  if (row.request_digest !== requestDigest) {
    throw new BoardCoreError('INTERACTION_MISMATCH', 'The interaction ID was reused with another request.');
  }
  return {
    session: decodeJson(row.session_snapshot_json, 'board_interactions.session_snapshot_json'),
    events: decodeJson(row.events_json, 'board_interactions.events_json'),
    replayed: true,
  };
}

function getActiveRow(api, guildId, channelId, sessionId = null) {
  if (sessionId) {
    return api.get(
      "SELECT * FROM board_sessions WHERE id = ? AND guild_id = ? AND channel_id = ? AND status IN ('lobby', 'active') LIMIT 1",
      [sessionId, guildId, channelId]
    );
  }
  return api.get(
    "SELECT * FROM board_sessions WHERE guild_id = ? AND channel_id = ? AND status IN ('lobby', 'active') LIMIT 1",
    [guildId, channelId]
  );
}

function insertInteraction(api, { interactionId, requestDigest, session, events }) {
  api.run(
    `INSERT INTO board_interactions
      (interaction_id, request_digest, session_id, session_revision, session_snapshot_json, events_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      interactionId,
      requestDigest,
      session.id,
      session.revision,
      encodeJson(session, 'interaction session snapshot', MAX_SESSION_JSON_BYTES),
      encodeJson(events, 'interaction events', MAX_EVENTS_JSON_BYTES),
      session.updatedAt,
    ]
  );
}

function insertSession(api, session) {
  const row = toRow(session);
  api.run(
    `INSERT INTO board_sessions
      (id, guild_id, channel_id, message_id, game_key, rules_version, status, host_id,
       players_json, rules_json, seed, state_json, turn_json, outcome_json, revision,
       created_at, updated_at, last_progress_at, expires_at, ended_at, end_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.guildId, row.channelId, row.messageId, row.gameKey, row.rulesVersion, row.status, row.hostId,
      row.playersJson, row.rulesJson, row.seed, row.stateJson, row.turnJson, row.outcomeJson, row.revision,
      row.createdAt, row.updatedAt, row.lastProgressAt, row.expiresAt, row.endedAt, row.endReason]
  );
}

function updateSessionCas(api, session, expectedRevision) {
  const row = toRow(session);
  api.run(
    `UPDATE board_sessions SET
       message_id = ?, status = ?, host_id = ?, players_json = ?, rules_json = ?, seed = ?,
       state_json = ?, turn_json = ?, outcome_json = ?, revision = ?, updated_at = ?,
       last_progress_at = ?, expires_at = ?, ended_at = ?, end_reason = ?
     WHERE id = ? AND guild_id = ? AND channel_id = ? AND revision = ?`,
    [row.messageId, row.status, row.hostId, row.playersJson, row.rulesJson, row.seed,
      row.stateJson, row.turnJson, row.outcomeJson, row.revision, row.updatedAt,
      row.lastProgressAt, row.expiresAt, row.endedAt, row.endReason,
      row.id, row.guildId, row.channelId, expectedRevision]
  );
  const changes = Number(api.get('SELECT changes() AS count').count);
  if (changes !== 1) throw new BoardCoreError('STALE_REVISION', 'The board session changed; load the latest revision.');
}

function validateImmutableSession(current, next) {
  if (next.id !== current.id || next.guildId !== current.guildId || next.channelId !== current.channelId) {
    throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation changed immutable session identity.');
  }
  if (next.gameKey !== current.gameKey || next.rulesVersion !== current.rulesVersion || next.seed !== current.seed ||
      next.createdAt !== current.createdAt || stableJson(next.rules) !== stableJson(current.rules)) {
    throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation changed immutable session rules.');
  }
}

function validateMutation(current, output) {
  if (output && typeof output.then === 'function') {
    throw new BoardCoreError('ASYNC_TRANSACTION_FORBIDDEN', 'Board transaction callbacks must be synchronous.');
  }
  if (!output || !output.session) throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation returned no session.');
  const next = cloneJson(output.session);
  validateImmutableSession(current, next);
  if (next.revision !== current.revision && next.revision !== current.revision + 1) {
    throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation revision must remain stable or increment by one.');
  }
  if (output.action && next.revision !== current.revision + 1) {
    throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Recorded actions must increment the revision.');
  }
  return next;
}

function insertAction(api, { session, interactionId, action, events }) {
  api.run(
    `INSERT INTO board_actions
      (session_id, revision, interaction_id, actor_id, action_json, events_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.revision,
      interactionId,
      action.actorId || null,
      encodeJson(action, 'board action', MAX_ACTION_JSON_BYTES),
      encodeJson(events, 'board events', MAX_EVENTS_JSON_BYTES),
      session.updatedAt,
    ]
  );
}

function createSqliteBoardStore({
  withDatabase = coinDatabase.withCoinDatabase,
  withTransaction = coinDatabase.withCoinTransaction,
} = {}) {
  if (typeof withDatabase !== 'function' || typeof withTransaction !== 'function') {
    throw new BoardCoreError('INVALID_STORE', 'coinDatabase-compatible runners are required.');
  }

  let schemaPromise = null;
  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = withTransaction((api) => {
        installBoardSchema(api);
        return true;
      }).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  }

  return Object.freeze({
    async createSession({ session, interactionId, requestDigest }) {
      await ensureSchema();
      return withTransaction((api) => {
        const replay = replayInteraction(api, interactionId, requestDigest);
        if (replay) return replay;
        if (getActiveRow(api, session.guildId, session.channelId)) {
          throw new BoardCoreError('SESSION_ALREADY_ACTIVE', 'This channel already has an active board session.');
        }
        insertSession(api, session);
        const events = [{ type: 'lobby-created' }];
        insertInteraction(api, { interactionId, requestDigest, session, events });
        return { session: cloneJson(session), events, replayed: false };
      });
    },

    async mutate(request, transform) {
      await ensureSchema();
      return withTransaction((api) => {
        const replay = replayInteraction(api, request.interactionId, request.requestDigest);
        if (replay) return replay;
        const row = getActiveRow(api, request.guildId, request.channelId);
        if (!row) throw new BoardCoreError('SESSION_NOT_FOUND', 'There is no active board session in this channel.');
        const current = fromRow(row);
        if (current.revision !== request.expectedRevision) {
          throw new BoardCoreError('STALE_REVISION', 'The board session changed; load the latest revision.');
        }
        const output = transform(cloneJson(current));
        if (output && typeof output.then === 'function') {
          throw new BoardCoreError('ASYNC_TRANSACTION_FORBIDDEN', 'Board transaction callbacks must be synchronous.');
        }
        const next = validateMutation(current, output);
        updateSessionCas(api, next, current.revision);
        const events = cloneJson(output.events || []);
        if (output.action) insertAction(api, { session: next, interactionId: request.interactionId, action: output.action, events });
        insertInteraction(api, { interactionId: request.interactionId, requestDigest: request.requestDigest, session: next, events });
        return { session: next, events, replayed: false };
      });
    },

    async expireActive({ guildId, channelId, sessionId = null, shouldExpire, buildExpired }) {
      await ensureSchema();
      return withTransaction((api) => {
        const row = getActiveRow(api, guildId, channelId, sessionId);
        if (!row) return null;
        const current = fromRow(row);
        if (!shouldExpire(cloneJson(current))) return current;
        const output = buildExpired(cloneJson(current));
        if (output && typeof output.then === 'function') {
          throw new BoardCoreError('ASYNC_TRANSACTION_FORBIDDEN', 'Board expiry callback must be synchronous.');
        }
        const next = cloneJson(output);
        validateImmutableSession(current, next);
        if (next.revision !== current.revision + 1 || next.status !== 'expired') {
          throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Expiry mutation is invalid.');
        }
        updateSessionCas(api, next, current.revision);
        insertAction(api, {
          session: next,
          interactionId: null,
          action: { type: 'expired', reason: next.endReason },
          events: [{ type: 'session-expired', reason: next.endReason }],
        });
        return next;
      });
    },

    async getActiveSession({ guildId, channelId }) {
      await ensureSchema();
      return withDatabase((api) => fromRow(getActiveRow(api, guildId, channelId)));
    },

    async getSessionById(sessionId) {
      await ensureSchema();
      return withDatabase((api) => fromRow(api.get('SELECT * FROM board_sessions WHERE id = ?', [sessionId])));
    },

    async listRecoverable({ now, limit = 100 }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BoardCoreError('INVALID_REQUEST', 'Recovery limit is invalid.');
      await ensureSchema();
      return withDatabase((api) => api.all(
        "SELECT * FROM board_sessions WHERE status IN ('lobby', 'active') AND expires_at > ? ORDER BY updated_at LIMIT ?",
        [String(now), limit]
      ).map(fromRow));
    },
  });
}

module.exports = {
  MAX_ACTION_JSON_BYTES,
  MAX_EVENTS_JSON_BYTES,
  MAX_SESSION_JSON_BYTES,
  createSqliteBoardStore,
  fromRow,
  toRow,
};
