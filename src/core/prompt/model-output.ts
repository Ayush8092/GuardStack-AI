import { z } from 'zod';
import type { FileInfo } from '../ast/types.js';
import { maskSecrets } from '../security/masker.js';
import { hasHiddenText } from '../../utils/text.js';

const text = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters are not allowed');

const answerSchema = z.strictObject({
  reuse: z
    .array(z.strictObject({ symbol: z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/), file: text(300), why: text(160) }))
    .max(8),
  assumptions: z.array(text(200)).max(5),
  questions: z.array(text(200)).max(5),
});

export type VerifiedReuse = { symbol: string; file: string; line: number; exported: boolean; why: string };
export type ModelNote = { reuse: VerifiedReuse[]; assumptions: string[]; questions: string[] };
export type RejectReason = 'not-in-project' | 'unsafe-content';
export type Rejection = { text: string; reason: RejectReason };

export type ModelAnswer =
  | { ok: true; note: ModelNote; rejected: string[]; rejections: Rejection[] }
  | { ok: false; reason: string };

const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)*\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py)\b/g;
// A directory-looking reference without an extension: src/utils, packages/core/lib.
const DIR_TOKEN = /(?<![\w@./-])(?:[\w@.-]+\/)+[\w@.-]+\/?(?![\w@./-]|\.[a-z])/g;
const BACKTICKED = /`([A-Za-z_$][\w$]*)`/g;
// foo( and obj.foo( : a call the model asserts exists. Member calls are skipped, they belong to some other object.
const CALL = /(?<![\w$.])([A-Za-z_$][\w$]*)\(/g;
// camelCase, PascalCase with a hump, or snake_case words of 6+ characters read as identifiers even without backticks.
const IDENTIFIER_LIKE = /(?<![\w$.\/-])([A-Za-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w$-]|\.[a-z])/g;
const WELL_KNOWN = new Set(['TypeScript', 'JavaScript', 'GitHub', 'GitLab', 'PostgreSQL', 'MongoDB', 'GraphQL', 'OAuth', 'NodeJS', 'FastAPI', 'SQLite', 'MySQL', 'DevOps', 'CommonJS', 'JSON', 'JWT', 'UTF', 'iOS', 'macOS', 'ReactJS', 'VueJS', 'e_g', 'i_e']);
const GLOBAL_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'print', 'len', 'range', 'str', 'int', 'list', 'dict', 'set', 'map', 'filter', 'require', 'import', 'fetch', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise', 'Error', 'Date', 'setTimeout', 'setInterval', 'isNaN', 'super', 'async', 'await']);

// The reply is advice, not a command: links, shell fragments, markup and instructions aimed at the next model are
// never repeated into a prompt, however well-formed the rest of the reply is.
const UNSAFE = /https?:\/\/|\bwww\.|<\/?[a-z][^>]*>|```|\[[^\]]*\]\([^)]*\)|\b(?:curl|wget|sudo|chmod|eval)\s|\brm\s+-|&&|\|\s*(?:sh|bash)\b|\$\(|ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)|disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above)|\b(?:system|developer)\s+prompt\b|\byou\s+(?:are|must)\s+now\b|\b(?:npm|pnpm|yarn|pip3?)\s+(?:i|install|add)\b/i;

// A reply may be wrapped in one json code fence; anything else around the object means it is not the object we asked for.
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

// Model output is untrusted input. It must match the schema exactly, and everything it states about this project
// is checked against the index before it is shown: files, symbols, directories, paths and identifiers named in
// free text must exist (or come from the developer's own request). What survives is split into verified references,
// which were checked, and commentary, which only passed those checks and is still the model's opinion.
export function validateModelAnswer(raw: string, files: FileInfo[], request: string): ModelAnswer {
  let data: unknown;
  try {
    data = extractJson(raw);
  } catch {
    return { ok: false, reason: 'the reply was not a single JSON object' };
  }
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: 'the reply did not match the expected schema' };

  const clean = (p: string): string => p.replace(/^\.\//, '');
  const byPath = new Map(files.map((f) => [f.path, f]));
  const basenames = new Map<string, number>();
  for (const f of files) basenames.set(f.path.split('/').pop() as string, (basenames.get(f.path.split('/').pop() as string) ?? 0) + 1);
  const directories = new Set(files.flatMap((f) => f.path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));

  const known = new Set<string>(WELL_KNOWN);
  for (const f of files) {
    for (const sym of f.symbols) {
      known.add(sym.name);
      if (sym.exportName) known.add(sym.exportName);
    }
    for (const imp of f.imports) for (const name of imp.names) known.add(name);
  }
  const requestWords = new Set(request.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const mentionable = (name: string): boolean => known.has(name) || requestWords.has(name);

  const pathExists = (token: string): boolean => {
    const t = clean(token);
    return byPath.has(t) || (!t.includes('/') && basenames.get(t) === 1);
  };

  // Returns why the text cannot be trusted, or null when everything it asserts about the project checks out.
  const problem = (value: string): RejectReason | null => {
    // Invisible or reordering characters (including the Unicode tag block) can hide an instruction from the reader of the note.
    if (UNSAFE.test(value) || hasHiddenText(value)) return 'unsafe-content';
    const paths = value.match(PATH_TOKEN) ?? [];
    for (const token of paths) if (!pathExists(token)) return 'not-in-project';
    const withoutFiles = paths.reduce((rest, token) => rest.replace(token, ' '), value);
    for (const token of withoutFiles.match(DIR_TOKEN) ?? []) {
      const dir = clean(token).replace(/\/$/, '');
      if (!directories.has(dir) && !requestWords.has(dir)) return 'not-in-project';
    }
    for (const match of value.matchAll(BACKTICKED)) if (!mentionable(match[1] as string)) return 'not-in-project';
    for (const match of withoutFiles.matchAll(CALL)) {
      const name = match[1] as string;
      if (!GLOBAL_CALLS.has(name) && !mentionable(name)) return 'not-in-project';
    }
    for (const match of withoutFiles.replace(/`[^`]*`/g, ' ').matchAll(IDENTIFIER_LIKE)) {
      const name = match[1] as string;
      if (name.length >= 6 && !mentionable(name)) return 'not-in-project';
    }
    return null;
  };

  const rejections: Rejection[] = [];
  const reject = (text: string, reason: RejectReason): void => {
    rejections.push({ text: text.slice(0, 80), reason });
  };

  const seen = new Set<string>();
  const reuse: VerifiedReuse[] = [];
  for (const entry of parsed.data.reuse) {
    const file = byPath.get(clean(entry.file));
    const sym = file?.symbols.find((s) => s.name === entry.symbol || s.exportName === entry.symbol);
    const why = problem(entry.why);
    if (!file || !sym) {
      reject(`${entry.symbol} in ${entry.file}`, 'not-in-project');
    } else if (why) {
      reject(`${entry.symbol} in ${entry.file}`, why);
    } else if (!seen.has(`${file.path}#${sym.name}`)) {
      seen.add(`${file.path}#${sym.name}`);
      reuse.push({ symbol: sym.name, file: file.path, line: sym.line, exported: sym.exportName !== undefined, why: entry.why });
    }
  }
  const keep = (list: string[]): string[] => {
    const kept: string[] = [];
    for (const item of list) {
      const why = problem(item);
      if (why) reject(item, why);
      else if (!kept.includes(item)) kept.push(item);
    }
    return kept;
  };

  const note: ModelNote = { reuse, assumptions: keep(parsed.data.assumptions), questions: keep(parsed.data.questions) };
  return { ok: true, note, rejected: rejections.map((r) => r.text), rejections };
}

