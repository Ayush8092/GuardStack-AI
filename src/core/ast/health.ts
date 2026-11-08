import type { Lang } from './types.js';

// The part of a Tree-sitter node this module reads. Flags are typed `unknown` because some builds expose them as
// properties and others as methods; `flag` accepts both.
export type TreeNode = {
  type: string;
  parent: TreeNode | null;
  children: (TreeNode | null)[];
  // `column` is present on real Tree-sitter nodes; it is what tells Python whether a statement belongs to a body.
  startPosition: { row: number; column?: number };
  // Present on real Tree-sitter nodes. `isNamed` tells a statement from a punctuation token; `childForFieldName` finds a suite.
  isNamed?: unknown;
  childForFieldName?: (name: string) => TreeNode | null;
  isMissing?: unknown;
  isError?: unknown;
  hasError?: unknown;
};

// recovered: the parser repaired the damage locally. Top-level declarations, imports and exports were still extracted,
//            but code inside the damaged region (names it uses, calls it makes) may be missing from the extraction.
// degraded:  the damage is at the top level, inside an import/export header (a clause, a specifier, a signature), or it
//            swallowed what follows it (an unclosed body that now contains the next export), so imports, exports or
//            declarations may be missing.
export type ParseHealth = {
  status: 'recovered' | 'degraded';
  errors: number;
  missing: number;
  // First affected lines (1-based, at most MAX_LINES).
  lines: number[];
};

const MAX_LINES = 5;
const MAX_VISITED = 5000;
const STRUCTURAL = new Set(['import_statement', 'import_from_statement', 'future_import_statement', 'export_statement', 'import_require_clause']);

function flag(node: TreeNode, key: 'isMissing' | 'isError' | 'hasError'): boolean {
  const value = (node as unknown as Record<string, unknown>)[key];
  return typeof value === 'function' ? Boolean((value as () => unknown).call(node)) : Boolean(value);
}

export const hasParseError = (node: TreeNode | null | undefined): boolean => (node ? flag(node, 'hasError') : false);

// Bodies of declarations: damage in one of these is contained, because the declaration's name, kind and position are
// decided before the body starts. `export function f() { <error> }` is still an exported function f.
const FUNCTION_LIKE = new Set([
  'function_declaration', 'function_expression', 'function', 'generator_function_declaration', 'generator_function',
  'arrow_function', 'method_definition', 'class_static_block', 'function_definition', 'class_definition',
]);
const BODY_OF_CLASS_LIKE = new Set(['class_body', 'interface_body', 'enum_body']);

function isDeclarationBody(node: TreeNode): boolean {
  if (BODY_OF_CLASS_LIKE.has(node.type)) return true;
  // A TypeScript namespace or `declare module` body is also a statement_block, but its parent is not function-like and
  // legitimately holds exports, so it is not a declaration body.
  return (node.type === 'statement_block' || node.type === 'block') && node.parent !== null && FUNCTION_LIKE.has(node.parent.type);
}

// An unclosed brace makes the parser keep reading the following source inside the damaged body. An export or import
// statement can never be valid inside a function or class body, so finding one there means declarations that really sit
// at the top level were absorbed into the body, and the damage is not contained after all. This is the JavaScript and
// TypeScript rule; Python allows imports inside functions and is judged by indentation instead (below).
function absorbsTopLevel(body: TreeNode): boolean {
  for (const child of body.children) {
    if (!child) continue;
    if (STRUCTURAL.has(child.type)) return true;
    if (child.type === 'ERROR') {
      for (const inner of child.children) if (inner && (STRUCTURAL.has(inner.type) || inner.type === 'export' || inner.type === 'import')) return true;
    }
  }
  return false;
}

