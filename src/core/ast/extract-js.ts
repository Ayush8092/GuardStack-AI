import type { Node } from '@vscode/tree-sitter-wasm';
import type { ParseInput } from './parser.js';
import type { DynamicLoad, Extracted, ImportKind, ImportRef, ReExport, Suppression, Sym, UnusedImport } from './types.js';
import { isBindingIdentifier, patternNames, resetScopeCache, resolvesToModuleBinding } from './scope-js.js';
import { hasParseError } from './health.js';
import { structuralHash, bodyHash, codeText, kids, leadingComment, lineOf, oneLine, rangeOf, summarizeNames, text, within, type Range } from './util.js';

const COMMENT_RULES: [kind: string, pattern: RegExp][] = [
  ['@ts-ignore', /@ts-ignore\b/],
  ['@ts-nocheck', /@ts-nocheck\b/],
  ['@ts-expect-error', /@ts-expect-error\b/],
  ['eslint-disable', /eslint-disable/],
];

const TS_SUPPRESSIONS = `
(comment) @comment
((predefined_type) @any (#eq? @any "any"))
`;

const JS_SUPPRESSIONS = '(comment) @comment';

const CALL_IMPORTS = `
(call_expression function: (import) arguments: (arguments . (string) @source)) @call
((call_expression function: (identifier) @fn arguments: (arguments . (string) @source)) @call (#eq? @fn "require"))
`;

const DYNAMIC_CALLS = `
(call_expression function: (import) arguments: (arguments . (_) @arg)) @call
((call_expression function: (identifier) @fn arguments: (arguments . (_) @arg)) @call (#eq? @fn "require"))
(call_expression function: (member_expression) @member arguments: (arguments . (_) @arg)) @call
`;
const GLOB_CALLS = new Set(['import.meta.glob', 'import.meta.globEager', 'require.context']);

// The literal text known before the first computed piece: `./plugins/${name}` and './plugins/' + name both give './plugins/'.
function literalPrefix(arg: Node): string | undefined {
  if (arg.type === 'string') return unquote(arg);
  if (arg.type === 'template_string') {
    const first = arg.children.find((c) => c?.type === 'string_fragment');
    const start = arg.children.find((c) => c && c.type !== '`');
    return first && start?.equals(first) ? first.text : '';
  }
  if (arg.type === 'binary_expression' && arg.childForFieldName('operator')?.text === '+') {
    const left = arg.childForFieldName('left');
    return left ? literalPrefix(left) : undefined;
  }
  return undefined;
}

const REFERENCE_NODES = ['identifier', 'type_identifier', 'shorthand_property_identifier'];
const FUNCTION_NODES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

type Binding = { local: string; imported: string };
type ImportBinding = Binding & { ref: ImportRef; source: string; line: number; skip: Range };
type Alias = { local: string; exported: string; line: number };
type Ref = { node: Node; exported: boolean };
type ExportMode = 'named' | 'default' | false;

const unquote = (node: Node | null | undefined): string => text(node).slice(1, -1);
const hasToken = (node: Node, type: string): boolean => node.children.some((c) => c?.type === type);
const isRequireCall = (node: Node): boolean => node.type === 'call_expression' && text(node.childForFieldName('function')) === 'require';

const structHashOf = (fn: Node | null | undefined): string | undefined =>
  fn ? structuralHash([fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter'), fn.childForFieldName('body')], isBindingIdentifier) : undefined;

function head(node: Node, source: string): string {
  const body = node.childForFieldName('body');
  return oneLine(codeText(node, source, body ? body.startIndex : node.endIndex));
}

function isPublicMethod(member: Node): boolean {
  if (member.type !== 'method_definition') return false;
  const name = text(member.childForFieldName('name'));
  if (!name || name === 'constructor' || name.startsWith('#')) return false;
  return !kids(member).some((c) => c.type === 'accessibility_modifier' && c.text !== 'public');
}

function insideFunction(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTION_NODES.has(current.type)) return true;
  }
  return false;
}

