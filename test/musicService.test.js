const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const {
  buildFfmpegTestToneArgs,
  buildLocalYouTubeFallbackOptions,
  buildLavalinkTrackUserData,
  buildTrustedLavalinkDurationEvidence,
  cleanupFailedSoundCloudFallbackPlayer,
  createPlaybackConfirmationError,
  evaluateSoundCloudCandidate,
  extractCanonicalTrackIdentity,
  extractCanonicalTrackIdentityCandidates,
  formatMusicPlaybackReply,
  getMusicErrorLayer,
  getMusicUserFacingError,
  getTrustedSoundCloudFallbackSeed,
  getGuildPlaybackOperationCount,
  getVoiceStayPolicy,
  handleBotVoiceStateUpdate,
  handleVoiceChannelDeleted,
  isYouTubeUrl,
  musicIdleLeaveMs,
  normalizeLavalinkLoadResult,
  normalizeTrackAuthor,
  normalizeTrackTitle,
  playSoundCloudSameTrackFallback,
  resolveLavalinkSearch,
  resolveSoundCloudSearch,
  runExclusiveGuildPlaybackOperation,
  selectUniqueSoundCloudSameTrack,
  soundCloudDurationToleranceMs,
  shouldScheduleIdleDisconnect,
  validateVoiceChannelForPlayback,
} = require('../src/services/musicService');
const logger = require('../src/utils/logger');
const {
  cancelLavalinkPlaybackConfirmation,
  getPendingPlaybackConfirmationCount,
  getLavalinkStatus,
  getNodeConfiguration,
  initializeLavalink,
  recordPlaybackEvent,
  waitForLavalinkPlaybackConfirmation,
} = require('../src/services/lavalinkService');
const musicCommand = require('../src/commands/music');
const { assertSafeYoutubeCredentialPolicy } = require('../scripts/check-project');
const { formatLavalinkStatus, formatQueue } = musicCommand;

test('isYouTubeUrl validates common YouTube video URLs', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=2'), true);
  assert.equal(isYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(isYouTubeUrl('https://youtube.com/playlist?list=abc'), false);
});

test('Lavalink 4.2.2 player update uses object track userData with request identity', () => {
  const requester = buildLavalinkTrackUserData('844163435037720597', 'request-1');
  const playerUpdatePayload = {
    track: {
      encoded: 'test-encoded-track',
      userData: requester,
    },
    replaceCurrent: true,
  };

  assert.deepEqual(playerUpdatePayload.track.userData, {
    requesterId: '844163435037720597',
    playbackRequestId: 'request-1',
  });
  assert.equal(typeof playerUpdatePayload.track.userData, 'object');
  assert.equal(Array.isArray(playerUpdatePayload.track.userData), false);
  assert.match(JSON.stringify(playerUpdatePayload), /"playbackRequestId":"request-1"/);
  assert.throws(
    () => buildLavalinkTrackUserData(null),
    (error) => error.code === 'lavalink_requester_invalid'
  );
});

test('Lavalink uses only pinned LavaSrc yt-dlp for anonymous YouTube loading', () => {
  const application = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'lavalink', 'application.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'lavalink', 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'lavalink', 'compose.yml'), 'utf8');

  assert.match(application, /com\.github\.topi314\.lavasrc:lavasrc-plugin:4\.8\.3/);
  assert.match(application, /^\s{6}ytdlp:\s+true\s*$/m);
  assert.match(application, /^\s{6}youtube:\s+false\s*$/m);
  assert.match(application, /^\s{6}path:\s+"\/usr\/local\/bin\/yt-dlp"\s*$/m);
  assert.doesNotMatch(application, /dev\.lavalink\.youtube:youtube-plugin|^\s{2}youtube:\s*$/m);
  assert.doesNotThrow(() => assertSafeYoutubeCredentialPolicy(application));
  assert.match(application, /^\s{6}soundcloud:\s+true\s*$/m);
  assert.match(dockerfile, /YTDLP_VERSION=2026\.07\.04/);
  assert.match(dockerfile, /YTDLP_SHA256=495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd/);
  assert.match(dockerfile, /DENO_VERSION=2\.9\.5/);
  assert.match(dockerfile, /DENO_SHA256=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530/);
  assert.doesNotMatch(dockerfile, /releases\/latest/);
  assert.match(compose, /curl --fail --silent --show-error/);
  assert.doesNotMatch(compose, /wget\s/);
});

test('unknown music errors are replaced with a bounded public message', () => {
  const internalDetail = `private-upstream-body-${'x'.repeat(10_000)}`;
  const reply = getMusicUserFacingError(new Error(internalDetail));

  assert.equal(reply, '音樂服務暫時無法完成這次操作，請稍後再試。');
  assert.ok(reply.length < 2_000);
  assert.doesNotMatch(reply, /private-upstream-body/);
});

test('TrackStart followed by an early TrackException is not confirmed as playback', async () => {
  const guildId = 'guild-early-exception';
  const identity = { requestId: 'request-early-exception', encodedTrack: 'encoded-early-exception' };
  const outcomePromise = waitForLavalinkPlaybackConfirmation(guildId, { ...identity, timeoutMs: 1000 });

  recordPlaybackEvent(guildId, 'TrackStartEvent', { trackEventType: 'TrackStartEvent', ...identity });
  recordPlaybackEvent(guildId, 'TrackExceptionEvent', {
    trackEventType: 'TrackExceptionEvent',
    errorMessage: 'synthetic sign-in challenge',
  });

  const outcome = await outcomePromise;
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.eventType, 'TrackExceptionEvent');
  assert.equal(outcome.encodedTrack, identity.encodedTrack);
});

test('TrackStart alone is insufficient until player position advances', async () => {
  const guildId = 'guild-sustained-playback';
  const identity = { requestId: 'request-sustained', encodedTrack: 'encoded-sustained' };
  const outcomePromise = waitForLavalinkPlaybackConfirmation(guildId, { ...identity, timeoutMs: 1000 });

  recordPlaybackEvent(guildId, 'TrackStartEvent', { trackEventType: 'TrackStartEvent', position: 0, ...identity });
  recordPlaybackEvent(guildId, 'playerUpdate', { position: 0 });
  recordPlaybackEvent(guildId, 'playerUpdate', { position: 1500 });

  const outcome = await outcomePromise;
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.failed, false);
  assert.equal(outcome.eventType, 'playerUpdate');
  assert.equal(outcome.position, 1500);
});

test('player position without a TrackStart does not confirm unrelated playback', async () => {
  const guildId = 'guild-no-track-start';
  const keepTestProcessAlive = setTimeout(() => {}, 100);
  const outcomePromise = waitForLavalinkPlaybackConfirmation(guildId, {
    requestId: 'request-no-start',
    encodedTrack: 'encoded-no-start',
    timeoutMs: 20,
  });

  recordPlaybackEvent(guildId, 'playerUpdate', { position: 5000 });

  const outcome = await outcomePromise.finally(() => clearTimeout(keepTestProcessAlive));
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.failed, false);
  assert.equal(outcome.sawStart, false);
});

test('cancelled play requests release their pending playback confirmation', async () => {
  const guildId = 'guild-cancelled-play';
  const requestId = 'request-cancelled';
  const outcomePromise = waitForLavalinkPlaybackConfirmation(guildId, {
    requestId,
    encodedTrack: 'encoded-cancelled',
    timeoutMs: 1000,
  });

  cancelLavalinkPlaybackConfirmation(guildId, requestId);

  const outcome = await outcomePromise;
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.eventType, 'cancelled');
  assert.equal(getPendingPlaybackConfirmationCount(guildId), 0);
});

