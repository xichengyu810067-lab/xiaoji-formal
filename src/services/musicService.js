const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const { KazagumoTrack } = require('kazagumo');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const fs = require('node:fs');
const ffmpegPath = require('ffmpeg-static');
const {
  cancelLavalinkPlaybackConfirmation,
  getKazagumo,
  waitForLavalinkPlaybackConfirmation,
} = require('./lavalinkService');
const { getGuildConfig } = require('../utils/guildConfig');
const logger = require('../utils/logger');
const {
  YouTubeLocalSourceError,
  createTrustedYouTubeDurationEvidence,
  extractStrictYouTubeVideoId,
  getSafeYouTubeLocalErrorCode,
  getYouTubeLocalDiagnostics,
  isYouTubeLocalError,
  loadAnonymousYouTubeAudio,
} = require('./youtubeLocalSource');
const { getYtdlpDiagnostics, loadYtdlpYouTubeAudio } = require('./youtubeYtdlpSource');

const musicIdleLeaveMs = 3 * 60 * 1000;
const testToneDurationSeconds = 5;
const testToneFrequencyHz = 880;
const youtubeFallbackStartupTimeoutMs = 15_000;
const youtubeFallbackMinimumPlaybackMs = 1_000;
const youtubeFallbackMinimumOutputBytes = 4_096;
const soundCloudDurationToleranceMs = 2_000;
const soundCloudSearchResultsPerQuery = 10;

// Local fallback state (used only for /music test now)
const guildLocalMusicStates = new Map();
const lavalinkIdleTimers = new Map();
const guildPlaybackOperationTails = new Map();
const trustedYouTubeDurationEvidenceByError = new WeakMap();
const trustedSoundCloudFallbackSeedByError = new WeakMap();
const trustedSoundCloudFallbackSeeds = new WeakSet();

class MusicUserError extends Error {
  constructor(message, code = 'music_user_error') {
    super(message);
    this.name = 'MusicUserError';
    this.code = code;
  }
}

function buildTrustedLavalinkDurationEvidence(input, track, playbackIdentity, playbackOutcome) {
  const videoId = extractStrictYouTubeVideoId(input);
  if (
    !videoId ||
    playbackOutcome?.failed !== true ||
    playbackOutcome.requestId !== playbackIdentity?.requestId ||
    playbackOutcome.encodedTrack !== playbackIdentity?.encodedTrack
  ) {
    return null;
  }

  return createTrustedYouTubeDurationEvidence({
    videoId,
    sourceName: track?.sourceName,
    identifier: track?.identifier,
    uri: track?.uri,
    isStream: track?.isStream,
    requestId: playbackIdentity.requestId,
    encodedTrack: playbackIdentity.encodedTrack,
    durationMs: track?.length,
  });
}

function normalizeTrackText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const soundCloudVersionRules = Object.freeze([
  ['live', /\blive\b/u],
  ['remix', /\bremix(?:ed)?\b/u],
  ['cover', /\bcover\b/u],
  ['acoustic', /\bacoustic\b/u],
  ['instrumental', /\binstrumental\b/u],
  ['karaoke', /\bkaraoke\b/u],
  ['nightcore', /\bnightcore\b/u],
  ['sped-up', /\bsped\s+up\b/u],
  ['slowed', /\bslowed(?:\s+down)?\b/u],
  ['reverb', /\breverb(?:ed)?\b/u],
  ['demo', /\bdemo\b/u],
  ['radio-edit', /\bradio\s+edit\b/u],
  ['extended', /\bextended(?:\s+(?:mix|version))?\b/u],
]);

const soundCloudReleaseTagAllowlist = new Set([
  'copyright free',
  'ncs release',
]);

function stripAllowlistedBracketedReleaseTags(value) {
  if (typeof value !== 'string') return value;
  return value.normalize('NFKC').replace(/\[([^\[\]]*)\]/gu, (match, content) => (
    soundCloudReleaseTagAllowlist.has(normalizeTrackText(content)) ? ' ' : match
  ));
}

function getTrackVersionSemantics(value) {
  const normalized = normalizeTrackText(value);
  return soundCloudVersionRules
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([name]) => name);
}

