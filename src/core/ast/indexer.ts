import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import ignore from 'ignore';
import type { Ctx } from '../../context.js';
import { applyCacheWrites, loadCache, type CacheWrite } from '../../db/client.js';
import { parseCachedInfo } from './cached-info.js';
import { RESOURCE_CEILINGS, effectiveLimit } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import { compareText } from '../../utils/text.js';
import { isSensitivePath, readInside, readOptionalInside } from '../security/sandbox.js';
import { createPacer } from '../../utils/pace.js';
import { FOREIGN_SOURCE, GENERATED, languageOf, walk, type DiscoveryStop } from './discovery.js';
import { describeHealth, type ParseHealth } from './health.js';
import { loadLanguages, parseFile } from './parser.js';
import { loadPackages, pythonConfigProblems, type PackageInfo } from './packages.js';
import { TSCONFIG_NAME, diskReader, loadTsConfigs, type TsConfigInfo } from './tsconfig.js';
import type { FileInfo, Lang } from './types.js';

export { FOREIGN_SOURCE, languageOf };

export type SkipReason = 'unreadable' | 'unparseable' | 'too-large' | 'unreadable-directory' | 'unclassified' | 'directory-replaced';
export type SkippedFile = { path: string; reason: SkipReason };
export type ParseIssue = { path: string } & ParseHealth;
// entry-limit, time-limit and memory-limit end discovery; index-time-limit ends parsing. Cancellation throws instead.
export type StopReason = DiscoveryStop | 'index-time-limit';
export type IndexOptions = { signal?: AbortSignal };

export type Project = {
  root: string;
  files: FileInfo[];
  tsconfigs: TsConfigInfo[];
  packages: PackageInfo[];
  // Extensions of importer-capable files present in the workspace that were not analysed (.vue, .svelte, .astro, .mdx).
  foreignExtensions: string[];
  // Every eligible source path in sorted order, including ones beyond maxFiles.
  knownPaths: string[];
  eligible: number;
  truncated: boolean;
  skipped: SkippedFile[];
  // package.json and tsconfig files that exist but could not be loaded, as readable sentences.
  configProblems: string[];
  // Files Tree-sitter had to repair. They stay indexed (their valid symbols are kept) but are not fully understood.
  parseIssues: ParseIssue[];
  // Set when a resource limit ended the scan early: the workspace was not fully discovered or not every file was processed.
  stopped?: StopReason;
  // Eligible files within maxFiles that were not processed because the scan stopped.
  unindexed: number;
  // True only when every eligible file was read and parsed and every manifest and tsconfig loaded. Absence-based findings are low confidence otherwise.
  complete: boolean;
};

const DEFAULT_IGNORES = [
  'node_modules/', '.git/', '.guardian/', 'dist/', 'build/', 'out/', 'coverage/', '.next/', '.nuxt/',
  '.turbo/', '.cache/', '.venv/', 'venv/', '__pycache__/', '.tox/', '.mypy_cache/', '.pytest_cache/',
  '*.egg-info/', 'target/', 'vendor/',
];

// The language of a file the indexer would analyse by name alone: generated and credential-like files never qualify.
export function sourceLanguage(rel: string): Lang | undefined {
  const name = path.posix.basename(rel);
  if (GENERATED.test(name) || isSensitivePath(rel) || TSCONFIG_NAME.test(name)) return undefined;
  return languageOf(name);
}

export const buildIgnoreFilter = (gitignore: string, configIgnore: readonly string[]): ReturnType<typeof ignore> =>
  ignore().add(DEFAULT_IGNORES).add(gitignore).add([...configIgnore]);

export const contentHash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

// A missing .gitignore is normal. One that exists but cannot be read, is unsafe (a symlink out of the workspace, a hard link,
// not a regular file), is too large or is refused for another reason is a different thing: its rules cannot be applied, and
// the scan must say so instead of quietly analysing as if the file were not there.
export type GitignoreState = { text: string; problem: string | null };

const MAX_GITIGNORE_BYTES = 256 * 1024;

export function readGitignoreState(root: string): GitignoreState {
  try {
    const data = readOptionalInside(root, '.gitignore', MAX_GITIGNORE_BYTES, { rejectHardLinks: true });
    return { text: data ? data.toString('utf8') : '', problem: null };
  } catch (err) {
    return { text: '', problem: `.gitignore was not applied (${errorMessage(err)})` };
  }
}

