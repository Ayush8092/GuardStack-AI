import { CACHE_LIMITS } from '../../db/schema.js';
import type { FileInfo } from './types.js';

// Structural check of a cached file result, nested records included. The signature on a cached row is what shows it was
// produced by this installation; this check is the second layer, so that a row from an older shape, a bug or a damaged
// database cannot put a wrongly typed value into the analysis. It accepts any extra fields and checks every field the
// analysis reads. It does not decide whether a result is genuine.

// The same bound the cache applies before it verifies a stored result (see CACHE_LIMITS), so a value too large to be stored is too large to be parsed.
const MAX_RAW = CACHE_LIMITS.maxInfoBytes;
const LANGS = new Set(['typescript', 'tsx', 'javascript', 'python']);
const SYMBOL_KINDS = new Set(['function', 'class', 'const', 'type', 'interface', 'enum', 'default', 'reexport']);
const IMPORT_KINDS = new Set(['import', 'reexport', 'require', 'dynamic']);
const DYNAMIC_KINDS = new Set(['import', 'require', 'glob']);
const HEALTH_STATUS = new Set(['recovered', 'degraded']);
const HEALTH_LIMITS = new Set(['depth', 'nodes']);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const list = <T>(v: unknown, each: (item: unknown) => item is T): v is T[] => Array.isArray(v) && v.every(each);

const sym = (v: unknown): v is Rec =>
  isRec(v) && isStr(v.name) && isStr(v.kind) && SYMBOL_KINDS.has(v.kind) && isNum(v.line) && isStr(v.signature) &&
  optStr(v.doc) && optStr(v.exportName) && optStr(v.bodyHash) && optStr(v.structHash) && (v.partial === undefined || v.partial === true);
const importRef = (v: unknown): v is Rec =>
  isRec(v) && isStr(v.source) && list(v.names, isStr) && isNum(v.line) && isStr(v.kind) && IMPORT_KINDS.has(v.kind) && typeof v.typeOnly === 'boolean';
const reexport = (v: unknown): v is Rec => isRec(v) && isStr(v.source) && isStr(v.imported) && isStr(v.exported);
const unusedImport = (v: unknown): v is Rec => isRec(v) && isStr(v.name) && isStr(v.source) && isNum(v.line);
const suppression = (v: unknown): v is Rec => isRec(v) && isStr(v.kind) && isNum(v.line);
const dynamicLoad = (v: unknown): v is Rec => isRec(v) && isNum(v.line) && isStr(v.kind) && DYNAMIC_KINDS.has(v.kind) && optStr(v.prefix);
const health = (v: unknown): boolean =>
  v === undefined || (isRec(v) && isStr(v.status) && HEALTH_STATUS.has(v.status) && isNum(v.errors) && isNum(v.missing) && list(v.lines, (n): n is number => isNum(n)) && (v.limit === undefined || (isStr(v.limit) && HEALTH_LIMITS.has(v.limit))));

// `expectedPath`, when given, must be the path the result claims to describe.
export function parseCachedInfo(raw: unknown, expectedPath?: string): FileInfo | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW || Buffer.byteLength(raw) > MAX_RAW) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRec(value)) return null;
  const ok =
    isStr(value.path) && (expectedPath === undefined || value.path === expectedPath) &&
    isStr(value.lang) && LANGS.has(value.lang) && isNum(value.bytes) && isNum(value.lines) &&
    list(value.symbols, sym) && list(value.imports, importRef) && list(value.reexports, reexport) &&
    list(value.unusedImports, unusedImport) && list(value.suppressions, suppression) && list(value.dynamicLoads, dynamicLoad) &&
    typeof value.decorated === 'boolean' && typeof value.script === 'boolean' && health(value.parse);
  return ok ? (value as unknown as FileInfo) : null;
}
