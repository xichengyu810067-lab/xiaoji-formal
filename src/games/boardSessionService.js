const {
  ACTIVE_TIMEOUT_MS,
  BoardCoreError,
  BoardRuleError,
  LOBBY_TIMEOUT_MS,
  addMilliseconds,
  assertEngineState,
  assertEngineTransition,
  assertPlayerCount,
  cloneJson,
  digestRequest,
  isSessionExpired,
  normalizeDate,
  requireIdentifier,
  requireRevision,
  stableJson,
} = require('./contracts');
const { assertUserAction, createTrustedSystemAction } = require('./trustedSystemActions');

function assertStore(store) {
  for (const method of ['createSession', 'getActiveSession', 'getSessionById', 'mutate', 'expireActive']) {
    if (typeof store?.[method] !== 'function') {
      throw new BoardCoreError('INVALID_STORE', `Board store is missing ${method}().`);
    }
  }
}

function activePlayerIds(session) {
  return session.players.filter((player) => player.status === 'active').map((player) => player.userId);
}

function retiredPlayerIds(session) {
  return session.players.filter((player) => player.status === 'retired').map((player) => player.userId);
}

function findPlayer(session, userId) {
  return session.players.find((player) => player.userId === userId) || null;
}

function engineContext(session, actorId, now) {
  return Object.freeze({
    actorId,
    players: Object.freeze(session.players.map((player) => player.userId)),
    activePlayers: Object.freeze(activePlayerIds(session)),
    retiredPlayers: Object.freeze(retiredPlayerIds(session)),
    revision: session.revision,
    now: normalizeDate(now).toISOString(),
  });
}

function safeEngineCall(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof BoardRuleError) throw error;
    if (error instanceof BoardCoreError && error.code === 'ENGINE_CONTRACT_VIOLATION') throw error;
    throw new BoardCoreError('ENGINE_FAILURE', 'The board game engine failed.');
  }
}

function applyEngineAction(engine, session, action, context) {
  const stateInput = cloneJson(session.state, 'engine state input');
  const before = stableJson(stateInput);
  const result = safeEngineCall(() => engine.applyAction(stateInput, action, context));
  if (stableJson(stateInput) !== before) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine mutated its input state.');
  }
  return assertEngineTransition(result, {
    gameKey: session.gameKey,
    rulesVersion: session.rulesVersion,
    players: session.players.map((player) => player.userId),
  });
}

class BoardSessionService {
  constructor({ store, registry, clock = () => new Date(), idFactory, seedFactory, presenter = null }) {
    assertStore(store);
    if (!registry || typeof registry.get !== 'function') throw new BoardCoreError('INVALID_ENGINE', 'Engine registry is required.');
    if (typeof idFactory !== 'function' || typeof seedFactory !== 'function') {
      throw new BoardCoreError('INVALID_REQUEST', 'idFactory and seedFactory are required.');
    }
    if (presenter != null && typeof presenter.refresh !== 'function') {
      throw new BoardCoreError('INVALID_PRESENTER', 'Presenter must expose refresh().');
    }
    this.store = store;
    this.registry = registry;
    this.clock = clock;
    this.idFactory = idFactory;
    this.seedFactory = seedFactory;
    this.presenter = presenter;
    this.presentationQueues = new Map();
    this.presentedRevisions = new Map();
  }

  _now() {
    return normalizeDate(this.clock(), 'clock time');
  }

  _normalizeScope(input) {
    return {
      guildId: requireIdentifier(input.guildId, 'guildId'),
      channelId: requireIdentifier(input.channelId, 'channelId'),
    };
  }

  _normalizeMutation(input, operation, payload) {
    const scope = this._normalizeScope(input);
    const interactionId = requireIdentifier(input.interactionId, 'interactionId', 160);
    const expectedRevision = requireRevision(input.expectedRevision);
    return {
      ...scope,
      interactionId,
      expectedRevision,
      operation,
      requestDigest: digestRequest({ operation, ...scope, ...payload }),
    };
  }

  _engine(session) {
    const engine = this.registry.get(session.gameKey);
    if (engine.rulesVersion !== session.rulesVersion) {
      throw new BoardCoreError('RULES_VERSION_UNAVAILABLE', 'The stored rules version is not available.');
    }
    return engine;
  }

