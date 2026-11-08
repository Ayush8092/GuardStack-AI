import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { renderFindings } from '../src/core/ast/report.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

async function run(files: Record<string, string>, config: Record<string, unknown> = {}) {
  const ctx = context(workspace(files), config);
  return analyzeProject(await indexProject(ctx), ctx.config);
}

const fmtA = `export function formatA(d: Date, pad: number) {
  const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return parts.map((p) => String(p).padStart(2, '0')).join('-');
}
`;

test('every finding carries confidence, method, evidence and remediation', async () => {
  const { findings } = await run({
    'src/a.ts': `${fmtA}export const x: any = 1;\nimport { nope } from './gone';\nconsole.log(nope);\n`,
    'src/b.ts': 'import { unused } from "./a";\nexport const b = 1;\n',
  });
  assert.ok(findings.length >= 4);
  for (const f of findings) {
    assert.ok(['high', 'medium', 'low'].includes(f.confidence), f.rule);
    assert.ok(f.method.length > 0 && f.evidence.length > 0 && f.remediation.length > 0, f.rule);
  }
});

test('identical text and renamed-but-same-shape code are reported as different things', async () => {
  const exact = fmtA.replace('formatA', 'formatCopy');
  const renamed = `export const formatB = (when: Date, width: number) => {
  const bits = [when.getFullYear(), when.getMonth() + 1, when.getDate()];
  return bits.map((q) => String(q).padStart(2, '0')).join('-');
};
`;
  const { findings } = await run({ 'src/a.ts': fmtA, 'src/copy.ts': exact, 'src/b.ts': renamed, 'src/main.ts': "import './a'; import './copy'; import './b';\n" });

  const identical = findings.find((f) => f.rule === 'duplicate-body');
  const similar = findings.find((f) => f.rule === 'similar-structure');
  assert.ok(identical && /formatA/.test(identical.message) && /formatCopy/.test(identical.message));
  assert.equal(identical.confidence, 'high');
  assert.equal(identical.method, 'exact-text-match');
  assert.match(identical.message, /not a semantic comparison/);
  assert.ok(similar && /formatB/.test(similar.message));
  assert.equal(similar.confidence, 'medium');
  assert.equal(similar.method, 'normalized-structure-match');
  assert.ok(!/formatB/.test(identical.message), 'a renamed copy is not textually identical');
});

test('changing what the code does breaks the structural match', async () => {
  const different = fmtA.replace('formatA', 'other').replace('.map(', '.filter(');
  const { findings } = await run({ 'src/a.ts': fmtA, 'src/o.ts': different, 'src/main.ts': "import './a'; import './o';\n" });
  assert.ok(!findings.some((f) => f.rule === 'similar-structure' || f.rule === 'duplicate-body'));
});

test('the same name alone is a low-confidence name match', async () => {
  const { findings } = await run({
    'src/a.ts': 'export function load() { return 1; }\n',
    'src/b.ts': 'export function load(path: string) { return path.length * 7; }\n',
    'src/main.ts': "import './a'; import './b';\n",
  });
  const same = findings.find((f) => f.rule === 'duplicate-symbol');
  assert.ok(same);
  assert.equal(same.confidence, 'low');
  assert.equal(same.method, 'name-match');
});