// The text of the .gitignore, or '' when there is none or it cannot be used (readGitignoreState says which).
export function readGitignore(root: string): string {
  return readGitignoreState(root).text;
}

function fromCache(raw: string): FileInfo | null {
  try {
    const info = JSON.parse(raw) as FileInfo;
    const valid = [info.symbols, info.imports, info.reexports, info.unusedImports, info.suppressions, info.dynamicLoads].every(Array.isArray) && typeof info.decorated === 'boolean' && typeof info.script === 'boolean';
    return valid ? info : null;
  } catch {
    return null;
  }
}

// A scan that a too small maxIndexMs keeps stopping can never finish on its own: handling a file means reading and hashing it (the
// hash is the only validity check, so a cached file is never taken on trust), and a call that cannot get through every file within
// its budget starts again at the same files next time. So after a call that was stopped by maxIndexMs, the next call for the same
// workspace in this process gets twice the budget, and so on, up to the same hard ceiling that bounds the setting itself
// (RESOURCE_CEILINGS.maxIndexMs). Nothing about validity is relaxed: every file is still read, hashed and compared before its cached
// result is used. The state is a few small numbers, held in memory only, bounded in size, and reset by any call that is not stopped
// by this limit. A deadline that is already expired (zero or negative) is never extended.
const MAX_TRACKED_ROOTS = 32;
const MAX_DOUBLINGS = 20;
const stoppedStreak = new Map<string, number>();

export function indexBudget(root: string, configured: number): number {
  if (!(configured > 0)) return configured;
  const doublings = stoppedStreak.get(root) ?? 0;
  return Math.min(configured * 2 ** doublings, Math.max(configured, RESOURCE_CEILINGS.maxIndexMs));
}

export function rememberStop(root: string, stoppedByBudget: boolean): void {
  const before = stoppedStreak.get(root) ?? 0;
  stoppedStreak.delete(root);
  if (!stoppedByBudget) return;
  stoppedStreak.set(root, Math.min(before + 1, MAX_DOUBLINGS));
  while (stoppedStreak.size > MAX_TRACKED_ROOTS) {
    const oldest = stoppedStreak.keys().next();
    if (oldest.done) break;
    stoppedStreak.delete(oldest.value);
  }
}