function declare(node: Node, source: string, mode: ExportMode): Sym[] {
  const line = lineOf(node);
  const doc = leadingComment(node);
  const make = (sym: Omit<Sym, 'line' | 'exportName'>): Sym => ({
    ...sym,
    ...(doc ? { doc } : {}),
    ...(hasParseError(node) ? { partial: true as const } : {}),
    line,
    exportName: mode === 'default' ? 'default' : mode ? sym.name : undefined,
  });

  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      return [
        make({
          name: text(node.childForFieldName('name')) || 'default',
          kind: 'function',
          signature: head(node, source),
          bodyHash: bodyHash(node.childForFieldName('body')),
          structHash: structHashOf(node),
        }),
      ];

    case 'class_declaration':
    case 'abstract_class_declaration': {
      const methods = kids(node.childForFieldName('body')).filter(isPublicMethod).map((m) => text(m.childForFieldName('name')));
      const signature = head(node, source);
      return [
        make({
          name: text(node.childForFieldName('name')) || 'default',
          kind: 'class',
          signature: methods.length ? `${signature} { ${summarizeNames(methods)} }` : signature,
        }),
      ];
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      const keyword = node.text.match(/^(const|let|var)/)?.[1] ?? 'const';
      const out: Sym[] = [];
      for (const declarator of kids(node).filter((k) => k.type === 'variable_declarator')) {
        const nameNode = declarator.childForFieldName('name');
        if (!nameNode) continue;

        if (nameNode.type !== 'identifier') {
          for (const name of patternNames(nameNode)) out.push(make({ name, kind: 'const', signature: `${keyword} ${name}` }));
          continue;
        }

        const value = declarator.childForFieldName('value');
        out.push(
          value && FUNCTION_VALUES.has(value.type)
            ? make({
                name: nameNode.text,
                kind: 'function',
                signature: oneLine(`${keyword} ${nameNode.text} = ${head(value, source)}`),
                bodyHash: bodyHash(value.childForFieldName('body')),
                structHash: structHashOf(value),
              })
            : make({
                name: nameNode.text,
                kind: 'const',
                signature: oneLine(`${keyword} ${nameNode.text}${codeText(declarator.childForFieldName('type'), source)}`),
              }),
        );
      }
      return out;
    }

    case 'type_alias_declaration': {
      const name = text(node.childForFieldName('name'));
      const generics = codeText(node.childForFieldName('type_parameters'), source);
      return [make({ name, kind: 'type', signature: oneLine(`type ${name}${generics} = ${codeText(node.childForFieldName('value'), source)}`, 140) })];
    }

    case 'interface_declaration': {
      const name = text(node.childForFieldName('name'));
      const members = kids(node.childForFieldName('body')).map((m) => text(m.childForFieldName('name'))).filter(Boolean);
      return [make({ name, kind: 'interface', signature: members.length ? `interface ${name} { ${summarizeNames(members)} }` : `interface ${name}` })];
    }

    case 'enum_declaration': {
      const name = text(node.childForFieldName('name'));
      const members = kids(node.childForFieldName('body')).map((m) => (m.type === 'enum_assignment' ? text(m.childForFieldName('name')) : m.text));
      return [make({ name, kind: 'enum', signature: members.length ? `enum ${name} { ${summarizeNames(members)} }` : `enum ${name}` })];
    }

    default:
      return [];
  }
}

function requireBindings(call: Node): { bindings: Binding[]; skip: Range | null } {
  const none = { bindings: [], skip: null };
  let target = call;
  let member: string | undefined;

  const parent = call.parent;
  if (parent?.type === 'member_expression' && parent.childForFieldName('object')?.equals(call)) {
    member = text(parent.childForFieldName('property'));
    target = parent;
  }

  const declarator = target.parent;
  if (declarator?.type !== 'variable_declarator' || !declarator.childForFieldName('value')?.equals(target)) return none;
  const name = declarator.childForFieldName('name');
  if (!name) return none;
  const skip = rangeOf(name);

  if (name.type === 'identifier') return { bindings: [{ local: name.text, imported: member ?? '*' }], skip };
  if (name.type !== 'object_pattern' || member) return { bindings: patternNames(name).map((local) => ({ local, imported: '*' })), skip };

  const bindings: Binding[] = [];
  for (const part of kids(name)) {
    if (part.type === 'shorthand_property_identifier_pattern') {
      bindings.push({ local: part.text, imported: part.text });
    } else if (part.type === 'object_assignment_pattern') {
      const local = text(part.childForFieldName('left'));
      if (local) bindings.push({ local, imported: local });
    } else if (part.type === 'pair_pattern') {
      const key = text(part.childForFieldName('key'));
      for (const local of patternNames(part.childForFieldName('value'))) bindings.push({ local, imported: key });
    } else if (part.type === 'rest_pattern') {
      for (const local of patternNames(part)) bindings.push({ local, imported: '*' });
    }
  }
  return { bindings, skip };
}

