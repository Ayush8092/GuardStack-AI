import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TS from '@vscode/tree-sitter-wasm';
import { extractJs } from './extract-js.js';
import { extractPython } from './extract-py.js';
import { assessParse, exceedsBudget } from './health.js';
import type { FileInfo, Lang } from './types.js';

const require = createRequire(import.meta.url);
const ts: typeof TS = require('@vscode/tree-sitter-wasm');
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));

const grammar: Record<Lang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};

export type QueryFn = (source: string) => TS.Query;
export type ParseInput = { root: TS.Node; source: string; lang: Lang; path: string; query: QueryFn };

let parser: TS.Parser | undefined;
let booting: Promise<void> | undefined;
const languages = new Map<Lang, TS.Language>();
const queries = new Map<string, TS.Query>();

function boot(): Promise<void> {
  booting ??= ts.Parser.init({ locateFile: (file) => path.join(wasmDir, file) }).then(() => {
    parser = new ts.Parser();
  });
  return booting;
}

export async function loadLanguages(langs: Iterable<Lang>): Promise<void> {
  await boot();
  for (const lang of new Set(langs)) {
    if (!languages.has(lang)) {
      languages.set(lang, await ts.Language.load(fs.readFileSync(path.join(wasmDir, grammar[lang]))));
    }
  }
}

export function parseFile(relPath: string, lang: Lang, source: string): FileInfo | null {
  const language = languages.get(lang);
  if (!parser || !language) throw new Error(`Language ${lang} is not loaded`);

  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) return null;

  const query: QueryFn = (src) => {
    const key = `${lang}:${createHash('sha1').update(src).digest('hex')}`;
    let q = queries.get(key);
    if (!q) {
      q = new ts.Query(language, src);
      queries.set(key, q);
    }
    return q;
  };

  try {
    // A pathologically large or deeply nested tree is not analysed: every pass below walks it, some once per reference up the
    // parent chain. The file is returned as an empty, degraded result, so it counts as partial and is never reported as clean.
    const limit = exceedsBudget(tree.rootNode);
    if (limit) return unanalysed(relPath, lang, source, limit);

    const input: ParseInput = { root: tree.rootNode, source, lang, path: relPath, query };
    const extracted = lang === 'python' ? extractPython(input) : extractJs(input);
    // Tree-sitter always returns a tree, repairing what it cannot parse. The repairs are recorded, never hidden.
    const parse = assessParse(tree.rootNode, lang, source);
    return {
      path: relPath,
      lang,
      bytes: Buffer.byteLength(source),
      lines: source.split('\n').length,
      ...extracted,
      ...(parse ? { parse } : {}),
    };
  } finally {
    tree.delete();
  }
}

function unanalysed(relPath: string, lang: Lang, source: string, limit: 'depth' | 'nodes'): FileInfo {
  return {
    path: relPath,
    lang,
    bytes: Buffer.byteLength(source),
    lines: source.split('\n').length,
    symbols: [],
    imports: [],
    reexports: [],
    unusedImports: [],
    suppressions: [],
    dynamicLoads: [],
    decorated: false,
    script: false,
    parse: { status: 'degraded', errors: 0, missing: 0, lines: [], limit },
  };
}
