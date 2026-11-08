import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessParse, describeHealth, hasParseError, type TreeNode } from '../src/core/ast/health.js';

type Spec = { type: string; row?: number; col?: number; missing?: boolean; error?: boolean; children?: Spec[] };

// A minimal tree: `hasError` is derived the way Tree-sitter derives it (an error or missing node, or a descendant of one).
function build(spec: Spec, parent: TreeNode | null = null, asMethods = false): TreeNode {
  const node: TreeNode = { type: spec.type, parent, children: [], startPosition: { row: spec.row ?? 0, column: spec.col } };
  node.children = (spec.children ?? []).map((child) => build(child, node, asMethods));
  const bad = Boolean(spec.missing) || spec.type === 'ERROR' || Boolean(spec.error) || node.children.some((c) => Boolean(c && (typeof c.hasError === 'function' ? (c.hasError as () => boolean)() : c.hasError)));
  const set = (key: 'isMissing' | 'isError' | 'hasError', value: boolean): void => {
    node[key] = asMethods ? () => value : value;
  };
  set('isMissing', Boolean(spec.missing));
  set('isError', spec.type === 'ERROR');
  set('hasError', bad);
  return node;
}

const program = (...children: Spec[]): Spec => ({ type: 'program', children });

test('a clean tree has no parse issue', () => {
  assert.equal(assessParse(build(program({ type: 'function_declaration' })), 'typescript'), undefined);
});

test('an error inside a function body is recovered: declarations survive', () => {
  const root = build(program({ type: 'function_declaration', row: 2, children: [{ type: 'statement_block', children: [{ type: 'ERROR', row: 4 }] }] }));
  const health = assessParse(root, 'typescript');
  assert.equal(health?.status, 'recovered');
  assert.deepEqual([health?.errors, health?.missing, health?.lines], [1, 0, [5]]);
  assert.ok(hasParseError(root));
});

test('a missing token inside a declaration is recovered', () => {
  const health = assessParse(build(program({ type: 'lexical_declaration', children: [{ type: ';', missing: true, row: 1 }] })), 'typescript');
  assert.equal(health?.status, 'recovered');
  assert.equal(health?.missing, 1);
});

test('an error at the top level is degraded: imports or exports may be missing', () => {
  const health = assessParse(build(program({ type: 'ERROR', row: 0 })), 'typescript');
  assert.equal(health?.status, 'degraded');
});

test('an error inside an import or export statement is degraded', () => {
  for (const type of ['import_statement', 'export_statement', 'import_from_statement']) {
    const health = assessParse(build(program({ type, children: [{ type: 'ERROR' }] })), 'python');
    assert.equal(health?.status, 'degraded', type);
  }
});

test('a root that reports an error without a locatable node is degraded', () => {
  assert.equal(assessParse(build({ type: 'program', error: true }), 'typescript')?.status, 'degraded');
});

test('flags exposed as methods are read the same way', () => {
  const root = build(program({ type: 'ERROR' }), null, true);
  assert.equal(assessParse(root, 'javascript')?.status, 'degraded');
  assert.ok(hasParseError(root));
});

test('only the first few lines are listed, in order', () => {
  const errors = Array.from({ length: 9 }, (_, i): Spec => ({ type: 'ERROR', row: 40 - i }));
  const health = assessParse(build(program({ type: 'class_declaration', children: [{ type: 'class_body', children: errors }] })), 'typescript');
  assert.equal(health?.errors, 9);
  assert.equal(health?.lines.length, 5);
  assert.deepEqual(health?.lines, [...(health?.lines ?? [])].sort((a, b) => a - b));
});

test('descriptions say what may be missing', () => {
  assert.match(describeHealth({ status: 'degraded', errors: 1, missing: 0, lines: [3] }), /1 syntax error.*line 3.*imports, exports or declarations may be missing/);
  assert.match(describeHealth({ status: 'recovered', errors: 0, missing: 2, lines: [] }), /2 missing token.*damaged region/);
});

// ---- Declaration bodies versus structure ---------------------------------------------------------------------------

const exported = (declaration: Spec): Spec => ({ type: 'export_statement', children: [declaration] });
const fn = (...body: Spec[]): Spec => ({ type: 'function_declaration', children: [{ type: 'formal_parameters' }, { type: 'statement_block', children: body }] });

test('an error inside the body of an exported function is recovered, not structural', () => {
  const health = assessParse(build(program(exported(fn({ type: 'ERROR', row: 3 })))), 'typescript');
  assert.equal(health?.status, 'recovered');
  assert.deepEqual(health?.lines, [4]);
});

