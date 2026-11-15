import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { after, test } from 'node:test';
import {
  CANDIDATE_FIXED_BYTES,
  FIXED_OVERHEAD_BYTES,
  MAX_DISCOVERY_MEMORY_BYTES,
  estimateCandidateBytes,
  estimateItemBytes,
  estimatePathBytes,
  sortEntries,
  walk,
  type WalkEnv,
} from '../src/core/ast/discovery.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { RESOURCE_CEILINGS, effectiveLimit, parseConfig } from '../src/utils/config.js';
import { isAbort } from '../src/utils/pace.js';
import { cleanup, context } from './helpers.js';

// Discovery holds a bounded ESTIMATE of memory (see "Memory model" in discovery.ts). These tests check that the estimate is
// conservative against the real heap, that discovery stops with an explicit 'memory-limit' when the budget is reached, that nothing is
// dropped silently, and that cancellation and enumeration order behave.

const MIB = 1024 * 1024;
const created: string[] = [];
after(() => {
  cleanup();
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const env = (root: string): WalkEnv => ({ root, ignores: () => false, maxBytes: 1 << 20, isTsConfig: () => false, isSensitive: () => false });

function scratch(files: Record<string, string> = {}, dirs: string[] = []): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-mem-')));
  created.push(root);
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
const names = (count: number, make: (i: number) => string): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [make(i), 'export const a = 1;\n']));
const BIG = { maxEntries: 1_000_000, maxMs: 120_000 };
const within = (r: Awaited<ReturnType<typeof walk>>): void => assert.ok(r.memory.peakEstimatedBytes <= r.memory.limitBytes, `estimate ${r.memory.peakEstimatedBytes} passed the budget ${r.memory.limitBytes}`);

// ---- A synthetic directory: no files on disk -----------------------------------------------------------------------------------------
// The first directory the walk opens (the root) is listed from a generator instead of the disk.
type Order = 'ascending' | 'descending' | 'shuffled';
function* syntheticNames(count: number, order: Order, make: (i: number) => string): Generator<string> {
  // 7919 is prime, so i * 7919 mod count visits every index once for any count that is not a multiple of it.
  for (let i = 0; i < count; i++) yield make(order === 'ascending' ? i : order === 'descending' ? count - 1 - i : (i * 7919) % count);
}
// libuv's UV_DIRENT_FILE
const UV_DIRENT_FILE = 1;
const DirentClass = fs.Dirent as unknown as new (name: string, type: number, parent: string) => fs.Dirent;

async function withSyntheticRoot<T>(entries: () => Iterable<string>, hooks: { onEntry?: (n: number) => void; onEnd?: () => void }, body: () => Promise<T>): Promise<T> {
  const original = fs.promises.opendir;
  let used = false;
  (fs.promises as unknown as Record<string, unknown>).opendir = async (...args: unknown[]) => {
    if (used) return (original as (...a: unknown[]) => Promise<fs.Dir>)(...args);
    used = true;
    return {
      async *[Symbol.asyncIterator]() {
        let n = 0;
        for (const name of entries()) {
          hooks.onEntry?.(++n);
          yield new DirentClass(name, UV_DIRENT_FILE, '/');
        }
        hooks.onEnd?.();
      },
      close: async () => undefined,
    };
  };
  try {
    return await body();
  } finally {
    (fs.promises as unknown as Record<string, unknown>).opendir = original;
  }
}
const sourceName = (i: number): string => `f${String(i).padStart(8, '0')}.ts`;

// ---- The estimate against the real heap ------------------------------------------------------------------------------------------------

