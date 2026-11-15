import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { compareText } from '../../utils/text.js';
import { createPacer } from '../../utils/pace.js';
import type { Lang } from './types.js';

export type Candidate = { rel: string; lang: Lang; size: number; mtimeMs: number };

// Why discovery stopped before the whole tree was seen. Absent means every directory was visited.
export type DiscoveryStop = 'entry-limit' | 'time-limit' | 'memory-limit';

export type Walk = {
  eligible: Candidate[];
  oversized: string[];
  unreadableDirs: string[];
  configs: string[];
  manifests: string[];
  legacy: string[];
  foreign: Set<string>;
  // Entries that could not be classified (the directory listing gave no type and lstat failed). They may be source files or
  // directories, so discovery is incomplete while any exist.
  unclassified: string[];
  // Directories that were listed as directories but were no longer the same directory when they were opened (replaced by a symbolic
  // link or by another directory during the scan), or that resolved outside the workspace. Nothing from them is used.
  replacedDirs: string[];
  // Entries that disappeared between being listed and being examined (ENOENT). They no longer exist, so they are not a gap in the
  // scan, but they are recorded rather than dropped silently.
  vanished: string[];
  // Three different quantities, which `maxDiscoveryEntries` does not conflate:
  //   listed            directory entries read from the file system. Choosing the first N names of a directory in name order
  //                     means reading all of it, so this can exceed `entries`; the time limit is what bounds it.
  //   entries           entries actually processed (classified, ignore-checked, stat-ed), in sorted order. Never more than
  //                     `maxDiscoveryEntries`: the entry that would exceed the limit is detected but not processed or counted.
  //   peakListingBuffer the most entries held in the directory-listing buffer at one moment, counted in entries, not bytes.
  //                     It covers only that buffer. It is NOT total discovery memory: the retained candidates (`eligible`), the
  //                     list of directories still to visit, and the results below are not part of it.
  listed: number;
  entries: number;
  peakListingBuffer: number;
  // The memory budget and the most the discovery algorithm was estimated to hold at one moment (see "Memory model" below). It is a
  // deterministic estimate computed from names and counts, never a measurement of the heap, and it never exceeds `limitBytes`.
  memory: { limitBytes: number; peakEstimatedBytes: number };
  stopped?: DiscoveryStop;
};

const LANGUAGE_BY_EXT: Record<string, Lang> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
};

export const GENERATED = /\.d\.[cm]?ts$|\.min\.[cm]?js$/;
export const languageOf = (file: string): Lang | undefined => LANGUAGE_BY_EXT[path.extname(file).toLowerCase()];

// Files that can import code but are not analysed here: an unseen importer means "nobody imports this" cannot be certain.
export const FOREIGN_SOURCE = new Set(['.vue', '.svelte', '.astro', '.mdx']);

// Everything the walk needs from the rest of the indexer, passed in so this module has no heavy dependencies.
export type WalkEnv = {
  root: string;
  ignores: (rel: string) => boolean;
  maxBytes: number;
  isTsConfig: (name: string) => boolean;
  isSensitive: (rel: string) => boolean;
};

export type WalkLimits = {
  maxEntries: number;
  maxMs: number;
  // Budget for the estimated memory of the walk (see "Memory model"). Absent: DEFAULT_DISCOVERY_MEMORY_BYTES. Never above
  // MAX_DISCOVERY_MEMORY_BYTES, whatever the caller passes.
  maxMemoryBytes?: number;
  signal?: AbortSignal;
};

