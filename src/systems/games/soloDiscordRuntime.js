const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { GAME_CHOICES } = require('../../games/discord/boardControls');
const { getBoardRuntime } = require('../../games/boardRuntimeRegistry');
const { isGuildApproved: defaultIsGuildApproved } = require('../../services/auditService');
const { isBotOwner: defaultIsBotOwner } = require('../../utils/ownerOnly');
const { createSoloSessionService } = require('./soloSessionService');
const { GameError } = require('./soloGameError');
const { buildSoloMessagePayload } = require('./soloPresenter');
const { parseSoloCustomId } = require('./soloCustomId');

const SOLO_CHOICES = Object.freeze([
  { label: '俄羅斯方塊', value: 'solo:tetris' },
  { label: '數字配對', value: 'solo:number-match' },
  { label: '數獨', value: 'solo:sudoku' },
]);
const DIFFICULTY_CHOICES = Object.freeze([
  { label: '簡單', value: 'easy' }, { label: '一般', value: 'normal' },
  { label: '複雜', value: 'complex' }, { label: '困難', value: 'hard' },
]);

function menuPayload() {
  return {
    content: '選擇遊戲。個人遊戲只由建立者操作；桌遊會在目前頻道建立等候室。',
    components: [{ type: 1, components: [{ type: 3, custom_id: 'solo|1|menu', placeholder: '選擇遊戲',
      options: [...SOLO_CHOICES, ...GAME_CHOICES.map((choice) => ({ label: choice.name, value: `board:${choice.value}` }))] }] }],
    ephemeral: true, allowedMentions: { parse: [] },
  };
}

function difficultyPayload(game) {
  if (!SOLO_CHOICES.some((choice) => choice.value === `solo:${game}`)) throw new GameError('INVALID_REQUEST', 'Unsupported game.');
  return {
    content: '選擇難度。',
    components: [{ type: 1, components: [{ type: 3, custom_id: `solo|1|difficulty|${game}`, placeholder: '選擇難度', options: DIFFICULTY_CHOICES }] }],
    ephemeral: true, allowedMentions: { parse: [] },
  };
}

function modalForMove(customId, verb) {
  const definitions = {
    'move.t': { title: '俄羅斯方塊：落下一塊', fields: [['column', '欄位（1–10）'], ['rotation', '旋轉（0–3）']] },
    'move.n': { title: '數字配對：選兩格', fields: [['first', '第一格（例：A1）'], ['second', '第二格（例：B1）']] },
    'move.s': { title: '數獨：填入格子', fields: [['cell', '格子（例：A1）'], ['value', '數字（1–9；0 清除）']] },
  };
  const definition = definitions[verb];
  if (!definition) throw new GameError('INVALID_CUSTOM_ID', 'Unsupported game move.');
  const modal = new ModalBuilder().setCustomId(customId).setTitle(definition.title);
  for (const [id, label] of definition.fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)));
  }
  return modal;
}

function coordinate(text, rows, columns) {
  const match = /^([A-Za-z])(\d{1,2})$/u.exec(String(text || '').trim());
  if (!match) throw new GameError('INVALID_ACTION', '請用 A1 這種座標。');
  const column = match[1].toUpperCase().charCodeAt(0) - 65;
  const row = Number(match[2]) - 1;
  if (column < 0 || column >= columns || row < 0 || row >= rows) throw new GameError('INVALID_ACTION', '座標超出棋盤。');
  return { row, column, index: row * columns + column };
}

function parseMove(interaction, session) {
  const value = (name) => String(interaction.fields.getTextInputValue(name) || '').trim();
  const wholeNumber = (name) => {
    const text = value(name);
    if (!/^\d{1,2}$/u.test(text)) throw new GameError('INVALID_ACTION', '請輸入有效數字。');
    return Number(text);
  };
  if (session.gameType === 'tetris') {
    const column = wholeNumber('column') - 1;
    const rotation = wholeNumber('rotation');
    if (!Number.isInteger(column) || !Number.isInteger(rotation) || column < 0 || column > 9 || rotation < 0 || rotation > 3) {
      throw new GameError('INVALID_ACTION', '欄位或旋轉不正確。');
    }
    return { type: 'lock', column, rotation };
  }
  if (session.gameType === 'number-match') {
    const first = coordinate(value('first'), session.state.rows, session.state.columns);
    const second = coordinate(value('second'), session.state.rows, session.state.columns);
    return { type: 'pair', first: first.index, second: second.index };
  }
  const cell = coordinate(value('cell'), 9, 9);
  const number = wholeNumber('value');
  if (!Number.isInteger(number) || number < 0 || number > 9) throw new GameError('INVALID_ACTION', '數字須為 0–9。');
  return { type: 'set', row: cell.row, column: cell.column, value: number };
}

