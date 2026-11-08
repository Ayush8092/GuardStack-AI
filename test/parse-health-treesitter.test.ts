// Real Tree-sitter parses, no mocked trees: the classification that health.ts produces for actual grammar output, and what
// the extractor keeps. The safety property behind the whole classification is the last test: a file is only called
// 'recovered' when every top-level declaration written in it was still extracted.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { loadLanguages, parseFile } from '../src/core/ast/parser.js';
import type { FileInfo, Lang } from '../src/core/ast/types.js';

before(async () => {
  await loadLanguages(['typescript', 'tsx', 'javascript', 'python']);
});

function parse(file: string, lang: Lang, lines: string[]): FileInfo {
  const info = parseFile(file, lang, lines.join('\n') + '\n');
  assert.ok(info, `${file} produced no tree`);
  return info;
}
const names = (info: FileInfo): string[] => info.symbols.map((s) => s.name);
const shown = (info: FileInfo): string => JSON.stringify({ parse: info.parse, symbols: names(info) });

// ---- recovered: the damage is inside a declaration body --------------------------------------------------------------

test('a syntax error inside an exported function body is recovered, and every export is kept', () => {
  const info = parse('a.ts', 'typescript', [
    'export function ok(a: number) { return a + 1; }',
    'export function broken(b: number) {',
    '  const x = ;',
    '  return b;',
    '}',
    'export const after = 1;',
  ]);
  assert.ok(info.parse, 'the error was not reported at all');
  assert.equal(info.parse.status, 'recovered', shown(info));
  for (const name of ['ok', 'broken', 'after']) assert.ok(names(info).includes(name), `${name} was lost: ${shown(info)}`);
  assert.equal(info.symbols.find((s) => s.name === 'broken')?.partial, true, 'the damaged declaration is not marked partial');
  assert.ok(!info.symbols.find((s) => s.name === 'ok')?.partial, 'an intact declaration was marked partial');
});

test('a syntax error inside an exported arrow function body is recovered', () => {
  const info = parse('handler.ts', 'typescript', ['export const handler = async (req: string) => {', '  const = ;', '  return req;', '};', 'export const next = 2;']);
  assert.equal(info.parse?.status, 'recovered', shown(info));
  for (const name of ['handler', 'next']) assert.ok(names(info).includes(name), `${name} was lost: ${shown(info)}`);
});

test('a syntax error inside a method of an exported class is recovered', () => {
  const info = parse('klass.ts', 'typescript', ['export class Service {', '  run() {', '    const = ;', '  }', '  stop() { return 1; }', '}', 'export const tail = 1;']);
  assert.equal(info.parse?.status, 'recovered', shown(info));
  for (const name of ['Service', 'tail']) assert.ok(names(info).includes(name), `${name} was lost: ${shown(info)}`);
});

test('a syntax error inside an exported function body is recovered in JavaScript and TSX too', () => {
  const js = parse('a.js', 'javascript', ['export function broken() {', '  let a = ;', '}', 'export const ok = 1;']);
  assert.equal(js.parse?.status, 'recovered', shown(js));
  assert.ok(names(js).includes('ok'));
  const tsx = parse('a.tsx', 'tsx', ['export function View() {', '  const x = ;', '  return <div />;', '}', 'export const other = 1;']);
  assert.equal(tsx.parse?.status, 'recovered', shown(tsx));
  assert.ok(names(tsx).includes('other'));
});

test('a syntax error inside a Python function body is recovered', () => {
  const info = parse('mod.py', 'python', ['def good(a):', '    return a', '', 'def bad(b):', '    x = = 1', '    return b', '', 'def after(c):', '    return c']);
  assert.ok(info.parse, 'the error was not reported at all');
  assert.equal(info.parse.status, 'recovered', shown(info));
  for (const name of ['good', 'bad', 'after']) assert.ok(names(info).includes(name), `${name} was lost: ${shown(info)}`);
});

// ---- degraded: the damage compromises imports, exports or top-level declarations --------------------------------------

test('an error inside an import statement is degraded', () => {
  const info = parse('imp.ts', 'typescript', ["import { a b } from './x';", 'export const k = 1;']);
  assert.equal(info.parse?.status, 'degraded', shown(info));
});