test('a missing token inside the body of an exported arrow function, method or class is recovered', () => {
  const arrow: Spec = { type: 'lexical_declaration', children: [{ type: 'variable_declarator', children: [{ type: 'arrow_function', children: [{ type: 'statement_block', children: [{ type: ';', missing: true }] }] }] }] };
  const method: Spec = { type: 'class_declaration', children: [{ type: 'class_body', children: [{ type: 'method_definition', children: [{ type: 'statement_block', children: [{ type: 'ERROR' }] }] }] }] };
  const members: Spec = { type: 'class_declaration', children: [{ type: 'class_body', children: [{ type: 'ERROR' }] }] };
  for (const declaration of [arrow, method, members]) assert.equal(assessParse(build(program(exported(declaration))), 'typescript')?.status, 'recovered', declaration.type);
});

test('an error in a nested block inside an exported function body is still contained', () => {
  const nested: Spec = { type: 'if_statement', children: [{ type: 'statement_block', children: [{ type: 'ERROR' }] }] };
  assert.equal(assessParse(build(program(exported(fn(nested)))), 'typescript')?.status, 'recovered');
});

test('an error in the header of an exported declaration is degraded', () => {
  const clause: Spec = { type: 'export_statement', children: [{ type: 'export_clause', children: [{ type: 'ERROR' }] }] };
  const signature: Spec = { type: 'function_declaration', children: [{ type: 'formal_parameters', children: [{ type: 'ERROR' }] }, { type: 'statement_block' }] };
  const specifier: Spec = { type: 'import_statement', children: [{ type: 'import_clause', children: [{ type: 'named_imports', children: [{ type: ',', missing: true }] }] }] };
  assert.equal(assessParse(build(program(clause)), 'typescript')?.status, 'degraded');
  assert.equal(assessParse(build(program(exported(signature))), 'typescript')?.status, 'degraded');
  assert.equal(assessParse(build(program(specifier)), 'typescript')?.status, 'degraded');
});

test('a damaged body that absorbed a later export or import is degraded', () => {
  const swallowed = fn({ type: 'ERROR', row: 1 }, { type: 'export_statement', children: [{ type: 'function_declaration' }] });
  assert.equal(assessParse(build(program(exported(swallowed))), 'typescript')?.status, 'degraded');
  const viaToken = fn({ type: 'ERROR', children: [{ type: 'export' }, { type: 'identifier' }] });
  assert.equal(assessParse(build(program(exported(viaToken))), 'javascript')?.status, 'degraded');
  const absorbedInNestedBlock = fn({ type: 'if_statement', children: [{ type: 'statement_block', children: [{ type: 'ERROR' }, { type: 'import_statement' }] }] });
  assert.equal(assessParse(build(program(absorbedInNestedBlock)), 'typescript')?.status, 'degraded');
});

test('exports that legitimately live in a namespace body do not make damage inside a function there structural', () => {
  const ns: Spec = { type: 'internal_module', children: [{ type: 'statement_block', children: [exported(fn({ type: 'ERROR' }))] }] };
  assert.equal(assessParse(build(program(exported(ns))), 'typescript')?.status, 'recovered');
});

test('a Python function body that contains an import is recovered when something else in it is damaged', () => {
  const def: Spec = { type: 'function_definition', children: [{ type: 'block', children: [{ type: 'import_statement' }, { type: 'ERROR' }] }] };
  assert.equal(assessParse(build(program(def)), 'python')?.status, 'recovered');
  const header: Spec = { type: 'import_from_statement', children: [{ type: 'ERROR' }] };
  assert.equal(assessParse(build(program(header)), 'python')?.status, 'degraded');
});

// ---- Python: what indentation says belongs to a body ----------------------------------------------------------------

const pyDef = (col: number, ...body: Spec[]): Spec => ({ type: 'function_definition', col, children: [{ type: 'parameters', col: col + 4 }, { type: 'block', col: col + 4, children: body }] });
const pyClass = (col: number, ...body: Spec[]): Spec => ({ type: 'class_definition', col, children: [{ type: 'block', col: col + 4, children: body }] });

