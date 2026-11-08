import type { Node } from '@vscode/tree-sitter-wasm';
import type { ParseInput } from './parser.js';
import type { Extracted, ImportKind, ImportRef, ReExport, Suppression, Sym, UnusedImport } from './types.js';
import { hasParseError } from './health.js';
import { structuralHash, bodyHash, codeText, docstring, kids, lineOf, oneLine, rangeOf, summarizeNames, text, within, type Range } from './util.js';

const COMMENT_RULES: [kind: string, pattern: RegExp][] = [
  ['type: ignore', /#\s*type:\s*ignore/],
  ['noqa', /#\s*noqa\b/i],
  ['pylint: disable', /#\s*pylint:\s*disable/],
  ['pyright: ignore', /#\s*pyright:\s*ignore/],
  ['mypy: ignore-errors', /#\s*mypy:\s*ignore-errors/],
];

const QUERY = `
(comment) @comment
(import_statement) @import
(import_from_statement) @from
`;

const CONSTANT = /^[A-Z][A-Z0-9_]*$/;
const INTENTIONAL_IMPORT = /#\s*(?:noqa|type:\s*ignore|pylint:\s*disable|pyright:\s*ignore)/i;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

type PyBinding = { local: string; source: string; line: number; skip: Range; intentional: boolean };

const present = (nodes: (Node | null)[]): Node[] => nodes.filter((n): n is Node => n !== null);

function signature(def: Node, source: string): string {
  const body = def.childForFieldName('body');
  return oneLine(codeText(def, source, body ? body.startIndex : def.endIndex)).replace(/:\s*(?:#.*)?$/, '');
}

const docField = (def: Node): { doc?: string } => {
  const doc = docstring(def);
  return doc ? { doc } : {};
};

function publicMethods(classNode: Node): string[] {
  return kids(classNode.childForFieldName('body'))
    .map((member) => (member.type === 'decorated_definition' ? member.childForFieldName('definition') : member))
    .filter((member): member is Node => member?.type === 'function_definition')
    .map((member) => member.childForFieldName('name')?.text ?? '')
    .filter((name) => name && !name.startsWith('_'));
}

function insideFunction(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'function_definition') return true;
  }
  return false;
}

function insideTypeChecking(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'if_statement' && /\bTYPE_CHECKING\b/.test(text(current.childForFieldName('condition')))) return true;
  }
  return false;
}

// A string that names a type: inside an annotation, inside a subscript (Callable[["Response"], Any], Optional["Foo"]),
// or the first argument of cast("Foo", value). Only a bare dotted name counts, so ordinary strings are not mistaken for uses.
const TYPE_NAME = /^\s*[A-Za-z_][\w.]*(?:\[[\w.,\s|\[\]]*\])?\s*$/;
function insideAnnotation(node: Node): boolean {
  let current = node.parent;
  for (let depth = 0; current && depth < 6; depth++, current = current.parent) {
    if (current.type === 'type') return true;
  }
  const raw = node.text.replace(/^[rbuRBU]*['"]+|['"]+$/g, '');
  if (!TYPE_NAME.test(raw)) return false;
  for (let parent = node.parent, depth = 0; parent && depth < 4; depth++, parent = parent.parent) {
    if (parent.type === 'subscript') return true;
    if (parent.type === 'call' && /^(?:typing\.)?cast$/.test(text(parent.childForFieldName('function')))) return true;
    if (parent.type === 'block' || parent.type === 'module') break;
  }
  return false;
}

function importedItem(item: Node): { imported: string; local: string } {
  if (item.type !== 'aliased_import') return { imported: item.text, local: item.text };
  const imported = text(item.childForFieldName('name'));
  return { imported, local: text(item.childForFieldName('alias')) || imported };
}

export function extractPython({ root, source, query, path: filePath }: ParseInput): Extracted {
  const symbols: Sym[] = [];
  const imports: ImportRef[] = [];
  const reexports: ReExport[] = [];
  const suppressions: Suppression[] = [];
  const bindings: PyBinding[] = [];
  const importRanges: Range[] = [];
  const isInit = /(^|\/)__init__\.py$/.test(filePath);

  for (const node of kids(root)) {
    const def = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
    if (!def) continue;
    const line = def.startPosition.row + 1;
    const name = def.childForFieldName('name')?.text ?? '';

    if (def.type === 'function_definition') {
      symbols.push({
        name,
        kind: 'function',
        line,
        signature: signature(def, source),
        ...docField(def),
        ...(hasParseError(def) ? { partial: true as const } : {}),
        exportName: name.startsWith('_') ? undefined : name,
        bodyHash: bodyHash(def.childForFieldName('body')),
        structHash: structuralHash([def.childForFieldName('parameters'), def.childForFieldName('body')], (n) => storeScope(n).store),
      });
    } else if (def.type === 'class_definition') {
      const methods = publicMethods(def);
      const classHead = signature(def, source);
      symbols.push({
        name,
        kind: 'class',
        line,
        signature: methods.length ? `${classHead} { ${summarizeNames(methods)} }` : classHead,
        ...docField(def),
        ...(hasParseError(def) ? { partial: true as const } : {}),
        exportName: name.startsWith('_') ? undefined : name,
      });
    } else if (def.type === 'expression_statement') {
      const assignment = kids(def).find((c) => c.type === 'assignment');
      const target = assignment?.childForFieldName('left');
      if (target?.type === 'identifier' && CONSTANT.test(target.text)) {
        const annotation = assignment?.childForFieldName('type');
        symbols.push({
          name: target.text,
          kind: 'const',
          line,
          signature: annotation ? `${target.text}: ${annotation.text}` : target.text,
          exportName: target.text.startsWith('_') ? undefined : target.text,
        });
      }
    }
  }

  function readImport(node: Node): void {
    importRanges.push(rangeOf(node));
    const line = lineOf(node);
    const kind: ImportKind = insideFunction(node) ? 'dynamic' : 'import';
    const typeOnly = insideTypeChecking(node);
    const endOfLine = source.indexOf('\n', node.endIndex);
    const intentional = INTENTIONAL_IMPORT.test(source.slice(node.startIndex, endOfLine === -1 ? source.length : endOfLine));

    if (node.type === 'import_statement') {
      for (const item of present(node.childrenForFieldName('name'))) {
        const aliased = item.type === 'aliased_import';
        const dotted = aliased ? text(item.childForFieldName('name')) : item.text;
        const alias = aliased ? text(item.childForFieldName('alias')) : '';
        imports.push({ source: dotted, names: ['*'], line, kind, typeOnly });
        bindings.push({ local: alias || dotted.split('.')[0], source: dotted, line, skip: rangeOf(node), intentional });
      }
      return;
    }

    const moduleName = text(node.childForFieldName('module_name'));
    const wildcard = kids(node).some((c) => c.type === 'wildcard_import');
    const items = present(node.childrenForFieldName('name')).map(importedItem);
    imports.push({ source: moduleName, names: wildcard ? ['*'] : items.map((i) => i.imported), line, kind, typeOnly });

    if (!wildcard && moduleName !== '__future__') {
      for (const item of items) bindings.push({ local: item.local, source: moduleName, line, skip: rangeOf(node), intentional });
    }
    if (isInit && kind === 'import' && !typeOnly) {
      if (wildcard) reexports.push({ source: moduleName, imported: '*', exported: '*' });
      else for (const item of items) reexports.push({ source: moduleName, imported: item.imported, exported: item.local });
    }
  }

  for (const capture of query(QUERY).captures(root)) {
    if (capture.name === 'comment') {
      const rule = COMMENT_RULES.find(([, pattern]) => pattern.test(capture.node.text));
      if (rule) suppressions.push({ kind: rule[0], line: lineOf(capture.node) });
    } else {
      readImport(capture.node);
    }
  }

  return { symbols, imports, reexports, unusedImports: isInit ? [] : findUnused(root, bindings, importRanges), suppressions, dynamicLoads: [], decorated: false, script: hasMainGuardOrCall(root) };
}

const PY_SCOPES = new Set(['function_definition', 'lambda', 'list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression', 'class_definition']);
const PATTERN_WRAPPERS = new Set(['tuple_pattern', 'list_pattern', 'pattern_list', 'list_splat_pattern', 'parenthesized_pattern', 'dictionary_splat_pattern']);
const PARAM_PARENTS = new Set(['parameters', 'lambda_parameters', 'default_parameter', 'typed_parameter', 'typed_default_parameter']);

// A top-level call or an `if __name__ == "__main__"` guard means the file is meant to be run, not only imported.
function hasMainGuardOrCall(root: Node): boolean {
  return kids(root).some(
    (n) =>
      (n.type === 'if_statement' && /__name__/.test(text(n.childForFieldName('condition')))) ||
      (n.type === 'expression_statement' && kids(n).some((c) => c.type === 'call' || c.type === 'await')),
  );
}

const COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

// A walrus inside a comprehension binds its target in the function (or module) around the comprehension, not in it.
function walrusScope(node: Node): Node | null {
  let scope = nearestPyScope(node);
  while (scope && COMPREHENSIONS.has(scope.type)) scope = nearestPyScope(scope);
  return scope;
}

function nearestPyScope(node: Node): Node | null {
  for (let current = node.parent; current; current = current.parent) if (PY_SCOPES.has(current.type)) return current;
  return null;
}

// A store introduces a name in its scope (assignment target, parameter, loop or with/except variable, def/class name).
// A keyword argument name is neither a store nor a use.
function storeScope(node: Node): { store: boolean; scope: Node | null } {
  const parent = node.parent;
  if (!parent) return { store: false, scope: null };
  if ((parent.type === 'function_definition' || parent.type === 'class_definition') && parent.childForFieldName('name')?.equals(node)) {
    return { store: true, scope: nearestPyScope(parent) };
  }
  let current = node;
  for (let p = current.parent; p; p = current.parent) {
    if (PATTERN_WRAPPERS.has(p.type)) {
      current = p;
      continue;
    }
    if (p.type === 'assignment' || p.type === 'for_statement' || p.type === 'for_in_clause') {
      return { store: p.childForFieldName('left')?.equals(current) === true, scope: nearestPyScope(p) };
    }
    if (p.type === 'as_pattern_target' || (p.type === 'as_pattern' && p.childForFieldName('alias')?.equals(current))) return { store: true, scope: nearestPyScope(p) };
    if (p.type === 'named_expression') return { store: p.childForFieldName('name')?.equals(current) === true, scope: walrusScope(p) };
    if (PARAM_PARENTS.has(p.type)) {
      const bound = p.type === 'parameters' || p.type === 'lambda_parameters' || p.childForFieldName('name')?.equals(current) === true || p.firstNamedChild?.equals(current) === true;
      return { store: bound, scope: nearestPyScope(p) };
    }
    return { store: false, scope: null };
  }
  return { store: false, scope: null };
}

function isKeywordName(node: Node): boolean {
  return node.parent?.type === 'keyword_argument' && node.parent.childForFieldName('name')?.equals(node) === true;
}

function findUnused(root: Node, bindings: PyBinding[], importRanges: Range[]): UnusedImport[] {
  if (bindings.length === 0) return [];

  const wanted = new Set(bindings.map((b) => b.local));
  const locals = new Map<number, Set<string>>();
  // Names bound in a class body, with where they are first bound: a read later in the same body sees the class
  // attribute, a read inside a method skips the class scope and sees the module.
  const classBound = new Map<number, Map<string, number>>();
  const loads: Node[] = [];

  for (const node of root.descendantsOfType('identifier')) {
    if (!node || within(node.startIndex, importRanges)) continue;
    const { store, scope } = storeScope(node);
    if (store) {
      if (scope && scope.type !== 'class_definition') {
        const names = locals.get(scope.id) ?? new Set<string>();
        names.add(node.text);
        locals.set(scope.id, names);
      } else if (scope) {
        const bound = classBound.get(scope.id) ?? new Map<string, number>();
        if (!bound.has(node.text)) bound.set(node.text, node.startIndex);
        classBound.set(scope.id, bound);
      }
      continue;
    }
    if (wanted.has(node.text) && !isKeywordName(node)) loads.push(node);
  }

  // `global x` / `nonlocal x` make the name refer to the outer binding again.
  for (const statement of root.descendantsOfType(['global_statement', 'nonlocal_statement'])) {
    if (!statement) continue;
    const scope = nearestPyScope(statement);
    for (const id of kids(statement)) locals.get(scope?.id ?? -1)?.delete(id.text);
  }

  const used = new Set<string>();
  for (const node of loads) {
    let shadowed = false;
    const nearest = nearestPyScope(node);
    if (nearest?.type === 'class_definition' && (classBound.get(nearest.id)?.get(node.text) ?? Infinity) < node.startIndex) shadowed = true;
    for (let scope = nearest; scope && !shadowed; scope = nearestPyScope(scope)) {
      if (scope.type !== 'class_definition' && locals.get(scope.id)?.has(node.text)) {
        shadowed = true;
        break;
      }
    }
    const isAttributeName = node.parent?.type === 'attribute' && node.parent.childForFieldName('attribute')?.equals(node);
    if (!shadowed && !isAttributeName) used.add(node.text);
  }

  // Quoted annotations ("Foo") and __all__ entries reference names without an identifier node.
  for (const node of root.descendantsOfType('string')) {
    if (!node) continue;
    const exportsList = node.parent?.parent?.type === 'assignment' && text(node.parent.parent.childForFieldName('left')) === '__all__';
    if (!insideAnnotation(node) && !exportsList) continue;
    for (const word of node.text.match(WORD) ?? []) used.add(word);
  }

  return bindings
    .filter((b) => !b.intentional && !used.has(b.local))
    .map((b) => ({ name: b.local, source: b.source, line: b.line }));
}
