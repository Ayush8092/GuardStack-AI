import { builtinModules } from 'node:module';
import path from 'node:path';
import { compareText } from '../../utils/text.js';
import { packageEntries, packageEntry, publicTargets, resolveMap, type PackageInfo } from './packages.js';
import { configCovers, type TsConfigInfo } from './tsconfig.js';
import type { FileInfo, ImportRef } from './types.js';

export type Target = { file: string; names: string[] };
// 'unsupported' means the specifier uses a resolution mechanism this tool does not model (a bundler alias, a built package
// whose source cannot be located): the import is not claimed to be broken.
export type UnresolvedReason = 'not-found' | 'ambiguous' | 'not-indexed' | 'unsupported';
export type Unresolved = { spec: string; reason: UnresolvedReason; candidates: string[] };
export type Resolution = { targets: Target[]; unresolved?: Unresolved };

export type ResolverOptions = {
  files: Iterable<string>;
  // Every eligible source path, including ones left out of the index by maxFiles.
  known?: Iterable<string>;
  tsconfigs: TsConfigInfo[];
  pythonRoots: string[];
  packages?: PackageInfo[];
};

type Hit = { file: string; indexed: boolean };

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_FOR_JS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const ASSET_EXT =
  /\.(?:css|scss|sass|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|md|mdx|html?|txt|wasm|node|graphql|gql|ya?ml|toml|csv|vue|svelte|astro|mp[34]|webm|pdf)$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/.*)?$/i;
const NONE: Resolution = { targets: [] };
// A missing target under a build directory or any hidden tool directory (.next, .source, .nuxt, .svelte-kit, ...) is generated output.
// Python standard library module names (3.12). A name from this list is external even when a directory of the same name
// exists in the project, such as tests/typing/.
const PYTHON_STDLIB = new Set(
  'abc aifc antigravity argparse array ast asyncio atexit audioop base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo'.split(' '),
);

