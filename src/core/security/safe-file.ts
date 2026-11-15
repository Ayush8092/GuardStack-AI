import fs from 'node:fs';
import path from 'node:path';
import { InputError, errorCode } from '../../utils/errors.js';

// Writes to files directly inside a directory we own (the workspace root or .guardian/) must never be steered
// elsewhere by a symlink, a dangling symlink, a device or a FIFO that a hostile repository planted there.
// Node has no openat2/RESOLVE_BENEATH, so each write combines three checks: refuse links up front (works where
// O_NOFOLLOW does not exist), open with O_NOFOLLOW (+ O_EXCL when creating, which never follows a link, dangling or
// not), then confirm the descriptor we hold is still the file the path names before a single byte is written.
//
// Windows is the exception to the open step. There O_NOFOLLOW is 0 and O_CREAT|O_EXCL *follows* a dangling symlink and
// creates its target, so createFileExclusive never opens the destination on Windows. It creates the file in a private
// staging directory next to the destination (same volume) and publishes it with fs.linkSync, which fails with EEXIST
// for any existing entry, a dangling symlink included, and so can neither overwrite nor follow anything. If hard links
// are unavailable it fails closed (UnsafeFileError); it never falls back to O_EXCL.
//
// What this cannot guarantee (Node exposes no openat/unlinkat/O_DIRECTORY handles, so the directory cannot be pinned):
// - The checks are before-and-after comparisons, not atomic. A directory or file swapped in the instant after the
//   last check, or swapped and restored between two checks, is not detected. Nothing is written to a path that has
//   already been seen to change, but a swap in the final instruction window cannot be ruled out.
// - Directory identity is the (dev, ino) pair of the directory plus its realpath. On a file system that reports
//   ino 0 or reuses numbers (some network and FUSE mounts, FAT-family volumes) two directories can look identical.
// - Hard-link publication (Windows) is still path based: linkSync takes two paths. The directory is verified (realpath,
//   dev/ino) and the staged file is re-checked immediately before the link and the result is verified immediately
//   after, but a swap in the instant between the last check and linkSync is not excluded; it is detected afterwards and
//   the file this call created is removed. If the directory is renamed away between staging and publication, the
//   staging directory goes with it, cannot be reached by path and is left behind inside the moved directory while
//   nothing is created at the destination. If removing the staged name or directory fails (a handle held by an
//   antivirus or indexer, say) an empty `.guardian-stage-*` directory can remain; the link-count check then fails
//   the creation closed. Hard links need NTFS or ReFS: FAT, exFAT and some network shares refuse them and creation
//   fails with an UnsafeFileError there. A file exists at the destination, empty, between publication and the write,
//   exactly as with the exclusive open. Whether an open handle inside a directory stops it being renamed on Windows
//   is a sharing-mode behaviour this code does not rely on.
// - When a created file has to be discarded the unlink goes by path after an identity check, so a swap in the gap
//   between that check and the unlink could remove the wrong entry. The file is only removed if it is verified to be
//   the one this call created, and a failure to remove it is not reported as success.

export class UnsafeFileError extends InputError {
  constructor(message: string) {
    super(message, 'unsafe_file');
  }
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export type FileIdentity = { dev: bigint; ino: bigint };

// A file with more than one directory entry can be changed through any of them: appending to a hard-linked .gitignore
// or opening a hard-linked cache.db edits the other path too, and no symlink check notices. The link count comes from
// lstat/fstat on every platform Node supports (NTFS and ReFS included, where libuv reads the real count), so the
// same check serves Windows and Unix. File systems that cannot hold hard links (FAT, exFAT) always report 1, and
// a file system that misreports the count cannot be detected from here.
export function isHardLinked(stat: { nlink: bigint | number }): boolean {
  return BigInt(stat.nlink) > 1n;
}

export function hardLinkMessage(name: string): string {
  return `${name} has more than one hard link`;
}

type Target = { file: string; name: string; realDir: string; dirId: FileIdentity };

function target(dir: string, name: string): Target {
  if (name.length === 0 || name === '.' || name === '..' || path.basename(name) !== name || name.includes('\0') || name.includes('\\')) {
    throw new UnsafeFileError(`Unsafe file name: ${name}`);
  }
  return { file: path.join(dir, name), name, realDir: realDirectory(dir, name), dirId: directoryIdentity(dir, name) };
}

function realDirectory(dir: string, name: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    throw new UnsafeFileError(`Cannot resolve the directory that holds ${name}`);
  }
}

