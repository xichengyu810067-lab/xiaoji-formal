'use strict';

// One small JSON document the bot keeps between runs, in the retained data folder
// (retainedDataSource.js). Two jobs, nothing else:
//
//   - load(): read the document once. It never throws, and a file that could not be used leaves one
//     fixed-code log line (never a path, a value or an ID):
//       absent      there is no file: the caller starts from empty;
//       loaded      the caller's validate() accepted the content;
//       invalid     the content is not the document the caller expects (damaged, too large, or not
//                   valid for validate()): the caller starts from empty, and the file is first renamed
//                   to <file>.corrupt (only the latest one is kept) so that it can be looked at later;
//       unreadable  the file could not be read at all, after a short retry of the errors a scanner or a
//                   backup program holding the file causes on Windows. It may well hold a good history,
//                   so it is never overwritten: see "blocked" below.
//   - markDirty() / flush(): write it back. Writes are merged: markDirty() only schedules one write
//     after flushDelayMs (a timer that does not keep the process alive), however many changes come
//     before it, and flush() writes at once (the shutdown). A write goes to <file>.tmp, is written in
//     full (a short write is finished or fails), is fsynced, and is renamed over the file, so a crash
//     leaves the earlier file whole. A write that fails (a scanner holding the file on Windows is
//     retried first) keeps the change pending, logs one fixed-code line at most once a minute, and is
//     tried again after retryDelayMs.
//
// Blocked: after an `unreadable` load the helper does not write. Before every write it reads the file
// again; once that works the caller's merge() is given the document, so what the caller learned in
// the meantime is added to the history instead of replacing it, and then the write goes ahead. Until
// then the change stays pending in memory and the old file stays as it is.
//
// Memory is the truth while the process runs; the file is what a restart starts from. A change made
// less than flushDelayMs before a crash is lost.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FLUSH_DELAY_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const LOG_INTERVAL_MS = 60_000;
// Windows can briefly refuse to replace, or to open, a file that a scanner, indexer or backup program
// holds open.
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// A read is tried once and then up to three times more, waiting 25, 50 and 100 ms.
const READ_ATTEMPTS = 4;
const READ_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
const NAME_TOKEN = /^[A-Z][A-Z0-9_]{1,47}$/u;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/u;

const ABSENT = Object.freeze({ state: 'absent', value: null });
const INVALID = Object.freeze({ state: 'invalid', value: null });
const UNREADABLE = Object.freeze({ state: 'unreadable', value: null });

function blockingPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function causeCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return CODE_TOKEN.test(code) ? code : 'UNEXPECTED_ERROR';
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function renameWithRetry(from, to, { filesystem, platform, pause }) {
  let delay = 20;
  for (let attempt = 1; ; attempt += 1) {
    try {
      filesystem.renameSync(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32' || !RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error;
      pause(delay);
      delay *= 2;
    }
  }
}

// Writes the whole of `buffer` to the descriptor: a write that took less is continued, and one that
// took nothing, or that left the file at another size than the text, is a failure.
function writeAll(descriptor, buffer, filesystem) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = filesystem.writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw codedError('RETAINED_JSON_SHORT_WRITE');
    }
    offset += written;
  }
  filesystem.fsyncSync(descriptor);
  if (filesystem.fstatSync(descriptor).size !== buffer.length) throw codedError('RETAINED_JSON_SHORT_WRITE');
}

// Writes `text` as the whole content of `filePath`: <file>.tmp, written in full, fsync, rename, then the
// folder's fsync (best effort; it fails harmlessly where a folder cannot be opened). A file name taken by
// anything but a regular file is refused. A temporary file that is not complete is never renamed.
function writeFileAtomically(filePath, text, { filesystem = fs, platform = process.platform, pause = blockingPause } = {}) {
  filesystem.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing = null;
  try {
    existing = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && !existing.isFile()) throw codedError('RETAINED_JSON_NOT_A_FILE');
  const tempPath = `${filePath}.tmp`;
  const buffer = Buffer.from(text, 'utf8');
  const descriptor = filesystem.openSync(tempPath, 'w', 0o600);
  let renamed = false;
  try {
    try {
      writeAll(descriptor, buffer, filesystem);
    } finally {
      filesystem.closeSync(descriptor);
    }
    renameWithRetry(tempPath, filePath, { filesystem, platform, pause });
    renamed = true;
  } finally {
    if (!renamed) {
      try { filesystem.unlinkSync(tempPath); } catch { /* keep the original failure */ }
    }
  }
  try {
    const directory = filesystem.openSync(path.dirname(filePath), 'r');
    try { filesystem.fsyncSync(directory); } finally { filesystem.closeSync(directory); }
  } catch { /* a folder that cannot be synced is not a failed write */ }
}