function normalizeTrackTitle(value) {
  let normalized = normalizeTrackText(stripAllowlistedBracketedReleaseTags(value));
  normalized = normalized
    .replace(/\bofficial\s+(?:music\s+)?(?:video|audio)\b/gu, ' ')
    .replace(/\blyric(?:s)?(?:\s+video)?\b/gu, ' ')
    .replace(/\bvisuali[sz]er\b/gu, ' ')
    .replace(/\bmusic\s+video\b/gu, ' ');
  for (const [, pattern] of soundCloudVersionRules) normalized = normalized.replace(pattern, ' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

function normalizeTrackAuthor(value) {
  return normalizeTrackText(value)
    .replace(/\b(?:topic|official|vevo)\b/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const trackPresentationSuffixRules = Object.freeze([
  /\s*歌詞字幕版\s*$/iu,
  /\s*lyrics?\s+video\s*$/iu,
  /\s*[\[（(【]\s*(?:歌詞字幕版|lyrics?\s+video)\s*[\]）)】]\s*$/iu,
]);

function stripTrackPresentationSuffix(value) {
  let title = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (const pattern of trackPresentationSuffixRules) title = title.replace(pattern, '').trim();
  return title;
}

function buildCanonicalTrackIdentity(artist, track, direction) {
  const normalizedArtist = normalizeTrackAuthor(artist);
  const normalizedTrack = normalizeTrackTitle(track);
  if (
    !artist ||
    artist.length > 200 ||
    !track ||
    track.length > 300 ||
    !normalizedArtist ||
    !normalizedTrack
  ) {
    return null;
  }
  return Object.freeze({ artist, track, normalizedArtist, normalizedTrack, direction });
}

function extractCanonicalTrackIdentityCandidates(value) {
  if (typeof value !== 'string') return null;
  const title = stripTrackPresentationSuffix(stripAllowlistedBracketedReleaseTags(value));
  if (!title || title.length > 300) return null;
  const separators = [...title.matchAll(/[-–—]/gu)];
  if (separators.length !== 1) return null;

  const separator = separators[0];
  const left = title.slice(0, separator.index).trim();
  const right = title.slice(separator.index + separator[0].length).trim();
  const artistTrack = buildCanonicalTrackIdentity(left, right, 'artist-track');
  const trackArtist = buildCanonicalTrackIdentity(right, left, 'track-artist');
  if (!artistTrack || !trackArtist) return null;
  return Object.freeze([artistTrack, trackArtist]);
}

function extractCanonicalTrackIdentity(value) {
  const identity = extractCanonicalTrackIdentityCandidates(value)?.[0];
  if (!identity) return null;
  return Object.freeze({
    artist: identity.artist,
    track: identity.track,
    normalizedArtist: identity.normalizedArtist,
    normalizedTrack: identity.normalizedTrack,
  });
}

function buildTrustedSoundCloudFallbackSeed(input, track, playbackIdentity, playbackOutcome) {
  const durationEvidence = buildTrustedLavalinkDurationEvidence(input, track, playbackIdentity, playbackOutcome);
  const title = typeof track?.title === 'string' ? track.title.replace(/\s+/g, ' ').trim() : '';
  const author = typeof track?.author === 'string' ? track.author.replace(/\s+/g, ' ').trim() : '';
  const requesterId = typeof track?.requester?.requesterId === 'string'
    ? track.requester.requesterId.trim()
    : '';
  const requesterPlaybackRequestId = typeof track?.requester?.playbackRequestId === 'string'
    ? track.requester.playbackRequestId.trim()
    : '';
  const identityCandidates = extractCanonicalTrackIdentityCandidates(title);

  if (
    !durationEvidence ||
    !title ||
    title.length > 300 ||
    !author ||
    author.length > 200 ||
    !requesterId ||
    requesterPlaybackRequestId !== durationEvidence.requestId ||
    !identityCandidates ||
    !normalizeTrackAuthor(author)
  ) {
    return null;
  }
  const canonical = identityCandidates[0];

  const seed = Object.freeze({
    videoId: durationEvidence.videoId,
    sourceName: durationEvidence.sourceName,
    identifier: durationEvidence.identifier,
    uri: durationEvidence.uri,
    isStream: durationEvidence.isStream,
    durationMs: durationEvidence.durationMs,
    title,
    author,
    canonicalArtist: canonical.artist,
    canonicalTitle: canonical.track,
    normalizedCanonicalArtist: canonical.normalizedArtist,
    normalizedCanonicalTitle: canonical.normalizedTrack,
    identityCandidates,
    requesterId,
    requestId: durationEvidence.requestId,
    encodedTrack: durationEvidence.encodedTrack,
    durationEvidence,
  });
  trustedSoundCloudFallbackSeeds.add(seed);
  return seed;
}

function getTrustedSoundCloudFallbackSeed(error) {
  const seed = trustedSoundCloudFallbackSeedByError.get(error);
  if (!seed || !Object.isFrozen(seed) || !trustedSoundCloudFallbackSeeds.has(seed)) return null;
  return seed;
}

function createPlaybackConfirmationError(input, track, playbackIdentity, playbackOutcome) {
  const error = new MusicUserError(
    playbackOutcome.failed
      ? 'YouTube 來源在音訊穩定前中止播放。'
      : '無法確認 Lavalink 正在持續輸出音訊。',
    playbackOutcome.failed ? 'youtube_stream_failed' : 'youtube_stream_unconfirmed'
  );

  if (error.code === 'youtube_stream_failed') {
    const evidence = buildTrustedLavalinkDurationEvidence(input, track, playbackIdentity, playbackOutcome);
    if (evidence) trustedYouTubeDurationEvidenceByError.set(error, evidence);
    const seed = buildTrustedSoundCloudFallbackSeed(input, track, playbackIdentity, playbackOutcome);
    if (seed) trustedSoundCloudFallbackSeedByError.set(error, seed);
  }

  return error;
}

function buildLocalYouTubeFallbackOptions(error, options = {}) {
  return {
    guild: options.guild,
    voiceChannel: options.voiceChannel,
    textChannel: options.textChannel,
    url: options.url,
    requestedBy: options.requestedBy,
    durationEvidence: trustedYouTubeDurationEvidenceByError.get(error) || null,
  };
}

function isPrivateYouTubeCookieAccess({ guild, requestedBy } = {}, env = process.env) {
  const ownerId = typeof env?.BOT_OWNER_ID === 'string' ? env.BOT_OWNER_ID.trim() : '';
  const guildId = typeof env?.DISCORD_GUILD_ID === 'string' ? env.DISCORD_GUILD_ID.trim() : '';
  return Boolean(
    ownerId &&
    guildId &&
    String(requestedBy || '').trim() === ownerId &&
    String(guild?.id || '').trim() === guildId
  );
}

function isYtdlpCookieConfigurationError(error) {
  return String(error?.code || '').startsWith('youtube_local_cookie_');
}

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    let videoId = null;

    if (parsed.searchParams.has('list')) return false;

    if (host === 'youtu.be') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 1) videoId = parts[0];
    } else if (host === 'youtube.com' && parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (host === 'youtube.com' && parsed.pathname.startsWith('/shorts/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'shorts') videoId = parts[1];
    }

    return /^[-_A-Za-z0-9]{11}$/.test(videoId || '');
  } catch {
    return false;
  }
}

function buildLavalinkTrackUserData(requestedBy, playbackRequestId = randomUUID()) {
  const requesterId = String(requestedBy || '').trim();
  const normalizedPlaybackRequestId = String(playbackRequestId || '').trim();
  if (!requesterId) {
    throw new MusicUserError('無法辨識點歌者，已停止送出 Lavalink 播放請求。', 'lavalink_requester_invalid');
  }
  if (!normalizedPlaybackRequestId) {
    throw new MusicUserError('無法建立播放請求識別，已停止送出 Lavalink 播放請求。', 'lavalink_request_invalid');
  }

  return { requesterId, playbackRequestId: normalizedPlaybackRequestId };
}

function getLavalinkLoadErrorSummary(data) {
  const parts = [data?.message, data?.cause, data?.severity ? `severity=${data.severity}` : null]
    .filter(Boolean)
    .map((part) => String(part).replace(/\s+/g, ' ').trim());

  return parts.join(' | ').slice(0, 300) || 'Lavalink 未提供錯誤摘要';
}

function normalizeLavalinkLoadResult(result, requester) {
  const loadType = String(result?.loadType || '').toLowerCase();
  let playlistName;
  let rawTracks;
  let type;

  if (loadType === 'error') {
    throw new MusicUserError(
      `YouTube 來源載入失敗：${getLavalinkLoadErrorSummary(result.data)}`,
      'youtube_source_failed'
    );
  }

  if (loadType === 'empty') {
    return { playlistName: undefined, tracks: [], type: 'SEARCH' };
  }

  if (loadType === 'track') {
    rawTracks = result?.data ? [result.data] : [];
    type = 'TRACK';
  } else if (loadType === 'playlist') {
    playlistName = result?.data?.info?.name;
    rawTracks = Array.isArray(result?.data?.tracks) ? result.data.tracks : [];
    type = 'PLAYLIST';
  } else if (loadType === 'search') {
    rawTracks = Array.isArray(result?.data) ? result.data : [];
    type = 'SEARCH';
  } else {
    throw new MusicUserError(`Lavalink 回傳未知的載入類型：${loadType || 'missing'}`, 'lavalink_load_protocol_error');
  }

  return {
    playlistName,
    tracks: rawTracks.map((rawTrack) => new KazagumoTrack(rawTrack, requester)),
    type,
  };
}

async function resolveLavalinkSearch(kazagumo, input, requester) {
  let node;

  try {
    node = await kazagumo.getLeastUsedNode();
  } catch {
    throw new MusicUserError('目前沒有可用的 Lavalink 節點，請稍後再試。', 'lavalink_unavailable');
  }

  if (!node) {
    throw new MusicUserError('目前沒有可用的 Lavalink 節點，請稍後再試。', 'lavalink_unavailable');
  }

  const identifier = /^https?:\/\//i.test(input) ? input : `ytsearch:${input}`;
  let result;

  try {
    result = await node.rest.resolve(identifier);
  } catch (error) {
    throw new MusicUserError(`Lavalink 載入請求失敗：${getBriefMusicError(error)}`, 'lavalink_load_request_failed');
  }

  return normalizeLavalinkLoadResult(result, requester);
}

async function resolveSoundCloudSearch(kazagumo, seed, requester) {
  if (!trustedSoundCloudFallbackSeeds.has(seed)) {
    throw new MusicUserError('SoundCloud 同曲備援缺少可信來源資料。', 'soundcloud_fallback_seed_invalid');
  }

  let node;
  try {
    node = await kazagumo.getLeastUsedNode();
  } catch {
    throw new MusicUserError('SoundCloud 同曲備援目前沒有可用節點。', 'soundcloud_fallback_unavailable');
  }
  if (!node) {
    throw new MusicUserError('SoundCloud 同曲備援目前沒有可用節點。', 'soundcloud_fallback_unavailable');
  }

  const searches = [];
  for (const identity of seed.identityCandidates) {
    const queries = Object.freeze([
      `${identity.artist} - ${identity.track}`,
      `${identity.track} ${identity.artist}`,
    ].map((query) => query.replace(/[\r\n]+/g, ' ').slice(0, 500)));
    const tracks = [];
    const seenEncodedTracks = new Set();

    for (const query of queries) {
      let result;
      try {
        result = await node.rest.resolve(`scsearch:${query}`);
      } catch {
        throw new MusicUserError('SoundCloud 同曲備援搜尋失敗。', 'soundcloud_fallback_search_failed');
      }

      if (String(result?.loadType || '').toLowerCase() === 'error') {
        throw new MusicUserError('SoundCloud 同曲備援搜尋失敗。', 'soundcloud_fallback_search_failed');
      }
      const normalized = !result || String(result.loadType || '').toLowerCase() === 'empty'
        ? { playlistName: undefined, tracks: [], type: 'SEARCH' }
        : normalizeLavalinkLoadResult(result, requester);
      for (const track of normalized.tracks.slice(0, soundCloudSearchResultsPerQuery)) {
        const encodedTrack = typeof track?.track === 'string' ? track.track.trim() : '';
        if (encodedTrack && seenEncodedTracks.has(encodedTrack)) continue;
        if (encodedTrack) seenEncodedTracks.add(encodedTrack);
        tracks.push(track);
      }
    }

    searches.push(Object.freeze({ identity, tracks: Object.freeze(tracks) }));
  }

  return {
    playlistName: undefined,
    tracks: searches.flatMap((search) => search.tracks),
    searches: Object.freeze(searches),
    type: 'SEARCH',
  };
}

function isSameVersionSemantics(first, second) {
  return JSON.stringify(getTrackVersionSemantics(first)) === JSON.stringify(getTrackVersionSemantics(second));
}

function evaluateSoundCloudCandidate(seed, track, identity = seed?.identityCandidates?.[0]) {
  const hasTrustedSeed = trustedSoundCloudFallbackSeeds.has(seed) && seed.identityCandidates.includes(identity);
  const sourceName = String(track?.sourceName || track?.raw?.info?.sourceName || '').toLowerCase();
  const encodedTrack = typeof track?.track === 'string' ? track.track.trim() : '';
  const durationMs = track?.length ?? track?.raw?.info?.length;
  const isStream = track?.isStream ?? track?.raw?.info?.isStream;
  const title = track?.title ?? track?.raw?.info?.title;
  const author = track?.author ?? track?.raw?.info?.author;
  const candidateIdentity = extractCanonicalTrackIdentity(title);
  const candidateTitle = normalizeTrackTitle(title);
  const candidateAuthor = normalizeTrackAuthor(author);
  const titleMode = candidateIdentity
    ? 'canonical-title'
    : candidateTitle && candidateAuthor
      ? 'title-author'
      : 'none';
  const titleMatch = titleMode === 'canonical-title'
    ? candidateIdentity.normalizedTrack === identity?.normalizedTrack
    : titleMode === 'title-author' && candidateTitle === identity?.normalizedTrack;
  const authorMatch = titleMode === 'canonical-title'
    ? candidateIdentity.normalizedArtist === identity?.normalizedArtist
    : titleMode === 'title-author' && candidateAuthor === identity?.normalizedArtist;
  const versionMatch = titleMode === 'canonical-title'
    ? isSameVersionSemantics(candidateIdentity.track, identity?.track)
    : titleMode === 'title-author' && isSameVersionSemantics(title, identity?.track);
  const rawDurationDeltaMs = Number.isSafeInteger(durationMs) && Number.isSafeInteger(seed?.durationMs)
    ? Math.abs(durationMs - seed.durationMs)
    : null;
  const durationDeltaMs = Number.isSafeInteger(rawDurationDeltaMs) ? rawDurationDeltaMs : null;
  const evaluation = {
    sourceIsSoundCloud: sourceName === 'soundcloud',
    encodedPresent: Boolean(encodedTrack),
    isNonLive: isStream === false,
    durationDeltaMs,
    durationWithinTolerance: durationMs > 0 &&
      durationDeltaMs !== null &&
      durationDeltaMs <= soundCloudDurationToleranceMs,
    titleMode,
    titleMatch: Boolean(titleMatch),
    authorMatch: Boolean(authorMatch),
    versionMatch: Boolean(versionMatch),
  };
  return Object.freeze({
    ...evaluation,
    isMatch: hasTrustedSeed &&
      evaluation.sourceIsSoundCloud &&
      evaluation.encodedPresent &&
      evaluation.isNonLive &&
      evaluation.durationWithinTolerance &&
      evaluation.titleMode !== 'none' &&
      evaluation.titleMatch &&
      evaluation.authorMatch &&
      evaluation.versionMatch,
  });
}

function isSafeSoundCloudSameTrackCandidate(seed, track, evaluation = evaluateSoundCloudCandidate(seed, track)) {
  if (!trustedSoundCloudFallbackSeeds.has(seed) || !track) return false;
  return evaluation.isMatch;
}

function sanitizeMusicGuildId(guildId) {
  return String(guildId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown';
}

function logSoundCloudSelectionDiagnostics(guildId, tracks, evaluations, matchingCandidateCount) {
  const common = {
    guildId: sanitizeMusicGuildId(guildId),
    candidateCount: tracks.length,
  };
  if (matchingCandidateCount > 1) {
    logger.warn(`[Music] SoundCloud same-track ambiguous diagnostics: ${JSON.stringify({
      ...common,
      matchingCandidateCount,
    })}`);
    return;
  }
  const candidates = evaluations.slice(0, 5).map((evaluation, index) => ({
    rank: index + 1,
    sourceIsSoundCloud: evaluation.sourceIsSoundCloud,
    encodedPresent: evaluation.encodedPresent,
    isNonLive: evaluation.isNonLive,
    durationDeltaMs: evaluation.durationDeltaMs,
    durationWithinTolerance: evaluation.durationWithinTolerance,
    titleMode: evaluation.titleMode,
    titleMatch: evaluation.titleMatch,
    authorMatch: evaluation.authorMatch,
    versionMatch: evaluation.versionMatch,
  }));
  logger.warn(`[Music] SoundCloud same-track zero-match diagnostics: ${JSON.stringify({
    ...common,
    candidates,
  })}`);
}

function selectUniqueSoundCloudSameTrack(seed, tracks, { guildId } = {}) {
  if (!trustedSoundCloudFallbackSeeds.has(seed)) {
    return { track: null, code: 'soundcloud_fallback_seed_invalid' };
  }
  const searchGroups = Array.isArray(tracks)
    ? [{ identity: seed.identityCandidates[0], tracks }]
    : Array.isArray(tracks?.searches)
      ? tracks.searches
      : Array.isArray(tracks?.tracks)
        ? [{ identity: seed.identityCandidates[0], tracks: tracks.tracks }]
        : null;
  if (!searchGroups || searchGroups.some(({ identity, tracks: groupTracks }) => (
    !seed.identityCandidates.includes(identity) || !Array.isArray(groupTracks)
  ))) {
    return { track: null, code: 'soundcloud_fallback_seed_invalid' };
  }
  const candidates = searchGroups.flatMap(({ identity, tracks: groupTracks }) => (
    groupTracks.map((track) => ({ track, evaluation: evaluateSoundCloudCandidate(seed, track, identity) }))
  ));
  const evaluations = candidates.map(({ evaluation }) => evaluation);
  const matches = candidates
    .filter(({ track, evaluation }) => isSafeSoundCloudSameTrackCandidate(seed, track, evaluation));
  if (matches.length === 1) return { track: matches[0].track, code: null };
  if (matches.length > 1) {
    const minimumDurationDeltaMs = Math.min(...matches.map(({ evaluation }) => evaluation.durationDeltaMs));
    const closestMatches = matches.filter(({ evaluation }) => (
      evaluation.durationDeltaMs === minimumDurationDeltaMs
    ));
    if (closestMatches.length === 1) return { track: closestMatches[0].track, code: null };
  }
  if (guildId !== undefined) {
    logSoundCloudSelectionDiagnostics(guildId, candidates, evaluations, matches.length);
  }
  return {
    track: null,
    code: matches.length > 1 ? 'soundcloud_fallback_ambiguous' : 'soundcloud_fallback_no_match',
  };
}

function getBriefMusicError(error) {
  return String(error?.message || error || '未知錯誤').replace(/\s+/g, ' ').slice(0, 180);
}

function getRestErrorDiagnostics(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name || 'unknown',
    statusCode: error.status ?? error.statusCode ?? null,
    error: error.error || null,
    message: getBriefMusicError(error),
    path: error.path || null,
  };
}

function getTrackDiagnostics(track) {
  if (!track) {
    return {
      title: null,
      identifier: null,
      uri: null,
      encodedTrackPresent: false,
      sourceName: null,
      isSeekable: null,
      length: null,
    };
  }

  return {
    title: track.title || null,
    identifier: track.identifier || null,
    uri: track.uri || null,
    encodedTrackPresent: Boolean(track.track || track.raw?.encoded),
    sourceName: track.sourceName || track.raw?.info?.sourceName || null,
    isSeekable: track.isSeekable ?? track.raw?.info?.isSeekable ?? null,
    length: track.length ?? track.raw?.info?.length ?? null,
  };
}

function getLavalinkPlaybackSnapshot({ player, connection, track, queueLengthOverride = null }) {
  return {
    track: getTrackDiagnostics(track || player?.queue?.current),
    player: {
      state: player?.state ?? null,
      voiceId: player?.voiceId || null,
      textId: player?.textId || null,
      playing: Boolean(player?.playing),
      paused: Boolean(player?.paused),
      position: player?.position ?? player?.shoukaku?.position ?? null,
      queueLength: queueLengthOverride ?? player?.queue?.length ?? null,
      currentTrackTitle: player?.queue?.current?.title || null,
      volume: player?.volume ?? null,
    },
    connection: {
      state: connection?.state ?? null,
      channelId: connection?.channelId || null,
      sessionIdPresent: Boolean(connection?.sessionId),
      serverUpdatePresent: Boolean(connection?.serverUpdate),
      endpointPresent: Boolean(connection?.serverUpdate?.endpoint),
      tokenPresent: Boolean(connection?.serverUpdate?.token),
    },
    node: {
      name: player?.node?.name || player?.shoukaku?.node?.name || null,
      state: player?.node?.state ?? player?.shoukaku?.node?.state ?? null,
      sessionIdPresent: Boolean(player?.node?.sessionId || player?.shoukaku?.node?.sessionId),
    },
  };
}

function logPlaybackSnapshot(level, message, snapshot, extra = {}) {
  const line = `[Music] ${message}: ${JSON.stringify({ ...snapshot, ...extra })}`;

  if (level === 'error') {
    logger.error(line);
    return;
  }

  if (level === 'warn') {
    logger.warn(line);
    return;
  }

  logger.info(line);
}

function getMusicErrorLayer(error) {
  const code = String(error?.code ?? '');

  if (
    [
      'user_not_in_voice',
      'bot_member_missing',
      'bot_in_other_voice',
      'missing_view_channel',
      'missing_connect',
      'missing_speak',
      'voice_channel_full',
      'voice_connect_failed',
    ].includes(code)
  ) {
    return 'voice';
  }

  if (code.startsWith('ffmpeg_')) {
    return 'ffmpeg';
  }
  
  if (code.startsWith('lavalink_')) {
      return 'lavalink';
  }

  if (code.startsWith('player_')) {
    return 'player';
  }

  if (code.startsWith('queue_')) {
    return 'queue';
  }

  if (code.startsWith('youtube_')) {
    return 'source';
  }

  if (code.startsWith('soundcloud_')) {
    return 'source';
  }

  return 'unknown';
}

function getMusicUserFacingError(error) {
  const layer = getMusicErrorLayer(error);
  const message = getBriefMusicError(error);

  if (isYtdlpCookieConfigurationError(error)) {
    return '私人 YouTube Cookie 設定無法安全使用，請 owner 檢查 YOUTUBE_COOKIES_PATH 指向的 Netscape cookies.txt 檔案與檔案權限。';
  }

  if (layer === 'lavalink') {
      return `目前缺少可用的 Lavalink 音樂節點。\n請在 .env 檔案中設定 \`LAVALINK_HOST\`, \`LAVALINK_PORT\`, \`LAVALINK_PASSWORD\` 等環境變數，或確認節點是否上線。\n（注意：小吉本體及 Discord 語音權限皆正常，此為節點伺服器問題）`;
  }

  if (layer === 'voice') {
    return `語音房連線失敗：${message}`;
  }

  if (layer === 'ffmpeg') {
    return `ffmpeg 測試音失敗：${message}`;
  }

  if (layer === 'player') {
    return `Discord audio player 失敗：${message}`;
  }

  if (layer === 'source') {
    if (String(error?.code || '').startsWith('soundcloud_')) {
      return 'YouTube 與本機匿名播放皆失敗，SoundCloud 同曲備援也無法安全確認同一首歌曲。';
    }
    return 'YouTube 來源目前拒絕或無法載入這部影片，請稍後再試或改用其他公開影片。';
  }

  // Unknown errors can contain a complete upstream response or stack. Keep the
  // Discord reply safely below its 2,000-character limit and log details at the
  // command boundary instead.
  return '音樂服務暫時無法完成這次操作，請稍後再試。';
}

function logYouTubeLocalFailure(guildId, error, fallbackCode = 'youtube_local_playback_failed') {
  const safeGuildId = String(guildId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown';
  const code = getSafeYouTubeLocalErrorCode(error, fallbackCode);
  const diagnostics = getYouTubeLocalDiagnostics(error);
  const suffix = diagnostics.length > 0 ? ` diagnostics=${JSON.stringify(diagnostics)}` : '';
  logger.warn(`[Music] Local YouTube fallback failed closed: guildId=${safeGuildId} code=${code}${suffix}`);
  return code;
}

function getMissingVoicePermissions(voiceChannel) {
  const botMember = voiceChannel.guild.members.me;
  const permissions = botMember ? voiceChannel.permissionsFor(botMember) : null;
  const missing = [];

  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    missing.push('ViewChannel');
  }

  if (!permissions?.has(PermissionFlagsBits.Connect)) {
    missing.push('Connect');
  }

  if (!permissions?.has(PermissionFlagsBits.Speak)) {
    missing.push('Speak');
  }

  return missing;
}

function isVoiceChannelFullForBot(voiceChannel) {
  const userLimit = voiceChannel.userLimit || 0;

  if (!userLimit) {
    return false;
  }

  if (voiceChannel.members?.has?.(voiceChannel.guild.members.me?.id)) {
    return false;
  }

  return (voiceChannel.members?.size || 0) >= userLimit;
}

function validateVoiceChannelForPlayback(voiceChannel, { commandName = '/music play' } = {}) {
  if (!voiceChannel) {
    throw new MusicUserError(`請先加入語音頻道，再使用 ${commandName}。`, 'user_not_in_voice');
  }

  if (!voiceChannel.guild?.members?.me) {
    throw new MusicUserError('小吉目前無法確認自己的語音權限，請稍後再試。', 'bot_member_missing');
  }
  
  // Check local connection
  const activeConnection = getVoiceConnection(voiceChannel.guild.id);
  if (activeConnection && activeConnection.joinConfig.channelId !== voiceChannel.id) {
    throw new MusicUserError('小吉已經在其他語音頻道，請先使用 /music leave 讓我離開後再播放。', 'bot_in_other_voice');
  }
  
  // Check Lavalink connection if initialized
  try {
      const kazagumo = getKazagumo();
      const activePlayer = kazagumo.players.get(voiceChannel.guild.id);
      if (activePlayer && activePlayer.voiceId !== voiceChannel.id) {
          throw new MusicUserError('小吉已經在其他語音頻道，請先使用 /music leave 讓我離開後再播放。', 'bot_in_other_voice');
      }
  } catch (e) {
      // It's okay if kazagumo isn't fully ready here, we fallback to local checks
  }

  const missingPermissions = getMissingVoicePermissions(voiceChannel);

  if (missingPermissions.includes('ViewChannel')) {
    throw new MusicUserError('小吉看不到這個語音頻道，請確認我有 View Channel 權限。', 'missing_view_channel');
  }

  if (missingPermissions.includes('Connect')) {
    throw new MusicUserError('小吉缺少 Connect 權限，無法加入你的語音頻道。', 'missing_connect');
  }

  if (missingPermissions.includes('Speak')) {
    throw new MusicUserError('小吉缺少 Speak 權限，就算加入語音頻道也無法播放音樂。', 'missing_speak');
  }

  if (isVoiceChannelFullForBot(voiceChannel)) {
    throw new MusicUserError('這個語音頻道已滿，小吉無法加入。', 'voice_channel_full');
  }

  return true;
}

// Local Player State Management (Mainly for /music test)
function cancelIdleDisconnect(state) {
  if (state && state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function cancelLavalinkIdleDisconnect(guildId) {
  const timer = lavalinkIdleTimers.get(guildId);
  if (timer) clearTimeout(timer);
  lavalinkIdleTimers.delete(guildId);
}

function parseBooleanEnv(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function getVoiceStayPolicy(guildId, { config = null, env = process.env } = {}) {
  const guildConfig = config || (guildId ? getGuildConfig(guildId) : null);
  if (typeof guildConfig?.music?.stayInVoice === 'boolean') {
    return { enabled: guildConfig.music.stayInVoice, source: 'guild-config' };
  }
  return { enabled: parseBooleanEnv(env.MUSIC_STAY_IN_VOICE), source: 'env' };
}

function shouldScheduleIdleDisconnect(state, options = {}) {
  if (!state || state.idleTimer || !state.connection || state.current || state.playing || state.queue.length > 0) {
    return false;
  }
  return !getVoiceStayPolicy(state.guildId, options).enabled;
}

function cleanupCurrentProcess(state) {
  if (state?.currentRuntime) {
    state.currentRuntime.cleanup();
    state.currentRuntime = null;
  }

  if (state && state.currentProcess && !state.currentProcess.killed) {
    state.currentProcess.kill('SIGKILL');
  }

  if (state) state.currentProcess = null;
}

function disconnectMusicState(state) {
  if (!state) return;
  const connection = state.connection;

  cancelIdleDisconnect(state);
  state.queue = [];
  state.current = null;
  state.playing = false;
  state.connection = null;
  cleanupCurrentProcess(state);
  state.player.stop(true);

  try {
    connection?.destroy();
  } catch (error) {
    logger.warn(`Failed to destroy local voice connection in guild ${state.guildId}: ${error?.message || error}`);
  }
}

function destroyLocalVoiceConnection(guildId, reason = 'switching to Lavalink') {
  let destroyed = false;
  const state = guildLocalMusicStates.get(guildId);

  if (state && state.connection) {
    disconnectMusicState(state);
    destroyed = true;
  }

  const activeConnection = getVoiceConnection(guildId);
  if (activeConnection) {
    try {
      activeConnection.destroy();
      destroyed = true;
    } catch (error) {
      logger.warn(`Failed to destroy stray local voice connection in guild ${guildId}: ${error?.message || error}`);
    }
  }

  if (destroyed) {
    logger.info(`[Music] Destroyed local @discordjs/voice connection in guild ${guildId}: ${reason}`);
  }

  return destroyed;
}

function scheduleIdleDisconnect(state) {
  if (!shouldScheduleIdleDisconnect(state)) {
    cancelIdleDisconnect(state);
    return;
  }

  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;

    if (!shouldScheduleIdleDisconnect({ ...state, idleTimer: null })) {
      return;
    }

    const textChannel = state.textChannel;
    disconnectMusicState(state);

    if (textChannel?.send) {
      void textChannel
        .send({
          content: '語音頻道閒置 3 分鐘，小吉已自動離開。',
          allowedMentions: { parse: [] },
        })
        .catch((error) => logger.warn(`Failed to send music idle message: ${error?.message || error}`));
    }
  }, musicIdleLeaveMs);

  state.idleTimer.unref?.();
}

function scheduleLavalinkIdleDisconnect(player, client = null) {
  if (!player?.guildId || lavalinkIdleTimers.has(player.guildId)) return;
  if (getVoiceStayPolicy(player.guildId).enabled) {
    cancelLavalinkIdleDisconnect(player.guildId);
    return;
  }

  const timer = setTimeout(async () => {
    lavalinkIdleTimers.delete(player.guildId);
    let currentPlayer = null;
    try {
      currentPlayer = getKazagumo().players.get(player.guildId) || null;
    } catch {
      return;
    }

    if (
      !currentPlayer ||
      getVoiceStayPolicy(player.guildId).enabled ||
      currentPlayer.playing ||
      currentPlayer.paused ||
      currentPlayer.queue?.length > 0
    ) {
      return;
    }

    const textId = currentPlayer.textId;
    await currentPlayer.destroy().catch((error) =>
      logger.warn(`Failed to destroy idle Lavalink player in guild ${player.guildId}: ${error?.message || error}`)
    );
    const textChannel = client?.channels?.cache?.get?.(textId);
    if (textChannel?.send) {
      await textChannel.send({
        content: '語音頻道閒置 3 分鐘，小吉已自動離開。',
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }
  }, musicIdleLeaveMs);
  timer.unref?.();
  lavalinkIdleTimers.set(player.guildId, timer);
}

function applyVoiceStayPolicy(guildId) {
  const policy = getVoiceStayPolicy(guildId);
  const localState = guildLocalMusicStates.get(guildId);
  let lavalinkPlayer = null;
  try {
    lavalinkPlayer = getKazagumo().players.get(guildId) || null;
  } catch {
    // No Lavalink runtime.
  }

  if (policy.enabled) {
    cancelIdleDisconnect(localState);
    cancelLavalinkIdleDisconnect(guildId);
  } else {
    scheduleIdleDisconnect(localState);
    if (lavalinkPlayer && !lavalinkPlayer.playing && !lavalinkPlayer.paused && lavalinkPlayer.queue?.length === 0) {
      scheduleLavalinkIdleDisconnect(lavalinkPlayer);
    }
  }
  return getVoiceStayStatus(guildId);
}

function getLocalMusicState(guildId) {
  if (!guildLocalMusicStates.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    const state = {
      guildId,
      player,
      connection: null,
      queue: [],
      current: null,
      currentProcess: null,
      currentRuntime: null,
      idleTimer: null,
      textChannel: null,
      playing: false,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      cleanupCurrentProcess(state);
      state.current = null;
      state.playing = false;
      // Local fallback queue no longer auto-plays next as we primarily use Lavalink
      scheduleIdleDisconnect(state);
    });

    player.on('error', (error) => {
      const isConfirmedYouTubeFallback = state.current?.source === 'youtube-local' && state.playing;
      if (isConfirmedYouTubeFallback) {
        logYouTubeLocalFailure(guildId, error, 'youtube_local_player_failed');
      } else if (state.current?.source !== 'youtube-local') {
        logger.warn(`Local Music player error in guild ${guildId}: ${error?.message || error}`);
      }
      cleanupCurrentProcess(state);
      state.current = null;
      state.playing = false;
      scheduleIdleDisconnect(state);
    });

    guildLocalMusicStates.set(guildId, state);
  }

  return guildLocalMusicStates.get(guildId);
}

// Local voice connection (fallback for test tone or when Lavalink is fully disabled)
async function connectToLocalVoice(voiceChannel) {
  const existingConnection = getVoiceConnection(voiceChannel.guild.id);

  if (existingConnection) {
    if (existingConnection.joinConfig.channelId !== voiceChannel.id) {
      existingConnection.destroy();
    } else {
      try {
        await entersState(existingConnection, VoiceConnectionStatus.Ready, 20_000);
      } catch (error) {
        throw new MusicUserError(`既有語音連線尚未就緒：${getBriefMusicError(error)}`, 'voice_connect_failed');
      }
      return existingConnection;
    }
  }

  // validateVoiceChannelForPlayback was already called by joinMusicVoiceChannel

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on('error', (error) => {
    logger.warn(`Local Voice connection error in guild ${voiceChannel.guild.id}: ${error?.message || error}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    logger.warn(`Local Voice connection disconnected in guild ${voiceChannel.guild.id}.`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    try {
      connection.destroy();
    } catch (destroyError) {
      logger.warn(`Failed to destroy failed local voice connection: ${destroyError?.message || destroyError}`);
    }

    throw new MusicUserError(`小吉加入語音頻道逾時或失敗：${getBriefMusicError(error)}`, 'voice_connect_failed');
  }

  return connection;
}

// Lavalink Main Functions
async function joinMusicVoiceChannel({ guild, voiceChannel, textChannel = null }) {
  validateVoiceChannelForPlayback(voiceChannel, { commandName: '/music join' });

  // Disconnect Lavalink if it's there to let local connection take over the join check
  try {
      const kazagumo = getKazagumo();
      const player = kazagumo.players.get(guild.id);
      if (player) {
          await player.destroy();
      }
  } catch(e) {}

  const state = getLocalMusicState(guild.id);
  state.textChannel = textChannel || state.textChannel;
  state.connection = await connectToLocalVoice(voiceChannel);
  state.connection.subscribe(state.player);
  scheduleIdleDisconnect(state);
  
  return {
      channelId: voiceChannel.id,
      channelName: voiceChannel.name || '語音頻道',
      reused: state.connection.joinConfig.channelId === voiceChannel.id,
  };
}

async function runExclusiveGuildPlaybackOperation(guildId, operation) {
  const normalizedGuildId = String(guildId || '').trim();
  if (!normalizedGuildId || typeof operation !== 'function') {
    throw new TypeError('Guild playback operation requires a guildId and callback');
  }

  const previous = guildPlaybackOperationTails.get(normalizedGuildId) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  guildPlaybackOperationTails.set(normalizedGuildId, current);

  await previous.catch(() => {});

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (guildPlaybackOperationTails.get(normalizedGuildId) === current) {
      guildPlaybackOperationTails.delete(normalizedGuildId);
    }
  }
}

function getGuildPlaybackOperationCount() {
  return guildPlaybackOperationTails.size;
}

async function enqueueTrackUnlocked({ guild, voiceChannel, textChannel, url, requestedBy }) {
  const input = String(url || '').trim();
  if (/^https?:\/\//i.test(input) && !isYouTubeUrl(input)) {
      throw new MusicUserError('目前只支援 YouTube watch、Shorts 或 youtu.be 影片連結。', 'unsupported_music_url');
  }
  validateVoiceChannelForPlayback(voiceChannel);
  
  let kazagumo;
  try {
      kazagumo = getKazagumo();
      if (!kazagumo.shoukaku.nodes.size) {
          throw new Error('No nodes online');
      }
  } catch (error) {
      throw new MusicUserError('音樂服務尚未初始化或節點離線中，請稍後再試。', 'lavalink_unavailable');
  }

  destroyLocalVoiceConnection(guild.id, 'before Lavalink playback');

  let player = kazagumo.players.get(guild.id);
  let connection = kazagumo.shoukaku.connections.get(guild.id);

  if (player && (!connection || connection.channelId !== voiceChannel.id)) {
      logger.warn(
          `[Music] Existing Lavalink player has invalid voice connection in guild ${guild.id}: playerVoiceId=${player.voiceId || 'none'} connectionChannelId=${connection?.channelId || 'none'} requestedVoiceId=${voiceChannel.id}. Recreating player.`
      );
      try {
          await player.destroy();
      } catch (error) {
          logger.warn(`[Music] Failed to destroy stale Lavalink player in guild ${guild.id}: ${error?.message || error}`);
      }
      player = null;
      connection = null;
  }

  if (!player) {
      try {
          const shardId = typeof guild.shardId === 'number' ? guild.shardId : 0;
          player = await kazagumo.createPlayer({
              guildId: guild.id,
              textId: textChannel.id,
              voiceId: voiceChannel.id,
              volume: 100,
              deaf: true,
              shardId,
          });
          logger.info(
              `[Music] Created Kazagumo player guildId=${guild.id} voiceId=${voiceChannel.id} textId=${textChannel.id} shardId=${shardId} state=${player.state}`
          );
      } catch (error) {
           throw new MusicUserError(`無法建立音訊播放器：${getBriefMusicError(error)}`, 'lavalink_player_failed');
      }
  } else {
      if (player.textId !== textChannel.id && typeof player.setTextChannel === 'function') {
          player.setTextChannel(textChannel.id);
      }

      if (player.voiceId !== voiceChannel.id && typeof player.setVoiceChannel === 'function') {
          player.setVoiceChannel(voiceChannel.id);
      }
  }

  // Clear local state idle timer if lavalink is active
  cancelIdleDisconnect(getLocalMusicState(guild.id));
  cancelLavalinkIdleDisconnect(guild.id);

  const requester = buildLavalinkTrackUserData(requestedBy);
  const result = await resolveLavalinkSearch(kazagumo, input, requester);

  if (!result.tracks.length) {
      throw new MusicUserError('找不到可播放的結果。', 'youtube_parse_failed');
  }

  const track = result.tracks[0];
  const started = !player.playing && !player.paused;
  let playbackConfirmed = false;

  if (result.type === "PLAYLIST" && !started) {
      player.queue.add(result.tracks);
  } else if (!started) {
      player.queue.add(track);
  }

  connection = kazagumo.shoukaku.connections.get(guild.id);
  logPlaybackSnapshot(
      'info',
      'Prepared Lavalink playback',
      getLavalinkPlaybackSnapshot({
          player,
          connection,
          track,
          queueLengthOverride: player.queue.length,
      }),
      {
          guildId: guild.id,
          input: isYouTubeUrl(url) ? 'youtube_url' : 'search',
          loadType: result.type,
          willStartNow: started,
      }
  );
  
  if (started) {
      const playbackIdentity = {
          requestId: requester.playbackRequestId,
          encodedTrack: track.track,
      };
      const playbackConfirmationPromise = waitForLavalinkPlaybackConfirmation(guild.id, playbackIdentity);

      try {
          await player.play(track, { replaceCurrent: true });
          if (result.type === "PLAYLIST" && result.tracks.length > 1) {
              player.queue.add(result.tracks.slice(1));
          }
      } catch (error) {
          cancelLavalinkPlaybackConfirmation(guild.id, requester.playbackRequestId);
          logPlaybackSnapshot(
              'error',
              'Lavalink playTrack REST request failed',
              getLavalinkPlaybackSnapshot({
                  player,
                  connection: kazagumo.shoukaku.connections.get(guild.id),
                  track,
                  queueLengthOverride: player.queue.length,
              }),
              {
                  guildId: guild.id,
                  restError: getRestErrorDiagnostics(error),
              }
          );
          throw new MusicUserError(`Lavalink 接收播放請求失敗：${getBriefMusicError(error)}`, 'lavalink_play_failed');
      }

      const playbackOutcome = await playbackConfirmationPromise;
      playbackConfirmed = Boolean(playbackOutcome.confirmed);

      if (!playbackConfirmed) {
          logPlaybackSnapshot(
              'warn',
              playbackOutcome.failed
                  ? 'Lavalink playback failed before sustained audio was confirmed'
                  : 'Lavalink did not confirm sustained audio before timeout',
              getLavalinkPlaybackSnapshot({
                  player,
                  connection: kazagumo.shoukaku.connections.get(guild.id),
                  track,
                  queueLengthOverride: player.queue.length,
              }),
              {
                  guildId: guild.id,
                  voiceId: voiceChannel.id,
                  textId: textChannel.id,
                  input: isYouTubeUrl(url) ? 'youtube_url' : 'search',
                  outcomeEventType: playbackOutcome.eventType || 'timeout',
                  suggestion: isYouTubeUrl(url)
                      ? 'Try a credential-free client fallback or move Lavalink to a clean egress IP.'
                      : 'Try a normal YouTube URL to distinguish search result issues from node source issues.',
              }
          );

          throw createPlaybackConfirmationError(input, track, playbackIdentity, playbackOutcome);
      } else {
          logger.info(
              `[Music] Sustained playback confirmed by ${playbackOutcome.eventType}: guildId=${guild.id} voiceId=${voiceChannel.id} textId=${textChannel.id} track=${track.title} position=${playbackOutcome.position}`
          );
      }
  }

  return {
    backend: 'lavalink',
    sourceName: track.sourceName || track.raw?.info?.sourceName || null,
    track: {
        title: result.type === "PLAYLIST" ? `播放清單：${result.playlistName}` : track.title,
        url: track.uri,
        sourceName: track.sourceName || track.raw?.info?.sourceName || null,
    },
    position: player.queue.length,
    started: started && playbackConfirmed,
  };
}

function assertCrossSourceFallbackStateIsIdle(kazagumo, guildId, voiceChannelId) {
  const localState = guildLocalMusicStates.get(guildId);
  if (
    localState?.connection ||
    localState?.current ||
    localState?.currentRuntime ||
    localState?.currentProcess ||
    localState?.playing ||
    localState?.queue?.length
  ) {
    throw new MusicUserError('本機音訊狀態尚未安全清理。', 'soundcloud_fallback_cleanup_failed');
  }
  if (getVoiceConnection(guildId)) {
    throw new MusicUserError('偵測到未清理的本機語音連線。', 'soundcloud_fallback_cleanup_failed');
  }

  const player = kazagumo.players.get(guildId) || null;
  const connection = kazagumo.shoukaku.connections.get(guildId) || null;
  if (!player && connection) {
    throw new MusicUserError('偵測到未綁定播放器的 Lavalink 連線。', 'soundcloud_fallback_cleanup_failed');
  }
  if (
    player &&
    (player.playing ||
      player.paused ||
      player.queue?.length > 0 ||
      !connection ||
      connection.channelId !== voiceChannelId)
  ) {
    throw new MusicUserError('失敗播放器仍有不可安全取代的狀態。', 'soundcloud_fallback_cleanup_failed');
  }
  return player;
}

async function createSoundCloudFallbackPlayer(kazagumo, existingPlayer, { guild, voiceChannel, textChannel }) {
  if (existingPlayer) {
    if (existingPlayer.textId !== textChannel.id && typeof existingPlayer.setTextChannel === 'function') {
      existingPlayer.setTextChannel(textChannel.id);
    }
    return existingPlayer;
  }
  try {
    return await kazagumo.createPlayer({
      guildId: guild.id,
      textId: textChannel.id,
      voiceId: voiceChannel.id,
      volume: 100,
      deaf: true,
      shardId: typeof guild.shardId === 'number' ? guild.shardId : 0,
    });
  } catch {
    throw new MusicUserError('SoundCloud 同曲備援無法建立音訊播放器。', 'soundcloud_fallback_player_failed');
  }
}

async function cleanupFailedSoundCloudFallbackPlayer(player, encodedTrack) {
  const currentEncoded = player?.queue?.current?.track || player?.queue?.current?.raw?.encoded;
  if (currentEncoded !== encodedTrack || player?.queue?.length > 0) return false;
  await player.destroy().catch(() => {});
  return true;
}

async function playSoundCloudSameTrackFallback(
  originalError,
  { guild, voiceChannel, textChannel, url, requestedBy },
  dependencies = {}
) {
  const seed = getTrustedSoundCloudFallbackSeed(originalError);
  const inputVideoId = extractStrictYouTubeVideoId(url);
  const normalizedRequesterId = String(requestedBy || '').trim();
  if (!seed || seed.videoId !== inputVideoId || seed.requesterId !== normalizedRequesterId) {
    throw new MusicUserError('SoundCloud 同曲備援缺少可信來源資料。', 'soundcloud_fallback_seed_invalid');
  }

  const getClient = dependencies.getKazagumo || getKazagumo;
  const assertIdle = dependencies.assertIdle || assertCrossSourceFallbackStateIsIdle;
  const createPlayer = dependencies.createPlayer || createSoundCloudFallbackPlayer;
  const resolveSearch = dependencies.resolveSearch || resolveSoundCloudSearch;
  const waitForConfirmation = dependencies.waitForConfirmation || waitForLavalinkPlaybackConfirmation;
  const cancelConfirmation = dependencies.cancelConfirmation || cancelLavalinkPlaybackConfirmation;
  const cleanupFailedPlayer = dependencies.cleanupFailedPlayer || cleanupFailedSoundCloudFallbackPlayer;
  let player = null;
  let fallbackRequester = null;
  let selectedTrack = null;

  try {
    const kazagumo = getClient();
    const existingPlayer = assertIdle(kazagumo, guild.id, voiceChannel.id);
    fallbackRequester = buildLavalinkTrackUserData(seed.requesterId);
    const result = await resolveSearch(kazagumo, seed, fallbackRequester);
    const selected = selectUniqueSoundCloudSameTrack(seed, result, { guildId: guild.id });
    if (!selected.track) {
      throw new MusicUserError('SoundCloud 同曲備援找不到唯一可信的同曲。', selected.code);
    }
    selectedTrack = selected.track;
    selectedTrack.requester = fallbackRequester;

    player = await createPlayer(kazagumo, existingPlayer, { guild, voiceChannel, textChannel });
    const playbackIdentity = {
      requestId: fallbackRequester.playbackRequestId,
      encodedTrack: selectedTrack.track,
    };
    const confirmationPromise = waitForConfirmation(guild.id, playbackIdentity);
    try {
      await player.play(selectedTrack, { replaceCurrent: true });
    } catch {
      cancelConfirmation(guild.id, fallbackRequester.playbackRequestId);
      throw new MusicUserError('SoundCloud 同曲備援播放請求失敗。', 'soundcloud_fallback_play_failed');
    }

    const outcome = await confirmationPromise;
    if (!outcome.confirmed) {
      throw new MusicUserError(
        'SoundCloud 同曲備援未達持續音訊確認門檻。',
        outcome.failed ? 'soundcloud_fallback_stream_failed' : 'soundcloud_fallback_stream_unconfirmed'
      );
    }

    cancelLavalinkIdleDisconnect(guild.id);
    logger.info(
      `[Music] SoundCloud same-track fallback confirmed: guildId=${sanitizeMusicGuildId(guild.id)} sourceName=soundcloud event=${outcome.eventType || 'confirmed'}`
    );
    return {
      backend: 'soundcloud-same-track',
      sourceName: 'soundcloud',
      position: 0,
      started: true,
      track: {
        title: selectedTrack.title,
        url: selectedTrack.uri,
        sourceName: 'soundcloud',
      },
    };
  } catch (error) {
    if (fallbackRequester) cancelConfirmation(guild.id, fallbackRequester.playbackRequestId);
    if (player && selectedTrack) await cleanupFailedPlayer(player, selectedTrack.track);
    const code = String(error?.code || '').startsWith('soundcloud_')
      ? String(error.code)
      : 'soundcloud_fallback_failed';
    const safeGuildId = sanitizeMusicGuildId(guild?.id);
    logger.warn(`[Music] SoundCloud same-track fallback failed closed: guildId=${safeGuildId} code=${code}`);
    if (error instanceof MusicUserError && String(error.code).startsWith('soundcloud_')) throw error;
    throw new MusicUserError('SoundCloud 同曲備援失敗。', code);
  }
}

async function enqueueTrack(options) {
  return runExclusiveGuildPlaybackOperation(options?.guild?.id, async () => {
    const existingLocalState = guildLocalMusicStates.get(options?.guild?.id);
    if (existingLocalState?.current?.source === 'youtube-local' && existingLocalState.playing) {
      throw new MusicUserError('本機 YouTube 音訊仍在播放，請先停止後再點播。', 'queue_busy');
    }

    try {
      return await enqueueTrackUnlocked(options);
    } catch (error) {
      if (!shouldUseLocalYouTubeFallback(error, options?.url)) throw error;
      try {
        return await playLocalYouTubeFallback(buildLocalYouTubeFallbackOptions(error, options));
      } catch (localError) {
        if (isYtdlpCookieConfigurationError(localError)) throw localError;
        if (!getTrustedSoundCloudFallbackSeed(error)) throw localError;
        return playSoundCloudSameTrackFallback(error, options);
      }
    }
  });
}

function formatMusicPlaybackReply(result) {
  if (result?.backend === 'soundcloud-same-track' && result?.sourceName === 'soundcloud') {
    return result.started
      ? `已透過 SoundCloud 同曲備援開始播放：${result.track.title}（實際來源：SoundCloud）`
      : `已透過 SoundCloud 同曲備援加入播放佇列：${result.track.title}（實際來源：SoundCloud）`;
  }
  return result?.started
    ? `已開始播放：${result.track.title}`
    : `已加入播放佇列：${result.track.title}`;
}

function shouldUseLocalYouTubeFallback(error, input) {
  return (
    ['youtube_source_failed', 'youtube_stream_failed'].includes(String(error?.code || '')) &&
    Boolean(extractStrictYouTubeVideoId(input))
  );
}

function buildFfmpegYoutubeFallbackArgs() {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    'pipe:0',
    '-vn',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-f',
    'ogg',
    'pipe:1',
  ];
}

function runYouTubeLocalRuntimeStage(operation, fallbackCode) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError(fallbackCode);
  }
}

function createYoutubeFallbackRuntime(
  webStream,
  { spawnImpl = spawn, readableFromWeb = Readable.fromWeb, nodeStream = null, sourceProcess = null } = {}
) {
  if (!ffmpegPath) throw new YouTubeLocalSourceError('youtube_local_ffmpeg_missing');
  if ((!webStream && !nodeStream) || (!nodeStream && typeof readableFromWeb !== 'function')) {
    throw new YouTubeLocalSourceError('youtube_local_stream_invalid');
  }

  const sourceStream = runYouTubeLocalRuntimeStage(
    () => nodeStream || readableFromWeb(webStream),
    'youtube_local_stream_failed'
  );
  const activity = { inputBytes: 0, outputBytes: 0 };
  const inputMonitor = new Transform({
    transform(chunk, encoding, callback) {
      activity.inputBytes += Buffer.byteLength(chunk);
      callback(null, chunk);
    },
  });
  const outputMonitor = new Transform({
    transform(chunk, encoding, callback) {
      activity.outputBytes += Buffer.byteLength(chunk);
      callback(null, chunk);
    },
  });
  let subprocess;
  try {
    subprocess = spawnImpl(ffmpegPath, buildFfmpegYoutubeFallbackArgs(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    sourceStream.destroy();
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_ffmpeg_failed');
  }

  if (!subprocess?.stdin || !subprocess?.stdout) {
    sourceStream.destroy();
    try {
      subprocess?.kill?.('SIGKILL');
    } catch {
      // Setup already failed; keep the original closed stage code.
    }
    throw new YouTubeLocalSourceError('youtube_local_ffmpeg_stream_failed');
  }

  let cleaned = false;
  let stderr = '';
  const onStderrData = (chunk) => {
    stderr = `${stderr}\n${String(chunk)}`.trim().slice(-500);
  };
  try {
    subprocess.stderr?.on('data', onStderrData);
    subprocess.stdin.on('error', () => {});
    sourceStream.pipe(inputMonitor).pipe(subprocess.stdin);
    subprocess.stdout.pipe(outputMonitor);
  } catch (error) {
    subprocess.stderr?.off?.('data', onStderrData);
    sourceStream.destroy();
    inputMonitor.destroy();
    outputMonitor.destroy();
    subprocess.stdin?.destroy?.();
    subprocess.stdout?.destroy?.();
    subprocess.stderr?.destroy?.();
    try {
      if (!subprocess.killed) subprocess.kill?.('SIGKILL');
    } catch {
      // Setup already failed; keep the original closed stage code.
    }
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_ffmpeg_stream_failed');
  }

  const runtime = {
    activity,
    get cleaned() {
      return cleaned;
    },
    get stderrPresent() {
      return Boolean(stderr);
    },
    inputMonitor,
    outputStream: outputMonitor,
    sourceStream,
    sourceProcess,
    subprocess,
    guardCleanup: null,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      runtime.guardCleanup?.();
      runtime.guardCleanup = null;
      subprocess.stderr?.off('data', onStderrData);
      sourceStream.unpipe(inputMonitor);
      inputMonitor.unpipe(subprocess.stdin);
      subprocess.stdout?.unpipe(outputMonitor);
      sourceStream.destroy();
      inputMonitor.destroy();
      outputMonitor.destroy();
      subprocess.stdin?.destroy();
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
      if (!subprocess.killed) subprocess.kill('SIGKILL');
      sourceProcess?.stdout?.destroy?.();
      sourceProcess?.stderr?.destroy?.();
      try {
        if (sourceProcess && !sourceProcess.killed) sourceProcess.kill('SIGKILL');
      } catch {
        // The source process may already have exited naturally.
      }
    },
  };

  return runtime;
}

function waitForSustainedLocalPlayback(
  state,
  resource,
  runtime,
  {
    timeoutMs = youtubeFallbackStartupTimeoutMs,
    minimumPlaybackMs = youtubeFallbackMinimumPlaybackMs,
    minimumOutputBytes = youtubeFallbackMinimumOutputBytes,
    enterPlaying = () => entersState(state.player, AudioPlayerStatus.Playing, timeoutMs),
  } = {}
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let playing = false;
    const timer = setTimeout(
      () => settle(reject, new YouTubeLocalSourceError('youtube_local_no_audio')),
      timeoutMs
    );
    const interval = setInterval(() => {
      if (
        playing &&
        runtime.activity.inputBytes > 0 &&
        runtime.activity.outputBytes >= minimumOutputBytes &&
        resource.playbackDuration >= minimumPlaybackMs
      ) {
        settle(resolve, {
          inputBytes: runtime.activity.inputBytes,
          outputBytes: runtime.activity.outputBytes,
          playbackDuration: resource.playbackDuration,
        });
      }
    }, 50);

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(interval);
      state.player.off('error', onPlayerError);
      runtime.sourceStream.off('error', onStreamError);
      runtime.outputStream.off('error', onStreamError);
      runtime.subprocess.off('error', onProcessError);
      runtime.subprocess.off('close', onProcessClose);
      runtime.sourceProcess?.off('error', onSourceProcessError);
      runtime.sourceProcess?.off('close', onSourceProcessClose);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (error, fallbackCode) =>
      settle(
        reject,
        new YouTubeLocalSourceError(getSafeYouTubeLocalErrorCode(error, fallbackCode))
      );
    const onPlayerError = (error) => fail(error, 'youtube_local_player_failed');
    const onStreamError = (error) => fail(error, 'youtube_local_stream_failed');
    const onProcessError = (error) => fail(error, 'youtube_local_ffmpeg_failed');
    const onProcessClose = (code) => {
      if (code !== 0 && !runtime.cleaned) fail(null, 'youtube_local_ffmpeg_failed');
    };
    const onSourceProcessError = (error) => fail(error, 'youtube_local_stream_failed');
    const onSourceProcessClose = (code) => {
      if (code !== 0 && !runtime.cleaned) fail(null, 'youtube_local_stream_failed');
    };

    state.player.once('error', onPlayerError);
    runtime.sourceStream.once('error', onStreamError);
    runtime.outputStream.once('error', onStreamError);
    runtime.subprocess.once('error', onProcessError);
    runtime.subprocess.once('close', onProcessClose);
    runtime.sourceProcess?.once('error', onSourceProcessError);
    runtime.sourceProcess?.once('close', onSourceProcessClose);

    Promise.resolve()
      .then(() => enterPlaying())
      .then(() => {
        playing = true;
      })
      .catch((error) => fail(error, 'youtube_local_player_not_playing'));
  });
}

function attachYoutubeFallbackRuntimeGuards(state, runtime) {
  const fail = (error, fallbackCode) => {
    if (runtime.cleaned || state.currentRuntime !== runtime) return;
    logYouTubeLocalFailure(state.guildId, error, fallbackCode);
    cleanupCurrentProcess(state);
    state.current = null;
    state.playing = false;
    state.player.stop(true);
    scheduleIdleDisconnect(state);
  };
  const onSourceError = (error) => fail(error, 'youtube_local_stream_failed');
  const onOutputError = (error) => fail(error, 'youtube_local_stream_failed');
  const onProcessError = (error) => fail(error, 'youtube_local_ffmpeg_failed');
  const onProcessClose = (code) => {
    if (code !== 0) fail(null, 'youtube_local_ffmpeg_failed');
  };
  const onSourceProcessError = (error) => fail(error, 'youtube_local_stream_failed');
  const onSourceProcessClose = (code) => {
    if (code !== 0) fail(null, 'youtube_local_stream_failed');
  };

  runtime.sourceStream.once('error', onSourceError);
  runtime.outputStream.once('error', onOutputError);
  runtime.subprocess.once('error', onProcessError);
  runtime.subprocess.once('close', onProcessClose);
  runtime.sourceProcess?.once('error', onSourceProcessError);
  runtime.sourceProcess?.once('close', onSourceProcessClose);

  runtime.guardCleanup = () => {
    runtime.sourceStream.off('error', onSourceError);
    runtime.outputStream.off('error', onOutputError);
    runtime.subprocess.off('error', onProcessError);
    runtime.subprocess.off('close', onProcessClose);
    runtime.sourceProcess?.off('error', onSourceProcessError);
    runtime.sourceProcess?.off('close', onSourceProcessClose);
  };
}

async function cancelWebStream(webStream) {
  try {
    await webStream?.cancel?.();
  } catch {
    // The stream may already be locked by Readable.fromWeb; runtime cleanup handles it.
  }
}

async function playLocalYouTubeFallback({ guild, voiceChannel, textChannel, url, requestedBy, durationEvidence }) {
  validateVoiceChannelForPlayback(voiceChannel);
  let sourceResult;
  let runtime;
  const state = getLocalMusicState(guild.id);

  try {
    try {
      sourceResult = await loadYtdlpYouTubeAudio(url, {
        allowCookies: isPrivateYouTubeCookieAccess({ guild, requestedBy }),
      });
    } catch (ytdlpError) {
      if (isYtdlpCookieConfigurationError(ytdlpError)) throw ytdlpError;
      const diagnostics = getYtdlpDiagnostics(ytdlpError);
      const diagnosticSuffix = diagnostics ? ` diagnostics=${JSON.stringify(diagnostics)}` : '';
      logger.warn(
        `[Music] Nyanko yt-dlp fallback unavailable: guildId=${String(guild.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)} code=${getSafeYouTubeLocalErrorCode(ytdlpError, 'youtube_local_source_failed')}${diagnosticSuffix}`
      );
      sourceResult = await loadAnonymousYouTubeAudio(url, { durationEvidence });
    }

    const kazagumo = getKazagumo();
    const lavalinkPlayer = kazagumo.players.get(guild.id);
    if (lavalinkPlayer) await lavalinkPlayer.destroy();
    if (kazagumo.players.get(guild.id)) {
      throw new YouTubeLocalSourceError('youtube_local_lavalink_cleanup_failed');
    }

    cancelLavalinkIdleDisconnect(guild.id);
    cancelIdleDisconnect(state);
    state.textChannel = textChannel;
    state.queue = [];

    if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
      state.connection = await connectToLocalVoice(voiceChannel);
    }
    runYouTubeLocalRuntimeStage(
      () => state.connection.subscribe(state.player),
      'youtube_local_player_failed'
    );

    runtime = createYoutubeFallbackRuntime(sourceResult.webStream, {
      nodeStream: sourceResult.nodeStream,
      sourceProcess: sourceResult.sourceProcess,
    });
    const track = {
      ...sourceResult.track,
      requestedBy: String(requestedBy || ''),
    };
    const resource = runYouTubeLocalRuntimeStage(
      () => createAudioResource(runtime.outputStream, {
        inputType: StreamType.OggOpus,
        metadata: track,
      }),
      'youtube_local_player_failed'
    );

    state.current = track;
    state.currentProcess = runtime.subprocess;
    state.currentRuntime = runtime;
    state.playing = false;
    runYouTubeLocalRuntimeStage(
      () => state.player.play(resource),
      'youtube_local_player_failed'
    );

    const confirmation = await waitForSustainedLocalPlayback(state, resource, runtime);
    state.playing = true;
    attachYoutubeFallbackRuntimeGuards(state, runtime);
    logger.info(
      `[Music] Local YouTube fallback confirmed: guildId=${guild.id} playbackMs=${confirmation.playbackDuration} inputBytes=${confirmation.inputBytes} outputBytes=${confirmation.outputBytes}`
    );

    return {
      backend: 'youtube-local',
      sourceName: 'youtube',
      position: 0,
      started: true,
      track: { title: track.title, sourceName: 'youtube' },
    };
  } catch (error) {
    const errorCode = getSafeYouTubeLocalErrorCode(error, 'youtube_local_playback_failed');
    if (runtime) runtime.cleanup();
    else {
      await cancelWebStream(sourceResult?.webStream);
      sourceResult?.nodeStream?.destroy?.();
      try {
        if (sourceResult?.sourceProcess && !sourceResult.sourceProcess.killed) {
          sourceResult.sourceProcess.kill('SIGKILL');
        }
      } catch {
        // The source process may already have exited.
      }
    }
    if (state.currentRuntime === runtime) state.currentRuntime = null;
    state.currentProcess = null;
    state.current = null;
    state.playing = false;
    state.player.stop(true);
    if (state.connection) disconnectMusicState(state);
    logYouTubeLocalFailure(guild.id, error);
    throw new YouTubeLocalSourceError(errorCode);
  }
}

// Local Ffmpeg functionality specifically for /music test
function buildFfmpegTestToneArgs({ durationSeconds = testToneDurationSeconds, frequencyHz = testToneFrequencyHz } = {}) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequencyHz}:duration=${durationSeconds}`,
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-f',
    'ogg',
    'pipe:1',
  ];
}

function createFfmpegTestToneStream() {
  if (!ffmpegPath) {
    throw new MusicUserError('找不到 ffmpeg-static 提供的 ffmpeg 執行檔。', 'ffmpeg_missing');
  }

  const subprocess = spawn(ffmpegPath, buildFfmpegTestToneArgs(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  subprocess.xiaojiStderr = '';

  subprocess.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      subprocess.xiaojiStderr = `${subprocess.xiaojiStderr}\n${message}`.trim().slice(-1000);
      logger.warn(`ffmpeg stderr: ${message}`);
    }
  });

  subprocess.on('error', (error) => {
    logger.warn(`ffmpeg process error: ${error?.message || error}`);
  });

  subprocess.on('close', (code, signal) => {
    if (code && !subprocess.killed) {
      logger.warn(`ffmpeg exited with code ${code}${signal ? ` and signal ${signal}` : ''}`);
    }
  });

  return subprocess;
}

function waitForPlaybackStart(state, subprocess, { sourceName = '音訊來源', failureCode = 'player_not_playing' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      subprocess.off('error', onProcessError);
      subprocess.off('close', onProcessClose);
    };

    const settle = (fn, value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn(value);
    };

    const onProcessError = (error) => {
      settle(reject, new MusicUserError(`${sourceName} 啟動失敗：${getBriefMusicError(error)}`, failureCode));
    };

    const onProcessClose = (code, signal) => {
      if (code && !subprocess.killed) {
        const stderr = subprocess.xiaojiStderr ? `；${subprocess.xiaojiStderr}` : '';
        const message = `${sourceName} 結束，代碼 ${code}${signal ? `，訊號 ${signal}` : ''}${stderr}`;
        settle(reject, new MusicUserError(message, failureCode));
      }
    };

    subprocess.once('error', onProcessError);
    subprocess.once('close', onProcessClose);

    entersState(state.player, AudioPlayerStatus.Playing, 15_000)
      .then((value) => settle(resolve, value))
      .catch((error) =>
        settle(reject, new MusicUserError(`播放器未進入播放狀態：${getBriefMusicError(error)}`, 'player_not_playing'))
      );
  });
}

async function createTestToneResource() {
  const subprocess = createFfmpegTestToneStream();

  if (!subprocess.stdout) {
    throw new MusicUserError('無法建立 ffmpeg 測試音串流。', 'ffmpeg_stream_failed');
  }

  const track = {
    url: 'xiaoji:test-tone',
    title: '小吉音樂系統測試音',
    duration: testToneDurationSeconds,
    requestedBy: null,
  };
  const resource = createAudioResource(subprocess.stdout, {
    inputType: StreamType.OggOpus,
    metadata: track,
  });

  return { resource, subprocess, track };
}

async function playTestTone({ guild, voiceChannel, textChannel }) {
  // Ensure Lavalink leaves before local takes over
  let kazagumo;
  try {
      kazagumo = getKazagumo();
      const player = kazagumo.players.get(guild.id);
      if (player) {
          await player.destroy();
      }
  } catch (e) {
      // Ignore
  }

  const state = getLocalMusicState(guild.id);
  cancelIdleDisconnect(state);
  validateVoiceChannelForPlayback(voiceChannel, { commandName: '/music test' });

  if (state.current || state.playing || state.queue.length > 0) {
    throw new MusicUserError('目前正在播放或佇列中仍有歌曲，請先使用 /music stop 再執行 /music test。', 'queue_busy');
  }

  state.textChannel = textChannel;

  if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
    state.connection = await connectToLocalVoice(voiceChannel);
  }

  state.connection.subscribe(state.player);

  const { resource, subprocess, track } = await createTestToneResource();
  state.current = track;
  state.playing = true;
  state.currentProcess = subprocess;

  try {
    state.player.play(resource);
    await waitForPlaybackStart(state, subprocess, {
      sourceName: 'ffmpeg',
      failureCode: 'ffmpeg_test_failed',
    });
  } catch (error) {
    cleanupCurrentProcess(state);
    state.current = null;
    state.playing = false;
    scheduleIdleDisconnect(state);
    throw error;
  }

  return {
    track,
    durationSeconds: testToneDurationSeconds,
  };
}

function getQueue(guildId) {
    let kazagumo;
    try {
        kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            return {
                current: player.queue.current ? { title: player.queue.current.title } : null,
                queue: player.queue.map(track => ({ title: track.title }))
            };
        }
    } catch (e) {
        // Ignore
    }

    // Local fallback check
    const state = getLocalMusicState(guildId);
    return {
      current: state.current,
      queue: [...state.queue],
    };
}

function skipTrack(guildId) {
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            const current = player.queue.current;
            player.skip();
            return current ? { title: current.title } : null;
        }
    } catch (e) {
        // Ignore
    }

    const state = getLocalMusicState(guildId);
    const skippedTrack = state.current;
    cleanupCurrentProcess(state);
    state.player.stop(true);

    if (!skippedTrack && state.queue.length === 0) {
      scheduleIdleDisconnect(state);
    }

    return skippedTrack;
}