test('Python: a later module-level def, class or import absorbed into a damaged body is degraded', () => {
  const asNode = pyDef(0, { type: 'ERROR', col: 4 }, { type: 'function_definition', col: 0 });
  const insideError = pyDef(0, { type: 'ERROR', col: 4, children: [{ type: 'def', col: 0 }, { type: 'identifier', col: 4 }] });
  const classInError = pyDef(0, { type: 'ERROR', col: 4, children: [{ type: 'class', col: 0 }] });
  const importInError = pyDef(0, { type: 'ERROR', col: 4, children: [{ type: 'from', col: 0 }, { type: 'dotted_name', col: 5 }] });
  const importNode = pyDef(0, { type: 'ERROR', col: 4 }, { type: 'import_statement', col: 0 });
  for (const [name, def] of Object.entries({ asNode, insideError, classInError, importInError, importNode })) {
    assert.equal(assessParse(build(program(def)), 'python')?.status, 'degraded', name);
  }
});

test('Python: a class whose method absorbed a module-level declaration is degraded', () => {
  const swallowedFunction = pyClass(0, pyDef(4, { type: 'ERROR', col: 8 }, { type: 'function_definition', col: 0 }));
  assert.equal(assessParse(build(program(swallowedFunction)), 'python')?.status, 'degraded');
});

// ---- Python: a damaged method is judged against its own def, not against the class around it --------------------------------

test('Python: a damaged method that absorbed a later sibling method is degraded', () => {
  const asNode = pyClass(0, pyDef(4, { type: 'ERROR', col: 8 }, { type: 'function_definition', col: 4 }));
  const asTokens = pyClass(0, pyDef(4, { type: 'ERROR', col: 8, children: [{ type: 'def', col: 4 }, { type: 'identifier', col: 8 }] }));
  const decorated = pyClass(0, pyDef(4, { type: 'ERROR', col: 8 }, { type: 'decorated_definition', col: 4 }));
  const absorbedImport = pyClass(0, pyDef(4, { type: 'ERROR', col: 8 }, { type: 'import_statement', col: 4 }));
  for (const [name, klass] of Object.entries({ asNode, asTokens, decorated, absorbedImport })) {
    assert.equal(assessParse(build(program(klass)), 'python')?.status, 'degraded', name);
  }
});

test('Python: a damaged nested function that absorbed a later statement of the function around it is degraded', () => {
  const outer = pyDef(0, pyDef(4, { type: 'ERROR', col: 8 }, { type: 'function_definition', col: 4 }));
  assert.equal(assessParse(build(program(outer)), 'python')?.status, 'degraded');
});

test('Python: an error placed directly in a class body that absorbed a later method is degraded, its own first line is not', () => {
  const absorbed = pyClass(0, { type: 'ERROR', row: 1, col: 4, children: [{ type: 'def', row: 1, col: 4 }, { type: 'identifier', row: 1, col: 8 }, { type: 'function_definition', row: 3, col: 4 }] });
  assert.equal(assessParse(build(program(absorbed)), 'python')?.status, 'degraded');
  const onlyItself = pyClass(0, { type: 'ERROR', row: 1, col: 4, children: [{ type: 'def', row: 1, col: 4 }, { type: 'identifier', row: 1, col: 8 }, { type: 'expression_statement', row: 2, col: 8 }] });
  assert.equal(assessParse(build(program(onlyItself)), 'python')?.status, 'recovered');
});

test('Python: a damaged method whose later sibling is intact is recovered', () => {
  const sibling = pyDef(4, { type: 'return_statement', col: 8 });
  const klass = pyClass(0, pyDef(4, { type: 'ERROR', col: 8 }), sibling);
  assert.equal(assessParse(build(program(klass)), 'python')?.status, 'recovered');
});

test('Python: nested functions, nested classes and imports inside a damaged method stay recovered', () => {
  const method = pyDef(4,
    { type: 'import_statement', col: 8 },
    { type: 'import_from_statement', col: 8 },
    pyDef(8, { type: 'return_statement', col: 12 }),
    pyClass(8, { type: 'pass_statement', col: 12 }),
    { type: 'decorated_definition', col: 8, children: [pyDef(8)] },
    { type: 'ERROR', col: 8, children: [{ type: '=', col: 10 }, { type: 'identifier', col: 8 }] },
  );
  assert.equal(assessParse(build(program(pyClass(0, method))), 'python')?.status, 'recovered');
});

test('Python: a class-level import and a legitimate sibling next to a damaged method are not reported as lost', () => {
  const imports = pyClass(0, { type: 'import_statement', col: 4 }, { type: 'import_from_statement', col: 4 }, pyDef(4, { type: 'ERROR', col: 8 }), pyDef(4, { type: 'return_statement', col: 8 }));
  assert.equal(assessParse(build(program(imports)), 'python')?.status, 'recovered');
});

