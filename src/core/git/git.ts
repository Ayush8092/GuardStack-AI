import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { InputError, errorCode } from '../../utils/errors.js';

const run = promisify(execFile);

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type Change = { status: ChangeStatus; path: string; oldPath?: string };

export type RepoState =
  | { ok: true; head: string | null }
  | { ok: false; reason: 'git-not-found' | 'not-a-repository' };

export type ChangeSet = {
  // Commit the working tree is compared against; null when the repository has no commits yet.
  baseSha: string | null;
  baseLabel: string;
  changes: Change[];
};

const REF = /^[A-Za-z0-9][\w./@{}~^-]{0,199}$/;
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// Repo config can name programs to run (fsmonitor, external diff, textconv); every call disables them.
const SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
}

async function git(root: string, args: string[], maxBuffer = MAX_BUFFER): Promise<string> {
  const { stdout } = await run('git', [...SAFE_ARGS, ...args], { cwd: root, env: gitEnv(), timeout: TIMEOUT_MS, maxBuffer, encoding: 'utf8' });
  return stdout;
}

const tryGit = (root: string, args: string[]): Promise<string | null> => git(root, args).catch(() => null);

export async function detectRepo(root: string): Promise<RepoState> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    return { ok: false, reason: errorCode(err) === 'ENOENT' ? 'git-not-found' : 'not-a-repository' };
  }
  const head = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  return { ok: true, head: head?.trim() || null };
}

const STATUS: Record<string, ChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified', R: 'renamed', C: 'added' };

// `git diff --name-status -z` output: STATUS NUL path NUL, with two paths for renames and copies.
export function parseNameStatus(raw: string): Change[] {
  const tokens = raw.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const status = STATUS[code[0]];
    if (!status) continue;

    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (newPath) changes.push(code[0] === 'R' ? { status, path: newPath, oldPath } : { status, path: newPath });
    } else {
      const file = tokens[++i];
      if (file) changes.push({ status, path: file });
    }
  }
  return changes;
}

const splitNul = (raw: string): string[] => raw.split('\0').filter(Boolean);

function isSafeRelative(p: string): boolean {
  const normalized = path.posix.normalize(p);
  return !path.posix.isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../');
}

export async function collectChanges(root: string, repo: Extract<RepoState, { ok: true }>, baseRef?: string): Promise<ChangeSet> {
  let baseSha = repo.head;
  let baseLabel = repo.head ? 'HEAD' : 'no commits yet';

  if (baseRef) {
    if (!REF.test(baseRef)) throw new InputError('Invalid git ref', 'invalid_input');
    const resolved = (await tryGit(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]))?.trim();
    if (!resolved) throw new InputError(`Unknown git ref: ${baseRef}`, 'invalid_input');
    const mergeBase = repo.head ? (await tryGit(root, ['merge-base', resolved, repo.head]))?.trim() : undefined;
    baseSha = mergeBase || resolved;
    baseLabel = `${baseRef} (${baseSha.slice(0, 7)})`;
  } else if (repo.head) {
    baseLabel = `HEAD (${repo.head.slice(0, 7)})`;
  }

  const tracked = baseSha
    ? parseNameStatus(await git(root, ['diff', '--name-status', '-z', '-M', '--relative', '--no-ext-diff', '--no-textconv', baseSha]))
    : [];
  const untracked = splitNul(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const everything = baseSha ? [] : splitNul(await git(root, ['ls-files', '-z']));

  const byPath = new Map<string, Change>();
  for (const change of tracked) byPath.set(change.path, change);
  for (const file of [...untracked, ...everything]) if (!byPath.has(file)) byPath.set(file, { status: 'added', path: file });

  const changes = [...byPath.values()].filter((c) => isSafeRelative(c.path) && (!c.oldPath || isSafeRelative(c.oldPath)));
  return { baseSha, baseLabel, changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

export type Blob = { ok: true; data: Buffer } | { ok: false; reason: 'too-large' | 'unreadable' };

export async function readBlob(root: string, sha: string, rel: string, maxBytes: number): Promise<Blob> {
  if (!isSafeRelative(rel)) return { ok: false, reason: 'unreadable' };
  try {
    const { stdout } = await run('git', [...SAFE_ARGS, 'show', '--no-textconv', `${sha}:./${rel}`], {
      cwd: root,
      env: gitEnv(),
      timeout: TIMEOUT_MS,
      maxBuffer: maxBytes + 1024,
      encoding: 'buffer',
    });
    return stdout.length > maxBytes ? { ok: false, reason: 'too-large' } : { ok: true, data: stdout };
  } catch (err) {
    return { ok: false, reason: errorCode(err) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too-large' : 'unreadable' };
  }
}

export async function readAtCommit(root: string, sha: string, rel: string, maxBytes: number): Promise<Buffer | null> {
  const blob = await readBlob(root, sha, rel, maxBytes);
  return blob.ok ? blob.data : null;
}

// Reads a small file (a config) synchronously; used where the caller is itself synchronous.
export function readAtCommitSync(root: string, sha: string, rel: string, maxBytes: number): Buffer | null {
  if (!isSafeRelative(rel)) return null;
  try {
    const stdout = execFileSync('git', [...SAFE_ARGS, 'show', '--no-textconv', `${sha}:./${rel}`], {
      cwd: root,
      env: gitEnv(),
      timeout: TIMEOUT_MS,
      maxBuffer: maxBytes + 1024,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.length > maxBytes ? null : stdout;
  } catch {
    return null;
  }
}

// Regular files tracked at `sha`, relative to the workspace root. Symlinks and submodules are left out,
// the same way the working-tree walk leaves them out.
export async function listTreeAtCommit(root: string, sha: string): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await git(root, ['ls-tree', '-r', '-z', sha, '--', '.']);
  } catch {
    return null;
  }
  const files: string[] = [];
  for (const entry of raw.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    if (type === 'blob' && (mode === '100644' || mode === '100755') && isSafeRelative(file)) files.push(file);
  }
  return files;
}