test('orphans are classified: confidently unused, potentially unused and unreferenced', async () => {
  const ok = await run({
    'src/main.ts': "import { used } from './used';\nconsole.log(used);\n",
    'src/used.ts': 'export const used = 1;\n',
    'src/lost.ts': 'export const lost = 1;\n',
    'src/plugins/csv.ts': 'export const csv = 1;\n',
    'src/runner.ts': "export const run = (n: string) => import(`./loaders/${n}.js`);\n",
    'src/loaders/json.ts': 'export const json = 1;\n',
    'src/side.ts': 'console.log("hello");\n',
    'src/job.ts': '@Job()\nexport class Cleanup {}\n',
  });
  const by = (file: string) => ok.findings.find((f) => f.rule === 'orphan-file' && f.file === file);
  assert.equal(by('src/lost.ts')?.classification, 'confidently-unused');
  assert.equal(by('src/lost.ts')?.confidence, 'high');
  for (const file of ['src/plugins/csv.ts', 'src/loaders/json.ts', 'src/side.ts', 'src/job.ts']) {
    assert.equal(by(file)?.classification, 'potentially-unused', file);
    assert.equal(by(file)?.confidence, 'medium', file);
  }
  assert.ok(by('src/loaders/json.ts')?.evidence.some((e) => /loads modules from \.\/loaders\//.test(e)));
  assert.match(renderFindings(ok.findings, 15, true), /→ /);
});

test('an incomplete scan only ever says unreferenced', async () => {
  const ctx = context(workspace({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' }), { maxFiles: 1 });
  const { findings } = analyzeProject(await indexProject(ctx), ctx.config);
  const orphan = findings.find((f) => f.rule === 'orphan-file');
  assert.ok(orphan);
  assert.equal(orphan.classification, 'unreferenced');
  assert.equal(orphan.confidence, 'low');
});

test('unused exports are never more than medium confidence, and dynamic loading lowers them', async () => {
  const { findings } = await run({
    'src/main.ts': "import { a } from './lib';\nimport { q } from './plug/x';\nconsole.log(a, q);\n",
    'src/lib.ts': 'export const a = 1;\nexport const b = 2;\n',
    'src/plug/x.ts': 'export const q = 1;\nexport const p = 1;\n',
    'src/boot.ts': "import './main';\nexport const go = (n: string) => require('./plug/' + n);\n",
  });
  const dead = (name: string) => findings.find((f) => f.rule === 'dead-export' && f.key.endsWith(`|${name}`));
  assert.equal(dead('b')?.confidence, 'medium');
  assert.equal(dead('b')?.classification, 'confidently-unused');
  assert.equal(dead('p')?.classification, 'potentially-unused');
  assert.equal(dead('p')?.confidence, 'low');
});

test('public package exports and configured entry points are not dead', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'lib', exports: { '.': './dist/index.js', './extra': './dist/extra.js' }, bin: { tool: './dist/cli.js' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
    'src/index.ts': 'export const api = 1;\n',
    'src/extra.ts': 'export const more = 1;\n',
    'src/cli.ts': 'export const cli = 1;\n',
    'tools/seed.ts': 'export const seed = 1;\n',
    'tools/stray.ts': 'export const stray = 1;\n',
  };
  const without = (await run(files)).findings.filter((f) => f.rule === 'orphan-file').map((f) => f.file);
  assert.deepEqual(without.sort(), ['tools/seed.ts', 'tools/stray.ts']);

  const configured = (await run(files, { entryPoints: ['tools/seed.ts'] })).findings.filter((f) => f.rule === 'orphan-file').map((f) => f.file);
  assert.deepEqual(configured, ['tools/stray.ts']);
});

test('framework profiles are detected from dependencies and can be forced or turned off', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'site', dependencies: { next: '15' } }),
    'src/app/dashboard/page.tsx': 'export default function Page() { return null; }\n',
    'src/app/dashboard/widgets.tsx': 'export const Widget = () => null;\n',
    'src/lib/stray.ts': 'export const stray = 1;\n',
  };
  const auto = (await run(files)).findings.filter((f) => f.rule === 'orphan-file').map((f) => f.file);
  assert.deepEqual(auto, ['src/app/dashboard/widgets.tsx', 'src/lib/stray.ts']);
  const none = (await run(files, { profile: 'none' })).findings.filter((f) => f.rule === 'orphan-file').map((f) => f.file).sort();
  assert.deepEqual(none, ['src/app/dashboard/page.tsx', 'src/app/dashboard/widgets.tsx', 'src/lib/stray.ts']);
});

test('rule severities and project exceptions apply', async () => {
  const files = { 'src/a.ts': 'export const a: any = 1;\n', 'src/b.ts': '// @ts-ignore\nexport const b = 1;\n', 'src/main.ts': "import './a'; import './b';\n" };
  const base = (await run(files)).findings.filter((f) => f.rule === 'suppression');
  assert.equal(base.length, 2);

  const tuned = (await run(files, { rules: { suppression: 'high', 'orphan-file': 'off' }, exceptions: [{ rule: 'suppression', path: 'src/b.ts' }] })).findings;
  const sup = tuned.filter((f) => f.rule === 'suppression');
  assert.deepEqual(sup.map((f) => f.file), ['src/a.ts']);
  assert.equal(sup[0].severity, 'high');
});
