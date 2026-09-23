const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeSourceRequestTimeoutMs = 15_000;
const youtubeSourceMaxDurationSeconds = 2 * 60 * 60;
const youtubeMediaChunkBytes = 64 * 1024;
const youtubeSourceMaxBytes = 512 * 1024 * 1024;
const anonymousYouTubeInfoClients = Object.freeze(['IOS', 'ANDROID']);
const trustedYouTubeDurationEvidence = new WeakSet();
const youtubeLocalDiagnosticsByError = new WeakMap();
const youtubeLocalErrorCodes = new Set([
  'youtube_local_api_unavailable',
  'youtube_local_cookie_access_failed',
  'youtube_local_cookie_file_invalid',
  'youtube_local_cookie_format_invalid',
  'youtube_local_cookie_handoff_failed',
  'youtube_local_cookie_path_invalid',
  'youtube_local_cookie_permissions_invalid',
  'youtube_local_cookie_size_invalid',
  'youtube_local_cookie_source_changed',
  'youtube_local_duration_invalid',
  'youtube_local_duration_overlong',
  'youtube_local_fetch_unavailable',
  'youtube_local_ffmpeg_failed',
  'youtube_local_ffmpeg_missing',
  'youtube_local_ffmpeg_stream_failed',
  'youtube_local_format_decipher_failed',
  'youtube_local_format_selection_failed',
  'youtube_local_format_timeout',
  'youtube_local_import_timeout',
  'youtube_local_info_failed',
  'youtube_local_info_timeout',
  'youtube_local_invalid_video',
  'youtube_local_lavalink_cleanup_failed',
  'youtube_local_length_invalid',
  'youtube_local_live_rejected',
  'youtube_local_media_host_rejected',
  'youtube_local_media_invalid',
  'youtube_local_metadata_id_mismatch',
  'youtube_local_no_audio',
  'youtube_local_playback_failed',
  'youtube_local_player_failed',
  'youtube_local_player_not_playing',
  'youtube_local_range_invalid',
  'youtube_local_session_failed',
  'youtube_local_session_timeout',
  'youtube_local_source_failed',
  'youtube_local_stream_empty',
  'youtube_local_stream_create_failed',
  'youtube_local_stream_failed',
  'youtube_local_stream_invalid',
  'youtube_local_stream_timeout',
]);

