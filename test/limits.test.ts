import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { sortEntries, walk, type WalkEnv } from '../src/core/ast/discovery.js';
import { createPacer, isAbort } from '../src/utils/pace.js';

const created: string[] = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tree(count: number, order: 'forward' | 'reverse' = 'forward'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-limits-')));
  created.push(root);
  const names = Array.from({ length: count }, (_, i) => i);
  if (order === 'reverse') names.reverse();
  for (const i of names) {
    const dir = path.join(root, `d${String(i % 10)}`, `s${String(i % 7)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.ts`), 'export const a = 1;\n');
  }
  return root;
}

const env = (root: string, ignores: WalkEnv['ignores'] = () => false): WalkEnv => ({ root, ignores, maxBytes: 1 << 20, isTsConfig: (n) => /^tsconfig/.test(n), isSensitive: () => false });
const BIG = { maxEntries: 1_000_000, maxMs: 60_000 };

test('an unbounded walk sees everything and reports no stop', async () => {
  const result = await walk(env(tree(120)), BIG);
  assert.equal(result.eligible.length, 120);
  assert.equal(result.stopped, undefined);
  assert.deepEqual(result.eligible.map((f) => f.rel), [...result.eligible.map((f) => f.rel)].sort());
});

test('the entry limit stops discovery and says so', async () => {
  const result = await walk(env(tree(300)), { ...BIG, maxEntries: 100 });
  assert.equal(result.stopped, 'entry-limit');
  assert.ok(result.eligible.length > 0 && result.eligible.length < 300);
});

test('which entries are seen before the entry limit does not depend on creation order', async () => {
  const a = await walk(env(tree(300, 'forward')), { ...BIG, maxEntries: 120 });
  const b = await walk(env(tree(300, 'reverse')), { ...BIG, maxEntries: 120 });
  assert.deepEqual(a.eligible.map((f) => f.rel), b.eligible.map((f) => f.rel));
  assert.equal(a.entries, b.entries);
});

test('the time limit stops discovery and says so', async () => {
  const result = await walk(env(tree(50)), { maxEntries: 1_000_000, maxMs: -1 });
  assert.equal(result.stopped, 'time-limit');
});

test('a signal that is already aborted rejects before any work', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(walk(env(tree(10)), { ...BIG, signal: controller.signal }), isAbort);
});

test('cancelling mid-walk rejects with an abort error', async () => {
  const controller = new AbortController();
  let seen = 0;
  const slow: WalkEnv['ignores'] = () => {
    if (++seen === 40) controller.abort();
    const until = performance.now() + 1;
    while (performance.now() < until);
    return false;
  };
  await assert.rejects(walk(env(tree(200), slow), { ...BIG, signal: controller.signal }), isAbort);
});

test('a long walk hands the event loop back so other work keeps running', async () => {
  let ticks = 0;
  const probe = setInterval(() => ticks++, 1);
  const slow: WalkEnv['ignores'] = () => {
    const until = performance.now() + 1;
    while (performance.now() < until);
    return false;
  };
  try {
    const result = await walk(env(tree(150), slow), BIG);
    assert.equal(result.eligible.length, 150);
  } finally {
    clearInterval(probe);
  }
  assert.ok(ticks > 3, `timers only ran ${ticks} time(s) during a ~150 ms walk`);
});

test('the pacer yields after its slice and honours cancellation', async () => {
  const pacer = createPacer({ sliceMs: 5 });
  const until = performance.now() + 12;
  while (performance.now() < until);
  await pacer.tick();
  assert.equal(pacer.yields(), 1);

  const controller = new AbortController();
  const cancellable = createPacer({ signal: controller.signal });
  controller.abort();
  await assert.rejects(cancellable.tick(), isAbort);
});

// ---- A single very large directory -------------------------------------------------------------------------------

const flatNames = (count: number): string[] => Array.from({ length: count }, (_, i) => `f${String(i).padStart(6, '0')}.ts`);

// One directory holding `count` files, created in the requested order so the on-disk order differs from the name order.
function flat(count: number, order: 'forward' | 'reverse' = 'forward'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-flat-')));
  created.push(root);
  const names = flatNames(count);
  if (order === 'reverse') names.reverse();
  for (const name of names) fs.writeFileSync(path.join(root, name), 'export const a = 1;\n');
  return root;
}

const busy = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

test('a single directory with 20,000 files is listed completely, in name order', async () => {
  const result = await walk(env(flat(20_000, 'reverse')), BIG);
  assert.equal(result.stopped, undefined);
  assert.equal(result.entries, 20_000);
  assert.deepEqual(result.eligible.map((f) => f.rel), flatNames(20_000));
});

test('the entry limit inside a huge directory keeps the first names in order, whatever the creation order', async () => {
  // 12,000 entries is above the point where the listing trims what it keeps, so this exercises the bounded path.
  const forward = await walk(env(flat(12_000, 'forward')), { ...BIG, maxEntries: 500 });
  const reverse = await walk(env(flat(12_000, 'reverse')), { ...BIG, maxEntries: 500 });
  for (const result of [forward, reverse]) {
    assert.equal(result.stopped, 'entry-limit');
    assert.deepEqual(result.eligible.map((f) => f.rel), flatNames(500));
  }
  assert.equal(forward.entries, reverse.entries);
});

