import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyze, analyzeProject } from '../src/core/ast/analysis.js';
import { findCycles } from '../src/core/ast/graph.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { createResolver } from '../src/core/ast/resolver.js';
import { loadTsConfigs, parseJsonc } from '../src/core/ast/tsconfig.js';
import type { ImportRef } from '../src/core/ast/types.js';
import { cleanup, context, info, workspace } from './helpers.js';

after(cleanup);

const ref = (source: string, names: string[] = ['x'], kind: ImportRef['kind'] = 'import', typeOnly = false): ImportRef => ({ source, names, line: 1, kind, typeOnly });

test('parses JSONC with comments, trailing commas and comment-like strings', () => {
  const parsed = parseJsonc('{\n // c\n "a": "http://x/*not a comment*/", /* b */ "list": [1, 2,],\n}\n') as { a: string; list: number[] };
  assert.equal(parsed.a, 'http://x/*not a comment*/');
  assert.deepEqual(parsed.list, [1, 2]);
});

test('resolves relative imports, .js to .ts mapping and directory index files', () => {
  const resolve = createResolver({ files: ['src/a.ts', 'src/b.ts', 'src/lib/index.ts', 'src/c.tsx'], tsconfigs: [], pythonRoots: [''] });
  const from = info('src/a.ts');
  assert.equal(resolve(from, ref('./b')).targets[0].file, 'src/b.ts');
  assert.equal(resolve(from, ref('./b.js')).targets[0].file, 'src/b.ts');
  assert.equal(resolve(from, ref('./lib')).targets[0].file, 'src/lib/index.ts');
  assert.equal(resolve(from, ref('./c')).targets[0].file, 'src/c.tsx');
  assert.equal(resolve(from, ref('./missing')).unresolved?.reason, 'not-found');
  assert.equal(resolve(from, ref('../../outside')).unresolved?.reason, 'not-found');
});

test('understands tsconfig paths, baseUrl and extends', async () => {
  const root = workspace({
    'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": "./src", "paths": { "@app/*": ["app/*"], "@app/special": ["special/index.ts"] } } }',
    'tsconfig.json': '{ "extends": "./tsconfig.base.json" }',
    'src/app/util.ts': 'export const util = 1;\n',
    'src/special/index.ts': 'export const special = 1;\n',
    'src/shared/thing.ts': 'export const thing = 1;\n',
    'src/main.ts': 'import { util } from "@app/util";\nimport { special } from "@app/special";\nimport { thing } from "shared/thing";\nimport fs from "node:fs";\nimport lodash from "lodash";\nconsole.log(util, special, thing, fs, lodash);\n',
  });
  const ctx = context(root);
  const project = await indexProject(ctx);
  assert.equal(project.tsconfigs.length, 2);

  const { graph, unresolved } = analyzeProject(project, ctx.config);
  const targets = graph.links.filter((l) => l.source === 'src/main.ts').map((l) => l.target).sort();
  assert.deepEqual(targets, ['src/app/util.ts', 'src/shared/thing.ts', 'src/special/index.ts']);
  assert.deepEqual(unresolved, []);
});

test('uses the nearest tsconfig for each file', () => {
  const configs = loadTsConfigs(workspace({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }', 'pkg/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["lib/*"] } } }' }), ['tsconfig.json', 'pkg/tsconfig.json']);
  const resolve = createResolver({ files: ['src/x.ts', 'pkg/lib/x.ts', 'pkg/a.ts', 'a.ts'], tsconfigs: configs, pythonRoots: [''] });
  assert.equal(resolve(info('pkg/a.ts'), ref('@/x')).targets[0].file, 'pkg/lib/x.ts');
  assert.equal(resolve(info('a.ts'), ref('@/x')).targets[0].file, 'src/x.ts');
});

test('reports ambiguity as unresolved and unknown aliases as unsupported instead of guessing', () => {
  const configs = [
    { file: 'tsconfig.json', dir: '', pathsBase: '', paths: [{ pattern: '@/*', targets: ['a/*'] }] },
    { file: 'tsconfig.app.json', dir: '', pathsBase: '', paths: [{ pattern: '@/*', targets: ['b/*'] }] },
  ];
  const resolve = createResolver({ files: ['a/x.ts', 'b/x.ts', 'main.ts', 'utils/x.ts'], tsconfigs: configs, pythonRoots: [''] });
  const ambiguous = resolve(info('main.ts'), ref('@/x')).unresolved;
  assert.equal(ambiguous?.reason, 'ambiguous');
  assert.deepEqual(ambiguous?.candidates, ['a/x.ts', 'b/x.ts']);

  const bare = createResolver({ files: ['main.ts', 'utils/x.ts'], tsconfigs: [], pythonRoots: [''] });
  assert.equal(bare(info('main.ts'), ref('@/utils/x')).unresolved?.reason, 'unsupported');
  assert.deepEqual(bare(info('main.ts'), ref('react')).targets, []);
  assert.equal(bare(info('main.ts'), ref('react')).unresolved, undefined);
  assert.equal(bare(info('main.ts'), ref('./styles.css')).unresolved, undefined);
});

test('distinguishes files left out of the index from files that do not exist', () => {
  const resolve = createResolver({ files: ['a.ts'], known: ['a.ts', 'b.ts'], tsconfigs: [], pythonRoots: [''] });
  assert.equal(resolve(info('a.ts'), ref('./b')).unresolved?.reason, 'not-indexed');
  assert.equal(resolve(info('a.ts'), ref('./c')).unresolved?.reason, 'not-found');
});