// Hands the event loop back between slices of work, so MCP requests keep being served during a large scan.
// Pass a signal to cancel: the work stops at the next slice, keeps what was already cached, and throws the signal's reason.
//
// Time limits and cancellation are cooperative. They are checked at the boundaries between units of work (between
// directory batches, between entries, between files, between phases), never inside one: a file system call, one
// Tree-sitter parse, or the load of one configuration file runs to completion before the next check, so a limit can be
// overrun by the duration of the slowest single unit (the largest file's parse, or one slow stat). Nothing expensive is
// started once the deadline has passed or the signal has fired, and a stopped scan is always reported as incomplete.
//
// What maxIndexMs covers: the time from the end of discovery until the last file has been handled. That includes loading the grammars
// and the cache (neither can be interrupted, but their time counts against the budget, so a slow start leaves less for files), and,
// for every file, reading, hashing, the cache lookup and parsing: no file is started and no parse is begun after the deadline.
// What it does not cover: discovery (limited by maxDiscoveryMs), the first file of a call (always handled, so a call makes progress),
// and the steps after the last file: writing the cache, loading tsconfig, package and pyproject files (one small read per
// configuration file), and building the result. Those are bounded by the number of configuration files, not by the number of sources.
export async function indexProject(ctx: Ctx, options: IndexOptions = {}): Promise<Project> {
  const { signal } = options;
  const pacer = createPacer({ signal });
  signal?.throwIfAborted();

  // Resource limits are read once, through the trusted ceilings, so every phase of this call works with the same bounded values.
  const maxFiles = effectiveLimit(ctx.config, 'maxFiles');
  const maxBytes = effectiveLimit(ctx.config, 'maxFileKb') * 1024;
  const maxIndexMs = indexBudget(ctx.root, effectiveLimit(ctx.config, 'maxIndexMs'));

  const gitignore = readGitignoreState(ctx.root);
  const filter = buildIgnoreFilter(gitignore.text, ctx.config.ignore);
  const discovered = await walk(
    { root: ctx.root, ignores: (rel) => filter.ignores(rel), maxBytes, isTsConfig: (name) => TSCONFIG_NAME.test(name), isSensitive: isSensitivePath },
    {
      maxEntries: effectiveLimit(ctx.config, 'maxDiscoveryEntries'),
      maxMs: effectiveLimit(ctx.config, 'maxDiscoveryMs'),
      maxMemoryBytes: effectiveLimit(ctx.config, 'maxDiscoveryMemoryMb') * 1024 * 1024,
      signal,
    },
  );
  // maxIndexMs starts here, when discovery (which has its own limit, maxDiscoveryMs) is over, so it covers loading the grammars and
  // the cache as well as reading, hashing, cache lookups and parsing.
  const indexDeadline = performance.now() + maxIndexMs;
  // Cancelled during discovery or while waiting for it: nothing has been written yet, so the cache is untouched.
  signal?.throwIfAborted();
  const selected = discovered.eligible.slice(0, maxFiles);
  const truncated = discovered.eligible.length > selected.length;
  await loadLanguages(selected.map((f) => f.lang));
  signal?.throwIfAborted();

  const cache = loadCache(ctx.db);
  const writes: CacheWrite[] = [];
  const files: FileInfo[] = [];
  const skipped: SkippedFile[] = [
    ...discovered.oversized.map((p): SkippedFile => ({ path: p, reason: 'too-large' })),
    ...discovered.unreadableDirs.map((p): SkippedFile => ({ path: p, reason: 'unreadable-directory' })),
    // Could be a source file or a directory: the workspace was not fully discovered, so the scan is partial.
    ...discovered.unclassified.map((p): SkippedFile => ({ path: p, reason: 'unclassified' })),
    // Replaced by a link or another directory while the scan ran: whatever was inside was not used, so the scan is partial.
    ...discovered.replacedDirs.map((p): SkippedFile => ({ path: p, reason: 'directory-replaced' })),
  ];
  let stopped: StopReason | undefined = discovered.stopped;
  // Files fully handled in this call (reused from the cache, parsed, or skipped). Everything after them is `unindexed`.
  let done = 0;

  // Rows are only pruned when the whole workspace was seen; a partial scan must never evict files it did not reach.
  const persist = (prune: boolean): void => {
    try {
      applyCacheWrites(ctx.db, writes, prune ? new Set(discovered.eligible.map((f) => f.rel)) : undefined);
    } catch (err) {
      log.warn(`Cache not updated this run: ${errorMessage(err)}`);
    }
  };

  // Files that are certain to need parsing (no cache row, or a row whose size or mtime differ) go first, in path order, then the rest in
  // path order. size and mtime are only a hint for this ordering, never a validity check: the SHA-256 below decides. The order
  // guarantees that a call stopped by maxIndexMs has spent its time on new work whenever there is any, so repeated calls always finish.
  const stale = (f: (typeof selected)[number]): boolean => {
    const row = cache.get(f.rel);
    return !row || row.size !== f.size || row.mtime_ms !== f.mtimeMs;
  };
  const order = [...selected.filter(stale), ...selected.filter((f) => !stale(f))];

  try {
    for (const file of order) {
      await pacer.tick();
      // maxIndexMs covers the whole indexing phase: reading, hashing, the cache lookup and parsing. No further file is started once
      // it has passed. The first file of every call is always handled, so a call never ends without having made progress. A read or
      // a parse that has already started is not interrupted.
      if (done > 0 && performance.now() > indexDeadline) {
        stopped ??= 'index-time-limit';
        break;
      }

      try {
        const data = readInside(ctx.root, file.rel, maxBytes);
        const hash = contentHash(data);
        const cached = cache.get(file.rel);

        // A cached result is reused only when its signature verified in loadCache and every nested field checks out here.
        const reusable = cached && cached.hash === hash ? parseCachedInfo(cached.info, file.rel) : null;
        if (reusable) {
          if (cached && (cached.size !== file.size || cached.mtime_ms !== file.mtimeMs)) {
            writes.push({ kind: 'touch', path: file.rel, size: file.size, mtime_ms: file.mtimeMs });
          }
          files.push(reusable);
          done++;
          continue;
        }

        // The file was read before the deadline; parsing it is the most expensive step, so it is not started after the deadline.
        if (done > 0 && performance.now() > indexDeadline) {
          stopped ??= 'index-time-limit';
          break;
        }
        const info = parseFile(file.rel, file.lang, data.toString('utf8').replace(/^\uFEFF/, ''));
        if (!info) {
          skipped.push({ path: file.rel, reason: 'unparseable' });
          done++;
          continue;
        }
        const serialized = JSON.stringify(info);
        if (typeof serialized !== 'string') {
          skipped.push({ path: file.rel, reason: 'unparseable' });
          done++;
          continue;
        }

        const normalized = fromCache(serialized);

        if (!normalized) {
          skipped.push({ path: file.rel, reason: 'unparseable' });
          done++;
          continue;
        }

        writes.push({
          kind: 'save',
          row: {
            path: file.rel,
            hash,
            size: file.size,
            mtime_ms: file.mtimeMs,
            info: serialized,
          },
        });

        files.push(normalized);
        done++;

        
      } catch (err) {
        skipped.push({ path: file.rel, reason: 'unreadable' });
        done++;
        log.debug(`Skipping ${file.rel}: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    // Cancelled mid-scan: keep the files already parsed so the next call does not redo them.
    persist(false);
    throw err;
  }
  persist(!discovered.stopped);
  rememberStop(ctx.root, stopped === 'index-time-limit');
  // The cache is saved; a request cancelled during the loop's last slice does not go on to load configuration files.
  signal?.throwIfAborted();
  // Files were handled stale-first; everything downstream sees them in path order, whatever order they were processed in.
  files.sort((a, b) => compareText(a.path, b.path));

  const unindexed = selected.length - done;
  const reader = diskReader(ctx.root);
  const tsconfigs = loadTsConfigs(reader, discovered.configs);
  const packages = loadPackages(reader, discovered.manifests);
  // A manifest or tsconfig that exists but did not load (unreadable, invalid JSON, an `extends` that cannot be found) means
  // aliases, workspace packages, entry points or framework signals may be missing, so the analysis cannot claim to be complete.
  const loadedConfigs = new Set([...tsconfigs.map((c) => c.file), ...packages.map((p) => p.file)]);
  const configProblems: string[] = [...discovered.configs, ...discovered.manifests.filter((m) => m.endsWith('package.json'))]
    .filter((file) => !loadedConfigs.has(file))
    .sort(compareText)
    .map((file) => `${file} could not be read or parsed`);
  // Ignore rules that could not be applied change which files were analysed: that is a problem of the scan, not a note.
  if (gitignore.problem) configProblems.push(gitignore.problem);
  // pyproject.toml (and the legacy setup files) only matter for entry-point detection, which only matters with Python source.
  if (discovered.eligible.some((f) => f.lang === 'python')) {
    configProblems.push(...pythonConfigProblems(reader, { pyproject: discovered.manifests.filter((m) => m.endsWith('pyproject.toml')), legacy: discovered.legacy }));
  }
  for (const config of tsconfigs) if (config.incomplete) configProblems.push(`${config.file} extends a configuration file that could not be loaded`);

  const parseIssues: ParseIssue[] = files
    .flatMap((f) => (f.parse ? [{ path: f.path, ...f.parse }] : []))
    .sort((a, b) => compareText(a.path, b.path));
  const complete = !truncated && !stopped && skipped.length === 0 && configProblems.length === 0 && parseIssues.length === 0;

  if (truncated) log.warn(`Indexed ${selected.length} of ${discovered.eligible.length} eligible files (sorted by path); raise maxFiles in .guardianrc to see more`);
  if (stopped) log.warn(`Scan stopped early (${stopped}); the analysis is partial. Raise maxDiscoveryEntries, maxDiscoveryMemoryMb, maxDiscoveryMs or maxIndexMs in .guardianrc, or run the scan again to continue from the cache`);
  if (skipped.length > 0) log.info(`${skipped.length} file(s) were skipped, analysis is partial`);
  if (parseIssues.length > 0) log.warn(`${parseIssues.length} file(s) have syntax errors, e.g. ${parseIssues[0].path}: ${describeHealth(parseIssues[0])}`);
  if (configProblems.length > 0) log.warn(`Analysis is partial: ${configProblems.join('; ')}`);

  return {
    root: ctx.root,
    files,
    tsconfigs,
    packages,
    foreignExtensions: [...discovered.foreign].sort(),
    knownPaths: discovered.eligible.map((f) => f.rel),
    eligible: discovered.eligible.length,
    truncated,
    skipped: skipped.sort((a, b) => compareText(a.path, b.path)),
    configProblems,
    parseIssues,
    stopped,
    unindexed,
    complete,
  };
}