test('a concurrent same-guild play supersedes the first request without double success', async () => {
  const guildId = 'guild-concurrent-replace';
  const firstIdentity = { requestId: 'request-first', encodedTrack: 'encoded-first' };
  const secondIdentity = { requestId: 'request-second', encodedTrack: 'encoded-second' };
  const firstOutcomePromise = waitForLavalinkPlaybackConfirmation(guildId, {
    ...firstIdentity,
    timeoutMs: 1000,
  });
  const secondOutcomePromise = waitForLavalinkPlaybackConfirmation(guildId, {
    ...secondIdentity,
    timeoutMs: 1000,
  });

  const firstOutcome = await firstOutcomePromise;
  assert.equal(firstOutcome.confirmed, false);
  assert.equal(firstOutcome.failed, true);
  assert.equal(firstOutcome.eventType, 'superseded');

  recordPlaybackEvent(guildId, 'TrackStartEvent', { ...firstIdentity, position: 0 });
  recordPlaybackEvent(guildId, 'playerUpdate', { position: 5000 });
  assert.equal(getPendingPlaybackConfirmationCount(guildId), 1);

  recordPlaybackEvent(guildId, 'TrackStartEvent', { ...secondIdentity, position: 0 });
  recordPlaybackEvent(guildId, 'playerUpdate', { position: 1500 });

  const secondOutcome = await secondOutcomePromise;
  assert.equal(secondOutcome.confirmed, true);
  assert.equal(secondOutcome.failed, false);
  assert.equal(secondOutcome.requestId, secondIdentity.requestId);
  assert.equal(secondOutcome.encodedTrack, secondIdentity.encodedTrack);
  assert.equal(getPendingPlaybackConfirmationCount(guildId), 0);
});

test('same-guild playback operations are serialized and release their mutex', async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = runExclusiveGuildPlaybackOperation('guild-serialized', async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
    return 'first';
  });
  const second = runExclusiveGuildPlaybackOperation('guild-serialized', async () => {
    order.push('second-start');
    return 'second';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  assert.equal(getGuildPlaybackOperationCount(), 1);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
  assert.equal(getGuildPlaybackOperationCount(), 0);
});

test('failure events settle only the matching active playback request', async () => {
  const guildId = 'guild-matching-failure';
  const activeIdentity = { requestId: 'request-active', encodedTrack: 'encoded-active' };
  const unrelatedIdentity = { requestId: 'request-unrelated', encodedTrack: 'encoded-unrelated' };
  const outcomePromise = waitForLavalinkPlaybackConfirmation(guildId, {
    ...activeIdentity,
    timeoutMs: 1000,
  });

  recordPlaybackEvent(guildId, 'TrackStartEvent', { ...activeIdentity, position: 0 });
  recordPlaybackEvent(guildId, 'TrackEndEvent', unrelatedIdentity);
  assert.equal(getPendingPlaybackConfirmationCount(guildId), 1);

  recordPlaybackEvent(guildId, 'TrackExceptionEvent', { errorMessage: 'synthetic current-track exception' });
  const outcome = await outcomePromise;
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.eventType, 'TrackExceptionEvent');
  assert.equal(outcome.requestId, activeIdentity.requestId);
  assert.equal(outcome.encodedTrack, activeIdentity.encodedTrack);
  assert.equal(getPendingPlaybackConfirmationCount(guildId), 0);
});

test('a matching TrackEnd fails and cleans its playback waiter', async () => {
  const guildId = 'guild-matching-end';
  const identity = { requestId: 'request-ended', encodedTrack: 'encoded-ended' };
  const outcomePromise = waitForLavalinkPlaybackConfirmation(guildId, { ...identity, timeoutMs: 1000 });

  recordPlaybackEvent(guildId, 'TrackStartEvent', { ...identity, position: 0 });
  recordPlaybackEvent(guildId, 'TrackEndEvent', identity);

  const outcome = await outcomePromise;
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.failed, true);
  assert.equal(outcome.eventType, 'TrackEndEvent');
  assert.equal(outcome.encodedTrack, identity.encodedTrack);
  assert.equal(getPendingPlaybackConfirmationCount(guildId), 0);
});

function createSyntheticResolvedYouTubeTrack(overrides = {}) {
  return {
    sourceName: 'youtube',
    identifier: 'dQw4w9WgXcQ',
    uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    isStream: false,
    length: 273_000,
    track: 'encoded-duration-track',
    title: 'Synthetic Artist - Synthetic Track',
    author: 'Synthetic Artist - Topic',
    requester: { requesterId: 'user-1', playbackRequestId: 'request-duration' },
    ...overrides,
  };
}

function createTrustedSoundCloudFallbackError(trackOverrides = {}, outcomeOverrides = {}) {
  const input = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const identity = { requestId: 'request-duration', encodedTrack: 'encoded-duration-track' };
  return createPlaybackConfirmationError(
    input,
    createSyntheticResolvedYouTubeTrack(trackOverrides),
    identity,
    { failed: true, eventType: 'TrackExceptionEvent', ...identity, ...outcomeOverrides }
  );
}

function createSyntheticSoundCloudTrack(overrides = {}) {
  return {
    sourceName: 'soundcloud',
    track: 'encoded-soundcloud-track',
    identifier: 'soundcloud-track-id',
    uri: 'https://soundcloud.com/synthetic/track',
    isStream: false,
    length: 273_900,
    title: 'Synthetic Track',
    author: 'Synthetic Artist',
    ...overrides,
  };
}

test('trusted duration evidence requires the exact resolved YouTube track and playback identity', () => {
  const input = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const identity = { requestId: 'request-duration', encodedTrack: 'encoded-duration-track' };
  const outcome = { failed: true, ...identity };
  const track = createSyntheticResolvedYouTubeTrack();
  const evidence = buildTrustedLavalinkDurationEvidence(input, track, identity, outcome);

  assert.ok(Object.isFrozen(evidence));
  assert.deepEqual(evidence, {
    videoId: 'dQw4w9WgXcQ',
    sourceName: 'youtube',
    identifier: 'dQw4w9WgXcQ',
    uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    isStream: false,
    requestId: 'request-duration',
    encodedTrack: 'encoded-duration-track',
    durationMs: 273_000,
  });

  const invalidTracks = [
    { identifier: 'aaaaaaaaaaa' },
    { uri: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
    { uri: null },
    { sourceName: 'soundcloud' },
    { isStream: true },
    { length: '273000' },
    { length: 0 },
    { length: -1 },
    { length: 1.5 },
    { length: Number.NaN },
    { length: Number.POSITIVE_INFINITY },
  ];
  for (const overrides of invalidTracks) {
    assert.equal(
      buildTrustedLavalinkDurationEvidence(
        input,
        createSyntheticResolvedYouTubeTrack(overrides),
        identity,
        outcome
      ),
      null
    );
  }

  assert.equal(
    buildTrustedLavalinkDurationEvidence(input, track, identity, {
      failed: true,
      requestId: identity.requestId,
      encodedTrack: 'another-track',
    }),
    null
  );
  assert.equal(buildTrustedLavalinkDurationEvidence(input, track, identity, { ...outcome, failed: false }), null);
});

test('SoundCloud fallback seed is internal, frozen, and cannot be injected by callers', () => {
  const injected = new Error('synthetic caller error');
  injected.soundCloudFallbackSeed = createSyntheticResolvedYouTubeTrack();
  assert.equal(getTrustedSoundCloudFallbackSeed(injected), null);

  const trustedError = createTrustedSoundCloudFallbackError();
  const seed = getTrustedSoundCloudFallbackSeed(trustedError);
  assert.ok(Object.isFrozen(seed));
  assert.equal(seed.videoId, 'dQw4w9WgXcQ');
  assert.equal(seed.sourceName, 'youtube');
  assert.equal(seed.requesterId, 'user-1');
  assert.equal(seed.title, 'Synthetic Artist - Synthetic Track');
  assert.equal(seed.author, 'Synthetic Artist - Topic');
  assert.equal(seed.canonicalArtist, 'Synthetic Artist');
  assert.equal(seed.canonicalTitle, 'Synthetic Track');
  assert.ok(Object.isFrozen(seed.identityCandidates));
  assert.deepEqual(seed.identityCandidates.map(({ direction, artist, track }) => ({ direction, artist, track })), [
    { direction: 'artist-track', artist: 'Synthetic Artist', track: 'Synthetic Track' },
    { direction: 'track-artist', artist: 'Synthetic Track', track: 'Synthetic Artist' },
  ]);

  for (const overrides of [
    { title: '' },
    { title: 'Synthetic Track' },
    { title: 'Synthetic Artist - Synthetic Track - Remix' },
    { author: '' },
    { requester: { requesterId: '', playbackRequestId: 'request-duration' } },
    { requester: { requesterId: 'user-1', playbackRequestId: 'another-request' } },
    { sourceName: 'soundcloud' },
    { isStream: true },
  ]) {
    assert.equal(getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError(overrides)), null);
  }

  const noCanonicalIdentity = createTrustedSoundCloudFallbackError({ title: 'Synthetic Track' });
  assert.equal(getTrustedSoundCloudFallbackSeed(noCanonicalIdentity), null);
  assert.equal(buildLocalYouTubeFallbackOptions(noCanonicalIdentity, {}).durationEvidence.durationMs, 273_000);
});