// `module.exports` -> { name: null }, `exports.x` / `module.exports.x` -> { name: 'x' }
function commonJsTarget(left: Node): { name: string | null } | null {
  const object = left.childForFieldName('object');
  const property = text(left.childForFieldName('property'));
  if (object?.type === 'identifier' && object.text === 'module' && property === 'exports') return { name: null };
  if (object?.type === 'identifier' && object.text === 'exports') return { name: property };
  if (object?.type === 'member_expression' && text(object.childForFieldName('object')) === 'module' && text(object.childForFieldName('property')) === 'exports') {
    return { name: property };
  }
  return null;
}

function isModuleExportsAssignment(call: Node): boolean {
  const parent = call.parent;
  if (parent?.type !== 'assignment_expression' || !parent.childForFieldName('right')?.equals(call)) return false;
  const left = parent.childForFieldName('left');
  return left?.type === 'member_expression' && commonJsTarget(left)?.name === null;
}

// `require('./x')` as a bare statement is an import, not a program that runs.
function isModuleExportsCall(statement: Node): boolean {
  const call = kids(statement).find((c) => c.type === 'call_expression');
  return call !== undefined && isRequireCall(call);
}

function memberNames(references: Ref[]): string[] | '*' {
  const names = new Set<string>();
  for (const { node } of references) {
    const parent = node.parent;
    if (parent?.type === 'member_expression' && parent.childForFieldName('object')?.equals(node)) {
      const property = parent.childForFieldName('property');
      if (!property) return '*';
      names.add(property.text);
    } else if (parent?.type === 'nested_type_identifier' && parent.childForFieldName('module')?.equals(node)) {
      names.add(text(parent.childForFieldName('name')));
    } else {
      return '*';
    }
  }
  return [...names];
}

// A reference counts only when it resolves to the module-level import: declarations and shadowed names do not.
function resolveReferences(root: Node, bindings: ImportBinding[], skipRanges: Range[], exportRanges: Range[]): UnusedImport[] {
  if (bindings.length === 0) return [];

  const wanted = new Set(bindings.map((b) => b.local));
  const references = new Map<string, Ref[]>();
  for (const node of root.descendantsOfType(REFERENCE_NODES)) {
    if (!node || !wanted.has(node.text) || within(node.startIndex, skipRanges) || !resolvesToModuleBinding(node)) continue;
    const list = references.get(node.text) ?? [];
    list.push({ node, exported: within(node.startIndex, exportRanges) });
    references.set(node.text, list);
  }

  const groups = new Map<ImportRef, ImportBinding[]>();
  for (const binding of bindings) groups.set(binding.ref, [...(groups.get(binding.ref) ?? []), binding]);

  const unused: UnusedImport[] = [];
  for (const [ref, group] of groups) {
    const names = new Set<string>();
    for (const binding of group) {
      const all = references.get(binding.local) ?? [];
      const runtime = all.filter((r) => !r.exported);
      if (all.length === 0 && binding.local !== 'React') unused.push({ name: binding.local, source: binding.source, line: binding.line });

      if (binding.imported === '*') {
        const members = memberNames(runtime);
        if (members === '*') names.add('*');
        else members.forEach((m) => names.add(m));
      } else if (runtime.length > 0 || all.length === 0) {
        names.add(binding.imported);
      }
    }
    ref.names = [...names];
  }
  return unused;
}

