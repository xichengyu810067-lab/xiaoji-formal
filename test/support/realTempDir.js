'use strict';

// Temporary directories for tests, named by their real path.
//
// A runner's temp directory is often reached through a short name or a link: C:\Users\RUNNER~1\AppData\Local\Temp on
// Windows (an 8.3 name), /var pointing at /private/var on macOS. Code that takes a data root refuses one whose real path
// differs from the path it was given, so a test that builds its root from os.tmpdir() as it stands stops at that check
// on such a runner, before it reaches the behavior it is about. These helpers resolve the path with
// fs.realpathSync.native, the call that code makes: the plain fs.realpathSync leaves a short name as it is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The real path of the system temp directory.
function realTmpdir() {
  return fs.realpathSync.native(os.tmpdir());
}

// Like fs.mkdtempSync(path.join(os.tmpdir(), prefix)), but returns the real path of the new directory.
function makeRealTempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// The real path of `target`, or, for a path that does not exist yet, the real path of its nearest existing ancestor
// followed by the names that are missing. A link anywhere in the path is followed, so the result is where a removal
// would really act.
function realPathOfTarget(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...[...missing].reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isStrictlyInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// A temp directory that is a drive root or the home directory would make "inside the temp directory" mean almost
// everything the user owns, so nothing is removed under one.
function assertSafeTempDirectory(tempDirectory) {
  if (tempDirectory === path.parse(tempDirectory).root) throw new Error('unsafe temp directory');
  let home;
  try {
    home = fs.realpathSync.native(os.homedir());
  } catch {
    home = path.resolve(os.homedir());
  }
  if (path.relative(home, tempDirectory) === '') throw new Error('unsafe temp directory');
}

// Removes a directory made by makeRealTempDir. The path must be absolute, and its real path (links followed) must be
// inside the real temp directory: anything outside it, or the temp directory itself, is refused, and so is a path that
// only looks like it is inside because it goes through a link that leads out.
function removeRealTempDir(directory) {
  if (typeof directory !== 'string' || directory === '' || !path.isAbsolute(directory)) {
    throw new Error('unsafe cleanup target');
  }
  const tempDirectory = realTmpdir();
  assertSafeTempDirectory(tempDirectory);
  const resolved = realPathOfTarget(path.resolve(directory));
  if (!isStrictlyInside(tempDirectory, resolved)) {
    throw new Error('unsafe cleanup target');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = { makeRealTempDir, realTmpdir, removeRealTempDir };