// `name` is the upper-case token the log codes start with (<NAME>_FILE_INVALID, <NAME>_FILE_UNREADABLE,
// <NAME>_FILE_MERGE_FAILED, <NAME>_WRITE_FAILED, <NAME>_WRITE_DEFERRED). A merge() that throws leaves the
// file as it is, like an unreadable one: the write is deferred and the merge is tried again at the next
// write. `resolvePath` is called when the file is first needed, so
// a store can be created before the data folder is known.
function createRetainedJsonFile({
  name,
  resolvePath,
  logger = null,
  now = () => Date.now(),
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  filesystem = fs,
  platform = process.platform,
  pause = blockingPause,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof name !== 'string' || !NAME_TOKEN.test(name)) throw new TypeError('Retained JSON file name is invalid.');
  if (typeof resolvePath !== 'function') throw new TypeError('Retained JSON file needs a path resolver.');
  let filePath = null;
  let build = null;
  let timer = null;
  // Set by an `unreadable` load: the file is not written until it has been read, and its content merged.
  let blocked = false;
  let lateLoad = null;
  const lastLogged = new Map();

  function pathOf() {
    if (filePath === null) filePath = resolvePath();
    return filePath;
  }

  function log(suffix, detail = '') {
    const code = `${name}_${suffix}`;
    let at;
    try { at = Number(now()); } catch { at = Number.NaN; }
    const last = lastLogged.get(code);
    if (Number.isFinite(at) && last !== undefined && at >= last && at - last < LOG_INTERVAL_MS) return;
    if (Number.isFinite(at)) lastLogged.set(code, at);
    try { logger?.warn?.(`[RETAINED_DATA] code=${code}${detail}`); } catch { /* logging never blocks */ }
  }

  function cancelTimer() {
    if (timer !== null) {
      try { clearTimer(timer); } catch { /* nothing to cancel */ }
      timer = null;
    }
  }

  function schedule(delayMs) {
    if (timer !== null) return;
    try {
      timer = setTimer(() => {
        timer = null;
        flush();
      }, delayMs);
      timer?.unref?.();
    } catch {
      timer = null;
    }
  }

  // What is at the path: { kind: 'absent' }, { kind: 'invalid', keep } (not a regular file, or too
  // large; keep says the file may be put aside) or { kind: 'text', text }. The errors a file in use
  // causes are retried; any other error, or one that lasts, is thrown.
  function readFile() {
    const target = pathOf();
    let delay = 25;
    for (let attempt = 1; ; attempt += 1) {
      try {
        let stat;
        try {
          stat = filesystem.lstatSync(target);
        } catch (error) {
          if (error?.code === 'ENOENT') return { kind: 'absent' };
          throw error;
        }
        if (!stat.isFile()) return { kind: 'invalid', keep: false };
        if (stat.size > maxBytes) return { kind: 'invalid', keep: true };
        return { kind: 'text', text: filesystem.readFileSync(target, 'utf8') };
      } catch (error) {
        if (!READ_RETRY_CODES.has(error?.code) || attempt >= READ_ATTEMPTS) throw error;
        pause(delay);
        delay *= 2;
      }
    }
  }

  // The file that is not the expected document is put aside as <file>.corrupt (replacing an earlier
  // one), so the next write does not destroy it. Whether that worked is the line's `kept=corrupt`.
  function putAside() {
    try {
      filesystem.renameSync(pathOf(), `${pathOf()}.corrupt`);
      return true;
    } catch {
      return false;
    }
  }

  function invalid(keep) {
    const kept = keep && putAside();
    log('FILE_INVALID', kept ? ' kept=corrupt' : '');
    return INVALID;
  }

  function attempt(validate) {
    let read;
    try {
      read = readFile();
    } catch (error) {
      log('FILE_UNREADABLE', ` cause=${causeCode(error)}`);
      return UNREADABLE;
    }
    if (read.kind === 'absent') return ABSENT;
    if (read.kind === 'invalid') return invalid(read.keep);
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return invalid(true);
    }
    let value = null;
    try {
      value = validate(parsed);
    } catch {
      value = null;
    }
    if (value === null || value === undefined) return invalid(true);
    return Object.freeze({ state: 'loaded', value });
  }

  // Reads the file and hands its parsed content to validate(), which returns the state to keep or null
  // for a document that is not the expected one. Returns { state, value } (see the top of this file);
  // value is null unless state is `loaded`. `merge`, if given, is called with a validated document
  // when a file that was `unreadable` is read later, before the first write that follows.
  function load(validate, { merge = null } = {}) {
    const result = attempt(validate);
    if (result.state === 'unreadable') {
      blocked = true;
      lateLoad = { validate, merge };
    }
    return result;
  }

  // Reads the file that could not be read, once more, and merges it. True when writing may go ahead.
  function unblock() {
    const result = attempt(lateLoad.validate);
    if (result.state === 'unreadable') return false;
    if (result.state === 'loaded' && lateLoad.merge) {
      try {
        lateLoad.merge(result.value);
      } catch {
        log('FILE_MERGE_FAILED');
        return false;
      }
    }
    blocked = false;
    lateLoad = null;
    return true;
  }

  // Writes what the last markDirty() described. True when nothing is pending afterwards.
  function flush() {
    cancelTimer();
    if (build === null) return true;
    if (blocked && !unblock()) {
      // The old file is left as it is; the change stays pending in memory.
      log('WRITE_DEFERRED');
      schedule(retryDelayMs);
      return false;
    }
    try {
      const text = `${JSON.stringify(build())}\n`;
      writeFileAtomically(pathOf(), text, { filesystem, platform, pause });
    } catch (error) {
      log('WRITE_FAILED', ` cause=${causeCode(error)}`);
      // The change stays pending, and is written again after the retry delay.
      schedule(retryDelayMs);
      return false;
    }
    build = null;
    return true;
  }

  // `describe` returns the JSON-serializable document as it is when the write happens.
  function markDirty(describe) {
    if (typeof describe !== 'function') throw new TypeError('Retained JSON file needs a document builder.');
    build = describe;
    schedule(flushDelayMs);
  }

  return Object.freeze({
    load,
    markDirty,
    flush,
    get pending() { return build !== null; },
    get blocked() { return blocked; },
  });
}

module.exports = {
  DEFAULT_FLUSH_DELAY_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETRY_DELAY_MS,
  createRetainedJsonFile,
  writeFileAtomically,
};
