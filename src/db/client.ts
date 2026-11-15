import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { UnsafeFileError, createFileExclusive, hardLinkMessage, isHardLinked, regularFileIdentity, type FileIdentity } from '../core/security/safe-file.js';
import { resolveInside } from '../core/security/sandbox.js';
import { errorCode, errorMessage } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { SEALED_OVERHEAD, loadMachineKey, openInfo, sealInfo } from './cache-key.js';
import { CACHE_LIMITS, CACHE_VERSION, schema, type CacheLimits } from './schema.js';
import { currentSchemaProblem, inspectSchema } from './schema-check.js';

export type Db = Database.Database;

export type CachedFile = {
  path: string;
  hash: string;
  size: number;
  mtime_ms: number;
  info: string;
};

export type CacheWrite =
  | { kind: 'save'; row: CachedFile }
  | { kind: 'touch'; path: string; size: number; mtime_ms: number };

const STATE_DIR = '.guardian';
const DB_NAME = 'cache.db';
// SQLite opens these next to the database by path. A planted link here would redirect its writes, so they are checked too.
const SIDECARS = ['-wal', '-shm', '-journal'];
// better-sqlite3 reports extended result codes, so a damaged file can arrive as SQLITE_CORRUPT_INDEX, SQLITE_CORRUPT_VTAB, ...
const isCorruptionCode = (code: string): boolean => code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_');

// Test seams for the permission step. Each runs at one exact point so a test can swap .guardian there; production callers pass
// none. beforePermissionOpen: after the path checks, before the directory is opened. afterPermissionOpen: the descriptor is open
// and verified, before fchmod. afterPermissionChange: after fchmod, before the path is checked once more.
export type PrepareHooks = { beforePermissionOpen?: () => void; afterPermissionOpen?: () => void; afterPermissionChange?: () => void };