// Python has no braces: what belongs to a body is decided by indentation, and a malformed expression (an unclosed parenthesis,
// a stray operator) can make the parser keep reading into the lines after it. Each body is judged against the column of the
// declaration that owns it: a function, class or import statement that starts at or to the left of that column can never belong to
// the body, so finding one inside means a later sibling was absorbed. For a method of a class that is the method's own `def`
// column, so a following method (same column, inside the same class) is caught; for a module-level function it is column 0. Imports
// and nested functions that are indented deeper than the owner are legitimate and are not matched.
const PYTHON_STATEMENT_START = new Set([
  'function_definition', 'class_definition', 'decorated_definition', 'import_statement', 'import_from_statement', 'future_import_statement',
  'def', 'class', 'import', 'from', '@',
]);

const startsStatementAtOrLeftOf = (n: TreeNode, column: number): boolean => PYTHON_STATEMENT_START.has(n.type) && n.startPosition.column !== undefined && n.startPosition.column <= column;

function absorbsPythonSibling(body: TreeNode, limitColumn: number): boolean {
  for (const child of body.children) {
    if (!child) continue;
    if (startsStatementAtOrLeftOf(child, limitColumn)) return true;
    if (child.type === 'ERROR') for (const inner of child.children) if (inner && startsStatementAtOrLeftOf(inner, limitColumn)) return true;
  }
  return false;
}

// An ERROR node that starts a statement at some column and then contains a def, class or import that starts on a LATER line at
// that column or further left has absorbed a sibling statement (the first line is the damaged statement itself, and its
// continuation lines are indented deeper). This also covers an ERROR placed directly in a class body, which has no body of its own.
function errorAbsorbsSibling(node: TreeNode): boolean {
  const column = node.startPosition.column;
  if (column === undefined || (node.type !== 'ERROR' && !flag(node, 'isError'))) return false;
  return node.children.some((inner) => inner !== null && inner.startPosition.row > node.startPosition.row && startsStatementAtOrLeftOf(inner, column));
}

// Does the damage at `node` threaten imports, exports or top-level declarations?
//  - directly under the root, or inside an import/export header (specifiers, clause, signature): yes
//  - inside the body of a function, method or class, even one wrapped in `export`: no, unless the body absorbed top-level code
function damagesStructure(node: TreeNode, lang: Lang): boolean {
  if (!node.parent || !node.parent.parent) return true;

  // Every block between the damage and the outermost declaration body that holds it. Swallowed top-level code lands in
  // whichever block was still open, which may be a nested one, so all of them are inspected.
  const blocks: TreeNode[] = [];
  let outermost = -1;
  for (let current: TreeNode | null = node.parent; current; current = current.parent) {
    if (isDeclarationBody(current)) {
      blocks.push(current);
      outermost = blocks.length - 1;
      continue;
    }
    // Only an import/export reached before any body is structural; one above a body is just the wrapper of the declaration.
    if (outermost < 0 && STRUCTURAL.has(current.type)) return true;
    if (outermost < 0 && (current.type === 'statement_block' || current.type === 'block')) blocks.push(current);
  }
if (outermost < 0) {
  return lang === 'python' || errorAbsorbsSibling(node);
}
  const inspected = blocks.slice(0, outermost + 1);
  if (lang === 'python') {
    // Every block is judged against its own owner (a method's body against the method, not against the class around it).
    const swallowed = inspected.some((b) => {
      const owner = b.parent?.startPosition.column;
      return owner !== undefined && absorbsPythonSibling(b, owner);
    });
    return swallowed || errorAbsorbsSibling(node);
  }
  return inspected.some(absorbsTopLevel);
}