test('Python: legitimate nested functions, classes and imports in a damaged body stay recovered', () => {
  const nested = pyDef(0,
    { type: 'import_statement', col: 4 },
    { type: 'import_from_statement', col: 4 },
    pyDef(4, { type: 'return_statement', col: 8 }),
    pyClass(4, { type: 'pass_statement', col: 8 }),
    { type: 'decorated_definition', col: 4, children: [pyDef(4)] },
    { type: 'ERROR', col: 4, children: [{ type: '=', col: 6 }, { type: 'identifier', col: 4 }] },
  );
  const health = assessParse(build(program(nested)), 'python');
  assert.equal(health?.status, 'recovered');
  const deeper = pyDef(4, { type: 'ERROR', col: 8, children: [{ type: 'import', col: 8 }] });
  assert.equal(assessParse(build(program(pyClass(0, deeper))), 'python')?.status, 'recovered', 'an import indented inside the method is its own');
});

test('Python: a body whose columns are unknown is not guessed at', () => {
  const unknown: Spec = { type: 'function_definition', children: [{ type: 'block', children: [{ type: 'ERROR', children: [{ type: 'def' }] }] }] };
  assert.equal(assessParse(build(program(unknown)), 'python')?.status, 'recovered');
});

// ---- Python: invalid code that the grammar accepts without an error node -------------------------------------------------
// (Trees here carry no ERROR or MISSING node anywhere: `hasError` is false at the root, as the real grammar reports it.)

const sMod = (...children: Spec[]): Spec => ({ type: 'module', children });
const sSuite = (...statements: Spec[]): Spec => ({ type: 'block', children: statements });
const sFn = (row: number, body?: Spec): Spec => ({ type: 'function_definition', row, col: 0, children: body ? [body] : [] });
const sClass = (row: number, ...inside: Spec[]): Spec => ({ type: 'class_definition', row, col: 0, children: [sSuite(...inside)] });
const sStmt = (type: string): Spec => ({ type });
const sComma: Spec = { type: ',' };

test('Python: a function or class with an empty body is reported although the tree has no error', () => {
  for (const owner of [sFn(4, sSuite()), sFn(4), sClass(4)]) {
    const health = assessParse(build(sMod(owner)), 'python');
    assert.equal(health?.status, 'recovered', owner.type);
    assert.deepEqual([health?.errors, health?.missing, health?.lines], [1, 0, [5]]);
  }
  assert.equal(assessParse(build(sMod(sFn(0, sSuite({ type: 'comment' })))), 'python')?.errors, 1, 'a comment is not a statement');
});

test('Python: an empty method inside a valid class, and several empty bodies, are each counted once', () => {
  const nested = sClass(0, sFn(1, sSuite(sStmt('pass_statement'))), { ...sFn(3, sSuite()), col: 4 });
  const health = assessParse(build(sMod(nested, sFn(9, sSuite()))), 'python');
  assert.deepEqual([health?.errors, health?.lines], [2, [4, 10]]);
});

test('Python: pass, ellipsis, docstrings and one-line suites are valid bodies', () => {
  const bodies = ['pass_statement', 'expression_statement', 'return_statement', 'raise_statement'];
  for (const type of bodies) assert.equal(assessParse(build(sMod(sFn(0, sSuite(sStmt(type))), sClass(2, sStmt(type)))), 'python'), undefined, type);
  const oneLine = sMod({ type: 'function_definition', row: 0, col: 0, children: [{ type: 'block', children: [sStmt('pass_statement'), { type: ';' }] }] });
  assert.equal(assessParse(build(oneLine), 'python'), undefined, '`def f(): pass;` is valid');
});

test('Python: a trailing comma in an unparenthesized import is reported and degrades the file', () => {
  const plain = { type: 'import_statement', row: 2, col: 0, children: [{ type: 'import' }, { type: 'dotted_name' }, sComma] };
  const from = { type: 'import_from_statement', row: 6, col: 0, children: [{ type: 'from' }, { type: 'dotted_name' }, { type: 'import' }, { type: 'dotted_name' }, sComma] };
  const many = { type: 'import_from_statement', row: 8, col: 0, children: [{ type: 'from' }, { type: 'dotted_name' }, { type: 'import' }, { type: 'dotted_name' }, sComma, { type: 'dotted_name' }, sComma] };
  for (const [statementSpec, line] of [[plain, 3], [from, 7], [many, 9]] as const) {
    const health = assessParse(build(sMod(statementSpec)), 'python');
    assert.equal(health?.status, 'degraded', `line ${line}: a malformed import is not a dependency to rely on`);
    assert.deepEqual([health?.errors, health?.lines], [1, [line]]);
  }
  const future = { type: 'future_import_statement', row: 0, col: 0, children: [{ type: 'from' }, { type: '__future__' }, { type: 'import' }, { type: 'dotted_name' }, sComma] };
  assert.equal(assessParse(build(sMod(future)), 'python')?.status, 'degraded');
  const trailingComment = { type: 'import_statement', row: 0, col: 0, children: [{ type: 'import' }, { type: 'dotted_name' }, sComma, { type: 'comment' }] };
  assert.equal(assessParse(build(sMod(trailingComment)), 'python')?.status, 'degraded', 'a comment after the comma does not make it valid');
});