// Tightens the permissions of the state directory through a descriptor, never through the path. chmod(path) follows symbolic
// links, so a lstat followed by a chmod lets a .guardian that is swapped for a link in between redirect the change to its
// target. Here the directory is opened with O_DIRECTORY | O_NOFOLLOW (a link in the last position makes the open fail), the
// descriptor is checked with fstat to be a directory with the very identity (dev, ino) that the earlier lstat saw, and only then
// is the mode changed, with fchmod on that descriptor, which cannot reach any other object.
// The result is verified, not assumed: after the change the mode is read back with fstat on the same descriptor and must be exactly
// 0700. A failed fchmod is not an error in itself (the directory may already be 0700, or the file system may refuse the call), but
// then the directory is only used if that read-back shows 0700; otherwise it is rejected. Nothing that cannot be verified is trusted
// (a failing fstat, no O_DIRECTORY or O_NOFOLLOW on this platform, a link, a replaced or non-directory entry, permission bits other
// than 0700), and the caller then keeps the cache in memory. Afterwards the path must still name the same directory, and the
// descriptor is closed on every path out.
// Windows has no meaningful mode bits (the key and cache protections there are ACL based) and keeps its behaviour: no change.
function tightenStateDir(dir: string, hooks: PrepareHooks): boolean {
  if (process.platform === 'win32') return true;
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  if (O_DIRECTORY === undefined || O_NOFOLLOW === undefined || typeof fs.fchmodSync !== 'function') {
    log.warn(`Cannot verify ${dir} safely on this platform`);
    return false;
  }
  let fd: number | null = null;
  try {
    const seen = fs.lstatSync(dir, { bigint: true });
    if (seen.isSymbolicLink() || !seen.isDirectory()) throw new UnsafeFileError(`${STATE_DIR} is not a plain directory`);
    hooks.beforePermissionOpen?.();
    fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const held = fs.fstatSync(fd, { bigint: true });
    if (!held.isDirectory() || held.ino !== seen.ino || held.dev !== seen.dev) throw new UnsafeFileError(`${STATE_DIR} was replaced while it was being checked`);
    hooks.afterPermissionOpen?.();
    let changeFailure: string | null = null;
    try {
      fs.fchmodSync(fd, 0o700);
    } catch (err) {
      changeFailure = errorCode(err) ?? errorMessage(err);
    }
    hooks.afterPermissionChange?.();
    // What the directory now has, read from the descriptor that fchmod acted on (not from the path). Whether or not the change
    // succeeded, the cache is trusted only if the verified directory really is 0700.
    const applied = fs.fstatSync(fd, { bigint: true });
    if (!applied.isDirectory() || applied.ino !== held.ino || applied.dev !== held.dev) throw new UnsafeFileError(`${STATE_DIR} was replaced while its permissions were being set`);
    const mode = applied.mode & 0o777n;
    if (mode !== 0o700n) {
      const shown = `0${mode.toString(8)}`;
      throw new UnsafeFileError(changeFailure === null ? `${STATE_DIR} has permissions ${shown} after they were set to 0700, which could not be confirmed` : `${STATE_DIR} has permissions ${shown} and they could not be changed to 0700 (${changeFailure})`);
    }
    if (changeFailure !== null) log.debug(`Could not tighten permissions on ${dir} (${changeFailure}), but it already has 0700`);
    const now = fs.lstatSync(dir, { bigint: true });
    if (now.isSymbolicLink() || !now.isDirectory() || now.ino !== held.ino || now.dev !== held.dev) throw new UnsafeFileError(`${STATE_DIR} was replaced while its permissions were being set`);
    return true;
  } catch (err) {
    log.warn(`Cannot use ${dir} (${err instanceof UnsafeFileError ? err.message : (errorCode(err) ?? errorMessage(err))}), caching in memory for this session`);
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

export function prepareStateDir(root: string, hooks: PrepareHooks = {}): string | null {
  const dir = path.join(root, STATE_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    resolveInside(root, STATE_DIR);
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    log.warn(`Cannot use ${dir} (${errorCode(err) ?? errorMessage(err)}), caching in memory for this session`);
    return null;
  }
  return tightenStateDir(dir, hooks) ? dir : null;
}

// The cache directory, as it was verified: the identity of the directory itself, not merely its path. Every later step
// (creating cache.db, opening it, deleting a corrupt one) first proves that the path still names this very directory, so
// a .guardian replaced by a symlink, or by another directory, after the checks is noticed and nothing is done through it.
// On Linux the directory is also held open, and the destructive steps go through that descriptor, which names this
// directory however the path is changed afterwards. Node has no openat(), and SQLite opens cache.db and its sidecars by
// path, so on other platforms (and for SQLite everywhere) the protection is: verify immediately before and immediately
// after, and give up on the file cache when anything differs. A swap in the instant between a check and the next call
// cannot be excluded there; it is detected before SQLite writes anything where the order allows, and never followed by
// a delete.
type StateDir = {
  dir: string;
  realDir: string;
  identity: FileIdentity;
  // The path of an entry of this directory: through the held descriptor where there is one, otherwise by path.
  at: (name: string) => string;
  release: () => void;
};

// What was verified about cache.db before SQLite is allowed to touch it.
type Guard = { state: StateDir; file: string; identity: FileIdentity };

export type OpenHooks = PrepareHooks & {
  // Runs once the directory is bound, before cache.db is checked or created. Tests swap the directory here.
  afterStateDir?: () => void;
  // Runs between the checks and the open. Tests use it to swap cache.db or the directory at exactly the wrong moment.
  afterGuard?: () => void;
  // Runs after a corruption was detected, before anything is deleted.
  beforeRecovery?: () => void;
};

// A database that opens fine but is not the supported cache: a schema that differs from schema.ts in any way (virtual tables,
// triggers or views that run inside our own statements, other indexes, other column types or constraints, an unsupported
// version). Checked with SQLite's own introspection (schema-check.ts). Treated like corruption: replaced, never trusted.
class PoisonedCacheError extends Error {
  constructor(what: string) {
    super(`${DB_NAME} is not the supported cache: ${what}`);
    this.name = 'PoisonedCacheError';
  }
}

// A cache.db that is larger than the limits allow. Not corruption and not an attack that can be repaired by deleting the file
// (it may be tracked by the repository), so it is never recovered or deleted: the session uses an in-memory cache.
class CacheLimitError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'CacheLimitError';
  }
}