function normalizeDurationSeconds(value) {
  let durationSeconds;

  if (typeof value === 'number') {
    durationSeconds = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    durationSeconds = Number(value);
  } else {
    return null;
  }

  return Number.isSafeInteger(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : null;
}

function createTrustedYouTubeDurationEvidence({
  videoId,
  sourceName,
  identifier,
  uri,
  isStream,
  requestId,
  encodedTrack,
  durationMs,
} = {}) {
  const normalizedVideoId = extractStrictYouTubeVideoId(videoId);
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  const normalizedEncodedTrack = typeof encodedTrack === 'string' ? encodedTrack.trim() : '';

  if (
    !normalizedVideoId ||
    videoId !== normalizedVideoId ||
    sourceName !== 'youtube' ||
    identifier !== normalizedVideoId ||
    extractStrictYouTubeVideoId(uri) !== normalizedVideoId ||
    isStream !== false ||
    !normalizedRequestId ||
    !normalizedEncodedTrack ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }

  const evidence = Object.freeze({
    videoId: normalizedVideoId,
    sourceName,
    identifier,
    uri,
    isStream,
    requestId: normalizedRequestId,
    encodedTrack: normalizedEncodedTrack,
    durationMs,
  });
  trustedYouTubeDurationEvidence.add(evidence);
  return evidence;
}

function getTrustedDurationMs(evidence, videoId) {
  if (!evidence || typeof evidence !== 'object' || !trustedYouTubeDurationEvidence.has(evidence)) {
    return null;
  }

  if (
    !Object.isFrozen(evidence) ||
    evidence.videoId !== videoId ||
    evidence.sourceName !== 'youtube' ||
    evidence.identifier !== videoId ||
    extractStrictYouTubeVideoId(evidence.uri) !== videoId ||
    evidence.isStream !== false ||
    typeof evidence.requestId !== 'string' ||
    !evidence.requestId ||
    typeof evidence.encodedTrack !== 'string' ||
    !evidence.encodedTrack ||
    !Number.isSafeInteger(evidence.durationMs) ||
    evidence.durationMs <= 0
  ) {
    return null;
  }

  return evidence.durationMs;
}

function validateYouTubeMetadataIdentity(info, videoId) {
  const returnedVideoId = info?.basic_info?.id;
  const returnedVideoIdAbsent =
    returnedVideoId === undefined ||
    returnedVideoId === null ||
    (typeof returnedVideoId === 'string' && returnedVideoId.trim() === '');

  if (
    !returnedVideoIdAbsent &&
    (typeof returnedVideoId !== 'string' || returnedVideoId !== videoId)
  ) {
    throw new YouTubeLocalSourceError('youtube_local_metadata_id_mismatch');
  }
}

function resolveYouTubeDurationSeconds(info, durationEvidence, videoId, durationLimitSeconds) {
  const metadataDurationSeconds = normalizeDurationSeconds(info?.basic_info?.duration);
  let durationSeconds = metadataDurationSeconds;

  if (metadataDurationSeconds === null) {
    const trustedDurationMs = getTrustedDurationMs(durationEvidence, videoId);
    if (trustedDurationMs === null) {
      throw new YouTubeLocalSourceError('youtube_local_duration_invalid');
    }
    if (trustedDurationMs > durationLimitSeconds * 1000) {
      throw new YouTubeLocalSourceError('youtube_local_duration_overlong');
    }
    durationSeconds = Math.ceil(trustedDurationMs / 1000);
  }
  if (durationSeconds > durationLimitSeconds) {
    throw new YouTubeLocalSourceError('youtube_local_duration_overlong');
  }

  return durationSeconds;
}

function getValidatedAudioCandidates(info) {
  const streamingData = info?.streaming_data;
  if (streamingData === undefined || streamingData === null) return [];
  if (
    typeof streamingData !== 'object' ||
    Array.isArray(streamingData) ||
    !Array.isArray(streamingData.formats) ||
    !Array.isArray(streamingData.adaptive_formats)
  ) {
    throw new YouTubeLocalSourceError('youtube_local_format_selection_failed');
  }

  const formats = [...streamingData.formats, ...streamingData.adaptive_formats];
  if (formats.some((format) => !format || typeof format !== 'object' || Array.isArray(format))) {
    throw new YouTubeLocalSourceError('youtube_local_format_selection_failed');
  }
  return formats.filter((format) => format.has_audio === true);
}

function getSafeYouTubeLocalErrorCode(error, fallbackCode = 'youtube_local_playback_failed') {
  const safeFallback = youtubeLocalErrorCodes.has(fallbackCode)
    ? fallbackCode
    : 'youtube_local_playback_failed';
  const candidate = String(error?.code || '');
  return youtubeLocalErrorCodes.has(candidate) ? candidate : safeFallback;
}

function getYouTubeLocalDiagnostics(error) {
  return youtubeLocalDiagnosticsByError.get(error) || Object.freeze([]);
}

function isYouTubeLocalError(error) {
  return youtubeLocalErrorCodes.has(String(error?.code || ''));
}

class YouTubeLocalSourceError extends Error {
  constructor(code = 'youtube_local_source_failed') {
    super('本機 YouTube 音訊來源目前無法使用。');
    this.name = 'YouTubeLocalSourceError';
    this.code = getSafeYouTubeLocalErrorCode({ code }, 'youtube_local_source_failed');
  }
}

async function runYouTubeLocalStage(operation, fallbackCode) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError(fallbackCode);
  }
}

function extractStrictYouTubeVideoId(input) {
  const value = String(input || '').trim();
  if (youtubeVideoIdPattern.test(value)) return value;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    let videoId = null;

    if (host === 'youtu.be') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 1) videoId = parts[0];
    } else if (host === 'youtube.com' && parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (host === 'youtube.com' && parsed.pathname.startsWith('/shorts/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'shorts') videoId = parts[1];
    }

    return youtubeVideoIdPattern.test(videoId || '') ? videoId : null;
  } catch {
    return null;
  }
}

