import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { degradedCleanups, detectRepo, killProcessTree, killProcessTreeSync, terminateGitChildren } from '../src/core/git/git.js';
import { cleanup, workspace } from './helpers.js';

// Windows process-tree termination, decision logic.
//
// These tests run the REAL code paths of git.ts on POSIX with `platform: 'win32'` injected and a shell script standing in for
// taskkill.exe. That checks what the code DECIDES from taskkill's behaviour (success, failure, hang, missing, a lying success, a pid
// that is already gone) and that it never reports an incomplete cleanup as a success. It is a SIMULATION: it proves nothing about
// how Windows itself behaves. The behaviour on Windows is covered by test/process-safety-windows.test.ts, which only runs there.

after(cleanup);

const posix = process.platform !== 'win32';
const skip = posix ? false : 'simulates taskkill with a shell script; the Windows behaviour is tested in process-safety-windows.test.ts';
const scratch: string[] = [];
const spawned: ChildProcess[] = [];
after(() => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-tree-'));
  scratch.push(dir);
  return dir;
};

// Running, as opposed to exited: a killed process that nobody has reaped yet is a zombie.
function running(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch {
    return false; // ps exits non-zero when there is no such process
  }
}
const alive = (pid: number): boolean => running(pid);

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// A launcher that starts a grandchild, like git.exe starting the real git: both pids are recorded.
async function tree(dir: string): Promise<{ child: ChildProcess; launcher: number; grandchild: number }> {
  const gfile = path.join(dir, 'grandchild.pid');
  const child = spawn('sh', ['-c', `sleep 120 & echo $! > "${gfile}"; wait`], { stdio: 'ignore' });
  spawned.push(child);
  await until(() => fs.existsSync(gfile) && fs.readFileSync(gfile, 'utf8').trim() !== '', 'the grandchild to start');
  return { child, launcher: child.pid!, grandchild: Number(fs.readFileSync(gfile, 'utf8').trim()) };
}

// A stand-in taskkill. It records its arguments, then behaves as `mode` says.
function fakeTaskkill(dir: string, mode: 'kills-tree' | 'fails' | 'hangs' | 'lies' | 'not-found-after-kill' | 'not-found'): string {
  const file = path.join(dir, 'taskkill');
  const grand = path.join(dir, 'grandchild.pid');
  const killTree = `grandchild="$(cat "${grand}")"; kill -KILL "$grandchild" 2>/dev/null; i=0; while [ "$i" -lt 20 ]; do state="$(ps -o stat= -p "$grandchild" 2>/dev/null | tr -d ' ')"; case "$state" in ''|Z*) break;; esac; sleep 0.01; i=$((i + 1)); done; state="$(ps -o stat= -p "$grandchild" 2>/dev/null | tr -d ' ')"; case "$state" in ''|Z*) ;; *) exit 1;; esac; kill -KILL "$2" 2>/dev/null`;
  const body: Record<typeof mode, string> = {
    'kills-tree': `${killTree}; exit 0`,
    fails: 'exit 1',
    hangs: 'sleep 60',
    lies: 'exit 0',
    'not-found-after-kill': `${killTree}; exit 128`,
    'not-found': 'exit 128',
  };
  fs.writeFileSync(file, `#!/bin/sh\necho "$@" >> "${path.join(dir, 'taskkill.calls')}"\n${body[mode]}\n`, { mode: 0o755 });
  return file;
}
const calls = (dir: string): string[] => (fs.existsSync(path.join(dir, 'taskkill.calls')) ? fs.readFileSync(path.join(dir, 'taskkill.calls'), 'utf8').trim().split('\n') : []);

function bystander(): number {
  const other = spawn('sleep', ['120'], { stdio: 'ignore' });
  spawned.push(other);
  return other.pid!;
}

const FAST = { platform: 'win32' as const, taskkillTimeoutMs: 400, exitWaitMs: 300, isAlive: running };