test('an error inside an export clause is degraded', () => {
  const info = parse('clause.ts', 'typescript', ['const a = 1;', 'const b = 2;', 'export { a b };']);
  assert.equal(info.parse?.status, 'degraded', shown(info));
});

test('an error in the signature of an exported function is degraded', () => {
  const info = parse('sig.ts', 'typescript', ['export function f(a: number b: number) { return a; }', 'export const z = 1;']);
  assert.equal(info.parse?.status, 'degraded', shown(info));
});

test('garbage at the top level is degraded', () => {
  const info = parse('top.ts', 'typescript', ['export function ((( {{{ => ;;; import from']);
  assert.equal(info.parse?.status, 'degraded', shown(info));
});

test('a Python import with a syntax error is degraded', () => {
  const info = parse('imp.py', 'python', ['from os import (', 'def after():', '    return 1']);
  assert.equal(info.parse?.status, 'degraded', shown(info));
});

// ---- the property the classification exists to protect ----------------------------------------------------------------

test('an unclosed body that swallows the exports after it is never called recovered while they are missing', () => {
  const cases: { file: string; lang: Lang; lines: string[]; expected: string[] }[] = [
    { file: 'open1.ts', lang: 'typescript', lines: ['export function open(a: number) {', '  if (a) {', '    foo(', '}', 'export function next() { return 1; }', 'export const tail = 2;'], expected: ['next', 'tail'] },
    { file: 'open2.ts', lang: 'typescript', lines: ['export function open() {', '  const x = {', '  return x;', '}', 'export const after = 1;'], expected: ['after'] },
    { file: 'open3.js', lang: 'javascript', lines: ['export function open() {', '  while (true) {', '    work(', '}', 'export function later() {}'], expected: ['later'] },
  ];
  for (const { file, lang, lines, expected } of cases) {
    const info = parse(file, lang, lines);
    assert.ok(info.parse, `${file}: the error was not reported`);
    const missing = expected.filter((name) => !names(info).includes(name));
    assert.ok(missing.length === 0 || info.parse.status === 'degraded', `${file}: ${missing.join(', ')} were not extracted but the file was called ${info.parse.status}: ${shown(info)}`);
  }
});

// ---- Python: damaged bodies must not swallow what follows them --------------------------------------------------------
//
// For each source below, the later top-level declarations and imports are valid code. The property under test: either the
// file is reported `degraded` (the parser lost track of the structure, which is honest), or it is `recovered` and every one
// of those declarations and imports really was extracted, as a declaration of its own that is not marked partial.

function keepsLaterCode(label: string, lines: string[], later: { symbols?: string[]; imports?: string[] }): FileInfo {
  const info = parse(`${label.replace(/\W+/g, '_')}.py`, 'python', lines);
  assert.ok(info.parse, `${label}: the error was not reported at all`);
  if (info.parse.status === 'recovered') {
    for (const name of later.symbols ?? []) {
      const symbol = info.symbols.find((s) => s.name === name);
      assert.ok(symbol, `${label}: ${name} was called recovered but not extracted: ${shown(info)}`);
      assert.ok(!symbol.partial, `${label}: ${name} was absorbed into the damaged code but the file was called recovered: ${shown(info)}`);
    }
    for (const source of later.imports ?? []) assert.ok(info.imports.some((i) => i.source === source), `${label}: import ${source} was called recovered but not extracted: ${shown(info)}`);
  }
  return info;
}

test('Python: a damaged function followed by a valid module-level function', () => {
  keepsLaterCode('unclosed paren', ['def broken():', '    value = (', '', 'def important_function():', '    return 42'], { symbols: ['important_function'] });
  keepsLaterCode('stray operator', ['def broken():', '    value = = 1', '', 'def important_function():', '    return 42'], { symbols: ['important_function'] });
  keepsLaterCode('unclosed bracket', ['def broken(a):', '    items = [a,', '    return items', '', 'def important_function():', '    return 42'], { symbols: ['important_function'] });
});

test('Python: a damaged class followed by a valid module-level class', () => {
  keepsLaterCode('class with unclosed dict', ['class Broken:', '    def method(self):', '        data = {', '', 'class Important:', '    def run(self):', '        return 1'], { symbols: ['Important'] });
  keepsLaterCode('class with stray operator', ['class Broken:', '    value = = 1', '', 'class Important:', '    pass'], { symbols: ['Important'] });
});