// ---- Python: invalid code the grammar accepts without reporting an error --------------------------------------------------
//
// The Python grammar is deliberately forgiving in two places, so a tree can have no ERROR or MISSING node and still describe
// code that Python itself rejects:
//   - an empty suite: `def f():` or `class A:` with nothing indented under it parses with an empty block;
//   - a trailing comma in an import that is not parenthesized: `import os,` and `from os import path,`.
// `assessParse` therefore cannot rely on `hasError` alone for Python. This pass looks for exactly these two shapes. A node whose
// subtree already reports an error is skipped here (the error walk counts it), so nothing is counted twice, and it only descends
// through statements, so a file costs one walk over its statements, not over every expression.
const PY_SUITE_OWNERS = new Set(['function_definition', 'class_definition']);
const PY_IMPORTS = new Set(['import_statement', 'import_from_statement', 'future_import_statement']);
const PY_CONTAINER = /^(module|block|decorated_definition|function_definition|class_definition|.+_statement|.+_clause)$/;

type Structural = {
  line: number;
  kind: 'empty-body' | 'trailing-comma' | 'indentation';
}
const isNamedNode = (node: TreeNode): boolean => {
  const value = node.isNamed;
  return typeof value === 'function' ? Boolean((value as () => unknown).call(node)) : value !== false;
};

// A body counts as present when it holds at least one statement. Comments are extras and do not make a suite valid; a valid
// `pass`, `...`, docstring or one-line suite (`def f(): pass`) is a statement and does.
function hasEmptyBody(owner: TreeNode): boolean {
  const body = typeof owner.childForFieldName === 'function' ? owner.childForFieldName('body') : (owner.children.find((c) => c?.type === 'block') ?? null);
  if (!body) return true;
  return !body.children.some((child) => child !== null && child.type !== 'comment' && isNamedNode(child));
}

// `import a,` and `from a import b,` end in a comma token; the parenthesized form ends in ")" and may legally have one inside.
function endsWithComma(statement: TreeNode): boolean {
  for (let i = statement.children.length - 1; i >= 0; i--) {
    const child = statement.children[i];
    if (!child || child.type === 'comment') continue;
    return child.type === ',';
  }
  return false;
}

function pythonStructure(root: TreeNode): Structural[] {
  const found: Structural[] = [];
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    if (!flag(node, 'hasError')) {
      const line = node.startPosition.row + 1;
      if (PY_SUITE_OWNERS.has(node.type) && hasEmptyBody(node)) found.push({ line, kind: 'empty-body' });
      else if (PY_IMPORTS.has(node.type) && endsWithComma(node)) found.push({ line, kind: 'trailing-comma' });
    }
    for (const child of node.children) if (child && PY_CONTAINER.test(child.type)) stack.push(child);
  }
  
  return found;
}
// Python indentation can be invalid even when Tree-sitter reports a clean tree.
// Check only direct statements in modules and suites, so multiline expression
// continuations are not mistaken for indentation errors.
function pythonIndentation(root: TreeNode, source: string): Structural[] {
  const found: Structural[] = [];
  const lines = source.split(/\r?\n/);

  type Indent = {
    visual: number;
    alternate: number;
  };

  const indentationAt = (row: number): Indent | undefined => {
    const line = lines[row];
    if (line === undefined || line.trim().length === 0) return undefined;

    const prefix = line.match(/^[\t ]*/)?.[0] ?? '';
    let visual = 0;
    let alternate = 0;

    for (const char of prefix) {
      if (char === '\t') {
        visual += 8 - (visual % 8);
        alternate += 1;
      } else {
        visual += 1;
        alternate += 1;
      }
    }

    return { visual, alternate };
  };

  const addIssue = (node: TreeNode): void => {
    const line = node.startPosition.row + 1;
    if (!found.some((issue) => issue.line === line)) {
      found.push({ line, kind: 'indentation' });
    }
  };

  const statements = (node: TreeNode): TreeNode[] =>
    node.children.filter(
      (child): child is TreeNode =>
        child !== null &&
        child.type !== 'comment' &&
        isNamedNode(child),
    );

  // Statements directly inside a Python module must start at column zero.
  if (root.type === 'module') {
    for (const statement of statements(root)) {
      const indent = indentationAt(statement.startPosition.row);

      if (indent && (indent.visual !== 0 || indent.alternate !== 0)) {
        addIssue(statement);
      }
    }
  }

  // Statements inside one suite must use a consistent indentation level.
  // Compare both normal tab expansion (8 columns) and alternate tab expansion
  // (1 column) to catch mixed tabs/spaces that look visually aligned.
  const stack: TreeNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'block') {
      const owner = node.parent;
      const ownerIndent = owner
        ? indentationAt(owner.startPosition.row)
        : undefined;

      let expected: Indent | undefined;

      for (const statement of statements(node)) {
        // A one-line suite is legal and does not introduce a new indentation level.
        if (owner && statement.startPosition.row <= owner.startPosition.row) {
          continue;
        }

        const indent = indentationAt(statement.startPosition.row);
        if (!indent) continue;

        if (!expected) {
          expected = indent;

          if (
            ownerIndent &&
            (indent.visual <= ownerIndent.visual ||
              indent.alternate <= ownerIndent.alternate)
          ) {
            addIssue(statement);
          }

          continue;
        }

        if (
          indent.visual !== expected.visual ||
          indent.alternate !== expected.alternate
        ) {
          addIssue(statement);
        }
      }
    }

    for (const child of node.children) {
      if (child) stack.push(child);
    }
  }

  return found;
}

