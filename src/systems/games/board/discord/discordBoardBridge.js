const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { BoardCoreError } = require('../core/contracts');

const BUTTON_STYLES = Object.freeze({
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
});

function buildDiscordComponents(rows = []) {
  return rows.map((row) => new ActionRowBuilder().addComponents(
    row.components.map((component) => new ButtonBuilder()
      .setCustomId(component.customId)
      .setLabel(component.label)
      .setStyle(BUTTON_STYLES[component.style] || ButtonStyle.Secondary)
      .setDisabled(component.disabled === true))
  ));
}

function buildDiscordPayload(payload) {
  return {
    ...payload,
    components: buildDiscordComponents(payload.components),
  };
}

function buildBoardModal(customId, definition) {
  if (!definition || !Array.isArray(definition.fields) || !definition.fields.length) {
    throw new BoardCoreError('ACTION_NOT_AVAILABLE', '這個操作目前沒有可用的輸入視窗。');
  }
  const modal = new ModalBuilder().setCustomId(customId).setTitle(definition.title);
  for (const field of definition.fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    if (Number.isInteger(field.maxLength)) input.setMaxLength(field.maxLength);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

async function fetchGuildTextChannel(client, guildId, channelId) {
  if (!client?.channels || typeof client.channels.fetch !== 'function') {
    throw new BoardCoreError('DISCORD_UNAVAILABLE', 'Discord client 尚未準備完成。');
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.guildId !== guildId || !channel.isTextBased?.() || !channel.messages) {
    throw new BoardCoreError('SESSION_SCOPE_MISMATCH', '棋局頻道不屬於目前伺服器。');
  }
  return channel;
}

function isUnknownMessage(error) {
  return Number(error?.code) === 10008 || Number(error?.rawError?.code) === 10008;
}

function createDiscordBoardTransport({ client }) {
  return Object.freeze({
    async update({ guildId, channelId, messageId, payload }) {
      const channel = await fetchGuildTextChannel(client, guildId, channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit(buildDiscordPayload(payload));
    },

    async messageExists({ guildId, channelId, messageId }) {
      const channel = await fetchGuildTextChannel(client, guildId, channelId);
      try {
        await channel.messages.fetch(messageId);
        return true;
      } catch (error) {
        if (isUnknownMessage(error)) return false;
        throw error;
      }
    },

    // The public discussion thread under a board message: the existing one, or a new one when there is none yet.
    async ensureThread({ guildId, channelId, messageId, name }) {
      const channel = await fetchGuildTextChannel(client, guildId, channelId);
      const message = await channel.messages.fetch(messageId);
      if (message.thread?.id) return { id: message.thread.id };
      if (typeof message.startThread !== 'function') {
        throw new BoardCoreError('DISCORD_UNAVAILABLE', '目前頻道無法建立討論串。');
      }
      const thread = await message.startThread({ name: String(name || '討論區').slice(0, 100), autoArchiveDuration: 1440 });
      return { id: thread.id };
    },

    // Posts one message in the board channel or in a thread under it. Only the listed users are pinged.
    async post({ guildId, channelId, threadId = null, content, mentionUserIds = [] }) {
      let target;
      if (threadId) {
        target = await client.channels.fetch(threadId);
        if (!target || target.guildId !== guildId || target.parentId !== channelId || typeof target.send !== 'function') {
          throw new BoardCoreError('SESSION_SCOPE_MISMATCH', '討論串不屬於這個棋局頻道。');
        }
      } else {
        target = await fetchGuildTextChannel(client, guildId, channelId);
      }
      const message = await target.send({
        content: String(content || '').slice(0, 2000),
        allowedMentions: { parse: [], users: [...new Set(mentionUserIds)].slice(0, 100) },
      });
      return { id: message.id };
    },

    async createReplacement({ guildId, channelId }) {
      const channel = await fetchGuildTextChannel(client, guildId, channelId);
      if (typeof channel.send !== 'function') {
        throw new BoardCoreError('DISCORD_UNAVAILABLE', '目前頻道無法建立替代棋盤訊息。');
      }
      const message = await channel.send({
        content: '正在恢復棋盤…',
        allowedMentions: { parse: [] },
      });
      return { id: message.id, guildId: channel.guildId, channelId: channel.id };
    },
  });
}

module.exports = {
  buildBoardModal,
  buildDiscordComponents,
  buildDiscordPayload,
  createDiscordBoardTransport,
  fetchGuildTextChannel,
  isUnknownMessage,
};
