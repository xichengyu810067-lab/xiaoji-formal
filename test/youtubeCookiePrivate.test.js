const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const logger = require('../src/utils/logger');

const {
  getMusicUserFacingError,
  isPrivateYouTubeCookieAccess,
  isYtdlpCookieConfigurationError,
} = require('../src/services/musicService');
const {
  buildYtdlpAudioArgs,
  buildYtdlpMetadataArgs,
  createYtdlpCookieHandoff,
  loadYtdlpYouTubeAudio,
  readValidatedYtdlpCookieSource,
  resolveYtdlpCookieHandoff,
  validateYtdlpCookieStat,
  ytdlpMaxCookieBytes,
} = require('../src/services/youtubeYtdlpSource');

const videoId = 'dQw4w9WgXcQ';
const providerPaths = Object.freeze({
  pluginDir: '/runtime/provider/plugin',
  serverHome: '/runtime/provider/server',
  cacheHome: '/runtime/cache',
});

function createCookieFixture(t, { header = '# Netscape HTTP Cookie File', body = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-cookie-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cookiePath = path.join(root, 'youtube.cookies.txt');
  const cookieBody = body ?? `${header}\n.example\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-private-value\n`;
  fs.writeFileSync(cookiePath, cookieBody, { mode: 0o600 });
  fs.chmodSync(cookiePath, 0o600);
  return { root, cookiePath };
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', -9));
    return true;
  };
  return child;
}

function createSuccessfulSpawn(calls) {
  return (binaryPath, args, options) => {
    calls.push({ binaryPath, args, options });
    const child = createChild();
    if (calls.length === 1) {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({
          id: videoId,
          title: 'Synthetic track',
          duration: 120,
          live_status: 'not_live',
        }));
        child.stderr.end();
        child.emit('close', 0);
      });
    }
    return child;
  };
}

function loadWithSpawn(spawnImpl, options = {}) {
  return loadYtdlpYouTubeAudio(`https://www.youtube.com/watch?v=${videoId}`, {
    ensureBinary: async () => '/runtime/yt-dlp',
    ensureProvider: async () => providerPaths,
    spawnImpl,
    platform: 'win32',
    ...options,
  });
}

async function waitForRemoval(targetPath) {
  for (let index = 0; index < 30 && fs.existsSync(targetPath); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(targetPath), false);
}

async function waitForCondition(predicate) {
  for (let index = 0; index < 30 && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

test('cookie path is optional and anonymous behavior remains the default', async () => {
  assert.equal(await resolveYtdlpCookieHandoff({ allowCookies: true, env: {} }), null);
  assert.equal(
    await resolveYtdlpCookieHandoff({
      allowCookies: false,
      env: { YOUTUBE_COOKIES_PATH: 'deliberately-invalid-relative-path' },
    }),
    null
  );

  for (const args of [
    buildYtdlpMetadataArgs(videoId, '/opt/node', providerPaths),
    buildYtdlpAudioArgs(videoId, '/opt/node', providerPaths),
  ]) {
    assert.equal(args.includes('--cookies'), false);
  }
});

test('a valid source is copied to an exclusive private handoff and its source path is not returned to yt-dlp', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  const handoff = await createYtdlpCookieHandoff(cookiePath, {
    platform: 'win32',
    tempRoot,
  });
  assert.notEqual(handoff.cookiePath, path.resolve(cookiePath));
  assert.equal(path.dirname(handoff.cookiePath).startsWith(tempRoot), true);
  assert.equal(fs.readFileSync(handoff.cookiePath, 'utf8'), fs.readFileSync(cookiePath, 'utf8'));
  assert.equal(fs.statSync(handoff.cookiePath).isFile(), true);
  await handoff.cleanup();
  assert.equal(fs.existsSync(handoff.cookiePath), false);
  assert.equal(fs.existsSync(path.dirname(handoff.cookiePath)), false);
});

test('metadata and audio subprocesses share one private snapshot that is removed on process close', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  const calls = [];
  const result = await loadWithSpawn(createSuccessfulSpawn(calls), {
    allowCookies: true,
    env: { YOUTUBE_COOKIES_PATH: cookiePath },
    cookieTempRoot: tempRoot,
  });

  assert.equal(calls.length, 2);
  const snapshotPath = calls[0].args[calls[0].args.indexOf('--cookies') + 1];
  assert.notEqual(snapshotPath, path.resolve(cookiePath));
  assert.equal(fs.existsSync(snapshotPath), true);
  for (const call of calls) {
    assert.equal(call.args.filter((arg) => arg === '--cookies').length, 1);
    assert.equal(call.args[call.args.indexOf('--cookies') + 1], snapshotPath);
    assert.equal(call.args.includes('--cookies-from-browser'), false);
    assert.equal(call.options.shell, undefined);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(call.options.env.YOUTUBE_COOKIES_PATH, undefined);
    assert.doesNotMatch(JSON.stringify(call.options.env), /youtube\.cookies\.txt|synthetic-private-value/);
  }
  assert.equal(result.track.title, 'Synthetic track');
  result.sourceProcess.kill('SIGKILL');
  await waitForRemoval(snapshotPath);
  assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
});