test('the time limit is enforced while entries of one directory are processed', async () => {
  const root = flat(3_000);
  const slow: WalkEnv['ignores'] = () => {
    busy(0.5);
    return false;
  };
  const started = performance.now();
  const result = await walk(env(root, slow), { maxEntries: 1_000_000, maxMs: 150 });
  const elapsed = performance.now() - started;

  assert.equal(result.stopped, 'time-limit');
  // Without a per-entry check this would have processed all 3,000 files (about 1.5 s) before noticing.
  assert.ok(elapsed < 1_000, `discovery ran for ${elapsed.toFixed(0)} ms with a 150 ms limit`);
  // Partial reporting stays accurate: what was counted is what was kept, and it is the first names in order.
  assert.ok(result.entries > 0 && result.entries < 3_000, `entries=${result.entries}`);
  assert.equal(result.eligible.length, result.entries);
  assert.deepEqual(result.eligible.map((f) => f.rel), flatNames(result.entries));
});

test('a time limit that expires while a huge directory is still being listed ends in a clean partial result', async () => {
  const result = await walk(env(flat(20_000)), { maxEntries: 1_000_000, maxMs: 1 });
  assert.equal(result.stopped, 'time-limit');
  assert.ok(result.entries < 20_000);
  assert.deepEqual(result.eligible.map((f) => f.rel), flatNames(result.eligible.length));
});

test('cancelling inside a huge directory rejects with an abort error', async () => {
  const controller = new AbortController();
  let seen = 0;
  const slow: WalkEnv['ignores'] = () => {
    if (++seen === 400) controller.abort();
    busy(0.2);
    return false;
  };
  await assert.rejects(walk(env(flat(3_000), slow), { ...BIG, signal: controller.signal }), isAbort);
});

test('the chunked sort matches a plain sort, never blocks for the whole job and is deterministic', async () => {
  const names = flatNames(50_000);
  const shuffled = [...names].sort((a, b) => (Math.imul(a.length * 31 + Number(a.slice(1, 7)), 2654435761) >>> 0) - (Math.imul(b.length * 31 + Number(b.slice(1, 7)), 2654435761) >>> 0));
  assert.notDeepEqual(shuffled.slice(0, 50), names.slice(0, 50));
  const dirents = shuffled.map((name) => ({ name }) as fs.Dirent);
  let checkpoints = 0;
  const sorted = await sortEntries(dirents, async () => {
    checkpoints++;
  });
  assert.deepEqual(sorted.map((e) => e.name), names);
  assert.ok(checkpoints > 20, `only ${checkpoints} checkpoint(s) in a 50,000 entry sort`);
});

// ---- Entries read, retained and processed are different numbers ----------------------------------------------------

// The most entries a directory listing may hold at once for a given `keep` (see listDirectory), plus one batch of slack.
const bufferBound = (keep: number): number => keep + Math.max(keep >> 1, 8192) + 1024;

test('the entry limit caps entries processed, not entries read: the whole directory is still examined', async () => {
  const result = await walk(env(flat(30_000, 'reverse')), { ...BIG, maxEntries: 500 });
  assert.equal(result.stopped, 'entry-limit');
  assert.equal(result.entries, 500, 'processed: exactly the limit; the entry that would exceed it is detected but not counted');
  assert.equal(result.listed, 30_000, 'read: choosing the first names in order needs the whole directory');
  assert.deepEqual(result.eligible.map((f) => f.rel), flatNames(500), 'retained and selected: the first names in order');
});

test('memory held while listing stays bounded by the limit, not by the size of the directory', async () => {
  const root = flat(30_000, 'reverse');
  for (const maxEntries of [500, 5_000, 12_000]) {
    const result = await walk(env(root), { ...BIG, maxEntries });
    assert.equal(result.listed, 30_000);
    assert.ok(result.peakListingBuffer <= bufferBound(maxEntries + 1), `maxEntries=${maxEntries}: ${result.peakListingBuffer} entries were held at once`);
    assert.ok(result.peakListingBuffer < 30_000, `maxEntries=${maxEntries}: the whole directory was buffered`);
    assert.deepEqual(result.eligible.map((f) => f.rel), flatNames(maxEntries), `maxEntries=${maxEntries}`);
  }
});

test('with no limit in play every entry is read, retained once and processed', async () => {
  const result = await walk(env(flat(9_000)), BIG);
  assert.equal(result.stopped, undefined);
  assert.equal(result.listed, 9_000);
  assert.equal(result.entries, 9_000);
  assert.equal(result.peakListingBuffer, 9_000);
});

test('listed counts every directory that was read, and only those', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-listed-')));
  created.push(root);
  for (const rel of ['a/1.ts', 'a/2.ts', 'b/3.ts', 'top.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'export const v = 1;\n');
  }
  const result = await walk(env(root), BIG);
  assert.equal(result.listed, 6, 'root: a, b, top.ts; a: 1.ts, 2.ts; b: 3.ts');
  assert.equal(result.entries, 6);

  const limited = await walk(env(root), { ...BIG, maxEntries: 3 });
  assert.equal(limited.stopped, 'entry-limit');
  assert.ok(limited.entries <= 3 && limited.listed >= limited.entries && limited.listed <= 6, `listed=${limited.listed}`);
});
