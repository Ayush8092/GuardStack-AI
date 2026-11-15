// Build integrity for dist/. dist/ is generated output that npm ships, so a copy that predates the source ships old code.
// This script makes that fail loudly instead of passing on whatever was built last:
//
//   node scripts/dist-integrity.mjs clean    remove dist/ (first step of `npm run build`)
//   node scripts/dist-integrity.mjs write    record what dist/ was built from (last step of `npm run build`, after tsc succeeded)
//   node scripts/dist-integrity.mjs verify   fail unless dist/ is complete and was built from exactly the current source
//
// The record is dist/build-manifest.json (version 2): the SHA-256 of every source file and of tsconfig.json, and the SHA-256 of
// every compiled JavaScript file that tsc produced from them. It is content based, so it does not depend on file times (which an
// archive or a checkout does not preserve). A failed tsc never reaches `write`, so a broken or partial build has no manifest and
// does not verify.
//
// The output hashes are what stop a compiled file from being edited after the build: a changed file keeps its imports and its
// security-marker strings, so only its hash shows the change. The manifest is validated strictly (version, key set, path shape,
// hash shape, one output per source and nothing else), every file is read once through a descriptor that refuses symbolic
// links, and what is hashed is the same bytes the marker and import checks look at. dist/ may hold nothing but the manifest and
// the recorded outputs. The same checks run on the installed package (checkOutput), which has no source next to it.
//
// Resource limits. A source tree, a dist/ directory or a package that arrives from elsewhere chooses how much this script is
// asked to read, so every step is bounded (DEFAULT_LIMITS): the size of each file and the total of each kind of file, the number
// of source files, the number of directory entries visited, the depth of the directory tree, and the size of package.json,
// tsconfig.json and the bin entry points. Files are processed one at a time: each is read, hashed and inspected while it is
// held, and released before the next is read, so the memory in use is bounded by the largest permitted file, not by their sum.
// When a limit is reached the run stops and reports it as a failure (verify) or refuses to record the build (write): a scan that
// did not finish never reports success.
//
// What this is not: the manifest sits next to the files it describes and is not signed. It detects a stale, partial or edited
// dist/; someone who can rewrite the outputs and the manifest together defeats it, which only a signature or a registry
// provenance check could prevent. bin/cli.js is hand-written, not generated, and is covered by the import check only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANIFEST = 'build-manifest.json';
export const MANIFEST_VERSION = 2;

// Security-relevant implementations that must be in the compiled output. Each token must exist in the source file (so this
// list cannot silently rot) and in the compiled file.
export const SECURITY_MARKERS = [
  ['src/core/security/safe-file.ts', 'createFileByHardLink'],
  ['src/core/security/safe-file.ts', 'createFileExclusive'],
  ['src/db/cache-key.ts', 'createHmac'],
  ['src/db/cache-key.ts', 'loadMachineKey'],
  ['src/db/cache-key.ts', 'openInfo'],
  ['src/db/client.ts', 'assertSameDirectory'],
  ['src/db/client.ts', 'removeVerified'],
  ['src/core/ast/cached-info.ts', 'parseCachedInfo'],
  ['src/core/ast/shared-index.ts', 'createIndexCoordinator'],
  ['src/db/windows-acl.ts', 'checkWindowsAcls'],
  ['src/db/schema-check.ts', 'inspectSchema'],
  // The aggregate cache-load budget counts UTF-8 bytes, not UTF-16 code units.
  ['src/db/client.ts', "Buffer.byteLength(row.info, 'utf8')"],
  ['src/core/git/git.ts', 'taskkill'],
];

const KIB = 1024;
const MIB = 1024 * KIB;