test('non-private loader entry ignores a configured cookie path', async (t) => {
  const { cookiePath } = createCookieFixture(t);
  const calls = [];
  const result = await loadWithSpawn(createSuccessfulSpawn(calls), {
    env: { YOUTUBE_COOKIES_PATH: cookiePath },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.args.includes('--cookies')), false);
  result.sourceProcess.kill('SIGKILL');
});

test('handle-based cookie reads fail closed for unsafe paths, files, size, format, and permissions', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const missing = path.join(root, 'missing.cookies.txt');
  const directory = path.join(root, 'directory');
  const empty = path.join(root, 'empty.cookies.txt');
  const oversized = path.join(root, 'oversized.cookies.txt');
  const wrongFormat = path.join(root, 'wrong-format.cookies.txt');
  fs.mkdirSync(directory);
  fs.writeFileSync(empty, '');
  fs.writeFileSync(oversized, Buffer.alloc(ytdlpMaxCookieBytes + 1));
  fs.writeFileSync(wrongFormat, 'SID=synthetic-private-value\n');

  const cases = [
    ['relative.cookies.txt', 'youtube_local_cookie_path_invalid'],
    [missing, 'youtube_local_cookie_access_failed'],
    [directory, 'youtube_local_cookie_file_invalid'],
    [empty, 'youtube_local_cookie_size_invalid'],
    [oversized, 'youtube_local_cookie_size_invalid'],
    [wrongFormat, 'youtube_local_cookie_format_invalid'],
  ];
  for (const [configuredPath, code] of cases) {
    await assert.rejects(
      readValidatedYtdlpCookieSource(configuredPath, { platform: 'win32' }),
      (error) => error.code === code && !JSON.stringify(error).includes('synthetic-private-value')
    );
  }

  fs.chmodSync(cookiePath, 0o644);
  await assert.rejects(
    readValidatedYtdlpCookieSource(cookiePath, { platform: 'linux' }),
    (error) => error.code === 'youtube_local_cookie_permissions_invalid'
  );

  assert.throws(
    () => validateYtdlpCookieStat({
      size: 64n,
      mode: 0o600n,
      uid: 1001n,
      isFile: () => true,
      isSymbolicLink: () => false,
    }, cookiePath, { platform: 'linux', ownerUid: 1000 }),
    (error) => error.code === 'youtube_local_cookie_permissions_invalid'
  );

  assert.throws(
    () => validateYtdlpCookieStat({
      size: 64n,
      mode: 0o600n,
      uid: 0n,
      isFile: () => true,
      isSymbolicLink: () => true,
    }, cookiePath, { platform: 'win32' }),
    (error) => error.code === 'youtube_local_cookie_file_invalid'
  );
});

