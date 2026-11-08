import type { ParseHealth } from './health.js';

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python';

export type SymbolKind = 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'default' | 'reexport';

export type Sym = {
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
  // First sentence of the doc comment or docstring directly above or inside the symbol. Used only for local retrieval.
  doc?: string;
  exportName?: string;
  // Whitespace-normalized text of the body. Equal hashes mean textually identical code.
  bodyHash?: string;
  // Hash of the syntax tree after local names are renamed by position and literals are normalized.
  // Equal hashes mean structurally similar code, which is weaker evidence than textual identity.
  structHash?: string;
  // The declaration contains a syntax error, so its signature and hashes may describe damaged code.
  partial?: true;
};

// 'reexport' edges only carry a dependency; 'dynamic' covers import() and lazy (function-scoped) imports.
export type ImportKind = 'import' | 'reexport' | 'require' | 'dynamic';

export type ImportRef = {
  source: string;
  names: string[];
  line: number;
  kind: ImportKind;
  typeOnly: boolean;
};

// imported '*' with exported '*' is `export * from`; imported '*' with a name is a namespace re-export.
export type ReExport = {
  source: string;
  imported: string;
  exported: string;
};

export type UnusedImport = {
  name: string;
  source: string;
  line: number;
};

export type Suppression = {
  kind: string;
  line: number;
};

// A runtime load whose target is not a plain string literal: import(`./plugins/${name}`), require(name), import.meta.glob(...).
// `prefix` is the literal part known before the first dynamic piece, when there is one.
export type DynamicLoad = {
  line: number;
  kind: 'import' | 'require' | 'glob';
  prefix?: string;
};

export type FileInfo = {
  // Present only when Tree-sitter reported syntax errors or missing tokens in the file.
  parse?: ParseHealth;
  path: string;
  lang: Lang;
  bytes: number;
  lines: number;
  symbols: Sym[];
  imports: ImportRef[];
  reexports: ReExport[];
  unusedImports: UnusedImport[];
  suppressions: Suppression[];
  dynamicLoads: DynamicLoad[];
  // A class carries a decorator (dependency injection, routing and ORM frameworks register such classes by metadata, not by import).
  decorated: boolean;
  // The file runs code when loaded (a top-level call or a __main__ guard), so it may be launched directly rather than imported.
  script: boolean;
};

export type Extracted = Pick<FileInfo, 'symbols' | 'imports' | 'reexports' | 'unusedImports' | 'suppressions' | 'dynamicLoads' | 'decorated' | 'script'>;