test('the estimate is not lower than the real heap for listing items, path strings and candidates (ASCII and wide names)', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const heap = (): number => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  const N = 60_000;
  const keep: unknown[] = [];
  for (const wide of [false, true]) {
    for (const length of [8, 40, 255]) {
      // Strings built from a Buffer are real, unshared strings, like the names that come back from the operating system.
      const make = (i: number): string => Buffer.from(`${String(i).padStart(7, '0')}${(wide ? '\u4e2d' : 'x').repeat(length - 7)}`).toString('utf8');
      const sample = make(1);
      let before = heap();
      const items: { name: string; kind: number }[] = [];
      for (let i = 0; i < N; i++) items.push({ name: make(i), kind: 0 });
      let per = (heap() - before) / N;
      assert.ok(per <= estimateItemBytes(sample), `listing item (${wide ? 'wide' : 'ascii'}, ${length}): measured ${per.toFixed(1)} B > estimated ${estimateItemBytes(sample)} B`);
      keep.push(items);

      before = heap();
      const paths: string[] = [];
      for (let i = 0; i < N; i++) paths.push(make(i));
      per = (heap() - before) / N;
      assert.ok(per <= estimatePathBytes(sample), `path string (${wide ? 'wide' : 'ascii'}, ${length}): measured ${per.toFixed(1)} B > estimated ${estimatePathBytes(sample)} B`);
      keep.push(paths);

      before = heap();
      const candidates: { rel: string; lang: string; size: number; mtimeMs: number }[] = [];
      for (let i = 0; i < N; i++) candidates.push({ rel: make(i), lang: 'typescript', size: 1000 + i, mtimeMs: 1.7e12 + i + 0.5 });
      per = (heap() - before) / N;
      assert.ok(per <= estimateCandidateBytes(sample), `candidate (${wide ? 'wide' : 'ascii'}, ${length}): measured ${per.toFixed(1)} B > estimated ${estimateCandidateBytes(sample)} B`);
      keep.push(candidates);
    }
  }
  assert.ok(keep.length > 0);
});

test('names are charged by length: the same count costs far more with long names', () => {
  assert.ok(estimateItemBytes('x'.repeat(255)) > 4 * estimateItemBytes('x'.repeat(8)));
  assert.ok(estimateCandidateBytes('x'.repeat(200)) >= CANDIDATE_FIXED_BYTES + 400);
});

// ---- Huge synthetic directory -----------------------------------------------------------------------------------------------------------

test('a huge synthetic directory stops at the memory budget with an explicit memory-limit, using the whole entry budget as no excuse', async () => {
  const root = scratch();
  const result = await withSyntheticRoot(() => syntheticNames(3_000_000, 'ascending', sourceName), {}, () => walk(env(root), { maxEntries: 2_000_000, maxMs: 120_000, maxMemoryBytes: 32 * MIB }));
  assert.equal(result.stopped, 'memory-limit');
  within(result);
  assert.ok(result.listed < 3_000_000, 'listing stopped instead of reading the whole directory into memory');
  assert.ok(result.listed > 1_000, 'it did read up to the budget');
  assert.equal(result.entries, 0, 'nothing from a directory that could not be selected within the budget was used');
  assert.deepEqual([result.eligible, result.vanished, result.unclassified], [[], [], []]);
});

test('a huge directory with a small entry limit is read completely, holds little, and reports entry-limit', async () => {
  const root = scratch();
  const result = await withSyntheticRoot(() => syntheticNames(1_000_000, 'descending', sourceName), {}, () => walk(env(root), { maxEntries: 50, maxMs: 120_000, maxMemoryBytes: 32 * MIB }));
  assert.equal(result.stopped, 'entry-limit');
  assert.equal(result.listed, 1_000_000);
  assert.equal(result.entries, 50);
  within(result);
  assert.ok(result.memory.peakEstimatedBytes < 4 * MIB, `held ${result.memory.peakEstimatedBytes} bytes for a limit of 50 entries`);
  // The files do not exist on disk, so each is recorded as vanished: the first 50 names in order, none dropped silently.
  assert.deepEqual(result.vanished, Array.from({ length: 50 }, (_, i) => sourceName(i)));
});

// ---- Very long filenames: bytes, not counts ---------------------------------------------------------------------------------------------

test('very long file names reach the memory budget long before the same number of short names does', async () => {
  const count = 3_000;
  const budget = 2 * MIB;
  const longRoot = scratch(names(count, (i) => `${'a'.repeat(240)}${String(i).padStart(5, '0')}.ts`));
  const shortRoot = scratch(names(count, (i) => `s${String(i).padStart(5, '0')}.ts`));
  const long = await walk(env(longRoot), { ...BIG, maxMemoryBytes: budget });
  const short = await walk(env(shortRoot), { ...BIG, maxMemoryBytes: budget });
  assert.equal(long.stopped, 'memory-limit');
  within(long);
  assert.equal(short.stopped, undefined, 'the same count of short names fits the same budget');
  assert.equal(short.eligible.length, count);
  assert.equal(long.eligible.length, 0, 'a directory that cannot be selected within the budget contributes nothing');
});