function leaveVoiceChannel(guildId) {
    let wasConnected = false;
    cancelLavalinkIdleDisconnect(guildId);
    
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            wasConnected = true;
            void player.destroy().catch((error) =>
                logger.warn(`Failed to destroy Lavalink player in guild ${guildId}: ${error?.message || error}`)
            );
        }
    } catch (e) {
        // Ignore
    }

    const state = guildLocalMusicStates.get(guildId);
    if (state && state.connection) {
        wasConnected = true;
        disconnectMusicState(state);
    }

    if (destroyLocalVoiceConnection(guildId, '/music leave')) {
        wasConnected = true;
    }

    return wasConnected;
}

function getVoiceStayStatus(guildId) {
  const policy = getVoiceStayPolicy(guildId);
  const localState = guildLocalMusicStates.get(guildId);
  const localConnection = localState?.connection || getVoiceConnection(guildId);
  let lavalinkPlayer = null;
  try {
    lavalinkPlayer = getKazagumo().players.get(guildId) || null;
  } catch {
    // Lavalink is optional for local voice diagnostics.
  }

  return {
    ...policy,
    backend: lavalinkPlayer ? 'lavalink' : localConnection ? 'local' : 'none',
    channelId: lavalinkPlayer?.voiceId || localConnection?.joinConfig?.channelId || null,
    idleTimerScheduled: Boolean(localState?.idleTimer || lavalinkIdleTimers.has(guildId)),
    playing: Boolean(lavalinkPlayer?.playing || localState?.playing),
  };
}

