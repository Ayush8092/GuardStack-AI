import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnsafeFileError, createFileExclusive, hardLinkMessage, isHardLinked, regularFileIdentity, type FileIdentity } from '../core/security/safe-file.js';
import { errorMessage } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { CACHE_LIMITS } from './schema.js';
import { checkWindowsAcls, type WindowsAclCheck } from './windows-acl.js';

// Cache integrity. A repository can ship its own .guardian/cache.db, and the cache is trusted when a file's content hash
// matches, so a crafted database could hand the analysis fabricated symbols and imports for files it names. Every stored
// result is therefore signed with a key that lives on this machine, outside any workspace: a row that was not written by
// this installation, or was changed afterwards, or was moved to another path or content, does not verify and is ignored.
//
// The key is 32 random bytes in a file only the current user can read, created exclusively. A workspace never contains it,
// so a repository cannot know it, and the cache of one machine is worthless on another (which is intended).
//
// "Only the current user" is established differently per platform. On POSIX systems it is the owner and the mode bits. Windows
// ignores both (0700 and 0600 mean nothing there), so the directory and the file are checked against their real ACLs
// (windows-acl.ts): no principal other than the user, SYSTEM and Administrators may have access. A directory or file that fails
// the check, or whose ACL cannot be inspected, is not used, which includes a custom GUARDIAN_STATE_HOME that is shared or
// inherits broad permissions: the key is then not established and the cache stays in memory. Files on network (UNC) paths are
// refused outright, because their effective permissions are decided by the server.

const KEY_DIR = 'guardian';
const KEY_FILE = 'cache-key';
const KEY_BYTES = 32;
const TAG = 'g1';
const MAC_HEX = 64;

// Where the key lives. GUARDIAN_STATE_HOME overrides it (tests, unusual setups); it must be an absolute path.
export function machineStateDir(): string {
  const override = process.env.GUARDIAN_STATE_HOME;
  if (override && path.isAbsolute(override)) return override;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : path.join(home, 'AppData', 'Local'), KEY_DIR);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', KEY_DIR);
  const state = process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME) ? process.env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(state, KEY_DIR);
}

const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  // Only a real parent step leaves `parent`: a child named `..state` is inside it.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// POSIX only: Windows is checked through its ACLs (see windows-acl.ts), never through these bits.
function checkOwner(stat: fs.Stats, what: string, forbidden: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new UnsafeFileError(`${what} is not owned by the current user`);
  if ((stat.mode & forbidden) !== 0) throw new UnsafeFileError(`${what} is accessible to other users`);
}

// The key file is 64 lowercase hexadecimal characters, optionally followed by one line ending (the file is written with "\n"; a
// text editor on Windows may leave "\r\n"). Nothing else is part of a key: no other whitespace, no second line, no prefix.
const MAX_KEY_FILE_BYTES = KEY_BYTES * 2 + 2;
const KEY_TEXT = new RegExp(`^[0-9a-f]{${KEY_BYTES * 2}}(?:\\r?\\n)?$`);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

// Test seams: each runs at one exact point of readKey so a test can swap the file there. Production callers pass none.
// beforeOpen: the path was checked, nothing is open yet (runs once per attempt). afterOpen: the descriptor is open and verified,
// nothing was read. afterRead: the bytes were read, the final verification has not run.
export type KeyReadHooks = { beforeOpen?: () => void; afterOpen?: () => void; afterRead?: () => void };

const sameFile = (a: FileIdentity, b: { dev: bigint; ino: bigint }): boolean => a.dev === b.dev && a.ino === b.ino;

