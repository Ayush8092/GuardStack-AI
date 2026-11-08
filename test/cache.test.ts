import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { cleanup, context, workspace, write } from './helpers.js';

after(cleanup);

const row = (ctx: ReturnType<typeof context>, rel: string) =>
  ctx.db.prepare('SELECT hash, mtime_ms FROM files WHERE path = ?').get(rel) as { hash: string; mtime_ms: number } | undefined;

test('content, not size or mtime, decides whether a cached file is still valid', async () => {
  const root = workspace({ 'a.ts': 'export const aaaa = 1;\n' });
  const ctx = context(root);
  const file = path.join(root, 'a.ts');
  const PINNED = 1_700_000_000;
  fs.utimesSync(file, PINNED, PINNED);
  const original = fs.statSync(file);

  assert.equal((await indexProject(ctx)).files[0].symbols[0].name, 'aaaa');

  fs.writeFileSync(file, 'export const bbbb = 1;\n');
  fs.utimesSync(file, PINNED, PINNED);
  const after = fs.statSync(file);
  assert.equal(after.size, original.size);
  assert.equal(after.mtimeMs, original.mtimeMs);

  assert.equal((await indexProject(ctx)).files[0].symbols[0].name, 'bbbb');
});

test('an unchanged file keeps its cached parse when only the mtime moves', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const ctx = context(root);
  await indexProject(ctx);
  const before = row(ctx, 'a.ts');

  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, 'a.ts'), later, later);
  const project = await indexProject(ctx);
  const after = row(ctx, 'a.ts');

  assert.equal(project.files[0].symbols[0].name, 'a');
  assert.equal(after?.hash, before?.hash);
  assert.notEqual(after?.mtime_ms, before?.mtime_ms);
});

test('hitting maxFiles never deletes cache entries for files left out of this pass', async () => {
  const root = workspace(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`src/${n}.ts`, `export const ${n} = 1;\n`])));
  const full = context(root);
  await indexProject(full);
  assert.equal((full.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, 5);

  const limited = { ...full, config: { ...full.config, maxFiles: 2 } };
  const project = await indexProject(limited);

  assert.equal(project.truncated, true);
  assert.equal(project.complete, false);
  assert.equal(project.eligible, 5);
  assert.deepEqual(project.files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);
  assert.equal((full.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, 5);
  assert.deepEqual(project.knownPaths, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
});

test('deleted files are still pruned from the cache', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  const ctx = context(root);
  await indexProject(ctx);
  fs.rmSync(path.join(root, 'b.ts'));
  await indexProject(ctx);
  assert.equal(row(ctx, 'b.ts'), undefined);
  assert.ok(row(ctx, 'a.ts'));
});

test('file selection is sorted and independent of creation order', async () => {
  const names = ['z', 'm', 'a', 'q', 'b'];
  const first = workspace(Object.fromEntries(names.map((n) => [`${n}/x.ts`, `export const ${n} = 1;\n`])));
  const second = workspace(Object.fromEntries([...names].reverse().map((n) => [`${n}/x.ts`, `export const ${n} = 1;\n`])));

  const a = await indexProject({ ...context(first), config: { ...context(first).config, maxFiles: 3 } });
  const b = await indexProject({ ...context(second), config: { ...context(second).config, maxFiles: 3 } });

  assert.deepEqual(a.files.map((f) => f.path), ['a/x.ts', 'b/x.ts', 'm/x.ts']);
  assert.deepEqual(b.files.map((f) => f.path), a.files.map((f) => f.path));
});

test('reports a complete scan as complete and a skipped file as partial', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'import { a } from "./a";\nexport const b = a;\n' });
  const ctx = context(root);
  const complete = await indexProject(ctx);
  assert.equal(complete.complete, true);
  assert.match(describeCoverage(complete, ctx.config.maxFiles), /complete/);

  write(root, 'big.ts', `export const big = "${'x'.repeat(2 * 1024)}";\n`);
  const small = { ...ctx, config: { ...ctx.config, maxFileKb: 1 } };
  const partial = await indexProject(small);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.skipped, [{ path: 'big.ts', reason: 'too-large' }]);
  assert.match(describeCoverage(partial, 1), /PARTIAL/);
  assert.ok(analyzeProject(partial, ctx.config).findings.filter((f) => f.rule === 'orphan-file').every((f) => f.confidence === 'low'));
});