// dev/ino of the directory itself. realpath alone cannot tell a directory from a different one later created at the
// same path (rename away, mkdir again): the string is identical, the identity is not.
function directoryIdentity(dir: string, name: string): FileIdentity {
  try {
    const stat = fs.statSync(dir, { bigint: true });
    if (stat.isDirectory()) return { dev: stat.dev, ino: stat.ino };
  } catch {
    // reported below
  }
  throw new UnsafeFileError(`Cannot resolve the directory that holds ${name}`);
}

// null when the path does not exist. A symlink (dangling or not), directory, device, FIFO or hard-linked file is refused.
export function regularFileIdentity(file: string): FileIdentity | null {
  const name = path.basename(file);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new UnsafeFileError(`Cannot inspect ${name} (${code ?? 'unknown error'})`);
  }
  if (stat.isSymbolicLink()) throw new UnsafeFileError(`${name} is a symbolic link`);
  if (!stat.isFile()) throw new UnsafeFileError(`${name} is not a regular file`);
  if (isHardLinked(stat)) throw new UnsafeFileError(hardLinkMessage(name));
  return { dev: stat.dev, ino: stat.ino };
}

// The descriptor we hold must still be what the path names, that path must not have become a link (symbolic or
// hard, the latter re-read from the descriptor itself), and the directory above it must still be the very directory
// we started in: same realpath and same dev/ino.
function verifyHeld(t: Target, dir: string, fd: number, held: fs.BigIntStats, action = 'updated'): void {
  const changed = () => new UnsafeFileError(`${t.name} changed while it was being ${action}`);
  let named: fs.BigIntStats;
  try {
    named = fs.lstatSync(t.file, { bigint: true });
  } catch {
    throw changed();
  }
  if (named.isSymbolicLink() || !named.isFile() || named.ino !== held.ino || named.dev !== held.dev) throw changed();
  if (isHardLinked(named) || isHardLinked(fs.fstatSync(fd, { bigint: true }))) throw new UnsafeFileError(hardLinkMessage(t.name));
  verifyDirectory(t, dir, action);
}

// The directory above the file must still be the one we started in: same realpath and same dev/ino.
function verifyDirectory(t: Target, dir: string, action: string): void {
  const now = directoryIdentity(dir, t.name);
  if (realDirectory(dir, t.name) !== t.realDir || now.ino !== t.dirId.ino || now.dev !== t.dirId.dev) {
    throw new UnsafeFileError(`${t.name} changed while it was being ${action}`);
  }
}

// Test seams: each runs at one exact point of createFileExclusive so a test can swap something there. Production
// callers never pass them.
// beforeOpen: after the existence check, before anything is created. afterOpen: the new file exists at its path and
// is ours, not yet verified. afterWrite: the data is written, the last verification has not run. beforePublish is
// called by the hard-link strategy only, immediately before the staged file is linked into place.
export type CreateHooks = { beforeOpen?: () => void; afterOpen?: () => void; afterWrite?: () => void; beforePublish?: () => void };

// Creates `dir/name` only if nothing exists there. Returns true when created, false when a regular file was
// already present (left untouched). Throws UnsafeFileError for a link or any non-regular file, without writing.
// Like appendToRegularFile, the descriptor from the exclusive open is checked against the path and against the
// directory it was opened in before a byte is written and again after. If a check fails the file this call created
// is removed, but only while the path still names that very file; anything else found there is left alone.
// On Windows the file is published by hard link instead (see createFileByHardLink); the results are the same.
export function createFileExclusive(dir: string, name: string, data: string, mode = 0o644, hooks: CreateHooks = {}): boolean {
  // Read at call time. On Windows O_CREAT|O_EXCL without O_NOFOLLOW would follow a dangling symlink, so that path is
  // never taken there.
  if (process.platform === 'win32') return createFileByHardLink(dir, name, data, mode, hooks);
  return createFileByExclusiveOpen(dir, name, data, mode, hooks);
}

function createFileByExclusiveOpen(dir: string, name: string, data: string, mode: number, hooks: CreateHooks): boolean {
  const t = target(dir, name);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (regularFileIdentity(t.file) !== null) return false;
    hooks.beforeOpen?.();

    let fd: number;
    try {
      fd = fs.openSync(t.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode);
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      // Lost a race: something appeared after the check above. Accept it only if it is a plain file. If it has
      // vanished again, look once more rather than report a file that is not there.
      if (regularFileIdentity(t.file) !== null) return false;
      continue;
    }
    return finishCreate(t, dir, fd, data, hooks);
  }
  throw new UnsafeFileError(`${name} kept changing while it was being created`);
}