// Bounds, so that a hostile or damaged tree cannot make verification read, hold or walk without limit. The real project is
// about 64 modules of at most a few tens of KiB each (well under 1 MiB in total), so these leave generous room for growth
// while keeping the worst case small: at most one file is held at a time (as bytes and as decoded text), so the largest amount
// of file data in memory is about twice maxOutputBytes plus the manifest.
export const DEFAULT_LIMITS = Object.freeze({
  maxManifestBytes: 4 * MIB,
  // Compiled outputs: each one, and all of them together (the total is spent as the files are read, in manifest order).
  maxOutputBytes: 4 * MIB,
  maxTotalOutputBytes: 32 * MIB,
  // Sources: the count is checked before any file is hashed, then each file and all of them together.
  maxSourceFiles: 1000,
  maxSourceBytes: 2 * MIB,
  maxTotalSourceBytes: 16 * MIB,
  // Directory traversal: every entry seen in src/ (and separately in dist/), whatever it is, and the nesting depth.
  maxTreeEntries: 10000,
  maxDepth: 12,
  // package.json and tsconfig.json, and the bin entry points (their number and each one's size).
  maxMetadataBytes: 256 * KIB,
  maxBins: 16,
  maxBinBytes: 1 * MIB,
  // Relative imports collected from one file.
  maxImportsPerFile: 10000,
});

// A limit that was reached. It stops the whole run: nothing after it was inspected, so nothing may be reported as verified.
export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
  }
}

function resolveLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in DEFAULT_LIMITS)) throw new TypeError(`unknown limit ${JSON.stringify(key)}`);
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`limit ${key} must be a positive integer`);
    limits[key] = value;
  }
  return limits;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

const HASH = /^[0-9a-f]{64}$/;
// One path segment: it cannot be empty, '.', '..' or hidden, and holds no separator, backslash, NUL or space.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

const isSource = (name) => name.endsWith('.ts') && !name.endsWith('.d.ts');
const compiledOf = (rel) => rel.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');

// The state of one run: the root, the limits, the problems found so far, and counters that show what the run did (a test passes
// its own `stats` object to read them: peakRetainedBytes is the most file data held at one moment).
function newScan(root, options = {}) {
  const stats = options.stats ?? {};
  Object.assign(stats, { retainedBytes: 0, peakRetainedBytes: 0, sourcesHashed: 0, outputsHashed: 0, entriesVisited: 0 });
  return { root, limits: resolveLimits(options.limits), problems: [], stats };
}

function retain(scan, bytes) {
  scan.stats.retainedBytes += bytes;
  scan.stats.peakRetainedBytes = Math.max(scan.stats.peakRetainedBytes, scan.stats.retainedBytes);
}

const release = (scan, bytes) => {
  scan.stats.retainedBytes -= bytes;
};

const budgetOf = (label, total) => ({ label, total, remaining: total });

// A manifest key is a relative POSIX path of plain segments under `prefix` with the given extension: no '..', no absolute or
// drive-letter path, no backslash. Declaration files are not sources.
function validPath(value, prefix, ext) {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith(prefix) || !value.endsWith(ext)) return false;
  if (ext === '.ts' && value.endsWith('.d.ts')) return false;
  return value.split('/').every((segment) => SEGMENT.test(segment));
}

