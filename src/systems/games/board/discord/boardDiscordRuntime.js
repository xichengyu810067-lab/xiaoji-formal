const { randomBytes, randomUUID } = require('node:crypto');
const { BoardSessionService } = require('../../../../games/boardSessionService');
const { createBoardLifecycle } = require('../../../../games/boardLifecycle');
const { BoardCoreError } = require('../../../../games/contracts');
const { BoardEngineRegistry } = require('../../../../games/engineRegistry');
const chess = require('../engines/chess');
const checkers = require('../engines/checkers');
const go = require('../engines/go');
const gomoku = require('../engines/gomoku');
const turtleSoup = require('../engines/turtleSoup');
const xiangqi = require('../engines/xiangqi');
const { renderBoardPng } = require('../renderer/svgBoardRenderer');
const { createSqliteBoardStore } = require('../storage/sqliteBoardStore');
const { createBoardStoreJudgeCommitter } = require('../turtleSoup/boardStoreAdapter');
const { TurtleSoupError } = require('../turtleSoup/errors');
const { createTurtleSoupJudgeWorkflow } = require('../turtleSoup/judgeWorkflow');
const { createJudgeProvider } = require('../turtleSoup/providerAdapter');
const { createTurtleSoupRevealService } = require('../turtleSoup/revealService');
const { createFileScenarioProvider } = require('../turtleSoup/scenarioProvider');
const { isGuildApproved: defaultIsGuildApproved } = require('../../../../services/auditService');
const { isBotOwner: defaultIsBotOwner } = require('../../../../utils/ownerOnly');
const logger = require('../../../../utils/logger');
const { parseBoardCustomId } = require('./boardCustomId');
const { createDiscordBoardInteractionAdapter, assertSessionBoundary, getInteractionIdentity } = require('./boardInteractionAdapter');
const { createDiscordBoardPresenter } = require('./boardPresenter');
const { createTurtleSoupDiscordAdapter } = require('./turtleSoupDiscordAdapter');
const {
  createActionParsers,
  decorateBoardResult,
  getModalDefinition,
} = require('./boardControls');
const { buildBoardModal, createDiscordBoardTransport } = require('./discordBoardBridge');

const AUDIT_PENDING_MESSAGE = '小吉在這個伺服器尚未通過機器人擁有者的審核，暫時無法提供服務。請耐心等待批准。';

const FRIENDLY_ERRORS = Object.freeze({
  ACTION_NOT_AVAILABLE: '這個操作目前不能使用，請重新整理棋盤。',
  ACTION_NOT_LEGAL: '這一步不符合目前規則。',
  ALREADY_JOINED: '你已經在這個棋局裡了。',
  BOARD_REBIND_UNAVAILABLE: '舊棋盤訊息已刪除；目前版本尚未啟用安全換綁，棋局資料仍完整保留。',
  CLAIM_NOT_AVAILABLE: '目前不能宣告和棋。',
  CORPUS_UNAVAILABLE: '海龜湯題庫暫時無法使用；其他棋類不受影響。',
  GAME_NOT_AVAILABLE: '這個遊戲目前無法使用。',
  HOST_ONLY: '只有房主可以執行這個操作。',
  INVALID_ACTION: '輸入內容不符合這個遊戲的規則。',
  INVALID_COORDINATE: '座標格式或範圍不正確，請依輸入視窗的範例重試。',
  INVALID_PLAYER_COUNT: '目前玩家人數不符合這個遊戲的開局規則。',
  LOBBY_CLOSED: '這個等候室已經關閉。',
  LOBBY_FULL: '這個等候室已滿。',
  MESSAGE_MISMATCH: '這個控制不是目前棋盤的最新版，請使用最新訊息。',
  NOT_A_PLAYER: '只有目前棋局的參與者可以執行這個操作。',
  NOT_YOUR_TURN: '現在還沒輪到你。',
  RESIGN_REQUIRED: '進行中的棋局不能直接停止；請使用離開／認輸。',
  SESSION_ALREADY_ACTIVE: '這個頻道已有進行中的棋局。',
  SESSION_NOT_ACTIVE: '這個棋局已經結束。',
  SESSION_NOT_FOUND: '這個頻道目前沒有進行中的棋局。',
  SESSION_SCOPE_MISMATCH: '這個棋盤不屬於目前伺服器或頻道。',
  STALE_REVISION: '棋盤已更新，請使用最新訊息上的按鈕。',
});