test('Python: parenthesized imports with a trailing comma, and ordinary imports, are valid', () => {
  const paren = (...names: Spec[]): Spec => ({ type: 'import_from_statement', row: 0, col: 0, children: [{ type: 'from' }, { type: 'dotted_name' }, { type: 'import' }, { type: '(' }, ...names, { type: ')' }] });
  const name: Spec = { type: 'dotted_name' };
  for (const spec of [paren(name, sComma), paren(name, sComma, name, sComma), paren(name), paren(name, sComma, name)]) assert.equal(assessParse(build(sMod(spec)), 'python'), undefined);
  const ordinary = { type: 'import_statement', row: 0, col: 0, children: [{ type: 'import' }, name, sComma, name] };
  const wildcard = { type: 'import_from_statement', row: 0, col: 0, children: [{ type: 'from' }, name, { type: 'import' }, { type: 'wildcard_import' }] };
  assert.equal(assessParse(build(sMod(ordinary, wildcard)), 'python'), undefined);
});

test('Python: an import inside a function or a class body is checked too', () => {
  const bad = { type: 'import_statement', row: 3, col: 4, children: [{ type: 'import' }, { type: 'dotted_name' }, sComma] };
  assert.equal(assessParse(build(sMod(sFn(0, sSuite(bad)))), 'python')?.status, 'degraded');
  assert.equal(assessParse(build(sMod(sClass(0, bad))), 'python')?.status, 'degraded');
});

test('Python: parse errors and structural problems are counted once each, never twice', () => {
  // A real ERROR inside a function, plus an unrelated empty function elsewhere: two problems, two counts.
  const damaged = sFn(0, sSuite({ type: 'ERROR', row: 1, col: 4 }));
  const both = assessParse(build(sMod(damaged, sFn(5, sSuite()))), 'python');
  assert.deepEqual([both?.errors, both?.lines], [2, [2, 6]]);
  // A function that already holds an ERROR is not examined again for an empty body: still one problem.
  const onlyError = assessParse(build(sMod({ type: 'function_definition', row: 0, col: 0, children: [{ type: 'ERROR', row: 0, col: 8 }] })), 'python');
  assert.equal(onlyError?.errors, 1);
  // The same line reported by both passes appears once.
  const sameLine = assessParse(build(sMod(sFn(3, sSuite({ type: 'ERROR', row: 3, col: 4 })), { type: 'import_statement', row: 3, col: 0, children: [{ type: 'import' }, sComma] })), 'python');
  assert.equal(sameLine?.lines.filter((l) => l === 4).length, 1);
});

test('Python: a trailing comma together with real damage keeps the stronger classification', () => {
  const bad = { type: 'import_statement', row: 0, col: 0, children: [{ type: 'import' }, { type: 'dotted_name' }, sComma] };
  const health = assessParse(build(sMod(bad, sFn(2, sSuite({ type: 'ERROR', row: 3, col: 4 })))), 'python');
  assert.equal(health?.status, 'degraded');
  assert.equal(health?.errors, 2);
});

test('JavaScript and TypeScript are not affected by the Python structure checks', () => {
  const emptyFunction = { type: 'function_definition', row: 0, children: [{ type: 'block', children: [] }] };
  const commaImport = { type: 'import_statement', row: 1, children: [{ type: 'import' }, { type: 'dotted_name' }, sComma] };
  for (const lang of ['typescript', 'tsx', 'javascript'] as const) assert.equal(assessParse(build(program(emptyFunction, commaImport)), lang), undefined, lang);
});

test('descriptions of Python structural problems read like the rest', () => {
  const health = assessParse(build(sMod(sFn(4, sSuite()))), 'python');
  assert.match(describeHealth(health as NonNullable<typeof health>), /^1 syntax error\(s\) near line 5: declarations were extracted/);
});