test('Python: a damaged function that contains valid nested functions is recovered', () => {
  const info = parse('nested.py', 'python', ['def outer():', '    def inner(a):', '        return a + 1', '', '    result = = inner(2)', '    return result', '', 'def after():', '    return 3']);
  assert.equal(info.parse?.status, 'recovered', shown(info));
  for (const name of ['outer', 'after']) assert.ok(names(info).includes(name), `${name} was lost: ${shown(info)}`);
  assert.ok(!info.symbols.find((s) => s.name === 'after')?.partial, 'a later valid function was marked damaged');
});

test('Python: an import inside a damaged function is legitimate and the file stays recovered', () => {
  const info = parse('local_import.py', 'python', ['def f():', '    import os', '    x = = 1', '    return os', '', 'def g():', '    return 1']);
  assert.equal(info.parse?.status, 'recovered', shown(info));
  for (const name of ['f', 'g']) assert.ok(names(info).includes(name), `${name} was lost: ${shown(info)}`);
});

test('Python: missing or malformed indentation never leaves later code silently lost', () => {
  keepsLaterCode('missing indent', ['def f():', 'return 1', '', 'def g():', '    return 2'], { symbols: ['g'] });
  keepsLaterCode('unexpected indent', ['x = 1', '    y = 2', '', 'def g():', '    return 2'], { symbols: ['g'] });
  keepsLaterCode('inconsistent dedent', ['def f():', '        a = 1', '    b = 2', '', 'def g():', '    return 3'], { symbols: ['g'] });
  keepsLaterCode('tab and spaces', ['def f():', '\tx = 1', '        y = 2', '', 'def g():', '    return 3'], { symbols: ['g'] });
});

test('Python: damaged imports and module-level statements never leave later code silently lost', () => {
  keepsLaterCode('trailing comma import', ['import os,', '', 'def g():', '    return 1'], { symbols: ['g'] });
  keepsLaterCode('unclosed from-import', ['from os import (path', '', 'def g():', '    return 1'], { symbols: ['g'] });
  keepsLaterCode('unclosed module statement', ['LIMITS = (1,', '', 'def g():', '    return 1'], { symbols: ['g'] });
  keepsLaterCode('stray token at module level', ['x = 1 +', '', 'import json', '', 'def g():', '    return json.dumps(1)'], { symbols: ['g'], imports: ['json'] });
});

test('Python: a module-level import after a damaged function is not swallowed while the file is called recovered', () => {
  keepsLaterCode('import after damage', ['def f():', '    x = (', '', 'import os', '', 'def g():', '    return os.getcwd()'], { symbols: ['g'], imports: ['os'] });
  keepsLaterCode('from-import after damage', ['def f():', '    x = [1,', '', 'from pathlib import Path', '', 'def g():', '    return Path(".")'], { symbols: ['g'], imports: ['pathlib'] });
});

// ---- Python: methods are judged against their own scope, not against the class around them -----------------------------------
//
// A method that is damaged can absorb the next method of the same class. The class symbol's signature lists its public methods, so
// "the sibling was not lost" can be checked on real grammar output: either the file is reported `degraded`, or it is `recovered` and
// every valid method named below really is listed on the class.

function keepsMethods(label: string, lines: string[], klass: string, methods: string[], laterSymbols: string[] = []): FileInfo {
  const info = parse(`${label.replace(/\W+/g, '_')}.py`, 'python', lines);
  assert.ok(info.parse, `${label}: the error was not reported at all`);
  if (info.parse.status === 'recovered') {
    const symbol = info.symbols.find((s) => s.name === klass);
    assert.ok(symbol, `${label}: class ${klass} was called recovered but not extracted: ${shown(info)}`);
    for (const method of methods) assert.ok(new RegExp(`\\b${method}\\b`).test(symbol.signature), `${label}: method ${method} was called recovered but is missing from ${symbol.signature}: ${shown(info)}`);
    for (const name of laterSymbols) assert.ok(names(info).includes(name), `${label}: ${name} was called recovered but not extracted: ${shown(info)}`);
  }
  return info;
}

