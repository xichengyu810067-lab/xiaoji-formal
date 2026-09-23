const { SlashCommandBuilder } = require('discord.js');
const {
  enqueueTrack,
  applyVoiceStayPolicy,
  formatMusicPlaybackReply,
  getMusicUserFacingError,
  getQueue,
  getVoiceStayStatus,
  isYouTubeLocalError,
  joinMusicVoiceChannel,
  leaveVoiceChannel,
  pauseMusic,
  playTestTone,
  resumeMusic,
  skipTrack,
  stopMusic,
  validateVoiceChannelForPlayback,
} = require('../services/musicService');
const { getLavalinkStatus } = require('../services/lavalinkService');
const { setMusicStayInVoice } = require('../utils/guildConfig');
const { getDiscordGuildId, getEnv } = require('../utils/env');
const { OWNER_DENIED_MESSAGE } = require('../utils/ownerOnly');
const logger = require('../utils/logger');

const PRIVATE_EXPERIMENT_DENIED_MESSAGE = '音樂功能目前僅供主測試伺服器的 owner 私人實驗使用。';

function isPrivateMusicOwner(userId) {
  const ownerId = getEnv('BOT_OWNER_ID');
  return Boolean(ownerId && userId && String(userId).trim() === ownerId);
}

async function ensurePrivateMusicOwner(interaction) {
  if (isPrivateMusicOwner(interaction.user?.id)) {
    return true;
  }

  logger.warn(
    `[PERMISSION_BLOCK] User ${interaction.user?.tag || 'unknown'} (${interaction.user?.id || 'unknown'}) denied access to private /music`
  );
  const payload = { content: OWNER_DENIED_MESSAGE, ephemeral: true };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }

  return false;
}

function formatQueue(queueState) {
  const lines = [];

  if (queueState.current) {
    lines.push(`正在播放：**${queueState.current.title}**`);
  } else {
    lines.push('目前沒有正在播放的音樂。');
  }

  if (queueState.queue.length > 0) {
    lines.push('', ...queueState.queue.slice(0, 10).map((track, index) => `${index + 1}. ${track.title}`));
  }

  return lines.join('\n');
}