test('same-track normalization handles Unicode width and punctuation without weakening identity', () => {
  assert.equal(
    normalizeTrackTitle('Ｓｙｎｔｈｅｔｉｃ—Ｔｒａｃｋ【Official Music Video】'),
    normalizeTrackTitle('synthetic track')
  );
  assert.equal(
    normalizeTrackAuthor('Ｓｙｎｔｈｅｔｉｃ　Ａｒｔｉｓｔ - Topic'),
    normalizeTrackAuthor('synthetic artist')
  );
  assert.notEqual(normalizeTrackTitle('Synthetic Track Two'), normalizeTrackTitle('Synthetic Track'));
});

test('SoundCloud title normalization strips only exact allowlisted bracketed release tags', () => {
  const seed = getTrustedSoundCloudFallbackSeed(
    createTrustedSoundCloudFallbackError({
      title: 'NEFFEX - Fight Back',
      author: 'xKito Music',
      length: 200_000,
    })
  );

  for (const title of [
    'Fight Back 👊 🔥 [Copyright Free]',
    'Fight Back [Copyright-Free]',
    'Fight Back [NCS Release]',
  ]) {
    const candidate = createSyntheticSoundCloudTrack({ title, author: 'NEFFEX', length: 200_000 });
    assert.equal(selectUniqueSoundCloudSameTrack(seed, [candidate]).track, candidate);
  }

  for (const bracketedText of [
    'Remix',
    'Live',
    'Cover',
    'feat Guest',
    'Extended Mix',
    'Random Label',
  ]) {
    const candidate = createSyntheticSoundCloudTrack({
      title: `Fight Back [${bracketedText}]`,
      author: 'NEFFEX',
      length: 200_000,
    });
    assert.equal(selectUniqueSoundCloudSameTrack(seed, [candidate]).code, 'soundcloud_fallback_no_match');
  }

  assert.equal(normalizeTrackTitle('Fight Back [Random Label]'), 'fight back random label');
});

test('canonical identity requires exactly one non-empty Artist - Track delimiter', () => {
  assert.deepEqual(extractCanonicalTrackIdentity('ＮＥＦＦＥＸ — Fight Back'), {
    artist: 'NEFFEX',
    track: 'Fight Back',
    normalizedArtist: 'neffex',
    normalizedTrack: 'fight back',
  });
  for (const title of [
    'Fight Back',
    'NEFFEX - Fight Back - Remix',
    ' - Fight Back',
    'NEFFEX - ',
    'NEFFEX--Fight Back',
  ]) {
    assert.equal(extractCanonicalTrackIdentity(title), null);
  }
});

test('trusted YouTube title yields only two finite directions and strips allowlisted presentation suffixes', () => {
  for (const title of [
    'Synthetic Song-Synthetic Singer 歌詞字幕版',
    'Synthetic Song - Synthetic Singer Lyrics Video',
    'Synthetic Song - Synthetic Singer [Lyrics Video]',
  ]) {
    assert.deepEqual(
      extractCanonicalTrackIdentityCandidates(title).map(({ direction, artist, track }) => ({ direction, artist, track })),
      [
        { direction: 'artist-track', artist: 'Synthetic Song', track: 'Synthetic Singer' },
        { direction: 'track-artist', artist: 'Synthetic Singer', track: 'Synthetic Song' },
      ]
    );
  }

  for (const version of ['Remix', 'Live', 'Cover', 'feat Guest']) {
    const candidates = extractCanonicalTrackIdentityCandidates(`Synthetic Song - Synthetic Singer ${version}`);
    assert.match(candidates[0].track, new RegExp(version, 'i'));
    assert.match(candidates[1].artist, new RegExp(version, 'i'));
  }
});

test('Track - Artist direction can match while cross-direction ties remain fail closed', () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError({
    title: 'Synthetic Song-Synthetic Singer 歌詞字幕版',
    author: 'Synthetic Upload Channel',
    length: 228_000,
  }));
  const [artistTrack, trackArtist] = seed.identityCandidates;
  const correct = createSyntheticSoundCloudTrack({
    track: 'encoded-track-artist',
    title: 'Synthetic Song',
    author: 'Synthetic Singer',
    length: 228_500,
  });
  assert.equal(selectUniqueSoundCloudSameTrack(seed, {
    searches: [
      { identity: artistTrack, tracks: [] },
      { identity: trackArtist, tracks: [correct] },
    ],
  }).track, correct);

  const reverseMatch = createSyntheticSoundCloudTrack({
    track: 'encoded-reverse-direction',
    title: 'Synthetic Singer',
    author: 'Synthetic Song',
    length: 227_500,
  });
  assert.equal(selectUniqueSoundCloudSameTrack(seed, {
    searches: [
      { identity: artistTrack, tracks: [reverseMatch] },
      { identity: trackArtist, tracks: [correct] },
    ],
  }).code, 'soundcloud_fallback_ambiguous');

  for (const candidate of [
    createSyntheticSoundCloudTrack({ title: 'Synthetic Song Remix', author: 'Synthetic Singer', length: 228_000 }),
    createSyntheticSoundCloudTrack({ title: 'Synthetic Song Live', author: 'Synthetic Singer', length: 228_000 }),
    createSyntheticSoundCloudTrack({ title: 'Synthetic Song Cover', author: 'Synthetic Singer', length: 228_000 }),
  ]) {
    assert.equal(selectUniqueSoundCloudSameTrack(seed, {
      searches: [{ identity: trackArtist, tracks: [candidate] }],
    }).code, 'soundcloud_fallback_no_match');
  }
});