function friendlyError(error) {
  const messages = {
    NOT_OWNER: '只有這局的建立者可以操作。', SESSION_SCOPE_MISMATCH: '這不是原本的伺服器或頻道。',
    MESSAGE_MISMATCH: '請使用目前的遊戲訊息。', STALE_REVISION: '遊戲已更新，請按重新整理。',
    SESSION_EXPIRED: '這局已逾時，請開始新遊戲。', SESSION_NOT_ACTIVE: '這局已結束。',
    ACTION_LIMIT_REACHED: '這局已達操作次數上限。',
    SESSION_NOT_FOUND: '找不到這局。', INVALID_ACTION: error?.message || '這一步不符合規則。',
    GIVEN_LOCKED: '數獨題目原有的數字不能修改。',
    GUILD_NOT_APPROVED: '小吉在這個伺服器尚未通過機器人擁有者的審核，暫時無法提供服務。',
  };
  return messages[error?.code] || '遊戲目前無法處理，請稍後再試。';
}

function createSoloDiscordRuntime({ service, client, boardRuntime = getBoardRuntime, renderPng, runtimeLogger,
  isGuildApproved = defaultIsGuildApproved, isBotOwner = defaultIsBotOwner } = {}) {
  if (!service) throw new GameError('STORE_NOT_CONFIGURED', 'Solo game service is required.');
  const payload = (session) => buildSoloMessagePayload(session, { renderPng });

  function assertAdmitted(interaction) {
    if (!interaction?.guildId || !interaction?.channelId || !interaction?.user?.id) {
      throw new GameError('INVALID_REQUEST', 'Guild channel required.');
    }
    if (!isBotOwner(interaction.user.id) && !isGuildApproved(interaction.guildId)) {
      throw new GameError('GUILD_NOT_APPROVED', 'Guild admission is required.');
    }
  }

  async function fetchPanel(session) {
    const channel = await client.channels.fetch(session.channelId);
    if (!channel || channel.guildId !== session.guildId) throw new GameError('SESSION_SCOPE_MISMATCH', 'Game channel changed.');
    return channel.messages.fetch(session.messageId);
  }

  async function editPanel(session) {
    const message = await fetchPanel(session);
    await message.edit(payload(session));
  }

  async function start(interaction, gameType, difficulty) {
    assertAdmitted(interaction);
    await interaction.deferReply();
    const created = await service.create({ userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId, gameType, difficulty });
    await interaction.editReply(payload(created));
    const message = await interaction.fetchReply();
    return service.bindMessage({ sessionId: created.id, actorId: interaction.user.id, guildId: interaction.guildId,
      channelId: interaction.channelId, messageId: message.id });
  }

  async function resume(interaction) {
    assertAdmitted(interaction);
    await interaction.deferReply({ ephemeral: true });
    const session = await service.findLatest({ actorId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId });
    if (!session) return interaction.editReply({ content: '目前沒有進行中的個人遊戲。', allowedMentions: { parse: [] } });
    if (session.messageId) {
      let existing = null;
      try {
        existing = await fetchPanel(session);
      } catch (error) {
        if (Number(error?.code) !== 10008) throw error;
      }
      if (existing) {
        await existing.edit(payload(session));
        return interaction.editReply({ content: '遊戲面板已重新整理。', allowedMentions: { parse: [] } });
      }
    }
    const channel = await client.channels.fetch(session.channelId);
    if (!channel || channel.guildId !== session.guildId) throw new GameError('SESSION_SCOPE_MISMATCH', 'Game channel changed.');
    const replacement = await channel.send(payload(session));
    const rebound = session.messageId
      ? await service.rebindMessage({ sessionId: session.id, actorId: interaction.user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, oldMessageId: session.messageId, newMessageId: replacement.id, expectedRevision: session.revision })
      : await service.bindMessage({ sessionId: session.id, actorId: interaction.user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, messageId: replacement.id });
    await replacement.edit(payload(rebound));
    return interaction.editReply({ content: '遊戲面板已重新建立。', allowedMentions: { parse: [] } });
  }

  async function executeCommand(interaction) {
    try {
      assertAdmitted(interaction);
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'menu') return await interaction.reply(menuPayload());
      if (subcommand === 'resume') return await resume(interaction);
      if (subcommand === 'play') return await start(interaction, interaction.options.getString('game', true), interaction.options.getString('difficulty', true));
      throw new GameError('INVALID_REQUEST', 'Unknown game command.');
    } catch (error) {
      runtimeLogger?.error?.('solo game command failed', error);
      const response = { content: friendlyError(error), allowedMentions: { parse: [] } };
      if (interaction.deferred) return interaction.editReply(response);
      if (interaction.replied) return interaction.followUp({ ...response, ephemeral: true });
      return interaction.reply({ ...response, ephemeral: true });
    }
  }

  async function handleInteraction(interaction) {
    const customId = String(interaction?.customId || '');
    if (!customId.startsWith('solo|1|')) return false;
    try {
      assertAdmitted(interaction);
      if (customId === 'solo|1|menu' && interaction.isStringSelectMenu()) {
        const selected = String(interaction.values?.[0] || '');
        if (selected.startsWith('solo:')) return await interaction.reply(difficultyPayload(selected.slice(5)));
        const game = selected.startsWith('board:') ? selected.slice(6) : '';
        if (!GAME_CHOICES.some((choice) => choice.value === game)) throw new GameError('INVALID_REQUEST', 'Unknown game.');
        await boardRuntime().startGame(interaction, game);
        return true;
      }
      if (customId.startsWith('solo|1|difficulty|') && interaction.isStringSelectMenu()) {
        const gameType = customId.slice('solo|1|difficulty|'.length);
        if (!SOLO_CHOICES.some((choice) => choice.value === `solo:${gameType}`)) throw new GameError('INVALID_REQUEST', 'Unknown game.');
        if (!DIFFICULTY_CHOICES.some((choice) => choice.value === interaction.values?.[0])) throw new GameError('INVALID_REQUEST', 'Unknown difficulty.');
        await start(interaction, gameType, interaction.values[0]);
        return true;
      }
      const decoded = parseSoloCustomId(customId);
      if (interaction.isButton() && decoded.verb.startsWith('move.')) {
        await interaction.showModal(modalForMove(customId, decoded.verb));
        return true;
      }
      await interaction.deferReply({ ephemeral: true });
      const scope = { sessionId: decoded.sessionId, actorId: interaction.user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, messageId: interaction.message?.id };
      if (!scope.messageId) throw new GameError('MESSAGE_MISMATCH', 'Game message is missing.');
      let result;
      if (interaction.isModalSubmit() && decoded.verb.startsWith('move.')) {
        const current = await service.get(scope);
        const expectedGame = { 'move.t': 'tetris', 'move.n': 'number-match', 'move.s': 'sudoku' }[decoded.verb];
        if (current.gameType !== expectedGame) throw new GameError('INVALID_CUSTOM_ID', 'Game type mismatch.');
        result = await service.apply({ ...scope, expectedRevision: decoded.revision,
          interactionId: interaction.id, action: parseMove(interaction, current) });
      } else if (interaction.isButton() && decoded.verb === 'refresh') result = await service.get(scope);
      else throw new GameError('INVALID_CUSTOM_ID', 'Unsupported game control.');
      let message = '遊戲面板已更新。';
      try { await editPanel(result); }
      catch (error) {
        runtimeLogger?.error?.('solo game panel edit failed', error);
        message = '這一步已儲存，但面板更新失敗；請按重新整理或使用 /games resume。';
      }
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      return true;
    } catch (error) {
      runtimeLogger?.error?.('solo game interaction failed', error);
      const response = { content: friendlyError(error), allowedMentions: { parse: [] } };
      if (interaction.deferred) await interaction.editReply(response);
      else if (interaction.replied) await interaction.followUp({ ...response, ephemeral: true });
      else await interaction.reply({ ...response, ephemeral: true });
      return true;
    }
  }

  return Object.freeze({ executeCommand, handleInteraction, start, resume });
}

function createDefaultSoloDiscordRuntime({ client, runtimeLogger, rewardCoordinator = null } = {}) {
  const { withCoinTransaction, withCoinDatabase } = require('../../services/coinDatabase');
  const { createRuntimeRewardCoordinator } = require('../../coordinators/rewardRuntime');
  const coordinator = rewardCoordinator || createRuntimeRewardCoordinator();
  const service = createSoloSessionService({ withTransaction: withCoinTransaction, withDatabase: withCoinDatabase,
    grantRewardOnceV2WithApi: (api, input) => coordinator.grantInTransaction(api, input) });
  return createSoloDiscordRuntime({ service, client, runtimeLogger });
}

module.exports = { createDefaultSoloDiscordRuntime, createSoloDiscordRuntime, menuPayload, difficultyPayload, parseMove };
