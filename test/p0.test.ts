import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { findCycles } from '../src/core/ast/graph.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { renderValidation } from '../src/core/ast/report.js';
import { validateProject } from '../src/core/validation/delta.js';
import { cleanup, context, workspace, write } from './helpers.js';

after(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(files: Record<string, string>): string {
  const root = workspace(files);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline');
  return root;
}

async function validate(root: string, options: { base?: string; maxChangedFiles?: number; config?: Record<string, unknown> } = {}) {
  const ctx = context(root, options.config);
  const project = await indexProject(ctx);
  return (await validateProject(ctx, project, options)).validation;
}

const ids = (list: { rule: string; file: string }[]) => list.map((f) => `${f.rule}:${f.file}`).sort();

const body = "const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate()]; return parts.map((p) => String(p).padStart(2, '0')).join('-');";

// ---- P0 #1: renamed files come back from the baseline at their original path ----

test('a rename that leaves an importer pointing at the old path is blamed on the change', async () => {
  const root = repo({
    'src/util.ts': `export function formatDate(d: Date) { ${body} }\n`,
    'src/main.ts': "import { formatDate } from './util';\nconsole.log(formatDate(new Date()));\n",
  });
  git(root, 'mv', 'src/util.ts', 'src/helpers.ts');

  const result = await validate(root);
  assert.ok(result.changes.some((c) => c.status === 'renamed' && c.oldPath === 'src/util.ts' && c.path === 'src/helpers.ts'));
  // Restoring util.ts under its new name would have made './util' look unresolved in the baseline too, hiding this.
  assert.ok(ids(result.introduced).includes('unresolved-import:src/main.ts'), ids(result.introduced).join());
  assert.equal(result.partial, false);
});

test('a clean rename with an updated importer introduces nothing and fixes nothing', async () => {
  const root = repo({
    'src/util.ts': `export function formatDate(d: Date) { ${body} }\nexport const legacy: any = 1;\n`,
    'src/main.ts': "import { formatDate } from './util';\nconsole.log(formatDate(new Date()));\n",
  });
  git(root, 'mv', 'src/util.ts', 'src/helpers.ts');
  write(root, 'src/main.ts', "import { formatDate } from './helpers';\nconsole.log(formatDate(new Date()));\n");

  const result = await validate(root);
  assert.deepEqual(ids(result.introduced), [], 'moving a file must not look like new problems');
  assert.deepEqual(ids(result.fixed), [], 'moving a file must not look like fixed problems');
  assert.ok(result.existing.some((f) => f.rule === 'suppression' && f.file === 'src/helpers.ts'), 'the pre-existing suppression follows the file to its new path');
});

test('a renamed file keeps its dependencies and importers in the baseline graph', async () => {
  const root = repo({
    'src/a.ts': "import { b } from './b';\nexport const a = b + 1;\n",
    'src/b.ts': "import { a } from './a';\nexport const b = 1;\nexport const viaA = () => a;\n",
    'src/main.ts': "import { a } from './a';\nconsole.log(a);\n",
  });
  git(root, 'mv', 'src/b.ts', 'src/renamed-b.ts');
  write(root, 'src/a.ts', "import { b } from './renamed-b';\nexport const a = b + 1;\n");
  write(root, 'src/renamed-b.ts', "import { a } from './a';\nexport const b = 1;\nexport const viaA = () => a;\n");

  const result = await validate(root);
  assert.ok(!result.introduced.some((f) => f.rule === 'circular-dependency'), 'the cycle already existed before the rename');
  assert.ok(result.existing.some((f) => f.rule === 'circular-dependency'));
  assert.deepEqual(ids(result.fixed).filter((f) => f.startsWith('circular')), []);
});

test('deleting a file and adding another elsewhere is not treated as a rename', async () => {
  const root = repo({ 'src/old.ts': 'export const old: any = 1;\n', 'src/main.ts': "import { old } from './old';\nconsole.log(old);\n" });
  fs.rmSync(path.join(root, 'src/old.ts'));
  write(root, 'src/main.ts', 'console.log(1);\n');
  write(root, 'src/other.ts', 'export const other: any = 1;\nexport const second: any = 2;\n');

  const result = await validate(root);
  assert.ok(result.fixed.some((f) => f.file === 'src/old.ts'));
  assert.ok(result.introduced.some((f) => f.rule === 'suppression' && f.file === 'src/other.ts'));
});

// ---- P0 #2: partial validation is explicit ----

test('files beyond the comparison limit make the result provisional and say so', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const root = repo(files);
  for (let i = 0; i < 5; i++) write(root, `src/f${i}.ts`, `export const v${i}: any = ${i};\n`);

  const result = await validate(root, { maxChangedFiles: 2 });
  assert.equal(result.partial, true);
  assert.equal(result.coverage?.evaluated.length, 2);
  assert.equal(result.coverage?.relevantChanges, 5);
  assert.equal(result.coverage?.skipped.filter((s) => s.reason === 'over-limit').length, 3);
  assert.ok(result.partialReasons.some((r) => /only the first 2/.test(r)));

  const text = renderValidation(result);
  assert.match(text, /PARTIAL VALIDATION/);
  assert.match(text, /Compared 2 of 5 changed source file/);
  assert.match(text, /Not compared \(3\)/);
  assert.match(text, /Possibly introduced by this change \(provisional\)/);
  assert.ok(!/## Introduced by this change/.test(text), 'a provisional result must not use the definitive heading');
});

test('a baseline file that cannot be read back is listed and makes the result provisional', async () => {
  const big = `export const big = "${'x'.repeat(3000)}";\n`;
  const root = repo({ 'src/big.ts': big, 'src/ok.ts': 'export const ok = 1;\n' });
  write(root, 'src/big.ts', 'export const big = 1;\n');
  write(root, 'src/ok.ts', 'export const ok: any = 1;\n');

  const result = await validate(root, { config: { maxFileKb: 1 } });
  assert.equal(result.partial, true);
  assert.deepEqual(result.coverage?.skipped, [{ path: 'src/big.ts', reason: 'baseline-too-large' }]);
  assert.match(renderValidation(result), /base version too large/);
});

test('a complete comparison is reported as definitive', async () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/a.ts', 'export const a: any = 1;\n');
  const result = await validate(root);
  assert.equal(result.partial, false);
  assert.deepEqual(result.partialReasons, []);
  assert.ok(!/PARTIAL/.test(renderValidation(result)));
});