test('canonical title artist overrides YouTube uploader without weakening candidate identity', () => {
  const seed = getTrustedSoundCloudFallbackSeed(
    createTrustedSoundCloudFallbackError({
      title: 'NEFFEX - Fight Back',
      author: 'xKito Music',
      length: 194_000,
    })
  );
  assert.ok(seed);
  assert.equal(seed.author, 'xKito Music');
  assert.equal(seed.canonicalArtist, 'NEFFEX');
  assert.equal(seed.canonicalTitle, 'Fight Back');

  const titleIdentity = createSyntheticSoundCloudTrack({
    title: 'NEFFEX - Fight Back',
    author: 'Different SoundCloud Uploader',
    length: 194_900,
  });
  const titleAndAuthor = createSyntheticSoundCloudTrack({
    title: 'Fight Back',
    author: 'NEFFEX',
    length: 194_900,
  });
  assert.equal(selectUniqueSoundCloudSameTrack(seed, [titleIdentity]).track, titleIdentity);
  assert.equal(selectUniqueSoundCloudSameTrack(seed, [titleAndAuthor]).track, titleAndAuthor);

  for (const candidate of [
    createSyntheticSoundCloudTrack({ title: 'WRONG - Fight Back', author: 'NEFFEX', length: 194_900 }),
    createSyntheticSoundCloudTrack({ title: 'NEFFEX - Wrong Track', author: 'NEFFEX', length: 194_900 }),
    createSyntheticSoundCloudTrack({ title: 'Fight Back', author: 'xKito Music', length: 194_900 }),
    createSyntheticSoundCloudTrack({ title: 'NEFFEX feat Guest - Fight Back', author: 'NEFFEX', length: 194_900 }),
    createSyntheticSoundCloudTrack({ title: 'NEFFEX - Fight Back - Remix', author: 'NEFFEX', length: 194_900 }),
  ]) {
    assert.equal(selectUniqueSoundCloudSameTrack(seed, [candidate]).code, 'soundcloud_fallback_no_match');
  }
});

test('SoundCloud same-track selection accepts one strict match and rejects unsafe candidates', () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const exact = createSyntheticSoundCloudTrack();
  assert.equal(selectUniqueSoundCloudSameTrack(seed, [exact]).track, exact);
  assert.equal(soundCloudDurationToleranceMs, 2_000);

  const rejected = [
    createSyntheticSoundCloudTrack({ length: seed.durationMs + soundCloudDurationToleranceMs + 1 }),
    createSyntheticSoundCloudTrack({ title: 'Wrong Song' }),
    createSyntheticSoundCloudTrack({ author: 'Wrong Artist' }),
    createSyntheticSoundCloudTrack({ sourceName: 'youtube' }),
    createSyntheticSoundCloudTrack({ isStream: true }),
    createSyntheticSoundCloudTrack({ track: '' }),
    createSyntheticSoundCloudTrack({ length: 0 }),
  ];
  for (const candidate of rejected) {
    assert.equal(selectUniqueSoundCloudSameTrack(seed, [candidate]).code, 'soundcloud_fallback_no_match');
  }
  for (const marker of [
    'Live',
    'Remix',
    'Cover',
    'Acoustic',
    'Instrumental',
    'Karaoke',
    'Nightcore',
    'Sped Up',
    'Slowed',
    'Reverb',
  ]) {
    assert.equal(
      selectUniqueSoundCloudSameTrack(seed, [createSyntheticSoundCloudTrack({ title: `Synthetic Track ${marker}` })]).code,
      'soundcloud_fallback_no_match'
    );
  }

  const acousticSeed = getTrustedSoundCloudFallbackSeed(
    createTrustedSoundCloudFallbackError({ title: 'Synthetic Artist - Synthetic Track (Acoustic)' })
  );
  assert.ok(
    selectUniqueSoundCloudSameTrack(acousticSeed, [
      createSyntheticSoundCloudTrack({ title: 'Synthetic Track Acoustic' }),
    ]).track
  );

  assert.equal(
    selectUniqueSoundCloudSameTrack(seed, [exact, createSyntheticSoundCloudTrack({ track: 'encoded-second' })]).code,
    'soundcloud_fallback_ambiguous'
  );
});

test('SoundCloud ambiguous selection accepts only one uniquely closest duration match', () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const closest = createSyntheticSoundCloudTrack({
    track: 'encoded-closest',
    length: seed.durationMs + 250,
  });
  const farther = createSyntheticSoundCloudTrack({
    track: 'encoded-farther',
    length: seed.durationMs + 1_200,
  });
  const result = selectUniqueSoundCloudSameTrack(seed, [
    createSyntheticSoundCloudTrack({ track: 'encoded-remix', title: 'Synthetic Track Remix' }),
    createSyntheticSoundCloudTrack({ track: 'encoded-live', isStream: true }),
    createSyntheticSoundCloudTrack({ track: 'encoded-cover', title: 'Synthetic Track Cover' }),
    farther,
    closest,
  ]);

  assert.equal(result.track, closest);
  assert.equal(result.code, null);
});

test('SoundCloud ambiguous selection fails closed when the minimum duration delta is tied', () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const earlier = createSyntheticSoundCloudTrack({
    track: 'encoded-earlier-sensitive',
    length: seed.durationMs - 500,
  });
  const later = createSyntheticSoundCloudTrack({
    track: 'encoded-later-sensitive',
    length: seed.durationMs + 500,
  });
  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => warnings.push(message);

  try {
    assert.deepEqual(
      selectUniqueSoundCloudSameTrack(seed, [earlier, later], { guildId: 'guild/tied' }),
      { track: null, code: 'soundcloud_fallback_ambiguous' }
    );
  } finally {
    logger.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"matchingCandidateCount":2/);
  assert.doesNotMatch(warnings[0], /encoded-earlier-sensitive|encoded-later-sensitive/);
});

test('SoundCloud candidate evaluation exposes every rejection flag without changing matcher decisions', () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const exact = createSyntheticSoundCloudTrack();
  assert.deepEqual(evaluateSoundCloudCandidate(seed, exact), {
    sourceIsSoundCloud: true,
    encodedPresent: true,
    isNonLive: true,
    durationDeltaMs: 900,
    durationWithinTolerance: true,
    titleMode: 'title-author',
    titleMatch: true,
    authorMatch: true,
    versionMatch: true,
    isMatch: true,
  });
  assert.ok(Object.isFrozen(evaluateSoundCloudCandidate(seed, exact)));

  const rejected = [
    [createSyntheticSoundCloudTrack({ sourceName: 'youtube' }), 'sourceIsSoundCloud'],
    [createSyntheticSoundCloudTrack({ track: '' }), 'encodedPresent'],
    [createSyntheticSoundCloudTrack({ isStream: true }), 'isNonLive'],
    [createSyntheticSoundCloudTrack({ length: seed.durationMs + soundCloudDurationToleranceMs + 1 }), 'durationWithinTolerance'],
    [createSyntheticSoundCloudTrack({ title: 'Synthetic Artist - Wrong Track' }), 'titleMatch'],
    [createSyntheticSoundCloudTrack({ title: 'Synthetic Track', author: 'Wrong Artist' }), 'authorMatch'],
    [createSyntheticSoundCloudTrack({ title: 'Synthetic Track Remix' }), 'versionMatch'],
  ];
  for (const [candidate, rejectedFlag] of rejected) {
    const evaluation = evaluateSoundCloudCandidate(seed, candidate);
    assert.equal(evaluation[rejectedFlag], false, rejectedFlag);
    assert.equal(evaluation.isMatch, false);
    assert.equal(selectUniqueSoundCloudSameTrack(seed, [candidate]).track, null);
  }

  const invalidDuration = evaluateSoundCloudCandidate(seed, createSyntheticSoundCloudTrack({ length: '273900' }));
  assert.equal(invalidDuration.durationDeltaMs, null);
  assert.equal(invalidDuration.durationWithinTolerance, false);
  const noIdentity = evaluateSoundCloudCandidate(seed, createSyntheticSoundCloudTrack({ title: '', author: '' }));
  assert.equal(noIdentity.titleMode, 'none');
  assert.equal(noIdentity.titleMatch, false);
  assert.equal(noIdentity.authorMatch, false);
  assert.equal(noIdentity.versionMatch, false);
});