function createAnonymousFetch({ timeoutMs = youtubeSourceRequestTimeoutMs, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new YouTubeLocalSourceError('youtube_local_fetch_unavailable');
  }

  return async (input, init = {}) => {
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const onUpstreamAbort = () => controller.abort(upstreamSignal.reason);
    const timer = setTimeout(() => controller.abort(new Error('youtube source request timeout')), timeoutMs);

    if (upstreamSignal?.aborted) onUpstreamAbort();
    else upstreamSignal?.addEventListener?.('abort', onUpstreamAbort, { once: true });

    try {
      return await fetchImpl(input, {
        ...init,
        credentials: 'omit',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener?.('abort', onUpstreamAbort);
    }
  };
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new YouTubeLocalSourceError(code)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sanitizeVideoTitle(title) {
  return String(title || 'YouTube 音訊')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/@/g, '＠')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'YouTube 音訊';
}

function isAllowedYouTubeMediaUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'googlevideo.com' || host.endsWith('.googlevideo.com'));
  } catch {
    return false;
  }
}

function getValidatedRangeLength(response, rangeStart, rangeEnd, totalBytes) {
  if (response?.status !== 206 || !response.body?.getReader) {
    throw new YouTubeLocalSourceError('youtube_local_stream_invalid');
  }
  if (response.url && !isAllowedYouTubeMediaUrl(response.url)) {
    throw new YouTubeLocalSourceError('youtube_local_media_host_rejected');
  }

  const contentRange = String(response.headers?.get?.('content-range') || '').trim();
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
  if (!match) throw new YouTubeLocalSourceError('youtube_local_range_invalid');

  const responseStart = Number(match[1]);
  const responseEnd = Number(match[2]);
  const responseTotal = Number(match[3]);
  if (
    !Number.isSafeInteger(responseStart) ||
    !Number.isSafeInteger(responseEnd) ||
    !Number.isSafeInteger(responseTotal) ||
    responseStart !== rangeStart ||
    responseEnd !== rangeEnd ||
    responseTotal !== totalBytes
  ) {
    throw new YouTubeLocalSourceError('youtube_local_range_invalid');
  }

  const expectedBytes = rangeEnd - rangeStart + 1;
  const contentLengthValue = response.headers?.get?.('content-length');
  if (contentLengthValue !== null && contentLengthValue !== undefined) {
    const normalizedContentLength = String(contentLengthValue).trim();
    if (!/^\d+$/.test(normalizedContentLength) || Number(normalizedContentLength) !== expectedBytes) {
      throw new YouTubeLocalSourceError('youtube_local_length_invalid');
    }
  }

  return expectedBytes;
}

function createRangedMediaStream(
  mediaUrl,
  contentLength,
  {
    mediaFetch = createAnonymousFetch(),
    requestTimeoutMs = youtubeSourceRequestTimeoutMs,
    chunkBytes = youtubeMediaChunkBytes,
  } = {}
) {
  const totalBytes = Number(contentLength);
  if (
    !isAllowedYouTubeMediaUrl(mediaUrl) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    totalBytes > youtubeSourceMaxBytes
  ) {
    throw new YouTubeLocalSourceError('youtube_local_media_invalid');
  }

  let offset = 0;
  let cancelled = false;
  let activeAbortController = null;
  let activeReader = null;

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      if (offset >= totalBytes) {
        controller.close();
        return;
      }

      const rangeEnd = Math.min(offset + chunkBytes - 1, totalBytes - 1);
      activeAbortController = new AbortController();

      try {
        const response = await withTimeout(
          mediaFetch(mediaUrl, {
            headers: { Range: `bytes=${offset}-${rangeEnd}` },
            redirect: 'error',
            signal: activeAbortController.signal,
          }),
          requestTimeoutMs,
          'youtube_local_stream_timeout'
        );
        const expectedBytes = getValidatedRangeLength(response, offset, rangeEnd, totalBytes);

        activeReader = response.body.getReader();
        let receivedBytes = 0;
        const chunks = [];
        while (true) {
          const { done, value } = await activeReader.read();
          if (done) break;
          if (cancelled) return;
          if (value?.byteLength) {
            if (
              receivedBytes + value.byteLength > expectedBytes ||
              offset + receivedBytes + value.byteLength > youtubeSourceMaxBytes
            ) {
              throw new YouTubeLocalSourceError('youtube_local_length_invalid');
            }
            receivedBytes += value.byteLength;
            chunks.push(value);
          }
        }
        if (cancelled) return;
        if (receivedBytes !== expectedBytes) {
          throw new YouTubeLocalSourceError(
            receivedBytes <= 0 ? 'youtube_local_stream_empty' : 'youtube_local_length_invalid'
          );
        }

        for (const chunk of chunks) controller.enqueue(chunk);
        offset = rangeEnd + 1;
        if (offset >= totalBytes) controller.close();
      } catch (error) {
        if (cancelled) return;
        activeAbortController?.abort(error);
        try {
          await activeReader?.cancel?.(error);
        } catch {
          // The response may already be closed; the stream still fails closed below.
        }
        controller.error(
          error instanceof YouTubeLocalSourceError
            ? error
            : new YouTubeLocalSourceError('youtube_local_stream_failed')
        );
      } finally {
        activeReader?.releaseLock?.();
        activeReader = null;
        activeAbortController = null;
      }
    },
    async cancel(reason) {
      cancelled = true;
      activeAbortController?.abort(reason);
      try {
        await activeReader?.cancel?.(reason);
      } catch {
        // Cancellation is best effort; the network timeout remains the final bound.
      }
    },
  });
}

