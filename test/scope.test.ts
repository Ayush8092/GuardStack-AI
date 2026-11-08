import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { loadLanguages, parseFile } from '../src/core/ast/parser.js';

before(async () => {
  await loadLanguages(['typescript', 'tsx', 'javascript', 'python']);
});

const unused = (code: string, lang: 'typescript' | 'javascript' | 'python' = 'typescript') =>
  (parseFile(lang === 'python' ? 'm.py' : 'm.ts', lang, code)?.unusedImports ?? []).map((u) => u.name).sort();

test('a parameter with the same name does not count as a use of the import', () => {
  assert.deepEqual(unused("import { format } from './fmt';\nexport function f(format: string) { return format.trim(); }\n"), ['format']);
});

test('a local const, let, nested function and catch variable shadow the import', () => {
  const code = [
    "import { a, b, c, d } from './m';",
    'export function f() {',
    '  const a = 1;',
    '  function b() { return 2; }',
    '  try { risky(); } catch (c) { console.log(c); }',
    '  for (const d of [1]) { console.log(d); }',
    '  return a + b();',
    '}',
  ].join('\n');
  assert.deepEqual(unused(code), ['a', 'b', 'c', 'd']);
});

test('a declaration of the same name is not a use, a real use alongside it still is', () => {
  assert.deepEqual(unused("import { x } from './m';\nexport function f() { const x = 1; return x; }\nexport const g = () => x;\n"), []);
  assert.deepEqual(unused("import { x } from './m';\nexport function f() { const x = 1; return x; }\n"), ['x']);
});

test('arrow parameters, destructured parameters and var hoisting shadow', () => {
  assert.deepEqual(unused("import { v, p, q } from './m';\nexport const f = (v) => v;\nexport function g({ p }, [q]) { return p + q; }\n"), ['p', 'q', 'v']);
  assert.deepEqual(unused("import { h } from './m';\nexport function f() { if (true) { var h = 1; } return h; }\n"), ['h']);
});

test('property names, object keys and type-only parameter names are not uses', () => {
  const code = "import { name, id } from './m';\nexport const o = { name: 1 };\nexport const n = o.name;\nexport type Fn = (id: number) => void;\n";
  assert.deepEqual(unused(code), ['id', 'name']);
});

test('shadowing in one function does not hide a genuine use in another', () => {
  const code = "import { t } from './m';\nexport function a(t: number) { return t; }\nexport function b() { return t(); }\n";
  assert.deepEqual(unused(code), []);
});

test('uses inside nested scopes, default values and JSX still count', () => {
  assert.deepEqual(unused("import { k } from './m';\nexport function f(x = k) { return () => [x].map(() => k); }\n"), []);
  const tsx = parseFile('c.tsx', 'tsx', "import { Card } from './card';\nexport const A = () => <Card />;\n");
  assert.deepEqual(tsx?.unusedImports, []);
});

test('python: parameters, local assignments, loop and comprehension variables shadow imports', () => {
  const code = [
    'from m import a, b, c, d, e',
    'def f(a):',
    '    return a',
    'def g():',
    '    b = 1',
    '    return b',
    'def h():',
    '    for c in range(3):',
    '        print(c)',
    'x = [d for d in range(3)]',
    'print(e)',
  ].join('\n');
  assert.deepEqual(unused(code, 'python'), ['a', 'b', 'c', 'd']);
});

test('python: keyword argument names are not uses, real loads and global names are', () => {
  assert.deepEqual(unused('import os\nprint(1, os=2)\n', 'python'), ['os']);
  assert.deepEqual(unused('import os\ndef f():\n    return os.getcwd()\n', 'python'), []);
  assert.deepEqual(unused('import os\ndef f():\n    global os\n    return os.sep\n', 'python'), []);
  assert.deepEqual(unused('import os\ndef f():\n    os = 1\n    return os\ndef g():\n    return os.sep\n', 'python'), []);
  assert.deepEqual(unused('import os\ndef f():\n    os = 1\n    return os\n', 'python'), ['os']);
});

// ---- regression: closures, destructuring, shadowing, class scopes, comprehensions ----

test('closures: an inner function sees the nearest binding, not the import behind it', () => {
  const code = [
    "import { fmt, log, a } from './m';",
    'export function outer() {',
    '  const fmt = (x: number) => x;',
    '  return () => fmt(1);',
    '}',
    'export function other() { return () => log(1); }',
    'export function mixed() { a(); return (a: number) => a; }',
  ].join('\n');
  assert.deepEqual(unused(code), ['fmt']);
});

test('closures: a use two levels down still reaches the import, a shadow in between does not', () => {
  const code = [
    "import { deep, hidden } from './m';",
    'export const f = () => () => () => deep();',
    'export const g = (hidden: number) => () => hidden;',
  ].join('\n');
  assert.deepEqual(unused(code), ['hidden']);
});

test('destructuring: the renamed local shadows, the property key is not a use, defaults are uses', () => {
  const code = [
    "import { value, fmt, dflt, first, rest } from './m';",
    'export function f(obj: any, list: number[], { n = dflt }: { n?: number } = {}) {',
    '  const { value: fmt } = obj;',
    '  const [first, ...rest] = list;',
    '  return [fmt, first, rest, n];',
    '}',
  ].join('\n');
  assert.deepEqual(unused(code), ['first', 'fmt', 'rest', 'value']);
});

