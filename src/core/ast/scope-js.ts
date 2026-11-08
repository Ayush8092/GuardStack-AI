import type { Node } from '@vscode/tree-sitter-wasm';
import { kids, text } from './util.js';

export function patternNames(node: Node | null | undefined): string[] {
  if (!node) return [];
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      return [node.text];
    case 'object_pattern':
    case 'array_pattern':
    case 'rest_pattern':
      return kids(node).flatMap(patternNames);
    case 'pair_pattern':
      return patternNames(node.childForFieldName('value'));
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      return patternNames(node.childForFieldName('left'));
    default:
      return [];
  }
}

const FUNCTION_LIKE = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const SCOPES = new Set([...FUNCTION_LIKE, 'statement_block', 'for_statement', 'for_in_statement', 'catch_clause']);
const NAMED_DECLARATIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'enum_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'internal_module',
  'type_parameter',
]);
const BLOCK_DECLARATIONS = new Set(['function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration', 'enum_declaration', 'interface_declaration', 'type_alias_declaration']);

function declaratorNames(declaration: Node): string[] {
  return kids(declaration)
    .filter((k) => k.type === 'variable_declarator')
    .flatMap((d) => patternNames(d.childForFieldName('name')));
}

function nearestFunction(node: Node): Node | null {
  for (let current = node.parent; current; current = current.parent) if (FUNCTION_LIKE.has(current.type)) return current;
  return null;
}

// Is this identifier the place a name is introduced (a declaration or a parameter), as opposed to a use of it?
export function isBindingIdentifier(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (NAMED_DECLARATIONS.has(parent.type) && parent.childForFieldName('name')?.equals(node)) return true;
  if (parent.type === 'arrow_function' && parent.childForFieldName('parameter')?.equals(node)) return true;

  let current = node;
  for (let p = current.parent; p; p = current.parent) {
    switch (p.type) {
      case 'object_pattern':
      case 'array_pattern':
      case 'rest_pattern':
        current = p;
        continue;
      case 'pair_pattern':
        if (!p.childForFieldName('value')?.equals(current)) return false;
        current = p;
        continue;
      case 'assignment_pattern':
      case 'object_assignment_pattern':
        if (!p.childForFieldName('left')?.equals(current)) return false;
        current = p;
        continue;
      case 'variable_declarator':
        return p.childForFieldName('name')?.equals(current) ?? false;
      case 'required_parameter':
      case 'optional_parameter':
        return p.childForFieldName('pattern')?.equals(current) ?? false;
      case 'formal_parameters':
        return true;
      case 'catch_clause':
        return p.childForFieldName('parameter')?.equals(current) ?? false;
      case 'for_in_statement':
        return p.childForFieldName('left')?.equals(current) === true && p.children.some((c) => c && ['const', 'let', 'var'].includes(c.type));
      default:
        return false;
    }
  }
  return false;
}

const cache = new Map<number, Set<string>>();

function declaredNames(scope: Node): Set<string> {
  const known = cache.get(scope.id);
  if (known) return known;
  const names = new Set<string>();

  if (FUNCTION_LIKE.has(scope.type)) {
    const parameters = scope.childForFieldName('parameters');
    for (const param of kids(parameters)) {
      if (param.type === 'required_parameter' || param.type === 'optional_parameter') patternNames(param.childForFieldName('pattern')).forEach((n) => names.add(n));
      else patternNames(param).forEach((n) => names.add(n));
    }
    const single = scope.childForFieldName('parameter');
    if (single) patternNames(single).forEach((n) => names.add(n));
    if (scope.type === 'function_expression' || scope.type === 'generator_function') {
      const own = text(scope.childForFieldName('name'));
      if (own) names.add(own);
    }
    for (const param of kids(scope.childForFieldName('type_parameters'))) {
      const name = text(param.childForFieldName('name'));
      if (name) names.add(name);
    }
    for (const declaration of scope.descendantsOfType('variable_declaration')) {
      if (declaration && nearestFunction(declaration)?.equals(scope)) declaratorNames(declaration).forEach((n) => names.add(n));
    }
  } else if (scope.type === 'statement_block') {
    for (const child of kids(scope)) {
      if (child.type === 'lexical_declaration') declaratorNames(child).forEach((n) => names.add(n));
      else if (BLOCK_DECLARATIONS.has(child.type)) {
        const name = text(child.childForFieldName('name'));
        if (name) names.add(name);
      }
    }
  } else if (scope.type === 'for_statement') {
    const init = scope.childForFieldName('initializer');
    if (init && (init.type === 'lexical_declaration' || init.type === 'variable_declaration')) declaratorNames(init).forEach((n) => names.add(n));
  } else if (scope.type === 'for_in_statement') {
    if (scope.children.some((c) => c && ['const', 'let', 'var'].includes(c.type))) patternNames(scope.childForFieldName('left')).forEach((n) => names.add(n));
  } else if (scope.type === 'catch_clause') {
    patternNames(scope.childForFieldName('parameter')).forEach((n) => names.add(n));
  }

  cache.set(scope.id, names);
  return names;
}

export function resetScopeCache(): void {
  cache.clear();
}

// A reference counts as a use of the import only if it is not itself a declaration and no enclosing scope
// declares the same name (a parameter, a local const, a catch variable, a nested function...).
export function resolvesToModuleBinding(node: Node): boolean {
  if (isBindingIdentifier(node)) return false;
  for (let current = node.parent; current; current = current.parent) {
    if (SCOPES.has(current.type) && declaredNames(current).has(node.text)) return false;
  }
  return true;
}