async function handleBotVoiceStateUpdate(oldState, newState) {
  const clientUserId = newState?.client?.user?.id || oldState?.client?.user?.id;
  const userId = newState?.id || oldState?.id || newState?.member?.id || oldState?.member?.id;
  if (!clientUserId || userId !== clientUserId) return false;

  const guildId = newState?.guild?.id || oldState?.guild?.id;
  const oldChannelId = oldState?.channelId || null;
  const newChannelId = newState?.channelId || null;
  if (!guildId || oldChannelId === newChannelId) return false;

  const localState = guildLocalMusicStates.get(guildId);
  let lavalinkPlayer = null;
  try {
    lavalinkPlayer = getKazagumo().players.get(guildId) || null;
  } catch {
    // No Lavalink runtime.
  }

  if (!newChannelId) {
    if (localState) disconnectMusicState(localState);
    if (lavalinkPlayer) await lavalinkPlayer.destroy().catch(() => undefined);
    logger.info(`[Music] Bot left voice in guild ${guildId}; stale player state was cleared.`);
    return true;
  }

  if (lavalinkPlayer && typeof lavalinkPlayer.setVoiceChannel === 'function') {
    await lavalinkPlayer.setVoiceChannel(newChannelId);
  }
  if (localState?.connection && localState.connection.joinConfig.channelId !== newChannelId && newState.channel) {
    localState.connection = await connectToLocalVoice(newState.channel);
    localState.connection.subscribe(localState.player);
    scheduleIdleDisconnect(localState);
  }
  logger.info(`[Music] Bot voice channel moved in guild ${guildId}: ${oldChannelId || 'none'} -> ${newChannelId}`);
  return true;
}