test('replacing the source after snapshot creation fails before spawn and cleans the handoff', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  let spawnCalls = 0;

  await assert.rejects(
    loadWithSpawn(
      () => {
        spawnCalls += 1;
        throw new Error('spawn must not run');
      },
      {
        allowCookies: true,
        env: { YOUTUBE_COOKIES_PATH: cookiePath },
        cookieTempRoot: tempRoot,
        ensureProvider: async () => {
          fs.renameSync(cookiePath, `${cookiePath}.replaced`);
          fs.writeFileSync(cookiePath, '# Netscape HTTP Cookie File\n.example\tTRUE\t/\tTRUE\t0\tSID\treplacement\n', { mode: 0o600 });
          fs.chmodSync(cookiePath, 0o600);
          return providerPaths;
        },
      }
    ),
    (error) => {
      assert.equal(error.code, 'youtube_local_cookie_source_changed');
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /replacement|youtube\.cookies\.txt|xiaoji-cookie-test-/);
      return true;
    }
  );
  assert.equal(spawnCalls, 0);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('spawn failures expose neither the cookie path nor cookie contents', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  let snapshotPath = null;
  await assert.rejects(
    loadWithSpawn(
      (_binaryPath, args) => {
        snapshotPath = args[args.indexOf('--cookies') + 1];
        throw new Error(`spawn failed ${snapshotPath} ${cookiePath} synthetic-private-value`);
      },
      {
        allowCookies: true,
        env: { YOUTUBE_COOKIES_PATH: cookiePath },
        cookieTempRoot: tempRoot,
      }
    ),
    (error) => {
      const serialized = `${error.message} ${JSON.stringify(error)}`;
      assert.equal(error.code, 'youtube_local_source_failed');
      assert.doesNotMatch(serialized, /synthetic-private-value|youtube\.cookies\.txt|xiaoji-cookie-test-/);
      return true;
    }
  );
  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(snapshotPath), false);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('metadata timeout kills the child and removes the private handoff', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  let snapshotPath = null;
  let metadataChild = null;

  await assert.rejects(
    loadWithSpawn(
      (_binaryPath, args) => {
        snapshotPath = args[args.indexOf('--cookies') + 1];
        metadataChild = createChild();
        return metadataChild;
      },
      {
        allowCookies: true,
        env: { YOUTUBE_COOKIES_PATH: cookiePath },
        cookieTempRoot: tempRoot,
        metadataTimeoutMs: 5,
      }
    ),
    (error) => error.code === 'youtube_local_info_timeout'
  );

  assert.equal(metadataChild?.killed, true);
  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(snapshotPath), false);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('a failed process-error cleanup remains retryable and close removes the snapshot and directory', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  let rmCalls = 0;
  let rmdirCalls = 0;
  const cleanupFs = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rm') {
        return async (...args) => {
          rmCalls += 1;
          if (rmCalls === 1) throw new Error(`synthetic rm failure: ${cookiePath}`);
          return target.rm(...args);
        };
      }
      if (property === 'rmdir') {
        return async (...args) => {
          rmdirCalls += 1;
          if (rmdirCalls === 1) throw new Error(`synthetic rmdir failure: ${cookiePath}`);
          return target.rmdir(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const messages = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => messages.push(String(message));
  try {
    const calls = [];
    const result = await loadWithSpawn(createSuccessfulSpawn(calls), {
      allowCookies: true,
      env: { YOUTUBE_COOKIES_PATH: cookiePath },
      cookieTempRoot: tempRoot,
      fsImpl: cleanupFs,
    });
    const snapshotPath = calls[0].args[calls[0].args.indexOf('--cookies') + 1];
    result.nodeStream.on('error', () => {});
    result.sourceProcess.emit('error', new Error(`synthetic process failure: ${cookiePath}`));
    await waitForCondition(() => rmCalls === 1 && rmdirCalls === 1);
    assert.equal(fs.existsSync(snapshotPath), true);

    result.sourceProcess.emit('close', 1);
    await waitForRemoval(snapshotPath);
    assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
    assert.equal(rmCalls, 2);
    assert.equal(rmdirCalls, 2);
    assert.deepEqual(messages, [
      '[Music] yt-dlp cookie handoff cleanup failed: code=youtube_local_cookie_cleanup_failed',
    ]);
    assert.doesNotMatch(messages.join('\n'), /synthetic-private-value|youtube\.cookies\.txt|xiaoji-cookie-test-/);
  } finally {
    logger.warn = originalWarn;
  }
});

test('partial cleanup remains retryable and already-missing artifacts count as removed', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  let rmdirCalls = 0;
  const cleanupFs = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rmdir') {
        return async (...args) => {
          rmdirCalls += 1;
          if (rmdirCalls === 1) {
            const error = new Error(`synthetic busy directory: ${cookiePath}`);
            error.code = 'EBUSY';
            throw error;
          }
          return target.rmdir(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const messages = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => messages.push(String(message));
  try {
    const handoff = await createYtdlpCookieHandoff(cookiePath, {
      fsImpl: cleanupFs,
      platform: 'win32',
      tempRoot,
    });
    const directoryPath = path.dirname(handoff.cookiePath);
    assert.equal(await handoff.cleanup(), false);
    assert.equal(fs.existsSync(handoff.cookiePath), false);
    assert.equal(fs.existsSync(directoryPath), true);

    fs.rmdirSync(directoryPath);
    assert.equal(await handoff.cleanup(), true);
    assert.equal(await handoff.cleanup(), true);
    assert.equal(fs.existsSync(directoryPath), false);
    assert.deepEqual(messages, [
      '[Music] yt-dlp cookie handoff cleanup failed: code=youtube_local_cookie_cleanup_failed',
    ]);
  } finally {
    logger.warn = originalWarn;
  }
});

test('permanent cleanup failures remain retryable and log only a fixed code', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const tempRoot = path.join(root, 'handoffs');
  fs.mkdirSync(tempRoot);
  const cleanupFs = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rm' || property === 'rmdir') {
        return async () => {
          throw new Error(`synthetic cleanup failure: ${cookiePath}`);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const messages = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => messages.push(String(message));
  try {
    const handoff = await createYtdlpCookieHandoff(cookiePath, {
      fsImpl: cleanupFs,
      platform: 'win32',
      tempRoot,
    });
    assert.equal(await handoff.cleanup(), false);
    assert.equal(await handoff.cleanup(), false);
    assert.equal(fs.existsSync(handoff.cookiePath), true);
    assert.equal(fs.existsSync(path.dirname(handoff.cookiePath)), true);
    assert.deepEqual(messages, [
      '[Music] yt-dlp cookie handoff cleanup failed: code=youtube_local_cookie_cleanup_failed',
      '[Music] yt-dlp cookie handoff cleanup failed: code=youtube_local_cookie_cleanup_failed',
    ]);
    assert.doesNotMatch(messages.join('\n'), /synthetic-private-value|youtube\.cookies\.txt|xiaoji-cookie-test-/);
  } finally {
    logger.warn = originalWarn;
  }
});

test('cookie access requires exact standard owner and guild identifiers', () => {
  const env = { BOT_OWNER_ID: 'owner-1', DISCORD_GUILD_ID: 'guild-1' };
  assert.equal(isPrivateYouTubeCookieAccess({ guild: { id: 'guild-1' }, requestedBy: 'owner-1' }, env), true);
  assert.equal(isPrivateYouTubeCookieAccess({ guild: { id: 'guild-2' }, requestedBy: 'owner-1' }, env), false);
  assert.equal(isPrivateYouTubeCookieAccess({ guild: { id: 'guild-1' }, requestedBy: 'admin-1' }, env), false);
  assert.equal(
    isPrivateYouTubeCookieAccess(
      { guild: { id: 'guild-1' }, requestedBy: 'owner-1' },
      { OWNER_ID: 'owner-1', GUILD_ID: 'guild-1' }
    ),
    false
  );
  assert.equal(isYtdlpCookieConfigurationError({ code: 'youtube_local_cookie_format_invalid' }), true);
  assert.equal(isYtdlpCookieConfigurationError({ code: 'youtube_local_info_failed' }), false);

  const userMessage = getMusicUserFacingError({ code: 'youtube_local_cookie_format_invalid' });
  assert.match(userMessage, /YOUTUBE_COOKIES_PATH|Netscape/);
  assert.doesNotMatch(userMessage, /synthetic-private-value|youtube\.cookies\.txt|xiaoji-cookie-test-/);

  const musicServiceSource = fs.readFileSync(path.join(__dirname, '../src/services/musicService.js'), 'utf8');
  assert.match(
    musicServiceSource,
    /catch \(localError\) \{\s*if \(isYtdlpCookieConfigurationError\(localError\)\) throw localError;/
  );
});
