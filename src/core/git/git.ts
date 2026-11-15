import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { InputError, errorCode } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';

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
const TASKKILL_TIMEOUT_MS = 3_000;
// After taskkill reports success the launcher must actually be gone; this is how long that is awaited before the cleanup is called degraded.
const TREE_EXIT_WAIT_MS = 1_000;
// When taskkill could not end the tree, only the launcher is killed (see killProcessTree). A descendant that is still running holds the
// pipes execFile waits on, so the pending call would not settle until it ends. Windows callers are released this long after a
// kill was requested: the taskkill timeout, the wait for the launcher to exit, and a margin.
const RELEASE_GRACE_MS = TASKKILL_TIMEOUT_MS + TREE_EXIT_WAIT_MS + 1_000;

// Repo config can name programs to run. fsmonitor, external diff and textconv are disabled on every call. Filter drivers
// (`filter.<name>.clean|smudge|process`) cannot be switched off from the command line, and `git diff <commit>` runs the clean
// filter of every file whose attributes name one, so `assertNoRepositoryCommands` refuses a repository that defines one.
const SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];

// ---- Process-tree termination ---------------------------------------------------------------------------------------------------
//
// What the product promises: on Windows, shutdown and cancellation end the whole Git process tree (README, "Process level").
// What can be guaranteed from Node without a native module: nothing stronger than taskkill's own report. A Job Object would contain
// the tree reliably, but Node cannot create one, and the alternatives (a native addon, a bundled helper executable, or compiling C#
// through PowerShell on every call) add a dependency, an unsigned binary or a code-generation step to a local-first tool that has
// none, so none was added. The promise is therefore made as narrow as it can be kept:
//   - `tree-terminated`    taskkill /T /F exited 0 AND the launcher was then seen to be gone. This is taskkill's report that it ended
//                          every process it found in the tree; descendants are not enumerated independently here.
//   - `exited-before-kill` the launcher had already ended (or taskkill said the pid no longer exists): nothing was killed, and nothing
//                          is claimed about descendants. A pid of an ended process is never targeted, it may belong to someone else now.
//   - `degraded`           taskkill is missing, failed, timed out, or did not remove the launcher. Only the launcher is killed, processes
//                          it started MAY STILL BE RUNNING, and this is logged and kept in `degradedCleanups()`. It is never reported
//                          as a success.
//   - `process-signalled`  not Windows: the process itself received SIGTERM (POSIX helpers are not tracked, see the README).
// taskkill finds descendants through the parent that is still alive, so it runs BEFORE the launcher is killed; killing the launcher
// first would orphan the tree. taskkill is part of Windows (System32), so nothing is added.

export type TreeCleanup = {
  pid: number;
  outcome: 'tree-terminated' | 'exited-before-kill' | 'degraded' | 'process-signalled';
  detail: string;
};

export type KillOptions = {
  // Seams for tests; production uses the defaults.
  platform?: NodeJS.Platform;
  taskkillPath?: string;
  taskkillTimeoutMs?: number;
  exitWaitMs?: number;
  // How the async and synchronous paths check whether the launcher is alive (default: signal 0).
  isAlive?: (pid: number) => boolean;
};

const TASKKILL_NOT_FOUND = 128;
const isGone = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const taskkillExecutable = (): string => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const reasonOf = (err: unknown): string => errorCode(err) ?? (err instanceof Error ? err.message : String(err));

// The launcher is killed directly when the tree could not be ended. A failure of that kill is part of the report, not swallowed.
function killLauncher(child: ChildProcess): string {
  try {
    return child.kill('SIGTERM') ? 'the launcher was killed' : 'the launcher could not be signalled (it may already have ended)';
  } catch (err) {
    return `killing the launcher failed (${reasonOf(err)})`;
  }
}

function degraded(child: ChildProcess, why: string): TreeCleanup {
  return { pid: child.pid ?? -1, outcome: 'degraded', detail: `${why}; ${killLauncher(child)}, processes it started may still be running` };
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (isGone(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), ms);
    const finish = (gone: boolean): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(gone);
    };
    const onExit = (): void => finish(true);
    child.once('exit', onExit);
  });
}

