const { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } = require('discord.js');
const {
  CATEGORY_LABELS,
  describeScope,
  forgetAllOwnPreferences,
  forgetOwnPreference,
  getConsent,
  isMemoryConfigured,
  listOwnPreferences,
  rememberPreferences,
  updateConsent,
} = require('../systems/conversation/preferenceMemory');

// Every reply is only for the member who ran it: their own memory, checked by their Discord ID.
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });
const DELETE_PREFIX = 'memdelete|1|';
const NOT_CONFIGURED = '小吉的記憶功能目前沒有開啟。';
const MAX_MESSAGE_LENGTH = 1900;

function privateReply(content, extra = {}) {
  return { content, ephemeral: true, allowedMentions: NO_MENTIONS, ...extra };
}

function chunks(lines) {
  const result = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
      result.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line.slice(0, MAX_MESSAGE_LENGTH);
  }
  if (current) result.push(current);
  return result;
}

function consentLine(consent) {
  const share = consent.choice === 'public'
    ? '公開（所有伺服器共用）'
    : consent.choice === 'private' ? '不公開（每個伺服器分開）' : '尚未選擇（目前視為不公開）';
  return `公開設定：${share}｜記憶：${consent.collecting ? '開啟中' : '已停止'}`;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function sendLines(interaction, lines) {
  const [first, ...rest] = chunks(lines);
  await interaction.reply(privateReply(first));
  for (const part of rest) await interaction.followUp(privateReply(part));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('查看或管理小吉記住的你的喜好')
    .addSubcommand((subcommand) => subcommand.setName('view').setDescription('查看小吉記住的你的喜好'))
    .addSubcommand((subcommand) => subcommand.setName('export').setDescription('取得你的記憶完整複本'))
    .addSubcommand((subcommand) =>
      subcommand.setName('add').setDescription('補充一條你的喜好')
        .addStringOption((option) => option.setName('text').setDescription('例如：喜歡豚骨拉麵').setRequired(true)
          .setMaxLength(100))
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('forget').setDescription('刪除或更正其中一條喜好')
        .addIntegerOption((option) => option.setName('item').setDescription('/memory view 裡的編號').setRequired(true)
          .setMinValue(1))
    )
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('停止小吉蒐集與使用你的喜好'))
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('恢復小吉蒐集與使用你的喜好'))
    .addSubcommand((subcommand) => subcommand.setName('delete').setDescription('刪除小吉記住的全部喜好'))
    .addSubcommand((subcommand) =>
      subcommand.setName('share').setDescription('設定是否公開聊天記憶')
        .addStringOption((option) => option.setName('choice').setDescription('公開或不公開').setRequired(true)
          .addChoices({ name: '公開（所有伺服器共用）', value: 'public' }, { name: '不公開（每個伺服器分開）', value: 'private' }))
    ),

  async execute(interaction) {
    if (!isMemoryConfigured()) {
      await interaction.reply(privateReply(NOT_CONFIGURED));
      return;
    }
    const userId = interaction.user.id;
    const guildId = interaction.guildId ?? null;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view' || subcommand === 'export') {
      const [consent, preferences] = await Promise.all([getConsent(userId), listOwnPreferences(userId)]);
      const lines = [consentLine(consent)];
      if (!preferences.length) lines.push('小吉目前沒有記住你的任何喜好。');
      preferences.forEach((entry, index) => {
        const where = describeScope(entry.scope, guildId);
        const label = CATEGORY_LABELS[entry.category] || CATEGORY_LABELS.other;
        lines.push(subcommand === 'export'
          ? `${index + 1}. [${label}] ${entry.value}（${where}；記下 ${formatDate(entry.createdAt)}，最近使用 ${formatDate(entry.lastUsedAt)}）`
          : `${index + 1}. [${label}] ${entry.value}（${where}）`);
      });
      if (subcommand === 'view' && preferences.length) lines.push('-# 用 /memory forget item:編號 刪除；想更正就刪掉後用 /memory add 補上。');
      if (subcommand === 'export') lines.push('-# 這是小吉保存的你的全部喜好記憶。超過一年沒有用到的喜好會自動刪除。');
      await sendLines(interaction, lines);
      return;
    }

    if (subcommand === 'add') {
      const consent = await getConsent(userId);
      if (!consent.collecting) {
        await interaction.reply(privateReply('你已經停止記憶，請先用 /memory on 恢復。'));
        return;
      }
      const kept = await rememberPreferences({ userId, guildId, entries: [{ category: 'other', preference: interaction.options.getString('text', true) }] });
      await interaction.reply(privateReply(kept
        ? '記住了！'
        : '這條內容小吉不能記（可能含有個人資料、敏感話題、連結或太長），請換個說法。'));
      return;
    }

    if (subcommand === 'forget') {
      const preferences = await listOwnPreferences(userId);
      const entry = preferences[interaction.options.getInteger('item', true) - 1];
      const removed = entry ? await forgetOwnPreference(userId, entry.id) : false;
      await interaction.reply(privateReply(removed ? `已刪除：${entry.value}` : '找不到這個編號，請先用 /memory view 查看。'));
      return;
    }

    if (subcommand === 'off' || subcommand === 'on') {
      await updateConsent(userId, { collecting: subcommand === 'on' });
      await interaction.reply(privateReply(subcommand === 'on'
        ? '已恢復：小吉會繼續記住並使用你的喜好。'
        : '已停止：小吉不再蒐集、也不再使用你的喜好；已記住的內容仍保留，要刪除請用 /memory delete。'));
      return;
    }

    if (subcommand === 'delete') {
      await interaction.reply(privateReply('確定要刪除小吉記住的全部喜好嗎？刪除後無法復原。', {
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${DELETE_PREFIX}confirm|${userId}`).setLabel('確定刪除').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`${DELETE_PREFIX}cancel|${userId}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
        )],
      }));
      return;
    }

    if (subcommand === 'share') {
      const choice = interaction.options.getString('choice', true) === 'public' ? 'public' : 'private';
      await updateConsent(userId, { choice });
      await interaction.reply(privateReply(choice === 'public'
        ? '已設定：公開聊天記憶，小吉所在的所有伺服器共用同一份記憶。'
        : '已設定：不公開聊天記憶，每個伺服器的記憶各自分開。'));
    }
  },

  async handleComponent(interaction) {
    const [, , action, userId] = String(interaction.customId).split('|');
    if (interaction.user?.id !== userId) {
      await interaction.reply(privateReply('這不是你的記憶設定。'));
      return;
    }
    if (action !== 'confirm') {
      await interaction.update({ content: '已取消，記憶沒有刪除。', components: [] });
      return;
    }
    const removed = isMemoryConfigured() ? await forgetAllOwnPreferences(userId) : 0;
    await interaction.update({
      content: `已刪除全部記憶（共 ${removed} 條）。你的公開設定與「已詢問過」的紀錄會保留，用來記住你的選擇。`,
      components: [],
    });
  },
};