// ---- Memory model --------------------------------------------------------------------------------------------------------------
//
// An entry-count limit alone says nothing about memory: a million entries with 255-character names hold several times what a million
// short names do. Discovery therefore keeps a running ESTIMATE of what it holds and stops, reporting 'memory-limit', before the
// estimate would pass the budget. The estimate is computed from names and counts only (never from the heap), so the same directory
// content gives the same estimate on every run. The constants below were measured on V8 (64-bit, no pointer compression) and rounded
// UP; names are charged at two bytes per UTF-16 unit, the worst case for a string.
//   listing item   {name, kind} object + string header + array slot             ITEM_FIXED_BYTES + 2 * name.length  (measured <= 66 + 2n)
//   path string    a retained relative path (pending directories, result lists)  STRING_FIXED_BYTES + 2 * length      (measured <= 40 + 2n)
//   candidate      {rel, lang, size, mtimeMs} + its path + allowance for the     CANDIDATE_FIXED_BYTES + 2 * length  (measured <= 82 + 2n)
//                  final sort of `eligible`
//   sorting        while a listing buffer is sorted or merged, the original array, the runs and the merge output are alive together
//                  (three pointer arrays) plus garbage not yet collected; SORT_BYTES_PER_ENTRY is reserved for EVERY buffered entry
//                  at all times, so a sort is always affordable when it is needed.
//   fixed          directory read batches (1024 Dirents), the result object, the pacer: FIXED_OVERHEAD_BYTES.
// What is charged: the listing buffer of the directory being read (and, once read, its entries until the directory is processed),
// the sort allowance for them, the directories still to visit, `eligible` and every other retained result list.
// What is not: the memory of the rest of the process, and the allocations of one file system call.
export const ITEM_FIXED_BYTES = 80;
export const STRING_FIXED_BYTES = 40;
export const CANDIDATE_FIXED_BYTES = 128;
export const SORT_BYTES_PER_ENTRY = 48;
export const FIXED_OVERHEAD_BYTES = 1024 * 1024;
export const DEFAULT_DISCOVERY_MEMORY_BYTES = 128 * 1024 * 1024;
export const MAX_DISCOVERY_MEMORY_BYTES = 256 * 1024 * 1024;
export const estimateItemBytes = (name: string): number => ITEM_FIXED_BYTES + 2 * name.length;
export const estimatePathBytes = (rel: string): number => STRING_FIXED_BYTES + 2 * rel.length;
export const estimateCandidateBytes = (rel: string): number => CANDIDATE_FIXED_BYTES + 2 * rel.length;

class MemoryMeter {
  readonly limit: number;
  // Directories still to visit and every retained result.
  retained = FIXED_OVERHEAD_BYTES;
  // Entries of the directory being processed, after it was listed.
  listing = 0;
  peak = FIXED_OVERHEAD_BYTES;
  constructor(limit: number) {
    this.limit = Number.isFinite(limit) ? Math.min(Math.max(limit, 0), MAX_DISCOVERY_MEMORY_BYTES) : DEFAULT_DISCOVERY_MEMORY_BYTES;
  }
  get total(): number {
    return this.retained + this.listing;
  }
  fits(extra: number): boolean {
    return this.total + extra <= this.limit;
  }
  observe(extra = 0): void {
    const now = this.total + extra;
    if (now > this.peak) this.peak = now;
  }
}

// What is kept of a directory entry while it is listed: the name and its kind, nothing else. A fs.Dirent also carries the
// parent path and other fields, which for a directory of hundreds of thousands of files is memory that is never used.
const FILE = 0;
const DIRECTORY = 1;
const SYMLINK = 2;
// A socket, FIFO or device: known to be neither a file nor a directory, and never indexed.
const OTHER = 3;
// The listing gave no type (some file systems and network mounts report DT_UNKNOWN). The entry may be a file or a directory, so
// it is classified with lstat, which never follows a symbolic link.
const UNKNOWN = 4;
export type Item = { name: string; kind: number };
const kindOf = (e: fs.Dirent): number =>
  e.isSymbolicLink()
    ? SYMLINK
    : e.isDirectory()
      ? DIRECTORY
      : e.isFile()
        ? FILE
        : e.isSocket() || e.isFIFO() || e.isCharacterDevice() || e.isBlockDevice()
          ? OTHER
          : UNKNOWN;
const kindOfStats = (s: fs.Stats): number => (s.isSymbolicLink() ? SYMLINK : s.isDirectory() ? DIRECTORY : s.isFile() ? FILE : OTHER);

const byName = (a: { name: string }, b: { name: string }): number => compareText(a.name, b.name);

