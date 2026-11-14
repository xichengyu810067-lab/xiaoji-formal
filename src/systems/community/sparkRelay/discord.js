'use strict';

// 星火接續 on Discord: the /spark-relay command, the sign-up panel (its buttons and the topics form), a thread for each
// group, and what the clock (service.runSparkRelayClock) has to say in them. The rules and the store are not touched
// here, only through service.js.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const rules = require('./rules');
const service = require('./service');
const { downloadImage, isMediaHostUrl, MAX_IMAGE_BYTES } = require('../../conversation/imageInput');
const { isVisionAvailable } = require('../../../services/aiService');
const { replyEphemeral } = require('../../../utils/moderation');
const { resolveBotMember } = require('../../../utils/botMember');
const { getTaipeiDateKey } = require('../../../utils/taipeiClock');
const logger = require('../../../utils/logger');

const CUSTOM_ID_PREFIX = 'spark|1|';
// Like /memory: a deployment without Claude or the Turso database does not offer the feature.
const NOT_CONFIGURED = '星火接續目前沒有開啟（需要小吉的 AI 與雲端資料庫）。';
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });
const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const THREAD_ARCHIVE_MINUTES = 10080;
const REQUIRED_BOT_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
]);
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const RULES_TEXT = [
  `小吉會把報名的人隨機分組（每組 4～6 人），每組開一個討論串。`,
  `分組隔天起，每天輪一位成員：輪到的人用 \`/spark-relay tasks\` 領 ${rules.MIN_TASKS}～${rules.MAX_TASKS} 件小任務（用自己報名時填的主題出題），`,
  `再用 \`/spark-relay submit\` 交文字或圖片給小吉驗收（每件每天最多送驗 ${rules.CHECKS_PER_TASK_PER_DAY} 次）。`,
  `當天太忙的話，輪值日之後還有 ${rules.GRACE_DAYS} 天可以補做。`,
  `全組每個人都完成時，每人得到 ${rules.REWARD_PER_MEMBER} 吉幣；有人逾期，全組就沒有獎金。`,
].join('\n');

function customId(action, roundId) {
  return `${CUSTOM_ID_PREFIX}${action}|${roundId}`;
}

function parseCustomId(value) {
  const parts = String(value || '').split('|');
  if (parts.length !== 4 || `${parts[0]}|${parts[1]}|` !== CUSTOM_ID_PREFIX) return null;
  return { action: parts[2], roundId: parts[3] };
}

function unix(ms) {
  return Math.floor(ms / 1000);
}

function dayLabel(dayKey) {
  const [, month, day] = dayKey.split('-').map(Number);
  const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return `${month}/${day}（${WEEKDAYS[weekday]}）`;
}

function buildPanel(round) {
  const lines = [`**星火接續**（<@${round.hostId}> 開的）`];
  if (round.status === 'signup') {
    lines.push(RULES_TEXT, '',
      `報名截止：<t:${unix(round.signupEndsAt)}:f>（<t:${unix(round.signupEndsAt)}:R>）`,
      `目前報名：${round.entrants.length} 人（報名時填 ${rules.MIN_TOPICS}～${rules.MAX_TOPICS} 個你有興趣的主題）`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('join', round.id)).setLabel('報名／改主題').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('leave', round.id)).setLabel('退出').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(customId('start', round.id)).setLabel('開始分組').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(customId('cancel', round.id)).setLabel('取消這一輪').setStyle(ButtonStyle.Danger),
    );
    return { content: lines.join('\n'), components: [row], allowedMentions: NO_MENTIONS };
  }
  if (round.status === 'cancelled') {
    lines.push(round.entrants.length < 2 ? '報名人數不足 2 人，這一輪取消了。' : '這一輪已取消。');
  } else {
    lines.push(`報名截止，共 ${round.entrants.length} 人，分成 ${round.groups.length} 組：`);
    for (const group of round.groups) {
      lines.push(`第 ${group.index + 1} 組（${group.turns.length} 人）${group.threadId ? `：<#${group.threadId}>` : ''}`);
    }
    if (round.leftOut.length) lines.push(`這一輪沒有分到組：${round.leftOut.map((id) => `<@${id}>`).join('、')}（人數剛好多出一位，下一輪再來！）`);
  }
  return { content: lines.join('\n'), components: [], allowedMentions: NO_MENTIONS };
}

