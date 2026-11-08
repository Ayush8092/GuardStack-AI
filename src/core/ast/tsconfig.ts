import path from 'node:path';
import { log } from '../../utils/logger.js';
import { errorMessage } from '../../utils/errors.js';
import { readInside } from '../security/sandbox.js';

export const TSCONFIG_NAME = /^(?:tsconfig|jsconfig)(?:\.[\w.-]+)?\.json$/;

export type PathMapping = { pattern: string; targets: string[] };

export type TsConfigInfo = {
  file: string;
  dir: string;
  baseUrl?: string;
  pathsBase: string;
  paths: PathMapping[];
  // Workspace-relative glob patterns. Absent means the TypeScript default of every file under `dir`.
  include?: string[];
  exclude?: string[];
  files?: string[];
  // Workspace-relative tsconfig files named in `references`.
  references: string[];
  outDir?: string;
  rootDir?: string;
  // True when a relative `extends` named a file in the repository that could not be loaded, so inherited options are missing.
  incomplete?: boolean;
};

// Returns the file's text, or null when it does not exist or cannot be read.
export type ConfigReader = (rel: string) => string | null;

type Resolved = {
  baseUrl?: string;
  paths?: PathMapping[];
  pathsDir?: string;
  include?: string[];
  exclude?: string[];
  files?: string[];
  outDir?: string;
  rootDir?: string;
  incomplete?: boolean;
};

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_EXTENDS_DEPTH = 8;

export function diskReader(root: string): ConfigReader {
  return (rel) => {
    try {
      return readInside(root, rel, MAX_CONFIG_BYTES).toString('utf8');
    } catch {
      return null;
    }
  };
}

function isTrailingComma(src: string, index: number): boolean {
  const closing = /\s*[}\]]/y;
  closing.lastIndex = index + 1;
  return closing.test(src);
}

export function parseJsonc(input: string): unknown {
  const src = input.replace(/^\uFEFF/, '');
  let stripped = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      stripped += src.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      stripped += ch;
      i++;
    }
  }

  let clean = '';
  i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < stripped.length && stripped[j] !== '"') j += stripped[j] === '\\' ? 2 : 1;
      clean += stripped.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ',' && isTrailingComma(stripped, i)) {
      i++;
    } else {
      clean += ch;
      i++;
    }
  }
  return JSON.parse(clean);
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;

function toWorkspacePath(dir: string, relative: string): string | undefined {
  const joined = path.posix.normalize(path.posix.join(dir || '.', relative));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return undefined;
  return joined === '.' ? '' : joined;
}

const dirOf = (file: string): string => (path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file));

function exportsTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of ['default', 'require', 'import']) {
    const found = exportsTarget(object[key]);
    if (found) return found;
  }
  return undefined;
}

// `extends: "@tsconfig/node20/tsconfig.json"`, `extends: "@acme/tsconfig"` and workspace packages linked into node_modules.
function packageConfig(read: ConfigReader, fromDir: string, spec: string): string | undefined {
  for (let dir = fromDir; ; dir = dirOf(dir)) {
    const base = path.posix.join(dir || '.', 'node_modules', spec);
    const normalized = path.posix.normalize(base);
    const direct = spec.endsWith('.json') ? [normalized] : [`${normalized}.json`, `${normalized}/tsconfig.json`];
    for (const candidate of direct) if (read(candidate) !== null) return candidate;

    const manifest = read(`${normalized}/package.json`);
    if (manifest) {
      try {
        const pkg = asObject(JSON.parse(manifest)) ?? {};
        const exportsMap = asObject(pkg.exports);
        const named = typeof pkg.tsconfig === 'string' ? pkg.tsconfig : exportsTarget(exportsMap ? (exportsMap['.'] ?? exportsMap) : pkg.exports);
        if (named) {
          const resolved = toWorkspacePath(normalized, named);
          if (resolved && read(resolved) !== null) return resolved;
        }
      } catch {
        // an unreadable manifest just means this candidate does not apply
      }
    }
    if (dir === '') return undefined;
  }
}

function parentChain(read: ConfigReader, dir: string, extendsValue: unknown, depth: number, seen: Set<string>): Resolved {
  const entries = (Array.isArray(extendsValue) ? extendsValue : [extendsValue]).filter((v): v is string => typeof v === 'string');
  let merged: Resolved = {};

  for (const entry of entries) {
    let candidates: string[] = [];
    if (entry.startsWith('.')) {
      const base = toWorkspacePath(dir, entry);
      if (base !== undefined) candidates = base.endsWith('.json') ? [base] : [`${base}.json`, `${base}/tsconfig.json`];
    } else {
      const found = packageConfig(read, dir, entry);
      if (found) candidates = [found];
    }
    let found = false;
    for (const candidate of candidates) {
      const loaded = load(read, candidate, depth + 1, seen);
      if (loaded) {
        merged = { ...merged, ...loaded };
        found = true;
        break;
      }
    }
    // A package-based extends lives in node_modules, which a checkout may not have; a relative one is part of the repository.
    if (!found && entry.startsWith('.')) merged.incomplete = true;
  }
  return merged;
}