test('SoundCloud zero and ambiguous diagnostics are bounded, structured, and metadata-safe', () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => warnings.push(message);

  try {
    const unsafeTracks = Array.from({ length: 7 }, (_value, index) => createSyntheticSoundCloudTrack({
      track: `encoded-sensitive-${index}`,
      identifier: `identifier-sensitive-${index}`,
      uri: `https://private.example/secret-sensitive-${index}`,
      title: `Raw Title Secret ${index}`,
      author: `Raw Author Secret ${index}`,
      query: `query-sensitive-${index}`,
      requester: { requesterId: `requester-sensitive-${index}` },
    }));
    assert.equal(
      selectUniqueSoundCloudSameTrack(seed, unsafeTracks, { guildId: 'guild/unsafe value' }).code,
      'soundcloud_fallback_no_match'
    );

    const firstMatch = createSyntheticSoundCloudTrack({ track: 'encoded-first-secret' });
    const secondMatch = createSyntheticSoundCloudTrack({ track: 'encoded-second-secret' });
    assert.equal(
      selectUniqueSoundCloudSameTrack(seed, [firstMatch, secondMatch], { guildId: 'guild/ambiguous' }).code,
      'soundcloud_fallback_ambiguous'
    );
  } finally {
    logger.warn = originalWarn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^\[Music\] SoundCloud same-track zero-match diagnostics: /);
  const zeroPayload = JSON.parse(warnings[0].slice(warnings[0].indexOf('{')));
  assert.equal(zeroPayload.guildId, 'guildunsafevalue');
  assert.equal(zeroPayload.candidateCount, 7);
  assert.equal(zeroPayload.candidates.length, 5);
  assert.deepEqual(zeroPayload.candidates.map((candidate) => candidate.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(zeroPayload.candidates[0]), [
    'rank',
    'sourceIsSoundCloud',
    'encodedPresent',
    'isNonLive',
    'durationDeltaMs',
    'durationWithinTolerance',
    'titleMode',
    'titleMatch',
    'authorMatch',
    'versionMatch',
  ]);

  assert.match(warnings[1], /^\[Music\] SoundCloud same-track ambiguous diagnostics: /);
  const ambiguousPayload = JSON.parse(warnings[1].slice(warnings[1].indexOf('{')));
  assert.deepEqual(ambiguousPayload, {
    guildId: 'guildambiguous',
    candidateCount: 2,
    matchingCandidateCount: 2,
  });
  assert.doesNotMatch(
    warnings.join('\n'),
    /Raw Title|Raw Author|https?:|encoded-sensitive|encoded-first-secret|encoded-second-secret|identifier-sensitive|query-sensitive|requester-sensitive|secret-sensitive/i
  );
});

test('SoundCloud search uses finite trusted query variants for both directions', async () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const identifiers = [];
  const result = await resolveSoundCloudSearch(
    {
      getLeastUsedNode: async () => ({
        rest: {
          resolve: async (value) => {
            identifiers.push(value);
            return { loadType: 'empty', data: {} };
          },
        },
      }),
    },
    seed,
    { requesterId: 'user-1' }
  );
  assert.deepEqual(identifiers, [
    'scsearch:Synthetic Artist - Synthetic Track',
    'scsearch:Synthetic Track Synthetic Artist',
    'scsearch:Synthetic Track - Synthetic Artist',
    'scsearch:Synthetic Artist Synthetic Track',
  ]);
  assert.deepEqual(result.tracks, []);
  assert.deepEqual(result.searches.map(({ identity, tracks }) => ({ direction: identity.direction, tracks })), [
    { direction: 'artist-track', tracks: [] },
    { direction: 'track-artist', tracks: [] },
  ]);
});

test('SoundCloud query variants stay bounded and an alternate query still passes the strict matcher', async () => {
  const seed = getTrustedSoundCloudFallbackSeed(createTrustedSoundCloudFallbackError());
  const rawTrack = (encoded, title = 'Wrong Track', author = 'Wrong Artist') => ({
    encoded,
    info: {
      identifier: `synthetic-${encoded}`,
      isSeekable: true,
      author,
      length: 273_000,
      isStream: false,
      position: 0,
      title,
      uri: 'https://soundcloud.com/synthetic/fixture',
      artworkUrl: null,
      isrc: null,
      sourceName: 'soundcloud',
    },
    pluginInfo: {},
    userData: {},
  });
  let call = 0;
  const result = await resolveSoundCloudSearch(
    {
      getLeastUsedNode: async () => ({
        rest: {
          resolve: async () => {
            call += 1;
            if (call === 1) {
              return {
                loadType: 'search',
                data: Array.from({ length: 12 }, (_, index) => rawTrack(`wrong-${index}`)),
              };
            }
            if (call === 2) {
              return {
                loadType: 'search',
                data: [
                  rawTrack('strict-match', 'Synthetic Track', 'Synthetic Artist'),
                  rawTrack('strict-match', 'Synthetic Track', 'Synthetic Artist'),
                ],
              };
            }
            return { loadType: 'empty', data: {} };
          },
        },
      }),
    },
    seed,
    { requesterId: 'user-1' }
  );

  assert.equal(call, 4);
  assert.equal(result.searches[0].tracks.length, 11);
  assert.equal(result.searches[0].tracks.filter((track) => track.track === 'strict-match').length, 1);
  assert.equal(selectUniqueSoundCloudSameTrack(seed, result).track.track, 'strict-match');
});

test('slash music search keeps public single-video URLs intact and prefixes keyword queries', async () => {
  const identifiers = [];
  const kazagumo = {
    getLeastUsedNode: async () => ({
      rest: {
        resolve: async (identifier) => {
          identifiers.push(identifier);
          return { loadType: 'empty', data: {} };
        },
      },
    }),
  };
  const syntheticId = 'AbCdEfGhI12';
  for (const input of [
    `https://www.youtube.com/watch?v=${syntheticId}`,
    `https://youtu.be/${syntheticId}?feature=shared`,
    `https://youtube.com/shorts/${syntheticId}?feature=share`,
    'synthetic artist synthetic song',
  ]) {
    await resolveLavalinkSearch(kazagumo, input, { requesterId: 'user-1' });
  }
  assert.deepEqual(identifiers, [
    `https://www.youtube.com/watch?v=${syntheticId}`,
    `https://youtu.be/${syntheticId}?feature=shared`,
    `https://youtube.com/shorts/${syntheticId}?feature=share`,
    'ytsearch:synthetic artist synthetic song',
  ]);
  assert.equal(isYouTubeUrl(`https://www.youtube.com/watch?v=${syntheticId}&list=PLsynthetic`), false);
  assert.equal(isYouTubeUrl(`https://youtu.be/${syntheticId}?list=PLsynthetic`), false);
  assert.equal(isYouTubeUrl(`https://youtube.com/shorts/${syntheticId}?list=PLsynthetic`), false);
  assert.equal(isYouTubeUrl('https://www.youtube.com/playlist?list=PLsynthetic'), false);
});

function createSoundCloudPlaybackHarness(outcome) {
  const calls = { play: 0, cleanup: 0, cancel: 0 };
  const player = {
    queue: { current: null, length: 0 },
    async play(track) {
      calls.play += 1;
      this.queue.current = track;
    },
  };
  return {
    calls,
    dependencies: {
      getKazagumo: () => ({}),
      assertIdle: () => null,
      resolveSearch: async (_kazagumo, _seed, requester) => ({
        type: 'SEARCH',
        tracks: [createSyntheticSoundCloudTrack({ requester })],
      }),
      createPlayer: async () => player,
      waitForConfirmation: async () => outcome,
      cancelConfirmation: () => { calls.cancel += 1; },
      cleanupFailedPlayer: async (_player, encodedTrack) => {
        assert.equal(encodedTrack, 'encoded-soundcloud-track');
        calls.cleanup += 1;
        return true;
      },
    },
  };
}