  _publicResult(session, viewerId, events = [], replayed = false) {
    const engine = this._engine(session);
    const viewer = findPlayer(session, viewerId);
    let game = null;
    let legalActions = [];
    if (session.state != null) {
      const viewerContext = Object.freeze({
        viewerId,
        isParticipant: Boolean(viewer),
        isActivePlayer: viewer?.status === 'active',
      });
      game = cloneJson(safeEngineCall(() => engine.getPublicView(cloneJson(session.state), viewerContext)), 'public view');
      if (viewer?.status === 'active' && typeof engine.getLegalActions === 'function') {
        const result = safeEngineCall(() => engine.getLegalActions(cloneJson(session.state), viewerContext));
        if (!Array.isArray(result)) throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Legal actions must be an array.');
        legalActions = cloneJson(result, 'legal actions');
      }
    }
    return {
      session: {
        id: session.id,
        guildId: session.guildId,
        channelId: session.channelId,
        messageId: session.messageId,
        gameKey: session.gameKey,
        rulesVersion: session.rulesVersion,
        status: session.status,
        hostId: session.hostId,
        players: session.players.map(({ userId, seat, status }) => ({ userId, seat, status })),
        turn: cloneJson(session.turn),
        outcome: cloneJson(session.outcome),
        revision: session.revision,
        expiresAt: session.expiresAt,
      },
      game,
      legalActions,
      events: cloneJson(events),
      replayed,
    };
  }

  async _present(result, viewerId, { force = false } = {}) {
    if (!this.presenter || !result.session.messageId || (result.replayed && !force)) {
      return { ...result, presentation: { ok: true, skipped: true } };
    }
    const sessionId = result.session.id;
    const previous = this.presentationQueues.get(sessionId) || Promise.resolve();
    const operation = previous.then(async () => {
      try {
        const latest = await this.store.getSessionById(sessionId);
        if (!latest || !latest.messageId) return { ok: true, skipped: true };
        const lastPresented = this.presentedRevisions.get(sessionId);
        if (!force && Number.isInteger(lastPresented) && latest.revision <= lastPresented) {
          return { ok: true, skipped: true };
        }
        const events = latest.revision === result.session.revision ? result.events : [];
        const latestResult = this._publicResult(latest, viewerId, events, false);
        await this.presenter.refresh(cloneJson(latestResult));
        this.presentedRevisions.set(sessionId, latest.revision);
        return { ok: true, skipped: false };
      } catch (_error) {
        return { ok: false, skipped: false, code: 'MESSAGE_UPDATE_FAILED' };
      }
    });
    const tail = operation.then(() => undefined);
    this.presentationQueues.set(sessionId, tail);
    const presentation = await operation;
    if (this.presentationQueues.get(sessionId) === tail) this.presentationQueues.delete(sessionId);
    return { ...result, presentation };
  }

  async _expireScope(scope, now, sessionId = null) {
    return this.store.expireActive({
      ...scope,
      ...(sessionId ? { sessionId } : {}),
      now: now.toISOString(),
      shouldExpire: (session) => isSessionExpired(session, now),
      buildExpired: (session) => ({
        ...session,
        status: 'expired',
        revision: session.revision + 1,
        updatedAt: now.toISOString(),
        endedAt: now.toISOString(),
        endReason: session.status === 'lobby' ? 'lobby-timeout' : 'inactivity-timeout',
      }),
    });
  }

  async start(input) {
    const scope = this._normalizeScope(input);
    const hostId = requireIdentifier(input.hostId, 'hostId');
    const interactionId = requireIdentifier(input.interactionId, 'interactionId', 160);
    const engine = this.registry.get(input.gameKey);
    const requestedOptions = cloneJson(input.options || {}, 'options');
    const rules = engine.normalizeOptions
      ? cloneJson(safeEngineCall(() => engine.normalizeOptions(requestedOptions)), 'rules')
      : requestedOptions;
    const now = this._now();
    await this._expireScope(scope, now);
    const sessionId = requireIdentifier(this.idFactory(), 'generated session id', 128);
    const seed = requireIdentifier(this.seedFactory(), 'generated seed', 256);
    const session = {
      id: sessionId,
      ...scope,
      messageId: null,
      gameKey: engine.key,
      rulesVersion: engine.rulesVersion,
      status: 'lobby',
      hostId,
      players: [{ userId: hostId, seat: 0, status: 'active', joinedAt: now.toISOString() }],
      rules,
      seed,
      state: null,
      turn: null,
      outcome: null,
      revision: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastProgressAt: now.toISOString(),
      expiresAt: addMilliseconds(now, LOBBY_TIMEOUT_MS),
      endedAt: null,
      endReason: null,
    };
    const requestDigest = digestRequest({ operation: 'start', ...scope, hostId, gameKey: engine.key, rules });
    const stored = await this.store.createSession({ session, interactionId, requestDigest });
    const result = this._publicResult(stored.session, hostId, [{ type: 'lobby-created' }], stored.replayed);
    return this._present(result, hostId);
  }