async function handleVoiceChannelDeleted(channel) {
  if (!channel?.guild?.id || !channel.isVoiceBased?.()) return false;
  const guildId = channel.guild.id;
  const localState = guildLocalMusicStates.get(guildId);
  let handled = false;

  if (localState?.connection?.joinConfig?.channelId === channel.id) {
    disconnectMusicState(localState);
    handled = true;
  }

  try {
    const player = getKazagumo().players.get(guildId);
    if (player?.voiceId === channel.id) {
      await player.destroy();
      handled = true;
    }
  } catch {
    // No Lavalink runtime.
  }

  if (handled) logger.info(`[Music] Deleted voice channel ${channel.id}; cleared guild ${guildId} voice state.`);
  return handled;
}

function stopMusic(guildId) {
    let kazagumo;
    try {
        kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            player.queue.clear();
        }
    } catch (e) {
        // Ignore
    }
    
    // Always call leave which handles destruction
    return leaveVoiceChannel(guildId);
}

function pauseMusic(guildId) {
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            player.pause(true);
            return true;
        }
    } catch (e) {
        // Ignore
    }
    
    const state = guildLocalMusicStates.get(guildId);
    if (state) return state.player.pause();
    return false;
}

function resumeMusic(guildId) {
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            player.pause(false);
            return true;
        }
    } catch (e) {
        // Ignore
    }
    
    const state = guildLocalMusicStates.get(guildId);
    if (state) return state.player.unpause();
    return false;
}