function buildRoster(group) {
  const lines = [`**星火接續 第 ${group.index + 1} 組** 開始！輪值順序：`];
  group.turns.forEach((turn, index) => {
    lines.push(`${index + 1}. ${dayLabel(turn.day)} <@${turn.userId}>（補做到 <t:${unix(rules.turnDeadlineMs(turn.day))}:f> 前）`);
  });
  lines.push('', '輪到你的那天用 `/spark-relay tasks` 領任務，用 `/spark-relay submit` 交給小吉驗收。',
    `全組都完成時每人 ${rules.REWARD_PER_MEMBER} 吉幣，大家一起把星火傳下去！`);
  return lines.join('\n');
}

function formatTasks(place, now) {
  const { turn } = place;
  const lines = [`**你的星火任務**（輪值日 ${dayLabel(turn.day)}，補做到 <t:${unix(rules.turnDeadlineMs(turn.day))}:f> 前）`];
  turn.tasks.forEach((task, index) => {
    const checksLeft = task.checks.day === getTaipeiDateKey(new Date(now))
      ? rules.CHECKS_PER_TASK_PER_DAY - task.checks.count : rules.CHECKS_PER_TASK_PER_DAY;
    lines.push(`${task.passedAt ? '✅' : '⬜'} ${index + 1}. ${task.text}${task.passedAt ? '' : `（今天還能送驗 ${checksLeft} 次）`}`);
  });
  lines.push('', place.turn.doneAt ? '你的任務都完成了，接力棒交出去了！' :
    '完成後用 `/spark-relay submit task:<編號> proof:<文字>`（也可以附 image 圖片）交給小吉驗收。');
  return lines.join('\n');
}

function formatStatus(place, now) {
  if (place.state === 'signup') return `你報名了 <#${place.round.channelId}> 的星火接續，報名截止 <t:${unix(place.round.signupEndsAt)}:R>。`;
  const lines = [`**星火接續 第 ${place.group.index + 1} 組**${place.group.threadId ? `（<#${place.group.threadId}>）` : ''}`];
  for (const turn of place.group.turns) {
    const state = rules.turnState(turn, now);
    const done = turn.tasks ? turn.tasks.filter((task) => task.passedAt).length : 0;
    const progress = turn.tasks ? `${done}/${turn.tasks.length}` : `0/${turn.taskCount}`;
    const label = { done: '✅ 完成', open: `⏳ 進行中 ${progress}`, upcoming: '🕒 還沒輪到', expired: '❌ 逾期' }[state];
    lines.push(`${dayLabel(turn.day)} <@${turn.userId}>：${label}`);
  }
  return lines.join('\n');
}

async function answer(interaction, content) {
  const payload = typeof content === 'string' ? { content, allowedMentions: NO_MENTIONS } : content;
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  await replyEphemeral(interaction, payload);
}

function errorText(error) {
  return error instanceof service.SparkRelayError ? error.message : null;
}

async function fetchChannel(client, channelId) {
  return client.channels.cache.get(channelId) || client.channels.fetch(channelId).catch(() => null);
}

async function sendTo(channel, content, mentionUserIds = []) {
  if (!channel?.send) return null;
  return channel.send({ content, allowedMentions: { parse: [], users: mentionUserIds, roles: [] } });
}

async function updatePanel(client, round) {
  if (!round.panelMessageId) return;
  try {
    const channel = await fetchChannel(client, round.channelId);
    const message = await channel?.messages?.fetch(round.panelMessageId);
    await message?.edit(buildPanel(round));
  } catch (error) {
    logger.warn(`[SPARK_RELAY] code=SPARK_RELAY_PANEL_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
  }
}

// A thread for each group that has none yet, with the roster; without a thread the roster goes to the channel.
async function openGroupThreads(client, round) {
  const channel = await fetchChannel(client, round.channelId);
  for (const group of round.groups) {
    if (group.threadId) continue;
    const members = group.turns.map((turn) => turn.userId);
    try {
      const thread = await channel.threads.create({
        name: `星火接續 第 ${group.index + 1} 組`,
        autoArchiveDuration: THREAD_ARCHIVE_MINUTES,
        reason: '小吉星火接續',
      });
      await service.setGroupThread(round.id, group.index, thread.id);
      group.threadId = thread.id;
      await sendTo(thread, buildRoster(group), members);
    } catch (error) {
      logger.warn(`[SPARK_RELAY] code=SPARK_RELAY_THREAD_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
      await sendTo(channel, buildRoster(group), members).catch(() => {});
    }
  }
  await updatePanel(client, round);
}

async function groupChannel(client, round, group) {
  return (group.threadId && await fetchChannel(client, group.threadId)) || fetchChannel(client, round.channelId);
}

// Shows what one run of the clock did.
async function applyClockReport(client, report) {
  for (const round of report.formed) await openGroupThreads(client, round).catch(() => {});
  for (const round of report.cancelled) await updatePanel(client, round);
  for (const { round, group, turn } of report.announcements) {
    const channel = await groupChannel(client, round, group);
    await sendTo(channel, `🔥 今天輪到 <@${turn.userId}> 接棒！用 \`/spark-relay tasks\` 領取 ${turn.taskCount} 件小任務，` +
      `補做期限是 <t:${unix(rules.turnDeadlineMs(turn.day))}:f>。`, [turn.userId]).catch(() => {});
  }
  for (const { round, group, turn } of report.failures) {
    const channel = await groupChannel(client, round, group);
    await sendTo(channel, `<@${turn.userId}> 的補做期限過了，這一組的星火接續到此結束，這次沒有獎金。謝謝大家的參與，下次再挑戰！`)
      .catch(() => {});
  }
  for (const { round, group, status } of report.rewards) {
    const channel = await groupChannel(client, round, group);
    await sendTo(channel, rewardText(status)).catch(() => {});
  }
}

function rewardText(status) {
  if (status === 'granted') return `🎉 全組完成星火接續！每人獲得 ${rules.REWARD_PER_MEMBER} 吉幣。`;
  if (status === 'coin_disabled') return '🎉 全組完成星火接續！不過這個伺服器沒有開啟吉幣，所以這次沒有發放獎金。';
  return '🎉 全組完成星火接續！獎金發放暫時失敗，小吉稍後會自動再試。';
}

async function startRound(interaction) {
  const channel = interaction.channel;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type)) {
    await replyEphemeral(interaction, '請在伺服器的文字頻道開星火接續（討論串裡不行）。');
    return;
  }
  const botMember = await resolveBotMember(interaction.guild);
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (!REQUIRED_BOT_PERMISSIONS.every((permission) => permissions?.has(permission))) {
    await replyEphemeral(interaction, '小吉在這個頻道需要「檢視頻道、傳送訊息、建立公開討論串、在討論串傳送訊息」權限才能開星火接續。');
    return;
  }
  const round = await service.openRound({
    guildId: interaction.guildId,
    channelId: channel.id,
    hostId: interaction.user.id,
    signupHours: interaction.options.getInteger('signup-hours') ?? rules.DEFAULT_SIGNUP_HOURS,
  });
  await interaction.reply(buildPanel(round));
  const reply = await interaction.fetchReply();
  await service.setPanelMessage(round.id, reply.id);
}

