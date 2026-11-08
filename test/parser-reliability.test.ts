import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { cleanup, context, workspace } from './helpers.js';

afterEach(cleanup);

async function index(files: Record<string, string>) {
  const ctx = context(workspace(files));
  const project = await indexProject(ctx);
  return { ctx, project, byPath: (p: string) => project.files.find((f) => f.path === p) };
}

const MODERN: Record<string, string> = {
  'modern.ts': [
    "import type { Config } from './types';",
    "export const settings = { port: 1 } satisfies Record<string, number>;",
    'export abstract class Base<T extends object = {}> { #secret = 1; abstract run(input: T): Promise<void>; }',
    'export function overload(a: string): string;',
    'export function overload(a: number): number;',
    'export function overload(a: unknown): unknown { return a ?? 0; }',
    'export enum Level { Low = 1, High = 1_000 }',
    'export type Getter<K extends string> = `get${Capitalize<K>}`;',
    'export const main = async (c?: Config) => { let x: number | undefined; x ??= 1; return c?.port ?? x; };',
  ].join('\n'),
  'types.ts': 'export type Config = { port: number };\n',
  'modern.js': ['export class Counter { #n = 0; static #made = 0; inc() { this.#n ||= 1; return this.#n; } }', 'export const load = async () => (await import("./modern.js")).Counter;'].join('\n'),
  'modern.py': [
    'from dataclasses import dataclass',
    '@dataclass',
    'class Point:',
    '    x: int = 0',
    'def first(items: list[int], /, *, default: int = 0) -> int:',
    '    if (n := len(items)) > 0:',
    '        return items[0]',
    '    return default',
    'async def fetch(urls):',
    '    return [u async for u in urls]',
    'def kind(value):',
    '    match value:',
    '        case [a, *rest]:',
    '            return a',
    '        case _:',
    '            return None',
  ].join('\n'),
};

test('modern TypeScript, JavaScript and Python parse cleanly and keep their symbols', async () => {
  const { project, byPath } = await index(MODERN);
  for (const file of Object.keys(MODERN)) assert.equal(byPath(file)?.parse, undefined, `${file} was reported as damaged: ${JSON.stringify(byPath(file)?.parse)}`);
  assert.deepEqual(project.parseIssues, []);
  const names = (p: string) => byPath(p)?.symbols.map((s) => s.name) ?? [];
  for (const name of ['settings', 'Base', 'overload', 'Level', 'Getter', 'main']) assert.ok(names('modern.ts').includes(name), `modern.ts lost ${name}`);
  assert.ok(names('modern.js').includes('Counter'));
  for (const name of ['Point', 'first', 'fetch', 'kind']) assert.ok(names('modern.py').includes(name), `modern.py lost ${name}`);
});

const MALFORMED: Record<string, string> = {
  // a valid export, garbage between statements, another valid export, and a function that is never closed
  'broken.ts': ['export function good(a: number) { return a + 1; }', 'export const = ;;; }}}', 'export function alsoGood(b: string) { return b; }', 'export function unclosed(c: number) { if (c) {'].join('\n'),
  'broken.js': ['export function fine() { return 1; }', 'const x = {{{ ;', 'export function stillFine() { return 2; }'].join('\n'),
  'broken.py': ['def good(a):', '    return a', 'def bad(:', '    pass', 'def after(b):', '    return b'].join('\n'),
};

test('malformed files are reported, not treated as fully analysed, and keep their valid symbols', async () => {
  const { project, byPath } = await index(MALFORMED);
  for (const file of Object.keys(MALFORMED)) {
    const info = byPath(file);
    assert.ok(info, `${file} was dropped from the index`);
    assert.ok(info.parse, `${file} has syntax errors but no parse report`);
    assert.ok(info.parse.errors + info.parse.missing > 0);
    assert.ok(info.parse.lines.length > 0);
  }
  assert.deepEqual(project.parseIssues.map((i) => i.path), Object.keys(MALFORMED).sort());
  assert.equal(project.complete, false);
  assert.match(describeCoverage(project, 5000), /syntax errors the parser had to repair/);
  // Valid declarations that precede the damage are not thrown away.
  assert.ok(byPath('broken.ts')?.symbols.some((s) => s.name === 'good'));
  assert.ok(byPath('broken.js')?.symbols.some((s) => s.name === 'fine'));
  assert.ok(byPath('broken.py')?.symbols.some((s) => s.name === 'good'));
});

test('garbage at the top level is classified as degraded', async () => {
  const { byPath } = await index({ 'syntax.ts': 'export function ((( {{{ => ;;; import from' });
  assert.equal(byPath('syntax.ts')?.parse?.status, 'degraded');
});

test('a function whose body contains an error is not hashed for duplicate detection', async () => {
  const body = 'const values = [1, 2, 3].map((n) => n * 2); const total = values.reduce((a, b) => a + b, 0); return total + values.length + 42;';
  const { ctx, project } = await index({
    'a.ts': `export function one(x: number) { ${body} }\n`,
    'b.ts': `export function two(x: number) { ${body} }\n`,
    'c.ts': `export function three(x: number) { ${body} const = ; }\n`,
    'd.ts': `export function four(x: number) { ${body} const = ; }\n`,
  });
  const { findings } = analyzeProject(project, ctx.config);
  const dupes = findings.filter((f) => f.rule === 'duplicate-body');
  assert.equal(dupes.length, 1, 'only the two intact copies may match');
  assert.ok(/one|two/.test(dupes[0].message) && !/three|four/.test(dupes[0].message));
  assert.ok(project.files.filter((f) => f.parse).every((f) => f.symbols.every((s) => !s.bodyHash)));
});

test('findings that depend on an incompletely extracted file are low confidence', async () => {
  const { ctx, project } = await index({
    'src/main.ts': "import { used } from './used';\nexport const run = () => used();\n",
    'src/used.ts': 'export const used = () => 1;\n',
    'src/lonely.ts': 'export const lonely = 1;\n',
    'src/damaged.ts': "import { gone } from './lonely';\nexport function f( { return gone; \n",
    'src/unused.ts': "import { maybe } from './used';\nexport const g = () => { const = ; };\n",
  });
  const { findings } = analyzeProject(project, ctx.config);
  const dependent = findings.filter((f) => f.rule === 'orphan-file' || f.rule === 'dead-export');
  assert.ok(dependent.length > 0);
  for (const f of dependent) {
    assert.equal(f.confidence, 'low', `${f.rule} on ${f.file} claimed ${f.confidence}`);
    assert.ok(f.evidence.some((e) => /syntax errors/.test(e)), `${f.rule} on ${f.file} does not mention the syntax errors`);
  }
  for (const f of findings.filter((x) => x.rule === 'unused-import' && x.file === 'src/unused.ts')) assert.equal(f.confidence, 'low');
});

test('parser findings survive the cache: a second run reports the same issues', async () => {
  const ctx = context(workspace(MALFORMED));
  const first = await indexProject(ctx);
  const second = await indexProject(ctx);
  assert.deepEqual(second.parseIssues, first.parseIssues);
  assert.deepEqual(second.files, first.files);
});