// ---- Large numbers of directories: pending directories and retained results are charged ---------------------------------------------

test('a large number of directories is stopped by the memory budget, in sorted order, without dropping any entry silently', async () => {
  const count = 3_000;
  const dirNames = Array.from({ length: count }, (_, i) => `${'d'.repeat(200)}${String(i).padStart(5, '0')}`);
  const root = scratch({}, dirNames);
  // The root listing fits, but the pending directories it produces do not.
  const listing = dirNames.reduce((sum, n) => sum + estimateItemBytes(n), 0);
  const pending = dirNames.reduce((sum, n) => sum + estimatePathBytes(n), 0);
  const result = await walk(env(root), { ...BIG, maxMemoryBytes: FIXED_OVERHEAD_BYTES + listing + 48 * count + Math.floor(pending / 2) });
  assert.equal(result.stopped, 'memory-limit');
  within(result);
  assert.ok(result.entries > 0 && result.entries < count, `processed ${result.entries} of ${count}: the walk stopped part-way through the root`);
  assert.equal(result.listed, count, 'nothing was dropped while listing; the stop came from the pending-directory budget');
});

test('with enough memory the same directories are all visited and nothing is reported as stopped', async () => {
  const root = scratch({ 'd1/a.ts': 'export const a = 1;\n', 'd2/b.ts': 'export const b = 1;\n' }, ['d3']);
  const result = await walk(env(root), { ...BIG, maxMemoryBytes: 8 * MIB });
  assert.equal(result.stopped, undefined);
  assert.deepEqual(result.eligible.map((f) => f.rel), ['d1/a.ts', 'd2/b.ts']);
  within(result);
});

// ---- Memory budget reached by retained candidates; entry budget reached; never COMPLETE -----------------------------------------------

test('a memory budget reached by retained candidates keeps the sorted prefix, stops explicitly, and counts exactly what it processed', async () => {
  const count = 5_000;
  const root = scratch(names(count, (i) => `f${String(i).padStart(5, '0')}.ts`));
  const first = await walk(env(root), { ...BIG, maxMemoryBytes: FIXED_OVERHEAD_BYTES + 900 * 1024 });
  assert.equal(first.stopped, 'memory-limit');
  within(first);
  assert.ok(first.eligible.length > 0 && first.eligible.length < count);
  assert.equal(first.entries, first.eligible.length, 'every entry processed was retained, none was dropped, and the one that did not fit was not counted');
  assert.deepEqual(first.eligible.map((f) => f.rel), Array.from({ length: first.eligible.length }, (_, i) => `f${String(i).padStart(5, '0')}.ts`), 'a deterministic prefix in sorted order');
  const again = await walk(env(root), { ...BIG, maxMemoryBytes: FIXED_OVERHEAD_BYTES + 900 * 1024 });
  assert.deepEqual(again.eligible, first.eligible);
});

test('reaching the entry budget is still reported as entry-limit, and the memory budget is not blamed', async () => {
  const result = await walk(env(scratch(names(300, (i) => `f${String(i).padStart(4, '0')}.ts`))), { ...BIG, maxEntries: 100, maxMemoryBytes: 64 * MIB });
  assert.equal(result.stopped, 'entry-limit');
  assert.equal(result.entries, 100);
  within(result);
});

test('a scan stopped by the memory budget is never complete, and the coverage text names the reason', async () => {
  const root = scratch(names(6_000, (i) => `${'n'.repeat(230)}${String(i).padStart(5, '0')}.ts`));
  const ctx = context(root, { maxDiscoveryMemoryMb: 4 });
  const project = await indexProject(ctx);
  assert.equal(project.stopped, 'memory-limit');
  assert.equal(project.complete, false);
  const text = describeCoverage(project, ctx.config.maxFiles);
  assert.match(text, /PARTIAL/);
  assert.match(text, /memory budget \(maxDiscoveryMemoryMb\)/);
});

// ---- Cancellation ----------------------------------------------------------------------------------------------------------------------

test('cancellation while a directory is being listed rejects with the abort and leaves the directory closed', async () => {
  const root = scratch();
  const controller = new AbortController();
  await withSyntheticRoot(() => syntheticNames(200_000, 'ascending', sourceName), { onEntry: (n) => n === 2_000 && controller.abort() }, async () => {
    await assert.rejects(walk(env(root), { ...BIG, signal: controller.signal }), isAbort);
  });
});