export function extractJs({ root, source, lang, query }: ParseInput): Extracted {
  resetScopeCache();
  const symbols: Sym[] = [];
  const imports: ImportRef[] = [];
  const reexports: ReExport[] = [];
  const bindings: ImportBinding[] = [];
  const locals = new Map<string, Sym>();
  const aliases: Alias[] = [];
  const reexportFromRanges: Range[] = [];
  const exportListRanges: Range[] = [];

  const keep = (found: Sym[], isLocal: boolean) => {
    symbols.push(...found);
    if (isLocal) for (const sym of found) locals.set(sym.name, sym);
  };

  const addRef = (specifier: string, names: string[], node: Node, kind: ImportKind, typeOnly: boolean): ImportRef => {
    const ref: ImportRef = { source: specifier, names, line: lineOf(node), kind, typeOnly };
    imports.push(ref);
    return ref;
  };

  function readImport(node: Node): void {
    const requireClause = kids(node).find((c) => c.type === 'import_require_clause');
    if (requireClause) {
      const specifier = unquote(requireClause.childForFieldName('source'));
      const local = text(kids(requireClause).find((c) => c.type === 'identifier'));
      const ref = addRef(specifier, ['*'], node, 'require', false);
      if (local) bindings.push({ local, imported: '*', ref, source: specifier, line: ref.line, skip: rangeOf(node) });
      return;
    }

    const specifier = unquote(node.childForFieldName('source'));
    const clause = kids(node).find((c) => c.type === 'import_clause');
    const found: Binding[] = [];
    const typedSpecifiers: boolean[] = [];

    for (const part of kids(clause)) {
      if (part.type === 'identifier') {
        found.push({ local: part.text, imported: 'default' });
      } else if (part.type === 'namespace_import') {
        found.push({ local: text(kids(part)[0]), imported: '*' });
      } else if (part.type === 'named_imports') {
        for (const spec of kids(part).filter((s) => s.type === 'import_specifier')) {
          const imported = text(spec.childForFieldName('name'));
          found.push({ local: text(spec.childForFieldName('alias')) || imported, imported });
          typedSpecifiers.push(hasToken(spec, 'type'));
        }
      }
    }

    const onlyTypedSpecifiers = found.length > 0 && typedSpecifiers.length === found.length && typedSpecifiers.every(Boolean);
    const ref = addRef(specifier, [...new Set(found.map((b) => b.imported))], node, 'import', hasToken(node, 'type') || onlyTypedSpecifiers);
    for (const binding of found) bindings.push({ ...binding, ref, source: specifier, line: ref.line, skip: rangeOf(node) });
  }

  function readExport(node: Node): void {
    const line = lineOf(node);
    const from = node.childForFieldName('source');
    const declaration = node.childForFieldName('declaration');
    const value = node.childForFieldName('value');
    const clause = kids(node).find((c) => c.type === 'export_clause');
    const isDefault = hasToken(node, 'default');
    const typeOnly = hasToken(node, 'type');
    const specifiers = kids(clause).filter((s) => s.type === 'export_specifier');

    if (from) {
      const specifier = unquote(from);
      reexportFromRanges.push(rangeOf(node));

      if (clause) {
        addRef(specifier, specifiers.map((s) => text(s.childForFieldName('name'))), node, 'reexport', typeOnly);
        for (const spec of specifiers) {
          const original = text(spec.childForFieldName('name'));
          const exported = text(spec.childForFieldName('alias')) || original;
          reexports.push({ source: specifier, imported: original, exported });
          symbols.push({ name: exported, kind: 'reexport', line, signature: `re-export ${original}`, exportName: exported });
        }
        return;
      }

      addRef(specifier, ['*'], node, 'reexport', typeOnly);
      const nsName = text(kids(kids(node).find((c) => c.type === 'namespace_export'))[0]);
      reexports.push({ source: specifier, imported: '*', exported: nsName || '*' });
      if (nsName) symbols.push({ name: nsName, kind: 'reexport', line, signature: `re-export * as ${nsName}`, exportName: nsName });
      return;
    }

    if (declaration) {
      keep(declare(declaration, source, isDefault ? 'default' : 'named'), false);
    } else if (clause) {
      exportListRanges.push(rangeOf(node));
      for (const spec of specifiers) {
        const local = text(spec.childForFieldName('name'));
        aliases.push({ local, exported: text(spec.childForFieldName('alias')) || local, line });
      }
    } else if (isDefault && value) {
      if (value.type === 'identifier') {
        exportListRanges.push(rangeOf(node));
        aliases.push({ local: value.text, exported: 'default', line });
      } else {
        symbols.push({ name: 'default', kind: 'default', line, signature: `default ${value.type.replace(/_/g, ' ')}`, exportName: 'default' });
      }
    }
  }

  function readCommonJsExport(node: Node): void {
    const assignment = kids(node).find((c) => c.type === 'assignment_expression');
    const left = assignment?.childForFieldName('left');
    const right = assignment?.childForFieldName('right');
    if (left?.type !== 'member_expression' || !right) return;

    const target = commonJsTarget(left);
    if (!target) return;
    const line = lineOf(node);

    const exportValue = (name: string, value: Node): void => {
      if (isRequireCall(value)) return;
      if (value.type === 'identifier') {
        aliases.push({ local: value.text, exported: name, line });
      } else if (FUNCTION_VALUES.has(value.type)) {
        symbols.push({
          name,
          kind: 'function',
          line,
          signature: oneLine(`${name} = ${head(value, source)}`),
          exportName: name,
          bodyHash: bodyHash(value.childForFieldName('body')),
          structHash: structHashOf(value),
        });
      } else if (value.type === 'class') {
        symbols.push({ name, kind: 'class', line, signature: head(value, source), exportName: name });
      } else {
        symbols.push({ name, kind: 'const', line, signature: `exports.${name}`, exportName: name });
      }
    };

    if (target.name !== null) return exportValue(target.name, right);
    if (right.type !== 'object') return exportValue('default', right);

    for (const member of kids(right)) {
      if (member.type === 'shorthand_property_identifier') {
        aliases.push({ local: member.text, exported: member.text, line });
      } else if (member.type === 'pair') {
        const value = member.childForFieldName('value');
        const key = text(member.childForFieldName('key'));
        if (key && value) exportValue(key, value);
      } else if (member.type === 'method_definition') {
        const name = text(member.childForFieldName('name'));
        if (!name) continue;
        symbols.push({
          name,
          kind: 'function',
          line: lineOf(member),
          signature: oneLine(`${name}${text(member.childForFieldName('parameters'))}`),
          exportName: name,
          bodyHash: bodyHash(member.childForFieldName('body')),
        });
      }
    }
  }

  for (const node of kids(root)) {
    if (node.type === 'import_statement') readImport(node);
    else if (node.type === 'export_statement') readExport(node);
    else if (node.type === 'expression_statement') readCommonJsExport(node);
    else keep(declare(node, source, false), true);
  }

  for (const match of query(CALL_IMPORTS).matches(root)) {
    const call = match.captures.find((c) => c.name === 'call')?.node;
    const target = match.captures.find((c) => c.name === 'source')?.node;
    if (!call || !target) continue;

    const isRequire = call.childForFieldName('function')?.type !== 'import';
    const specifier = unquote(target);
    const found = isRequire ? requireBindings(call) : { bindings: [], skip: null };
    const kind: ImportKind = isRequire && !insideFunction(call) ? 'require' : 'dynamic';
    const ref = addRef(specifier, found.bindings.length > 0 ? [] : ['*'], call, kind, false);

    if (isRequire && isModuleExportsAssignment(call)) reexports.push({ source: specifier, imported: '*', exported: 'default' });
    if (found.skip) for (const binding of found.bindings) bindings.push({ ...binding, ref, source: specifier, line: ref.line, skip: found.skip });
  }

  const dynamicLoads: DynamicLoad[] = [];
  for (const match of query(DYNAMIC_CALLS).matches(root)) {
    const call = match.captures.find((c) => c.name === 'call')?.node;
    const arg = match.captures.find((c) => c.name === 'arg')?.node;
    const member = match.captures.find((c) => c.name === 'member')?.node;
    if (!call || !arg) continue;
    if (member) {
      if (!GLOB_CALLS.has(member.text)) continue;
      const pattern = arg.type === 'array' ? kids(arg).find((k) => k.type === 'string') : arg;
      const prefix = pattern?.type === 'string' ? unquote(pattern).split('*')[0] : undefined;
      dynamicLoads.push({ line: lineOf(call), kind: 'glob', prefix: prefix || undefined });
      continue;
    }
    if (arg.type === 'string') continue;
    const prefix = literalPrefix(arg);
    dynamicLoads.push({ line: lineOf(call), kind: call.childForFieldName('function')?.type === 'import' ? 'import' : 'require', prefix: prefix || undefined });
  }

  const decorated = root.descendantsOfType(['class_declaration', 'abstract_class_declaration']).some((c) => c !== null && (kids(c).some((k) => k.type === 'decorator') || kids(c.parent).some((k) => k.type === 'decorator')));
  const script = kids(root).some((n) => n.type === 'expression_statement' && kids(n).some((c) => ['call_expression', 'await_expression', 'new_expression'].includes(c.type)) && !isModuleExportsCall(n));

  const byLocal = new Map(bindings.map((b) => [b.local, b]));
  for (const alias of aliases) {
    const local = locals.get(alias.local);
    if (local && !local.exportName) {
      local.exportName = alias.exported;
      continue;
    }
    const imported = byLocal.get(alias.local);
    if (imported) reexports.push({ source: imported.source, imported: imported.imported, exported: alias.exported });
    symbols.push({ name: alias.local, kind: 'reexport', line: alias.line, signature: `re-export ${alias.local}`, exportName: alias.exported });
  }

  const skipRanges = [...bindings.map((b) => b.skip), ...reexportFromRanges];
  const unusedImports = resolveReferences(root, bindings, skipRanges, exportListRanges);

  const suppressions: Suppression[] = [];
  const hasTypes = lang !== 'javascript';
  for (const capture of query(hasTypes ? TS_SUPPRESSIONS : JS_SUPPRESSIONS).captures(root)) {
    const line = lineOf(capture.node);
    if (capture.name === 'any') {
      suppressions.push({ kind: 'any', line });
      continue;
    }
    const rule = COMMENT_RULES.find(([, pattern]) => pattern.test(capture.node.text));
    if (rule) suppressions.push({ kind: rule[0], line });
  }

  return { symbols, imports, reexports, unusedImports, suppressions, dynamicLoads, decorated, script };
}
