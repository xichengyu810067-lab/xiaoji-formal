const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensurePinnedPotProvider,
  getCleanProviderEnv,
  getProviderRuntimePaths,
} = require('../../scripts/bootstrap-ytdlp-pot-provider');
const {
  YouTubeLocalSourceError,
  extractStrictYouTubeVideoId,
  sanitizeVideoTitle,
  youtubeSourceMaxDurationSeconds,
} = require('./youtubeLocalSource');
const logger = require('../utils/logger');

const ytdlpVersion = '2026.07.04';
const ytdlpMaxDownloadBytes = 64 * 1024 * 1024;
const ytdlpMaxCookieBytes = 1024 * 1024;
const ytdlpMaxMetadataBytes = 1024 * 1024;
const ytdlpMaxStderrBytes = 4096;
const ytdlpProcessTimeoutMs = 30_000;
const ytdlpDownloadTimeoutMs = 45_000;
const ytdlpAllowedDownloadHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
]);
const ytdlpDiagnosticsByError = new WeakMap();
const ytdlpCookieHeaders = new Set([
  '# HTTP Cookie File',
  '# Netscape HTTP Cookie File',
]);
const ytdlpAssets = Object.freeze({
  glibc: Object.freeze({
    name: 'yt-dlp_linux',
    sha256: '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae',
  }),
  musl: Object.freeze({
    name: 'yt-dlp_musllinux',
    sha256: 'f7439ec2e3ffe69e06ac233f83f0d9687b89105939129bddcbf74e5de0f2b40e',
  }),
});

let installPromise = null;

function createYtdlpError(code, diagnostics = null) {
  const error = new YouTubeLocalSourceError(code);
  if (diagnostics) {
    const safeDiagnostics = Object.freeze({
      stage: String(diagnostics.stage || 'unknown').replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'unknown',
      exitCode: Number.isSafeInteger(diagnostics.exitCode) ? diagnostics.exitCode : null,
      stdoutBytes: Number.isSafeInteger(diagnostics.stdoutBytes) ? diagnostics.stdoutBytes : 0,
      stderrBytes: Number.isSafeInteger(diagnostics.stderrBytes) ? diagnostics.stderrBytes : 0,
      stderrCategory: ['none', 'bot-challenge', 'js-runtime', 'unsupported-option', 'no-formats', 'unavailable', 'other']
        .includes(diagnostics.stderrCategory)
        ? diagnostics.stderrCategory
        : 'other',
    });
    ytdlpDiagnosticsByError.set(error, safeDiagnostics);
  }
  return error;
}

function getYtdlpDiagnostics(error) {
  return ytdlpDiagnosticsByError.get(error) || null;
}

function classifyYtdlpStderr(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  if (!text) return 'none';
  if (/sign in to confirm|not a bot/i.test(text)) return 'bot-challenge';
  if (/javascript runtime|js runtime|js-runtimes|ejs/i.test(text)) return 'js-runtime';
  if (/no such option|unrecognized arguments?|unknown option/i.test(text)) return 'unsupported-option';
  if (/no video formats|requested format is not available|no formats found/i.test(text)) return 'no-formats';
  if (/video unavailable|private video|members-only|age.restricted|geo.restricted/i.test(text)) return 'unavailable';
  return 'other';
}

function selectYtdlpAsset(report = process.report?.getReport?.(), platform = process.platform) {
  if (platform !== 'linux') return null;
  return report?.header?.glibcVersionRuntime ? ytdlpAssets.glibc : ytdlpAssets.musl;
}

function getYtdlpRuntimePath(asset = selectYtdlpAsset(), cwd = process.cwd()) {
  return path.join(cwd, '.runtime', 'yt-dlp', `${asset.name}-${ytdlpVersion}`);
}