// Asynchronous: for cancellation and timeouts, where the event loop keeps running.
export function killProcessTree(child: ChildProcess, options: KillOptions = {}): Promise<TreeCleanup> {
  const pid = child.pid;
  if (pid === undefined || isGone(child)) return Promise.resolve({ pid: pid ?? -1, outcome: 'exited-before-kill', detail: 'the process had already ended' });
  if ((options.platform ?? process.platform) !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve({ pid, outcome: 'process-signalled', detail: 'SIGTERM sent to the process itself' });
  }
  const exitWait = options.exitWaitMs ?? TREE_EXIT_WAIT_MS;
  return new Promise<TreeCleanup>((resolve) => {
    let settled = false;
    const done = (result: TreeCleanup): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let killer: ChildProcess;
    try {
      // A taskkill that hangs must not leave the tree running with no fallback: spawn's timeout ends it, it closes with a null code,
      // and that is handled like any other failure.
      killer = spawn(options.taskkillPath ?? taskkillExecutable(), ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS });
    } catch (err) {
      done(degraded(child, `taskkill could not be started (${reasonOf(err)})`));
      return;
    }
    killer.once('error', (err) => done(degraded(child, `taskkill could not be run (${reasonOf(err)})`)));
    killer.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        // Success is only reported once the launcher is really gone.
        void waitForExit(child, exitWait).then((gone) =>
          done(gone ? { pid, outcome: 'tree-terminated', detail: 'taskkill /T /F reported success and the launcher ended' } : degraded(child, 'taskkill reported success but the launcher is still running')),
        );
      } else if (code === TASKKILL_NOT_FOUND && (isGone(child) || !(options.isAlive ?? pidAlive)(pid))) {
        done({ pid, outcome: 'exited-before-kill', detail: 'the process ended before taskkill reached it' });
      } else {
        done(degraded(child, code === null ? `taskkill did not finish (${signal ?? 'terminated'}; timeout ${options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS} ms)` : `taskkill failed with exit code ${code}`));
      }
    });
    killer.unref();
  });
}

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
};

// Synchronous: for shutdown, where the process exits right after and nothing could wait for an asynchronous taskkill.
export function killProcessTreeSync(child: ChildProcess, options: KillOptions = {}): TreeCleanup {
  const pid = child.pid;
  if (pid === undefined || isGone(child)) return { pid: pid ?? -1, outcome: 'exited-before-kill', detail: 'the process had already ended' };
  if ((options.platform ?? process.platform) !== 'win32') {
    child.kill('SIGTERM');
    return { pid, outcome: 'process-signalled', detail: 'SIGTERM sent to the process itself' };
  }
  const timeout = options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS;
  const result = spawnSync(options.taskkillPath ?? taskkillExecutable(), ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout });
  if (result.error) return degraded(child, `taskkill could not be run or timed out (${reasonOf(result.error)})`);
  const alive = options.isAlive ?? pidAlive;
  // While this function blocks, Node cannot update `exitCode`, so an ended launcher is also recognised by its pid no longer existing.
  if (result.status === TASKKILL_NOT_FOUND && (isGone(child) || !alive(pid))) return { pid, outcome: 'exited-before-kill', detail: 'the process ended before taskkill reached it' };
  if (result.status !== 0) return degraded(child, result.status === null ? `taskkill did not finish (${result.signal ?? 'terminated'})` : `taskkill failed with exit code ${result.status}`);
  // The 'exit' event cannot be delivered while this function blocks, so the launcher is looked for by pid, right after taskkill ended it.
  const deadline = Date.now() + (options.exitWaitMs ?? TREE_EXIT_WAIT_MS);
  while (alive(pid) && Date.now() < deadline) sleepSync(25);
  return alive(pid) ? degraded(child, 'taskkill reported success but the launcher is still running') : { pid, outcome: 'tree-terminated', detail: 'taskkill /T /F reported success and the launcher ended' };
}

const MAX_REPORTS = 20;
const degradedReports: TreeCleanup[] = [];
// The most recent cleanups that could not be confirmed (newest last, bounded). Empty means none happened, not that nothing was missed.
export const degradedCleanups = (): readonly TreeCleanup[] => [...degradedReports];

function record(result: TreeCleanup): TreeCleanup {
  if (result.outcome === 'degraded') {
    degradedReports.push(result);
    if (degradedReports.length > MAX_REPORTS) degradedReports.shift();
    log.warn(`Windows git cleanup degraded (pid ${result.pid}): ${result.detail}`);
  } else {
    log.debug(`git process cleanup: ${result.outcome} (pid ${result.pid})`);
  }
  return result;
}

// Every asynchronous git process that is still alive. A per-request signal kills its own process, but when the whole server shuts
// down (a signal, the client closing the pipe, a fatal error) nothing is left to enforce the call's timeout, so a git process that is
// still running would outlive the server. `terminateGitChildren` ends them. A process stays here until it has really exited, not until
// its caller was released: a launcher that could not be killed must still be found by shutdown.
const running = new Set<ChildProcess>();
// One kill attempt at a time per process (a cancellation and the timeout can both ask), and the last outcome for the error text.
const killing = new Map<ChildProcess, Promise<TreeCleanup>>();
const lastCleanup = new WeakMap<ChildProcess, TreeCleanup>();