test('resolves Python packages, relative imports and refuses ambiguous roots', () => {
  const files = ['pkg/__init__.py', 'pkg/models.py', 'pkg/app.py', 'pkg/sub/__init__.py', 'pkg/sub/deep.py', 'src/shared.py', 'shared.py'];
  const resolve = createResolver({ files, tsconfigs: [], pythonRoots: ['', 'src'] });
  const app = info('pkg/app.py', 'python');

  assert.equal(resolve(app, ref('.models', ['User'])).targets[0].file, 'pkg/models.py');
  // `from . import sub` loads the submodule; the package __init__ is only implied, so it is not a dependency edge.
  assert.deepEqual(resolve(app, ref('.', ['sub'])).targets.map((t) => t.file).sort(), ['pkg/sub/__init__.py']);
  assert.deepEqual(resolve(app, ref('.', ['VERSION'])).targets.map((t) => t.file).sort(), ['pkg/__init__.py'], 'a name that is not a submodule comes from __init__');
  assert.equal(resolve(app, ref('pkg.sub.deep', ['*'])).targets[0].file, 'pkg/sub/deep.py');
  assert.equal(resolve(app, ref('..outside', ['x'])).unresolved?.reason, 'not-found');
  assert.equal(resolve(app, ref('os', ['path'])).unresolved, undefined);
  assert.equal(resolve(app, ref('pkg.nothing', ['x'])).unresolved?.reason, 'not-found');

  const ambiguous = resolve(app, ref('shared', ['x'])).unresolved;
  assert.equal(ambiguous?.reason, 'ambiguous');
  assert.deepEqual(ambiguous?.candidates, ['shared.py', 'src/shared.py']);
});

test('finds strongly connected components and the shortest path through them', () => {
  const edges = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a', 'd']],
    ['d', ['e']],
    ['e', ['d']],
    ['f', ['a']],
  ]);
  const cycles = findCycles(['a', 'b', 'c', 'd', 'e', 'f'], edges);
  assert.deepEqual(cycles.map((c) => c.modules), [['a', 'b', 'c'], ['d', 'e']]);
  assert.deepEqual(cycles[0].path, ['a', 'b', 'c', 'a']);
  assert.deepEqual(cycles[1].path, ['d', 'e', 'd']);
});

test('cycle detection survives a very long dependency chain', () => {
  const nodes = Array.from({ length: 50_000 }, (_, i) => `n${i}`);
  const edges = new Map(nodes.map((n, i) => [n, i + 1 < nodes.length ? [nodes[i + 1]] : [nodes[0]]]));
  const cycles = findCycles(nodes, edges);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].modules.length, 50_000);
});

test('reports circular dependencies but ignores type-only and lazy edges', async () => {
  const root = workspace({
    'src/a.ts': 'import { b } from "./b";\nexport const a = () => b;\n',
    'src/b.ts': 'import { a } from "./a";\nexport const b = () => a;\n',
    'src/t1.ts': 'import type { T2 } from "./t2";\nexport type T1 = T2;\n',
    'src/t2.ts': 'import { type T1 } from "./t1";\nexport type T2 = T1 | string;\n',
    'src/l1.ts': 'export const l1 = () => import("./l2");\n',
    'src/l2.ts': 'import { l1 } from "./l1";\nexport const l2 = l1;\n',
    'pkg/x.py': 'from . import y\n',
    'pkg/y.py': 'from . import x\n',
    'pkg/z.py': 'def f():\n    from . import w\n',
    'pkg/w.py': 'from . import z\n',
    'pkg/__init__.py': '',
  });
  const ctx = context(root);
  const { findings, cycles, graph } = analyzeProject(await indexProject(ctx), ctx.config);

  assert.deepEqual(cycles.map((c) => c.modules), [['pkg/x.py', 'pkg/y.py'], ['src/a.ts', 'src/b.ts']]);
  const cycleFindings = findings.filter((f) => f.rule === 'circular-dependency');
  assert.equal(cycleFindings.length, 2);
  assert.match(cycleFindings[1].message, /src\/a\.ts → src\/b\.ts → src\/a\.ts/);
  assert.equal(graph.links.find((l) => l.source === 'src/t1.ts')?.runtime, false);
  assert.equal(graph.links.find((l) => l.source === 'src/l1.ts')?.runtime, false);
  assert.equal(graph.nodes.find((n) => n.id === 'src/a.ts')?.inCycle, true);
});

test('follows barrels so dead exports are found behind them', () => {
  const files = [
    { ...info('src/lib/index.ts'), imports: [ref('./a', ['*'], 'reexport'), ref('./b', ['b'], 'reexport')], reexports: [{ source: './a', imported: '*', exported: '*' }, { source: './b', imported: 'b', exported: 'b' }] },
    { ...info('src/lib/a.ts'), symbols: [{ name: 'used', kind: 'const' as const, line: 1, signature: 'const used', exportName: 'used' }, { name: 'dead', kind: 'const' as const, line: 2, signature: 'const dead', exportName: 'dead' }] },
    { ...info('src/lib/b.ts'), symbols: [{ name: 'b', kind: 'const' as const, line: 1, signature: 'const b', exportName: 'b' }] },
    { ...info('src/app.ts'), imports: [ref('./lib', ['used', 'b'])] },
  ];
  const dead = analyze(files).findings.filter((f) => f.rule === 'dead-export').map((f) => `${f.file}:${f.key.split('|')[2]}`);
  assert.deepEqual(dead, ['src/lib/a.ts:dead']);
});

test('detects unresolved imports as findings', async () => {
  const root = workspace({ 'a.ts': 'import { x } from "./gone";\nconsole.log(x);\n' });
  const ctx = context(root);
  const { findings } = analyzeProject(await indexProject(ctx), ctx.config);
  assert.ok(findings.some((f) => f.rule === 'unresolved-import' && f.message.includes('./gone')));
});