// Sorting is done in bounded slices so that a directory with hundreds of thousands of entries never holds the event loop
// for one long Array.prototype.sort: each chunk is sorted on its own, then the sorted runs are merged with a checkpoint
// every few thousand steps. Names are unique inside a directory, so the order is total and identical to a plain sort.
const SORT_CHUNK = 4096;
const MERGE_STEP = 2048;
type Checkpoint = () => Promise<void>;

async function mergeRuns<T extends { name: string }>(a: T[], b: T[], checkpoint: Checkpoint): Promise<T[]> {
  const out: T[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length || j < b.length) {
    out[k++] = j >= b.length || (i < a.length && byName(a[i], b[j]) <= 0) ? a[i++] : b[j++];
    if ((k & (MERGE_STEP - 1)) === 0) await checkpoint();
  }
  return out;
}

export async function sortEntries<T extends { name: string }>(entries: T[], checkpoint: Checkpoint): Promise<T[]> {
  if (entries.length <= SORT_CHUNK) return entries.sort(byName);
  let runs: T[][] = [];
  for (let i = 0; i < entries.length; i += SORT_CHUNK) {
    runs.push(entries.slice(i, i + SORT_CHUNK).sort(byName));
    await checkpoint();
  }
  while (runs.length > 1) {
    const next: T[][] = [];
    for (let i = 0; i < runs.length; i += 2) next.push(i + 1 < runs.length ? await mergeRuns(runs[i], runs[i + 1], checkpoint) : runs[i]);
    runs = next;
  }
  return runs[0] ?? [];
}

// ---- Opening a directory without trusting the path -----------------------------------------------------------------------------
//
// A directory that was listed as a directory can be replaced by a symbolic link before it is opened, which would make the walk list
// (and descend into) a directory outside the workspace. Checking with lstat and then opening by path leaves a gap between the two
// calls, so the checks are layered:
//   1. lstat the path: it must be a directory and not a link. Its device and inode are remembered.
//   2. Where the platform has O_NOFOLLOW (Linux, macOS), open the directory descriptor with O_NOFOLLOW | O_DIRECTORY: the kernel
//      refuses a link in the final component atomically. fstat the descriptor: it must be the object seen in step 1.
//   3. On Linux the listing is read through /proc/self/fd/<fd>, that is, from the verified object itself, whatever happens to the
//      path afterwards. Its real path (readlink) must be inside the workspace.
//   4. After the listing, the path is checked again: still a directory, not a link, same object, still inside the workspace. If not,
//      the whole listing is discarded and the directory is reported as replaced.
// Node has no openat or fdopendir, so on macOS and Windows the listing itself is still opened by path; there the checks in 1 and 4
// bracket it and a replacement that is undone within the window is not detectable. File contents are never read through this path:
// readInside refuses links and paths outside the workspace on its own.
class DirectoryReplaced extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryReplaced';
  }
}

const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' && process.platform !== 'win32';
const OPEN_DIRECTORY = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
const sameObject = (a: fs.Stats, b: fs.Stats): boolean => a.isDirectory() === b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
const insideRoot = (real: string, rootReal: string): boolean => real === rootReal || real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

type OpenedDirectory = { dir: fs.Dir; verify: () => void; close: () => void };

async function openVerifiedDirectory(rootReal: string, abs: string): Promise<OpenedDirectory> {
  const before = fs.lstatSync(abs);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new DirectoryReplaced('no longer a directory');

  let fd: number | undefined;
  let listPath = abs;
  let real: string;
  try {
    if (NOFOLLOW) {
      try {
        fd = fs.openSync(abs, OPEN_DIRECTORY);
      } catch (err) {
        // ELOOP: the final component is now a link. ENOTDIR: it is no longer a directory.
        if (codeOf(err) === 'ELOOP' || codeOf(err) === 'ENOTDIR') throw new DirectoryReplaced('replaced while being opened');
        throw err;
      }
      if (!sameObject(before, fs.fstatSync(fd))) throw new DirectoryReplaced('a different directory was opened');
      const viaFd = `/proc/self/fd/${fd}`;
      if (process.platform === 'linux' && fs.existsSync(viaFd)) {
        listPath = viaFd;
        real = fs.readlinkSync(viaFd);
      } else {
        real = fs.realpathSync(abs);
      }
    } else {
      real = fs.realpathSync(abs);
    }
    if (!insideRoot(real, rootReal)) throw new DirectoryReplaced('resolves outside the workspace');
    const dir = await fs.promises.opendir(listPath, { bufferSize: 1024 });
    const opened = fd;
    return {
      dir,
      close: () => {
        if (opened !== undefined) {
          try {
            fs.closeSync(opened);
          } catch {
            // already closed
          }
        }
      },
      verify: () => {
        const after = fs.lstatSync(abs);
        if (after.isSymbolicLink() || !after.isDirectory() || !sameObject(before, after)) throw new DirectoryReplaced('replaced while being listed');
        if (!insideRoot(fs.realpathSync(abs), rootReal)) throw new DirectoryReplaced('resolves outside the workspace');
      },
    };
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    throw err;
  }
}

