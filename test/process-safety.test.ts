import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { detectRepo, terminateGitChildren } from '../src/core/git/git.js';
import { reconstructBaseline } from '../src/core/validation/baseline.js';
import { isAbort } from '../src/utils/pace.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

const posix = process.platform !== 'win32';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch: string[] = [];
after(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A `git` that records its pid and then blocks, standing in for a git process that is slow or stuck (a hung filesystem).
function blockingGit(): { dir: string; pids: () => number[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-fakegit-'));
  scratch.push(dir);
  const pidFile = path.join(dir, 'pids');
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho $$ >> "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });
  return { dir, pids: () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []) };
}

async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Running, as opposed to exited. A killed process that was reparented to init can linger as a zombie until it is reaped, and
// `kill(pid, 0)` reports a zombie as present, so the state is read from /proc.
function running(pid: number): boolean {
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

test('terminateGitChildren ends a running git process', { skip: !posix }, async () => {
  const fake = blockingGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const original = process.env.PATH;
  process.env.PATH = `${fake.dir}${path.delimiter}${original}`;
  try {
    const pending = detectRepo(root);
    await until(() => fake.pids().length > 0, 'the fake git to start');
    const pid = fake.pids()[0];
    assert.equal(running(pid) || !fs.existsSync('/proc'), true, 'the git process is running before shutdown');

    const started = performance.now();
    terminateGitChildren();
    // The call settles because its process ended, not because the 60 s block ran out.
    await pending;
    assert.ok(performance.now() - started < 10_000, 'the pending call ended promptly');
    if (fs.existsSync('/proc')) assert.equal(running(pid), false, 'the git process is gone');
  } finally {
    process.env.PATH = original;
  }
});

test('terminateGitChildren with nothing running does nothing', () => {
  assert.doesNotThrow(() => terminateGitChildren());
});

// Drives the real server over stdio: a validate_rules request is left waiting on a blocked git, then the server is told to stop.
// The server must exit and must not leave that git process behind.
async function shutdownLeavesNoGit(stop: (server: ReturnType<typeof spawn>) => void): Promise<void> {
  const fake = blockingGit();
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const server = spawn(process.execPath, ['--import', 'tsx', path.join(projectRoot, 'src/cli/index.ts'), '--root', root, 'serve'], {
    cwd: projectRoot,
    env: { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => server.on('exit', (code) => resolve(code)));
  try {
    const send = (message: object): void => void server.stdin?.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await new Promise((resolve) => server.stdout?.once('data', resolve));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'validate_rules', arguments: {} } });
    await until(() => fake.pids().length > 0, 'the server to start git');
    const pid = fake.pids()[0];
    assert.equal(running(pid), true);

    stop(server);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000));
    assert.notEqual(await Promise.race([exited, timeout]), 'timeout', 'the server exits');
    await until(() => !running(pid), 'the git process to end', 5_000);
  } finally {
    server.kill('SIGKILL');
    for (const pid of fake.pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

test('SIGTERM stops the server and the git process it was waiting on', { skip: process.platform !== 'linux' }, async () => {
  await shutdownLeavesNoGit((server) => server.kill('SIGTERM'));
});

test('the client closing the pipe stops the server and the git process it was waiting on', { skip: process.platform !== 'linux' }, async () => {
  await shutdownLeavesNoGit((server) => server.stdin?.end());
});

// ---- baseline reconstruction reads its configuration without blocking or ignoring a cancel -----------------------------

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function configRepo(count: number, extra: Record<string, string> = {}): { root: string; sha: string } {
  const files: Record<string, string> = { ...extra };
  for (let i = 0; i < count; i++) {
    files[`pkg${String(i).padStart(4, '0')}/tsconfig.json`] = '{"compilerOptions":{}}';
    files[`pkg${String(i).padStart(4, '0')}/a.ts`] = 'export const a = 1;\n';
  }
  const root = workspace(files);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, sha: git(root, 'rev-parse', 'HEAD').trim() };
}

const noProject = { tsconfigs: [], packages: [] };

test('reading many configuration files from git does not stall the event loop', async () => {
  const { root, sha } = configRepo(400);
  const ctx = context(root);
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  try {
    const rules = await reconstructBaseline(ctx, sha, noProject);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(rules?.tsconfigs.length, 400, 'every configuration file was read back');
    // Each synchronous `git show` used to hold the loop for its whole duration, one after another (about a second for this
    // repository). Reads are now asynchronous; what remains is parsing in memory.
    assert.ok(worst < 400, `the event loop stalled for ${worst.toFixed(0)} ms`);
  } finally {
    clearInterval(timer);
  }
});

test('a cancel during the configuration reads ends the work early with the cancellation', async () => {
  const { root, sha } = configRepo(400);
  const ctx = context(root);

  const fullStart = performance.now();
  await reconstructBaseline(ctx, sha, noProject);
  const full = performance.now() - fullStart;

  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), Math.max(10, full / 4));
  await assert.rejects(() => reconstructBaseline(ctx, sha, noProject, controller.signal), isAbort);
  assert.ok(performance.now() - started < full * 0.9, `cancelled run took ${(performance.now() - started).toFixed(0)} ms of a ${full.toFixed(0)} ms run`);
});

test('a configuration reached only through `extends` is still read, within a fixed budget of synchronous reads', async () => {
  // `shared/base.json` does not look like a tsconfig, so it is not part of the up-front reads; each of these needs one fallback.
  const extra: Record<string, string> = { 'shared/base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}' };
  const { root, sha } = configRepo(0, extra);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/tsconfig.json'), '{"extends":"../shared/base.json"}');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'app');
  const ctx = context(root);
  const rules = await reconstructBaseline(ctx, git(root, 'rev-parse', 'HEAD').trim(), noProject);
  const app = rules?.tsconfigs.find((c) => c.file === 'app/tsconfig.json');
  assert.ok(app, 'the extending configuration was loaded');
  assert.equal(app.paths?.some((m) => m.pattern === '@lib/*'), true, 'the inherited path alias was read through the fallback');

  // Many configurations that each need a fallback: past the budget they are reported unreadable (a partial baseline), never read
  // without limit.
  const many: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    many[`c${String(i).padStart(3, '0')}/tsconfig.json`] = `{"extends":"../shared/b${i}.json"}`;
    many[`shared/b${i}.json`] = `{"compilerOptions":{"paths":{"@a${i}/*":["a/*"]}}}`;
  }
  const big = configRepo(0, many);
  const bigRules = await reconstructBaseline(context(big.root), big.sha, noProject);
  const resolved = bigRules?.tsconfigs.filter((c) => c.paths?.length).length ?? 0;
  assert.ok(resolved > 0 && resolved < 60, `${resolved} of 60 extends targets were resolved: some, but not an unbounded number`);
  assert.equal(bigRules?.tsconfigs.length, 60, 'every configuration is still present, as incomplete where its parent was not read');
});