async function showTasks(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const place = await service.getTurnTasks({ guildId: interaction.guildId, userId: interaction.user.id });
  await answer(interaction, formatTasks(place, Date.now()));
}

// The image of a hand-in, read like a chat image (imageInput.js): Discord's media hosts, png/jpeg/gif/webp, 5 MB.
async function readProofImage(attachment) {
  if (!attachment) return { image: null };
  const type = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(type) || !(Number(attachment.size) > 0) || Number(attachment.size) > MAX_IMAGE_BYTES ||
      !isMediaHostUrl(attachment.url)) {
    return { error: '圖片只收 png、jpg、gif、webp，且不超過 5 MB。' };
  }
  if (!isVisionAvailable()) return { error: '小吉現在看不到圖片，請改用文字說明。' };
  const image = await downloadImage({ url: attachment.url });
  return image ? { image } : { error: '小吉打不開這張圖片，請換一張或改用文字。' };
}

async function submitProof(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const proof = await readProofImage(interaction.options.getAttachment('image'));
  if (proof.error) {
    await answer(interaction, proof.error);
    return;
  }
  const result = await service.submitTask({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    taskNumber: interaction.options.getInteger('task', true),
    text: interaction.options.getString('proof') || '',
    image: proof.image,
  });
  if (!result.passed) {
    await answer(interaction, `❌ 第 ${result.taskNumber} 件還沒通過：${result.feedback}\n今天這件還能送驗 ${result.remainingChecks} 次。`);
    return;
  }
  const done = result.turn.tasks.filter((task) => task.passedAt).length;
  await answer(interaction, `✅ 第 ${result.taskNumber} 件通過！${result.feedback}（${done}/${result.turn.tasks.length}）`);
  const channel = await groupChannel(interaction.client, result.round, result.group);
  const lines = [`✅ <@${interaction.user.id}> 完成了一件星火任務（${done}/${result.turn.tasks.length}）`];
  if (result.turnDone && !result.groupCompleted) lines.push('今天的接力棒交出去了，換下一位！');
  await sendTo(channel, lines.join('\n')).catch(() => {});
  if (result.groupCompleted) await sendTo(channel, rewardText(result.reward?.status)).catch(() => {});
}

