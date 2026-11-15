// `hash` (sha256 of the file bytes) is the only validity check; size and mtime are recorded for diagnostics.
// Bump when the shape of the extracted file info changes; the file cache is rebuilt on mismatch.
export const CACHE_VERSION = 7;

// The cache is read from .guardian/cache.db, which a repository can ship, so every dimension of it is bounded before any
// expensive work (signature checks, JSON parsing) is done on it. The numbers sit above what a real run produces: rows are
// at most config.maxFiles (20000 at most, 5000 by default), and a file of config.maxFileKb (1024 at most) yields a result
// far below maxInfoBytes. A cache beyond a limit is not used; the session falls back to an in-memory cache.
export type CacheLimits = {
  // cache.db plus its -wal, -shm and -journal files. Larger files are not opened.
  maxDbBytes: number;
  // Rows in the files table. More rows than this and the file is not opened.
  maxRows: number;
  // One stored result, as JSON text. Larger values are rejected before their signature is computed.
  maxInfoBytes: number;
  // The path of one row, in bytes.
  maxPathBytes: number;
  // All results read in one load together; rows beyond the budget are recomputed instead of read.
  maxLoadBytes: number;
  // Rows of the unsigned usage table that are kept (recordUsage enforces this on every write, openDb once more when the file is
  // opened), and the largest token count that is believed. Rows that are trimmed away are not lost to the lifetime statistics:
  // their totals are folded into the single row of usage_archive.
  maxUsageRows: number;
  maxUsageTokens: number;
};

export const CACHE_LIMITS: CacheLimits = {
  maxDbBytes: 128 * 1024 * 1024,
  maxRows: 20_000,
  maxInfoBytes: 4 * 1024 * 1024,
  maxPathBytes: 4096,
  maxLoadBytes: 64 * 1024 * 1024,
  maxUsageRows: 100_000,
  maxUsageTokens: 1_000_000_000,
};

export const schema = `
CREATE TABLE IF NOT EXISTS files (
  path     TEXT PRIMARY KEY,
  hash     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  info     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  raw_tokens  INTEGER NOT NULL,
  sent_tokens INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_archive (
  id          INTEGER PRIMARY KEY,
  calls       INTEGER NOT NULL,
  raw_tokens  INTEGER NOT NULL,
  sent_tokens INTEGER NOT NULL
);
`;
