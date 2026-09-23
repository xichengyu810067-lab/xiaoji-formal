const { BoardCoreError, cloneJson } = require('../../src/games/contracts');

function interactionKey(interactionId) {
  return String(interactionId || '');
}

class InMemoryBoardStore {
  constructor(snapshot = null) {
    this.sessions = new Map((snapshot?.sessions || []).map((session) => [session.id, cloneJson(session)]));
    this.actions = cloneJson(snapshot?.actions || []);
    this.interactions = new Map((snapshot?.interactions || []).map((entry) => [entry.interactionId, cloneJson(entry)]));
    this.queue = Promise.resolve();
  }

  _enqueue(work) {
    const operation = this.queue.then(work, work);
    this.queue = operation.catch(() => {});
    return operation;
  }

  _findActive(guildId, channelId) {
    return [...this.sessions.values()].find((session) =>
      session.guildId === guildId && session.channelId === channelId && ['lobby', 'active'].includes(session.status)
    ) || null;
  }

  _replay(interactionId, requestDigest) {
    const previous = this.interactions.get(interactionKey(interactionId));
    if (!previous) return null;
    if (previous.requestDigest !== requestDigest) {
      throw new BoardCoreError('INTERACTION_MISMATCH', 'The interaction ID was reused with another request.');
    }
    if (!previous.sessionSnapshot) throw new BoardCoreError('STORE_CORRUPT', 'The replayed session snapshot is missing.');
    return { session: cloneJson(previous.sessionSnapshot), events: cloneJson(previous.events), replayed: true };
  }

  async createSession({ session, interactionId, requestDigest }) {
    return this._enqueue(() => {
      const replay = this._replay(interactionId, requestDigest);
      if (replay) return replay;
      if (this._findActive(session.guildId, session.channelId)) {
        throw new BoardCoreError('SESSION_ALREADY_ACTIVE', 'This channel already has an active board session.');
      }
      if (this.sessions.has(session.id)) throw new BoardCoreError('SESSION_ID_CONFLICT', 'The generated session ID already exists.');
      const stored = cloneJson(session);
      this.sessions.set(stored.id, stored);
      const events = [{ type: 'lobby-created' }];
      this.interactions.set(interactionKey(interactionId), {
        interactionId: interactionKey(interactionId),
        requestDigest,
        sessionId: stored.id,
        sessionSnapshot: stored,
        events,
      });
      return { session: cloneJson(stored), events, replayed: false };
    });
  }

  async mutate(request, transform) {
    return this._enqueue(() => {
      const replay = this._replay(request.interactionId, request.requestDigest);
      if (replay) return replay;
      const current = this._findActive(request.guildId, request.channelId);
      if (!current) throw new BoardCoreError('SESSION_NOT_FOUND', 'There is no active board session in this channel.');
      if (current.revision !== request.expectedRevision) {
        throw new BoardCoreError('STALE_REVISION', 'The board session changed; load the latest revision.');
      }
      const output = transform(cloneJson(current));
      if (output && typeof output.then === 'function') {
        throw new BoardCoreError('ASYNC_TRANSACTION_FORBIDDEN', 'Board transaction callbacks must be synchronous.');
      }
      if (!output || !output.session) throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation returned no session.');
      const next = cloneJson(output.session);
      if (next.id !== current.id || next.guildId !== current.guildId || next.channelId !== current.channelId) {
        throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation changed immutable session identity.');
      }
      if (next.revision !== current.revision && next.revision !== current.revision + 1) {
        throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Mutation revision must remain stable or increment by one.');
      }
      if (output.action && next.revision !== current.revision + 1) {
        throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Recorded actions must increment the revision.');
      }
      this.sessions.set(next.id, next);
      const events = cloneJson(output.events || []);
      if (output.action) {
        this.actions.push({
          sessionId: next.id,
          revision: next.revision,
          interactionId: request.interactionId,
          actorId: output.action.actorId || null,
          action: cloneJson(output.action),
          createdAt: next.updatedAt,
        });
      }
      this.interactions.set(interactionKey(request.interactionId), {
        interactionId: interactionKey(request.interactionId),
        requestDigest: request.requestDigest,
        sessionId: next.id,
        sessionSnapshot: next,
        events,
      });
      return { session: cloneJson(next), events, replayed: false };
    });
  }

  async expireActive({ guildId, channelId, sessionId = null, shouldExpire, buildExpired }) {
    return this._enqueue(() => {
      const current = this._findActive(guildId, channelId);
      if (sessionId && current?.id !== sessionId) return null;
      if (!current || !shouldExpire(cloneJson(current))) return current ? cloneJson(current) : null;
      const next = buildExpired(cloneJson(current));
      if (next && typeof next.then === 'function') {
        throw new BoardCoreError('ASYNC_TRANSACTION_FORBIDDEN', 'Board expiry callback must be synchronous.');
      }
      if (!next || next.id !== current.id || next.revision !== current.revision + 1 || next.status !== 'expired') {
        throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Expiry mutation is invalid.');
      }
      this.sessions.set(next.id, cloneJson(next));
      this.actions.push({
        sessionId: next.id,
        revision: next.revision,
        interactionId: null,
        actorId: null,
        action: { type: 'expired', reason: next.endReason },
        createdAt: next.updatedAt,
      });
      return cloneJson(next);
    });
  }

  async getActiveSession({ guildId, channelId }) {
    return this._enqueue(() => {
      const session = this._findActive(guildId, channelId);
      return session ? cloneJson(session) : null;
    });
  }

  async getSessionById(sessionId) {
    return this._enqueue(() => {
      const session = this.sessions.get(sessionId);
      return session ? cloneJson(session) : null;
    });
  }

  snapshot() {
    return cloneJson({
      sessions: [...this.sessions.values()],
      actions: this.actions,
      interactions: [...this.interactions.values()],
    });
  }
}

module.exports = { InMemoryBoardStore };
