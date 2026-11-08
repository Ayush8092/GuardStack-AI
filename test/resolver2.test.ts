import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { loadPackages, resolveMap } from '../src/core/ast/packages.js';
import { createResolver } from '../src/core/ast/resolver.js';
import { configCovers, globToRegExp, loadTsConfigs } from '../src/core/ast/tsconfig.js';
import type { ImportRef } from '../src/core/ast/types.js';
import { cleanup, context, info, workspace } from './helpers.js';

after(cleanup);

const ref = (source: string): ImportRef => ({ source, names: ['*'], line: 1, kind: 'import', typeOnly: false });
const reader = (files: Record<string, string>) => (rel: string) => files[rel] ?? null;

test('package exports maps resolve conditions, subpaths and patterns', () => {
  const map = { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './utils': './dist/utils.js', './features/*': './dist/features/*.js' };
  assert.equal(resolveMap(map, '.'), './dist/index.d.ts');
  assert.equal(resolveMap(map, './utils'), './dist/utils.js');
  assert.equal(resolveMap(map, './features/a'), './dist/features/a.js');
  assert.equal(resolveMap(map, './missing'), undefined);
  assert.equal(resolveMap('./main.js', '.'), './main.js');
  assert.equal(resolveMap({ import: './esm.js', require: './cjs.js' }, '.'), './esm.js');
  assert.equal(resolveMap({ '#internal/*': './src/internal/*.ts' }, '#internal/x'), './src/internal/x.ts');
});

test('workspace packages resolve through exports and main back to their source', () => {
  const packages = loadPackages(
    reader({
      'packages/core/package.json': JSON.stringify({ name: '@acme/core', exports: { '.': './dist/index.js', './util': './dist/util.js' } }),
      'packages/old/package.json': JSON.stringify({ name: 'old-lib', main: 'lib/main.js' }),
      'packages/odd/package.json': JSON.stringify({ name: 'odd', exports: { '.': './weird/entry.js' } }),
    }),
    ['packages/core/package.json', 'packages/old/package.json', 'packages/odd/package.json'],
  );
  const files = ['packages/core/src/index.ts', 'packages/core/src/util.ts', 'packages/old/src/main.ts', 'apps/web/page.ts', 'packages/odd/index.ts'];
  const resolve = createResolver({ files, tsconfigs: [], packages, pythonRoots: [''] });
  const from = info('apps/web/page.ts');

  assert.deepEqual(resolve(from, ref('@acme/core')).targets.map((t) => t.file), ['packages/core/src/index.ts']);
  assert.deepEqual(resolve(from, ref('@acme/core/util')).targets.map((t) => t.file), ['packages/core/src/util.ts']);
  assert.deepEqual(resolve(from, ref('old-lib')).targets.map((t) => t.file), ['packages/old/src/main.ts']);
  // The map points at a path that is not source here: not a broken import, just one this tool cannot follow.
  assert.equal(resolve(from, ref('odd')).unresolved?.reason, 'unsupported');
  assert.equal(resolve(from, ref('@acme/core/not-exported')).unresolved?.reason, 'unsupported');
  assert.equal(resolve(from, ref('react')).unresolved, undefined);
});

