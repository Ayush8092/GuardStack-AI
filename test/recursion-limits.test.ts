import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/core/ast/analysis.js';
import { loadPackages, packageEntries, packageEntry, publicTargets, resolveMap } from '../src/core/ast/packages.js';
import type { ImportKind, ImportRef } from '../src/core/ast/types.js';
import { info } from './helpers.js';

// Far deeper than the JavaScript call stack allows a recursive walk to go. JSON.parse itself does not overflow at this depth.
const STACK_BUSTING = 200_000;

const ref = (source: string, names: string[], kind: ImportKind = 'import'): ImportRef => ({ source, names, line: 1, kind, typeOnly: false });
const manifest = (exportsJson: string): string => `{"name":"p","main":"./main.js","exports":${exportsJson}}`;
const nestedConditions = (key: string, depth: number, leaf: string): string => `{"${key}":`.repeat(depth) + leaf + '}'.repeat(depth);

function load(exportsJson: string) {
  const [pkg] = loadPackages((file) => (file === 'package.json' ? manifest(exportsJson) : null), ['package.json']);
  assert.ok(pkg, 'a package whose exports map is pathological must still load');
  return pkg;
}

test('an exports map nested far beyond the call stack is bounded, not a crash', () => {
  const pkg = load(`{".":{"import":${nestedConditions('default', STACK_BUSTING, '"./x.js"')}}}`);
  assert.doesNotThrow(() => resolveMap(pkg.exports, '.'));
  assert.doesNotThrow(() => packageEntries(pkg, '.'));
  assert.doesNotThrow(() => packageEntry(pkg, '.'));
  assert.doesNotThrow(() => publicTargets(pkg));
  // The target sits below the depth budget, so it is not found: a partial answer, never a wrong one.
  assert.equal(resolveMap(pkg.exports, '.'), undefined);
});

test('a deeply nested array of fallbacks in an exports map is bounded too', () => {
  const pkg = load(`{".":${'['.repeat(STACK_BUSTING)}"./x.js"${']'.repeat(STACK_BUSTING)}}`);
  assert.doesNotThrow(() => packageEntries(pkg, '.'));
  assert.doesNotThrow(() => publicTargets(pkg));
});

test('a very wide exports map stops at the node budget', () => {
  const entries = Array.from({ length: 50_000 }, (_, i) => `"./f${i}":"./f${i}.js"`).join(',');
  const pkg = load(`{${entries}}`);
  assert.doesNotThrow(() => publicTargets(pkg));
  assert.ok(publicTargets(pkg).length < 50_000, 'collection stops at the budget');
  assert.equal(resolveMap(pkg.exports, './f7'), './f7.js', 'direct lookups still work on a wide map');
});

test('realistic nested exports maps resolve exactly as before', () => {
  const map = {
    '.': { types: './index.d.ts', import: { node: './esm/node.js', default: './esm/index.js' }, require: './cjs/index.cjs' },
    './feature': ['./first.js', './second.js'],
    './internal/*': { default: './src/*.js' },
    './blocked': { browser: './browser.js' },
  };
  assert.equal(resolveMap(map, '.'), './index.d.ts', 'conditions are tried in the order the object lists them');
  assert.equal(resolveMap({ '.': { import: { node: './n.js', default: './d.js' } } }, '.'), './n.js');
  assert.equal(resolveMap(map, './feature'), './first.js', 'the first alternative of an array wins');
  assert.equal(resolveMap(map, './internal/util'), './src/util.js');
  assert.equal(resolveMap(map, './blocked'), undefined, 'an unrecognised condition is not picked');
  assert.equal(resolveMap({ '.': ['', './fallback.js'] }, '.'), './fallback.js', 'an empty alternative is skipped');

  const pkg = load(JSON.stringify(map));
  assert.deepEqual(packageEntries(pkg, '.'), ['./index.d.ts', './esm/node.js', './esm/index.js', './cjs/index.cjs', './index.d.ts'].filter((v, i, a) => a.indexOf(v) === i));
  assert.deepEqual(publicTargets(pkg), ['./index.d.ts', './esm/node.js', './esm/index.js', './cjs/index.cjs', './first.js', './second.js', './src/*.js', './browser.js', './main.js']);
});

test('a very long chain of re-exports is followed without overflowing the stack', () => {
  const length = 20_000;
  const files = Array.from({ length }, (_, i) => {
    const barrel = info(`src/b${i}.ts`);
    if (i < length - 1) {
      barrel.imports = [ref(`./b${i + 1}`, ['*'], 'reexport')];
      barrel.reexports = [{ source: `./b${i + 1}`, imported: '*', exported: '*' }];
    } else {
      barrel.symbols = [
        { name: 'live', kind: 'const', line: 1, signature: 'const live', exportName: 'live' },
        { name: 'dead', kind: 'const', line: 2, signature: 'const dead', exportName: 'dead' },
      ];
    }
    return barrel;
  });
  files.push({ ...info('src/app.ts'), imports: [ref('./b0', ['live'])] });

  const result = analyze(files);
  const dead = result.findings.filter((f) => f.rule === 'dead-export').map((f) => `${f.file}:${f.key.split('|')[2]}`);
  assert.deepEqual(dead, [`src/b${length - 1}.ts:dead`], 'the use of `live` is traced to the file that defines it, through every barrel');
});

test('a re-export cycle between barrels terminates', () => {
  const files = [
    { ...info('src/a.ts'), imports: [ref('./b', ['*'], 'reexport')], reexports: [{ source: './b', imported: '*', exported: '*' }] },
    { ...info('src/b.ts'), imports: [ref('./a', ['*'], 'reexport')], reexports: [{ source: './a', imported: '*', exported: '*' }], symbols: [{ name: 'v', kind: 'const' as const, line: 1, signature: 'const v', exportName: 'v' }] },
    { ...info('src/app.ts'), imports: [ref('./a', ['v'])] },
  ];
  const dead = analyze(files).findings.filter((f) => f.rule === 'dead-export');
  assert.deepEqual(dead, []);
});
