import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { createResolver } from '../src/core/ast/resolver.js';
import type { ImportRef } from '../src/core/ast/types.js';
import { cleanup, context, info, workspace } from './helpers.js';

// Each case is a miniature of a false positive found by running the analysis on a real repository
// (psf/requests, pallets/click, colinhacks/zod, t3-oss/create-t3-turbo) and checking the result by hand.
after(cleanup);

const ref = (source: string, names: string[] = ['x']): ImportRef => ({ source, names, line: 1, kind: 'import', typeOnly: false });

async function analyse(files: Record<string, string>) {
  const ctx = context(workspace(files));
  const project = await indexProject(ctx);
  return analyzeProject(project, ctx.config);
}
const rules = (a: { findings: { rule: string; file: string }[] }, rule: string): string[] => a.findings.filter((f) => f.rule === rule).map((f) => f.file).sort();

test('click/requests: `from . import submodule` inside a package is not a cycle through __init__', async () => {
  const a = await analyse({
    'src/pkg/__init__.py': 'from .core import run\n',
    'src/pkg/core.py': 'from . import types\n\n\ndef run():\n    return types.NAME\n',
    'src/pkg/types.py': 'NAME = "x"\n',
  });
  assert.deepEqual(a.graph.cycles ?? [], [], 'a child importing its sibling through the package is not a dependency cycle');
});

test('a real two-module cycle in a package is still reported', async () => {
  const a = await analyse({
    'src/pkg/__init__.py': 'from .a import fa\n',
    'src/pkg/a.py': 'from .b import fb\n\n\ndef fa():\n    return fb()\n',
    'src/pkg/b.py': 'from .a import fa\n\n\ndef fb():\n    return fa()\n',
  });
  assert.equal(rules(a, 'circular-dependency').length, 1);
});

test('click: a standard-library module is never unresolved because a directory of the same name exists', () => {
  const files = ['src/click/core.py', 'tests/test_options.py', 'tests/typing/typing_example.py'];
  const resolve = createResolver({ files, tsconfigs: [], pythonRoots: ['', 'src'] });
  const test = info('tests/test_options.py', 'python');
  assert.equal(resolve(test, ref('typing', ['Literal'])).unresolved, undefined);
  // The same shape for a name that is not in the standard library is still a broken import.
  const withLocal = createResolver({ files: [...files, 'tests/fixtures/helper.py'], tsconfigs: [], pythonRoots: ['', 'src'] });
  assert.equal(withLocal(test, ref('fixtures.nothing', ['x'])).unresolved?.reason, 'not-found');
});

test('requests: importing through a plain module file is unsupported (runtime sys.modules alias), not broken', () => {
  const files = ['src/requests/__init__.py', 'src/requests/packages.py', 'src/requests/api.py', 'tests/test_requests.py'];
  const resolve = createResolver({ files, tsconfigs: [], pythonRoots: ['', 'src'] });
  const test = info('tests/test_requests.py', 'python');
  assert.equal(resolve(test, ref('requests.packages.urllib3.poolmanager', ['PoolManager'])).unresolved?.reason, 'unsupported');
  assert.equal(resolve(test, ref('requests.missing_module', ['x'])).unresolved?.reason, 'not-found');
});

test('requests: a compat module that imports names for other modules to import is not full of unused imports', async () => {
  const a = await analyse({
    'src/pkg/__init__.py': '',
    'src/pkg/compat.py': 'from urllib.parse import quote, urlparse\nfrom collections import OrderedDict\n\nIS_COMPAT = True\n',
    'src/pkg/utils.py': 'from .compat import quote\n\n\ndef q(s):\n    return quote(s)\n',
  });
  const unused = a.findings.filter((f) => f.rule === 'unused-import' && f.file === 'src/pkg/compat.py').map((f) => f.message.split(' ')[0]);
  // quote is imported from here by utils.py, so it is a re-export; the other two are genuinely unused.
  assert.deepEqual(unused.sort(), ['OrderedDict', 'urlparse']);
});

test('zod docs: an import into a hidden generated directory (.source) is unsupported, not broken', async () => {
  const a = await analyse({
    'package.json': JSON.stringify({ name: 'docs' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
    'loaders/source.ts': "import { docs } from '@/.source';\nexport const d = docs;\n",
    'loaders/other.ts': "import { x } from '@/missing/thing';\nexport const y = x;\n",
  });
  const broken = a.unresolved?.filter((u: { reason: string }) => u.reason === 'not-found') ?? [];
  assert.ok(!broken.some((u: { file: string }) => u.file === 'loaders/source.ts'), 'a generated .source directory says nothing about the source being broken');
  assert.ok(broken.some((u: { file: string }) => u.file === 'loaders/other.ts'), 'a missing ordinary path is still reported');
});

test('create-t3-turbo: unused imports in generated route trees are not reported, the same code elsewhere is', async () => {
  const code = "import type { createStart } from '@tanstack/react-start';\nexport const tree = 1;\n";
  const a = await analyse({ 'src/routeTree.gen.ts': code, 'src/router.ts': code });
  assert.deepEqual(rules(a, 'unused-import'), ['src/router.ts']);
});

test('requests/click: an unused public name in an importable Python package module is only potentially unused', async () => {
  const a = await analyse({
    'src/lib/__init__.py': 'from .cookies import make_jar\n',
    'src/lib/cookies.py': 'class CookieConflictError(RuntimeError):\n    pass\n\n\ndef make_jar():\n    return {}\n',
    // The same shape outside a package: a plain script directory with no __init__.py.
    'misc/tool.py': 'def helper():\n    return 1\n\n\ndef unused_helper():\n    return 2\n',
    'misc/run.py': 'from tool import helper\n\nhelper()\n',
  });
  const dead = a.findings.filter((f) => f.rule === 'dead-export');
  const inPackage = dead.find((f) => f.file === 'src/lib/cookies.py');
  assert.ok(inPackage, 'the unused name is still reported');
  assert.equal(inPackage.classification, 'potentially-unused');
  assert.equal(inPackage.confidence, 'low');
  assert.match(inPackage.evidence.join(' '), /package\.module\.name/);
  const inScripts = dead.find((f) => f.file === 'misc/tool.py');
  assert.equal(inScripts?.classification, 'confidently-unused', 'outside a package nothing can reach the name by attribute');
});

test('express: module.exports = Fn required as a variable is a used default export, even when only its members are read', async () => {
  const a = await analyse({
    'package.json': JSON.stringify({ name: 'x' }),
    'ex/index.js': "var User = require('./user');\nUser.count(function () {});\nUser.all(function () {});\n",
    'ex/user.js': "'use strict'\n\nmodule.exports = User;\n\nfunction User(name) { this.name = name; }\n\nUser.all = function (fn) { fn(null, []); };\n",
    'ex/orphan-model.js': "module.exports = Orphan;\n\nfunction Orphan() {}\n",
  });
  assert.deepEqual(a.findings.filter((f) => f.rule === 'dead-export').map((f) => f.file), [], 'the required default export is used');
  assert.ok(a.findings.some((f) => f.rule === 'orphan-file' && f.file === 'ex/orphan-model.js'), 'a model nobody requires is still reported');
});