export const isEmptyNote = (note: ModelNote): boolean => note.reuse.length + note.assumptions.length + note.questions.length === 0;

// The note is built here from validated fields, never copied from the reply. Two labelled parts: references that were
// checked against the index, and commentary that is only the model's opinion.
export function renderNote(note: ModelNote): string {
  const lines: string[] = [];
  if (note.reuse.length > 0) {
    lines.push('Verified references (each file and symbol exists in the index):');
    for (const r of note.reuse) lines.push(`- ${r.symbol} in ${r.file}:${r.line}${r.exported ? '' : ' (not exported)'}. Model's reason: ${r.why}`);
  }
  if (note.assumptions.length + note.questions.length > 0) {
    lines.push('Unverified commentary from the model (nothing in it was confirmed against your code):');
    for (const a of note.assumptions) lines.push(`- Assumption to confirm: ${a}`);
    for (const q of note.questions) lines.push(`- Open question: ${q}`);
  }
  return maskSecrets(lines.join('\n')).text;
}

const REASON_TEXT: Record<RejectReason, string> = { 'not-in-project': 'named something that does not exist in this project', 'unsafe-content': 'contained links, commands or instructions' };
export function describeRejections(rejections: Rejection[], provider: string): string {
  const counts = new Map<RejectReason, number>();
  for (const r of rejections) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const parts = [...counts].map(([reason, n]) => `${n} ${REASON_TEXT[reason]}`);
  return `${rejections.length} item(s) from ${provider} were dropped: ${parts.join('; ')}.`;
}