test('destructuring: nested patterns declare every leaf', () => {
  const code = [
    "import { a, b, c, d } from './m';",
    'export function f(o: any) {',
    '  const { x: { a }, y: [b, { c }], ...d } = o;',
    '  return [a, b, c, d];',
    '}',
  ].join('\n');
  assert.deepEqual(unused(code), ['a', 'b', 'c', 'd']);
});

test('shadowing: a block-scoped binding hides the import only inside its block', () => {
  const code = [
    "import { x, y } from './m';",
    'export function f() {',
    '  { let x = 1; console.log(x); }',
    '  { const y = 2; console.log(y); }',
    '  return x;',
    '}',
  ].join('\n');
  assert.deepEqual(unused(code), ['y']);
});

test('shadowing: a named function expression and a local class hide the import inside their own scope', () => {
  const code = [
    "import { fmt, Widget, kept } from './m';",
    'export const g = function fmt() { return fmt; };',
    'export function f() { class Widget {} return new Widget(); }',
    'export const h = function inner() { return kept; };',
  ].join('\n');
  assert.deepEqual(unused(code), ['Widget', 'fmt']);
});

test('shadowing: shorthand properties, export specifiers and typeof queries are uses', () => {
  const code = [
    "import { a, b, c, d } from './m';",
    'export const o = { a };',
    'export { b };',
    'export type T = typeof c;',
    'export function f() { return { d }; }',
  ].join('\n');
  assert.deepEqual(unused(code), []);
});

test('shadowing: a generic type parameter hides an imported type of the same name', () => {
  const code = ["import type { T, U } from './m';", 'export function id<T>(x: T): T { return x; }', 'export const u: U = null as any;'].join('\n');
  assert.deepEqual(unused(code), ['T']);
});

test('class scopes: members named like an import are not uses, field initializers and heritage are', () => {
  const code = [
    "import { name, helper, seed, Base, run } from './m';",
    'export class A extends Base {',
    '  name = 1;',
    '  helper() { return this.name; }',
    '  static count = seed();',
    '  run(run: number) { return run; }',
    '}',
  ].join('\n');
  assert.deepEqual(unused(code), ['helper', 'name', 'run']);
});

test('class scopes: this.member and obj.member are never uses of a same-named import', () => {
  const code = ["import { name, id } from './m';", 'export class A { name = 1; show(o: { id: number }) { return this.name + o.id; } }'].join('\n');
  assert.deepEqual(unused(code), ['id', 'name']);
});

test('python comprehensions: the loop variable is local to the comprehension and does not leak', () => {
  const code = [
    'from m import x, items, limit, k, v, n, c, row',
    'def f():',
    '    ys = [x for x in items if x > limit]',
    '    d = {k: v for k, v in ys}',
    '    s = sum(n for n in ys)',
    '    g = [[c for c in row] for row in ys]',
    '    return ys, d, s, g, x',
  ].join('\n');
  // x is used again after the comprehension, so that one is the import; the others only ever appear as loop variables.
  assert.deepEqual(unused(code, 'python'), ['c', 'k', 'n', 'row', 'v']);
});

test('python comprehensions: only the loop variable is local, the first iterable is read from the enclosing scope', () => {
  const code = ['from m import items, other', 'def f():', '    return [i for i in items], [other for other in range(3)]'].join('\n');
  assert.deepEqual(unused(code, 'python'), ['other']);
});

test('python comprehensions: a walrus target binds in the enclosing function', () => {
  const code = ['from m import y, make', 'def f(data):', '    [y := make(i) for i in data]', '    return y'].join('\n');
  assert.deepEqual(unused(code, 'python'), ['y']);
});

test('python class scopes: class-body names are not visible inside methods', () => {
  const code = [
    'from m import helper, shared, local',
    'class A:',
    '    helper = 1',
    '    shared = 2',
    '    local = 3',
    '    value = local + 1',
    '    def run(self):',
    '        return helper',
  ].join('\n');
  // run() reads the module-level helper (a use); shared is shadowed in the class body and never read; local is read in the class body.
  assert.deepEqual(unused(code, 'python'), ['local', 'shared']);
});

test('python: lambda parameters, except-as and with-as bindings shadow imports', () => {
  const code = [
    'from m import n, e, fh, kept',
    'f = lambda n: n + 1',
    'g = lambda: kept',
    'def run(p):',
    '    try:',
    '        pass',
    '    except ValueError as e:',
    '        print(e)',
    '    with open(p) as fh:',
    '        print(fh)',
  ].join('\n');
  assert.deepEqual(unused(code, 'python'), ['e', 'fh', 'n']);
});

test('python: a string forward reference in a subscript or cast() is a use of the import', () => {
  const code = [
    'from typing import Any, Callable, cast, TYPE_CHECKING',
    'if TYPE_CHECKING:',
    '    from m import Response, CookieJar, Plain, Other',
    'Hook = Callable[["Response"], Any]',
    'def f(x):',
    '    jar = cast("CookieJar", x)',
    '    label = "Plain"',
    '    return jar, label, {"Other": 1}["Other"]',
  ].join('\n');
  // Response and CookieJar are named in type positions. "Plain" is an ordinary string, so it is still unused. A string used
  // as a subscript index is indistinguishable from a forward reference, so Other counts as used: a deliberate trade of a
  // little recall for fewer false positives.
  assert.deepEqual(unused(code, 'python'), ['Plain']);
});