function getYtdlpReleaseUrl(asset) {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${ytdlpVersion}/${asset.name}`;
}

function getCookieStatFingerprint(stat) {
  const fields = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs'];
  return fields.map((field) => `${field}:${String(stat?.[field] ?? '')}`).join('|');
}

function validateYtdlpCookieStat(
  stat,
  configuredPath,
  {
    platform = process.platform,
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null,
  } = {}
) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.()) {
    throw new YouTubeLocalSourceError('youtube_local_cookie_file_invalid');
  }
  const size = typeof stat.size === 'bigint' ? stat.size : BigInt(stat.size);
  if (size <= 0n || size > BigInt(ytdlpMaxCookieBytes)) {
    throw new YouTubeLocalSourceError('youtube_local_cookie_size_invalid');
  }
  const mode = typeof stat.mode === 'bigint' ? stat.mode : BigInt(stat.mode);
  const uid = typeof stat.uid === 'bigint' ? stat.uid : BigInt(stat.uid);
  if (
    platform !== 'win32' &&
    ((mode & 0o077n) !== 0n || (Number.isSafeInteger(ownerUid) && uid !== BigInt(ownerUid)))
  ) {
    throw new YouTubeLocalSourceError('youtube_local_cookie_permissions_invalid');
  }
  return path.resolve(configuredPath);
}

async function readValidatedYtdlpCookieSource(
  configuredPath,
  {
    fsImpl = fs.promises,
    platform = process.platform,
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null,
  } = {}
) {
  const value = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (!value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new YouTubeLocalSourceError('youtube_local_cookie_path_invalid');
  }

  const resolvedPath = path.resolve(value);
  const noFollow = platform !== 'win32' && Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  const openFlags = fs.constants.O_RDONLY | noFollow;

  let handle;
  try {
    handle = await fsImpl.open(resolvedPath, openFlags);
    const handleStat = await handle.stat({ bigint: true });
    const pathStat = await fsImpl.lstat(resolvedPath, { bigint: true });
    validateYtdlpCookieStat(handleStat, resolvedPath, { platform, ownerUid });
    validateYtdlpCookieStat(pathStat, resolvedPath, { platform, ownerUid });
    const fingerprint = getCookieStatFingerprint(handleStat);
    if (fingerprint !== getCookieStatFingerprint(pathStat)) {
      throw new YouTubeLocalSourceError('youtube_local_cookie_source_changed');
    }

    const bytes = await handle.readFile();
    const finalHandleStat = await handle.stat({ bigint: true });
    if (
      bytes.length !== Number(handleStat.size) ||
      fingerprint !== getCookieStatFingerprint(finalHandleStat)
    ) {
      bytes.fill(0);
      throw new YouTubeLocalSourceError('youtube_local_cookie_source_changed');
    }
    const firstLine = bytes.subarray(0, 128).toString('utf8').split(/\r?\n/, 1)[0];
    if (!ytdlpCookieHeaders.has(firstLine)) {
      bytes.fill(0);
      throw new YouTubeLocalSourceError('youtube_local_cookie_format_invalid');
    }
    return Object.freeze({
      bytes,
      fingerprint,
      sourcePath: resolvedPath,
    });
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_cookie_access_failed');
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function cleanupYtdlpCookieHandoffArtifacts(directoryPath, cookiePath, fsImpl = fs.promises) {
  let failed = false;
  try {
    if (cookiePath) await fsImpl.rm(cookiePath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') failed = true;
  }
  try {
    if (directoryPath) await fsImpl.rmdir(directoryPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') failed = true;
  }
  if (failed) {
    logger.warn('[Music] yt-dlp cookie handoff cleanup failed: code=youtube_local_cookie_cleanup_failed');
  }
  return !failed;
}

function waitForYtdlpCookieCleanupRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function cleanupYtdlpCookieHandoffArtifactsWithRetry(
  directoryPath,
  cookiePath,
  fsImpl,
  { maxAttempts = 2, retryDelayMs = 5 } = {}
) {
  const attempts = Number.isSafeInteger(maxAttempts) ? Math.max(1, Math.min(maxAttempts, 3)) : 1;
  const delayMs = Number.isSafeInteger(retryDelayMs) ? Math.max(0, Math.min(retryDelayMs, 25)) : 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await cleanupYtdlpCookieHandoffArtifacts(directoryPath, cookiePath, fsImpl)) return true;
    if (attempt + 1 < attempts && delayMs > 0) {
      await waitForYtdlpCookieCleanupRetry(delayMs);
    }
  }
  return false;
}

async function requestYtdlpCookieHandoffCleanup(handoff, options) {
  if (!handoff?.cleanup) return true;
  try {
    return await handoff.cleanup(options);
  } catch {
    logger.warn('[Music] yt-dlp cookie handoff cleanup failed: code=youtube_local_cookie_cleanup_failed');
    return false;
  }
}

async function createYtdlpCookieHandoff(
  configuredPath,
  {
    fsImpl = fs.promises,
    platform = process.platform,
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null,
    tempRoot = os.tmpdir(),
  } = {}
) {
  const source = await readValidatedYtdlpCookieSource(configuredPath, { fsImpl, platform, ownerUid });
  let directoryPath = null;
  let cookiePath = null;
  let outputHandle = null;
  try {
    directoryPath = await fsImpl.mkdtemp(path.join(path.resolve(tempRoot), 'xiaoji-ytdlp-cookie-'));
    await fsImpl.chmod(directoryPath, 0o700);
    cookiePath = path.join(directoryPath, 'cookies.txt');
    outputHandle = await fsImpl.open(cookiePath, 'wx', 0o600);
    await outputHandle.writeFile(source.bytes);
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = null;
    await fsImpl.chmod(cookiePath, 0o600);

    let cleaned = false;
    let cleanupInFlight = null;
    const cleanup = async ({ maxAttempts = 1, retryDelayMs = 0 } = {}) => {
      if (cleaned) return true;
      const attempts = Number.isSafeInteger(maxAttempts) ? Math.max(1, Math.min(maxAttempts, 3)) : 1;
      const delayMs = Number.isSafeInteger(retryDelayMs) ? Math.max(0, Math.min(retryDelayMs, 25)) : 0;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (cleaned) return true;
        const activeCleanup = cleanupInFlight || cleanupYtdlpCookieHandoffArtifacts(
          directoryPath,
          cookiePath,
          fsImpl
        );
        cleanupInFlight = activeCleanup;
        const success = await activeCleanup;
        if (cleanupInFlight === activeCleanup) cleanupInFlight = null;
        if (success) {
          cleaned = true;
          return true;
        }
        if (attempt + 1 < attempts && delayMs > 0) {
          await waitForYtdlpCookieCleanupRetry(delayMs);
        }
      }
      return false;
    };
    return Object.freeze({
      cleanup,
      cookiePath,
      sourceFingerprint: source.fingerprint,
      sourcePath: source.sourcePath,
    });
  } catch (error) {
    await outputHandle?.close?.().catch(() => {});
    await cleanupYtdlpCookieHandoffArtifactsWithRetry(directoryPath, cookiePath, fsImpl);
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_cookie_handoff_failed');
  } finally {
    source.bytes.fill(0);
  }
}

async function assertYtdlpCookieSourceUnchanged(
  handoff,
  {
    fsImpl = fs.promises,
    platform = process.platform,
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null,
  } = {}
) {
  if (!handoff) return;
  try {
    const stat = await fsImpl.lstat(handoff.sourcePath, { bigint: true });
    validateYtdlpCookieStat(stat, handoff.sourcePath, { platform, ownerUid });
    if (getCookieStatFingerprint(stat) !== handoff.sourceFingerprint) {
      throw new YouTubeLocalSourceError('youtube_local_cookie_source_changed');
    }
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_cookie_source_changed');
  }
}

async function resolveYtdlpCookieHandoff({
  allowCookies = false,
  env = process.env,
  fsImpl = fs.promises,
  platform = process.platform,
  tempRoot = os.tmpdir(),
} = {}) {
  if (allowCookies !== true) return null;
  const configuredPath = typeof env?.YOUTUBE_COOKIES_PATH === 'string'
    ? env.YOUTUBE_COOKIES_PATH.trim()
    : '';
  if (!configuredPath) return null;
  return createYtdlpCookieHandoff(configuredPath, { fsImpl, platform, tempRoot });
}

function isAllowedYtdlpDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ytdlpAllowedDownloadHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readVerifiedCachedBinary(filePath, expectedSha256, fsImpl = fs.promises) {
  try {
    const buffer = await fsImpl.readFile(filePath);
    return buffer.length <= ytdlpMaxDownloadBytes && sha256(buffer) === expectedSha256;
  } catch {
    return false;
  }
}

async function fetchPinnedYtdlpAsset(
  url,
  {
    fetchImpl = globalThis.fetch,
    maxRedirects = 5,
    maxBytes = ytdlpMaxDownloadBytes,
    timeoutMs = ytdlpDownloadTimeoutMs,
  } = {}
) {
  if (typeof fetchImpl !== 'function') throw new YouTubeLocalSourceError('youtube_local_fetch_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new YouTubeLocalSourceError('youtube_local_source_failed')),
      { once: true }
    );
  });
  let currentUrl = url;

  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (!isAllowedYtdlpDownloadUrl(currentUrl)) {
        throw new YouTubeLocalSourceError('youtube_local_source_failed');
      }
      const response = await Promise.race([
        fetchImpl(currentUrl, {
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': `xiaoji-ytdlp-bootstrap/${ytdlpVersion}` },
        }),
        aborted,
      ]);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location || redirects === maxRedirects) {
          throw new YouTubeLocalSourceError('youtube_local_source_failed');
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok || !response.body) throw new YouTubeLocalSourceError('youtube_local_source_failed');
      const declaredLengthHeader = response.headers?.get?.('content-length');
      const declaredLength = declaredLengthHeader === null || declaredLengthHeader === undefined
        ? null
        : Number(declaredLengthHeader);
      if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes)) {
        throw new YouTubeLocalSourceError('youtube_local_length_invalid');
      }

      const chunks = [];
      let total = 0;
      const iterator = response.body[Symbol.asyncIterator]?.();
      if (!iterator) throw new YouTubeLocalSourceError('youtube_local_stream_invalid');
      try {
        while (true) {
          const { done, value } = await Promise.race([iterator.next(), aborted]);
          if (done) break;
          total += value.length;
          if (total > maxBytes) throw new YouTubeLocalSourceError('youtube_local_length_invalid');
          chunks.push(Buffer.from(value));
        }
      } finally {
        Promise.resolve(iterator.return?.()).catch(() => {});
      }
      if (total <= 0) throw new YouTubeLocalSourceError('youtube_local_stream_empty');
      return Buffer.concat(chunks, total);
    }
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_source_failed');
  } finally {
    clearTimeout(timer);
  }
  throw new YouTubeLocalSourceError('youtube_local_source_failed');
}

async function installPinnedYtdlp({ asset = selectYtdlpAsset(), cwd, fetchImpl, fsImpl = fs.promises } = {}) {
  if (!asset) throw new YouTubeLocalSourceError('youtube_local_source_failed');
  const binaryPath = getYtdlpRuntimePath(asset, cwd);
  if (await readVerifiedCachedBinary(binaryPath, asset.sha256, fsImpl)) {
    await fsImpl.chmod(binaryPath, 0o755);
    return binaryPath;
  }

  const buffer = await fetchPinnedYtdlpAsset(getYtdlpReleaseUrl(asset), { fetchImpl });
  if (sha256(buffer) !== asset.sha256) throw new YouTubeLocalSourceError('youtube_local_source_failed');
  const directory = path.dirname(binaryPath);
  const temporaryPath = `${binaryPath}.${process.pid}.tmp`;
  await fsImpl.mkdir(directory, { recursive: true });
  try {
    await fsImpl.writeFile(temporaryPath, buffer, { mode: 0o755, flag: 'wx' });
    if (!(await readVerifiedCachedBinary(temporaryPath, asset.sha256, fsImpl))) {
      throw new YouTubeLocalSourceError('youtube_local_source_failed');
    }
    await fsImpl.chmod(temporaryPath, 0o755);
    await fsImpl.rename(temporaryPath, binaryPath);
    return binaryPath;
  } finally {
    await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function ensurePinnedYtdlp(options = {}) {
  if (options.asset || options.cwd || options.fetchImpl || options.fsImpl) return installPinnedYtdlp(options);
  if (!installPromise) installPromise = installPinnedYtdlp().catch((error) => {
    installPromise = null;
    throw error;
  });
  return installPromise;
}

function buildYtdlpCommonArgs(
  nodePath = process.execPath,
  providerPaths = getProviderRuntimePaths(),
  { cookiePath = null } = {}
) {
  const args = [
    '--no-config',
    '--no-plugin-dirs',
    '--plugin-dirs',
    providerPaths.pluginDir,
    '--no-playlist',
    '--no-remote-components',
    '--no-js-runtimes',
    '--js-runtimes',
    `node:${nodePath}`,
    '--extractor-args',
    `youtube:player_client=mweb;youtubepot-bgutilscript:server_home=${providerPaths.serverHome}`,
    '--proxy',
    '',
  ];
  if (cookiePath) args.push('--cookies', cookiePath);
  args.push('--no-warnings', '--no-progress');
  return args;
}

function buildYtdlpMetadataArgs(
  videoId,
  nodePath = process.execPath,
  providerPaths = getProviderRuntimePaths(),
  options = {}
) {
  return [
    ...buildYtdlpCommonArgs(nodePath, providerPaths, options),
    '--skip-download',
    '--dump-single-json',
    '--',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

function buildYtdlpAudioArgs(
  videoId,
  nodePath = process.execPath,
  providerPaths = getProviderRuntimePaths(),
  options = {}
) {
  return [
    ...buildYtdlpCommonArgs(nodePath, providerPaths, options),
    '--format',
    'bestaudio/best',
    '--output',
    '-',
    '--',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

function spawnYtdlp(binaryPath, args, spawnImpl = spawn, providerPaths = getProviderRuntimePaths()) {
  try {
    return spawnImpl(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: getCleanProviderEnv(providerPaths.cacheHome),
    });
  } catch {
    throw new YouTubeLocalSourceError('youtube_local_source_failed');
  }
}

function collectYtdlpMetadata(child, { timeoutMs = ytdlpProcessTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const diagnostics = (stage, exitCode = null) => ({
      stage,
      exitCode,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stderrCategory: classifyYtdlpStderr(stderr),
    });
    const timer = setTimeout(() => fail('youtube_local_info_timeout', 'timeout'), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('close');
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (code, stage, exitCode = null) => {
      try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      finish(reject, createYtdlpError(code, diagnostics(stage, exitCode)));
    };

    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length > ytdlpMaxMetadataBytes) {
        return fail('youtube_local_info_failed', 'stdout-limit');
      }
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < ytdlpMaxStderrBytes) {
        stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(0, ytdlpMaxStderrBytes);
      }
    });
    child.once('error', () => fail('youtube_local_info_failed', 'process-error'));
    child.once('close', (code) => {
      if (code !== 0) return fail('youtube_local_info_failed', 'exit-nonzero', code);
      if (stdout.length <= 0) return fail('youtube_local_info_failed', 'stdout-empty', code);
      try {
        finish(resolve, JSON.parse(stdout.toString('utf8')));
      } catch {
        fail('youtube_local_info_failed', 'json-invalid', code);
      }
    });
  });
}

function validateYtdlpMetadata(metadata, videoId) {
  if (!metadata || metadata.id !== videoId) {
    throw createYtdlpError('youtube_local_metadata_id_mismatch', { stage: 'identity' });
  }
  if (
    metadata.is_live === true ||
    ['is_live', 'is_upcoming', 'post_live', 'was_live'].includes(metadata.live_status)
  ) {
    throw createYtdlpError('youtube_local_live_rejected', { stage: 'live-check' });
  }
  const duration = Number(metadata.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw createYtdlpError('youtube_local_duration_invalid', { stage: 'duration' });
  }
  if (duration > youtubeSourceMaxDurationSeconds) {
    throw createYtdlpError('youtube_local_duration_overlong', { stage: 'duration' });
  }
  return {
    title: sanitizeVideoTitle(metadata.title),
    duration: Math.ceil(duration),
    source: 'youtube-local',
  };
}

async function loadYtdlpYouTubeAudio(input, {
  ensureBinary = ensurePinnedYtdlp,
  ensureProvider = ensurePinnedPotProvider,
  spawnImpl = spawn,
  allowCookies = false,
  env = process.env,
  fsImpl = fs.promises,
  platform = process.platform,
  cookieTempRoot = os.tmpdir(),
  metadataTimeoutMs = ytdlpProcessTimeoutMs,
} = {}) {
  const videoId = extractStrictYouTubeVideoId(input);
  if (!videoId) throw new YouTubeLocalSourceError('youtube_local_invalid_video');
  let cookieHandoff = null;
  let sourceProcess = null;
  try {
    cookieHandoff = await resolveYtdlpCookieHandoff({
      allowCookies,
      env,
      fsImpl,
      platform,
      tempRoot: cookieTempRoot,
    });
    const binaryPath = await ensureBinary();
    const providerPaths = await ensureProvider();
    const cookieOptions = { cookiePath: cookieHandoff?.cookiePath || null };
    await assertYtdlpCookieSourceUnchanged(cookieHandoff, { fsImpl, platform });
    const metadataChild = spawnYtdlp(
      binaryPath,
      buildYtdlpMetadataArgs(videoId, process.execPath, providerPaths, cookieOptions),
      spawnImpl,
      providerPaths
    );
    const metadata = await collectYtdlpMetadata(metadataChild, { timeoutMs: metadataTimeoutMs });
    const track = validateYtdlpMetadata(metadata, videoId);
    await assertYtdlpCookieSourceUnchanged(cookieHandoff, { fsImpl, platform });
    sourceProcess = spawnYtdlp(
      binaryPath,
      buildYtdlpAudioArgs(videoId, process.execPath, providerPaths, cookieOptions),
      spawnImpl,
      providerPaths
    );
    if (!sourceProcess?.stdout) {
      try { sourceProcess?.kill?.('SIGKILL'); } catch {}
      throw new YouTubeLocalSourceError('youtube_local_stream_create_failed');
    }
    if (cookieHandoff) {
      sourceProcess.once('error', () => {
        void requestYtdlpCookieHandoffCleanup(cookieHandoff, { maxAttempts: 1 });
      });
      sourceProcess.once('close', () => {
        void requestYtdlpCookieHandoffCleanup(cookieHandoff, { maxAttempts: 2, retryDelayMs: 5 });
      });
    }
    sourceProcess.once('error', () => {
      sourceProcess.stdout?.destroy?.(new YouTubeLocalSourceError('youtube_local_stream_failed'));
    });
    sourceProcess.stderr?.resume?.();
    return { nodeStream: sourceProcess.stdout, sourceProcess, track };
  } catch (error) {
    try {
      if (sourceProcess && !sourceProcess.killed) sourceProcess.kill?.('SIGKILL');
    } catch {
      // Preserve the original finite source error.
    }
    await requestYtdlpCookieHandoffCleanup(cookieHandoff, { maxAttempts: 2, retryDelayMs: 5 });
    throw error;
  }
}

module.exports = {
  buildYtdlpAudioArgs,
  buildYtdlpCommonArgs,
  buildYtdlpMetadataArgs,
  assertYtdlpCookieSourceUnchanged,
  collectYtdlpMetadata,
  createYtdlpCookieHandoff,
  ensurePinnedYtdlp,
  fetchPinnedYtdlpAsset,
  getYtdlpReleaseUrl,
  getYtdlpDiagnostics,
  getYtdlpRuntimePath,
  installPinnedYtdlp,
  isAllowedYtdlpDownloadUrl,
  classifyYtdlpStderr,
  getCookieStatFingerprint,
  loadYtdlpYouTubeAudio,
  readVerifiedCachedBinary,
  readValidatedYtdlpCookieSource,
  resolveYtdlpCookieHandoff,
  selectYtdlpAsset,
  sha256,
  validateYtdlpCookieStat,
  validateYtdlpMetadata,
  ytdlpAllowedDownloadHosts,
  ytdlpAssets,
  ytdlpMaxCookieBytes,
  ytdlpMaxDownloadBytes,
  ytdlpVersion,
};