const BUILD_OUTPUT = /(^|\/)(?:dist|build|out|\.(?!\.?(?:\/|$))[\w-]+)(\/|$)/;
const ALIAS_LIKE = /^(?:[@~$#]{1,2}(?:\/|$)|\$[a-z])/i;

const dirOf = (p: string): string => {
  const dir = path.posix.dirname(p);
  return dir === '.' ? '' : dir;
};

function joinPath(base: string, relative: string): string | null {
  // A trailing slash ('./lib/', '../../') names the directory itself; keep it out of the path so index lookups work.
  const joined = path.posix.normalize(path.posix.join(base || '.', relative)).replace(/\/+$/, '');
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined === '.' || joined === '' ? '' : joined;
}

function matchPattern(pattern: string, spec: string): { capture: string; score: number } | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === spec ? { capture: '', score: pattern.length + 1 } : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return { capture: spec.slice(prefix.length, spec.length - suffix.length), score: prefix.length };
}

const isRelative = (spec: string): boolean => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

const isHit = (hit: Hit | null): hit is Hit => hit !== null;

function distinctHits(hits: Hit[]): Hit[] {
  return [...new Map(hits.map((h) => [h.file, h])).values()].sort((a, b) => compareText(a.file, b.file));
}

export type Resolver = ((from: FileInfo, imp: ImportRef) => Resolution) & { publicEntries: () => string[] };

export function createResolver(options: ResolverOptions): Resolver {
  const indexed = new Set(options.files);
  const known = new Set([...(options.known ?? []), ...indexed]);
  const dirs = new Set<string>(['']);
  for (const file of known) {
    for (let dir = dirOf(file); dir && !dirs.has(dir); dir = dirOf(dir)) dirs.add(dir);
  }

  const configsByDir = new Map<string, TsConfigInfo[]>();
  for (const config of options.tsconfigs) configsByDir.set(config.dir, [...(configsByDir.get(config.dir) ?? []), config]);

  const pythonRoots = [...new Set(options.pythonRoots.map((r) => joinPath('', r) ?? ''))];

  // The tsconfigs whose include/exclude actually cover this file, deepest directory first. When none claims the file
  // (a config without an include that excludes it, a solution-style root) fall back to the nearest directory's configs.
  const configsFor = (file: string): TsConfigInfo[] => {
    const ancestors: string[] = [];
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      ancestors.push(dir);
      if (dir === '') break;
    }
    for (const dir of ancestors) {
      const covering = (configsByDir.get(dir) ?? []).filter((c) => configCovers(c, file));
      if (covering.length > 0) return covering;
    }
    for (const dir of ancestors) {
      const found = configsByDir.get(dir);
      if (found) return found;
    }
    return [];
  };

  const packages = options.packages ?? [];
  const named = new Map<string, PackageInfo>();
  for (const pkg of packages) if (pkg.name && !named.has(pkg.name)) named.set(pkg.name, pkg);
  const packageFor = (file: string): PackageInfo | undefined => {
    let best: PackageInfo | undefined;
    for (const pkg of packages) {
      if ((pkg.dir === '' || file.startsWith(`${pkg.dir}/`)) && (!best || pkg.dir.length > best.dir.length)) best = pkg;
    }
    return best;
  };

  const lookup = (p: string): Hit | null => (indexed.has(p) ? { file: p, indexed: true } : known.has(p) ? { file: p, indexed: false } : null);

  const firstHit = (candidates: string[]): Hit | null => {
    for (const candidate of candidates) {
      const hit = lookup(candidate);
      if (hit) return hit;
    }
    return null;
  };

  function unresolved(spec: string, reason: Unresolved['reason'], candidates: string[] = []): Resolution {
    return { targets: [], unresolved: { spec, reason, candidates } };
  }

  function settle(hits: Hit[], spec: string, names: string[]): Resolution {
    const distinct = distinctHits(hits);
    if (distinct.length === 0) return unresolved(spec, 'not-found');
    if (distinct.length > 1) return unresolved(spec, 'ambiguous', distinct.map((h) => h.file));
    const [hit] = distinct;
    return hit.indexed ? { targets: [{ file: hit.file, names }] } : unresolved(spec, 'not-indexed', [hit.file]);
  }

  function probeJs(base: string | null): Hit | null {
    if (base === null) return null;
    const ext = path.posix.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const prefix = base ? `${base}/` : '';
    const candidates = [
      ...(TS_FOR_JS[ext] ?? []).map((e) => stem + e),
      ...(SOURCE_EXTS.includes(ext) ? [base] : []),
      ...SOURCE_EXTS.map((e) => base + e),
      ...SOURCE_EXTS.map((e) => `${prefix}index${e}`),
    ];
    return firstHit(candidates);
  }

  function viaConfig(config: TsConfigInfo, spec: string): { matched: boolean; hit: Hit | null; generated: boolean } {
    let best: { targets: string[]; capture: string; score: number } | null = null;
    for (const mapping of config.paths) {
      const match = matchPattern(mapping.pattern, spec);
      if (match && (!best || match.score > best.score)) best = { targets: mapping.targets, ...match };
    }

    const matched = best !== null;
    // A target inside a build or hidden tool directory that is not in the repository (dist/, .source/) is generated output.
    let generated = false;
    for (const target of best?.targets ?? []) {
      const path = joinPath(config.pathsBase, target.replace('*', best?.capture ?? ''));
      const hit = probeJs(path);
      if (hit) return { matched, hit, generated: false };
      if (path !== null && BUILD_OUTPUT.test(path)) generated = true;
    }
    if (config.baseUrl !== undefined) {
      const hit = probeJs(joinPath(config.baseUrl, spec));
      if (hit) return { matched, hit, generated: false };
    }
    return { matched, hit: null, generated };
  }

  function resolveJs(from: FileInfo, imp: ImportRef): Resolution {
    const spec = imp.source.replace(/(?!^)[?#].*$/, '');
    if (!spec || ASSET_EXT.test(spec) || spec.startsWith('node:')) return NONE;

    if (isRelative(spec)) return resolveRelative(from, imp, spec);
    if (spec.startsWith('/')) return NONE;

    const results = configsFor(from.path).map((config) => viaConfig(config, spec));
    const hits = results.map((r) => r.hit).filter(isHit);
    if (hits.length > 0) return settle(hits, imp.source, imp.names);
    if (results.some((r) => r.matched)) return unresolved(imp.source, results.some((r) => r.generated) ? 'unsupported' : 'not-found');

    if (spec.startsWith('#')) return viaImportsField(from, imp, spec);

    const workspace = viaWorkspacePackage(from, imp, spec);
    if (workspace) return workspace;

    const framework = viaFrameworkAlias(from, imp, spec);
    if (framework) return framework;

    const [top] = spec.split('/');
    if (PACKAGE_NAME.test(spec) || builtinModules.includes(top)) return NONE;
    // `@/x`, `~/x`, `$lib/x`: an alias that only a bundler config could define.
    return ALIAS_LIKE.test(spec) ? unresolved(imp.source, 'unsupported') : unresolved(imp.source, 'not-found');
  }

  // `require('../..')` or `import './lib'` where the directory is a package: its main/exports wins over a guessed index file.
  function resolveRelative(from: FileInfo, imp: ImportRef, spec: string): Resolution {
    const base = joinPath(dirOf(from.path), spec);
    const direct = probeJs(base);
    if (direct) return settle([direct], imp.source, imp.names);

    const pkg = base === null ? undefined : packages.find((p) => p.dir === base);
    const entry = pkg ? packageEntry(pkg, '.') : undefined;
    const viaPackage = pkg && entry ? probePackageTarget(pkg, entry) : null;
    if (viaPackage) return settle([viaPackage], imp.source, imp.names);

    // Pointing into a build directory that is not in the repository (dist/, build/) says nothing about the source being broken.
    if (base !== null && BUILD_OUTPUT.test(base)) return unresolved(imp.source, 'unsupported');
    return settle([], imp.source, imp.names);
  }

  // Maps a package-relative target (often a built dist file) back to the places its source could be.
  function candidateBases(pkg: PackageInfo, target: string): string[] {
    const direct = joinPath(pkg.dir, target.replace(/\.d\.([cm]?)ts$/, '.$1ts'));
    if (direct === null) return [];
    const bases = [direct];
    const config = configsFor(`${pkg.dir ? `${pkg.dir}/` : ''}x.ts`).find((c) => c.outDir !== undefined);
    if (config?.outDir !== undefined && (direct === config.outDir || direct.startsWith(`${config.outDir}/`))) {
      const mapped = joinPath(config.rootDir ?? (config.dir ? `${config.dir}/src` : 'src'), direct.slice(config.outDir.length + 1));
      if (mapped !== null) bases.push(mapped);
    }
    const relative = direct.slice(pkg.dir ? pkg.dir.length + 1 : 0);
    const swapped = relative.replace(/^(?:dist|build|lib|out|esm|cjs|types)\//, 'src/');
    if (swapped !== relative) {
      const base = joinPath(pkg.dir, swapped);
      if (base !== null) bases.push(base);
    }
    return bases;
  }

  function probePackageTarget(pkg: PackageInfo, target: string): Hit | null {
    for (const base of candidateBases(pkg, target)) {
      const hit = probeJs(base);
      if (hit) return hit;
    }
    return null;
  }

  function viaWorkspacePackage(from: FileInfo, imp: ImportRef, spec: string): Resolution | null {
    const segments = spec.split('/');
    const nameLength = spec.startsWith('@') ? 2 : 1;
    const name = segments.slice(0, nameLength).join('/');
    const pkg = named.get(name);
    if (!pkg) return null;
    const rest = segments.slice(nameLength).join('/');
    const subpath = rest ? `./${rest}` : '.';
    // A package that exists in this workspace but whose entry we cannot map to source is not claimed to be broken.
    for (const target of packageEntries(pkg, subpath)) {
      const hit = probePackageTarget(pkg, target);
      if (hit) return settle([hit], imp.source, imp.names);
    }
    return unresolved(imp.source, 'unsupported', [from.path]);
  }

  function viaImportsField(from: FileInfo, imp: ImportRef, spec: string): Resolution {
    const pkg = packageFor(from.path);
    if (!pkg) return unresolved(imp.source, 'unsupported');
    if (!pkg.imports) return unresolved(imp.source, 'not-found');
    const target = resolveMap(pkg.imports, spec);
    if (!target) return unresolved(imp.source, 'not-found');
    if (!target.startsWith('.')) return NONE;
    const hit = probePackageTarget(pkg, target);
    return hit ? settle([hit], imp.source, imp.names) : unresolved(imp.source, 'unsupported');
  }

  function viaFrameworkAlias(from: FileInfo, imp: ImportRef, spec: string): Resolution | null {
    const pkg = packageFor(from.path);
    const frameworks = pkg?.frameworks ?? [];
    const root = pkg?.dir ?? '';
    const rules: [RegExp, string[]][] = [];
    if (frameworks.includes('sveltekit')) rules.push([/^\$lib(?:\/|$)/, [joinPath(root, 'src/lib') ?? 'src/lib']]);
    if (frameworks.includes('nuxt')) {
      const app = known.has(`${root ? `${root}/` : ''}app`) || dirs.has(root ? `${root}/app` : 'app') ? 'app' : '';
      rules.push([/^[~@](?:\/|$)/, [joinPath(root, app) ?? root]], [/^(?:~~|@@)(?:\/|$)/, [root]]);
    }
    for (const [pattern, [base]] of rules) {
      if (!pattern.test(spec)) continue;
      const rest = spec.replace(/^(?:\$lib|~~|@@|[~@])\/?/, '');
      const hit = probeJs(joinPath(base, rest));
      return hit ? settle([hit], imp.source, imp.names) : unresolved(imp.source, 'not-found');
    }
    // SvelteKit and Nuxt also expose virtual modules ($app/*, #imports) that are not files.
    if ((frameworks.includes('sveltekit') && /^\$(?:app|env)\//.test(spec)) || (frameworks.includes('nuxt') && /^#(?:imports|app|build)/.test(spec))) return NONE;
    return null;
  }

  function modulePath(base: string, segments: string[]): Hit | null {
    const joined = [base, ...segments].filter(Boolean).join('/');
    if (segments.length === 0) return lookup(joined ? `${joined}/__init__.py` : '__init__.py');
    return firstHit([`${joined}.py`, `${joined}/__init__.py`]);
  }

  function isLocalTopLevel(first: string, bases: string[]): boolean {
    return bases.some((base) => {
      const candidate = base ? `${base}/${first}` : first;
      return known.has(`${candidate}.py`) || dirs.has(candidate);
    });
  }

  function resolvePython(from: FileInfo, imp: ImportRef): Resolution {
    const dots = /^\.*/.exec(imp.source)?.[0].length ?? 0;
    const segments = imp.source.slice(dots).split('.').filter(Boolean);
    const submodules = imp.names.filter((n) => n !== '*');

    const attempt = (base: string): { module: Hit | null; subs: Map<string, Hit> } => {
      const subs = new Map<string, Hit>();
      for (const name of submodules) {
        const hit = modulePath(base, [...segments, name]);
        if (hit) subs.set(name, hit);
      }
      return { module: modulePath(base, segments), subs };
    };

    const settleTier = (bases: string[]): Resolution | null => {
      const attempts = bases.map(attempt);
      const modules = distinctHits(attempts.map((a) => a.module).filter(isHit));
      const bySub = new Map<string, Hit[]>();
      for (const found of attempts) {
        for (const [name, hit] of found.subs) bySub.set(name, [...(bySub.get(name) ?? []), hit]);
      }
      if (modules.length === 0 && bySub.size === 0) return null;

      const conflicting = modules.length > 1 ? modules : [...bySub.values()].map(distinctHits).find((hits) => hits.length > 1);
      if (conflicting) return unresolved(imp.source, 'ambiguous', conflicting.map((h) => h.file));

      const targets: Target[] = [];
      const [module] = modules;
      // `from . import types` / `from pkg import sub` where every name is a submodule loads those submodules; the package's
      // own __init__ is only implied (a child always follows its parent), so it is not an edge, and it cannot form a cycle.
      const onlySubmodules = submodules.length > 0 && submodules.length === imp.names.length && submodules.every((n) => bySub.has(n));
      if (module?.indexed && !(onlySubmodules && module.file.endsWith('/__init__.py') || onlySubmodules && module.file === '__init__.py')) targets.push({ file: module.file, names: imp.names });
      for (const hits of bySub.values()) {
        const [hit] = distinctHits(hits);
        if (hit?.indexed) targets.push({ file: hit.file, names: ['*'] });
      }
      return targets.length > 0 ? { targets } : unresolved(imp.source, 'not-indexed');
    };

    const fromDir = dirOf(from.path);
    if (dots > 0) {
      let base = fromDir;
      const depth = base ? base.split('/').length : 0;
      if (dots - 1 > depth) return unresolved(imp.source, 'not-found');
      for (let i = 1; i < dots; i++) base = dirOf(base);
      return settleTier([base]) ?? unresolved(imp.source, 'not-found');
    }

    const found = settleTier(pythonRoots) ?? settleTier([fromDir]);
    if (found) return found;
    if (segments.length === 0) return NONE;
    if (PYTHON_STDLIB.has(segments[0] as string)) return NONE;
    if (!isLocalTopLevel(segments[0] as string, [...pythonRoots, fromDir])) return NONE;
    // pkg.mod.attr where pkg/mod.py is a plain module: Python only allows that when the module registers the name in
    // sys.modules at run time (requests.packages does), which static analysis cannot see.
    for (let k = segments.length - 1; k >= 1; k--) {
      const prefix = segments.slice(0, k).join('/');
      for (const base of [...pythonRoots, fromDir]) {
        const candidate = base ? `${base}/${prefix}` : prefix;
        if (known.has(`${candidate}.py`) && !dirs.has(candidate)) return unresolved(imp.source, 'unsupported');
      }
    }
    return unresolved(imp.source, 'not-found');
  }

  // Source files a package exposes to the outside (exports, main, module, types, bin). Their exports are API, not dead code.
  function publicEntries(): string[] {
    const found = new Set<string>();
    for (const pkg of packages) {
      for (const target of publicTargets(pkg)) {
        if (target.includes('*')) {
          const prefix = target.slice(0, target.indexOf('*'));
          for (const base of candidateBases(pkg, prefix)) for (const file of indexed) if (file.startsWith(base)) found.add(file);
        } else if (target.endsWith('.py')) {
          // A pyproject.toml console script: the module file itself, no extension probing.
          const file = joinPath(pkg.dir, target);
          if (file !== null && indexed.has(file)) found.add(file);
        } else {
          const hit = probePackageTarget(pkg, target);
          if (hit?.indexed) found.add(hit.file);
        }
      }
    }
    return [...found].sort(compareText);
  }

  const resolve = (from: FileInfo, imp: ImportRef): Resolution => {
    if (!imp.source) return NONE;
    return from.lang === 'python' ? resolvePython(from, imp) : resolveJs(from, imp);
  };
  return Object.assign(resolve, { publicEntries });
}