// ---- P0 #3: the baseline uses the configuration of the base commit ----

test('a tsconfig edit that breaks an alias is blamed on the change, not hidden by today\'s config', async () => {
  const root = repo({
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/util.ts': 'export const u = 1;\n',
    'src/main.ts': "import { u } from '@/util';\nconsole.log(u);\n",
  });
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: {} }));

  const result = await validate(root);
  // The alias no longer resolves, so util.ts has lost its only importer.
  assert.ok(ids(result.introduced).includes('orphan-file:src/util.ts'), ids(result.introduced).join());
  assert.ok(result.baselineNotes.some((n) => /tsconfig/.test(n)), result.baselineNotes.join());
  assert.match(renderValidation(result), /Project configuration differs from the base commit/);
});

test('a tsconfig edit that repairs an alias counts as a fix', async () => {
  const root = repo({
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'src/util.ts': 'export const u = 1;\n',
    'src/main.ts': "import { u } from '@/util';\nconsole.log(u);\n",
  });
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));

  const result = await validate(root);
  assert.ok(ids(result.fixed).includes('orphan-file:src/util.ts'), ids(result.fixed).join());
  assert.deepEqual(ids(result.introduced), []);
});

test('.guardianrc ignore rules and .gitignore at the base commit decide which files existed', async () => {
  const root = repo({
    '.guardianrc': JSON.stringify({ ignore: ['legacy/'] }),
    'legacy/old.ts': 'export const old: any = 1;\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  const before = await validate(root);
  assert.deepEqual(ids(before.introduced), []);

  write(root, '.guardianrc', JSON.stringify({}));
  const result = await validate(root);
  assert.ok(ids(result.introduced).includes('suppression:legacy/old.ts'), 'files that were ignored at the base are new to the analysis');
  assert.ok(result.baselineNotes.some((n) => /\.guardianrc/.test(n)));
});

test('a .guardianrc that did not exist at the base commit means defaults, not today\'s rules', async () => {
  const root = repo({ 'legacy/old.ts': 'export const old: any = 1;\n', 'src/a.ts': 'export const a = 1;\n' });
  write(root, '.guardianrc', JSON.stringify({ ignore: ['legacy/'] }));

  const result = await validate(root);
  assert.ok(ids(result.fixed).includes('suppression:legacy/old.ts'));
  assert.ok(result.baselineNotes.some((n) => /\.guardianrc/.test(n)));
});

test('a tsconfig that extends another file is rebuilt from the base commit', async () => {
  const root = repo({
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['lib/*'] } } }),
    'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
    'lib/x.ts': 'export const x = 1;\n',
    'src/main.ts': "import { x } from '~/x';\nconsole.log(x);\n",
  });
  write(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['elsewhere/*'] } } }));

  const result = await validate(root);
  assert.ok(ids(result.introduced).includes('orphan-file:lib/x.ts'), ids(result.introduced).join());
});