test('Python: a damaged method followed by a valid sibling method never loses the sibling silently', () => {
  keepsMethods('unclosed paren in method', ['class Service:', '    def broken(self):', '        value = (', '', '    def good(self):', '        return 1'], 'Service', ['good']);
  keepsMethods('stray operator in method', ['class Service:', '    def broken(self):', '        value = = 1', '', '    def good(self):', '        return 1', '', '    def also_good(self):', '        return 2'], 'Service', ['good', 'also_good']);
  keepsMethods('unclosed bracket in method', ['class Service:', '    def broken(self, a):', '        items = [a,', '        return items', '', '    def good(self):', '        return 1'], 'Service', ['good']);
  keepsMethods('damaged signature', ['class Service:', '    def broken(self, a:', '        return a', '', '    def good(self):', '        return 1'], 'Service', ['good']);
});

test('Python: a damaged method in a class followed by a valid module-level function', () => {
  keepsMethods('method then module function', ['class Service:', '    def broken(self):', '        value = (', '', 'def helper():', '    return 1'], 'Service', [], ['helper']);
});

test('Python: nested functions and class-level imports around a damaged method', () => {
  const info = keepsMethods(
    'nested and imports',
    ['class Service:', '    import os', '    from pathlib import Path', '', '    def broken(self):', '        def inner(a):', '            return a + 1', '        value = = inner(2)', '        return value', '', '    def good(self):', '        return 1'],
    'Service',
    ['good'],
  );
  // The nested function and the imports are written inside the class: none of them may be reported as lost module-level code.
  assert.ok(!info.symbols.some((s) => s.name === 'inner'), 'a nested function is not a module-level symbol');
});

test('Python: valid methods, nested functions and class-level imports are never reported as damaged', () => {
  const info = parse('valid_class.py', 'python', [
    'class Service:',
    '    import os',
    '    from pathlib import Path',
    '',
    '    def run(self):',
    '        def inner(a):',
    '            return a + 1',
    '        return inner(1)',
    '',
    '    def stop(self):',
    '        return 2',
  ]);
  assert.equal(info.parse, undefined, shown(info));
  const signature = info.symbols.find((s) => s.name === 'Service')?.signature ?? '';
  assert.ok(/\brun\b/.test(signature) && /\bstop\b/.test(signature), signature);
});

// ---- Python: invalid code the grammar accepts without reporting an error -------------------------------------------------
//
// `def f():` and `class A:` with nothing under them, and `import os,` / `from os import path,`, parse without an ERROR or a
// MISSING node, so `hasError` alone cannot see them. health.ts looks for these shapes itself. Each fixture below has exactly one
// problem, so the number of problems must be exactly one: nothing is counted twice, whichever way the grammar reports it.

const problems = (info: FileInfo): number => (info.parse?.errors ?? 0) + (info.parse?.missing ?? 0);

test('Python: a function or class with an empty body is reported, and its declaration is kept', () => {
  for (const [label, lines, kept] of [
    ['empty function', ['def f():'], 'f'],
    ['empty class', ['class A:'], 'A'],
    ['empty function before valid code', ['def f():', '', 'def g():', '    return 1'], 'g'],
    ['empty class before valid code', ['class A:', '', 'class B:', '    x = 1'], 'B'],
    ['empty function after valid code', ['def g():', '    return 1', '', 'def f():'], 'g'],
  ] as const) {
    const info = parse(`${label.replace(/\W+/g, '_')}.py`, 'python', [...lines]);
    assert.ok(info.parse, `${label}: invalid code was reported as clean`);
    assert.equal(problems(info), 1, `${label}: ${shown(info)}`);
    assert.ok(names(info).includes(kept), `${label}: the valid declaration ${kept} was lost: ${shown(info)}`);
  }
});

test('Python: an empty method inside a class is reported', () => {
  const info = parse('empty_method.py', 'python', ['class A:', '    def ok(self):', '        return 1', '', '    def empty(self):', '']);
  assert.ok(info.parse, `invalid code was reported as clean: ${shown(info)}`);
  assert.ok(info.parse.lines.includes(5) || info.parse.lines.length > 0, shown(info));
  assert.ok(names(info).includes('A'), shown(info));
});