// Reads one file below `root` for hashing and inspection. No directory above it (inside root) and not the file itself may be a
// symbolic link, it must be a regular file, and it is read through one descriptor that is checked against the path before and
// after the read, so that what is hashed is exactly what was read. The size is checked against the per-file limit and the
// aggregate budget before anything is allocated. Returns { data } or { problem, missing? }; a limit throws LimitError.
function readRegular(scan, rel, { maxBytes, budget = null }) {
  const { root } = scan;
  const tooLarge = () => new LimitError(`${rel} is larger than ${maxBytes} bytes`);
  const overBudget = () => new LimitError(`the ${budget.label} together exceed the aggregate limit of ${budget.total} bytes (reached at ${rel})`);
  const parts = rel.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      return { problem: `${rel} is missing`, missing: true };
    }
    if (stat.isSymbolicLink()) return { problem: `${posix(path.relative(root, dir))} is a symbolic link` };
    if (!stat.isDirectory()) return { problem: `${posix(path.relative(root, dir))} is not a directory` };
  }
  const file = path.join(root, ...parts);
  let named;
  try {
    named = fs.lstatSync(file, { bigint: true });
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? { problem: `${rel} is missing`, missing: true } : { problem: `${rel} cannot be inspected` };
  }
  if (named.isSymbolicLink()) return { problem: `${rel} is a symbolic link` };
  if (!named.isFile()) return { problem: `${rel} is not a regular file` };
  if (named.size > BigInt(maxBytes)) throw tooLarge();
  if (budget && named.size > BigInt(budget.remaining)) throw overBudget();

  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const held = fs.fstatSync(fd, { bigint: true });
    if (!held.isFile() || held.ino !== named.ino || held.dev !== named.dev) return { problem: `${rel} changed while it was being read` };
    if (held.size > BigInt(maxBytes)) throw tooLarge();
    if (budget) {
      if (held.size > BigInt(budget.remaining)) throw overBudget();
      budget.remaining -= Number(held.size);
    }
    const data = Buffer.alloc(Number(held.size));
    let got = 0;
    while (got < data.length) {
      const n = fs.readSync(fd, data, got, data.length - got, got);
      if (n === 0) break;
      got += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (got !== data.length || after.size !== held.size || after.mtimeNs !== held.mtimeNs) return { problem: `${rel} changed while it was being read` };
    return { data };
  } catch (err) {
    if (err instanceof LimitError) throw err;
    return { problem: `${rel} cannot be read` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Reads a file and hands its bytes to `use` while they are held; they are released as soon as `use` returns, so the caller keeps
// no reference and the next file can be read. Returns { ok: true } or the { problem, missing? } of the read.
function readThen(scan, rel, options, use) {
  const read = readRegular(scan, rel, options);
  if (!read.data) return read;
  const { data } = read;
  retain(scan, data.length);
  try {
    use(data);
  } finally {
    release(scan, data.length);
  }
  return { ok: true };
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// Strict validation of a parsed manifest. Returns the list of problems; empty means the manifest is well formed and its sources
// and outputs correspond one to one through the fixed src/*.ts -> dist/*.js mapping.
export function manifestProblems(manifest, limitOverrides) {
  const { maxSourceFiles } = resolveLimits(limitOverrides);
  const label = `dist/${MANIFEST}`;
  if (!isPlainObject(manifest)) return [`${label} is not a JSON object`];
  const problems = [];
  if (manifest.version !== MANIFEST_VERSION) {
    return [`${label} has unsupported version ${JSON.stringify(manifest.version)} (this tool reads version ${MANIFEST_VERSION}): rebuild with \`npm run build\``];
  }
  for (const key of Object.keys(manifest)) if (!['version', 'tsconfig', 'sources', 'outputs'].includes(key)) problems.push(`${label} has an unexpected field ${JSON.stringify(key.slice(0, 40))}`);
  if (typeof manifest.tsconfig !== 'string' || !HASH.test(manifest.tsconfig)) problems.push(`${label} has an invalid tsconfig hash`);

  const section = (name, prefix, ext) => {
    const value = manifest[name];
    if (!isPlainObject(value)) {
      problems.push(`${label} has no valid ${name} list`);
      return null;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) problems.push(`${label} lists no ${name}`);
    if (keys.length > maxSourceFiles) {
      problems.push(`${label} lists more than ${maxSourceFiles} ${name}`);
      return null;
    }
    for (const key of keys) {
      if (!validPath(key, prefix, ext)) problems.push(`${label} has an invalid ${name} path ${JSON.stringify(key.slice(0, 80))}`);
      else if (typeof value[key] !== 'string' || !HASH.test(value[key])) problems.push(`${label} has an invalid hash for ${key}`);
    }
    return keys;
  };
  const sources = section('sources', 'src/', '.ts');
  const outputs = section('outputs', 'dist/', '.js');
  if (sources && outputs && problems.length === 0) {
    const listed = new Set(outputs);
    const expected = new Set(sources.map(compiledOf));
    for (const rel of sources) if (!listed.has(compiledOf(rel))) problems.push(`${label} lists no output for ${rel} (expected ${compiledOf(rel)})`);
    for (const rel of outputs) if (!expected.has(rel)) problems.push(`${label} lists ${rel}, which no listed source produces`);
  }
  return problems;
}

// The manifest, read safely and validated: { manifest } or { problems }.
function loadManifest(scan) {
  const label = `dist/${MANIFEST}`;
  let manifest;
  let notJson = false;
  const read = readThen(scan, label, { maxBytes: scan.limits.maxManifestBytes }, (data) => {
    try {
      manifest = JSON.parse(data.toString('utf8'));
    } catch {
      notJson = true;
    }
  });
  if (!read.ok) return { problems: [read.missing ? `${label} is missing: dist/ was not produced by \`npm run build\`` : `${label}: ${read.problem}`] };
  if (notJson) return { problems: [`${label} is not valid JSON`] };
  const problems = manifestProblems(manifest, scan.limits);
  return problems.length ? { problems } : { manifest };
}

// The entries of one directory, read through a directory handle one entry at a time and counted against the traversal limit
// as they arrive, so a directory with millions of entries is refused after the limit, not after it has been listed.
// Each entry is classified as 'link', 'dir', 'file' or 'other' without following links.
function listDirectory(scan, dir, counter) {
  let handle;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return null;
  }
  const entries = [];
  try {
    for (let e = handle.readSync(); e !== null; e = handle.readSync()) {
      counter.seen += 1;
      scan.stats.entriesVisited += 1;
      if (counter.seen > scan.limits.maxTreeEntries) throw new LimitError(`${counter.label} holds more than ${scan.limits.maxTreeEntries} directory entries`);
      let kind = e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
      if (kind === 'other') {
        // Some file systems do not report the type with the entry name.
        try {
          const stat = fs.lstatSync(path.join(dir, e.name));
          kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
        } catch {
          kind = 'other';
        }
      }
      entries.push({ name: e.name, kind });
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function checkDepth(scan, rel, depth) {
  if (depth > scan.limits.maxDepth) throw new LimitError(`${rel} is nested deeper than ${scan.limits.maxDepth} directory levels`);
}

// The source files, sorted, found without following any link. A symbolic link anywhere under src/ and a source-named entry that is
// not a regular file are problems, never inputs. The count is bounded here, before any file is hashed.
function collectSources(scan) {
  const top = path.join(scan.root, 'src');
  let stat;
  try {
    stat = fs.lstatSync(top);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    scan.problems.push('src cannot be inspected');
    return [];
  }
  if (stat.isSymbolicLink()) {
    scan.problems.push('src is a symbolic link');
    return [];
  }
  if (!stat.isDirectory()) {
    scan.problems.push('src is not a directory');
    return [];
  }
  const files = [];
  const counter = { label: 'src/', seen: 0 };
  const visit = (dir, relDir, depth) => {
    checkDepth(scan, relDir, depth);
    const entries = listDirectory(scan, dir, counter);
    if (entries === null) {
      scan.problems.push(`${relDir} cannot be listed`);
      return;
    }
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      if (e.kind === 'link') scan.problems.push(`${rel} is a symbolic link`);
      else if (e.kind === 'dir') visit(path.join(dir, e.name), rel, depth + 1);
      else if (isSource(e.name)) {
        if (e.kind !== 'file') scan.problems.push(`${rel} is not a regular file`);
        else if (files.push(rel) > scan.limits.maxSourceFiles) throw new LimitError(`src/ holds more than ${scan.limits.maxSourceFiles} source files`);
      }
    }
  };
  visit(top, 'src', 0);
  return files.sort();
}

// Hashes the sources one at a time, in order, each through a verified descriptor, within the per-file and aggregate byte limits.
// `inspect(rel, data)` runs while the file is held. Returns { rel: sha256 } for the files that were read.
function hashSources(scan, files, inspect) {
  const hashes = {};
  const budget = budgetOf('source files', scan.limits.maxTotalSourceBytes);
  for (const rel of files) {
    const read = readThen(scan, rel, { maxBytes: scan.limits.maxSourceBytes, budget }, (data) => {
      hashes[rel] = sha256(data);
      scan.stats.sourcesHashed += 1;
      if (inspect) inspect(rel, data);
    });
    if (!read.ok) scan.problems.push(read.problem);
  }
  return hashes;
}

// The SHA-256 of every source file, in sorted order. Throws when a source is not a regular file or a limit is reached.
export function sourceHashes(root, options = {}) {
  const scan = newScan(root, options);
  const hashes = hashSources(scan, collectSources(scan));
  if (scan.problems.length) throw new Error(`cannot hash the sources:\n${scan.problems.map((p) => `  - ${p}`).join('\n')}`);
  return hashes;
}

// Everything under dist/ must be a regular file or a real directory, and nothing but the manifest and the recorded outputs
// may be there. Symbolic links are reported, never followed. The walk is bounded in entries and depth.
function scanDist(scan, recorded) {
  const top = path.join(scan.root, 'dist');
  const { problems } = scan;
  const counter = { label: 'dist/', seen: 0 };
  const visit = (dir, relDir, depth) => {
    checkDepth(scan, relDir, depth);
    const entries = listDirectory(scan, dir, counter);
    if (entries === null) {
      problems.push(`${relDir} cannot be listed`);
      return;
    }
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      if (e.kind === 'link') problems.push(`${rel} is a symbolic link`);
      else if (e.kind === 'dir') visit(path.join(dir, e.name), rel, depth + 1);
      else if (e.kind !== 'file') problems.push(`${rel} is not a regular file`);
      else if (rel !== `dist/${MANIFEST}` && !recorded.has(rel)) problems.push(`${rel} is not recorded in ${MANIFEST}: unexpected file in dist/`);
    }
  };
  let stat;
  try {
    stat = fs.lstatSync(top);
  } catch {
    problems.push('dist/ is missing');
    return;
  }
  if (stat.isSymbolicLink()) problems.push('dist is a symbolic link');
  else if (!stat.isDirectory()) problems.push('dist is not a directory');
  else visit(top, 'dist', 0);
}

// Relative specifiers that Node resolves when the file is loaded: static imports and re-exports (from '...'), side-effect
// imports, and import('...'). Comment lines are skipped so that prose cannot produce a false report. The number collected from
// one file is bounded.
function relativeImports(text, maxImports) {
  const found = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const re of [/\bfrom\s*(['"])(\.{1,2}\/[^'"]*)\1/g, /^import\s*(['"])(\.{1,2}\/[^'"]*)\1/g, /\bimport\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g]) {
      for (const m of t.matchAll(re)) {
        found.push(m[2]);
        if (found.length > maxImports) throw new LimitError(`a file has more than ${maxImports} relative imports`);
      }
    }
  }
  return found;
}

function checkImports(scan, file, specifiers) {
  for (const spec of specifiers) {
    const target = path.resolve(path.dirname(file), spec);
    let ok = false;
    try {
      ok = fs.statSync(target).isFile();
    } catch {
      ok = false;
    }
    if (!ok) scan.problems.push(`${posix(path.relative(scan.root, file))} imports ${spec}, which does not exist`);
  }
}

// A bin entry from package.json: a relative POSIX path of plain segments (an initial './' is allowed), no '..', no absolute or
// drive-letter path, no backslash. Returns the normalized path or null.
function binPath(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const rel = value.startsWith('./') ? value.slice(2) : value;
  return rel.split('/').every((segment) => SEGMENT.test(segment)) ? rel : null;
}

// The bin entry points named by package.json, which is read within the metadata limit and must be a plain JSON object whose
// `bin` is a string or an object of strings. Anything else is a problem, not silently an empty list.
function packageBins(scan) {
  let text = null;
  const read = readThen(scan, 'package.json', { maxBytes: scan.limits.maxMetadataBytes }, (data) => {
    text = data.toString('utf8');
  });
  if (!read.ok) {
    scan.problems.push(read.missing ? 'package.json is missing or not valid JSON' : read.problem);
    return [];
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    scan.problems.push('package.json is missing or not valid JSON');
    return [];
  }
  if (!isPlainObject(pkg)) {
    scan.problems.push('package.json is not a JSON object');
    return [];
  }
  const declared = pkg.bin;
  if (declared === undefined) return [];
  const values = typeof declared === 'string' ? [declared] : isPlainObject(declared) ? Object.values(declared) : null;
  if (values === null) {
    scan.problems.push('package.json has an unexpected bin field (it must be a string or an object of strings)');
    return [];
  }
  if (values.length > scan.limits.maxBins) {
    scan.problems.push(`package.json lists more than ${scan.limits.maxBins} bin entries`);
    return [];
  }
  const bins = [];
  for (const value of values) {
    const normalized = binPath(value);
    if (normalized === null) scan.problems.push(`package.json has an invalid bin path ${JSON.stringify(String(value).slice(0, 80))}`);
    else if (!bins.includes(normalized)) bins.push(normalized);
  }
  return bins;
}

// The checks that need only dist/ and its manifest, shared by checkOutput and verifyDist: the layout of dist/, every recorded
// output (present, a regular file, hash equal to the recorded one), the relative imports of each output, the bin entries and the
// security implementations. Outputs are processed one at a time: each is read once and every check that needs its bytes (hash,
// security markers, imports) runs while it is held; it is released before the next one is read, so the outputs are never held
// together. Problems are added to scan.problems.
function inspectOutput(scan, manifest, markers) {
  const outputs = manifest.outputs;
  scanDist(scan, new Set(Object.keys(outputs)));

  const tokensByOutput = new Map();
  for (const [srcFile, token] of markers) {
    const built = compiledOf(srcFile);
    if (!tokensByOutput.has(built)) tokensByOutput.set(built, []);
    tokensByOutput.get(built).push(token);
  }

  const sourceOf = new Map(Object.keys(manifest.sources).map((s) => [compiledOf(s), s]));
  const budget = budgetOf('compiled outputs', scan.limits.maxTotalOutputBytes);
  for (const [out, recorded] of Object.entries(outputs)) {
    const read = readThen(scan, out, { maxBytes: scan.limits.maxOutputBytes, budget }, (data) => {
      scan.stats.outputsHashed += 1;
      if (sha256(data) !== recorded) scan.problems.push(`${out} was modified after the build (its SHA-256 differs from ${MANIFEST})`);
      for (const token of tokensByOutput.get(out) ?? []) if (!data.includes(token)) scan.problems.push(`${out} lacks ${token}`);
      const text = data.toString('utf8');
      retain(scan, text.length);
      try {
        checkImports(scan, path.join(scan.root, ...out.split('/')), relativeImports(text, scan.limits.maxImportsPerFile));
      } finally {
        release(scan, text.length);
      }
    });
    if (!read.ok) scan.problems.push(read.missing ? `missing build output ${out} for ${sourceOf.get(out)}` : read.problem);
  }
  for (const built of tokensByOutput.keys()) if (!(built in outputs)) scan.problems.push(`missing build output ${built}`);

  for (const bin of packageBins(scan)) {
    const read = readThen(scan, bin, { maxBytes: scan.limits.maxBinBytes }, (data) => {
      const file = path.join(scan.root, ...bin.split('/'));
      const imports = relativeImports(data.toString('utf8'), scan.limits.maxImportsPerFile);
      checkImports(scan, file, imports);
      const targets = imports.map((s) => path.resolve(path.dirname(file), s));
      if (!targets.some((t) => posix(path.relative(scan.root, t)).startsWith('dist/'))) scan.problems.push(`bin entry ${bin} does not load anything from dist/`);
    });
    if (!read.ok) scan.problems.push(read.missing ? `bin entry ${bin} does not exist` : read.problem);
  }
}

// Runs one operation; a limit that was reached ends it with a failure that names the limit (plus whatever was found before), so
// an incomplete scan can never come back as an empty list of problems.
function guarded(scan, run) {
  try {
    return run();
  } catch (err) {
    if (!(err instanceof LimitError)) throw err;
    return [...new Set(scan.problems), `verification stopped before it finished, a limit was reached: ${err.message}`];
  }
}

// What can be checked on a built tree with no source next to it, so the same checks run on the installed package: a valid
// manifest, every recorded output present with the recorded hash, nothing else in dist/, every relative import resolves, every
// bin entry exists and leads into dist, and the security implementations are present.
export function checkOutput(root, { markers = SECURITY_MARKERS, limits, stats } = {}) {
  const scan = newScan(root, { limits, stats });
  return guarded(scan, () => {
    const loaded = loadManifest(scan);
    if (!loaded.manifest) return loaded.problems;
    inspectOutput(scan, loaded.manifest, markers);
    return [...new Set(scan.problems)];
  });
}

// Everything checkOutput does, plus proof that dist/ was built from this very source.
export function verifyDist(root, { markers = SECURITY_MARKERS, limits, stats } = {}) {
  const scan = newScan(root, { limits, stats });
  return guarded(scan, () => {
    const loaded = loadManifest(scan);
    if (!loaded.manifest) return loaded.problems;
    const { manifest } = loaded;
    const { problems } = scan;

    // The source file count is bounded before the first file is hashed; each marker is checked while its file is held.
    const files = collectSources(scan);
    const listed = new Set(files);
    const tokensBySource = new Map();
    for (const [srcFile, token] of markers) {
      if (!tokensBySource.has(srcFile)) tokensBySource.set(srcFile, []);
      tokensBySource.get(srcFile).push(token);
    }
    const current = hashSources(scan, files, (rel, data) => {
      for (const token of tokensBySource.get(rel) ?? []) if (!data.includes(token)) problems.push(`${rel} no longer contains ${token}: update SECURITY_MARKERS`);
    });
    for (const [srcFile, tokens] of tokensBySource) if (!listed.has(srcFile)) for (const token of tokens) problems.push(`${srcFile} no longer contains ${token}: update SECURITY_MARKERS`);

    const recorded = manifest.sources;
    for (const rel of files) {
      if (!(rel in recorded)) {
        problems.push(`${rel} is newer than dist/ (it was added after the build)`);
        try {
          fs.lstatSync(path.join(scan.root, ...compiledOf(rel).split('/')));
        } catch (err) {
          if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) problems.push(`missing build output ${compiledOf(rel)} for ${rel}`);
        }
      } else if (rel in current && recorded[rel] !== current[rel]) problems.push(`${rel} changed after dist/ was built`);
    }
    for (const rel of Object.keys(recorded)) if (!listed.has(rel)) problems.push(`dist/ still contains output of ${rel}, which no longer exists`, `${compiledOf(rel)} has no source file: stale build output`);

    let tsconfig = null;
    const read = readThen(scan, 'tsconfig.json', { maxBytes: scan.limits.maxMetadataBytes }, (data) => {
      tsconfig = sha256(data);
    });
    if (!read.ok) problems.push(read.missing ? 'tsconfig.json is missing' : read.problem);
    else if (manifest.tsconfig !== tsconfig) problems.push('tsconfig.json changed after dist/ was built');

    inspectOutput(scan, manifest, markers);
    return [...new Set(problems)];
  });
}

// Called once tsc has succeeded (`npm run build` runs `clean && tsc && write`). Every source must have exactly one compiled
// output and dist/ must hold nothing else, because the hashes are recorded for what is there; anything else fails the build
// instead of being recorded. Sources and outputs are read one at a time within the same limits as verification; a limit that is
// reached fails the build and nothing is written.
export function writeManifest(root, options = {}) {
  const scan = newScan(root, options);
  const fail = (extra = []) => {
    throw new Error(`cannot record the build:\n${[...new Set([...scan.problems, ...extra])].map((p) => `  - ${p}`).join('\n')}`);
  };
  let manifest;
  try {
    const files = collectSources(scan);
    const sources = hashSources(scan, files);
    const outputs = {};
    const budget = budgetOf('compiled outputs', scan.limits.maxTotalOutputBytes);
    for (const rel of files) {
      const out = compiledOf(rel);
      const read = readThen(scan, out, { maxBytes: scan.limits.maxOutputBytes, budget }, (data) => {
        outputs[out] = sha256(data);
        scan.stats.outputsHashed += 1;
      });
      if (!read.ok) scan.problems.push(read.missing ? `missing build output ${out} for ${rel}` : read.problem);
    }
    let tsconfig = '0'.repeat(64);
    const read = readThen(scan, 'tsconfig.json', { maxBytes: scan.limits.maxMetadataBytes }, (data) => {
      tsconfig = sha256(data);
    });
    if (!read.ok) scan.problems.push(read.missing ? 'tsconfig.json is missing' : read.problem);
    manifest = { version: MANIFEST_VERSION, tsconfig, sources, outputs };
    scan.problems.push(...manifestProblems(manifest, scan.limits));
    if (!scan.problems.length) scanDist(scan, new Set(Object.keys(outputs)));
  } catch (err) {
    if (err instanceof LimitError) fail([`a limit was reached: ${err.message}`]);
    throw err;
  }
  if (scan.problems.length) fail();
  fs.writeFileSync(path.join(root, 'dist', MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '..');
  const command = process.argv[2] ?? 'verify';
  if (command === 'clean') {
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  } else if (command === 'write') {
    try {
      const { sources, outputs } = writeManifest(root);
      console.error(`dist/${MANIFEST} written for ${Object.keys(sources).length} source files and ${Object.keys(outputs).length} compiled files`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (command === 'verify') {
    let problems;
    try {
      problems = verifyDist(root);
    } catch (err) {
      console.error(`dist/ could not be verified: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (problems.length) {
      console.error(`dist/ is not a faithful build of src/ (${problems.length} problem(s)); run \`npm run build\`:`);
      for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.error('dist/ matches src/');
  } else {
    console.error('usage: node scripts/dist-integrity.mjs clean|write|verify');
    process.exit(2);
  }
}