test('a sub-directory workspace reads the baseline relative to itself', async () => {
  const top = repo({
    'app/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'app/src/util.ts': 'export const u = 1;\n',
    'app/src/main.ts': "import { u } from '@/util';\nconsole.log(u);\n",
    'other/z.ts': 'export const z: any = 1;\n',
  });
  write(top, 'app/src/extra.ts', 'export const extra = 1;\n');
  const result = await validate(path.join(top, 'app'));
  assert.deepEqual(ids(result.introduced), ['orphan-file:src/extra.ts']);
  assert.ok(!result.partial);
});

// ---- P0 #4: self-import cycles ----

test('findCycles reports a file that imports itself', () => {
  const cycles = findCycles(['a.ts'], new Map([['a.ts', ['a.ts']]]));
  assert.deepEqual(cycles, [{ modules: ['a.ts'], path: ['a.ts', 'a.ts'] }]);
});

test('findCycles still reports multi-file cycles and ignores acyclic graphs', () => {
  const edges = new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']], ['d.ts', ['a.ts']]]);
  const cycles = findCycles(['a.ts', 'b.ts', 'c.ts', 'd.ts'], edges);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].modules, ['a.ts', 'b.ts', 'c.ts']);

  assert.deepEqual(findCycles(['x.ts', 'y.ts'], new Map([['x.ts', ['y.ts']]])), []);
  assert.deepEqual(findCycles(['solo.ts'], new Map()), []);
});

test('analysis flags a runtime self-import and nothing else', async () => {
  const root = workspace({
    'src/self.ts': "import { later } from './self';\nexport const now = 1;\nexport function later() { return now; }\nconsole.log(later);\n",
    'src/typed.ts': "import type { T } from './typed';\nexport type T = { a: number };\nexport const t: T = { a: 1 };\n",
    'src/lazy.ts': "export const load = () => import('./lazy');\n",
    'src/plain.ts': 'export const plain = 1;\n',
    'src/main.ts': "import './self';\nimport './typed';\nimport './lazy';\nimport './plain';\n",
  });
  const ctx = context(root);
  const { findings, cycles, graph } = analyzeProject(await indexProject(ctx), ctx.config);

  assert.deepEqual(cycles.map((c) => c.modules), [['src/self.ts']]);
  const cycle = findings.filter((f) => f.rule === 'circular-dependency');
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].file, 'src/self.ts');
  assert.match(cycle[0].message, /src\/self\.ts → src\/self\.ts/);
  assert.equal(graph.nodes.find((n) => n.id === 'src/self.ts')?.inCycle, true);
  assert.equal(graph.nodes.find((n) => n.id === 'src/plain.ts')?.inCycle, false);
  assert.equal(graph.nodes.find((n) => n.id === 'src/typed.ts')?.inCycle, false);
});

test('a file that only imports itself is still an orphan', async () => {
  const root = workspace({ 'src/island.ts': "import { x } from './island';\nexport const x = 1;\nconsole.log(x);\n", 'src/other.ts': 'export const o = 1;\n' });
  const ctx = context(root);
  const { findings } = analyzeProject(await indexProject(ctx), ctx.config);
  assert.ok(findings.some((f) => f.rule === 'orphan-file' && f.file === 'src/island.ts'));
});

test('a package __init__.py importing its own submodules is not a self-import', async () => {
  const root = workspace({ 'pkg/__init__.py': 'from . import models\n', 'pkg/models.py': 'class A:\n    pass\n', 'main.py': 'import pkg\n' });
  const ctx = context(root);
  const { cycles } = analyzeProject(await indexProject(ctx), ctx.config);
  assert.deepEqual(cycles, []);
});