const STAGE_PREFIX = '.guardian-stage-';
const STAGED_NAME = 'file';

type StageNames = { dir: string; dirId: FileIdentity | null; file: string; held: fs.BigIntStats | null };
type Stage = StageNames & { dirId: FileIdentity; held: fs.BigIntStats; fd: number };

// Windows strategy, exported so the same code is tested everywhere (createFileExclusive selects it on win32).
// 1. mkdtemp makes a fresh, randomly named directory inside `dir` (so on the same volume); it never reuses an entry.
// 2. The staged file is created with O_EXCL inside that private directory, where nothing can be waiting at the name.
// 3. The directory is verified, then fs.linkSync(staged, destination) publishes it. A link never overwrites: EEXIST
//    for a regular file means "already present" (false), for a symlink, dangling or not, or anything else it means
//    UnsafeFileError, and the existing entry is not touched either way. Any other link failure (no hard links on this
//    volume, say) fails closed with UnsafeFileError; there is no fallback to opening the destination.
// 4. The staged name is removed and finishCreate then verifies and writes through the descriptor exactly as it does
//    for the exclusive open, including discarding the destination if it is still the file this call created.
// Only what this call created is ever removed: the staged file while it is still that inode, the staging directory
// with a non-recursive rmdir while it is still that directory, so anything foreign inside it survives.
export function createFileByHardLink(dir: string, name: string, data: string, mode = 0o644, hooks: CreateHooks = {}): boolean {
  const t = target(dir, name);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (regularFileIdentity(t.file) !== null) return false;
    hooks.beforeOpen?.();

    const stage = openStage(t, dir, mode);
    let linked = false;
    try {
      hooks.beforePublish?.();
      verifyStage(t, dir, stage);
      try {
        fs.linkSync(stage.file, t.file);
        linked = true;
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') throw publishFailure(t.name, err);
      }
    } catch (err) {
      releaseStage(stage);
      throw err;
    }

    if (!linked) {
      // Something already has the name. Accept it only if it is a plain file; if it vanished again, look once more.
      releaseStage(stage);
      if (regularFileIdentity(t.file) !== null) return false;
      continue;
    }

    try {
      removeStageNames(stage); // the link count must be back to 1 before the file is verified
      return finishCreate(t, dir, stage.fd, data, hooks); // closes the descriptor
    } finally {
      removeStageNames(stage); // again, now that the descriptor is closed and cannot hold the directory
    }
  }
  throw new UnsafeFileError(`${name} kept changing while it was being created`);
}

function openStage(t: Target, dir: string, mode: number): Stage {
  const stageDir = fs.mkdtempSync(path.join(dir, STAGE_PREFIX));
  const names: StageNames = { dir: stageDir, dirId: null, file: path.join(stageDir, STAGED_NAME), held: null };
  let fd: number | null = null;
  try {
    const made = fs.lstatSync(stageDir, { bigint: true });
    if (!made.isDirectory()) throw new UnsafeFileError(`${t.name} changed while it was being created`);
    names.dirId = { dev: made.dev, ino: made.ino };
    verifyDirectory(t, dir, 'created');

    fd = fs.openSync(names.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode);
    const held = fs.fstatSync(fd, { bigint: true });
    names.held = held;
    const named = fs.lstatSync(names.file, { bigint: true });
    if (!held.isFile() || isHardLinked(held) || !named.isFile() || named.ino !== held.ino || named.dev !== held.dev) {
      throw new UnsafeFileError(`${t.name} changed while it was being created`);
    }
    return { ...names, dirId: names.dirId, held, fd };
  } catch (err) {
    if (fd !== null) closeQuietly(fd);
    removeStageNames(names);
    throw err;
  }
}

// Right before publication: the destination directory is still ours, and the staging directory and staged file are
// still what this call made.
function verifyStage(t: Target, dir: string, stage: Stage): void {
  const changed = () => new UnsafeFileError(`${t.name} changed while it was being created`);
  verifyDirectory(t, dir, 'created');
  try {
    const d = fs.lstatSync(stage.dir, { bigint: true });
    const f = fs.lstatSync(stage.file, { bigint: true });
    if (!d.isDirectory() || d.ino !== stage.dirId.ino || d.dev !== stage.dirId.dev) throw changed();
    if (!f.isFile() || f.ino !== stage.held.ino || f.dev !== stage.held.dev) throw changed();
  } catch (err) {
    throw err instanceof UnsafeFileError ? err : changed();
  }
}