function requestKill(child: ChildProcess, options: KillOptions = {}): Promise<TreeCleanup> {
  const existing = killing.get(child);
  if (existing) return existing;
  const attempt = killProcessTree(child, options).then((result) => {
    lastCleanup.set(child, result);
    return record(result);
  });
  killing.set(child, attempt);
  void attempt.finally(() => killing.delete(child));
  return attempt;
}

// The signal is handled here and not passed to execFile: Node's own abort handler is registered first and would end the
// launcher before the tree is killed. The pending call then rejects, and every caller turns that into the signal's reason.
// On Windows the timeout is enforced here too, for the same reason (execFile's timeout also ends only the launcher).
async function tracked<T>(pending: Promise<T> & { child: ChildProcess }, signal?: AbortSignal, killOptions: KillOptions = {},

): Promise<T> {
  const { child } = pending;
  running.add(child);
  child.once('exit', () => running.delete(child));
  const windows = process.platform === 'win32';
  let release: ((reason: unknown) => void) | undefined;
  const released = windows ? new Promise<never>((_, reject) => (release = reject)) : undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  const stop = (reason: () => unknown): void => {
    void requestKill(child, killOptions);
    if (!release || graceTimer) return;
    // If the tree is gone, `pending` settles first and this never fires.
    graceTimer = setTimeout(() => release?.(reason()), RELEASE_GRACE_MS);
    graceTimer.unref();
  };
  const onAbort = (): void => stop(() => signal?.reason ?? new Error('git was cancelled'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = windows
    ? setTimeout(
        () =>
          stop(() => {
            const cleanup = lastCleanup.get(child);
            return new Error(cleanup?.outcome === 'degraded' ? `git timed out (process-tree cleanup degraded: ${cleanup.detail})` : 'git timed out');
          }),
        TIMEOUT_MS - 500,
      )
    : undefined;
  timer?.unref();
  try {
    if (!released) return await pending;
    pending.catch(() => undefined); // when released first, a later rejection of the abandoned call is not an unhandled one
    return await Promise.race([pending, released]);
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    signal?.removeEventListener('abort', onAbort);
    // A call that settled has a process that ended; one that was released may still have a running launcher, which stays tracked.
    if (child.pid === undefined || isGone(child)) running.delete(child);
  }
}

export type ShutdownSummary = { requested: number; treeTerminated: number; exitedBeforeKill: number; processSignalled: number; degraded: number };

// Ends every running git process, synchronously. The summary says what was confirmed: `degraded` counts processes whose tree could not
// be confirmed ended (also logged and kept in `degradedCleanups()`).
export function terminateGitChildren(options: KillOptions = {}): ShutdownSummary {
  const summary: ShutdownSummary = { requested: 0, treeTerminated: 0, exitedBeforeKill: 0, processSignalled: 0, degraded: 0 };
  for (const child of [...running]) {
    const result = record(killProcessTreeSync(child, options));
    summary.requested++;
    if (result.outcome === 'tree-terminated') summary.treeTerminated++;
    else if (result.outcome === 'exited-before-kill') summary.exitedBeforeKill++;
    else if (result.outcome === 'process-signalled') summary.processSignalled++;
    else summary.degraded++;
  }
  return summary;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
}

// `signal` kills the git process when the caller cancels (an MCP client that gave up). A cancelled call throws the signal's
// reason; it is never turned into "git failed" or "file unreadable", which would be read as a result.
async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
  maxBuffer = MAX_BUFFER,
  killOptions: KillOptions = {},
): Promise<string> {
  signal?.throwIfAborted();
  try {
    const { stdout } = await tracked(
      run('git', [...SAFE_ARGS, ...args], {
        cwd: root,
        env: gitEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer,
        encoding: 'utf8',
      }),
      signal,
      killOptions,
    );
    return stdout;
  } catch (err) {
    signal?.throwIfAborted();
    throw err;
  }
}

const tryGit = (
  root: string,
  args: string[],
  signal?: AbortSignal,
  killOptions: KillOptions = {},
): Promise<string | null> =>
  git(root, args, signal, MAX_BUFFER, killOptions).catch(() => {
    signal?.throwIfAborted();
    return null;
  });
export async function detectRepo(
  root: string,
  signal?: AbortSignal,
  killOptions: KillOptions = {},
): Promise<RepoState> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree'], signal, MAX_BUFFER, killOptions);
  } catch (err) {
    signal?.throwIfAborted();
    return { ok: false, reason: errorCode(err) === 'ENOENT' ? 'git-not-found' : 'not-a-repository' };
  }

  const head = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], signal, killOptions);
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