for (const sync of [false, true]) {
  const kill = (child: ChildProcess, options: Parameters<typeof killProcessTree>[1]) => (sync ? Promise.resolve(killProcessTreeSync(child, options)) : killProcessTree(child, options));
  const label = sync ? 'shutdown (synchronous)' : 'cancellation (asynchronous)';

  test(`${label}: taskkill succeeds, so the launcher and the grandchild are gone and the cleanup is reported as terminated`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher, grandchild } = await tree(dir);
    const other = bystander();
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'kills-tree') });
    assert.equal(result.outcome, 'tree-terminated');
    assert.deepEqual(calls(dir), [`/pid ${launcher} /t /f`], 'taskkill targets the launcher pid, with /t /f, and nothing else');
    assert.equal(alive(launcher), false, 'no launcher remains');
    assert.equal(alive(grandchild), false, 'no descendant remains when a terminated tree is reported');
    assert.equal(alive(other), true, 'an unrelated process was not touched');
  });

  test(`${label}: taskkill missing is reported as degraded, the launcher is still killed, the unrelated process lives`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher, grandchild } = await tree(dir);
    const other = bystander();
    const result = await kill(child, { ...FAST, taskkillPath: path.join(dir, 'does-not-exist', 'taskkill.exe') });
    assert.equal(result.outcome, 'degraded', 'an incomplete cleanup is never reported as a success');
    assert.match(result.detail, /ENOENT/);
    assert.match(result.detail, /may still be running/);
    await until(() => !alive(launcher), 'the launcher to end through the fallback');
    assert.equal(alive(grandchild), true, 'the descendant survives the fallback, which is exactly why the result is degraded');
    assert.equal(alive(other), true);
  });

  test(`${label}: taskkill hanging is cut off by its timeout and reported as degraded`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher } = await tree(dir);
    const started = Date.now();
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'hangs') });
    assert.equal(result.outcome, 'degraded');
    assert.match(result.detail, /did not finish|timed out/);
    assert.ok(Date.now() - started < 5_000, 'the hung taskkill did not hold the caller');
    await until(() => !alive(launcher), 'the launcher to end through the fallback');
  });

  test(`${label}: taskkill returning failure is degraded, with its exit code`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher } = await tree(dir);
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'fails') });
    assert.equal(result.outcome, 'degraded');
    assert.match(result.detail, /exit code 1/);
    await until(() => !alive(launcher), 'the launcher to end through the fallback');
  });

  test(`${label}: a taskkill that reports success while the launcher keeps running is not accepted as success`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher } = await tree(dir);
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'lies') });
    assert.equal(result.outcome, 'degraded');
    assert.match(result.detail, /still running/);
    await until(() => !alive(launcher), 'the launcher to end through the fallback');
  });

  test(`${label}: pid/exit race, a process that already ended is never targeted`, { skip }, async () => {
    const dir = tmp();
    const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    spawned.push(child);
    await new Promise((resolve) => child.once('exit', resolve));
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'kills-tree') });
    assert.equal(result.outcome, 'exited-before-kill');
    assert.deepEqual(calls(dir), [], 'taskkill was not started: the pid may belong to another process by now');
  });

  test(`${label}: pid/exit race, taskkill finding no such process after the launcher ended is not a failure and claims nothing`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher } = await tree(dir);
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'not-found-after-kill') });
    assert.equal(result.outcome, 'exited-before-kill');
    assert.notEqual(result.outcome, 'tree-terminated', 'nothing is claimed about descendants');
    await until(() => !alive(launcher), 'the launcher to be gone');
  });

  test(`${label}: "not found" while the launcher is still running is a failure, not an excuse`, { skip }, async () => {
    const dir = tmp();
    const { child, launcher } = await tree(dir);
    const result = await kill(child, { ...FAST, taskkillPath: fakeTaskkill(dir, 'not-found') });
    assert.equal(result.outcome, 'degraded');
    await until(() => !alive(launcher), 'the launcher to end through the fallback');
  });
}

// ---- Shutdown and cancellation through the real git call path ----------------------------------------------------------------------

function blockingGit(dir: string): void {
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho $$ >> "${path.join(dir, 'git.pids')}"\nexec sleep 60\n`, { mode: 0o755 });
}
const gitPids = (dir: string): number[] => (fs.existsSync(path.join(dir, 'git.pids')) ? fs.readFileSync(path.join(dir, 'git.pids'), 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);

test('server shutdown: terminateGitChildren reports what it could not confirm, and a degraded cleanup is recorded', { skip }, async () => {
  const dir = tmp();
  blockingGit(dir);
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const original = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${original}`;
  try {
    const pending = detectRepo(root);
    await until(() => gitPids(dir).length > 0, 'the fake git to start');
    const before = degradedCleanups().length;
    const summary = terminateGitChildren({ ...FAST, taskkillPath: path.join(dir, 'missing', 'taskkill.exe') });
    assert.equal(summary.requested, 1);
    assert.equal(summary.degraded, 1, 'the summary does not call an unconfirmed tree terminated');
    assert.equal(summary.treeTerminated, 0);
    const reports = degradedCleanups();
    assert.equal(reports.length, before + 1, 'the degraded cleanup is kept, not swallowed');
    assert.equal(reports.at(-1)?.pid, gitPids(dir)[0]);
    await pending; // the launcher was killed by the fallback, so the call settles
    assert.equal(terminateGitChildren().requested, 0, 'an ended process is not tracked any more');
  } finally {
    process.env.PATH = original;
  }
});

test('a git call that completes normally leaves nothing tracked and nothing to kill', { skip }, async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const before = degradedCleanups().length;
  await detectRepo(root);
  const summary = terminateGitChildren({ platform: 'win32', taskkillPath: '/nonexistent/taskkill' });
  assert.deepEqual(summary, { requested: 0, treeTerminated: 0, exitedBeforeKill: 0, processSignalled: 0, degraded: 0 });
  assert.equal(degradedCleanups().length, before);
});

test('cancelling a git call rejects with the signal reason and ends the process', { skip }, async () => {
  const dir = tmp();
  blockingGit(dir);
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const original = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${original}`;
  try {
    const controller = new AbortController();
    const pending = detectRepo(root, controller.signal);
    const rejected = assert.rejects(pending, (err: Error) => err.name === 'AbortError');
    await until(() => gitPids(dir).length > 0, 'the fake git to start');
    controller.abort();
    await rejected;
    await until(() => !alive(gitPids(dir)[0]), 'the git process to end');
    assert.equal(terminateGitChildren().requested, 0);
  } finally {
    process.env.PATH = original;
  }
});
