import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { degradedCleanups, detectRepo, killProcessTree, terminateGitChildren } from '../src/core/git/git.js';
import { cleanup, workspace } from './helpers.js';

// Git for Windows starts `git.exe` as a launcher that runs the real git and waits for it, and git starts helpers of its own.
// Node's kill() on Windows ends only the process it is given, so shutting the server down (or cancelling a request) has to
// end the whole tree. These tests build that shape with real processes: a `git.exe` that starts a grandchild and then blocks.
// They only run on Windows, where the behaviour is different; on other platforms process-safety.test.ts covers shutdown.

after(cleanup);

const windows = process.platform === 'win32' ? false : 'the process tree behaviour under test is specific to Windows';
const scratch: string[] = [];
after(() => scratch.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A `git.exe` (a copy of node.exe, so the executable really is named git) that, through a preload, starts a grandchild
// process, records both pids, and blocks its own thread for a minute.
function launcherGit(): { dir: string; pids: () => { child: number; grandchild: number } | null; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-wingit-'));
  scratch.push(dir);
  fs.copyFileSync(process.execPath, path.join(dir, 'git.exe'));
  const pidFile = path.join(dir, 'pids.json');
  fs.writeFileSync(
    path.join(dir, 'preload.cjs'),
    [
      // The same preload serves the fake taskkill.exe of the failure tests: it fails at once (FAKE_TASKKILL_MODE=fail) or blocks, as a
      // hung taskkill would. It must not start the grandchild: it is not git.
      "if (process.argv[1]?.toLowerCase() === '/pid') { if (process.env.FAKE_TASKKILL_MODE === 'fail') process.exit(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); process.exit(1); }",
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const pidFile = ${JSON.stringify(pidFile)};`,
      // The grandchild must not run this preload again, or the tree would never stop growing.
      "const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });",
      "fs.writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grand.pid }));",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); process.exit(0);",
    ].join('\n'),
  );
  return {
    dir,
    env: { NODE_OPTIONS: `--require ${JSON.stringify(path.join(dir, 'preload.cjs'))}`, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    pids: () => {
      try {
        return JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
      } catch {
        return null;
      }
    },
  };
}

// The pending call's own process is spawned with this process's environment, so the fake is put in place around the call.
async function withFakeGit<T>(fake: ReturnType<typeof launcherGit>, body: () => Promise<T>): Promise<T> {
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, PATH: process.env.PATH };
  Object.assign(process.env, fake.env);
  try {
    return await body();
  } finally {
    if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved.NODE_OPTIONS;
    process.env.PATH = saved.PATH;
    const left = fake.pids();
    for (const pid of left ? [left.child, left.grandchild] : []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

test('terminateGitChildren ends the git process and the process it started', { skip: windows }, async () => {
  const fake = launcherGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  await withFakeGit(fake, async () => {
    const pending = detectRepo(root);
    await until(() => fake.pids() !== null, 'the fake git and its child to start');
    const { child, grandchild } = fake.pids()!;
    assert.ok(alive(child) && alive(grandchild), 'both processes are running before shutdown');

    terminateGitChildren();
    await pending;
    await until(() => !alive(child), 'the git process to end', 10_000);
    await until(() => !alive(grandchild), 'the process git started to end', 10_000);
  });
});

test('cancelling a request ends the git process and the process it started', { skip: windows }, async () => {
  const fake = launcherGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  await withFakeGit(fake, async () => {
    const controller = new AbortController();
    const pending = detectRepo(root, controller.signal);
    const rejected = assert.rejects(pending, (err: Error) => err.name === 'AbortError');
    await until(() => fake.pids() !== null, 'the fake git and its child to start');
    const { child, grandchild } = fake.pids()!;

    controller.abort();
    await rejected;
    await until(() => !alive(child), 'the git process to end', 10_000);
    await until(() => !alive(grandchild), 'the process git started to end', 10_000);
  });
});

// An unrelated process, started before the tree is killed, that must still be running afterwards.
function bystander(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  return { pid: child.pid!, stop: () => child.kill() };
}

test('killing the tree leaves an unrelated process running', { skip: windows }, async () => {
  const fake = launcherGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const other = bystander();
  try {
    await withFakeGit(fake, async () => {
      const controller = new AbortController();
      const pending = detectRepo(root, controller.signal);
      const rejected = assert.rejects(pending, (err: Error) => err.name === 'AbortError');
      await until(() => fake.pids() !== null, 'the fake git and its child to start');
      const { child, grandchild } = fake.pids()!;
      controller.abort();
      await rejected;
      await until(() => !alive(child) && !alive(grandchild), 'the whole tree to end', 10_000);
      assert.ok(alive(other.pid), 'a process that is not part of the tree was not touched');
    });
  } finally {
    other.stop();
  }
});

test('a git call that ends normally leaves nothing for shutdown to kill, and nothing is started to kill it', { skip: windows }, async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const state = await detectRepo(root);
  assert.equal(state.ok, false, 'a directory that is not a repository is reported, not an error');
  assert.doesNotThrow(() => terminateGitChildren());
});

// taskkill is found under %SystemRoot%\\System32, read when the process is killed. Pointing SystemRoot at a scratch directory makes
// taskkill missing (ENOENT) or, with a node.exe named taskkill.exe that blocks, hung. Only the launcher can then be killed, so the
// requirements are the ones the fallback can keep: the launcher ends, the caller is released instead of waiting on pipes that a
// surviving descendant holds, nothing hangs, and the cleanup is REPORTED as degraded (never as a success). Descendant termination is
// NOT guaranteed there, so it is not asserted, and the report says so.
async function withSystemRoot<T>(root: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = root;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
}

// A missing, hung, or failing taskkill must trigger the degraded fallback.
// Keep the real SystemRoot untouched and inject the executable path instead.
for (const mode of ['missing', 'hung', 'failing'] as const) {
  test(`when taskkill is ${mode}, cancelling still ends the launcher and releases the caller`, { skip: windows }, async () => {
    const fake = launcherGit();
    const taskkillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-taskkill-'));
    scratch.push(taskkillDir);

    const taskkillPath = path.join(taskkillDir, 'taskkill.exe');
    if (mode !== 'missing') {
      fs.copyFileSync(process.execPath, taskkillPath);
    }

    const root = workspace({ 'a.ts': 'export const a = 1;\n' });
    await withFakeGit(fake, async () => {
      const controller = new AbortController();
      const pending = detectRepo(root, controller.signal, {
        taskkillPath,
        ...(mode === 'hung' ? { taskkillTimeoutMs: 500 } : {}),
      });
      const rejected = assert.rejects(pending, (err: Error) => err.name === 'AbortError');

      await until(() => fake.pids() !== null, 'the fake git and its child to start');
      const { child } = fake.pids()!;
      assert.ok(alive(child), 'the fake git launcher must still be alive before cancellation');

      const before = degradedCleanups().length;
      const savedMode = process.env.FAKE_TASKKILL_MODE;
      if (mode === 'failing') process.env.FAKE_TASKKILL_MODE = 'fail';

      try {
        controller.abort();
        await rejected;
        await until(() => !alive(child), 'the git launcher to end through the fallback', 10_000);
        await until(() => degradedCleanups().length > before, 'the degraded cleanup to be reported', 10_000);
      } finally {
        if (savedMode === undefined) delete process.env.FAKE_TASKKILL_MODE;
        else process.env.FAKE_TASKKILL_MODE = savedMode;
      }

      const report = degradedCleanups().at(-1)!;
      assert.equal(report.outcome, 'degraded');
      assert.equal(report.pid, child);
      assert.match(report.detail, /may still be running/);
    });
  });
}

test('terminateGitChildren with nothing running does nothing on Windows either', { skip: windows }, () => {
  assert.doesNotThrow(() => terminateGitChildren());
});

// ---- Success is only reported when it is confirmed ----------------------------------------------------------------------------------

test('shutdown with a working taskkill reports a terminated tree and leaves no descendant', { skip: windows }, async () => {
  const fake = launcherGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const other = bystander();
  try {
    await withFakeGit(fake, async () => {
      const pending = detectRepo(root);
      await until(() => fake.pids() !== null, 'the fake git and its child to start');
      const { child, grandchild } = fake.pids()!;
      const before = degradedCleanups().length;

      const summary = terminateGitChildren();
      await pending;
      assert.equal(summary.requested, 1);
      assert.equal(summary.treeTerminated, 1);
      assert.equal(summary.degraded, 0);
      assert.equal(degradedCleanups().length, before, 'a confirmed cleanup is not recorded as degraded');
      // The report says "terminated", so nothing of the tree may be left.
      await until(() => !alive(child) && !alive(grandchild), 'the whole tree to end', 10_000);
      assert.ok(alive(other.pid), 'a process that is not part of the tree was not touched');
    });
  } finally {
    other.stop();
  }
});

test('cancelling with a working taskkill ends the tree and records no degraded cleanup', { skip: windows }, async () => {
  const fake = launcherGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  await withFakeGit(fake, async () => {
    const controller = new AbortController();
    const pending = detectRepo(root, controller.signal);
    const rejected = assert.rejects(pending, (err: Error) => err.name === 'AbortError');
    await until(() => fake.pids() !== null, 'the fake git and its child to start');
    const { child, grandchild } = fake.pids()!;
    const before = degradedCleanups().length;
    controller.abort();
    await rejected;
    await until(() => !alive(child) && !alive(grandchild), 'the whole tree to end', 10_000);
    assert.equal(degradedCleanups().length, before);
  });
});

test('pid/exit race: a process that has already ended is not targeted by taskkill', { skip: windows }, async () => {
  const done = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => done.once('exit', resolve));
  const other = bystander();
  try {
    const result = await killProcessTree(done);
    assert.equal(result.outcome, 'exited-before-kill');
    assert.ok(alive(other.pid), 'taskkill was not pointed at a pid that may have been reused');
  } finally {
    other.stop();
  }
});