  async join(input) {
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const now = this._now();
    const request = this._normalizeMutation(input, 'join', { actorId });
    const stored = await this.store.mutate(request, (session) => {
      if (session.status !== 'lobby') throw new BoardCoreError('LOBBY_CLOSED', 'The lobby is closed.');
      const engine = this._engine(session);
      if (findPlayer(session, actorId)) throw new BoardCoreError('ALREADY_JOINED', 'The player already joined this session.');
      if (session.players.length >= engine.maxPlayers) throw new BoardCoreError('LOBBY_FULL', 'The lobby is full.');
      const next = cloneJson(session);
      next.players.push({ userId: actorId, seat: next.players.length, status: 'active', joinedAt: now.toISOString() });
      next.revision += 1;
      next.updatedAt = now.toISOString();
      return {
        session: next,
        events: [{ type: 'player-joined', playerId: actorId }],
        action: { type: 'join', actorId },
      };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async begin(input) {
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const now = this._now();
    const request = this._normalizeMutation(input, 'begin', { actorId });
    const stored = await this.store.mutate(request, (session) => {
      if (session.status !== 'lobby') throw new BoardCoreError('LOBBY_CLOSED', 'The lobby is closed.');
      if (session.hostId !== actorId) throw new BoardCoreError('HOST_ONLY', 'Only the lobby host can start the game.');
      const engine = this._engine(session);
      assertPlayerCount(engine, session.players.length);
      const players = session.players.map((player) => player.userId);
      const initialState = assertEngineState(safeEngineCall(() => engine.createInitialState({
        players: Object.freeze([...players]),
        rules: cloneJson(session.rules),
        seed: session.seed,
      })), { gameKey: session.gameKey, rulesVersion: session.rulesVersion });
      const next = cloneJson(session);
      next.status = 'active';
      next.state = initialState;
      next.turn = cloneJson(initialState.turn ?? null);
      next.revision += 1;
      next.updatedAt = now.toISOString();
      next.lastProgressAt = now.toISOString();
      next.expiresAt = addMilliseconds(now, ACTIVE_TIMEOUT_MS);
      return {
        session: next,
        events: [{ type: 'game-started' }],
        action: { type: 'begin', actorId },
      };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async bindMessage(input) {
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const messageId = requireIdentifier(input.messageId, 'messageId');
    const now = this._now();
    const request = this._normalizeMutation(input, 'bind-message', { actorId, messageId });
    const stored = await this.store.mutate(request, (session) => {
      if (session.hostId !== actorId) throw new BoardCoreError('HOST_ONLY', 'Only the lobby host can bind the session message.');
      if (session.messageId && session.messageId !== messageId) {
        throw new BoardCoreError('MESSAGE_MISMATCH', 'The session is already bound to another message.');
      }
      if (session.messageId === messageId) {
        return { session, events: [], action: null };
      }
      const next = { ...cloneJson(session), messageId, revision: session.revision + 1, updatedAt: now.toISOString() };
      return { session: next, events: [{ type: 'message-bound' }], action: { type: 'bind-message', actorId } };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async abortUnboundLobby(input) {
    const scope = this._normalizeScope(input);
    const sessionId = requireIdentifier(input.sessionId, 'sessionId');
    const hostId = requireIdentifier(input.hostId, 'hostId');
    const now = this._now();
    const session = await this.store.expireActive({
      ...scope,
      sessionId,
      now: now.toISOString(),
      shouldExpire: (current) => current.id === sessionId && current.status === 'lobby' &&
        current.hostId === hostId && current.messageId == null,
      buildExpired: (current) => ({
        ...current,
        status: 'expired',
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        endedAt: now.toISOString(),
        endReason: 'message-bind-failed',
      }),
    });
    if (!session || session.id !== sessionId || session.status !== 'expired' || session.endReason !== 'message-bind-failed') {
      return null;
    }
    return this._publicResult(session, hostId, [{ type: 'session-aborted', reason: session.endReason }]);
  }

  async rebindMessage(input) {
    const sessionId = requireIdentifier(input.sessionId, 'sessionId');
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const oldMessageId = requireIdentifier(input.oldMessageId, 'oldMessageId');
    const newMessageId = requireIdentifier(input.newMessageId, 'newMessageId');
    if (oldMessageId === newMessageId) throw new BoardCoreError('MESSAGE_MISMATCH', 'Replacement message must be new.');
    const now = this._now();
    const request = this._normalizeMutation(input, 'rebind-message', {
      sessionId,
      actorId,
      oldMessageId,
      newMessageId,
    });
    const stored = await this.store.mutate(request, (session) => {
      if (session.id !== sessionId) throw new BoardCoreError('SESSION_MISMATCH', 'Another board session is active in this channel.');
      if (!['lobby', 'active'].includes(session.status)) throw new BoardCoreError('SESSION_NOT_ACTIVE', 'The session is already closed.');
      const player = findPlayer(session, actorId);
      if (!player || player.status !== 'active') throw new BoardCoreError('NOT_A_PLAYER', 'Only active players can recover the session message.');
      if (!session.messageId || session.messageId !== oldMessageId) {
        throw new BoardCoreError('MESSAGE_MISMATCH', 'The stored board message changed before recovery.');
      }
      const next = {
        ...cloneJson(session),
        messageId: newMessageId,
        revision: session.revision + 1,
        updatedAt: now.toISOString(),
      };
      return {
        session: next,
        events: [{ type: 'message-rebound', oldMessageId, newMessageId }],
        action: { type: 'rebind-message', actorId },
      };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async leave(input) {
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const now = this._now();
    const request = this._normalizeMutation(input, 'leave', { actorId });
    const stored = await this.store.mutate(request, (session) => {
      const player = findPlayer(session, actorId);
      if (!player || player.status !== 'active') throw new BoardCoreError('NOT_A_PLAYER', 'The user is not an active player.');
      const next = cloneJson(session);
      if (session.status === 'lobby') {
        if (session.hostId === actorId) {
          next.status = 'cancelled';
          next.endedAt = now.toISOString();
          next.endReason = 'host-left';
        } else {
          next.players = next.players.filter((entry) => entry.userId !== actorId)
            .map((entry, seat) => ({ ...entry, seat }));
        }
        next.revision += 1;
        next.updatedAt = now.toISOString();
        return {
          session: next,
          events: [{ type: session.hostId === actorId ? 'lobby-cancelled' : 'player-left', playerId: actorId }],
          action: { type: 'leave', actorId },
        };
      }
      if (session.status !== 'active') throw new BoardCoreError('SESSION_NOT_ACTIVE', 'The session is not active.');
      const target = next.players.find((entry) => entry.userId === actorId);
      target.status = 'retired';
      target.retiredAt = now.toISOString();
      let events = [{ type: 'player-retired', playerId: actorId }];
      if (session.gameKey === 'turtle-soup') {
        const remaining = activePlayerIds(next);
        if (remaining.length === 0) {
          next.status = 'cancelled';
          next.endedAt = now.toISOString();
          next.endReason = 'all-players-left';
        } else if (next.hostId === actorId) {
          next.hostId = remaining[0];
        }
      } else {
        const engine = this._engine(session);
        const transition = applyEngineAction(
          engine,
          session,
          createTrustedSystemAction('player-retired', { playerId: actorId }),
          engineContext(session, actorId, now)
        );
        next.state = transition.state;
        next.turn = cloneJson(transition.state.turn ?? null);
        next.outcome = transition.outcome;
        events = [...events, ...transition.events];
        if (transition.outcome?.terminal === true) {
          next.status = 'completed';
          next.endedAt = now.toISOString();
          next.endReason = transition.outcome.reason;
        }
      }
      if (next.status === 'completed') {
        next.endedAt = now.toISOString();
      }
      next.revision += 1;
      next.updatedAt = now.toISOString();
      next.lastProgressAt = now.toISOString();
      next.expiresAt = addMilliseconds(now, ACTIVE_TIMEOUT_MS);
      return {
        session: next,
        events,
        action: { type: 'player-retired', actorId },
      };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async stop(input) {
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const now = this._now();
    const request = this._normalizeMutation(input, 'stop', { actorId });
    const stored = await this.store.mutate(request, (session) => {
      if (session.hostId !== actorId) throw new BoardCoreError('HOST_ONLY', 'Only the host can stop this session.');
      const next = cloneJson(session);
      if (session.status === 'lobby') {
        next.status = 'cancelled';
        next.endReason = 'host-cancelled';
      } else if (session.status === 'active' && session.gameKey === 'turtle-soup') {
        next.status = 'completed';
        next.outcome = { terminal: true, type: 'draw', winnerIds: [], loserIds: [], reason: 'host-ended' };
        next.endReason = 'host-ended';
      } else if (session.status === 'active') {
        throw new BoardCoreError('RESIGN_REQUIRED', 'Active board games cannot be stopped; leave to resign.');
      } else {
        throw new BoardCoreError('SESSION_NOT_ACTIVE', 'The session is already closed.');
      }
      next.revision += 1;
      next.updatedAt = now.toISOString();
      next.endedAt = now.toISOString();
      return { session: next, events: [{ type: 'session-stopped', reason: next.endReason }], action: { type: 'stop', actorId } };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async submitAction(input) {
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const messageId = requireIdentifier(input.messageId, 'messageId');
    const action = cloneJson(input.action, 'action');
    assertUserAction(action);
    const now = this._now();
    const request = this._normalizeMutation(input, 'action', { actorId, messageId, action });
    const stored = await this.store.mutate(request, (session) => {
      if (session.status !== 'active') throw new BoardCoreError('SESSION_NOT_ACTIVE', 'The session is not active.');
      if (!session.messageId) throw new BoardCoreError('MESSAGE_NOT_BOUND', 'The session message is not bound.');
      if (session.messageId !== messageId) throw new BoardCoreError('MESSAGE_MISMATCH', 'The interaction came from another message.');
      const player = findPlayer(session, actorId);
      if (!player || player.status !== 'active') throw new BoardCoreError('NOT_A_PLAYER', 'The user is not an active player.');
      const engine = this._engine(session);
      const transition = applyEngineAction(
        engine,
        session,
        Object.freeze(cloneJson(action)),
        engineContext(session, actorId, now)
      );
      const next = cloneJson(session);
      next.state = transition.state;
      next.turn = cloneJson(transition.state.turn ?? null);
      next.outcome = transition.outcome;
      if (transition.outcome?.terminal === true) {
        next.status = 'completed';
        next.endedAt = now.toISOString();
        next.endReason = transition.outcome.reason;
      }
      next.revision += 1;
      next.updatedAt = now.toISOString();
      next.lastProgressAt = now.toISOString();
      next.expiresAt = addMilliseconds(now, ACTIVE_TIMEOUT_MS);
      return {
        session: next,
        events: transition.events,
        action: { type: 'engine-action', actorId, payload: action },
      };
    });
    return this._present(this._publicResult(stored.session, actorId, stored.events, stored.replayed), actorId);
  }

  async status(input) {
    const scope = this._normalizeScope(input);
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const now = this._now();
    await this._expireScope(scope, now);
    const session = await this.store.getActiveSession(scope);
    if (!session) throw new BoardCoreError('SESSION_NOT_FOUND', 'There is no active board session in this channel.');
    return this._publicResult(session, actorId);
  }

  async recoverSession(input) {
    const sessionId = requireIdentifier(input.sessionId, 'sessionId');
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const session = await this.store.getSessionById(sessionId);
    if (!session) throw new BoardCoreError('SESSION_NOT_FOUND', 'The board session does not exist.');
    return this._present(this._publicResult(session, actorId), actorId, { force: true });
  }

  async refreshSession(input) {
    const sessionId = requireIdentifier(input.sessionId, 'sessionId');
    const scope = this._normalizeScope(input);
    const messageId = requireIdentifier(input.messageId, 'messageId');
    const actorId = requireIdentifier(input.actorId, 'actorId');
    let session = await this.store.getSessionById(sessionId);
    if (!session) throw new BoardCoreError('SESSION_NOT_FOUND', 'The board session does not exist.');
    if (session.guildId !== scope.guildId || session.channelId !== scope.channelId) {
      throw new BoardCoreError('SESSION_SCOPE_MISMATCH', 'The board session belongs to another server or channel.');
    }
    if (!session.messageId || session.messageId !== messageId) {
      throw new BoardCoreError('MESSAGE_MISMATCH', 'The board session belongs to another message.');
    }
    const player = findPlayer(session, actorId);
    if (!player || player.status !== 'active') throw new BoardCoreError('NOT_A_PLAYER', 'The user is not an active player.');
    if (session.status === 'lobby' || session.status === 'active') {
      await this._expireScope(scope, this._now(), session.id);
      session = await this.store.getSessionById(sessionId);
      if (!session) throw new BoardCoreError('SESSION_NOT_FOUND', 'The board session does not exist.');
    }
    return this._present(this._publicResult(session, actorId), actorId, { force: true });
  }

  async readSession(input) {
    const sessionId = requireIdentifier(input.sessionId, 'sessionId');
    const actorId = requireIdentifier(input.actorId, 'actorId');
    const session = await this.store.getSessionById(sessionId);
    if (!session) throw new BoardCoreError('SESSION_NOT_FOUND', 'The board session does not exist.');
    return this._publicResult(session, actorId);
  }
}

module.exports = {
  BoardSessionService,
  activePlayerIds,
  applyEngineAction,
  engineContext,
  retiredPlayerIds,
};
