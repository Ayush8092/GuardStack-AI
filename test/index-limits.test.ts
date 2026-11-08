import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { isAbort } from '../src/utils/pace.js';
import { cleanup, context, workspace } from './helpers.js';

afterEach(cleanup);

const many = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${String(i).padStart(3, '0')}.ts`, `export const v${i} = ${i};\n`]));
const rows = (ctx: ReturnType<typeof context>): number => (ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;

// maxDiscoveryEntries cannot be configured below 100, so these workspaces hold more entries than that (150 files + 1 directory).
test('the entry limit makes the scan partial and is reported, never silently complete', async () => {
  const ctx = context(workspace(many(150)), { maxDiscoveryEntries: 100 });
  const project = await indexProject(ctx);
  assert.equal(project.stopped, 'entry-limit');
  assert.equal(project.complete, false);
  assert.match(describeCoverage(project, ctx.config.maxFiles), /maxDiscoveryEntries/);
});

test('a partial scan never evicts cached files it did not reach', async () => {
  const root = workspace(many(150));
  const full = context(root);
  await indexProject(full);
  assert.equal(rows(full), 150);

  const limited = context(root, { maxDiscoveryEntries: 100 });
  const partial = await indexProject(limited);
  assert.equal(partial.stopped, 'entry-limit');
  assert.equal(rows(limited), 150);
});

test('limited runs continue from the cache and converge on the full, identical result', async () => {
  const root = workspace(many(30));
  const reference = await indexProject(context(workspace(many(30))));
  // A deadline that has already passed: every call handles one file, and files that need parsing come first, so each call adds
  // exactly one row to the cache. (maxIndexMs now also bounds re-reading and re-hashing cached files, so once everything is parsed a
  // call with a deadline that is already over cannot re-verify the cache either; that last step needs a normal budget.)
  const ctx = context(root, { maxIndexMs: -1 });

  let project = await indexProject(ctx);
  assert.equal(project.stopped, 'index-time-limit');
  assert.equal(project.complete, false);
  assert.ok(project.unindexed > 0);

  let calls = 1;
  let cached = rows(ctx);
  assert.equal(cached, 1);
  while (cached < 30 && calls < 100) {
    project = await indexProject(ctx);
    calls++;
    assert.equal(rows(ctx), cached + 1, `call ${calls} made no progress`);
    cached = rows(ctx);
  }
  assert.equal(cached, 30);
  assert.ok(calls <= 30, `took ${calls} calls`);

  const finished = await indexProject(context(root));
  assert.equal(finished.stopped, undefined);
  assert.equal(finished.complete, true);
  assert.deepEqual(finished.files.map((f) => f.path), reference.files.map((f) => f.path));
  assert.deepEqual(finished.files.map((f) => f.symbols), reference.files.map((f) => f.symbols));
});

test('cancelling stops the scan, keeps what was parsed, and the next run reuses it', async () => {
  const root = workspace(many(80));
  const ctx = context(root);
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await assert.rejects(indexProject(ctx, { signal: controller.signal }), isAbort);

  const again = await indexProject(ctx);
  assert.equal(again.complete, true);
  assert.equal(again.files.length, 80);
});

test('an already cancelled request does no work', async () => {
  const ctx = context(workspace(many(5)));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(indexProject(ctx, { signal: controller.signal }), isAbort);
  assert.equal(rows(ctx), 0);
});

test('other tasks run while a large scan is in progress', async () => {
  const ctx = context(workspace(many(400)));
  let ticks = 0;
  const probe = setInterval(() => ticks++, 1);
  try {
    const project = await indexProject(ctx);
    assert.equal(project.files.length, 400);
  } finally {
    clearInterval(probe);
  }
  assert.ok(ticks > 0, 'the event loop was never free during the scan');
});

test('a content change is still detected by hash after a partial run', async () => {
  const root = workspace({ 'a.ts': 'export const aaaa = 1;\n', 'b.ts': 'export const bbbb = 1;\n' });
  const ctx = context(root, { maxIndexMs: -1 });
  await indexProject(ctx);
  await indexProject(ctx);
  const { write } = await import('./helpers.js');
  write(root, 'a.ts', 'export const cccc = 1;\n');
  const project = await indexProject(context(root));
  assert.equal(project.files.find((f) => f.path === 'a.ts')?.symbols[0].name, 'cccc');
});

test('the discovery time limit makes the scan partial, is reported, and evicts nothing', async () => {
  const root = workspace(many(40));
  const full = context(root);
  await indexProject(full);
  assert.equal(rows(full), 40);

  const limited = context(root, { maxDiscoveryMs: -1 });
  const partial = await indexProject(limited);
  assert.equal(partial.stopped, 'time-limit');
  assert.equal(partial.complete, false);
  assert.match(describeCoverage(partial, limited.config.maxFiles), /maxDiscoveryMs/);
  assert.equal(rows(limited), 40);
});

test('cancelling at any point never removes cached records and never returns a result', async () => {
  const root = workspace(many(300));
  const warm = context(root);
  await indexProject(warm);
  assert.equal(rows(warm), 300);

  for (const delay of [0, 1, 3, 8]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), delay);
    try {
      const project = await indexProject(context(root), { signal: controller.signal });
      // The scan can finish before the signal fires; a finished scan must then be a complete one.
      assert.equal(project.complete, true);
    } catch (err) {
      assert.ok(isAbort(err), `unexpected error: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(rows(warm), 300, `a cancellation after ${delay} ms removed cached records`);
  }
});

test('a partial scan never produces a confidently-unused finding, whichever limit stopped it', async () => {
  const files = { ...many(150), 'src/orphan.ts': 'export const lonely = 1;\n' };
  const limits: Record<string, Record<string, number>> = { 'entry limit': { maxDiscoveryEntries: 100 }, 'discovery time limit': { maxDiscoveryMs: -1 }, 'index time limit': { maxIndexMs: -1 } };
  for (const [name, overrides] of Object.entries(limits)) {
    const ctx = context(workspace(files), overrides);
    const project = await indexProject(ctx);
    assert.equal(project.complete, false, name);
    assert.ok(project.stopped, name);
    const analysis = analyzeProject(project, ctx.config);
    const strong = analysis.findings.filter((f) => f.classification === 'confidently-unused');
    assert.deepEqual(strong.map((f) => f.key), [], `${name}: absence-based findings must not be confident on a partial scan`);
  }
});