test('SoundCloud fallback fails closed before sustained audio and cleans only its failed track', async () => {
  const originalError = createTrustedSoundCloudFallbackError();
  const harness = createSoundCloudPlaybackHarness({ confirmed: false, failed: true, eventType: 'TrackExceptionEvent' });
  await assert.rejects(
    () => playSoundCloudSameTrackFallback(
      originalError,
      {
        guild: { id: 'guild-sc', shardId: 0 },
        voiceChannel: { id: 'voice-sc' },
        textChannel: { id: 'text-sc' },
        url: 'https://youtu.be/dQw4w9WgXcQ',
        requestedBy: 'user-1',
      },
      harness.dependencies
    ),
    (error) => error.code === 'soundcloud_fallback_stream_failed'
  );
  assert.equal(harness.calls.play, 1);
  assert.equal(harness.calls.cleanup, 1);
});

test('real SoundCloud cleanup destroys only the exact failed current with no queued tracks', async () => {
  let destroyed = 0;
  const player = {
    queue: { current: { track: 'encoded-soundcloud-track' }, length: 0 },
    destroy: async () => { destroyed += 1; },
  };
  assert.equal(await cleanupFailedSoundCloudFallbackPlayer(player, 'encoded-soundcloud-track'), true);
  assert.equal(destroyed, 1);
  assert.equal(await cleanupFailedSoundCloudFallbackPlayer(player, 'another-track'), false);
  player.queue.length = 1;
  assert.equal(await cleanupFailedSoundCloudFallbackPlayer(player, 'encoded-soundcloud-track'), false);
  assert.equal(destroyed, 1);
});

test('SoundCloud fallback reports started only after sustained audio confirmation', async () => {
  const originalError = createTrustedSoundCloudFallbackError();
  const harness = createSoundCloudPlaybackHarness({ confirmed: true, failed: false, eventType: 'playerUpdate' });
  const result = await playSoundCloudSameTrackFallback(
    originalError,
    {
      guild: { id: 'guild-sc-success', shardId: 0 },
      voiceChannel: { id: 'voice-sc' },
      textChannel: { id: 'text-sc' },
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      requestedBy: 'user-1',
    },
    harness.dependencies
  );
  assert.equal(result.started, true);
  assert.equal(result.backend, 'soundcloud-same-track');
  assert.equal(result.sourceName, 'soundcloud');
  assert.equal(result.track.sourceName, 'soundcloud');
  assert.equal(harness.calls.cleanup, 0);
});

test('SoundCloud fallback never triggers for a non-YouTube input', async () => {
  let clientCalls = 0;
  await assert.rejects(
    () => playSoundCloudSameTrackFallback(
      createTrustedSoundCloudFallbackError(),
      {
        guild: { id: 'guild-sc-non-youtube' },
        voiceChannel: { id: 'voice-sc' },
        textChannel: { id: 'text-sc' },
        url: 'https://soundcloud.com/synthetic/track',
        requestedBy: 'user-1',
      },
      { getKazagumo: () => { clientCalls += 1; return {}; } }
    ),
    (error) => error.code === 'soundcloud_fallback_seed_invalid'
  );
  assert.equal(clientCalls, 0);
});

test('playback replies disclose SoundCloud fallback while preserving normal YouTube wording', () => {
  assert.equal(
    formatMusicPlaybackReply({ started: true, backend: 'lavalink', track: { title: 'Synthetic Track' } }),
    '已開始播放：Synthetic Track'
  );
  const fallbackReply = formatMusicPlaybackReply({
    started: true,
    backend: 'soundcloud-same-track',
    sourceName: 'soundcloud',
    track: { title: 'Synthetic Track' },
  });
  assert.match(fallbackReply, /SoundCloud 同曲備援/);
  assert.match(fallbackReply, /實際來源：SoundCloud/);
  const commandSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'music.js'), 'utf8');
  assert.match(commandSource, /editReply\(formatMusicPlaybackReply\(result\)\)/);
  const safeError = new Error('https://secret.invalid media body token=synthetic-secret');
  safeError.code = 'soundcloud_fallback_search_failed';
  assert.doesNotMatch(getMusicUserFacingError(safeError), /secret\.invalid|synthetic-secret|media body/);
});

test('only an internal matching youtube_stream_failed error can carry duration evidence to fallback', () => {
  const input = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const identity = { requestId: 'request-duration', encodedTrack: 'encoded-duration-track' };
  const injectedEvidence = { durationMs: 1, videoId: 'dQw4w9WgXcQ' };
  const options = {
    guild: { id: 'guild-duration' },
    voiceChannel: { id: 'voice-duration' },
    textChannel: { id: 'text-duration' },
    url: input,
    requestedBy: 'user-duration',
    durationEvidence: injectedEvidence,
  };

  const sourceFailure = new Error('synthetic load failure');
  sourceFailure.code = 'youtube_source_failed';
  assert.equal(buildLocalYouTubeFallbackOptions(sourceFailure, options).durationEvidence, null);

  const streamFailure = createPlaybackConfirmationError(
    input,
    createSyntheticResolvedYouTubeTrack(),
    identity,
    { failed: true, ...identity }
  );
  const prepared = buildLocalYouTubeFallbackOptions(streamFailure, options);
  assert.equal(streamFailure.code, 'youtube_stream_failed');
  assert.notEqual(prepared.durationEvidence, injectedEvidence);
  assert.equal(prepared.durationEvidence.durationMs, 273_000);
  assert.equal(prepared.durationEvidence.requestId, identity.requestId);
  assert.equal(prepared.durationEvidence.encodedTrack, identity.encodedTrack);

  const unconfirmed = createPlaybackConfirmationError(
    input,
    createSyntheticResolvedYouTubeTrack(),
    identity,
    { failed: false, ...identity }
  );
  assert.equal(unconfirmed.code, 'youtube_stream_unconfirmed');
  assert.equal(buildLocalYouTubeFallbackOptions(unconfirmed, options).durationEvidence, null);
});