// The size on disk of cache.db and its sidecars, checked before SQLite opens anything: opening and scanning a database costs
// time proportional to its size, and a repository chooses that size.
function assertCacheSize(file: string, limits: CacheLimits): void {
  let total = 0;
  for (const suffix of ['', ...SIDECARS]) {
    try {
      total += fs.lstatSync(`${file}${suffix}`).size;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
  }
  if (total > limits.maxDbBytes) throw new CacheLimitError(`${DB_NAME} and its journal files take ${Math.ceil(total / 1048576)} MiB, over the ${limits.maxDbBytes / 1048576} MiB limit`);
}

// Counting stops one row past the limit, so a table with millions of rows costs no more to refuse than one just over it.
function assertRowCount(db: Db, limits: CacheLimits): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM files LIMIT ?)').get(limits.maxRows + 1) as { n: number };
  if (n > limits.maxRows) throw new CacheLimitError(`the files table has more than ${limits.maxRows} rows`);
}

// The usage table is unsigned statistics: only the newest rows are kept, so it cannot grow without bound. This is the trim for a table
// that arrives with the file (shipped, or from a version that did not trim while running); recordUsage keeps it within the limit after
// that. Rows that came with the file were never counted by this installation, so they are dropped, not archived.
function trimUsage(db: Db, limits: CacheLimits): void {
  db.prepare('DELETE FROM usage WHERE id <= (SELECT MAX(id) FROM usage) - ?').run(limits.maxUsageRows);
}

function realDirectory(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    throw new UnsafeFileError('the cache directory changed while it was being opened');
  }
}

function assertSameDirectory(state: StateDir): void {
  const replaced = () => new UnsafeFileError('the cache directory was replaced while it was being used');
  let now: fs.BigIntStats;
  try {
    now = fs.lstatSync(state.dir, { bigint: true });
  } catch {
    throw replaced();
  }
  if (now.isSymbolicLink() || !now.isDirectory() || now.ino !== state.identity.ino || now.dev !== state.identity.dev || realDirectory(state.dir) !== state.realDir) throw replaced();
}

function bindStateDir(dir: string): StateDir {
  const found = fs.lstatSync(dir, { bigint: true });
  if (found.isSymbolicLink() || !found.isDirectory()) throw new UnsafeFileError(`${STATE_DIR} is not a plain directory`);
  const state: StateDir = { dir, realDir: realDirectory(dir), identity: { dev: found.dev, ino: found.ino }, at: (name) => path.join(dir, name), release: () => undefined };

  if (process.platform === 'linux' && fs.constants.O_DIRECTORY !== undefined) {
    try {
      const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
      const held = fs.fstatSync(fd, { bigint: true });
      if (held.ino === state.identity.ino && held.dev === state.identity.dev && fs.statSync(`/proc/self/fd/${fd}`).isDirectory()) {
        state.at = (name) => `/proc/self/fd/${fd}/${name}`;
        state.release = () => fs.closeSync(fd);
      } else {
        fs.closeSync(fd);
      }
    } catch {
      /* no /proc or no descriptor: the path-based checks still apply */
    }
  }
  try {
    assertSameDirectory(state);
  } catch (err) {
    state.release();
    throw err;
  }
  return state;
}

