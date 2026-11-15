import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { MAX_TREE_DEPTH, MAX_TREE_NODES, assessParse, describeHealth, exceedsBudget, type TreeNode } from '../src/core/ast/health.js';
import { loadLanguages, parseFile } from '../src/core/ast/parser.js';

// Far deeper than the JavaScript call stack allows a recursive walk to go.
const STACK_BUSTING = 60_000;

function chain(depth: number, error = false): TreeNode {
  const root: TreeNode = { type: 'program', parent: null, children: [], startPosition: { row: 0 }, hasError: error, isMissing: false, isError: false };
  let tip = root;
  for (let i = 1; i < depth; i++) {
    const child: TreeNode = { type: 'expression', parent: tip, children: [], startPosition: { row: i }, hasError: error, isMissing: false, isError: false };
    tip.children = [child];
    tip = child;
  }
  if (error) {
    tip.children = [{ type: 'ERROR', parent: tip, children: [], startPosition: { row: depth }, hasError: true, isMissing: false, isError: true }];
  }
  return root;
}

test('the budget check measures a tree far deeper than the call stack without recursing', () => {
  assert.equal(exceedsBudget(chain(STACK_BUSTING)), 'depth');
  assert.equal(exceedsBudget(chain(MAX_TREE_DEPTH)), undefined);
  assert.equal(exceedsBudget(chain(MAX_TREE_DEPTH + 1)), 'depth');
});

test('the budget check stops at the node limit', () => {
  const wide: TreeNode = { type: 'program', parent: null, children: [], startPosition: { row: 0 } };
  wide.children = Array.from({ length: MAX_TREE_NODES + 1 }, () => ({ type: 'x', parent: wide, children: [], startPosition: { row: 0 } }));
  assert.equal(exceedsBudget(wide), 'nodes');
});

test('error assessment walks a very deep tree without overflowing the stack', () => {
  const health = assessParse(chain(STACK_BUSTING, true), 'javascript');
  assert.ok(health, 'the damage must be reported');
  assert.equal(health.status === 'recovered' || health.status === 'degraded', true);
});

test('describeHealth says plainly that a file over budget was not analysed', () => {
  const text = describeHealth({ status: 'degraded', errors: 0, missing: 0, lines: [], limit: 'depth' });
  assert.match(text, /not analysed/);
  assert.match(text, /nothing was extracted/);
});

const nested = (open: string, close: string, depth: number, core: string): string => open.repeat(depth) + core + close.repeat(depth);

async function parsed(path: string, lang: 'javascript' | 'typescript' | 'python', source: string) {
  await loadLanguages([lang]);
  const started = performance.now();
  const info = parseFile(path, lang, source);
  return { info, ms: performance.now() - started };
}

test('deeply nested JavaScript is returned as a partial result, not a crash or a clean result', async () => {
  const { info, ms } = await parsed('deep.js', 'javascript', `export const x = ${nested('(', ')', 20_000, '1')};\n`);
  assert.ok(info);
  assert.equal(info.parse?.status, 'degraded');
  assert.equal(info.parse?.limit, 'depth');
  assert.deepEqual(info.symbols, []);
  assert.ok(ms < 20_000, `bounded execution, took ${ms}ms`);
});

test('a long left-leaning string concatenation does not overflow the stack', async () => {
  const source = `export const s = ${Array.from({ length: 30_000 }, () => "'a'").join(' + ')};\nimport(\`./x\` + y);\n`;
  const { info } = await parsed('concat.js', 'javascript', source);
  assert.ok(info);
  assert.equal(info.parse?.limit, 'depth');
});

test('deeply nested TypeScript types and destructuring patterns are partial, not a crash', async () => {
  const types = await parsed('types.ts', 'typescript', `export type T = ${nested('Array<', '>', 15_000, 'string')};\n`);
  assert.equal(types.info?.parse?.limit, 'depth');
  const pattern = await parsed('pattern.ts', 'typescript', `export const ${nested('[', ']', 15_000, 'a')} = v;\n`);
  assert.equal(pattern.info?.parse?.limit, 'depth');
});

test('deeply nested Python is partial, not a crash', async () => {
  const { info } = await parsed('deep.py', 'python', `x = ${nested('(', ')', 15_000, '1')}\n`);
  assert.ok(info);
  assert.equal(info.parse?.status, 'degraded');
});

test('a very large AST is partial', async () => {
  const { info } = await parsed('big.js', 'javascript', `export const a = [${'1,'.repeat(MAX_TREE_NODES + 10)}];\n`);
  assert.equal(info?.parse?.limit, 'nodes');
});

test('a normal file with realistic nesting is analysed in full', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `export function f${i}(a, b) { if (a) { return [b, { v: (a + b) * ${i} }]; } else { return null; } }`).join('\n');
  const { info } = await parsed('normal.js', 'javascript', `${body}\n`);
  assert.ok(info);
  assert.equal(info.parse, undefined);
  assert.equal(info.symbols.filter((s) => s.exportName).length, 300);
});

test('a long else-if chain and a 500-term concatenation stay within the budget', async () => {
  const chainSource = `export function pick(x) {\n${Array.from({ length: 150 }, (_, i) => `  ${i ? 'else ' : ''}if (x === ${i}) return ${i};`).join('\n')}\n}\nexport const s = ${Array.from({ length: 500 }, () => "'a'").join(' + ')};\n`;
  const { info } = await parsed('chain.js', 'javascript', chainSource);
  assert.equal(info?.parse, undefined);
  assert.equal(info?.symbols.some((s) => s.name === 'pick'), true);
});