function load(read: ConfigReader, file: string, depth: number, seen: Set<string>): (Resolved & { references: string[] }) | null {
  if (depth > MAX_EXTENDS_DEPTH || seen.has(file)) return null;

  const content = read(file);
  if (content === null) return null;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asObject(parseJsonc(content));
  } catch (err) {
    log.debug(`Ignoring ${file}: ${errorMessage(err)}`);
    return null;
  }
  if (!parsed) return null;

  const dir = dirOf(file);
  const inherited = parentChain(read, dir, parsed.extends, depth, new Set([...seen, file]));
  const options = asObject(parsed.compilerOptions) ?? {};
  const result: Resolved = { ...inherited };

  if (typeof options.baseUrl === 'string') {
    const resolved = toWorkspacePath(dir, options.baseUrl);
    if (resolved !== undefined) result.baseUrl = resolved;
  }
  for (const key of ['outDir', 'rootDir'] as const) {
    const value = options[key];
    if (typeof value === 'string') {
      const resolved = toWorkspacePath(dir, value);
      if (resolved !== undefined) result[key] = resolved;
    }
  }

  const rawPaths = asObject(options.paths);
  if (rawPaths) {
    result.paths = Object.entries(rawPaths)
      .map(([pattern, targets]) => ({ pattern, targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : [] }))
      .filter((mapping) => mapping.targets.length > 0);
    result.pathsDir = dir;
  }

  // include, exclude and files are inherited, and patterns stay relative to the config that wrote them.
  for (const key of ['include', 'exclude', 'files'] as const) {
    const own = strings(parsed[key]);
    if (own) result[key] = own.map((p) => toWorkspacePath(dir, p)).filter((p): p is string => p !== undefined);
  }

  const references = (Array.isArray(parsed.references) ? parsed.references : [])
    .map((ref) => asObject(ref)?.path)
    .filter((p): p is string => typeof p === 'string')
    .map((p) => toWorkspacePath(dir, p))
    .filter((p): p is string => p !== undefined)
    .map((p) => (p.endsWith('.json') ? p : p ? `${p}/tsconfig.json` : 'tsconfig.json'));

  return { ...result, references };
}

export function loadTsConfigs(source: string | ConfigReader, files: string[]): TsConfigInfo[] {
  const read = typeof source === 'string' ? diskReader(source) : source;
  const configs: TsConfigInfo[] = [];
  const done = new Set<string>();
  const queue = [...new Set(files)].sort();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (done.has(file)) continue;
    done.add(file);

    const resolved = load(read, file, 0, new Set());
    if (!resolved) continue;
    const dir = dirOf(file);
    configs.push({
      file,
      dir,
      baseUrl: resolved.baseUrl,
      pathsBase: resolved.baseUrl ?? resolved.pathsDir ?? dir,
      paths: resolved.paths ?? [],
      include: resolved.include,
      exclude: resolved.exclude,
      files: resolved.files,
      references: resolved.references,
      outDir: resolved.outDir,
      rootDir: resolved.rootDir,
      ...(resolved.incomplete ? { incomplete: true } : {}),
    });
    for (const reference of resolved.references) if (!done.has(reference)) queue.push(reference);
  }
  return configs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// TypeScript's include/exclude globs: `*` and `?` stay inside a segment, `**/` spans directories.
// A pattern with no extension and no wildcard names a directory.
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\/+$/, '');
  const hasWildcard = /[*?]/.test(normalized);
  const base = !hasWildcard && !path.posix.extname(normalized) ? `${normalized}/**/*` : normalized;

  let source = '';
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    if (ch === '*' && base[i + 1] === '*') {
      if (base[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

const DEFAULT_EXCLUDE = ['node_modules', 'bower_components', 'jspm_packages'];
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

// Whether a tsconfig's include/exclude/files would put this file in the project.
export function configCovers(config: TsConfigInfo, file: string): boolean {
  const inside = config.dir === '' || file === config.dir || file.startsWith(`${config.dir}/`);
  if (!inside) return false;
  if (!SOURCE_FILE.test(file)) return false;

  const excludes = (config.exclude ?? DEFAULT_EXCLUDE.map((e) => (config.dir ? `${config.dir}/${e}` : e))).map(globToRegExp);
  if (excludes.some((re) => re.test(file))) return false;

  if (config.files?.includes(file)) return true;
  if (config.include) return config.include.map(globToRegExp).some((re) => re.test(file));
  // `files` without `include` means exactly those files; a config with neither covers everything under its directory.
  return config.files === undefined;
}
