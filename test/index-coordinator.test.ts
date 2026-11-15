import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Ctx } from '../src/context.js';
import type { Project } from '../src/core/ast/indexer.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { MAX_CONCURRENT_INDEXES, createIndexCoordinator } from '../src/core/ast/shared-index.js';
import { cleanup, context, workspace } from './helpers.js';

// MCP requests share one coordinator: identical requests coalesce, the number of simultaneous scans is bounded, and a cancelled
// request never cancels a scan another request still needs.

after(cleanup);

const fake = (root: string): Ctx => ({ root, config: {} as Ctx['config'], db: {} as Ctx['db'] });
const project = (root: string, tag: string): Project => ({ root, files: [], tsconfigs: [], packages: [], foreignExtensions: [], knownPaths: [tag], eligible: 0, truncated: false, skipped: [], configProblems: [], parseIssues: [], unindexed: 0, complete: true });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const abortError = (): DOMException => new DOMException('cancelled', 'AbortError');

// A scan the test controls: it records when it started, and finishes (or fails) only when told to.
function controlled() {
  const scans: Array<{ ctx: Ctx; signal: AbortSignal; finish: (tag?: string) => void; fail: (e: Error) => void }> = [];
  let active = 0;
  let peak = 0;
  const index = (ctx: Ctx, options: { signal?: AbortSignal }): Promise<Project> =>
    new Promise((resolve, reject) => {
      active++;
      peak = Math.max(peak, active);
      const signal = options.signal!;
      const end = (): void => void active--;
      signal.addEventListener('abort', () => (end(), reject(signal.reason)), { once: true });
      scans.push({
        ctx,
        signal,
        finish: (tag = 'done') => (end(), resolve(project(ctx.root, tag))),
        fail: (e) => (end(), reject(e)),
      });
    });
  return { index, scans, peak: () => peak, active: () => active };
}

test('identical simultaneous requests for one workspace share a single scan', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index });
  const ctx = fake('/w');
  const results = Promise.all([run(ctx), run(ctx), run(ctx), run(ctx)]);
  await tick();
  assert.equal(c.scans.length, 1, 'one scan serves all four');
  c.scans[0].finish('shared');
  const all = await results;
  assert.equal(all.length, 4);
  for (const p of all) assert.deepEqual(p.knownPaths, ['shared']);
});

test('callers never share mutable state: each result is its own object', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index });
  const ctx = fake('/w');
  const pending = Promise.all([run(ctx), run(ctx)]);
  await tick();
  c.scans[0].finish();
  const [a, b] = await pending;
  assert.notEqual(a, b);
  a.knownPaths.push('mutated');
  assert.deepEqual(b.knownPaths, ['done']);
});

test('a request that arrives while a scan runs gets a newer scan, not the one already in progress', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index });
  const ctx = fake('/w');
  const first = run(ctx);
  await tick();
  const second = run(ctx);
  const third = run(ctx);
  await tick();
  assert.equal(c.scans.length, 1, 'the second scan waits for the first to end; one workspace is never scanned twice at once');
  c.scans[0].finish('old');
  assert.deepEqual((await first).knownPaths, ['old']);
  await tick();
  assert.equal(c.scans.length, 2, 'the late requests share one fresh scan');
  c.scans[1].finish('fresh');
  assert.deepEqual((await second).knownPaths, ['fresh']);
  assert.deepEqual((await third).knownPaths, ['fresh']);
  assert.equal(c.peak(), 1);
});

test('the number of simultaneous scans is bounded across workspaces', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index, maxConcurrent: 2 });
  const pending = ['/a', '/b', '/c', '/d', '/e'].map((root) => run(fake(root)));
  await tick();
  assert.equal(c.scans.length, 2, 'only two started');
  c.scans[0].finish();
  await tick();
  assert.equal(c.scans.length, 3, 'a slot freed, the next one started');
  while (c.scans.length < 5 || c.active() > 0) {
    await tick();
    c.scans.filter((_, i) => i < c.scans.length).forEach((s) => s.finish());
  }
  assert.equal((await Promise.all(pending)).length, 5);
  assert.ok(c.peak() <= 2, `peak was ${c.peak()}`);
});

test('the default bound is small and fixed', () => {
  assert.ok(MAX_CONCURRENT_INDEXES >= 1 && MAX_CONCURRENT_INDEXES <= 4);
});

test('requests for different workspaces get their own results', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index });
  const a = run(fake('/a'));
  const b = run(fake('/b'));
  await tick();
  assert.equal(c.scans.length, 2);
  c.scans.find((s) => s.ctx.root === '/b')!.finish('b');
  c.scans.find((s) => s.ctx.root === '/a')!.finish('a');
  assert.equal((await a).root, '/a');
  assert.equal((await b).root, '/b');
});

test('one cancelled request does not cancel a scan another request still needs', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index });
  const ctx = fake('/w');
  const stay = new AbortController();
  const leave = new AbortController();
  const kept = run(ctx, stay.signal);
  const cancelled = run(ctx, leave.signal);
  await tick();
  leave.abort(abortError());
  await assert.rejects(cancelled, (e: Error) => e.name === 'AbortError');
  assert.equal(c.scans[0].signal.aborted, false, 'the scan goes on for the request that is still waiting');
  c.scans[0].finish('kept');
  assert.deepEqual((await kept).knownPaths, ['kept']);
});

