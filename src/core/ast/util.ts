import { createHash } from 'node:crypto';
import type { Node } from '@vscode/tree-sitter-wasm';
import { hasParseError } from './health.js';

export type Range = readonly [start: number, end: number];

export function kids(node: Node | null | undefined): Node[] {
  return node ? node.namedChildren.filter((c): c is Node => c !== null) : [];
}

export const text = (node: Node | null | undefined): string => node?.text ?? '';

// The source text of `node` up to `end`, with comments removed. Signatures are built from this so that a comment
// inside a parameter list or type never becomes part of what is displayed or sent to an external model.
export function codeText(node: Node | null | undefined, source: string, end?: number): string {
  if (!node) return '';
  const stop = end ?? node.endIndex;
  const cuts: Range[] = [];
  const collect = (n: Node): void => {
    if (n.startIndex >= stop) return;
    if (n.type === 'comment') {
      cuts.push([n.startIndex, n.endIndex]);
      return;
    }
    for (const child of n.children) if (child) collect(child);
  };
  collect(node);

  let out = '';
  let pos = node.startIndex;
  for (const [from, to] of cuts) {
    out += `${source.slice(pos, from)} `;
    pos = to;
  }
  return out + source.slice(pos, stop);
}

export const rangeOf = (node: Node): Range => [node.startIndex, node.endIndex];

export const within = (index: number, ranges: readonly Range[]): boolean => ranges.some(([start, end]) => index >= start && index < end);

export const lineOf = (node: Node): number => node.startPosition.row + 1;

export function oneLine(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const MIN_BODY_CHARS = 120;

export function bodyHash(body: Node | null): string | undefined {
  // A body that contains a syntax error was cut short or repaired by the parser: equal hashes would prove nothing.
  if (!body || hasParseError(body)) return undefined;
  const normalized = body.text.replace(/\s+/g, ' ').trim();
  if (normalized.length < MIN_BODY_CHARS) return undefined;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

export function summarizeNames(names: string[], limit = 10): string {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown}, …` : shown;
}

const MIN_STRUCT_TOKENS = 40;
const LITERAL_TOKENS: Record<string, string> = {
  string: 'S', template_string: 'S', number: 'N', integer: 'N', float: 'N', regex: 'R', concatenated_string: 'S',
};
const SKIPPED = new Set(['comment', 'type_annotation', 'type_parameters', 'return_type', 'decorator']);

// Hash of a function's parameters and body (not its name or keyword form) where names declared inside the function (parameters, locals) are replaced by their
// order of appearance, free names, property names and operators are kept, and literals keep only their kind.
// Two functions that differ only in local naming, literal values or type annotations hash the same; anything
// that changes the shape of the code does not. This compares syntax, never behaviour.
export function structuralHash(parts: (Node | null)[], isDeclared: (node: Node) => boolean): string | undefined {
  if (parts.some((part) => hasParseError(part))) return undefined;
  const rename = new Map<string, number>();
  const tokens: string[] = [];

  const visit = (node: Node): void => {
    if (SKIPPED.has(node.type)) return;
    const literal = LITERAL_TOKENS[node.type];
    if (literal) {
      tokens.push(literal);
      return;
    }
    if (node.childCount === 0) {
      if (node.type === 'identifier' || node.type === 'shorthand_property_identifier' || node.type === 'shorthand_property_identifier_pattern') {
        const name = node.text;
        if (isDeclared(node) || rename.has(name)) {
          if (!rename.has(name)) rename.set(name, rename.size);
          tokens.push(`#${rename.get(name)}`);
        } else {
          tokens.push(`id:${name}`);
        }
      } else if (node.isNamed) {
        tokens.push(`${node.type}:${node.text}`);
      } else {
        tokens.push(node.type);
      }
      return;
    }
    tokens.push(`(${node.type}`);
    for (const child of node.children) if (child) visit(child);
    tokens.push(')');
  };
  for (const part of parts) if (part) visit(part);

  if (tokens.length < MIN_STRUCT_TOKENS) return undefined;
  return createHash('sha1').update(tokens.join(' ')).digest('hex').slice(0, 12);
}

const cleanDoc = (raw: string): string | undefined => {
  const lines = raw
    .replace(/^\s*(?:\/\*+|\/\/+|#+|"""|\'\'\')/, '')
    .replace(/(?:\*+\/|"""|\'\'\')\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\*+|\/\/+|#+)\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@') && !/^eslint|^prettier|^ts-|^istanbul/i.test(l));
  const first = lines.join(' ').match(/^.*?(?:[.!?](?=\s|$)|$)/)?.[0] ?? '';
  const doc = oneLine(first.trim(), 160);
  return doc.length >= 8 ? doc : undefined;
};

// The comment that sits directly above a declaration (or above its `export` wrapper): a JSDoc block or `//` line.
export function leadingComment(node: Node): string | undefined {
  const target = node.parent?.type === 'export_statement' ? node.parent : node;
  const prev = target.previousSibling;
  if (prev?.type !== 'comment' || prev.endPosition.row < target.startPosition.row - 1) return undefined;
  if (/^\/\/\s*(?:@ts-|eslint|prettier|istanbul|#region|#endregion)/.test(prev.text)) return undefined;
  return cleanDoc(prev.text);
}

// A Python docstring: the first statement of a function or class body when it is a bare string.
export function docstring(def: Node): string | undefined {
  const first = def.childForFieldName('body')?.namedChildren[0];
  if (first?.type !== 'expression_statement') return undefined;
  const str = first.namedChildren[0];
  return str?.type === 'string' ? cleanDoc(str.text) : undefined;
}