async function showStatus(interaction) {
  const place = await service.findMemberPlace({ guildId: interaction.guildId, userId: interaction.user.id });
  await replyEphemeral(interaction, {
    content: place ? formatStatus(place, Date.now()) : '你目前沒有參加星火接續。可以用 `/spark-relay start` 開一輪，或在別人開的面板按「報名」。',
    allowedMentions: NO_MENTIONS,
  });
}

async function executeSparkRelayCommand(interaction) {
  try {
    if (!interaction.inGuild?.() || !interaction.guildId) {
      await replyEphemeral(interaction, '星火接續只能在伺服器裡玩。');
      return;
    }
    if (!service.isSparkRelayAvailable()) {
      await replyEphemeral(interaction, NOT_CONFIGURED);
      return;
    }
    const action = interaction.options.getSubcommand();
    if (action === 'start') await startRound(interaction);
    else if (action === 'tasks') await showTasks(interaction);
    else if (action === 'submit') await submitProof(interaction);
    else await showStatus(interaction);
  } catch (error) {
    const message = errorText(error);
    if (!message) logger.error('/spark-relay failed', error);
    await answer(interaction, message || '星火接續處理失敗，請稍後再試。').catch(() => {});
  }
}

function buildTopicsModal(roundId) {
  return new ModalBuilder()
    .setCustomId(customId('topics', roundId))
    .setTitle('報名星火接續')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('topics')
        .setLabel(`你有興趣的主題（${rules.MIN_TOPICS}～${rules.MAX_TOPICS} 個，用逗號分隔）`)
        .setPlaceholder('例如：烘焙、日本旅遊、貓咪、吉他')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(1)
        .setMaxLength(rules.MAX_TOPICS * (rules.MAX_TOPIC_LENGTH + 1))
        .setRequired(true)
    ));
}

async function handleSparkRelayInteraction(interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || !interaction.guildId) return;
  try {
    if (interaction.isButton() && parsed.action === 'join') {
      await interaction.showModal(buildTopicsModal(parsed.roundId));
      return;
    }
    if (interaction.isModalSubmit?.() && parsed.action === 'topics') {
      const joined = await service.joinRound({
        roundId: parsed.roundId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        topicsInput: interaction.fields.getTextInputValue('topics'),
      });
      await replyEphemeral(interaction, `${joined.result.updated ? '主題已更新' : '報名成功'}！你的主題：${joined.result.topics.join('、')}`);
      await updatePanel(interaction.client, joined.round);
      return;
    }
    if (!interaction.isButton()) return;
    if (parsed.action === 'leave') {
      const left = await service.leaveRound({ roundId: parsed.roundId, userId: interaction.user.id });
      await replyEphemeral(interaction, '已退出這一輪星火接續。');
      await updatePanel(interaction.client, left.round);
    } else if (parsed.action === 'start') {
      const closed = await service.closeSignup({ roundId: parsed.roundId, userId: interaction.user.id });
      await replyEphemeral(interaction, closed.result.formed ? '分組完成！' : closed.result.already ? '這一輪已經截止了。' : '報名人數不足 2 人，這一輪取消了。');
      if (closed.result.formed) await openGroupThreads(interaction.client, closed.round);
      else await updatePanel(interaction.client, closed.round);
    } else if (parsed.action === 'cancel') {
      const cancelled = await service.cancelRound({ roundId: parsed.roundId, userId: interaction.user.id });
      await replyEphemeral(interaction, '這一輪星火接續已取消。');
      await updatePanel(interaction.client, cancelled.round);
    }
  } catch (error) {
    const message = errorText(error);
    if (!message) logger.error('spark relay interaction failed', error);
    await replyEphemeral(interaction, message || '星火接續處理失敗，請稍後再試。').catch(() => {});
  }
}

async function processSparkRelayClock(client, options = {}) {
  const report = await service.runSparkRelayClock(options);
  if (client) await applyClockReport(client, report);
  return report;
}

module.exports = {
  CUSTOM_ID_PREFIX,
  RULES_TEXT,
  applyClockReport,
  buildPanel,
  buildRoster,
  executeSparkRelayCommand,
  formatStatus,
  formatTasks,
  handleSparkRelayInteraction,
  parseCustomId,
  processSparkRelayClock,
};