function shortValue(value, maxLength = 180) {
  const text = String(value ?? 'none');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatLavalinkStatus(status, voiceStay = null) {
  const source = status.configurationMode === 'self-hosted' ? '自架節點' : status.usingDefaultNodes ? '顯式啟用的公開 fallback' : '未啟用';
  const lines = [
    '**Lavalink 音樂節點狀態**',
    `initialized: ${status.initialized} (${status.initialized ? '已初始化' : '尚未初始化'})`,
    `usingDefaultNodes: ${status.usingDefaultNodes} (${source})`,
    `configurationMode: ${status.configurationMode}`,
    `publicFallbackEnabled: ${status.publicFallbackEnabled}`,
    `configuredNodeCount: ${status.configuredNodeCount}`,
    `runtimeNodeCount: ${status.runtimeNodeCount ?? 0}`,
    `runtimeNodeKeys: ${status.runtimeNodeKeys?.length ? status.runtimeNodeKeys.join(', ') : 'none'}`,
    `connectedNodeCount: ${status.connectedNodeCount}`,
  ];

  if (voiceStay) {
    lines.push(
      '',
      '**語音長駐策略**',
      `enabled: ${voiceStay.enabled}`,
      `source: ${voiceStay.source}`,
      `backend: ${voiceStay.backend}`,
      `channelId: ${voiceStay.channelId || 'none'}`,
      `idleTimerScheduled: ${voiceStay.idleTimerScheduled}`,
      `playing: ${voiceStay.playing}`
    );
  }

  if (status.configurationErrors?.length) {
    lines.push('', '**設定診斷**', ...status.configurationErrors.map((message) => `- ${message}`));
  }

  if (status.nodes.length > 0) {
    lines.push(
      '',
      ...status.nodes.map(
        (node) =>
          `• name=${node.name} runtimeKey=${node.runtimeKey || 'not_found'} url=${node.secure ? 'wss' : 'ws'}://${node.url} secure=${node.secure} source=${node.source} status=${node.status} lastLifecycle=${node.lifecycle?.event || 'none'} at=${node.lifecycle?.at || 'none'}`
      )
    );
  }

  if (status.runtimeOnlyNodes?.length > 0) {
    lines.push(
      '',
      'Runtime-only nodes:',
      ...status.runtimeOnlyNodes.map((node) => `• key=${node.key} name=${node.name} status=${node.status}`)
    );
  }

  if (status.playback) {
    const playback = status.playback;
    lines.push(
      '',
      '**目前伺服器播放狀態**',
      `node status: ${playback.nodeStatus}`,
      `player exists: ${playback.playerExists}`,
      `player connected: ${playback.playerConnected}`,
      `player state: ${playback.playerState}`,
      `connection state: ${playback.connectionState}`,
      `voiceId: ${playback.voiceId || 'none'}`,
      `textId: ${playback.textId || 'none'}`,
      `playing: ${playback.playing}`,
      `paused: ${playback.paused}`,
      `current track title: ${playback.currentTrackTitle || 'none'}`,
      `current track identifier: ${playback.currentTrackIdentifier || 'none'}`,
      `current track uri: ${shortValue(playback.currentTrackUri)}`,
      `current track encoded present: ${playback.currentTrackEncodedPresent}`,
      `current track sourceName: ${playback.currentTrackSourceName || 'none'}`,
      `current track isSeekable: ${playback.currentTrackIsSeekable ?? 'unknown'}`,
      `current track length: ${playback.currentTrackLength ?? 'unknown'}`,
      `queue length: ${playback.queueLength}`,
      `volume: ${playback.volume ?? 'unknown'}`,
      `position: ${playback.position ?? 'unknown'}`,
      `position increasing: ${playback.positionIncreased}`,
      `recent TrackStartEvent: ${playback.recentTrackStartEvent} (${playback.lastTrackStartEventAt || 'none'})`,
      `recent playerStart: ${playback.recentPlayerStart} (${playback.lastPlayerStartAt || 'none'})`,
      `recent playerUpdate: ${playback.recentPlayerUpdate} (${playback.lastPlayerUpdateAt || 'none'})`,
      `last voiceStateUpdate: ${playback.lastVoiceStateUpdateAt || 'none'}`,
      `last voiceServerUpdate: ${playback.lastVoiceServerUpdateAt || 'none'}`,
      `last event: ${playback.lastEvent || 'none'}`
    );

    if (playback.lastPlayerError) {
      lines.push(`last player error: ${playback.lastPlayerError}`);
    }

    if (playback.lastTrackException) {
      lines.push(`last TrackExceptionEvent: ${shortValue(JSON.stringify(playback.lastTrackException), 450)}`);
    }

    if (playback.lastTrackStuck) {
      lines.push(`last TrackStuckEvent: ${shortValue(JSON.stringify(playback.lastTrackStuck), 350)}`);
    }
  }

  if (status.connectedNodeCount === 0) {
    lines.push(
      '',
      '目前沒有可用 Lavalink 節點。請 owner 檢查：',
      '- LAVALINK_HOST 是否正確',
      '- LAVALINK_PORT 是否正確',
      '- LAVALINK_SECURE 是否符合節點協定',
      '- LAVALINK_PASSWORD 是否正確',
      '- public fallback 是否以 LAVALINK_ALLOW_PUBLIC_FALLBACK=true 明確啟用',
      '- hosting 是否阻擋 websocket outbound'
    );
  }

  return lines.join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Owner 私人實驗：音樂播放（未支援）')
    .addSubcommand((subcommand) => subcommand.setName('join').setDescription('只測試小吉能否加入你的語音頻道'))
    .addSubcommand((subcommand) => subcommand.setName('test').setDescription('播放固定測試音，檢查 voice/player/ffmpeg'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('play')
        .setDescription('播放 YouTube 影片或搜尋歌曲')
        .addStringOption((option) =>
          option.setName('url').setDescription('YouTube 影片連結或搜尋關鍵字').setRequired(true).setMaxLength(300)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('queue').setDescription('查看播放佇列'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看 Lavalink 音樂節點狀態'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('stay')
        .setDescription('管理員設定小吉是否在閒置時留在語音頻道')
        .addBooleanOption((option) => option.setName('enabled').setDescription('是否長駐').setRequired(true))
    )
    .addSubcommand((subcommand) => subcommand.setName('skip').setDescription('跳過目前歌曲'))
    .addSubcommand((subcommand) => subcommand.setName('pause').setDescription('暫停播放'))
    .addSubcommand((subcommand) => subcommand.setName('resume').setDescription('繼續播放'))
    .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('停止播放並清空佇列'))
    .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('讓小吉離開語音頻道')),

  async execute(interaction) {
    if (!(await ensurePrivateMusicOwner(interaction))) {
      return;
    }

    if (!interaction.inGuild() || interaction.guildId !== getDiscordGuildId()) {
      await interaction.reply({ content: PRIVATE_EXPERIMENT_DENIED_MESSAGE, ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'queue') {
      await interaction.reply({ content: formatQueue(getQueue(interaction.guildId)), ephemeral: true });
      return;
    }

    if (subcommand === 'status') {
      await interaction.reply({
        content: formatLavalinkStatus(getLavalinkStatus(interaction.guildId), getVoiceStayStatus(interaction.guildId)),
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'stay') {
      const enabled = interaction.options.getBoolean('enabled', true);
      setMusicStayInVoice(interaction.guildId, enabled);
      applyVoiceStayPolicy(interaction.guildId);
      await interaction.reply({
        content: enabled ? '已啟用語音長駐；閒置時不會自動離開。' : '已停用語音長駐；閒置 3 分鐘後會自動離開。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'skip') {
      const skippedTrack = skipTrack(interaction.guildId);
      await interaction.reply({
        content: skippedTrack ? `已跳過：${skippedTrack.title}` : '目前沒有正在播放的音樂。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'pause') {
      await interaction.reply({
        content: pauseMusic(interaction.guildId) ? '已暫停播放。' : '目前沒有可以暫停的音樂。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'resume') {
      await interaction.reply({
        content: resumeMusic(interaction.guildId) ? '已繼續播放。' : '目前沒有可以繼續的音樂。',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'stop') {
      stopMusic(interaction.guildId);
      await interaction.reply({ content: '已停止播放、清空佇列，並離開語音頻道。', ephemeral: true });
      return;
    }

    if (subcommand === 'leave') {
      const left = leaveVoiceChannel(interaction.guildId);
      await interaction.reply({
        content: left ? '小吉已離開語音頻道。' : '小吉目前不在語音頻道。',
        ephemeral: true,
      });
      return;
    }

    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await interaction.reply({ content: '音樂指令只能在伺服器文字頻道使用。', ephemeral: true });
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: `請先加入語音頻道，再使用 /music ${subcommand}。`, ephemeral: true });
      return;
    }

    if (subcommand === 'join') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await joinMusicVoiceChannel({
          guild: interaction.guild,
          voiceChannel,
          textChannel: interaction.channel,
        });

        await interaction.editReply(`小吉已加入語音頻道：${result.channelName}`);
      } catch (error) {
        logger.warn(`music join command failed in guild ${interaction.guildId}: ${error?.message || error}`);
        await interaction.editReply(getMusicUserFacingError(error));
      }

      return;
    }

    if (subcommand === 'test') {
      await interaction.deferReply();

      try {
        const result = await playTestTone({
          guild: interaction.guild,
          voiceChannel,
          textChannel: interaction.channel,
        });

        await interaction.editReply(`正在播放 ${result.durationSeconds} 秒測試音：${result.track.title}`);
      } catch (error) {
        logger.warn(`music test command failed in guild ${interaction.guildId}: ${error?.message || error}`);
        await interaction.editReply(`無法播放測試音：${getMusicUserFacingError(error)}`);
      }

      return;
    }

    try {
      validateVoiceChannelForPlayback(voiceChannel);
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const result = await enqueueTrack({
        guild: interaction.guild,
        voiceChannel,
        textChannel: interaction.channel,
        url: interaction.options.getString('url', true),
        requestedBy: interaction.user.id,
      });

      await interaction.editReply(formatMusicPlaybackReply(result));
    } catch (error) {
      if (!isYouTubeLocalError(error)) {
        logger.warn(`music play command failed in guild ${interaction.guildId}: ${error?.message || error}`);
      }
      await interaction.editReply(`無法播放：${getMusicUserFacingError(error)}`);
    }
  },
};

module.exports.formatQueue = formatQueue;
module.exports.formatLavalinkStatus = formatLavalinkStatus;
module.exports.isPrivateMusicOwner = isPrivateMusicOwner;
module.exports.PRIVATE_EXPERIMENT_DENIED_MESSAGE = PRIVATE_EXPERIMENT_DENIED_MESSAGE;