test('the scan is aborted once its last request has been cancelled, and the next request starts a fresh one', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index });
  const ctx = fake('/w');
  const one = new AbortController();
  const two = new AbortController();
  const a = run(ctx, one.signal);
  const b = run(ctx, two.signal);
  await tick();
  one.abort(abortError());
  two.abort(abortError());
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(c.scans[0].signal.aborted, true);
  const next = run(ctx);
  await tick();
  assert.equal(c.scans.length, 2, 'the aborted scan is not reused');
  c.scans[1].finish('next');
  assert.deepEqual((await next).knownPaths, ['next']);
});

test('a request cancelled before it is started, or while waiting for a slot, leaves at once and frees the queue', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index, maxConcurrent: 1 });
  const first = run(fake('/a'));
  await tick();
  const controller = new AbortController();
  const queued = run(fake('/b'), controller.signal);
  await tick();
  assert.equal(c.scans.length, 1);
  controller.abort(abortError());
  await assert.rejects(queued, (e: Error) => e.name === 'AbortError');
  const after = run(fake('/c'));
  c.scans[0].finish();
  await first;
  await tick();
  assert.equal(c.scans.length, 2, 'the cancelled request never ran; the next one took the slot');
  assert.equal(c.scans[1].ctx.root, '/c');
  c.scans[1].finish();
  await after;
  await assert.rejects(run(fake('/d'), AbortSignal.abort(abortError())), (e: Error) => e.name === 'AbortError');
  assert.equal(c.scans.length, 2, 'an already-cancelled request starts nothing');
});

test('an error reaches every request that shared the scan and does not block later ones', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index, maxConcurrent: 1 });
  const ctx = fake('/w');
  const a = run(ctx);
  const b = run(ctx);
  await tick();
  c.scans[0].fail(new Error('disk on fire'));
  await assert.rejects(a, /disk on fire/);
  await assert.rejects(b, /disk on fire/);
  const again = run(ctx);
  await tick();
  assert.equal(c.scans.length, 2, 'the failed scan is forgotten; a new one starts');
  c.scans[1].finish('ok');
  assert.deepEqual((await again).knownPaths, ['ok']);
});

test('the concurrency limit recovers after failures and cancellations', async () => {
  const c = controlled();
  const run = createIndexCoordinator({ index: c.index, maxConcurrent: 1 });
  for (let i = 0; i < 5; i++) {
    const p = run(fake(`/fail-${i}`));
    await tick();
    c.scans[c.scans.length - 1].fail(new Error('boom'));
    await assert.rejects(p, /boom/);
  }
  const controller = new AbortController();
  const aborted = run(fake('/abort'), controller.signal);
  await tick();
  controller.abort(abortError());
  await assert.rejects(aborted);
  const healthy = run(fake('/healthy'));
  await tick();
  c.scans[c.scans.length - 1].finish('fine');
  assert.deepEqual((await healthy).knownPaths, ['fine'], 'the single slot is still usable');
  assert.equal(c.active(), 0);
});

test('a scan that throws synchronously releases its slot', async () => {
  let calls = 0;
  const run = createIndexCoordinator({
    maxConcurrent: 1,
    index: () => {
      calls++;
      if (calls === 1) throw new Error('sync failure');
      return Promise.resolve(project('/w', 'second'));
    },
  });
  await assert.rejects(run(fake('/w')), /sync failure/);
  assert.deepEqual((await run(fake('/w'))).knownPaths, ['second']);
});

test('real indexing: concurrent requests return the same correct result as a single scan, and see later changes', async () => {
  const root = workspace({ 'src/a.ts': 'export function alpha() { return 1; }\n', 'src/b.ts': "import { alpha } from './a';\nexport const b = alpha();\n" });
  const ctx = context(root);
  const run = createIndexCoordinator();
  const reference = await indexProject(ctx);
  const results = await Promise.all(Array.from({ length: 8 }, () => run(ctx)));
  for (const p of results) {
    assert.deepEqual(p.files.map((f) => f.path), reference.files.map((f) => f.path));
    assert.deepEqual(p.knownPaths, reference.knownPaths);
    assert.equal(p.complete, true);
  }
  // A change made after the first batch is visible to the next request: nothing is served from an old scan.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${root}/src/c.ts`, 'export const c = 3;\n');
  const next = await run(ctx);
  assert.ok(next.files.some((f) => f.path === 'src/c.ts'));
});

test('real indexing: a cancelled request leaves the other one with a complete result', async () => {
  const root = workspace(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.ts`, `export const v${i} = ${i};\n`])));
  const ctx = context(root);
  const run = createIndexCoordinator();
  const controller = new AbortController();
  const cancelled = run(ctx, controller.signal);
  const kept = run(ctx);
  controller.abort(abortError());
  await assert.rejects(cancelled, (e: Error) => e.name === 'AbortError');
  const result = await kept;
  assert.equal(result.files.length, 60);
  assert.equal(result.complete, true);
});
