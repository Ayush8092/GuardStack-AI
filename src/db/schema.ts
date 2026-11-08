// `hash` (sha256 of the file bytes) is the only validity check; size and mtime are recorded for diagnostics.
// Bump when the shape of the extracted file info changes; the file cache is rebuilt on mismatch.
export const CACHE_VERSION = 6;

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
`;
