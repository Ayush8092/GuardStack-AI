import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveInside } from '../core/security/sandbox.js';
import { errorCode, errorMessage } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { CACHE_VERSION, schema } from './schema.js';

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
const CORRUPTION_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);

export function prepareStateDir(root: string): string | null {
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
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      log.debug(`Could not tighten permissions on ${dir}`);
    }
  }
  return dir;
}

function open(file: string): Db {
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.transaction(() => {
      if (db.pragma('user_version', { simple: true }) !== CACHE_VERSION) {
        db.exec('DROP TABLE IF EXISTS files');
        db.pragma(`user_version = ${CACHE_VERSION}`);
      }
      db.exec(schema);
    }).immediate();
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function openDb(root: string): Db {
  const dir = prepareStateDir(root);
  if (!dir) return open(':memory:');

  const file = path.join(dir, 'cache.db');
  try {
    return open(file);
  } catch (err) {
    if (!CORRUPTION_CODES.has(errorCode(err) ?? '')) {
      log.warn(`Could not open cache.db (${errorMessage(err)}), caching in memory`);
      return open(':memory:');
    }
    log.warn('cache.db is corrupted, rebuilding it');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    try {
      return open(file);
    } catch (retryErr) {
      log.warn(`Could not recreate cache.db (${errorMessage(retryErr)}), caching in memory`);
      return open(':memory:');
    }
  }
}

export function closeDb(db: Db): void {
  try {
    db.close();
  } catch (err) {
    log.debug(`Closing the database failed: ${errorMessage(err)}`);
  }
}

export function loadCache(db: Db): Map<string, CachedFile> {
  try {
    const rows = db.prepare('SELECT path, hash, size, mtime_ms, info FROM files').all() as CachedFile[];
    return new Map(rows.map((row) => [row.path, row]));
  } catch (err) {
    log.warn(`Cache unreadable, re-parsing everything: ${errorMessage(err)}`);
    return new Map();
  }
}

// `retain` is every path that still exists and is eligible, whether or not this run indexed it.
// Without it nothing is pruned: used when the scan stopped early and so does not know every path.
export function applyCacheWrites(db: Db, writes: CacheWrite[], retain?: Set<string>): void {
  const save = db.prepare(
    `INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (@path, @hash, @size, @mtime_ms, @info)
     ON CONFLICT(path) DO UPDATE SET hash = @hash, size = @size, mtime_ms = @mtime_ms, info = @info`,
  );
  const touch = db.prepare('UPDATE files SET size = @size, mtime_ms = @mtime_ms WHERE path = @path');
  const remove = db.prepare('DELETE FROM files WHERE path = ?');

  db.transaction(() => {
    for (const write of writes) {
      if (write.kind === 'save') save.run(write.row);
      else touch.run(write);
    }
    if (!retain) return;
    for (const { path: stored } of db.prepare('SELECT path FROM files').all() as { path: string }[]) {
      if (!retain.has(stored)) remove.run(stored);
    }
  }).immediate();
}

export function recordUsage(db: Db, tool: string, rawTokens: number, sentTokens: number): void {
  try {
    db.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (?, ?, ?, ?)').run(Date.now(), tool, rawTokens, sentTokens);
  } catch (err) {
    log.debug(`Usage not recorded: ${errorMessage(err)}`);
  }
}

export function lifetimeUsage(db: Db): { calls: number; raw: number; sent: number } {
  try {
    return db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(raw_tokens), 0) AS raw, COALESCE(SUM(sent_tokens), 0) AS sent FROM usage')
      .get() as { calls: number; raw: number; sent: number };
  } catch {
    return { calls: 0, raw: 0, sent: 0 };
  }
}