function publishFailure(name: string, err: unknown): UnsafeFileError {
  const code = errorCode(err);
  if (code === 'ENOENT') return new UnsafeFileError(`${name} changed while it was being created`);
  return new UnsafeFileError(
    `${name} cannot be created safely: publishing it with a hard link failed${code ? ` (${code})` : ''}. ` +
      'This needs a file system that supports hard links (NTFS and ReFS do; FAT, exFAT and some network shares do not). Nothing was created.',
  );
}

function releaseStage(stage: Stage): void {
  closeQuietly(stage.fd);
  removeStageNames(stage);
}

// Never throws and never recurses: rmdir fails on a directory that holds anything else, and that is the point.
function removeStageNames(s: StageNames): void {
  if (!s.dirId) return;
  try {
    if (s.held) {
      const f = fs.lstatSync(s.file, { bigint: true });
      if (f.isFile() && f.ino === s.held.ino && f.dev === s.held.dev) fs.unlinkSync(s.file);
    }
  } catch {
    // Already gone, or not removable; the leftovers are covered in the header comment.
  }
  try {
    const d = fs.lstatSync(s.dir, { bigint: true });
    if (d.isDirectory() && d.ino === s.dirId.ino && d.dev === s.dirId.dev) fs.rmdirSync(s.dir);
  } catch {
    // Same.
  }
}

// writeSync may write fewer bytes than asked (a full disk, a quota) and reports that only through its return value. A short write
// is an incomplete file, so it is an error here and never a success.
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new UnsafeFileError('the file could not be written completely');
    offset += written;
  }
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Nothing useful to do.
  }
}

function finishCreate(t: Target, dir: string, fd: number, data: string, hooks: CreateHooks): true {
  let held: fs.BigIntStats | null = null;
  let failed = false;
  try {
    held = fs.fstatSync(fd, { bigint: true });
    hooks.afterOpen?.();
    if (!held.isFile()) throw new UnsafeFileError(`${t.name} is not a regular file`);
    verifyHeld(t, dir, fd, held, 'created');
    if (data.length > 0) {
      writeAll(fd, data);
      hooks.afterWrite?.();
      verifyHeld(t, dir, fd, held, 'created');
    }
    return true;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    fs.closeSync(fd);
    if (failed && held) discardCreated(t, held);
  }
}

// Removes the file this call created, but only if the path still names it. Never throws: the original error is
// the one worth reporting. A hard-linked name is removed too, which only drops this entry; the inode and its
// other name were created empty by this call, so nothing that existed before is lost.
function discardCreated(t: Target, created: fs.BigIntStats): void {
  try {
    const named = fs.lstatSync(t.file, { bigint: true });
    if (named.isFile() && named.ino === created.ino && named.dev === created.dev) fs.unlinkSync(t.file);
  } catch {
    // Best effort; see the limits in the header comment.
  }
}

// Appends to an existing regular file. `decide` sees the current text and returns what to append, or null for
// nothing. The write goes through the descriptor that was verified, never through a path that could be swapped.
export function appendToRegularFile(dir: string, name: string, maxBytes: number, decide: (current: string) => string | null): boolean {
  const t = target(dir, name);
  if (regularFileIdentity(t.file) === null) throw new UnsafeFileError(`${name} does not exist`);

  let fd: number;
  try {
    fd = fs.openSync(t.file, fs.constants.O_RDWR | fs.constants.O_APPEND | NOFOLLOW | NONBLOCK);
  } catch (err) {
    if (errorCode(err) === 'ELOOP') throw new UnsafeFileError(`${name} is a symbolic link`);
    throw err;
  }

  try {
    const held = fs.fstatSync(fd, { bigint: true });
    if (!held.isFile()) throw new UnsafeFileError(`${name} is not a regular file`);
    if (isHardLinked(held)) throw new UnsafeFileError(hardLinkMessage(name));
    if (held.size > BigInt(maxBytes)) throw new UnsafeFileError(`${name} is too large to update safely`);
    verifyHeld(t, dir, fd, held);

    const size = Number(held.size);
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, data, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }

    const addition = decide(data.subarray(0, offset).toString('utf8'));
    if (addition === null) return false;

    verifyHeld(t, dir, fd, held);
    writeAll(fd, addition);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