test('Python: pass, ellipsis, docstrings and one-line suites are valid and never reported', () => {
  const valid: [string, string[]][] = [
    ['pass body', ['def f():', '    pass', 'class A:', '    pass']],
    ['one-line suites', ['def f(): pass', 'class A: pass', 'def g(): return 1', 'class B: x = 1']],
    ['ellipsis stubs', ['def f(): ...', 'class P:', '    def m(self): ...', '    def n(self) -> int:', '        ...']],
    ['docstring only', ['def f():', '    """Does nothing."""', 'class A:', '    """Nothing here."""']],
    ['comment then statement', ['def f():', '    # explain', '    pass']],
    ['nested valid definitions', ['class A:', '    class Inner:', '        pass', '    def m(self):', '        def deep():', '            return 1', '        return deep']],
    ['async and decorated', ['@decorator', 'async def f():', '    pass', '@dataclass', 'class D:', '    x: int = 0']],
    ['semicolon suite', ['def f(): pass;']],
  ];
  for (const [label, lines] of valid) {
    const info = parse(`${label.replace(/\W+/g, '_')}.py`, 'python', lines);
    assert.equal(info.parse, undefined, `${label} was reported as damaged: ${shown(info)}`);
  }
});

test('Python: a trailing comma in an unparenthesized import is reported and the file is degraded', () => {
  for (const [label, lines] of [
    ['import with trailing comma', ['import os,']],
    ['from-import with trailing comma', ['from os import path,']],
    ['from-import with two names and a trailing comma', ['from os import path, name,']],
    ['relative from-import', ['from . import helper,']],
    ['trailing comma and comment', ['from os import path,  # why']],
    ['after valid code', ['import sys', 'from os import path,', 'def f():', '    return 1']],
  ] as [string, string[]][]) {
    const info = parse(`${label.replace(/\W+/g, '_')}.py`, 'python', lines);
    assert.ok(info.parse, `${label}: invalid code was reported as clean`);
    assert.equal(info.parse.status, 'degraded', `${label}: a malformed import is not a dependency to rely on: ${shown(info)}`);
    assert.equal(problems(info), 1, `${label}: ${shown(info)}`);
  }
});

test('Python: parenthesized imports with a trailing comma, and ordinary imports, are valid', () => {
  for (const [label, lines] of [
    ['parenthesized single', ['from os import (path,)']],
    ['parenthesized several', ['from os import (path, name,)']],
    ['parenthesized multiline', ['from os import (', '    path,', '    name,', ')']],
    ['parenthesized without comma', ['from os import (path, name)']],
    ['plain several', ['import os, sys', 'from os import path, name']],
    ['aliases', ['import numpy as np, pandas as pd', 'from os import path as p, name as n']],
    ['wildcard and relative', ['from os import *', 'from . import (a, b,)', 'from .pkg import c']],
    ['import inside function and class', ['class A:', '    import os', '    from typing import (List,)', 'def f():', '    import sys', '    return sys']],
  ] as [string, string[]][]) {
    const info = parse(`${label.replace(/\W+/g, '_')}.py`, 'python', lines);
    assert.equal(info.parse, undefined, `${label} was reported as damaged: ${shown(info)}`);
  }
});

test('Python: an import with a trailing comma inside a function or class is reported too', () => {
  const info = parse('nested_comma.py', 'python', ['def f():', '    import os,', '    return os']);
  assert.ok(info.parse, shown(info));
  assert.equal(problems(info), 1, shown(info));
});

test('Python: every problem is counted once when a file has several', () => {
  const info = parse('several.py', 'python', ['import os,', 'def empty():', '', 'class Empty:', '', 'def fine():', '    return 1']);
  assert.ok(info.parse, shown(info));
  assert.equal(info.parse.status, 'degraded', shown(info));
  assert.equal(problems(info), 3, shown(info));
  assert.ok(names(info).includes('fine'), shown(info));
});

test('JavaScript and TypeScript: empty bodies and trailing commas are valid and unaffected', () => {
  for (const [file, lang, lines] of [
    ['empty.ts', 'typescript', ['export function f() {}', 'export class A {}', 'export const g = () => {};']],
    ['commas.ts', 'typescript', ["import { a, } from './a';", "import b, { c, } from './b';", "export { a, c, };"]],
    ['empty.js', 'javascript', ['function f() {}', 'class A {}', 'module.exports = { f, A, };']],
  ] as [string, Lang, string[]][]) {
    const info = parse(file, lang, lines);
    assert.equal(info.parse, undefined, `${file} was reported as damaged: ${shown(info)}`);
  }
});