// Thrown by the checkpoint while a directory is being listed or sorted, when maxMs has run out.
const OUT_OF_TIME = Symbol('discovery-out-of-time');
// Thrown while a directory is being listed when what has to be held would pass the memory budget.
const OUT_OF_MEMORY = Symbol('discovery-out-of-memory');

type ListStats = { listed: number; peakListingBuffer: number };

// Lists one directory without a single blocking readdir call: entries arrive in batches from the thread pool, and every
// batch passes a checkpoint (cancellation, deadline, event-loop yield).
//
// Which names come first in name order cannot be known before the whole directory has been read, so every entry is read
// (and counted in `stats.listed`); what is bounded is how many are kept. At most `keep` entries are retained, the first
// `keep` in name order, which is all the entry limit can ever reach. Once `keep` names have been collected, the largest of
// them is a cutoff: an entry that sorts after it can never be selected and is dropped on arrival instead of buffered. The
// buffer is sorted and cut back to `keep` whenever it grows by half of `keep` (at least 8192), so its size stays within
// `1.5 * keep + 8192` entries however large the directory is, and in the usual case stays close to `keep`.
// The selection is exactly the first `keep` names in name order, whatever order the file system lists them in.
//
// The buffer is also bounded in BYTES (see "Memory model"). Before an entry is buffered, the estimate of the buffer, its sort
// allowance and the rest of the walk must fit the budget. If it does not, the buffer is cut back early when that frees at least
// MIN_RECLAIM entries (so a sort is never repeated for a handful of entries). If that is not possible either, the directory cannot
// be selected from within the budget: OUT_OF_MEMORY is thrown and nothing from this directory is used. Nothing is dropped silently:
// the caller reports 'memory-limit'.
async function listDirectory(rootReal: string, abs: string, keep: number, checkpoint: Checkpoint, stats: ListStats, meter: MemoryMeter): Promise<{ items: Item[]; bytes: number }> {
  const trimAt = keep + Math.max(keep >> 1, 8192);
  const minReclaim = Math.max(8192, keep >> 3);
  let buffer: Item[] = [];
  let bufferBytes = 0;
  let cutoff: string | undefined;
  const sizeOf = (items: Item[]): number => {
    let total = 0;
    for (const item of items) total += estimateItemBytes(item.name);
    return total;
  };
  const trim = async (): Promise<void> => {
    buffer = await sortEntries(buffer, checkpoint);
    if (buffer.length > keep) buffer.length = keep;
    bufferBytes = sizeOf(buffer);
    if (buffer.length === keep) cutoff = buffer[keep - 1].name;
  };
  // Bytes held if one more entry of `cost` is buffered: the buffer, the item, and the sort allowance for all of them.
  const needed = (cost: number): number => bufferBytes + cost + SORT_BYTES_PER_ENTRY * (buffer.length + 1);
  const opened = await openVerifiedDirectory(rootReal, abs);
  let seen = 0;
  try {
    for await (const entry of opened.dir) {
      stats.listed++;
      if ((++seen & 255) === 0) await checkpoint();
      if (cutoff !== undefined && compareText(entry.name, cutoff) > 0) continue;
      const cost = estimateItemBytes(entry.name);
      if (!meter.fits(needed(cost))) {
        const before = buffer.length;
        if (before > keep) await trim();
        // The cutoff may have just been set or lowered: an entry beyond it is not wanted after all.
        if (cutoff !== undefined && compareText(entry.name, cutoff) > 0) continue;
        if (before - buffer.length < minReclaim || !meter.fits(needed(cost))) throw OUT_OF_MEMORY;
      }
      buffer.push({ name: entry.name, kind: kindOf(entry) });
      bufferBytes += cost;
      meter.observe(bufferBytes + SORT_BYTES_PER_ENTRY * buffer.length);
      if (buffer.length > stats.peakListingBuffer) stats.peakListingBuffer = buffer.length;
      if (buffer.length >= trimAt) await trim();
    }
    // Everything listed is only trusted if the path still leads to the directory that was opened.
    opened.verify();
  } finally {
    opened.close();
  }
  buffer = await sortEntries(buffer, checkpoint);
  if (buffer.length > keep) buffer.length = keep;
  return { items: buffer, bytes: sizeOf(buffer) };
}

