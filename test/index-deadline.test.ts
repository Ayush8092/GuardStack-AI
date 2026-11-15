import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { afterEach, test, type TestContext } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { cleanup, context, workspace } from './helpers.js';

afterEach(cleanup);

// maxIndexMs covers the whole indexing phase: reading, hashing, the cache lookup and parsing. A negative value is a deadline that has
// already passed, which makes the rule observable without depending on how fast the machine is: exactly the first file is handled.
const many = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${String(i).padStart(3, '0')}.ts`, `export const v${i} = ${i};\n`]));
const rows = (ctx: ReturnType<typeof context>): number => (ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;

// A clock the test controls. The indexer measures maxIndexMs with performance.now(), so replacing it makes every budget a
// matter of how many times the clock is read and how far the test moves it, not of how fast the machine happens to be.
// `step` is how far each reading moves it; `jump` moves it by hand (a slow cache load, say).
function fakeClock(t: TestContext, step = 0): { jump: (ms: number) => void } {
  let now = 1_000;
  t.mock.method(performance, 'now', () => {
    now += step;
    return now;
  });
  return { jump: (ms) => void (now += ms) };
}

test('cold cache: the deadline stops the scan before the next file is read, and the scan is reported as incomplete', async () => {
  const ctx = context(workspace(many(120)), { maxIndexMs: -1 });
  const project = await indexProject(ctx);
  assert.equal(project.stopped, 'index-time-limit');
  assert.equal(project.complete, false);
  assert.equal(project.files.length, 1, 'only the first file of the call is handled once the deadline has passed');
  assert.equal(project.unindexed, 119);
  assert.equal(rows(ctx), 1, 'the file that was parsed is cached');
  assert.match(describeCoverage(project, ctx.config.maxFiles), /maxIndexMs/);
});

test('warm cache: reading and hashing cached files stops at the deadline too, and no cached record is evicted', async () => {
  const root = workspace(many(120));
  const warm = context(root);
  await indexProject(warm);
  assert.equal(rows(warm), 120);

  const limited = context(root, { maxIndexMs: -1 });
  const project = await indexProject(limited);
  assert.equal(project.stopped, 'index-time-limit', 'cache hits are not exempt from the limit');
  assert.equal(project.complete, false);
  assert.equal(project.files.length, 1);
  assert.equal(project.unindexed, 119);
  assert.equal(rows(limited), 120, 'files that were not reached keep their cache rows');
});

test('an interrupted scan is reported as incomplete and never produces a high-confidence absence-based finding', async () => {
  const files = { ...many(60), 'a-first.ts': "import { nothing } from './does-not-exist';\nexport const first = nothing;\n", 'src/orphan.ts': 'export const lonely = 1;\n' };
  const complete = context(workspace(files));
  const whole = analyzeProject(await indexProject(complete), complete.config);
  assert.equal(whole.findings.find((f) => f.rule === 'unresolved-import')?.confidence, 'high', 'on a complete scan the missing file is a confident finding');

  const ctx = context(workspace(files), { maxIndexMs: -1 });
  const project = await indexProject(ctx);
  assert.equal(project.complete, false);
  assert.ok(project.files.some((f) => f.path === 'a-first.ts'), 'the first file in path order was processed');
  const analysis = analyzeProject(project, ctx.config);
  const missing = analysis.findings.find((f) => f.rule === 'unresolved-import');
  assert.equal(missing?.confidence, 'low', 'a file that is "not found" may simply be one the interrupted scan did not reach');
  assert.deepEqual(analysis.findings.filter((f) => f.classification === 'confidently-unused').map((f) => f.key), []);
  assert.ok(analysis.findings.every((f) => f.confidence !== 'high' || !['orphan-file', 'dead-export', 'unresolved-import'].includes(f.rule)), 'no absence-based finding is high confidence');
});

test('a scan that finishes inside its budget is complete and reports no stop', async () => {
  const ctx = context(workspace(many(30)), { maxIndexMs: 600_000 });
  const project = await indexProject(ctx);
  assert.equal(project.stopped, undefined);
  assert.equal(project.complete, true);
  assert.equal(project.unindexed, 0);
});

test('repeated calls with a small budget progressively populate the cache, and a later call completes', async (t) => {
  // Every clock reading costs 1 ms and the budget is 4 ms, so a call handles a few files and then stops: the same shape as
  // a real 4 ms budget, but identical on every machine and every run.
  fakeClock(t, 1);
  const root = workspace(many(80));
  let last = 0;
  let calls = 0;
  let finished = false;

  for (; calls < 400 && !finished; calls++) {
    const ctx = context(root, { maxIndexMs: 4 });
    const project = await indexProject(ctx);
    const cached = rows(ctx);

    assert.ok(cached >= last, 'the cache never shrinks while a scan is being completed');
    last = cached;

    if (project.complete) finished = true;
    else {
      assert.equal(project.stopped, 'index-time-limit');
      assert.ok(project.files.length >= 1, 'every call makes progress');
    }
  }

  assert.ok(calls > 1, 'the budget really was too small for one call');
  assert.ok(calls < 400, `the scan did not populate the cache after ${calls} calls`);
  assert.equal(finished, true);
  assert.equal(last, 80, 'all 80 files are cached once the scan has completed');

  const finalCtx = context(root, { maxIndexMs: 600_000 });
  const finalProject = await indexProject(finalCtx);

  assert.equal(finalProject.complete, true);
  assert.equal(finalProject.stopped, undefined);
  assert.equal(finalProject.files.length, 80);
  assert.equal(finalProject.unindexed, 0);
  assert.equal(rows(finalCtx), 80);
});

// ---- the clock starts before the preparation work -----------------------------------------------------------------------------------

// The cache load takes `ms` of the fake clock, instead of occupying the process for that long.
function slowCache(ctx: ReturnType<typeof context>, onLoad: () => void): ReturnType<typeof context> {
  const db = new Proxy(ctx.db, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
      return (sql: string) => {
        if (/SELECT path, hash, size, mtime_ms, info FROM files/.test(sql)) onLoad();
        return (value as (s: string) => unknown).call(target, sql);
      };
    },
  });
  return { ...ctx, db };
}

test('preparation counts against maxIndexMs: a slow cache load leaves less time for files', async (t) => {
  // The clock does not move by itself, so "four tiny files fit in 150 ms" is exactly true rather than usually true.
  const clock = fakeClock(t, 0);
  const root = workspace(many(4));
  const normal = await indexProject(context(root, { maxIndexMs: 150 }));
  assert.equal(normal.complete, true);
  assert.equal(normal.stopped, undefined);

  // The same budget, but loading the cache takes 400 ms. The clock started before that, so only the first file of the call is handled.
  const slow = await indexProject(slowCache(context(workspace(many(4)), { maxIndexMs: 150 }), () => clock.jump(400)));
  assert.equal(slow.stopped, 'index-time-limit');
  assert.equal(slow.complete, false);
  assert.equal(slow.files.length, 1, 'the budget was already spent when the first file was reached');
  assert.equal(slow.unindexed, 3);
});

test('the same scan with a real clock still completes inside a generous budget', async () => {
  const project = await indexProject(context(workspace(many(4)), { maxIndexMs: 600_000 }));
  assert.equal(project.complete, true);
  assert.equal(project.stopped, undefined);
});