// Reads the key through one descriptor and never reads more than MAX_KEY_FILE_BYTES + 1 bytes: the size is checked on the
// descriptor before anything is read, and the read itself is capped, so a file that grows afterwards cannot make this read more.
// The descriptor is opened with O_NOFOLLOW (a link in the final position is refused, not followed), and it must be a regular file
// with one hard link that is the very file the path named a moment ago (dev/ino). After the read the same is established again,
// from the descriptor and from the path, so a file that was replaced, linked or resized while it was read is not used.
// `expected` is the identity that an earlier check (the Windows ACL inspection) was made on: another file is refused.
function readKey(file: string, platform: NodeJS.Platform, expected?: FileIdentity, hooks: KeyReadHooks = {}): Buffer {
  const changed = () => new UnsafeFileError(`${KEY_FILE} changed while it was being read`);
  // Another process may have just created the file and not written it yet: wait briefly for an empty file, nothing else.
  for (let attempt = 0; ; attempt++) {
    const named = regularFileIdentity(file);
    if (named === null) throw new UnsafeFileError(`${KEY_FILE} is missing`);
    if (expected && !sameFile(expected, named)) throw changed();
    hooks.beforeOpen?.();

    let fd: number | null = null;
    let text: Buffer;
    try {
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      } catch (err) {
        // ELOOP: the final component is (now) a symbolic link. Anything else is just as unusable.
        throw err instanceof UnsafeFileError ? err : new UnsafeFileError(`${KEY_FILE} cannot be opened safely (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`);
      }
      const held = fs.fstatSync(fd, { bigint: true });
      if (!held.isFile()) throw new UnsafeFileError(`${KEY_FILE} is not a regular file`);
      if (!sameFile(named, held)) throw changed();
      if (isHardLinked(held)) throw new UnsafeFileError(hardLinkMessage(KEY_FILE));
      if (held.size > BigInt(MAX_KEY_FILE_BYTES)) throw new UnsafeFileError(`${KEY_FILE} is larger than a key can be (${MAX_KEY_FILE_BYTES} bytes at most)`);
      checkOwner(fs.fstatSync(fd), KEY_FILE, 0o077, platform);
      hooks.afterOpen?.();

      const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
      let got = 0;
      while (got < buffer.length) {
        const n = fs.readSync(fd, buffer, got, buffer.length - got, got);
        if (n === 0) break;
        got += n;
      }
      hooks.afterRead?.();

      // The same file, still singly linked and not grown or cut, from the descriptor and from the path.
      const after = fs.fstatSync(fd, { bigint: true });
      if (!after.isFile() || !sameFile(held, after) || after.size !== held.size || got !== Number(held.size)) throw changed();
      if (isHardLinked(after)) throw new UnsafeFileError(hardLinkMessage(KEY_FILE));
      const still = regularFileIdentity(file);
      if (still === null || !sameFile(held, still)) throw changed();
      checkOwner(fs.fstatSync(fd), KEY_FILE, 0o077, platform);
      text = buffer.subarray(0, got);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // nothing useful to do
        }
      }
    }

    if (KEY_TEXT.test(text.toString('utf8'))) return Buffer.from(text.toString('utf8').slice(0, KEY_BYTES * 2), 'hex');
    if (text.length > 0 || attempt >= 20) throw new UnsafeFileError(`${KEY_FILE} does not hold a valid key`);
    pause(25);
  }
}

// The machine-owned key, created on first use. null (and a warning) when none can be established safely: the caller then
// keeps the cache in memory, which needs no key because nothing outside the process can write to it.
// `platform` and `acl` exist so the Windows path can be tested on any system; production callers pass neither.
export type KeyOptions = { platform?: NodeJS.Platform; acl?: WindowsAclCheck; hooks?: KeyReadHooks };

// A network path (\\server\share, \\?\UNC\...) has permissions decided by another machine; a `\\?\C:\` path is local.
const isNetworkPath = (p: string): boolean => p.startsWith('\\') && !/^\\\?\[A-Za-z]:\\/.test(p);

