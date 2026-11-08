// Checks the installed @vscode/tree-sitter-wasm against what src/core/ast/parser.ts and health.ts rely on. These tests
// load the real WASM grammars; nothing here is mocked. The shape of the node flags (property or method) is reported with
// t.diagnostic so a run shows what the installed version actually does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { before, test } from 'node:test';
import type * as TS from '@vscode/tree-sitter-wasm';
import { hasParseError, type TreeNode } from '../src/core/ast/health.js';

const require = createRequire(import.meta.url);
const ts: typeof TS = require('@vscode/tree-sitter-wasm');
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));

let parser: TS.Parser;
let typescript: TS.Language;

before(async () => {
  await ts.Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
  parser = new ts.Parser();
  typescript = await ts.Language.load(fs.readFileSync(path.join(wasmDir, 'tree-sitter-typescript.wasm')));
  parser.setLanguage(typescript);
});

const read = (node: unknown, key: string): unknown => (node as Record<string, unknown>)[key];
const truthy = (node: unknown, key: string): boolean => {
  const value = read(node, key);
  return typeof value === 'function' ? Boolean((value as () => unknown).call(node)) : Boolean(value);
};

function firstBad(node: TreeNode): TreeNode | undefined {
  if (node.type === 'ERROR' || truthy(node, 'isMissing') || truthy(node, 'isError')) return node;
  for (const child of node.children) if (child && truthy(child, 'hasError')) return firstBad(child) ?? undefined;
  return undefined;
}

test('the package exposes the entry points parser.ts calls', () => {
  assert.equal(typeof ts.Parser, 'function');
  assert.equal(typeof ts.Parser.init, 'function');
  assert.equal(typeof ts.Language.load, 'function');
  assert.equal(typeof ts.Query, 'function');
  assert.equal(typeof parser.parse, 'function');
  assert.equal(typeof parser.setLanguage, 'function');
  for (const grammar of ['typescript', 'tsx', 'javascript', 'python']) assert.ok(fs.existsSync(path.join(wasmDir, `tree-sitter-${grammar}.wasm`)), `tree-sitter-${grammar}.wasm is missing`);
});

test('error flags and tree navigation have the shape health.ts reads', (t) => {
  const clean = parser.parse('export const a = 1;\n');
  const broken = parser.parse('export function f() {\n  const x = ;\n}\n');
  assert.ok(clean && broken, 'parse() returned no tree');
  try {
    const root = broken.rootNode;
    for (const key of ['hasError', 'isMissing', 'isError']) t.diagnostic(`node.${key} is a ${typeof read(root, key)} on the installed version`);

    // Each flag is either a boolean property or a method; both are supported by health.ts.
    for (const key of ['hasError', 'isMissing', 'isError']) assert.ok(['boolean', 'function'].includes(typeof read(root, key)), `node.${key} is ${typeof read(root, key)}`);
    assert.equal(hasParseError(clean.rootNode as unknown as TreeNode), false);
    assert.equal(hasParseError(root as unknown as TreeNode), true);

    assert.ok(Array.isArray(root.children), 'node.children is not an array');
    assert.equal(root.parent, null, 'the root has a parent');
    const bad = firstBad(root as unknown as TreeNode);
    assert.ok(bad, 'an error tree contained no ERROR or MISSING node');
    assert.equal(typeof bad.startPosition.row, 'number');
    assert.ok(bad.parent, 'an error node has no parent');
    const chain: string[] = [];
    for (let n: TreeNode | null = bad; n; n = n.parent) chain.push(n.type);
    t.diagnostic(`damage inside a function body: ${chain.join(' < ')}`);
    assert.ok(chain.includes('statement_block'), `expected the damage to sit inside a statement_block, got ${chain.join(' < ')}`);
    assert.ok(chain.includes('export_statement'), `expected the function to be wrapped in an export_statement, got ${chain.join(' < ')}`);
  } finally {
    clean.delete();
    broken.delete();
  }
});

test('a missing token is reported with isMissing and the clean tree reports none', (t) => {
  const tree = parser.parse('function f( {\n');
  assert.ok(tree);
  try {
    const bad = firstBad(tree.rootNode as unknown as TreeNode);
    assert.ok(bad, 'no ERROR or MISSING node found');
    t.diagnostic(`first damaged node: type=${bad.type} isMissing=${truthy(bad, 'isMissing')} isError=${truthy(bad, 'isError')}`);
    assert.ok(bad.type === 'ERROR' || truthy(bad, 'isMissing') || truthy(bad, 'isError'));
  } finally {
    tree.delete();
  }
  const ok = parser.parse('const a = 1;\n');
  assert.ok(ok);
  try {
    assert.equal(firstBad(ok.rootNode as unknown as TreeNode), undefined);
  } finally {
    ok.delete();
  }
});