test('a built package maps back to source through the tsconfig outDir and rootDir', () => {
  const packages = loadPackages(reader({ 'lib/package.json': JSON.stringify({ name: 'lib', main: './out/index.js' }) }), ['lib/package.json']);
  const tsconfigs = loadTsConfigs(reader({ 'lib/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'out', rootDir: 'source' } }) }), ['lib/tsconfig.json']);
  const resolve = createResolver({ files: ['lib/source/index.ts', 'app.ts'], tsconfigs, packages, pythonRoots: [''] });
  assert.deepEqual(resolve(info('app.ts'), ref('lib')).targets.map((t) => t.file), ['lib/source/index.ts']);
});

test('package.json "imports" subpath specifiers resolve and unknown ones are reported', () => {
  const packages = loadPackages(reader({ 'package.json': JSON.stringify({ name: 'app', imports: { '#db': './src/db/index.ts', '#lib/*': './src/lib/*.ts' } }) }), ['package.json']);
  const resolve = createResolver({ files: ['src/db/index.ts', 'src/lib/log.ts', 'src/main.ts'], tsconfigs: [], packages, pythonRoots: [''] });
  const from = info('src/main.ts');
  assert.deepEqual(resolve(from, ref('#db')).targets.map((t) => t.file), ['src/db/index.ts']);
  assert.deepEqual(resolve(from, ref('#lib/log')).targets.map((t) => t.file), ['src/lib/log.ts']);
  assert.equal(resolve(from, ref('#nope')).unresolved?.reason, 'not-found');
  assert.equal(createResolver({ files: ['a.ts'], tsconfigs: [], packages: [], pythonRoots: [''] })(info('a.ts'), ref('#x')).unresolved?.reason, 'unsupported');
});

test('framework aliases come from the dependencies that define them', () => {
  const sveltekit = loadPackages(reader({ 'package.json': JSON.stringify({ name: 'kit', devDependencies: { '@sveltejs/kit': '2' } }) }), ['package.json']);
  const svelte = createResolver({ files: ['src/lib/db.ts', 'src/routes/page.ts'], tsconfigs: [], packages: sveltekit, pythonRoots: [''] });
  assert.deepEqual(svelte(info('src/routes/page.ts'), ref('$lib/db')).targets.map((t) => t.file), ['src/lib/db.ts']);
  assert.equal(svelte(info('src/routes/page.ts'), ref('$app/navigation')).unresolved, undefined);

  const nuxt = loadPackages(reader({ 'package.json': JSON.stringify({ name: 'n', dependencies: { nuxt: '3' } }) }), ['package.json']);
  const resolve = createResolver({ files: ['utils/format.ts', 'pages/index.ts'], tsconfigs: [], packages: nuxt, pythonRoots: [''] });
  assert.deepEqual(resolve(info('pages/index.ts'), ref('~/utils/format')).targets.map((t) => t.file), ['utils/format.ts']);

  // Without that framework the same specifier is an alias nobody here defines.
  const none = createResolver({ files: ['src/lib/db.ts', 'src/a.ts'], tsconfigs: [], packages: [], pythonRoots: [''] });
  assert.equal(none(info('src/a.ts'), ref('$lib/db')).unresolved?.reason, 'unsupported');
});

test('tsconfig include and exclude decide which config applies to a file', () => {
  const configs = loadTsConfigs(
    reader({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'], exclude: ['src/legacy'] }),
      'tsconfig.test.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['test-src/*'] } }, include: ['test/**/*.ts'] }),
    }),
    ['tsconfig.json', 'tsconfig.test.json'],
  );
  const [app, test_] = configs;
  assert.ok(configCovers(app, 'src/a.ts') && !configCovers(app, 'src/legacy/a.ts') && !configCovers(app, 'test/a.ts'));
  assert.ok(configCovers(test_, 'test/deep/a.ts') && !configCovers(test_, 'src/a.ts'));

  const resolve = createResolver({ files: ['src/x.ts', 'test-src/x.ts', 'src/main.ts', 'test/a.ts'], tsconfigs: configs, pythonRoots: [''] });
  assert.deepEqual(resolve(info('src/main.ts'), ref('@/x')).targets.map((t) => t.file), ['src/x.ts']);
  assert.deepEqual(resolve(info('test/a.ts'), ref('@/x')).targets.map((t) => t.file), ['test-src/x.ts']);
});

test('glob conversion follows TypeScript include semantics', () => {
  assert.ok(globToRegExp('src').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts') && globToRegExp('src/**/*.ts').test('src/b.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('a?.ts').test('ab.ts'));
});

test('references are loaded even when their file name is not tsconfig-like, and solution roots claim nothing', () => {
  const configs = loadTsConfigs(
    reader({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './packages/a' }, { path: './config/ts.app.json' }] }),
      'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#a/*': ['src/*'] } } }),
      'config/ts.app.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '~/*': ['app/*'] } } }),
    }),
    ['tsconfig.json'],
  );
  assert.deepEqual(configs.map((c) => c.file), ['config/ts.app.json', 'packages/a/tsconfig.json', 'tsconfig.json']);
  const root = configs.find((c) => c.file === 'tsconfig.json');
  assert.ok(root && !configCovers(root, 'packages/a/src/x.ts'));
});

test('extends resolves package-based configs and workspace packages through node_modules', () => {
  const configs = loadTsConfigs(
    reader({
      'tsconfig.json': JSON.stringify({ extends: ['@acme/tsconfig/base.json', 'shared-config'] }),
      'node_modules/@acme/tsconfig/base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@x/*': ['x/*'] } } }),
      'node_modules/shared-config/package.json': JSON.stringify({ tsconfig: 'ts/tsconfig.json' }),
      'node_modules/shared-config/ts/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'build' } }),
    }),
    ['tsconfig.json'],
  );
  assert.equal(configs[0].outDir, 'node_modules/shared-config/ts/build');
  assert.deepEqual(configs[0].paths, [{ pattern: '@x/*', targets: ['x/*'] }]);
});

test('end to end: a monorepo gets cross-package edges, so packages are not reported as orphans', async () => {
  const root = workspace({
    'package.json': JSON.stringify({ name: 'mono', private: true }),
    'packages/ui/package.json': JSON.stringify({ name: '@mono/ui', exports: { '.': './dist/index.js' } }),
    'packages/ui/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
    'packages/ui/src/index.ts': "export { Button } from './button';\n",
    'packages/ui/src/button.ts': 'export const Button = () => 1;\nexport const Unused = 2;\n',
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '15' } }),
    'apps/web/src/main.ts': "import { Button } from '@mono/ui';\nimport { z } from '@/missing-alias';\nconsole.log(Button, z);\n",
  });
  const ctx = context(root);
  const result = analyzeProject(await indexProject(ctx), ctx.config);
  assert.ok(result.graph.links.some((l) => l.source === 'apps/web/src/main.ts' && l.target === 'packages/ui/src/index.ts'));
  assert.ok(!result.findings.some((f) => f.rule === 'orphan-file' && f.file.startsWith('packages/ui')));
  assert.ok(!result.findings.some((f) => f.rule === 'dead-export' && f.key.endsWith('|Button')));
  assert.ok(result.findings.some((f) => f.rule === 'dead-export' && f.key.endsWith('|Unused')));
  assert.deepEqual(result.unsupported.map((u) => u.spec), ['@/missing-alias']);
  assert.ok(!result.findings.some((f) => f.rule === 'unresolved-import'), 'an unsupported alias must not be reported as a broken import');
});

test('a trailing slash names the directory: require("../../") reaches the package root, "./lib/" reaches lib/index', () => {
  const resolve = createResolver({ files: ['index.js', 'lib/index.js', 'examples/a/app.js', 'src/x.js'], tsconfigs: [], pythonRoots: [''] });
  assert.deepEqual(resolve(info('examples/a/app.js'), ref('../../')).targets.map((t) => t.file), ['index.js']);
  assert.deepEqual(resolve(info('src/x.js'), ref('../lib/')).targets.map((t) => t.file), ['lib/index.js']);
  assert.deepEqual(resolve(info('src/x.js'), ref('..')).targets.map((t) => t.file), ['index.js']);
});

test('a directory that is a package resolves through its main field', () => {
  const packages = loadPackages(reader({ 'vendor/lib/package.json': JSON.stringify({ name: 'inner', main: './entry.js' }) }), ['vendor/lib/package.json']);
  const resolve = createResolver({ files: ['vendor/lib/entry.js', 'app.js'], tsconfigs: [], packages, pythonRoots: [''] });
  assert.deepEqual(resolve(info('app.js'), ref('./vendor/lib')).targets.map((t) => t.file), ['vendor/lib/entry.js']);
});

test('a relative import into a build directory that is not in the repository is not called broken', () => {
  const resolve = createResolver({ files: ['docs/example.js'], tsconfigs: [], pythonRoots: [''] });
  assert.equal(resolve(info('docs/example.js'), ref('../dist/index.js')).unresolved?.reason, 'unsupported');
  assert.equal(resolve(info('docs/example.js'), ref('./missing')).unresolved?.reason, 'not-found');
});