// Directories are visited in sorted order, so which entries are seen before a limit is hit does not depend on the
// order the operating system lists them. The entry limit is therefore deterministic; the time limit cannot be.
// The deadline is enforced while a directory is listed, sorted and processed entry by entry, not only between
// directories, and the walk hands the event loop back regularly and throws the signal's reason when cancelled.
export async function walk(env: WalkEnv, limits: WalkLimits): Promise<Walk> {
  const result: Walk = { eligible: [], oversized: [], unreadableDirs: [], configs: [], manifests: [], legacy: [], foreign: new Set(), unclassified: [], replacedDirs: [], vanished: [], listed: 0, entries: 0, peakListingBuffer: 0, memory: { limitBytes: 0, peakEstimatedBytes: 0 } };
  const meter = new MemoryMeter(limits.maxMemoryBytes ?? DEFAULT_DISCOVERY_MEMORY_BYTES);
  result.memory.limitBytes = meter.limit;
  // Every retained string is charged when it is stored, so the budget covers the result lists as well as the pending directories.
  const retainPath = (list: string[], rel: string): void => {
    list.push(rel);
    meter.retained += estimatePathBytes(rel);
    meter.observe();
  };
  const pacer = createPacer({ signal: limits.signal });
  const deadline = performance.now() + limits.maxMs;
  const timeUp = (): boolean => performance.now() > deadline;
  const checkpoint: Checkpoint = async () => {
    await pacer.tick();
    if (timeUp()) throw OUT_OF_TIME;
  };
  const pending = [''];
  // Every path below is built from the real path of the root, so a root that is itself a link is resolved once, up front.
  let rootReal = env.root;
  try {
    rootReal = fs.realpathSync(env.root);
  } catch {
    // an unreadable root is reported as an unreadable directory below
  }

  scan: while (pending.length > 0) {
    await pacer.tick();
    if (timeUp()) {
      result.stopped = 'time-limit';
      break;
    }

    const dir = pending.pop() as string;
    if (dir) meter.retained -= estimatePathBytes(dir);
    let entries: Item[];
    try {
      // One more than the budget left, so that exceeding the entry limit is still detected after trimming.
      const listed = await listDirectory(rootReal, path.join(rootReal, dir), limits.maxEntries - result.entries + 1, checkpoint, result, meter);
      entries = listed.items;
      meter.listing = listed.bytes;
      meter.observe();
    } catch (err) {
      if (err === OUT_OF_TIME) {
        result.stopped = 'time-limit';
        break;
      }
      // The directory could not be selected from within the budget. Nothing of it is used, and the scan says it stopped.
      if (err === OUT_OF_MEMORY) {
        result.stopped = 'memory-limit';
        break;
      }
      // Cancellation is never reported as an unreadable directory.
      if (limits.signal?.aborted) throw err;
      if (err instanceof DirectoryReplaced) retainPath(result.replacedDirs, dir || '.');
      // A subdirectory that no longer exists was removed during the scan: nothing is hidden by that. A root that cannot be read is a gap.
      else if (codeOf(err) === 'ENOENT' && dir !== '') retainPath(result.vanished, dir);
      else retainPath(result.unreadableDirs, dir || '.');
      continue;
    }

    const subdirs: string[] = [];
    let sinceTick = 0;
    for (const entry of entries) {
      if (timeUp()) {
        result.stopped = 'time-limit';
        break scan;
      }
      // The entry that would exceed the limit proves there is more to see, but it is not processed and not counted.
      if (result.entries >= limits.maxEntries) {
        result.stopped = 'entry-limit';
        break scan;
      }
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // Room for the most one entry can retain (a candidate, plus its path in `legacy`) before it is looked at. Like the entry limit,
      // the entry that does not fit is not processed and not counted; everything before it, in sorted order, is.
      if (!meter.fits(estimateCandidateBytes(rel) + estimatePathBytes(rel))) {
        result.stopped = 'memory-limit';
        break scan;
      }
      result.entries++;
      if ((++sinceTick & 31) === 0) await pacer.tick();
      if (entry.kind === SYMLINK) continue;

      let kind = entry.kind;
      if (kind === UNKNOWN) {
        try {
          kind = kindOfStats(fs.lstatSync(path.join(rootReal, rel)));
        } catch (err) {
          // ENOENT: it was removed after it was listed. Any other error (permissions, I/O): neither the listing nor lstat could say what
          // this is, so it cannot be ruled out as a source file or a directory.
          if (codeOf(err) === 'ENOENT') retainPath(result.vanished, rel);
          else retainPath(result.unclassified, rel);
          continue;
        }
        if (kind === SYMLINK) continue;
      }

      if (kind === DIRECTORY) {
        if (!env.ignores(`${rel}/`)) {
          subdirs.push(rel);
          meter.retained += estimatePathBytes(rel);
          meter.observe();
        }
        continue;
      }
      if (kind !== FILE || env.ignores(rel)) continue;

      if (env.isTsConfig(entry.name)) {
        retainPath(result.configs, rel);
        continue;
      }
      if (entry.name === 'package.json' || entry.name === 'pyproject.toml') {
        retainPath(result.manifests, rel);
        continue;
      }
      // setup.cfg / setup.py can declare console entry points that are not read; setup.py is still indexed as source.
      if (entry.name === 'setup.cfg' || entry.name === 'setup.py') {
        retainPath(result.legacy, rel);
        if (entry.name === 'setup.cfg') continue;
      }

      const foreignExt = path.extname(entry.name).toLowerCase();
      if (FOREIGN_SOURCE.has(foreignExt)) result.foreign.add(foreignExt);

      const lang = languageOf(entry.name);
      if (!lang || GENERATED.test(entry.name) || env.isSensitive(rel)) continue;

      let stat: fs.Stats;
      try {
        // lstat, not stat: a file swapped for a symbolic link after it was listed is not followed.
        stat = fs.lstatSync(path.join(rootReal, rel));
      } catch (err) {
        // A source file that cannot be examined is never dropped silently: ENOENT means it is gone (recorded, no gap); anything else
        // (permissions, I/O error) means it may be a source file the scan could not see, and the scan is reported as partial.
        if (codeOf(err) === 'ENOENT') retainPath(result.vanished, rel);
        else retainPath(result.unclassified, rel);
        continue;
      }
      // Listed as a file, no longer one: replaced by a link or a directory since. It is not followed, and the scan says it did not see it.
      if (!stat.isFile()) {
        retainPath(result.unclassified, rel);
        continue;
      }
      if (stat.size === 0) continue;
      if (stat.size > env.maxBytes) {
        retainPath(result.oversized, rel);
        continue;
      }
      result.eligible.push({ rel, lang, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
      meter.retained += estimateCandidateBytes(rel);
      meter.observe();
    }
    // The directory is done: its entries are no longer held.
    meter.listing = 0;
    // Reversed so that popping from the end visits subdirectories in sorted order.
    for (let i = subdirs.length - 1; i >= 0; i--) pending.push(subdirs[i]);
  }

  result.memory.peakEstimatedBytes = meter.peak;
  result.eligible.sort((a, b) => compareText(a.rel, b.rel));
  result.oversized.sort(compareText);
  result.unreadableDirs.sort(compareText);
  result.unclassified.sort(compareText);
  result.replacedDirs.sort(compareText);
  result.vanished.sort(compareText);
  return result;
}