test('cancellation while a listing is being sorted rejects with the abort, never with a partial result', async () => {
  const root = scratch();
  const controller = new AbortController();
  // Aborted after the last entry was read: the next step is the (chunked) final sort of 30,000 entries.
  await withSyntheticRoot(() => syntheticNames(30_000, 'descending', sourceName), { onEnd: () => controller.abort() }, async () => {
    await assert.rejects(walk(env(root), { ...BIG, signal: controller.signal }), isAbort);
  });
});

test('sortEntries stops at its checkpoint when cancelled and returns nothing partial', async () => {
  const controller = new AbortController();
  const entries = Array.from({ length: 50_000 }, (_, i) => ({ name: sourceName((i * 7919) % 50_000) }));
  let checkpoints = 0;
  await assert.rejects(
    sortEntries(entries, async () => {
      if (++checkpoints === 5) controller.abort();
      controller.signal.throwIfAborted();
    }),
    isAbort,
  );
  assert.ok(checkpoints < 20, 'it stopped soon after the abort');
});

// ---- Determinism ----------------------------------------------------------------------------------------------------------------------

test('the entry-limit selection and the memory-limit stop are identical whatever order the file system lists names in', async () => {
  const root = scratch();
  const orders: Order[] = ['ascending', 'descending', 'shuffled'];
  for (const limits of [{ maxEntries: 500, maxMemoryBytes: 64 * MIB }, { maxEntries: 1_000_000, maxMemoryBytes: 3 * MIB }]) {
    const runs = [];
    for (const order of orders) runs.push(await withSyntheticRoot(() => syntheticNames(30_000, order, sourceName), {}, () => walk(env(root), { maxMs: 120_000, ...limits })));
    for (const run of runs) {
      assert.equal(run.stopped, runs[0].stopped, `${JSON.stringify(limits)}: same stop`);
      assert.deepEqual(run.vanished, runs[0].vanished, `${JSON.stringify(limits)}: same entries, same order`);
      assert.equal(run.entries, runs[0].entries);
      within(run);
    }
  }
});

// ---- Configuration -----------------------------------------------------------------------------------------------------------------------

test('the trusted ceilings: entries lowered to 1,000,000, memory capped at 256 MiB, and a repository cannot raise either', () => {
  assert.equal(RESOURCE_CEILINGS.maxDiscoveryEntries, 1_000_000);
  assert.equal(RESOURCE_CEILINGS.maxDiscoveryMemoryMb * MIB, MAX_DISCOVERY_MEMORY_BYTES);
  assert.equal(parseConfig({}).maxDiscoveryMemoryMb, 128, 'the default is half of the ceiling');
  assert.equal(parseConfig({ maxDiscoveryMemoryMb: 256 }).maxDiscoveryMemoryMb, 256);
  assert.throws(() => parseConfig({ maxDiscoveryMemoryMb: 257 }), /maxDiscoveryMemoryMb/);
  assert.throws(() => parseConfig({ maxDiscoveryMemoryMb: 3 }), /maxDiscoveryMemoryMb/);
  assert.throws(() => parseConfig({ maxDiscoveryEntries: 1_000_001 }), /maxDiscoveryEntries/);
  assert.equal(effectiveLimit({ maxDiscoveryMemoryMb: 10_000 }, 'maxDiscoveryMemoryMb'), 256, 'a Config built without the schema is still cut to the ceiling');
  assert.equal(effectiveLimit({ maxDiscoveryMemoryMb: Number.NaN }, 'maxDiscoveryMemoryMb'), 128);
});

test('a walk is never given more than the trusted maximum, whatever the caller passes', async () => {
  const result = await walk(env(scratch({ 'a.ts': 'export const a = 1;\n' })), { ...BIG, maxMemoryBytes: 10 * 1024 * MIB });
  assert.equal(result.memory.limitBytes, MAX_DISCOVERY_MEMORY_BYTES);
  const nan = await walk(env(scratch({ 'a.ts': 'export const a = 1;\n' })), { ...BIG, maxMemoryBytes: Number.NaN });
  assert.ok(nan.memory.limitBytes > 0 && nan.memory.limitBytes <= MAX_DISCOVERY_MEMORY_BYTES);
});
