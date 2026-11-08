import path from 'node:path';
import ignore from 'ignore';
import type { Config } from '../../utils/config.js';
import { compareText } from '../../utils/text.js';
import { findCycles, type Cycle } from './graph.js';
import { describeHealth } from './health.js';
import type { Project } from './indexer.js';
import type { PackageInfo } from './packages.js';
import { createResolver, type Unresolved } from './resolver.js';
import type { TsConfigInfo } from './tsconfig.js';
import { PROFILE_ENTRIES, REMEDIATION, type Classification, type Confidence, type Method, type Profile, type Rule, type Severity } from './rules.js';
import type { FileInfo, Lang } from './types.js';

export type { Rule, Severity, Confidence, Method, Classification } from './rules.js';

export type Finding = {
  rule: Rule;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  // Stable identity across edits (no line numbers), and how many occurrences it stands for.
  key: string;
  count: number;
  // How sure the tool is, derived from how the finding was detected and whether the scan saw every file.
  confidence: Confidence;
  // What was actually compared or inspected. Never implies more than that (text matching is not semantic matching).
  method: Method;
  // The facts the finding rests on, short enough to read at a glance.
  evidence: string[];
  remediation: string;
  // Only for orphan-file and dead-export: how far "unused" can be trusted.
  classification?: Classification;
};

export type Graph = {
  nodes: { id: string; lang: Lang; lines: number; exports: number; importedBy: number; orphan: boolean; inCycle: boolean }[];
  // runtime is false when every import between the pair is type-only or lazy.
  links: { source: string; target: string; runtime: boolean }[];
};

export type UnresolvedImport = Unresolved & { file: string; line: number };

// `unsupported` lists imports the resolver cannot judge (bundler aliases, unmapped built packages); they are not findings.
export type Analysis = { graph: Graph; findings: Finding[]; cycles: Cycle[]; unresolved: UnresolvedImport[]; unsupported: UnresolvedImport[] };

export type AnalyzeOptions = {
  // Maps a path to the identity used in finding keys. A baseline passes renames here so that a file which was only
  // moved keeps the identity of its findings and the move is not read as new or fixed problems.
  identify?: (path: string) => string;
  tsconfigs?: TsConfigInfo[];
  packages?: PackageInfo[];
  foreignExtensions?: string[];
  pythonRoots?: string[];
  known?: Iterable<string>;
  complete?: boolean;
  // Entry points, severities and exceptions from .guardianrc (the historical one when analysing a baseline).
  config?: Partial<Pick<Config, 'profile' | 'entryPoints' | 'rules' | 'exceptions'>>;
};

const TEST_FILE =
  /(^|\/)(__tests__|tests?|e2e)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;
const ENTRY_FILE =
  /(^|\/)(?:index|main|cli|app|server|manage|setup|wsgi|asgi|__init__|__main__)\.[a-z]+$|\.config\.[cm]?[jt]s$|(^|\/)(?:bin|scripts|migrations)\//;
const FRAMEWORK_FILE =
  /(^|\/)(?:page|layout|route|loading|error|not-found|template|middleware|instrumentation|_app|_document)\.[cm]?[jt]sx?$/;