// Commands a repository can make git run while it compares the working tree with a commit. Only the repository's own
// configuration is looked at (local and worktree scope, includes followed): the user's global and system configuration is
// trusted. These are exactly what Git for LFS installs; any other filter command is refused instead of being executed.
const LFS_FILTERS = new Set(['git-lfs clean -- %f', 'git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f', 'git-lfs filter-process', 'git-lfs filter-process --skip']);
const FILTER_COMMAND = /^filter\.(.+)\.(clean|smudge|process)$/i;

export async function assertNoRepositoryCommands(root: string, signal?: AbortSignal): Promise<void> {
  let raw: string;
  try {
    raw = await git(root, ['config', '--list', '--show-scope', '-z'], signal);
  } catch (err) {
    signal?.throwIfAborted();
    // Without a readable configuration nothing can be said about what a filter would run: fail closed.
    throw new InputError(`Cannot read the repository's git configuration (${errorCode(err) ?? 'git failed'}); git 2.26 or newer is required`, 'unsafe_repository_config');
  }
  // With -z and --show-scope every entry is two NUL-terminated fields: the scope, then `key\nvalue`.
  const fields = raw.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    const entry = fields[i + 1];
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);
    if (scope !== 'local' && scope !== 'worktree') continue;
    if (FILTER_COMMAND.test(key) && !LFS_FILTERS.has(value.trim())) {
      throw new InputError(`Refusing to run git: the repository's configuration defines a filter command (${key}) that git would execute. Remove it from .git/config to continue.`, 'unsafe_repository_config');
    }
  }
}

export async function collectChanges(root: string, repo: Extract<RepoState, { ok: true }>, baseRef?: string, signal?: AbortSignal): Promise<ChangeSet> {
  let baseSha = repo.head;
  let baseLabel = repo.head ? 'HEAD' : 'no commits yet';

  if (baseRef) {
    if (!REF.test(baseRef)) throw new InputError('Invalid git ref', 'invalid_input');
    const resolved = (await tryGit(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], signal))?.trim();
    if (!resolved) throw new InputError(`Unknown git ref: ${baseRef}`, 'invalid_input');
    const mergeBase = repo.head ? (await tryGit(root, ['merge-base', resolved, repo.head], signal))?.trim() : undefined;
    baseSha = mergeBase || resolved;
    baseLabel = `${baseRef} (${baseSha.slice(0, 7)})`;
  } else if (repo.head) {
    baseLabel = `HEAD (${repo.head.slice(0, 7)})`;
  }

  if (baseSha) await assertNoRepositoryCommands(root, signal);
  const tracked = baseSha
    ? parseNameStatus(await git(root, ['diff', '--name-status', '-z', '-M', '--relative', '--no-ext-diff', '--no-textconv', baseSha], signal))
    : [];
  const untracked = splitNul(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal));
  const everything = baseSha ? [] : splitNul(await git(root, ['ls-files', '-z'], signal));

  const byPath = new Map<string, Change>();
  for (const change of tracked) byPath.set(change.path, change);
  for (const file of [...untracked, ...everything]) if (!byPath.has(file)) byPath.set(file, { status: 'added', path: file });

  const changes = [...byPath.values()].filter((c) => isSafeRelative(c.path) && (!c.oldPath || isSafeRelative(c.oldPath)));
  return { baseSha, baseLabel, changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

export type Blob = { ok: true; data: Buffer } | { ok: false; reason: 'too-large' | 'unreadable' };

export async function readBlob(root: string, sha: string, rel: string, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  if (!isSafeRelative(rel)) return { ok: false, reason: 'unreadable' };
  signal?.throwIfAborted();
  try {
    const { stdout } = await tracked(
      run('git', [...SAFE_ARGS, 'show', '--no-textconv', `${sha}:./${rel}`], {
        cwd: root,
        env: gitEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: maxBytes + 1024,
        encoding: 'buffer',
      }),
      signal,
    );
    return stdout.length > maxBytes ? { ok: false, reason: 'too-large' } : { ok: true, data: stdout };
  } catch (err) {
    signal?.throwIfAborted();
    return { ok: false, reason: errorCode(err) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too-large' : 'unreadable' };
  }
}

export async function readAtCommit(root: string, sha: string, rel: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
  const blob = await readBlob(root, sha, rel, maxBytes, signal);
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
export async function listTreeAtCommit(root: string, sha: string, signal?: AbortSignal): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await git(root, ['ls-tree', '-r', '-z', sha, '--', '.'], signal);
  } catch {
    signal?.throwIfAborted();
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