// Looks for ERROR and MISSING nodes below `root`, descending only into subtrees that contain one.
// Returns undefined for a clean tree.
export function assessParse(root: TreeNode, lang: Lang, source = ''): ParseHealth | undefined {
  // Python can be invalid without the tree saying so (see above), so this pass runs whether or not the root reports an error.
  const structure
   = lang === 'python'
   ? [...pythonStructure(root), ...pythonIndentation(root, source)]
   : [];
  const reported = flag(root, 'hasError');
  if (!reported && structure.length === 0) return undefined;

  let errors = 0;
  let missing = 0;
  let visited = 0;
  let structural = false;
  const lines: number[] = [];

  const visit = (node: TreeNode): void => {
    if (++visited > MAX_VISITED) {
      structural = true;
      return;
    }
    const isMissing = flag(node, 'isMissing');
    const isError = node.type === 'ERROR' || flag(node, 'isError');
    if (isMissing || isError) {
      if (isMissing) missing++;
      else errors++;
      const line = node.startPosition.row + 1;
      if (lines.length < MAX_LINES && !lines.includes(line)) lines.push(line);
      if (damagesStructure(node, lang)) structural = true;
      return;
    }
    for (const child of node.children) if (child && flag(child, 'hasError')) visit(child);
  };
  if (reported) visit(root);

  // A malformed import is not a dependency to rely on: the file's imports are degraded. An empty suite leaves the declaration
  // itself (its name, kind and position) intact, so it is only recovered.
  if (
    structure.some(
      (issue) => 
        issue.kind === 'trailing-comma' ||
        issue.kind === 'indentation',
      )
  ) {
      structural = true;
  }  
  for (const issue of structure) if (!lines.includes(issue.line)) lines.push(issue.line);
  const total = errors + structure.length;

  // A root that reports an error but yields no ERROR or MISSING node cannot be judged: treat it as degraded.
  const found = reported ? errors + missing > 0 : true;
  return { status: !found || structural ? 'degraded' : 'recovered', errors: total, missing, lines: lines.sort((a, b) => a - b).slice(0, MAX_LINES) };
}

export function describeHealth(health: ParseHealth): string {
  const parts = [health.errors > 0 ? `${health.errors} syntax error(s)` : '', health.missing > 0 ? `${health.missing} missing token(s)` : ''].filter(Boolean);
  const where = health.lines.length > 0 ? ` near line ${health.lines.join(', ')}` : '';
  const effect =
    health.status === 'degraded'
      ? 'imports, exports or declarations may be missing from the extraction'
      : 'declarations were extracted, but code inside the damaged region may be missing';
  return `${parts.join(' and ') || 'parse problems'}${where}: ${effect}`;
}