function friendlyError(error) {
  return FRIENDLY_ERRORS[error?.code] || '小吉暫時無法處理這個棋盤操作，請稍後再試。';
}

async function privateReply(interaction, content) {
  const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
  if (interaction.deferred) {
    if (interaction.__boardReplyDeferred && typeof interaction.editReply === 'function') {
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } else {
      await interaction.followUp(payload);
    }
  } else if (interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

function createUnavailableScenarioProvider() {
  return Object.freeze({
    loadScenario() {
      throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Turtle soup corpus is unavailable.', { retryable: true });
    },
  });
}

function createUnavailableJudgeProvider() {
  return Object.freeze({
    async judge() {
      throw new TurtleSoupError('JUDGE_UNAVAILABLE', 'Turtle soup judge is unavailable.', { retryable: true });
    },
  });
}

function loadSessionInScope(store) {
  return async ({ id, guildId, channelId }) => {
    const session = await store.getSessionById(id);
    if (!session || session.guildId !== guildId || session.channelId !== channelId) {
      throw new TurtleSoupError('SESSION_MISMATCH', 'Turtle soup session scope does not match.');
    }
    return session;
  };
}

function statusSummary(result) {
  const labels = {
    lobby: '等待玩家', active: '進行中', completed: '已完成', cancelled: '已取消', expired: '已逾時',
  };
  const activePlayers = result.session.players.filter((player) => player.status === 'active').length;
  return `目前棋局：${labels[result.session.status] || result.session.status}，玩家 ${activePlayers} 人，棋盤版本 ${result.session.revision}。`;
}

function assertApprovedGuild(interaction, { isGuildApproved, isBotOwner }) {
  if (!interaction?.guildId || !interaction?.channelId || !interaction?.user?.id) {
    throw new BoardCoreError('SESSION_SCOPE_MISMATCH', '桌遊只能在伺服器文字頻道中使用。');
  }
  if (!isBotOwner(interaction.user.id) && !isGuildApproved(interaction.guildId)) {
    throw new BoardCoreError('GUILD_NOT_APPROVED', AUDIT_PENDING_MESSAGE);
  }
}

function createBoardDiscordRuntime({
  client,
  store = null,
  registry = null,
  scenarioProvider = null,
  privateCorpusRoot = null,
  judgeProvider = null,
  transport = null,
  rebindSessionMessage = null,
  isGuildApproved = defaultIsGuildApproved,
  isBotOwner = defaultIsBotOwner,
  clock = () => new Date(),
  idFactory = () => randomUUID(),
  seedFactory = () => randomBytes(24).toString('hex'),
  lifecycleIntervalMs = 60_000,
  renderPngImpl = renderBoardPng,
  runtimeLogger = logger,
} = {}) {
  const boardStore = store || createSqliteBoardStore();
  const engineRegistry = registry || new BoardEngineRegistry([turtleSoup, chess, gomoku, go, checkers, xiangqi]);
  const discordTransport = transport || createDiscordBoardTransport({ client });

  let corpus = scenarioProvider;
  if (!corpus && privateCorpusRoot) {
    try {
      corpus = createFileScenarioProvider({ rootDir: privateCorpusRoot });
    } catch (error) {
      runtimeLogger?.error?.('turtle soup corpus initialization failed', error);
    }
  }
  let judge = judgeProvider;
  if (!judge) {
    try {
      judge = createJudgeProvider();
    } catch (_error) {
      judge = createUnavailableJudgeProvider();
    }
  }
  const safeScenarioProvider = corpus || createUnavailableScenarioProvider();

  const rawPresenter = createDiscordBoardPresenter({
    renderPng: (view, options) => renderPngImpl(view, options),
    transport: discordTransport,
  });
  const presenter = Object.freeze({
    async refresh(result) {
      const decorated = await decorateBoardResult(result, {
        store: boardStore,
        scenarioProvider: corpus,
      });
      return rawPresenter.refresh(decorated);
    },
  });
  const service = new BoardSessionService({
    store: boardStore,
    registry: engineRegistry,
    clock,
    idFactory,
    seedFactory,
    presenter,
  });
  const interactionAdapter = createDiscordBoardInteractionAdapter({
    service,
    store: boardStore,
    actionParsers: createActionParsers(),
  });
  const loadSession = loadSessionInScope(boardStore);
  const commitPrepared = createBoardStoreJudgeCommitter({ store: boardStore, clock });
  const turtleWorkflow = createTurtleSoupJudgeWorkflow({
    loadSession,
    scenarioProvider: safeScenarioProvider,
    judgeProvider: judge,
    commitPrepared,
    engine: turtleSoup,
    clock,
  });
  const revealService = createTurtleSoupRevealService({ loadSession, scenarioProvider: safeScenarioProvider });
  const turtleAdapter = createTurtleSoupDiscordAdapter({
    workflow: turtleWorkflow,
    revealService,
    service,
    store: boardStore,
  });
  const lifecycle = createBoardLifecycle({
    store: boardStore,
    service,
    clock,
    intervalMs: lifecycleIntervalMs,
    logger: runtimeLogger,
  });

  async function prepareStartOptions(gameKey) {
    if (gameKey !== 'turtle-soup') return {};
    if (!corpus) throw new BoardCoreError('CORPUS_UNAVAILABLE', 'Turtle soup corpus is unavailable.');
    return corpus.selectScenarioReference();
  }

  async function bindInitialMessage(interaction, started) {
    try {
      const initial = {
        content: '正在建立棋盤…',
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred) await interaction.editReply(initial);
      else await interaction.reply(initial);
      const message = await interaction.fetchReply();
      const bound = await service.bindMessage({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorId: interaction.user.id,
        messageId: message.id,
        expectedRevision: started.session.revision,
        interactionId: `${interaction.id}:bind`,
      });
      lifecycle.track(bound.session);
      return bound;
    } catch (error) {
      try {
        const aborted = await service.abortUnboundLobby({
          sessionId: started.session.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          hostId: interaction.user.id,
        });
        if (aborted) lifecycle.track(aborted.session);
      } catch (_rollbackError) {
        // A successfully bound or concurrently changed session must never be cancelled here.
      }
      throw error;
    }
  }

  async function recoverDeletedMessage(interaction, result) {
    const session = result.session;
    const player = session.players.find((entry) => entry.userId === interaction.user.id && entry.status === 'active');
    if (!player) throw new BoardCoreError('NOT_A_PLAYER', 'Only active players can recover a deleted board message.');
    const replacement = await discordTransport.createReplacement({
      guildId: session.guildId,
      channelId: session.channelId,
    });
    if (replacement.guildId !== session.guildId || replacement.channelId !== session.channelId) {
      throw new BoardCoreError('SESSION_SCOPE_MISMATCH', 'Replacement message escaped the original board scope.');
    }
    const rebind = rebindSessionMessage || ((request) => service.rebindMessage(request));
    const rebound = await rebind({
      service,
      store: boardStore,
      sessionId: session.id,
      guildId: session.guildId,
      channelId: session.channelId,
      actorId: interaction.user.id,
      oldMessageId: session.messageId,
      newMessageId: replacement.id,
      expectedRevision: session.revision,
      interactionId: `${interaction.id}:rebind`,
    });
    const reboundSession = rebound?.session || rebound;
    if (!reboundSession || reboundSession.id !== session.id || reboundSession.guildId !== session.guildId ||
        reboundSession.channelId !== session.channelId || reboundSession.messageId !== replacement.id) {
      throw new BoardCoreError('STORE_CONTRACT_VIOLATION', 'Board rebind hook returned an invalid session.');
    }
    const refreshed = await service.recoverSession({ sessionId: session.id, actorId: interaction.user.id });
    lifecycle.track(refreshed.session);
    return refreshed;
  }

  async function startGame(interaction, gameKey) {
    assertApprovedGuild(interaction, { isGuildApproved, isBotOwner });
    if (typeof interaction.deferReply === 'function' && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
    const options = await prepareStartOptions(gameKey);
    const started = await service.start({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      hostId: interaction.user.id,
      gameKey,
      options,
      interactionId: interaction.id,
    });
    lifecycle.track(started.session);
    return bindInitialMessage(interaction, started);
  }

  async function executeCommand(interaction) {
    try {
      assertApprovedGuild(interaction, { isGuildApproved, isBotOwner });
      const action = interaction.options.getSubcommand();
      if (action === 'start') {
        const gameKey = interaction.options.getString('game', true);
        return await startGame(interaction, gameKey);
      }

      const current = await service.status({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorId: interaction.user.id,
      });
      let result = current;
      if (action === 'join') {
        result = await service.join({
          guildId: interaction.guildId, channelId: interaction.channelId, actorId: interaction.user.id,
          expectedRevision: current.session.revision, interactionId: interaction.id,
        });
      } else if (action === 'leave') {
        result = await service.leave({
          guildId: interaction.guildId, channelId: interaction.channelId, actorId: interaction.user.id,
          expectedRevision: current.session.revision, interactionId: interaction.id,
        });
      } else if (action === 'stop') {
        result = await service.stop({
          guildId: interaction.guildId, channelId: interaction.channelId, actorId: interaction.user.id,
          expectedRevision: current.session.revision, interactionId: interaction.id,
        });
      } else if (action === 'status') {
        const participant = current.session.players.some((player) => player.userId === interaction.user.id && player.status === 'active');
        if (participant && current.session.messageId) {
          const exists = await discordTransport.messageExists({
            guildId: current.session.guildId,
            channelId: current.session.channelId,
            messageId: current.session.messageId,
          });
          result = exists
            ? await service.refreshSession({
              sessionId: current.session.id,
              guildId: current.session.guildId,
              channelId: current.session.channelId,
              messageId: current.session.messageId,
              actorId: interaction.user.id,
            })
            : await recoverDeletedMessage(interaction, current);
        }
      } else {
        throw new BoardCoreError('INVALID_ACTION', 'Unknown board command action.');
      }
      lifecycle.track(result.session);
      await privateReply(interaction, statusSummary(result));
      return result;
    } catch (error) {
      runtimeLogger?.error?.('board command failed', error);
      const content = error?.code === 'GUILD_NOT_APPROVED' ? AUDIT_PENDING_MESSAGE : friendlyError(error);
      if (interaction.deferred && !interaction.__boardReplyDeferred) {
        await interaction.editReply({ content, allowedMentions: { parse: [] } });
      } else await privateReply(interaction, content);
      return { ok: false, code: error?.code || 'BOARD_COMMAND_FAILED' };
    }
  }

  async function handleInteraction(interaction) {
    if (!String(interaction?.customId || '').startsWith('board|')) return false;
    try {
      assertApprovedGuild(interaction, { isGuildApproved, isBotOwner });
      const decoded = parseBoardCustomId(interaction.customId);
      const session = await boardStore.getSessionById(decoded.sessionId);

      if (interaction.isButton?.()) {
        const modal = getModalDefinition(session?.gameKey, decoded.verb.startsWith('act.') ? decoded.verb.slice(4) : '');
        if (modal) {
          const identity = getInteractionIdentity(interaction);
          assertSessionBoundary(session, identity, decoded, decoded.verb);
          if (session.revision !== decoded.revision) throw new BoardCoreError('STALE_REVISION', 'Board control is stale.');
          await interaction.showModal(buildBoardModal(interaction.customId, modal));
          return true;
        }
      }

      const turtleAction = session?.gameKey === 'turtle-soup' &&
        ['act.ask', 'act.guess', 'reveal'].includes(decoded.verb);
      if (interaction.isModalSubmit?.() || turtleAction) {
        await interaction.deferReply({ ephemeral: true });
        interaction.__boardReplyDeferred = true;
        const result = turtleAction
          ? await turtleAdapter.handle(interaction)
          : await interactionAdapter.handle(interaction);
        lifecycle.track(result?.board?.session || result?.session);
        const content = result?.revealText || result?.content || '棋盤已更新。';
        await privateReply(interaction, content);
        return true;
      }

      await interaction.deferUpdate();
      const result = await interactionAdapter.handle(interaction);
      lifecycle.track(result.session);
      return true;
    } catch (error) {
      runtimeLogger?.error?.('board interaction failed', error);
      await privateReply(interaction, error?.code === 'GUILD_NOT_APPROVED' ? AUDIT_PENDING_MESSAGE : friendlyError(error));
      return true;
    }
  }

  return Object.freeze({
    executeCommand,
    startGame,
    handleInteraction,
    startLifecycle: () => lifecycle.start(),
    stopLifecycle: () => lifecycle.stop(),
    lifecycle,
    service,
    store: boardStore,
    transport: discordTransport,
    hasPrivateCorpus: () => Boolean(corpus),
  });
}

module.exports = {
  AUDIT_PENDING_MESSAGE,
  FRIENDLY_ERRORS,
  createBoardDiscordRuntime,
  friendlyError,
  privateReply,
  statusSummary,
};