export function loadMachineKey(workspaceRoot: string, options: KeyOptions = {}): Buffer | null {
  const platform = options.platform ?? process.platform;
  const acl = options.acl ?? checkWindowsAcls;
  const requirePrivate = (targets: Array<{ path: string; what: string }>): void => {
    const problem = acl(targets);
    if (problem) throw new UnsafeFileError(problem);
  };
  try {
    const dir = machineStateDir();
    if (platform === 'win32' && isNetworkPath(dir)) throw new UnsafeFileError('the key directory is on a network path');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync.native(dir);
    if (platform === 'win32' && isNetworkPath(real)) throw new UnsafeFileError('the key directory is on a network path');
    if (inside(fs.realpathSync.native(workspaceRoot), real)) throw new UnsafeFileError('the key directory is inside the workspace');
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new UnsafeFileError('the key directory is not a directory');
    checkOwner(stat, 'the key directory', 0o022, platform);
    const keyFile = path.join(real, KEY_FILE);
    const directory = { path: real, what: 'the key directory' };
    const file = { path: keyFile, what: KEY_FILE };
    if (platform === 'win32') {
      // regularFileIdentity also refuses a symbolic link or a hard link in the key's place. An existing key is checked together with
      // its directory (one inspection); a new one is created only after the directory has passed, then checked.
      let inspected = regularFileIdentity(keyFile);
      requirePrivate(inspected !== null ? [directory, file] : [directory]);
      if (inspected === null) {
        createFileExclusive(real, KEY_FILE, `${crypto.randomBytes(KEY_BYTES).toString('hex')}\n`, 0o600);
        inspected = regularFileIdentity(keyFile);
        requirePrivate([file]);
      }
      // The ACLs were read from the path; the key is read only if it is still the file that was inspected.
      return readKey(keyFile, platform, inspected ?? undefined, options.hooks);
    }
    createFileExclusive(real, KEY_FILE, `${crypto.randomBytes(KEY_BYTES).toString('hex')}\n`, 0o600);
    return readKey(keyFile, platform, undefined, options.hooks);
  } catch (err) {
    log.warn(`No machine-owned cache key (${errorMessage(err)}); the cache stays in memory for this session`);
    return null;
  }
}

// Binds a result to its path and to the hash of the content it was computed from, so a genuine row cannot be moved to
// another file, and a changed one does not verify. JSON encoding keeps the fields unambiguous.
function mac(key: Buffer, filePath: string, hash: string, info: string): string {
  return crypto.createHmac('sha256', key).update(JSON.stringify(['guardian-cache', 1, filePath, hash, info])).digest('hex');
}

// What a sealed value adds to the result it carries: the tag, the signature and the separators around the signature.
export const SEALED_OVERHEAD = TAG.length + 1 + MAC_HEX + 1;
// A hash is a SHA-256 hex digest; the bound is looser only because callers and tests use shorter stand-ins. It exists so that no
// field that is fed to the signature can be arbitrarily long.
const MAX_HASH_CHARS = 128;

export function sealInfo(key: Buffer, filePath: string, hash: string, info: string): string {
  if (Buffer.byteLength(info) > CACHE_LIMITS.maxInfoBytes) throw new RangeError('the result is too large to be stored in the cache');
  return `${TAG}.${mac(key, filePath, hash, info)}.${info}`;
}

// The stored text when it is a genuine sealed result for exactly this path and hash, otherwise null. Every input is bounded
// first: the signature costs time proportional to the size of what it covers, and the stored text comes from a file that a
// repository can supply, so nothing oversized reaches the HMAC.
export function openInfo(key: Buffer, filePath: string, hash: string, stored: string): string | null {
  if (typeof stored !== 'string' || typeof filePath !== 'string' || typeof hash !== 'string') return null;
  // .length is O(1) and never exceeds the byte length, so it rejects the huge values without scanning them; the byte count then enforces the exact bound.
  if (hash.length > MAX_HASH_CHARS || filePath.length === 0 || filePath.length > CACHE_LIMITS.maxPathBytes || Buffer.byteLength(filePath) > CACHE_LIMITS.maxPathBytes) return null;
  const maxStored = CACHE_LIMITS.maxInfoBytes + SEALED_OVERHEAD;
  if (stored.length > maxStored || Buffer.byteLength(stored) > maxStored) return null;
  if (!stored.startsWith(`${TAG}.`) || stored[TAG.length + 1 + MAC_HEX] !== '.') return null;
  const given = stored.slice(TAG.length + 1, TAG.length + 1 + MAC_HEX);
  if (!/^[0-9a-f]+$/.test(given)) return null;
  const info = stored.slice(TAG.length + 2 + MAC_HEX);
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(mac(key, filePath, hash, info), 'hex')) ? info : null;
}