module.exports = {
  buildFfmpegTestToneArgs,
  buildFfmpegYoutubeFallbackArgs,
  buildLavalinkTrackUserData,
  buildLocalYouTubeFallbackOptions,
  buildTrustedLavalinkDurationEvidence,
  applyVoiceStayPolicy,
  cancelLavalinkIdleDisconnect,
  cleanupFailedSoundCloudFallbackPlayer,
  createFfmpegTestToneStream,
  createTestToneResource,
  createYoutubeFallbackRuntime,
  createPlaybackConfirmationError,
  enqueueTrack,
  evaluateSoundCloudCandidate,
  extractCanonicalTrackIdentity,
  extractCanonicalTrackIdentityCandidates,
  formatMusicPlaybackReply,
  getTrackVersionSemantics,
  getTrustedSoundCloudFallbackSeed,
  getMusicErrorLayer,
  getMusicUserFacingError,
  logYouTubeLocalFailure,
  getGuildPlaybackOperationCount,
  getQueue,
  getVoiceStayPolicy,
  getVoiceStayStatus,
  handleBotVoiceStateUpdate,
  handleVoiceChannelDeleted,
  isYouTubeUrl,
  isYouTubeLocalError,
  isPrivateYouTubeCookieAccess,
  isYtdlpCookieConfigurationError,
  joinMusicVoiceChannel,
  leaveVoiceChannel,
  MusicUserError,
  musicIdleLeaveMs,
  normalizeLavalinkLoadResult,
  normalizeTrackAuthor,
  normalizeTrackTitle,
  pauseMusic,
  playLocalYouTubeFallback,
  playSoundCloudSameTrackFallback,
  playTestTone,
  resumeMusic,
  resolveLavalinkSearch,
  resolveSoundCloudSearch,
  runExclusiveGuildPlaybackOperation,
  runYouTubeLocalRuntimeStage,
  scheduleLavalinkIdleDisconnect,
  shouldScheduleIdleDisconnect,
  shouldUseLocalYouTubeFallback,
  selectUniqueSoundCloudSameTrack,
  skipTrack,
  stopMusic,
  testToneDurationSeconds,
  soundCloudDurationToleranceMs,
  validateVoiceChannelForPlayback,
  waitForSustainedLocalPlayback,
};