// Deletes one entry of the bound directory, only after proving that the directory is still the verified one and that
// the entry is a plain, singly linked file (and, when given, the very file that was checked earlier). Anything else is
// refused, not deleted.
function removeVerified(state: StateDir, name: string, expected?: FileIdentity): void {
  assertSameDirectory(state);
  const target = state.at(name);
  let found: fs.BigIntStats;
  try {
    found = fs.lstatSync(target, { bigint: true });
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  if (found.isSymbolicLink() || !found.isFile()) throw new UnsafeFileError(`${name} is not a regular file, it was left in place`);
  if (isHardLinked(found)) throw new UnsafeFileError(`${hardLinkMessage(name)}, it was left in place`);
  if (expected && (found.ino !== expected.ino || found.dev !== expected.dev)) throw new UnsafeFileError(`${name} is not the file that was checked, it was left in place`);
  fs.unlinkSync(target);
}

// Refuses a symlinked or non-regular cache.db and sidecars, and creates a missing cache.db exclusively. SQLite then
// only ever opens a plain file that already exists, so it cannot create or follow anything through a planted link.
function guardDatabaseFile(state: StateDir): Guard {
  const file = path.join(state.dir, DB_NAME);
  assertSameDirectory(state);
  for (const suffix of SIDECARS) regularFileIdentity(`${file}${suffix}`);
  createFileExclusive(state.dir, DB_NAME, '', 0o600);
  assertSameDirectory(state);
  const identity = regularFileIdentity(file);
  if (!identity) throw new UnsafeFileError(`${DB_NAME} could not be created`);
  assertSameDirectory(state);
  return { state, file, identity };
}

function verifyGuard(guard: Guard): void {
  assertSameDirectory(guard.state);
  const now = regularFileIdentity(guard.file);
  if (!now || now.ino !== guard.identity.ino || now.dev !== guard.identity.dev) throw new UnsafeFileError(`${DB_NAME} was replaced while it was being opened`);
  for (const suffix of SIDECARS) regularFileIdentity(`${guard.file}${suffix}`);
}

// Every database handle has the key its rows are signed with. A handle opened by openDb gets the machine key; one that
// was not (an in-memory cache, a handle made directly) gets a random key of its own, which is enough because nothing
// outside the process can put rows into it.
const keys = new WeakMap<Db, Buffer>();
function keyOf(db: Db): Buffer {
  let key = keys.get(db);
  if (!key) {
    key = crypto.randomBytes(32);
    keys.set(db, key);
  }
  return key;
}

function openMemory(): Db {
  try {
    return open(':memory:');
  } catch (err) {
    throw new Error(`Cannot create an in-memory SQLite database: ${errorMessage(err)}`);
  }
}

function open(file: string, guard?: Guard, limits: CacheLimits = CACHE_LIMITS): Db {
  // Size first, before SQLite reads a byte of it.
  if (guard) assertCacheSize(file, limits);
  // A constructor failure leaves no handle to close; it propagates to the caller, which never treats it as a reason to delete.
  const db = new Database(file, guard ? { fileMustExist: true } : undefined);
  try {
    // Nothing below writes until the path is confirmed to still name the file that was checked.
    if (guard) verifyGuard(guard);
    db.pragma('trusted_schema = OFF');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    if (guard) verifyGuard(guard);
    db.pragma('synchronous = NORMAL');
    db.transaction(() => {
      // The structure is inspected before anything is created, dropped or migrated: nothing runs against a schema that has not
      // been checked, and a database that is not the supported cache is refused (and then replaced), never repaired in place.
      const inspected = inspectSchema(db, db.pragma('user_version', { simple: true }) as number);
      if (inspected.problem !== null) throw new PoisonedCacheError(inspected.problem);
      if (inspected.state === 'migrate') {
        // A supported older version: its file results are rebuilt (the row format changed), its usage statistics are kept.
        db.exec('DROP TABLE IF EXISTS files');
      }
      if (inspected.state !== 'current') db.pragma(`user_version = ${CACHE_VERSION}`);
      db.exec(schema);
      // CREATE TABLE IF NOT EXISTS keeps a table that was already there; the finished structure must be exactly the supported one.
      const unexpected = currentSchemaProblem(db);
      if (unexpected !== null) throw new PoisonedCacheError(unexpected);
      // A valid schema says nothing about what is in the tables.
      assertRowCount(db, limits);
      trimUsage(db, limits);
    }).immediate();
    // Whatever the file held, it cannot grow past the limit through this handle either.
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    if (pageSize > 0) db.pragma(`max_page_count = ${Math.max(1, Math.floor(limits.maxDbBytes / pageSize))}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

const recoverable = (err: unknown): boolean => err instanceof PoisonedCacheError || isCorruptionCode(errorCode(err) ?? '');

export function openDb(root: string, hooks: OpenHooks = {}, limits: CacheLimits = CACHE_LIMITS): Db {
  const dir = prepareStateDir(root, hooks);
  if (!dir) return openMemory();

  const inMemory = (reason: string): Db => {
    log.warn(`${reason}, caching in memory`);
    return openMemory();
  };
  const withKey = (db: Db, key: Buffer): Db => {
    keys.set(db, key);
    return db;
  };

  // Rows are signed with a key kept outside the workspace; without one the file cache could not be trusted.
  const key = loadMachineKey(root);
  if (!key) return openMemory();

  let state: StateDir;
  try {
    state = bindStateDir(dir);
  } catch (err) {
    return inMemory(`Cannot use ${dir} (${errorMessage(err)}), it was left untouched`);
  }

  try {
    hooks.afterStateDir?.();
    let guard: Guard;
    try {
      guard = guardDatabaseFile(state);
    } catch (err) {
      const refused = err instanceof UnsafeFileError;
      return inMemory(`${refused ? 'Refusing to use' : 'Cannot use'} ${path.join(dir, DB_NAME)} (${errorMessage(err)})${refused ? ', it was left untouched' : ''}`);
    }

    try {
      hooks.afterGuard?.();
      return withKey(open(guard.file, guard, limits), key);
    } catch (err) {
      if (!recoverable(err)) return inMemory(`Could not open ${DB_NAME} (${errorMessage(err)})`);
      log.warn(`${DB_NAME} is corrupted or not a plain cache, rebuilding it`);
    }

    // Recovery deletes files, so every delete is preceded by proof that the directory and the file are the ones that were
    // verified; if anything differs nothing is deleted and the session uses memory.
    try {
      hooks.beforeRecovery?.();
      removeVerified(state, DB_NAME, guard.identity);
      for (const suffix of SIDECARS) removeVerified(state, `${DB_NAME}${suffix}`);
      const fresh = guardDatabaseFile(state);
      return withKey(open(fresh.file, fresh, limits), key);
    } catch (retryErr) {
      return inMemory(`Could not recreate ${DB_NAME} (${errorMessage(retryErr)})`);
    }
  } finally {
    state.release();
  }
}

export function closeDb(db: Db): void {
  try {
    db.close();
  } catch (err) {
    log.debug(`Closing the database failed: ${errorMessage(err)}`);
  }
}

// The path of a row, as a file of the workspace is named in the cache: relative, no NUL, nothing that climbs out.
function validCachePath(file: string, limits: CacheLimits): boolean {
  return (
    file.length > 0 &&
    file.length <= limits.maxPathBytes &&
    Buffer.byteLength(file) <= limits.maxPathBytes &&
    !file.includes('\0') &&
    !file.startsWith('/') &&
    !/^[A-Za-z]:/.test(file) &&
    !file.split('/').includes('..')
  );
}

// A content hash is a short run of letters and digits (SHA-256 hex in practice).
const validCacheHash = (hash: string): boolean => /^[0-9A-Za-z]{1,128}$/.test(hash);

// Only rows that can be believed are read, and only as many as the limits allow. The WHERE clause rejects a row of the wrong
// type or size inside SQLite, so a huge value is never copied into the process; iterate() hands rows over one at a time
// instead of building the whole result; and the total read is capped before any signature is computed.
export function loadCache(db: Db, limits: CacheLimits = CACHE_LIMITS): Map<string, CachedFile> {
  try {
    const key = keyOf(db);
    assertRowCount(db, limits);
    const select = db.prepare(
      `SELECT path, hash, size, mtime_ms, info FROM files
       WHERE typeof(path) = 'text' AND length(CAST(path AS BLOB)) BETWEEN 1 AND @maxPath
         AND typeof(hash) = 'text' AND length(hash) BETWEEN 1 AND 128
         AND typeof(size) IN ('integer', 'real') AND typeof(mtime_ms) IN ('integer', 'real')
         AND typeof(info) = 'text' AND length(CAST(info AS BLOB)) <= @maxInfo
       ORDER BY rowid LIMIT @maxRows`,
    );
    const trusted = new Map<string, CachedFile>();
    let seen = 0;
    let rejected = 0;
    let budget = limits.maxLoadBytes;
    let overBudget = false;
    for (const row of select.iterate({ maxPath: limits.maxPathBytes, maxInfo: limits.maxInfoBytes + SEALED_OVERHEAD, maxRows: limits.maxRows }) as IterableIterator<CachedFile>) {
      seen++;
      if (!validCachePath(row.path, limits) || !validCacheHash(row.hash) || !Number.isFinite(row.size) || !Number.isFinite(row.mtime_ms)) {
        rejected++;
        continue;
      }
      // The budget is in bytes of stored data, like every other cache limit: .length counts UTF-16 code units, which is a quarter to a
      // third of the bytes for text outside ASCII. The query already bounds each value, so counting the bytes of one is cheap. The budget
      // is spent before the signature is computed, so the work done on a database has a ceiling however it is filled.
      const bytes = Buffer.byteLength(row.info, 'utf8');
      if (bytes > budget) {
        overBudget = true;
        break;
      }
      budget -= bytes;
      // A row only counts when it carries a signature made with this machine's key for exactly this path and hash.
      const info = openInfo(key, row.path, row.hash, row.info);
      if (info === null) rejected++;
      else trusted.set(row.path, { ...row, info });
    }
    // Rows the query itself left out (wrong type, too long) were never read; they count as rejected too.
    const total = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
    if (!overBudget) rejected += Math.max(0, total - seen);
    if (rejected > 0) log.warn(`${rejected} cached result(s) were not written by this installation, or were malformed or oversized, and will be recomputed`);
    if (overBudget) log.warn(`The cache holds more than ${Math.floor(limits.maxLoadBytes / 1048576)} MiB of results; the rest will be recomputed`);
    return trusted;
  } catch (err) {
    log.warn(`Cache unreadable, re-parsing everything: ${errorMessage(err)}`);
    return new Map();
  }
}

// `retain` is every path that still exists and is eligible, whether or not this run indexed it.
// Without it nothing is pruned: used when the scan stopped early and so does not know every path.
export function applyCacheWrites(db: Db, writes: CacheWrite[], retain?: Set<string>, limits: CacheLimits = CACHE_LIMITS): void {
  const save = db.prepare(
    `INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (@path, @hash, @size, @mtime_ms, @info)
     ON CONFLICT(path) DO UPDATE SET hash = @hash, size = @size, mtime_ms = @mtime_ms, info = @info`,
  );
  const touch = db.prepare('UPDATE files SET size = @size, mtime_ms = @mtime_ms WHERE path = @path');
  const remove = db.prepare('DELETE FROM files WHERE path = ?');
  const key = keyOf(db);

  db.transaction(() => {
    for (const write of writes) {
      if (write.kind === 'touch') {
        touch.run(write);
        continue;
      }
      // A result that loadCache would refuse is not stored; the file is simply parsed again next time, and an older row for it is dropped.
      const { row } = write;
      if (!validCachePath(row.path, limits) || !validCacheHash(row.hash) || Buffer.byteLength(row.info) > limits.maxInfoBytes) {
        log.debug(`Not caching ${row.path.slice(0, 200)}: the result is too large or the entry is malformed`);
        remove.run(row.path);
        continue;
      }
      save.run({ ...row, info: sealInfo(key, row.path, row.hash, row.info) });
    }
    if (retain) {
      // Done inside SQLite from a temporary table: a database that holds many or huge rows is never read into the process.
      db.exec('CREATE TEMP TABLE IF NOT EXISTS temp.retain_paths (path TEXT PRIMARY KEY); DELETE FROM temp.retain_paths');
      const keep = db.prepare('INSERT OR IGNORE INTO temp.retain_paths (path) VALUES (?)');
      for (const kept of retain) keep.run(kept);
      db.exec('DELETE FROM files WHERE NOT EXISTS (SELECT 1 FROM temp.retain_paths r WHERE r.path = files.path); DROP TABLE temp.retain_paths');
    }
    // The table never ends a run above the row limit: the oldest rows (lowest rowid) are the ones to go.
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    if (n > limits.maxRows) db.prepare('DELETE FROM files WHERE rowid IN (SELECT rowid FROM files ORDER BY rowid LIMIT ?)').run(n - limits.maxRows);
  }).immediate();
}

// The statements of the usage table, in one place so that a test can ask SQLite how each one is executed (EXPLAIN QUERY PLAN): none
// of them may scan the table. `id` is the rowid, so every range below is a b-tree seek that touches only the rows it names.
export const USAGE_SQL = {
  insert: 'INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (?, ?, ?, ?)',
  // What is about to be trimmed away: its row count and the same believable-value sums that lifetimeUsage computes.
  expiring: `SELECT COUNT(*) AS calls, COALESCE(SUM(${believable('raw_tokens')}), 0) AS raw, COALESCE(SUM(${believable('sent_tokens')}), 0) AS sent FROM usage WHERE id <= @cutoff`,
  archive: `INSERT INTO usage_archive (id, calls, raw_tokens, sent_tokens) VALUES (1, @calls, @raw, @sent)
    ON CONFLICT(id) DO UPDATE SET calls = MIN(CASE WHEN typeof(calls) = 'integer' AND calls BETWEEN 0 AND @cap THEN calls ELSE 0 END + @calls, @cap),
      raw_tokens = MIN(CASE WHEN typeof(raw_tokens) = 'integer' AND raw_tokens BETWEEN 0 AND @cap THEN raw_tokens ELSE 0 END + @raw, @cap),
      sent_tokens = MIN(CASE WHEN typeof(sent_tokens) = 'integer' AND sent_tokens BETWEEN 0 AND @cap THEN sent_tokens ELSE 0 END + @sent, @cap)`,
  trim: 'DELETE FROM usage WHERE id <= ?',
} as const;

function believable(column: string): string {
  return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND @maxTokens THEN ${column} ELSE 0 END`;
}

// The largest total that is kept: every number handed back is a safe integer, however the tables were filled.
const TOTAL_CAP = Number.MAX_SAFE_INTEGER;

// Every call is one transaction: the row is added, and in the same transaction the rows beyond the newest `maxUsageRows` are folded
// into usage_archive and deleted. So the table is within the limit after every write, not just when the file is opened, and the
// lifetime totals do not lose what is trimmed.
// - Bounded work. `id` is an AUTOINCREMENT rowid: the new row has the highest id, the rows to trim are exactly those with
//   id <= newest - limit, and both the count/sum and the delete are range seeks over that rowid range only. In steady state that is
//   one row per call; nothing counts the table or scans it.
// - Concurrent writers (the server and a CLI run on the same cache.db). BEGIN IMMEDIATE takes the write lock up front, and ids only
//   ever increase, so whichever order the writers run in, each one leaves at most `maxUsageRows` rows with ids above its own cutoff.
//   A writer that cannot get the lock within busy_timeout drops its record.
// - Failure. Any error (locked, read-only, disk or page limit, a damaged table) rolls the whole transaction back, so the table never
//   holds the row without its trim, and the error is not thrown: statistics must never break a tool call.
export function recordUsage(db: Db, tool: string, rawTokens: number, sentTokens: number, limits: CacheLimits = CACHE_LIMITS): void {
  try {
    db.transaction(() => {
      const inserted = db.prepare(USAGE_SQL.insert).run(Date.now(), tool, rawTokens, sentTokens);
      const cutoff = Number(inserted.lastInsertRowid) - limits.maxUsageRows;
      if (!(cutoff > 0)) return;
      const gone = db.prepare(USAGE_SQL.expiring).get({ cutoff, maxTokens: limits.maxUsageTokens }) as { calls: number; raw: number; sent: number };
      if (gone.calls > 0) {
        db.prepare(USAGE_SQL.archive).run({ calls: gone.calls, raw: gone.raw, sent: gone.sent, cap: TOTAL_CAP });
        db.prepare(USAGE_SQL.trim).run(cutoff);
      }
    }).immediate();
  } catch (err) {
    log.debug(`Usage not recorded: ${errorMessage(err)}`);
  }
}

// Unsigned statistics. The total is what usage_archive holds (rows that were trimmed away) plus the rows still in the table. Only
// the newest `maxUsageRows` rows are read, and a value that is not a plausible token count counts as 0, so a crafted table can
// neither make this scan unbounded nor skew the totals beyond what the limits allow. Archived values are used only when they are
// non-negative safe integers, and the result is capped at the largest safe integer.
export function lifetimeUsage(db: Db, limits: CacheLimits = CACHE_LIMITS): { calls: number; raw: number; sent: number } {
  try {
    const live = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(r), 0) AS raw, COALESCE(SUM(s), 0) AS sent FROM (
           SELECT ${believable('raw_tokens')} AS r, ${believable('sent_tokens')} AS s FROM usage ORDER BY id DESC LIMIT @maxRows
         )`,
      )
      .get({ maxTokens: limits.maxUsageTokens, maxRows: limits.maxUsageRows }) as { calls: number; raw: number; sent: number };
    const archived = archivedUsage(db);
    const total = (a: number, b: number): number => Math.min(a + b, TOTAL_CAP);
    return { calls: total(live.calls, archived.calls), raw: total(live.raw, archived.raw), sent: total(live.sent, archived.sent) };
  } catch {
    return { calls: 0, raw: 0, sent: 0 };
  }
}

function archivedUsage(db: Db): { calls: number; raw: number; sent: number } {
  const none = { calls: 0, raw: 0, sent: 0 };
  try {
    const row = db.prepare('SELECT calls, raw_tokens AS raw, sent_tokens AS sent FROM usage_archive WHERE id = 1').get() as { calls: unknown; raw: unknown; sent: unknown } | undefined;
    if (!row) return none;
    const sane = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
    return { calls: sane(row.calls), raw: sane(row.raw), sent: sane(row.sent) };
  } catch {
    return none;
  }
}