test('early playback failure paths do not emit misleading playing messages', () => {
  const lavalinkServiceSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'lavalinkService.js'),
    'utf8'
  );
  const musicServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'musicService.js'), 'utf8');
  const musicCommandSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'music.js'), 'utf8');
  const earlyFailure = new Error('synthetic internal exception');
  earlyFailure.code = 'youtube_stream_failed';

  assert.doesNotMatch(lavalinkServiceSource, /send\(\{\s*content:\s*`正在播放/);
  assert.doesNotMatch(musicServiceSource, /pendingStart/);
  assert.doesNotMatch(musicCommandSource, /pendingStart/);
  assert.equal(getMusicErrorLayer(earlyFailure), 'source');
  assert.doesNotMatch(getMusicUserFacingError(earlyFailure), /已開始播放|正在播放|synthetic internal exception/);
});

test('Lavalink YouTube credential policy rejects every supported account credential key', () => {
  const forbiddenKeys = [
    'oauth',
    `po${'Token'}`,
    'cookie',
    `refresh${'Token'}`,
    'pot',
    'token',
    `visitor${'Data'}`,
    `access${'Token'}`,
    'cookieFile',
    'youtubeOauthEnabled',
  ];

  for (const key of forbiddenKeys) {
    const syntheticApplication = `plugins:\n  youtube:\n    enabled: true\n    ${key}: synthetic-disabled-value\n`;
    assert.throws(
      () => assertSafeYoutubeCredentialPolicy(syntheticApplication),
      /must not introduce account credentials/
    );
  }

  assert.doesNotThrow(() =>
    assertSafeYoutubeCredentialPolicy(
      'plugins:\n  youtube:\n    notes: "synthetic token: marker only"\n    scalarExample: |\n      "remote\\u0043ipher":\n        "password": synthetic-scalar-only\n'
    )
  );
});

test('Lavalink YouTube policy rejects remote cipher and IP routing without blocking the server password', () => {
  assert.doesNotThrow(() =>
    assertSafeYoutubeCredentialPolicy(
      '"lavalink":\n  \'server\':\n    "password": "${LAVALINK_SERVER_PASSWORD}"\nplugins:\n  youtube:\n    enabled: true\n'
    )
  );

  const escapedDoubleQuotedKeys = [
    'remote\\u0043ipher',
    'o\\u0061uth',
    'po\\u0054oken',
    'route\\u0050lanner',
    'ip\\u0052otation',
  ];

  for (const key of escapedDoubleQuotedKeys) {
    assert.throws(
      () => assertSafeYoutubeCredentialPolicy(`plugins:\n  youtube:\n    "${key}": synthetic-disabled-value\n`),
      /must not use escaped quoted mapping keys/
    );
  }

  const forbiddenFixtures = [
    {
      application:
        'plugins:\n  youtube:\n    "remoteCipher":\n      url: https://cipher.invalid\n      password: synthetic-secret\n      userAgent: synthetic-agent\n',
      message: /must not introduce remote cipher configuration/,
    },
    {
      application: "plugins:\n  youtube:\n    'oauth': false\n    \"poToken\": synthetic-disabled-value\n",
      message: /must not introduce account credentials/,
    },
    {
      application:
        'lavalink:\n  server:\n    ratelimit:\n      ipBlocks:\n        - 192.0.2.0\/24\n      strategy: RotateOnBan\n',
      message: /must not introduce IP rotation, route planner, or routing configuration/,
    },
    {
      application: "plugins:\n  youtube:\n    'routePlanner':\n      rotation: enabled\n",
      message: /must not introduce IP rotation, route planner, or routing configuration/,
    },
    {
      application: 'plugins:\n  youtube:\n    "ipRotation": enabled\n',
      message: /must not introduce IP rotation, route planner, or routing configuration/,
    },
  ];

  for (const fixture of forbiddenFixtures) {
    assert.throws(() => assertSafeYoutubeCredentialPolicy(fixture.application), fixture.message);
  }
});

test('Lavalink load errors remain failures instead of becoming empty search results', () => {
  assert.throws(
    () =>
      normalizeLavalinkLoadResult(
        {
          loadType: 'error',
          data: {
            message: 'All clients failed',
            cause: 'Synthetic playback failure',
            severity: 'fault',
          },
        },
        { requesterId: 'user-1' }
      ),
    (error) => error.code === 'youtube_source_failed' && /All clients failed/.test(error.message)
  );
});

test('Lavalink empty results remain distinct from source load errors', () => {
  assert.deepEqual(normalizeLavalinkLoadResult({ loadType: 'empty', data: {} }, { requesterId: 'user-1' }), {
    playlistName: undefined,
    tracks: [],
    type: 'SEARCH',
  });
});

test('Lavalink track results are normalized into playable Kazagumo tracks', () => {
  const requester = { requesterId: 'user-1' };
  const result = normalizeLavalinkLoadResult(
    {
      loadType: 'track',
      data: {
        encoded: 'synthetic-encoded-track',
        info: {
          identifier: 'video-id',
          isSeekable: true,
          author: 'Synthetic Artist',
          length: 120000,
          isStream: false,
          position: 0,
          title: 'Synthetic Track',
          uri: 'https://www.youtube.com/watch?v=video-id',
          artworkUrl: null,
          isrc: null,
          sourceName: 'youtube',
        },
        pluginInfo: {},
        userData: {},
      },
    },
    requester
  );

  assert.equal(result.type, 'TRACK');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].track, 'synthetic-encoded-track');
  assert.equal(result.tracks[0].requester, requester);
});

test('YouTube source failures use a stable user message without exposing backend details', () => {
  const error = new Error('All clients failed: synthetic backend details');
  error.code = 'youtube_source_failed';

  assert.equal(getMusicErrorLayer(error), 'source');
  assert.equal(
    getMusicUserFacingError(error),
    'YouTube 來源目前拒絕或無法載入這部影片，請稍後再試或改用其他公開影片。'
  );
  assert.doesNotMatch(getMusicUserFacingError(error), /All clients failed/);
});

test('Lavalink search reports no online node as a friendly service error', async () => {
  await assert.rejects(
    () => resolveLavalinkSearch({ getLeastUsedNode: async () => null }, 'synthetic query', { requesterId: 'user-1' }),
    (error) =>
      error.code === 'lavalink_unavailable' &&
      getMusicErrorLayer(error) === 'lavalink' &&
      !/undefined|null/i.test(getMusicUserFacingError(error))
  );
});

test('Lavalink numeric node-selection errors are normalized without leaking internals', async () => {
  const internalError = new Error('synthetic internal node-selection detail');
  internalError.code = 2;

  assert.equal(getMusicErrorLayer(internalError), 'unknown');
  await assert.rejects(
    () =>
      resolveLavalinkSearch(
        { getLeastUsedNode: async () => Promise.reject(internalError) },
        'synthetic query',
        { requesterId: 'user-1' }
      ),
    (error) =>
      error.code === 'lavalink_unavailable' &&
      getMusicErrorLayer(error) === 'lavalink' &&
      !getMusicUserFacingError(error).includes('synthetic internal node-selection detail')
  );
});

test('Lavalink public fallback is off unless explicitly enabled', () => {
  const previous = {
    host: process.env.LAVALINK_HOST,
    password: process.env.LAVALINK_PASSWORD,
    fallback: process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK,
    fallbackHost: process.env.LAVALINK_PUBLIC_FALLBACK_HOST,
    fallbackPassword: process.env.LAVALINK_PUBLIC_FALLBACK_PASSWORD,
  };
  delete process.env.LAVALINK_HOST;
  delete process.env.LAVALINK_PASSWORD;
  delete process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;

  try {
    const disabled = getNodeConfiguration();
    assert.equal(disabled.mode, 'disabled');
    assert.equal(disabled.nodes.length, 0);

    process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK = 'true';
    process.env.LAVALINK_PUBLIC_FALLBACK_HOST = 'public.example.test';
    process.env.LAVALINK_PUBLIC_FALLBACK_PASSWORD = 'provider-value';
    const optedIn = getNodeConfiguration();
    assert.equal(optedIn.mode, 'public-fallback-opt-in');
    assert.ok(optedIn.nodes.length > 0);
  } finally {
    for (const [key, value] of Object.entries({
      LAVALINK_HOST: previous.host,
      LAVALINK_PASSWORD: previous.password,
      LAVALINK_ALLOW_PUBLIC_FALLBACK: previous.fallback,
      LAVALINK_PUBLIC_FALLBACK_HOST: previous.fallbackHost,
      LAVALINK_PUBLIC_FALLBACK_PASSWORD: previous.fallbackPassword,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('self-hosted Lavalink requires an explicit password and reports safe diagnostics', () => {
  const previousHost = process.env.LAVALINK_HOST;
  const previousPassword = process.env.LAVALINK_PASSWORD;
  process.env.LAVALINK_HOST = 'lavalink.internal';
  delete process.env.LAVALINK_PASSWORD;

  try {
    const invalid = getNodeConfiguration();
    assert.equal(invalid.nodes.length, 0);
    assert.match(invalid.errors.join(' '), /LAVALINK_PASSWORD/);

    process.env.LAVALINK_PASSWORD = 'test-only-secret';
    const configured = getNodeConfiguration();
    assert.equal(configured.mode, 'self-hosted');
    assert.equal(configured.nodes[0].url, 'lavalink.internal:2333');
    assert.doesNotMatch(JSON.stringify(getLavalinkStatus()), /test-only-secret/);
  } finally {
    if (previousHost === undefined) delete process.env.LAVALINK_HOST;
    else process.env.LAVALINK_HOST = previousHost;
    if (previousPassword === undefined) delete process.env.LAVALINK_PASSWORD;
    else process.env.LAVALINK_PASSWORD = previousPassword;
  }
});

test('Lavalink initialization stays disabled instead of silently connecting to public nodes', () => {
  const previousHost = process.env.LAVALINK_HOST;
  const previousFallback = process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;
  delete process.env.LAVALINK_HOST;
  delete process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;

  try {
    assert.equal(initializeLavalink({}), null);
    const status = getLavalinkStatus();
    assert.equal(status.configurationMode, 'disabled');
    assert.match(formatLavalinkStatus(status), /public fallback 預設關閉/);
  } finally {
    if (previousHost === undefined) delete process.env.LAVALINK_HOST;
    else process.env.LAVALINK_HOST = previousHost;
    if (previousFallback === undefined) delete process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;
    else process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK = previousFallback;
  }
});

test('formatQueue renders current track and queued tracks', () => {
  const output = formatQueue({
    current: { title: 'Current' },
    queue: [{ title: 'Next' }],
  });

  assert.match(output, /Current/);
  assert.match(output, /Next/);
});

test('buildFfmpegTestToneArgs builds a local non-youtube test source', () => {
  const args = buildFfmpegTestToneArgs({ durationSeconds: 5, frequencyHz: 880 });

  assert.ok(args.includes('lavfi'));
  assert.ok(args.includes('sine=frequency=880:duration=5'));
  assert.ok(args.includes('libopus'));
  assert.ok(args.includes('pipe:1'));
  assert.equal(args.some((arg) => String(arg).includes('youtube')), false);
});

test('music errors are categorized by layer', () => {
  const voiceError = new Error('小吉缺少 Connect 權限');
  voiceError.code = 'missing_connect';

  assert.equal(getMusicErrorLayer(voiceError), 'voice');
  
  const lavalinkError = new Error('Lavalink failed');
  lavalinkError.code = 'lavalink_connect_failed';
  assert.equal(getMusicErrorLayer(lavalinkError), 'lavalink');
});

test('music command exposes diagnostic subcommands', () => {
  const subcommands = musicCommand.data.toJSON().options.map((option) => option.name);

  assert.ok(subcommands.includes('join'));
  assert.ok(subcommands.includes('test'));
  assert.ok(subcommands.includes('status'));
  assert.ok(subcommands.includes('stay'));
  assert.ok(subcommands.includes('leave'));
});

test('music status exposes effective voice stay diagnostics', () => {
  const output = formatLavalinkStatus(getLavalinkStatus(), {
    enabled: true,
    source: 'env',
    backend: 'local',
    channelId: 'voice-1',
    idleTimerScheduled: false,
    playing: false,
  });

  assert.match(output, /語音長駐策略/);
  assert.match(output, /enabled: true/);
  assert.match(output, /channelId: voice-1/);
});

test('lavalink status is available before runtime initialization', () => {
  const status = getLavalinkStatus();
  const output = formatLavalinkStatus(status);

  assert.equal(status.initialized, false);
  assert.ok(status.configuredNodeCount >= 0);
  assert.match(output, /Lavalink 音樂節點狀態/);
  assert.match(output, /尚未初始化/);
});

test('music idle leave timeout is 3 minutes', () => {
  assert.equal(musicIdleLeaveMs, 180000);
});

test('voice stay policy uses guild override before environment', () => {
  assert.deepEqual(
    getVoiceStayPolicy('guild-1', { config: { music: { stayInVoice: true } }, env: { MUSIC_STAY_IN_VOICE: 'false' } }),
    { enabled: true, source: 'guild-config' }
  );
  assert.deepEqual(
    getVoiceStayPolicy('guild-1', { config: { music: { stayInVoice: null } }, env: { MUSIC_STAY_IN_VOICE: 'true' } }),
    { enabled: true, source: 'env' }
  );
});

test('idle disconnect is suppressed only when stay policy is enabled', () => {
  const state = { guildId: 'guild-1', idleTimer: null, connection: {}, current: null, playing: false, queue: [] };
  assert.equal(
    shouldScheduleIdleDisconnect(state, { config: { music: { stayInVoice: true } } }),
    false
  );
  assert.equal(
    shouldScheduleIdleDisconnect(state, { config: { music: { stayInVoice: false } } }),
    true
  );
  assert.equal(
    shouldScheduleIdleDisconnect({ ...state, playing: true }, { config: { music: { stayInVoice: false } } }),
    false
  );
});

test('voice lifecycle handlers ignore unrelated users and accept bot movement', async () => {
  const client = { user: { id: 'bot-1' } };
  assert.equal(
    await handleBotVoiceStateUpdate(
      { id: 'user-1', channelId: 'voice-1', client, guild: { id: 'guild-1' } },
      { id: 'user-1', channelId: null, client, guild: { id: 'guild-1' } }
    ),
    false
  );
  assert.equal(
    await handleBotVoiceStateUpdate(
      { id: 'bot-1', channelId: 'voice-1', client, guild: { id: 'guild-1' } },
      { id: 'bot-1', channelId: 'voice-2', channel: null, client, guild: { id: 'guild-1' } }
    ),
    true
  );
  assert.equal(await handleVoiceChannelDeleted({ id: 'text-1', guild: { id: 'guild-1' }, isVoiceBased: () => false }), false);
});

test('message event never routes a pasted YouTube URL to playback', () => {
  const messageEventSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'events', 'messageCreate.js'), 'utf8');
  assert.doesNotMatch(messageEventSource, /handleMusicLinkMessage/);
  assert.doesNotMatch(messageEventSource, /musicService/);
});

test('retained private /music experiment keeps its explicit URL input contract', () => {
  const command = musicCommand.data.toJSON();
  const play = command.options.find((option) => option.name === 'play');
  assert.ok(play);
  const input = play.options.find((option) => option.name === 'url');
  assert.equal(input.required, true);
  assert.match(input.description, /YouTube.*搜尋/);

  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=share',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  ]) {
    assert.equal(isYouTubeUrl(url), true, url);
  }
  assert.equal(isYouTubeUrl('lofi hip hop'), false, 'search phrases are intentionally passed through to Lavalink');
});

function createVoiceChannel({
  permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
  userLimit = 0,
  memberCount = 0,
  channelId = 'voice-1',
} = {}) {
  const allowed = new Set(permissions);

  return {
    id: channelId,
    userLimit,
    members: {
      size: memberCount,
      has: () => false,
    },
    guild: {
      id: 'guild-1',
      members: {
        me: {
          id: 'bot-1',
        },
      },
    },
    permissionsFor: () => ({
      has: (permission) => allowed.has(permission),
    }),
  };
}

test('validateVoiceChannelForPlayback rejects missing voice permissions clearly', () => {
  assert.throws(
    () => validateVoiceChannelForPlayback(createVoiceChannel({ permissions: [PermissionFlagsBits.ViewChannel] })),
    /Connect/
  );

  assert.throws(
    () =>
      validateVoiceChannelForPlayback(
        createVoiceChannel({ permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })
      ),
    /Speak/
  );
});

test('validateVoiceChannelForPlayback rejects full channels', () => {
  assert.throws(() => validateVoiceChannelForPlayback(createVoiceChannel({ userLimit: 2, memberCount: 2 })), /已滿/);
});
