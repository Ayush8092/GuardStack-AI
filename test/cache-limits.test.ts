import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { SEALED_OVERHEAD, loadMachineKey, openInfo, sealInfo } from '../src/db/cache-key.js';
import { applyCacheWrites, closeDb, lifetimeUsage, loadCache, openDb, recordUsage, type CachedFile, type Db } from '../src/db/client.js';
import { CACHE_LIMITS, CACHE_VERSION } from '../src/db/schema.js';

// The cache is read from .guardian/cache.db, which a repository can ship. The signature proves who wrote a row; these tests
// prove the other half: whatever is in the file, the memory and CPU spent on it have a ceiling, nothing is believed because
// the schema looks right, and a cache beyond the limits is not used (the session falls back to memory) instead of crashing.

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-limits-home-')));
// TEMP may grant broad inherited permissions. Keep the test machine-key directory
// private so loadMachineKey() can exercise persistent-cache paths on Windows.
if (process.platform === 'win32') {
  execFileSync('icacls.exe', [
    home,
    '/inheritance:r',
    '/grant:r', `*${currentUserSid()}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ], { stdio: 'ignore', windowsHide: true });
}
const roots: string[] = [];
const open: Db[] = [];
const saved = process.env.GUARDIAN_STATE_HOME;
let counter = 0;

beforeEach(() => {
  // A fresh machine key per test.
  process.env.GUARDIAN_STATE_HOME = path.join(home, `state-${counter++}`);
});
afterEach(() => {
  mock.restoreAll();
  open.splice(0).forEach(closeDb);
});
after(() => {
  if (saved === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = saved;
  for (const dir of [home, ...roots]) fs.rmSync(dir, { recursive: true, force: true });
});

const workspace = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-limits-')));
  roots.push(dir);
  return dir;
};
const cacheFile = (root: string): string => path.join(root, '.guardian', 'cache.db');
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const opened = (root: string): Db => {
  const db = openDb(root);
  open.push(db);
  return db;
};
const isMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const goodRow = (file: string, info = '{"ok":true}'): CachedFile => ({ path: file, hash: sha(file), size: 1, mtime_ms: 2, info });

// A cache.db that exists, has the real layout, and is closed again: the starting point for an attacker's edits.
function shipped(): string {
  const root = workspace();
  closeDb(opened(root));
  open.length = 0;
  return root;
}

function rawEdit(root: string, fn: (raw: Database.Database) => void): void {
  const raw = new Database(cacheFile(root));
  try {
    fn(raw);
  } finally {
    raw.close();
  }
}

// A row signed exactly as this installation signs (the attacker cannot do this; the test can, so that a row is rejected for
// its size or its fields and not merely because the signature is missing). sealInfo itself refuses oversized values.
function signed(key: Buffer, file: string, hash: string, info: string): string {
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(['guardian-cache', 1, file, hash, info])).digest('hex');
  return `g1.${mac}.${info}`;
}

const insert = (raw: Database.Database, file: string | Buffer, hash: string | Buffer, info: string): void => {
  raw.prepare('INSERT OR REPLACE INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)').run(file, hash, 1, 2, info);
};

// The number of signatures computed while fn runs.
function hmacCalls(fn: () => void): number {
  const spy = mock.method(crypto, 'createHmac');
  fn();
  const calls = spy.mock.callCount();
  spy.mock.restore();
  return calls;
}

test('the limits are finite and sit above what a real run produces', () => {
  assert.ok(CACHE_LIMITS.maxRows >= 20_000, 'config.maxFiles can be 20000');
  assert.ok(CACHE_LIMITS.maxInfoBytes >= 2 * 1024 * 1024 && CACHE_LIMITS.maxInfoBytes <= 16 * 1024 * 1024);
  assert.ok(CACHE_LIMITS.maxLoadBytes >= CACHE_LIMITS.maxInfoBytes && CACHE_LIMITS.maxDbBytes >= CACHE_LIMITS.maxLoadBytes);
  for (const [name, value] of Object.entries(CACHE_LIMITS)) assert.ok(Number.isSafeInteger(value) && value > 0, name);
});

// --- normal operation is unchanged ---------------------------------------------------------------------------------------

test('normal cache reuse still works: rows written in one session are read in the next', () => {
  const root = workspace();
  const first = opened(root);
  assert.equal(isMemory(first), false);
  applyCacheWrites(first, [{ kind: 'save', row: goodRow('src/a.ts', '{"a":1}') }, { kind: 'save', row: goodRow('src/b.ts', '{"b":1}') }]);
  closeDb(first);
  open.length = 0;

  const rows = loadCache(opened(root));
  assert.deepEqual([...rows.keys()].sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(rows.get('src/a.ts')?.info, '{"a":1}');
  assert.equal(rows.get('src/a.ts')?.hash, sha('src/a.ts'));
});

test('cache corruption recovery still works: a damaged file is rebuilt, not abandoned', () => {
  const root = shipped();
  fs.writeFileSync(cacheFile(root), Buffer.alloc(8192, 0x41));
  const db = opened(root);
  assert.equal(isMemory(db), false, 'the damaged file was replaced by a working one');
  applyCacheWrites(db, [{ kind: 'save', row: goodRow('a.ts') }]);
  assert.equal(loadCache(db).size, 1);
});

// --- size of the database --------------------------------------------------------------------------------------------------

test('a cache.db over the size limit is not opened: the session uses memory and the file is left alone', () => {
  const root = shipped();
  const size = CACHE_LIMITS.maxDbBytes + 1;
  fs.truncateSync(cacheFile(root), size); // sparse: costs nothing to create
  const db = opened(root);
  assert.equal(isMemory(db), true);
  assert.equal(fs.statSync(cacheFile(root)).size, size, 'the oversized file was neither deleted nor modified');
  applyCacheWrites(db, [{ kind: 'save', row: goodRow('a.ts') }]);
  assert.equal(loadCache(db).size, 1, 'the in-memory cache works');
});

test('a huge -wal file counts toward the size limit', () => {
  const root = shipped();
  const wal = `${cacheFile(root)}-wal`;
  fs.writeFileSync(wal, '', { mode: 0o600 });
  fs.truncateSync(wal, CACHE_LIMITS.maxDbBytes + 1); // sparse
  assert.equal(isMemory(opened(root)), true);
});

// --- number of rows ----------------------------------------------------------------------------------------------------------

test('more rows than the limit: not opened, memory fallback, file untouched', () => {
  const root = shipped();
  const key = loadMachineKey(root)!;
  rawEdit(root, (raw) => {
    const add = raw.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)');
    raw.transaction(() => {
      for (let i = 0; i <= CACHE_LIMITS.maxRows; i++) add.run(`f${i}.ts`, 'a'.repeat(64), 1, 1, signed(key, `f${i}.ts`, 'a'.repeat(64), '{}'));
    })();
  });
  const calls = hmacCalls(() => {
    const db = opened(root);
    assert.equal(isMemory(db), true);
    assert.equal(loadCache(db).size, 0, 'nothing from the oversized table is used, not even validly signed rows');
  });
  assert.equal(calls, 0, 'no signature was computed on the oversized table');
  rawEdit(root, (raw) => assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, CACHE_LIMITS.maxRows + 1));
});

test('many small unsigned rows, up to the limit: opened, read in bounded time, none believed', () => {
  const root = shipped();
  rawEdit(root, (raw) => {
    const add = raw.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)');
    raw.transaction(() => {
      for (let i = 0; i < CACHE_LIMITS.maxRows; i++) add.run(`f${i}.ts`, sha(String(i)), 1, 1, '{}');
    })();
  });
  const db = opened(root);
  assert.equal(isMemory(db), false);
  const calls = hmacCalls(() => assert.equal(loadCache(db).size, 0));
  assert.equal(calls, 0, 'unsigned values are turned away by their shape, with no signature computed');
});

test('many small rows with a signature-shaped prefix: every one is verified (cheaply) and rejected', () => {
  const root = shipped();
  rawEdit(root, (raw) => {
    const add = raw.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)');
    raw.transaction(() => {
      for (let i = 0; i < 2000; i++) add.run(`f${i}.ts`, sha(String(i)), 1, 1, `g1.${'0'.repeat(64)}.{}`);
    })();
  });
  assert.equal(loadCache(opened(root)).size, 0);
});

test('applyCacheWrites keeps the table within the row limit, evicting the oldest rows first', () => {
  const db = opened(workspace());
  const limits = { ...CACHE_LIMITS, maxRows: 5 };
  applyCacheWrites(db, [1, 2, 3, 4].map((i) => ({ kind: 'save' as const, row: goodRow(`old${i}.ts`) })), undefined, limits);
  applyCacheWrites(db, [1, 2, 3, 4].map((i) => ({ kind: 'save' as const, row: goodRow(`new${i}.ts`) })), undefined, limits);
  const names = [...loadCache(db, limits).keys()].sort();
  assert.equal(names.length, 5);
  assert.deepEqual(names.filter((n) => n.startsWith('new')), ['new1.ts', 'new2.ts', 'new3.ts', 'new4.ts'], 'this run\'s results survive');
});

// --- size of values ----------------------------------------------------------------------------------------------------------

test('an oversized value is rejected before any signature is computed, even when it carries a valid signature', () => {
  const root = shipped();
  const key = loadMachineKey(root)!;
  const huge = `{"pad":"${'x'.repeat(CACHE_LIMITS.maxInfoBytes)}"}`;
  rawEdit(root, (raw) => insert(raw, 'big.ts', sha('big.ts'), signed(key, 'big.ts', sha('big.ts'), huge)));
  const db = opened(root);
  assert.equal(isMemory(db), false, 'one oversized row does not make the whole cache unusable');
  const calls = hmacCalls(() => assert.equal(loadCache(db).size, 0));
  assert.equal(calls, 0);
});

test('a value of exactly the largest permitted size is still read', () => {
  const root = workspace();
  const db = opened(root);
  const info = `{"pad":"${'x'.repeat(CACHE_LIMITS.maxInfoBytes - 10)}"}`;
  assert.equal(Buffer.byteLength(info), CACHE_LIMITS.maxInfoBytes);
  applyCacheWrites(db, [{ kind: 'save', row: goodRow('edge.ts', info) }]);
  assert.equal(loadCache(db).get('edge.ts')?.info, info);
});

test('openInfo and sealInfo refuse oversized inputs before computing a signature', () => {
  const key = Buffer.alloc(32, 9);
  const oversized = 'x'.repeat(CACHE_LIMITS.maxInfoBytes + 1);
  // multi-byte characters: fewer characters than bytes, still over the byte limit
  const wide = '€'.repeat(Math.ceil(CACHE_LIMITS.maxInfoBytes / 3) + 1);
  const edge = 'x'.repeat(CACHE_LIMITS.maxInfoBytes);
  // Everything that signs is prepared first, so that only openInfo is counted below.
  const small = sealInfo(key, 'a.ts', 'h1', '{}');
  const signedOversized = signed(key, 'a.ts', 'h1', oversized);
  const signedWide = signed(key, 'a.ts', 'h1', wide);
  const sealedEdge = sealInfo(key, 'a.ts', 'h1', edge);
  assert.throws(() => sealInfo(key, 'a.ts', 'h1', oversized), RangeError);
  assert.equal(small.length, SEALED_OVERHEAD + 2);

  assert.equal(hmacCalls(() => assert.equal(openInfo(key, 'a.ts', 'h1', signedOversized), null)), 0, 'oversized value');
  assert.equal(hmacCalls(() => assert.equal(openInfo(key, 'a.ts', 'h1', signedWide), null)), 0, 'oversized in bytes, not in characters');
  assert.equal(hmacCalls(() => assert.equal(openInfo(key, 'a'.repeat(CACHE_LIMITS.maxPathBytes + 1), 'h1', small), null)), 0, 'oversized path');
  assert.equal(hmacCalls(() => assert.equal(openInfo(key, 'a.ts', 'h'.repeat(129), small), null)), 0, 'oversized hash');
  assert.equal(hmacCalls(() => assert.equal(openInfo(key, 'a.ts', 'h1', small), '{}')), 1, 'a normal value costs one signature');
  assert.equal(openInfo(key, 'a.ts', 'h1', sealedEdge), edge, 'a value at the limit still opens');
});

test('the total read in one load is budgeted: rows past the budget are skipped, and so is their signature work', () => {
  const db = opened(workspace());
  applyCacheWrites(db, Array.from({ length: 10 }, (_, i) => ({ kind: 'save' as const, row: goodRow(`f${i}.ts`, `{"pad":"${'x'.repeat(1000)}"}`) })));
  const limits = { ...CACHE_LIMITS, maxLoadBytes: 5 * 1100 };
  let loaded = 0;
  const calls = hmacCalls(() => (loaded = loadCache(db, limits).size));
  assert.ok(loaded >= 1 && loaded <= 5, `loaded ${loaded}`);
  assert.equal(calls, loaded, 'one signature per row that was read, none for the rest');
  assert.equal(loadCache(db).size, 10, 'with the default budget everything is read');
});

test('applyCacheWrites does not store an oversized result, and drops the older row for that file', () => {
  const db = opened(workspace());
  applyCacheWrites(db, [{ kind: 'save', row: goodRow('a.ts', '{"v":1}') }]);
  applyCacheWrites(db, [{ kind: 'save', row: goodRow('a.ts', `{"pad":"${'x'.repeat(CACHE_LIMITS.maxInfoBytes)}"}`) }, { kind: 'save', row: goodRow('b.ts') }]);
  assert.deepEqual([...loadCache(db).keys()], ['b.ts'], 'no failure, the other results are stored');
});

// --- the other fields that reach the signature ---------------------------------------------------------------------------

test('malformed paths are never trusted, even with a valid signature', () => {
  const root = shipped();
  const key = loadMachineKey(root)!;
  const hash = sha('x');
  const bad: (string | Buffer)[] = ['', '/etc/passwd', '../outside.ts', 'a/../../b.ts', 'C:\\x.ts', 'c:x.ts', 'a\0b.ts', 'p'.repeat(CACHE_LIMITS.maxPathBytes + 1), Buffer.from('blob.ts')];
  rawEdit(root, (raw) => {
    for (const [i, file] of bad.entries()) insert(raw, file, hash, signed(key, String(file), hash, `{"i":${i}}`));
    insert(raw, 'src/ok.ts', hash, signed(key, 'src/ok.ts', hash, '{"ok":1}'));
  });
  const rows = loadCache(opened(root));
  assert.deepEqual([...rows.keys()], ['src/ok.ts']);
});

test('invalid hashes are never trusted, even with a valid signature', () => {
  const root = shipped();
  const key = loadMachineKey(root)!;
  const bad: (string | Buffer)[] = ['', 'h'.repeat(129), 'has space', 'new\nline', 'a/b', Buffer.from('abcd')];
  rawEdit(root, (raw) => {
    for (const [i, hash] of bad.entries()) insert(raw, `bad${i}.ts`, hash, signed(key, `bad${i}.ts`, String(hash), '{}'));
    insert(raw, 'good.ts', sha('good'), signed(key, 'good.ts', sha('good'), '{}'));
  });
  assert.deepEqual([...loadCache(opened(root)).keys()], ['good.ts']);
});

test('invalid signatures are never trusted: unsigned, wrong key, moved to another path or hash, truncated, tampered', () => {
  const root = shipped();
  const key = loadMachineKey(root)!;
  const hash = sha('a.ts');
  const genuine = signed(key, 'a.ts', hash, '{"v":1}');
  rawEdit(root, (raw) => {
    insert(raw, 'unsigned.ts', hash, '{"v":1}');
    insert(raw, 'otherkey.ts', hash, signed(Buffer.alloc(32, 1), 'otherkey.ts', hash, '{"v":1}'));
    insert(raw, 'moved.ts', hash, genuine);
    insert(raw, 'rehashed.ts', sha('other'), signed(key, 'rehashed.ts', hash, '{"v":1}'));
    insert(raw, 'truncated.ts', hash, genuine.slice(0, 40));
    insert(raw, 'tampered.ts', hash, signed(key, 'tampered.ts', hash, '{"v":1}').replace('1}', '2}'));
    insert(raw, 'a.ts', hash, genuine);
  });
  assert.deepEqual([...loadCache(opened(root)).keys()], ['a.ts']);
});

test('rows of the wrong type are skipped without an error, in a table that has no constraints', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.guardian'), { mode: 0o700 });
  const raw = new Database(cacheFile(root));
  // The right column names, none of the constraints: a valid layout that proves nothing about the contents.
  raw.exec('CREATE TABLE files (path, hash, size, mtime_ms, info); CREATE TABLE usage (id, at, tool, raw_tokens, sent_tokens)');
  raw.pragma(`user_version = ${CACHE_VERSION}`);
  const add = raw.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)');
  add.run(null, null, null, null, null);
  add.run('a.ts', sha('a'), 'not a number', 1, '{}');
  add.run('b.ts', sha('b'), 1, null, '{}');
  add.run('c.ts', sha('c'), 1, 1, Buffer.from('blob'));
  add.run('d.ts', sha('d'), 1, 1, null);
  add.run(7, sha('e'), 1, 1, '{}');
  raw.close();
  const db = opened(root);
  assert.equal(isMemory(db), false);
  assert.equal(loadCache(db).size, 0);
});

// --- unsigned usage data -------------------------------------------------------------------------------------------------------

test('oversized or implausible usage values are not believed, and the sum stays small', () => {
  const db = opened(workspace());
  const add = db.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (?, ?, ?, ?)');
  add.run(1, 't', 100, 40);
  add.run(2, 't', 9_000_000_000_000_000_000, 5);
  add.run(3, 't', -50, 5);
  add.run(4, 't', 'lots', 'few');
  add.run(5, 'x'.repeat(5_000_000), 10, 5);
  const usage = lifetimeUsage(db);
  assert.equal(usage.calls, 5);
  assert.equal(usage.raw, 110);
  assert.equal(usage.sent, 55, 'each column is judged on its own: 40 + 5 + 5 + 0 + 5');
  assert.ok(Number.isSafeInteger(usage.raw) && Number.isSafeInteger(usage.sent));
});

test('only the newest usage rows are read, and a shipped table beyond the limit is trimmed when the cache opens', () => {
  const root = shipped();
  rawEdit(root, (raw) => {
    const add = raw.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (1, ?, 1, 1)');
    raw.transaction(() => {
      for (let i = 0; i < CACHE_LIMITS.maxUsageRows + 50; i++) add.run('t');
    })();
  });
  const db = opened(root);
  assert.equal(lifetimeUsage(db).calls, CACHE_LIMITS.maxUsageRows, 'trimmed on open');
  assert.equal(lifetimeUsage(db, { ...CACHE_LIMITS, maxUsageRows: 3 }).calls, 3, 'and the reader is bounded on its own');
});

test('recording and summing usage still works', () => {
  const db = opened(workspace());
  recordUsage(db, 'get_codebase_context', 1000, 250);
  recordUsage(db, 'optimize_prompt', 500, 100);
  assert.deepEqual({ ...lifetimeUsage(db) }, { calls: 2, raw: 1500, sent: 350 });
});

// --- pruning --------------------------------------------------------------------------------------------------------------------

test('pruning removes every row that is not retained, including rows of the wrong type, without reading them into memory', () => {
  const root = shipped();
  rawEdit(root, (raw) => {
    insert(raw, Buffer.from('blob-path'), sha('b'), '{}');
    insert(raw, 'x'.repeat(CACHE_LIMITS.maxPathBytes + 10), sha('x'), '{}');
  });
  const db = opened(root);
  applyCacheWrites(db, [{ kind: 'save', row: goodRow('keep.ts') }, { kind: 'save', row: goodRow('drop.ts') }], new Set(['keep.ts']));
  assert.deepEqual([...loadCache(db).keys()], ['keep.ts']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, 1);
});
