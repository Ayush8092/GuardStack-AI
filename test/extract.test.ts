import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

async function parse(files: Record<string, string>) {
  const ctx = context(workspace(files));
  const project = await indexProject(ctx);
  const get = (p: string) => {
    const found = project.files.find((f) => f.path === p);
    assert.ok(found, `${p} was not indexed`);
    return found;
  };
  return { ctx, project, get };
}

const exportsOf = (file: { symbols: { name: string; exportName?: string }[] }) =>
  file.symbols.filter((s) => s.exportName).map((s) => `${s.name}=>${s.exportName}`).sort();

test('extracts destructured declarations, exported and local', async () => {
  const { get } = await parse({
    'a.ts': 'export const { a, b: renamed, c = 1, ...rest } = source;\nexport const [first, , third] = list;\nconst { hidden } = other;\nexport { hidden };\n',
  });
  assert.deepEqual(exportsOf(get('a.ts')), ['a=>a', 'c=>c', 'first=>first', 'hidden=>hidden', 'renamed=>renamed', 'rest=>rest', 'third=>third']);
});

test('tracks re-exports of every shape with their source and alias', async () => {
  const { get } = await parse({
    'index.ts':
      'export * from "./all";\nexport * as ns from "./space";\nexport { one, two as deux } from "./named";\nexport { default as Thing } from "./thing";\nimport { local as renamed } from "./local";\nexport { renamed as final };\nimport type { T } from "./types";\nexport type { T };\n',
  });
  const { reexports, imports } = get('index.ts');
  const key = (r: { source: string; imported: string; exported: string }) => `${r.source}:${r.imported}>${r.exported}`;
  assert.deepEqual(reexports.map(key).sort(), ['./all:*>*', './local:local>final', './named:one>one', './named:two>deux', './space:*>ns', './thing:default>Thing', './types:T>T']);
  assert.equal(imports.find((i) => i.source === './all')?.kind, 'reexport');
  assert.equal(imports.find((i) => i.source === './types')?.typeOnly, true);
});

test('tracks CommonJS exports and requires, including destructuring and member access', async () => {
  const { get } = await parse({
    'dep.js': 'exports.one = 1;\nmodule.exports.two = function () {};\n',
    'main.js':
      'const { one, two: renamed } = require("./dep");\nconst fs = require("fs");\nconst helper = () => 1;\nconst value = require("./other").thing;\nfunction lazy() { return require("./late"); }\nmodule.exports = { helper, extra: 5, method() {} };\nconsole.log(one, renamed, fs, value);\n',
  });
  assert.deepEqual(exportsOf(get('dep.js')), ['one=>one', 'two=>two']);
  assert.deepEqual(exportsOf(get('main.js')), ['extra=>extra', 'helper=>helper', 'method=>method']);

  const imports = get('main.js').imports;
  assert.deepEqual(imports.find((i) => i.source === './dep')?.names, ['one', 'two']);
  assert.equal(imports.find((i) => i.source === './dep')?.kind, 'require');
  assert.deepEqual(imports.find((i) => i.source === './other')?.names, ['thing']);
  assert.equal(imports.find((i) => i.source === './late')?.kind, 'dynamic');
  assert.deepEqual(get('main.js').unusedImports, []);
});

test('module.exports = require() is a re-export and a bare function export is the default', async () => {
  const { get } = await parse({ 'proxy.js': 'module.exports = require("./real");\n', 'fn.js': 'module.exports = function build() { return 1; };\n' });
  assert.deepEqual(get('proxy.js').reexports, [{ source: './real', imported: '*', exported: 'default' }]);
  assert.deepEqual(exportsOf(get('fn.js')), ['default=>default']);
});

test('alias tracking: renamed imports and namespace member access', async () => {
  const { get } = await parse({
    'a.ts':
      'import { original as alias, other } from "./m";\nimport * as ns from "./n";\nimport * as whole from "./w";\nconsole.log(alias, ns.first, ns.second);\nconst take = (x: unknown) => x;\ntake(whole);\nexport { other };\n',
  });
  const imports = get('a.ts').imports;
  assert.deepEqual(imports.find((i) => i.source === './m')?.names, ['original']);
  assert.deepEqual(imports.find((i) => i.source === './n')?.names.sort(), ['first', 'second']);
  assert.deepEqual(imports.find((i) => i.source === './w')?.names, ['*']);
  assert.deepEqual(get('a.ts').reexports, [{ source: './m', imported: 'other', exported: 'other' }]);
});

test('reports unused imports with AST reference checking', async () => {
  const { get } = await parse({
    'a.tsx':
      'import React from "react";\nimport { used, unused, TypeOnly } from "./m";\nimport * as ns from "./n";\nimport def from "./d";\nimport "./side-effect";\nconst x: TypeOnly = used;\nconst o = { def };\nexport const el = <div>{x}</div>;\n',
  });
  assert.deepEqual(get('a.tsx').unusedImports.map((u) => u.name).sort(), ['ns', 'unused']);
});

test('unused-import findings are emitted, and re-exported imports are not flagged', async () => {
  const { ctx, project } = await parse({
    'a.ts': 'import { a, b } from "./m";\nexport { b };\nexport const keep = 1;\n',
    'm.ts': 'export const a = 1;\nexport const b = 2;\n',
  });
  const unused = analyzeProject(project, ctx.config).findings.filter((f) => f.rule === 'unused-import');
  assert.equal(unused.length, 1);
  assert.match(unused[0].message, /^a is imported/);
});

test('Python unused imports honour noqa, __init__ re-exports, __all__ and quoted annotations', async () => {
  const { get } = await parse({
    'pkg/__init__.py': 'from .models import User\n',
    'pkg/models.py': 'class User:\n    pass\n',
    'pkg/app.py':
      'import os\nimport sys  # noqa: F401\nfrom typing import List, Dict\nfrom .models import User\nfrom . import helpers\n\ndef f(a: "Dict[str, int]") -> None:\n    print(helpers.path, os.path.join("a"))\n\n__all__ = ["User"]\n',
  });
  assert.deepEqual(get('pkg/app.py').unusedImports.map((u) => u.name), ['List']);
  assert.deepEqual(get('pkg/__init__.py').unusedImports, []);
  assert.deepEqual(get('pkg/__init__.py').reexports, [{ source: '.models', imported: 'User', exported: 'User' }]);
});

test('Python lazy and TYPE_CHECKING imports are not runtime dependencies', async () => {
  const { get } = await parse({
    'a.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from b import B\n\ndef f():\n    import c\n    return c\n\nx: "B"\n',
  });
  const imports = get('a.py').imports;
  assert.equal(imports.find((i) => i.source === 'b')?.typeOnly, true);
  assert.equal(imports.find((i) => i.source === 'c')?.kind, 'dynamic');
});