const GENERIC_NAMES = new Set([
  'default', 'main', 'handler', 'init', 'setup', 'run', 'index', 'app', 'config', 'loader', 'action', 'meta',
  'links', 'middleware', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

export const isTest = (p: string): boolean => TEST_FILE.test(p);
// Files written by a generator: reporting style problems in them is noise the developer cannot act on.
const GENERATED_FILE = /\.(?:gen|generated)\.[cm]?[jt]sx?$|(^|\/)__generated__\//;
const conventionalEntry = (p: string): boolean => ENTRY_FILE.test(p) || FRAMEWORK_FILE.test(p);
// Directories whose contents frameworks and plugin systems load by convention rather than by import.
const RUNTIME_DIR = /(^|\/)(?:plugins?|adapters?|handlers?|commands?|jobs?|workers?|listeners?|subscribers?|providers?|migrations?|seeds?|strategies|drivers?|loaders?|extensions?|middlewares?|controllers?|resolvers?|modules?)\//i;

type Located = { file: string; line: number; name: string; exported: boolean; body?: string };
type Edge = { runtime: boolean };

function suppressionSeverity(kind: string): Severity {
  if (kind === '@ts-nocheck') return 'high';
  return kind === 'any' ? 'low' : 'medium';
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export function analyze(files: FileInfo[], options: AnalyzeOptions = {}): Analysis {
  // A file Tree-sitter had to repair may have lost imports or declarations, so "nothing imports this" cannot be proven
  // while one exists, and a use of a name inside its damaged region may be missed.
  const damaged = new Set(files.filter((f) => f.parse).map((f) => f.path));
  const degraded = files.filter((f) => f.parse?.status === 'degraded');
  const complete = (options.complete ?? true) && damaged.size === 0;
  const id = options.identify ?? ((p: string): string => p);
  const resolve = createResolver({
    files: files.map((f) => f.path),
    known: options.known,
    tsconfigs: options.tsconfigs ?? [],
    packages: options.packages ?? [],
    pythonRoots: options.pythonRoots ?? ['', 'src'],
  });

  const settings = options.config ?? {};
  const frameworks = new Set((options.packages ?? []).flatMap((p) => p.frameworks));
  const profile: Profile = settings.profile ?? 'auto';
  const profilePatterns =
    profile === 'none' ? [] : profile === 'auto' ? [...frameworks].flatMap((f) => PROFILE_ENTRIES[f as keyof typeof PROFILE_ENTRIES] ?? []) : PROFILE_ENTRIES[profile];
  const entryMatcher = ignore().add([...profilePatterns, ...(settings.entryPoints ?? [])]);
  const publicEntries = new Set(resolve.publicEntries());
  const isEntry = (p: string): boolean => (profile !== 'none' && conventionalEntry(p)) || entryMatcher.ignores(p) || publicEntries.has(p);
  const profileLabel = profile === 'auto' ? (frameworks.size > 0 ? `auto: ${[...frameworks].join(', ')}` : 'auto') : profile;

  const edges = new Map<string, Edge>();
  const importedBy = new Map<string, Set<string>>();
  const used = new Map<string, Set<string>>();
  const forwards = new Map<string, { target: string; imported: string; exported: string }[]>();
  const unresolved: UnresolvedImport[] = [];
  const seenUnresolved = new Set<string>();

  const addUse = (file: string, name: string): void => {
    const names = used.get(file) ?? new Set<string>();
    names.add(name);
    used.set(file, names);
  };

  // A name used through a barrel is a use of the module that really defines it.
  const markUsed = (file: string, name: string, seen: Set<string>): void => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    addUse(file, name);

    for (const forward of forwards.get(file) ?? []) {
      if (name === '*') markUsed(forward.target, forward.imported, seen);
      else if (forward.exported === name) markUsed(forward.target, forward.imported, seen);
      else if (forward.exported === '*' && name !== 'default') markUsed(forward.target, name, seen);
    }
  };

  const consumed: { file: string; name: string }[] = [];
  const selfImports = new Set<string>();

  for (const file of files) {
    for (const imp of file.imports) {
      const resolution = resolve(file, imp);

      if (resolution.unresolved) {
        const key = `${file.path}\0${imp.source}`;
        if (!seenUnresolved.has(key)) {
          seenUnresolved.add(key);
          unresolved.push({ ...resolution.unresolved, file: file.path, line: imp.line });
        }
      }

      for (const hit of resolution.targets) {
        const runtime = imp.kind !== 'dynamic' && !imp.typeOnly;
        if (hit.file === file.path) {
          // A self-import is never a use by another file, but it is a one-file cycle when it runs at load time.
          // `from . import x` inside a package's __init__.py loads submodules, it does not import the file itself.
          const bareRelativePython = file.lang === 'python' && /^\.*$/.test(imp.source);
          if (runtime && !bareRelativePython) selfImports.add(file.path);
          continue;
        }
        const edgeKey = `${file.path}\0${hit.file}`;
        const edge = edges.get(edgeKey);
        if (edge) edge.runtime = edge.runtime || runtime;
        else edges.set(edgeKey, { runtime });

        const importers = importedBy.get(hit.file) ?? new Set<string>();
        importers.add(file.path);
        importedBy.set(hit.file, importers);

        if (imp.kind !== 'reexport') for (const name of hit.names) consumed.push({ file: hit.file, name });
        // `const User = require('./user'); User.all()` records the members read (all), but what was required is the value the
        // module assigned to module.exports: its default export. Using any member of it uses the export itself.
        if (imp.kind === 'require' && file.lang !== 'python' && hit.names.length > 0 && !hit.names.includes('default')) consumed.push({ file: hit.file, name: 'default' });
      }
    }

    for (const reexport of file.reexports) {
      const resolution = resolve(file, { source: reexport.source, names: [reexport.imported], line: 0, kind: 'reexport', typeOnly: false });
      for (const hit of resolution.targets) {
        if (hit.file !== file.path) push(forwards, file.path, { target: hit.file, imported: reexport.imported, exported: reexport.exported });
      }
    }
  }

  for (const { file, name } of consumed) markUsed(file, name, new Set());
  // A real entry point (nothing imports it) exposes everything it re-exports. An imported barrel is tracked name by name.
  for (const file of files) if (isEntry(file.path) && !importedBy.has(file.path)) markUsed(file.path, '*', new Set());

  const links: Graph['links'] = [...edges]
    .map(([key, edge]) => {
      const [source, target] = key.split('\0');
      return { source, target, runtime: edge.runtime };
    })
    .sort((a, b) => compareText(a.source, b.source) || compareText(a.target, b.target));

  const runtimeAdjacency = new Map<string, string[]>();
  for (const link of links) if (link.runtime) push(runtimeAdjacency, link.source, link.target);
  for (const file of selfImports) push(runtimeAdjacency, file, file);
  const cycles = findCycles(files.map((f) => f.path), runtimeAdjacency);
  const inCycle = new Set(cycles.flatMap((c) => c.modules));

  const orphans = new Set(files.filter((f) => !importedBy.has(f.path) && !isTest(f.path) && !isEntry(f.path)).map((f) => f.path));

  const graph: Graph = {
    nodes: files.map((f) => ({
      id: f.path,
      lang: f.lang,
      lines: f.lines,
      exports: f.symbols.filter((s) => s.exportName).length,
      importedBy: importedBy.get(f.path)?.size ?? 0,
      orphan: orphans.has(f.path),
      inCycle: inCycle.has(f.path),
    })),
    links,
  };

  const findings: Finding[] = [];
  type Draft = Omit<Finding, 'count' | 'confidence' | 'remediation'> & { count?: number; confidence: Confidence; remediation?: string };
  const add = (draft: Draft): void => {
    findings.push({ count: 1, remediation: REMEDIATION[draft.rule], ...draft });
  };

  // ---- is this file reachable some way other than an import?
  const loaders = files.filter((f) => f.dynamicLoads.length > 0);
  const reachedByDynamicLoad = (file: string): string | undefined => {
    for (const loader of loaders) {
      const dir = path.posix.dirname(loader.path) === '.' ? '' : path.posix.dirname(loader.path);
      for (const load of loader.dynamicLoads) {
        if (load.prefix) {
          if (!load.prefix.startsWith('.')) continue;
          const base = path.posix.normalize(path.posix.join(dir || '.', load.prefix));
          if (file.startsWith(base)) return `${loader.path}:${load.line} loads modules from ${load.prefix} at run time`;
        } else if (dir ? file.startsWith(`${dir}/`) : !file.includes('/')) {
          return `${loader.path}:${load.line} loads a computed ${load.kind} path, which could reach this file`;
        }
      }
    }
    return undefined;
  };
  const unsupportedAliases = unresolved
    .filter((u) => u.reason === 'unsupported')
    .map((u) => ({ spec: u.spec, tail: u.spec.replace(/^[@~$#]+\/?/, '').replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '') }))
    .filter((u) => u.tail.length > 0);
  const viaUnsupportedAlias = (file: string): string | undefined => {
    const stem = file.replace(/\.[^.]+$/, '').replace(/\/index$/, '');
    return unsupportedAliases.find((u) => stem === u.tail || stem.endsWith(`/${u.tail}`))?.spec;
  };

  const foreign = options.foreignExtensions ?? [];
  const signalsFor = (f: FileInfo, forFile: boolean): string[] => {
    const signals: string[] = [];
    const dynamic = reachedByDynamicLoad(f.path);
    if (dynamic) signals.push(dynamic);
    const alias = viaUnsupportedAlias(f.path);
    if (alias) signals.push(`'${alias}' is imported through an alias this tool cannot resolve`);
    if (foreign.length > 0) signals.push(`the workspace has ${foreign.join(', ')} files, which are not analysed and may import it`);
    if (RUNTIME_DIR.test(f.path)) signals.push('is in a directory that frameworks and plugin systems load by convention');
    if (f.decorated) signals.push('declares a decorated class, which frameworks often register without an import');
    if (forFile && f.script) signals.push('runs code when loaded, so it may be launched directly');
    else if (forFile && !f.symbols.some((s) => s.exportName)) signals.push('exports nothing, so it may exist only for its side effects');
    return signals;
  };
  const classify = (signals: string[]): Classification => (!complete ? 'unreferenced' : signals.length > 0 ? 'potentially-unused' : 'confidently-unused');
  const orphanConfidence: Record<Classification, Confidence> = { 'confidently-unused': 'high', 'potentially-unused': 'medium', unreferenced: 'low' };
  const exportConfidence: Record<Classification, Confidence> = { 'confidently-unused': 'medium', 'potentially-unused': 'low', unreferenced: 'low' };
  // Which files are damaged and how, in path order, so the reason for a lowered confidence is in the evidence and not only the
  // fact that it was lowered. At most three are spelled out; the rest are counted.
  const damagedFiles = files.filter((f) => f.parse).sort((a, b) => compareText(a.path, b.path));
  const listed = new Set(damagedFiles.slice(0, 3).map((f) => f.path));
  const syntaxNotes = [...damagedFiles.slice(0, 3).map((f) => `${f.path}: ${describeHealth(f.parse as NonNullable<FileInfo['parse']>)}`), ...(damagedFiles.length > 3 ? [`and ${damagedFiles.length - 3} more file(s) with syntax errors`] : [])];
  const caveat = [
  ...(damaged.size > 0
    ? [
        `${damaged.size} file(s) have syntax errors${degraded.length > 0 ? ` (${degraded.length} at the top level or inside an import/export)` : ''}, so an importer may have been missed and a missing importer proves nothing`,
      ]
    : []),
  ...(options.complete === false
    ? ['the scan did not see every file, so a missing importer cannot be ruled out']
    : []),
  ...syntaxNotes,
];


  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const file of [...orphans].sort(compareText)) {
    const info = byPath.get(file) as FileInfo;
    const signals = signalsFor(info, true);
    const classification = classify(signals);
    add({
      rule: 'orphan-file',
      severity: classification === 'confidently-unused' ? 'medium' : 'low',
      file,
      message: `${classification === 'confidently-unused' ? 'Confidently unused' : classification === 'potentially-unused' ? 'Potentially unused' : 'Unreferenced'}: no file imports this module`,
      key: `orphan-file|${id(file)}`,
      confidence: orphanConfidence[classification],
      method: 'import-graph',
      classification,
      evidence: [`no import of it among ${files.length} indexed files`, `not an entry point (profile: ${profileLabel})`, ...caveat, ...signals],
      remediation: classification === 'confidently-unused' ? REMEDIATION['orphan-file'] : `Check whether it is loaded some other way. ${REMEDIATION['orphan-file']}`,
    });
  }

  for (const f of files) {
    const names = used.get(f.path);
    if (orphans.has(f.path) || isTest(f.path) || isEntry(f.path) || names?.has('*')) continue;
    const signals = signalsFor(f, false);
    // Any public name of an importable Python package module can be reached as package.module.name without being imported by
    // name (requests.cookies.CookieConflictError, click.testing.Result), which an import graph cannot see.
    if (f.lang === 'python' && byPath.has(`${f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}__init__.py`)) {
      signals.push('is a module of an importable Python package: callers can use the name as package.module.name without importing it by name');
    }
    const classification = classify(signals);
    for (const s of f.symbols) {
      if (s.exportName && !names?.has(s.exportName)) {
        add({
          rule: 'dead-export',
          severity: 'low',
          file: f.path,
          line: s.line,
          message: `${classification === 'potentially-unused' ? 'Possibly unused' : 'Unused'} export: ${s.exportName} is exported but never imported`,
          key: `dead-export|${id(f.path)}|${s.exportName}`,
          confidence: s.partial || f.parse ? 'low' : exportConfidence[classification],
          method: 'import-graph',
          classification,
          evidence: [`no indexed file imports ${s.exportName} from ${f.path}`, 'not re-exported by an entry point or public package export', 'code outside this workspace (other packages, consumers) is not visible', ...caveat, ...signals, ...(f.parse ? [`${f.path} has syntax errors${s.partial ? ' inside this declaration' : ''}, so this symbol may be incompletely extracted${listed.has(f.path) ? '' : ` (${describeHealth(f.parse)})`}`] : [])],
        });
      }
    }
  }

  const byHash = new Map<string, Located[]>();
  const byStruct = new Map<string, Located[]>();
  const byName = new Map<string, Located[]>();
  for (const f of files.filter((x) => !isTest(x.path))) {
    for (const s of f.symbols) {
      const where: Located = { file: f.path, line: s.line, name: s.name, exported: Boolean(s.exportName), body: s.bodyHash };
      if (s.bodyHash) push(byHash, s.bodyHash, where);
      if (s.structHash) push(byStruct, s.structHash, where);
      if ((s.kind === 'function' || s.kind === 'class') && !GENERIC_NAMES.has(s.name) && !s.name.startsWith('_')) push(byName, s.name, where);
    }
  }

  const place = (w: Located): string => `${w.name} (${w.file}:${w.line})`;
  const exact = new Set<string>();
  const memberKey = (w: Located): string => `${id(w.file)}:${w.name}`;

  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.forEach((w) => exact.add(`${w.file}:${w.name}`));
    add({
      rule: 'duplicate-body',
      severity: 'high',
      file: group[0].file,
      line: group[0].line,
      message: `Textually identical implementation (whitespace-normalized text match, not a semantic comparison): ${group.slice(0, 4).map(place).join(', ')}`,
      key: `duplicate-body|${group.map(memberKey).sort(compareText).join(',')}`,
      confidence: 'high',
      method: 'exact-text-match',
      evidence: [`${group.length} functions have the same body once whitespace is ignored`, ...group.slice(0, 6).map(place)],
    });
  }

  const MAX_SIMILAR_GROUP = 8;
  for (const group of byStruct.values()) {
    if (group.length < 2 || group.length > MAX_SIMILAR_GROUP) continue;
    if (group.every((w) => exact.has(`${w.file}:${w.name}`))) continue;
    add({
      rule: 'similar-structure',
      severity: 'medium',
      file: group[0].file,
      line: group[0].line,
      message: `Structurally similar implementation (same syntax tree after renaming local variables and normalizing literals; not a semantic comparison): ${group.slice(0, 4).map(place).join(', ')}`,
      key: `similar-structure|${group.map(memberKey).sort(compareText).join(',')}`,
      confidence: 'medium',
      method: 'normalized-structure-match',
      evidence: [`${group.length} functions have the same syntax tree shape (at least 40 tokens)`, 'local names, literal values and type annotations were ignored; called functions and property names were not', ...group.slice(0, 6).map(place)],
    });
  }

  for (const [name, group] of byName) {
    const distinctFiles = new Set(group.map((w) => w.file));
    const alreadyCovered = group.every((w) => exact.has(`${w.file}:${w.name}`));
    if (distinctFiles.size < 2 || !group.some((w) => w.exported) || alreadyCovered) continue;
    add({
      rule: 'duplicate-symbol',
      severity: 'low',
      file: group[0].file,
      line: group[0].line,
      message: `${name} is defined in ${distinctFiles.size} files: ${group.slice(0, 4).map((w) => `${w.file}:${w.line}`).join(', ')} (same name only; the bodies were not found to match)`,
      key: `duplicate-symbol|${name}|${[...distinctFiles].map(id).sort(compareText).join(',')}`,
      confidence: 'low',
      method: 'name-match',
      evidence: [`the name ${name} is declared in ${distinctFiles.size} files`, 'a shared name says nothing about shared behaviour'],
    });
  }

  for (const f of files) {
    const byKind = new Map<string, number[]>();
    for (const s of f.suppressions) push(byKind, s.kind, s.line);
    for (const [kind, lines] of byKind) {
      add({
        rule: 'suppression',
        severity: suppressionSeverity(kind),
        file: f.path,
        line: lines[0],
        message: `${lines.length}x ${kind} (line${lines.length > 1 ? 's' : ''} ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''})`,
        key: `suppression|${id(f.path)}|${kind}`,
        count: lines.length,
        confidence: 'high',
        method: 'comment-scan',
        evidence: [`${lines.length} occurrence(s) of ${kind} found in the source`],
      });
    }

    for (const item of f.unusedImports) {
      // A Python module's imports are attributes of the module: another file importing the name from here is a re-export (compat shims).
      if (f.lang === 'python' && used.get(f.path)?.has(item.name)) continue;
      // Generated code (route trees, API clients) imports for module augmentation and is rewritten on every build.
      if (GENERATED_FILE.test(f.path)) continue;
      add({
        rule: 'unused-import',
        severity: 'low',
        file: f.path,
        line: item.line,
        message: `${item.name} is imported from '${item.source}' but never used`,
        key: `unused-import|${id(f.path)}|${item.source}|${item.name}`,
        confidence: f.parse ? 'low' : f.lang === 'python' ? 'medium' : 'high',
        method: 'scope-analysis',
        evidence: [`'${item.name}' is bound by the import on line ${item.line}`, 'no reference in the file resolves to that binding (shadowed names and declarations were not counted)', ...(f.lang === 'python' ? ['Python can use a name through getattr, globals() or a re-export that static analysis does not see'] : []), ...(f.parse ? [`the file has syntax errors near line ${f.parse.lines.join(', ')}, so a use of '${item.name}' inside the damaged region may have been missed (${describeHealth(f.parse)})`] : [])],
      });
    }
  }

  for (const cycle of cycles) {
    const extra = cycle.modules.length > cycle.path.length - 1 ? ` (${cycle.modules.length} modules take part)` : '';
    add({
      rule: 'circular-dependency',
      severity: 'medium',
      file: cycle.path[0],
      message: `Circular dependency: ${cycle.path.join(' → ')}${extra}`,
      key: `circular-dependency|${cycle.modules.map(id).sort(compareText).join(',')}`,
      confidence: 'high',
      method: 'import-graph',
      evidence: [`${cycle.path.join(' → ')}`, 'every edge is a load-time import between resolved files (type-only and lazy imports are not counted)'],
    });
  }

  for (const item of unresolved) {
    if (item.reason === 'not-indexed' || item.reason === 'unsupported') continue;
    const detail = item.reason === 'ambiguous' ? `is ambiguous (${item.candidates.slice(0, 3).join(', ')}), not guessing` : 'could not be resolved to a file in this workspace';
    add({
      rule: 'unresolved-import',
      severity: 'low',
      file: item.file,
      line: item.line,
      message: `'${item.spec}' ${detail}`,
      key: `unresolved-import|${id(item.file)}|${item.spec}`,
      // "No such file" is an absence claim, like "nothing imports this": on a scan that did not see the whole workspace the file may
      // simply be somewhere the scan did not look.
      confidence: options.complete === false ? 'low' : item.reason === 'not-found' && item.spec.startsWith('.') ? 'high' : 'medium',
      method: 'import-resolution',
      evidence: [
        `'${item.spec}' was looked up as ${item.spec.startsWith('.') ? 'a relative path' : 'a configured alias or local module'}`,
        item.reason === 'ambiguous' ? `it matches several files: ${item.candidates.slice(0, 3).join(', ')}` : 'no matching file exists in the index',
        ...(options.complete === false ? ['the scan did not see every file, so the target may exist where it did not look'] : []),
      ],
    });
  }

  // Project configuration: per-rule severity (or off) and path exceptions.
  const ruleSettings = settings.rules ?? {};
  const exceptions = (settings.exceptions ?? []).map((e) => ({ rule: e.rule, symbol: e.symbol, matcher: ignore().add(e.path) }));
  const kept = findings.filter((f) => {
    if (ruleSettings[f.rule] === 'off') return false;
    return !exceptions.some((e) => e.rule === f.rule && e.matcher.ignores(f.file) && (!e.symbol || f.message.includes(e.symbol) || f.key.includes(e.symbol)));
  });
  for (const f of kept) {
    const level = ruleSettings[f.rule];
    if (level && level !== 'off') f.severity = level;
  }
  findings.length = 0;
  findings.push(...kept);

  const weight: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (a, b) => weight[a.severity] - weight[b.severity] || compareText(a.rule, b.rule) || compareText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || compareText(a.key, b.key),
  );

  return { graph, findings, cycles, unresolved: unresolved.filter((u) => u.reason !== 'unsupported'), unsupported: unresolved.filter((u) => u.reason === 'unsupported') };
}

export function analyzeProject(project: Pick<Project, 'files' | 'tsconfigs' | 'packages' | 'foreignExtensions' | 'knownPaths' | 'complete'>, config: Pick<Config, 'pythonRoots'> & Partial<Pick<Config, 'profile' | 'entryPoints' | 'rules' | 'exceptions'>>): Analysis {
  return analyze(project.files, {
    tsconfigs: project.tsconfigs,
    packages: project.packages,
    foreignExtensions: project.foreignExtensions,
    pythonRoots: config.pythonRoots,
    known: project.knownPaths,
    complete: project.complete,
    config,
  });
}
