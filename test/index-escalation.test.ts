import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, test, type TestContext } from 'node:test';
import { indexBudget, indexProject, rememberStop } from '../src/core/ast/indexer.js';
import { RESOURCE_CEILINGS } from '../src/utils/config.js';
import { cleanup, context, workspace } from './helpers.js';

afterEach(cleanup);

// A scan stopped by maxIndexMs gets a larger budget on the next call for the same workspace (doubling, up to the ceiling of the
// setting), because a cached file is only used after it has been read and hashed again, so a budget below the cost of verifying
// every file could otherwise never finish. These tests prove the three properties that matter: it finishes, it stays bounded, and
// nothing about validity was relaxed.

const many = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${String(i).padStart(3, '0')}.ts`, `export const v${i} = ${i};\n`]));
const rows = (ctx: ReturnType<typeof context>): number => (ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;

function fakeClock(t: TestContext, step: number): void {
  let now = 1_000;
  t.mock.method(performance, 'now', () => {
    now += step;
    return now;
  });
}

async function populate(root: string): Promise<void> {
  const ctx = context(root, { maxIndexMs: 100_000 });
  const project = await indexProject(ctx);
  assert.equal(project.complete, true);
}

test('a warm cache and a budget far below the cost of verifying every file still finishes, in a bounded number of calls', async (t) => {
  const root = workspace(many(80));
  await populate(root);

  fakeClock(t, 1);
  let calls = 0;
  let finished = false;
  for (; calls < 40 && !finished; calls++) {
    const project = await indexProject(context(root, { maxIndexMs: 4 }));
    if (project.complete) finished = true;
    else assert.equal(project.stopped, 'index-time-limit');
  }
  assert.ok(calls > 1, 'the first budget really was too small');
  assert.equal(finished, true, `the scan did not finish after ${calls} calls`);
  // 4 ms doubles to 8, 16, 32, 64, 128 and the scan needs about 160 clock readings: seven calls with room to spare.
  assert.ok(calls <= 10, `${calls} calls: the budget is not growing geometrically`);
});

test('the growth is bounded by the ceiling of the setting, however many calls were stopped', () => {
  const root = '/virtual/ceiling';
  assert.equal(indexBudget(root, 100), 100);
  const seen: number[] = [];
  for (let i = 0; i < 60; i++) {
    rememberStop(root, true);
    seen.push(indexBudget(root, 100));
  }
  assert.deepEqual(seen.slice(0, 5), [200, 400, 800, 1600, 3200], 'it doubles at first');
  assert.ok(seen.every((ms) => ms <= RESOURCE_CEILINGS.maxIndexMs), 'and never passes the hard ceiling');
  assert.equal(seen.at(-1), RESOURCE_CEILINGS.maxIndexMs, 'it ends at the ceiling');
  rememberStop(root, false);
  assert.equal(indexBudget(root, 100), 100, 'a call that was not stopped by the budget resets it');
});

test('a deadline that has already expired, and a non-finite one, are never extended', () => {
  const root = '/virtual/expired';
  for (let i = 0; i < 5; i++) rememberStop(root, true);
  assert.equal(indexBudget(root, -1), -1);
  assert.equal(indexBudget(root, 0), 0);
  assert.ok(Number.isNaN(indexBudget(root, Number.NaN)));
  rememberStop(root, false);
});

test('the number of workspaces that are tracked is bounded: the oldest is forgotten first', () => {
  const roots = Array.from({ length: 40 }, (_, i) => `/virtual/many/${i}`);
  for (const root of roots) rememberStop(root, true);
  assert.equal(indexBudget(roots[0], 100), 100, 'the oldest entry was dropped');
  assert.equal(indexBudget(roots[39], 100), 200, 'the newest is still tracked');
  for (const root of roots) rememberStop(root, false);
});

test('after a scan completes the next one starts from the configured budget again', async (t) => {
  const root = workspace(many(60));
  await populate(root);

  fakeClock(t, 1);
  let finished = false;
  for (let i = 0; i < 40 && !finished; i++) finished = (await indexProject(context(root, { maxIndexMs: 4 }))).complete;
  assert.equal(finished, true);

  // The state was reset by the completed call: this call is limited by 4 ms again and stops after a few files.
  const again = await indexProject(context(root, { maxIndexMs: 4 }));
  assert.equal(again.complete, false);
  assert.equal(again.stopped, 'index-time-limit');
  assert.ok(again.files.length <= 3, `${again.files.length} files in a 4 ms call: the earlier growth was not reset`);
});

test('the growth belongs to one workspace: another workspace starts from the configured budget', async (t) => {
  const first = workspace(many(60));
  const second = workspace(many(60));
  await populate(first);
  await populate(second);

  fakeClock(t, 1);
  for (let i = 0; i < 4; i++) await indexProject(context(first, { maxIndexMs: 4 }));
  const grown = await indexProject(context(first, { maxIndexMs: 4 }));
  const fresh = await indexProject(context(second, { maxIndexMs: 4 }));
  assert.ok(fresh.files.length <= 3, 'the other workspace is limited by its own, unextended budget');
  assert.ok(grown.files.length > fresh.files.length, 'the stopped workspace did get a longer budget');
});

test('an expired deadline is never extended', async () => {
  const root = workspace(many(30));
  await populate(root);
  for (let i = 0; i < 6; i++) {
    const project = await indexProject(context(root, { maxIndexMs: -1 }));
    assert.equal(project.stopped, 'index-time-limit');
    assert.equal(project.files.length, 1, `call ${i + 1}: exactly the first file is handled once the deadline has passed`);
  }
});

test('a larger budget does not make the cache trusted: a file changed without changing its size or modification time is read again', async (t) => {
  const root = workspace(many(30));
  await populate(root);

  // Grow the budget with a few stopped calls first.
  fakeClock(t, 1);
  for (let i = 0; i < 3; i++) await indexProject(context(root, { maxIndexMs: 4 }));
  t.mock.restoreAll();

  // Same length, same modification time, different content.
  const file = path.join(root, 'src', 'm005.ts');
  const before = fs.statSync(file);
  fs.writeFileSync(file, 'export const v5 = 9;\n');
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(fs.statSync(file).size, before.size);

  const ctx = context(root, { maxIndexMs: 100_000 });
  const project = await indexProject(ctx);
  assert.equal(project.complete, true);
  const row = ctx.db.prepare('SELECT hash FROM files WHERE path = ?').get('src/m005.ts') as { hash: string };
  assert.equal(row.hash, crypto.createHash('sha256').update('export const v5 = 9;\n').digest('hex'), 'the cache follows the content on disk, not the size and time');
  assert.equal(rows(ctx), 30);
});