async function createAnonymousInnertube({ importYoutubei = () => import('youtubei.js'), fetchImpl } = {}) {
  const module = await withTimeout(importYoutubei(), youtubeSourceRequestTimeoutMs, 'youtube_local_import_timeout');
  const Innertube = module?.Innertube;
  if (!Innertube?.create) throw new YouTubeLocalSourceError('youtube_local_api_unavailable');

  return withTimeout(
    Innertube.create({
      enable_session_cache: false,
      fetch: createAnonymousFetch({ fetchImpl }),
    }),
    youtubeSourceRequestTimeoutMs,
    'youtube_local_session_timeout'
  );
}

async function loadAnonymousYouTubeAudio(
  input,
  {
    clientFactory = createAnonymousInnertube,
    durationEvidence = null,
    mediaFetch = createAnonymousFetch(),
    requestTimeoutMs = youtubeSourceRequestTimeoutMs,
    maxDurationSeconds = youtubeSourceMaxDurationSeconds,
  } = {}
) {
  const videoId = extractStrictYouTubeVideoId(input);
  if (!videoId) throw new YouTubeLocalSourceError('youtube_local_invalid_video');
  const diagnostics = [];

  try {
    const client = await runYouTubeLocalStage(
      () => withTimeout(Promise.resolve().then(() => clientFactory()), requestTimeoutMs, 'youtube_local_session_timeout'),
      'youtube_local_session_failed'
    );
    const durationLimitSeconds =
      Number.isSafeInteger(maxDurationSeconds) &&
      maxDurationSeconds > 0 &&
      maxDurationSeconds <= youtubeSourceMaxDurationSeconds
        ? maxDurationSeconds
        : youtubeSourceMaxDurationSeconds;
    let info;
    let format;
    let durationSeconds;
    let selectedDiagnostic;

    for (const clientName of anonymousYouTubeInfoClients) {
      const diagnostic = {
        client: clientName,
        stage: 'info-request',
        metadataReceived: false,
        identityValid: false,
        nonLive: false,
        durationValid: false,
        streamingDataPresent: false,
        formatCount: null,
        audioFormatCount: null,
        chooseFormatSucceeded: false,
      };
      diagnostics.push(diagnostic);
      const candidateInfo = await runYouTubeLocalStage(
        () => withTimeout(
          Promise.resolve().then(() => client.getBasicInfo(videoId, { client: clientName })),
          requestTimeoutMs,
          'youtube_local_info_timeout'
        ),
        'youtube_local_info_failed'
      );
      diagnostic.metadataReceived = Boolean(candidateInfo && typeof candidateInfo === 'object');
      diagnostic.stage = 'identity';
      validateYouTubeMetadataIdentity(candidateInfo, videoId);
      diagnostic.identityValid = true;
      diagnostic.stage = 'live-check';
      if (candidateInfo?.basic_info?.is_live || candidateInfo?.basic_info?.is_live_content) {
        throw new YouTubeLocalSourceError('youtube_local_live_rejected');
      }
      diagnostic.nonLive = true;

      diagnostic.stage = 'duration';
      const candidateDurationSeconds = resolveYouTubeDurationSeconds(
        candidateInfo,
        durationEvidence,
        videoId,
        durationLimitSeconds
      );
      diagnostic.durationValid = true;
      diagnostic.stage = 'formats';
      const streamingData = candidateInfo?.streaming_data;
      diagnostic.streamingDataPresent = Boolean(
        streamingData && typeof streamingData === 'object' && !Array.isArray(streamingData)
      );
      if (Array.isArray(streamingData?.formats) && Array.isArray(streamingData?.adaptive_formats)) {
        diagnostic.formatCount = streamingData.formats.length + streamingData.adaptive_formats.length;
      }
      const audioCandidates = getValidatedAudioCandidates(candidateInfo);
      diagnostic.audioFormatCount = audioCandidates.length;
      if (audioCandidates.length === 0) {
        diagnostic.stage = 'no-audio';
        continue;
      }

      diagnostic.stage = 'choose-format';
      const candidateFormat = await runYouTubeLocalStage(
        async () => {
          if (typeof candidateInfo?.chooseFormat !== 'function') {
            throw new YouTubeLocalSourceError('youtube_local_format_selection_failed');
          }
          const selected = await candidateInfo.chooseFormat({
            type: 'audio',
            quality: 'best',
            format: 'any',
          });
          if (
            !selected ||
            typeof selected !== 'object' ||
            Array.isArray(selected) ||
            selected.has_audio !== true ||
            !audioCandidates.includes(selected) ||
            typeof selected.decipher !== 'function'
          ) {
            throw new YouTubeLocalSourceError('youtube_local_format_selection_failed');
          }
          return selected;
        },
        'youtube_local_format_selection_failed'
      );
      diagnostic.chooseFormatSucceeded = true;
      diagnostic.stage = 'selected';

      info = candidateInfo;
      format = candidateFormat;
      durationSeconds = candidateDurationSeconds;
      selectedDiagnostic = diagnostic;
      break;
    }

    if (!info || !format || durationSeconds === undefined) {
      throw new YouTubeLocalSourceError('youtube_local_format_selection_failed');
    }
    selectedDiagnostic.stage = 'decipher';
    const mediaUrl = await runYouTubeLocalStage(
      () => withTimeout(
        Promise.resolve().then(() => format.decipher(client.session?.player)),
        requestTimeoutMs,
        'youtube_local_format_timeout'
      ),
      'youtube_local_format_decipher_failed'
    );
    selectedDiagnostic.stage = 'media-validation';
    if (!isAllowedYouTubeMediaUrl(mediaUrl)) {
      throw new YouTubeLocalSourceError('youtube_local_media_host_rejected');
    }

    selectedDiagnostic.stage = 'stream-create';
    const webStream = await runYouTubeLocalStage(
      () => createRangedMediaStream(mediaUrl, format.content_length, {
        mediaFetch,
        requestTimeoutMs,
      }),
      'youtube_local_stream_create_failed'
    );

    return {
      webStream,
      track: {
        title: sanitizeVideoTitle(info?.basic_info?.title),
        duration: durationSeconds,
        source: 'youtube-local',
      },
    };
  } catch (error) {
    const safeError = error instanceof YouTubeLocalSourceError
      ? error
      : new YouTubeLocalSourceError('youtube_local_source_failed');
    youtubeLocalDiagnosticsByError.set(
      safeError,
      Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })))
    );
    throw safeError;
  }
}

module.exports = {
  YouTubeLocalSourceError,
  createAnonymousFetch,
  createAnonymousInnertube,
  createRangedMediaStream,
  createTrustedYouTubeDurationEvidence,
  extractStrictYouTubeVideoId,
  getSafeYouTubeLocalErrorCode,
  getYouTubeLocalDiagnostics,
  getValidatedRangeLength,
  isAllowedYouTubeMediaUrl,
  isYouTubeLocalError,
  loadAnonymousYouTubeAudio,
  normalizeDurationSeconds,
  sanitizeVideoTitle,
  youtubeSourceMaxDurationSeconds,
  youtubeMediaChunkBytes,
  youtubeSourceMaxBytes,
  youtubeSourceRequestTimeoutMs,
};
