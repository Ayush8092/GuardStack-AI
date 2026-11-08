import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputError, errorCode } from '../../utils/errors.js';

export class SandboxError extends InputError {
  constructor(message: string) {
    super(message, 'invalid_path');
  }
}

const MAX_PATH_LENGTH = 4096;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

// Windows treats these names as devices, and a UNC or device prefix leaves the drive-relative namespace entirely.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

function rejectWindowsForms(target: string): void {
  if (process.platform !== 'win32') return;
  if (/^[\\/]{2}/.test(target) || /^[A-Za-z]:(?![\\/])/.test(target)) throw new SandboxError(`Unsafe path form: ${target}`);
  if (target.split(/[\\/]/).some((segment) => WINDOWS_DEVICE.test(segment))) throw new SandboxError(`Reserved device name in path: ${target}`);
}

const SENSITIVE_NAME =
  /^(?:\.env.*|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore)|.*(?:secret|credential)s?\.[a-z0-9]+)$/i;

export function isSensitivePath(rel: string): boolean {
  return SENSITIVE_NAME.test(rel.split('/').pop() ?? '');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const canonical = (p: string): string => fs.realpathSync.native(p);
function canonicalRoot(root: string): string {
  try {
    return canonical(root);
  } catch {
    throw new SandboxError('Workspace directory not found');
  }
}

function homeDirectory(): string | undefined {
  try {
    return canonical(os.homedir());
  } catch {
    return undefined;
  }
}

export function resolveWorkspaceRoot(input: string): string {
  let root: string;
  try {
    root = canonical(path.resolve(input));
  } catch {
    throw new SandboxError(`Workspace directory not found: ${input}`);
  }
  if (!fs.statSync(root).isDirectory()) throw new SandboxError(`Not a directory: ${root}`);

  const home = homeDirectory();
  const tooBroad = root === path.parse(root).root || (home !== undefined && (root === home || root === path.dirname(home)));
  if (tooBroad) throw new SandboxError('Refusing to use a filesystem root or home directory as the workspace. Pass --root <project>.');
  return root;
}

export function resolveInside(root: string, target: string): string {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_PATH_LENGTH || target.includes('\0')) {
    throw new SandboxError('Invalid path');
  }
  const outside = () => new SandboxError(`Path is outside the workspace: ${target}`);
  rejectWindowsForms(target);
  const workspace = canonicalRoot(root);
  const lexical = path.resolve(workspace, target);
  if (!isInside(workspace, lexical)) throw outside();

  let real: string;
  try {
    real = canonical(lexical);
  } catch {
    throw new SandboxError(`Path not found inside workspace: ${target}`);
  }
  if (!isInside(workspace, real)) throw outside();
  return real;
}

export function toRelative(root: string, absolute: string): string {
  return path.relative(canonicalRoot(root), absolute).split(path.sep).join('/');
}

export type ReadHooks = {
  // Runs between the path check and the open. Tests use it to swap a directory for a symlink at exactly the wrong moment.
  afterResolve?: () => void;
};

// Node has no openat2/RESOLVE_BENEATH, so the check and the open cannot be one atomic step. Instead the open is
// verified afterwards: the descriptor we hold must still be what the path names, and that path must still be inside.
function verifyOpened(root: string, abs: string, fd: number): void {
  const workspace = canonicalRoot(root);
  const held = fs.fstatSync(fd, { bigint: true });
  let again: string;
  try {
    again = canonical(abs);
  } catch {
    throw new SandboxError('File changed while it was being read');
  }
  if (again !== abs || !isInside(workspace, again)) throw new SandboxError('Path changed while it was being checked');
  const named = fs.statSync(again, { bigint: true });
  if (named.ino !== held.ino || named.dev !== held.dev) throw new SandboxError('File changed while it was being read');
}

export function readInside(root: string, rel: string, maxBytes: number, hooks: ReadHooks = {}): Buffer {
  const abs = resolveInside(root, rel);
  if (isSensitivePath(rel) || isSensitivePath(toRelative(root, abs))) {
    throw new SandboxError(`Refusing to read sensitive file: ${rel}`);
  }
  hooks.afterResolve?.();

  let fd: number;
  try {
    fd = fs.openSync(abs, OPEN_FLAGS);
  } catch {
    throw new SandboxError(`Cannot open file: ${rel}`);
  }

  try {
    verifyOpened(root, abs, fd);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new SandboxError(`Not a regular file: ${rel}`);
    if (stat.size > maxBytes) throw new SandboxError(`File too large: ${rel}`);

    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return data.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads a workspace file that may legitimately be absent (a config file). Absence is null; a symlink that leaves
// the workspace, a sensitive name or an oversized file still throws, so a hostile repository cannot steer the read.
export function readOptionalInside(root: string, rel: string, maxBytes: number, hooks: ReadHooks = {}): Buffer | null {
  const workspace = canonicalRoot(root);
  const lexical = path.resolve(workspace, rel);
  if (!isInside(workspace, lexical)) throw new SandboxError(`Path is outside the workspace: ${rel}`);
  try {
    fs.lstatSync(lexical);
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null;
    throw new SandboxError(`Cannot access ${rel}`);
  }
  return readInside(root, rel, maxBytes, hooks);
}
