import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyCacheWrites, closeDb, loadCache, openDb, type Db } from '../src/db/client.js';
import { CACHE_VERSION, schema } from '../src/db/schema.js';
import { OLDEST_MIGRATABLE_VERSION, inspectSchema } from '../src/db/schema-check.js';
import { cleanup, workspace } from './helpers.js';

// cache.db may be supplied by a repository, so it is trusted only when its structure is exactly the one schema.ts creates. Every
// fixture below is a database that opens fine but differs from the supported schema in one way. The outcome is always the same:
// the file is replaced by a clean supported cache (never repaired in place, never used as it was), and never an error.

// The test state directory must have private Windows ACLs; os.tmpdir() may inherit
// broad permissions, which correctly causes loadMachineKey() to refuse the cache.

const open: Db[] = [];
const home = workspace({}, 'guardian-schemahome-');

if (process.platform === 'win32') {
  execFileSync('icacls.exe', [
    home,
    '/inheritance:r',
    '/grant:r', `*${currentUserSid()}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ], { stdio: 'ignore', windowsHide: true });
}

const savedHome = process.env.GUARDIAN_STATE_HOME;
let counter = 0;
beforeEach(() => {
  process.env.GUARDIAN_STATE_HOME = path.join(home, `state-${counter++}`);
});
afterEach(() => open.splice(0).forEach(closeDb));
after(() => {
  if (savedHome === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = savedHome;
  cleanup();
});

const cacheFile = (root: string): string => path.join(root, '.guardian', 'cache.db');
const inMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const tracked = (root: string): Db => {
  const db = openDb(root);
  open.push(db);
  return db;
};

// A workspace whose .guardian/cache.db was written by `build`, with the given user_version.
function shipped(build: (db: Database.Database) => void, version: number = CACHE_VERSION): string {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.guardian'), { mode: 0o700 });
  const raw = new Database(cacheFile(root));
  build(raw);
  raw.pragma(`user_version = ${version}`);
  raw.close();
  return root;
}

// What is in the file now, read independently of the code under test.
function describe(root: string): { version: number; objects: string[]; problem: string | null } {
  const raw = new Database(cacheFile(root), { readonly: true });
  try {
    const version = raw.pragma('user_version', { simple: true }) as number;
    const objects = (raw.prepare('SELECT type || \':\' || name AS o FROM sqlite_master').all() as { o: string }[]).map((r) => r.o).sort();
    return { version, objects, problem: inspectSchema(raw, version).problem };
  } finally {
    raw.close();
  }
}

const SUPPORTED_OBJECTS = ['index:sqlite_autoindex_files_1', 'table:files', 'table:sqlite_sequence', 'table:usage', 'table:usage_archive'].sort();

function assertReplacedByCleanCache(root: string, why: string): void {
  const db = tracked(root);
  assert.equal(inMemory(db), false, `${why}: a file cache is back, not a memory fallback`);
  closeDb(db);
  open.length = 0;
  const now = describe(root);
  assert.equal(now.version, CACHE_VERSION, why);
  assert.equal(now.problem, null, why);
  assert.deepEqual(now.objects, SUPPORTED_OBJECTS, `${why}: nothing of the hostile structure is left`);
}

// Same file, structure changed in one way, from the supported schema text.
const variant = (from: string, to: string): string => {
  assert.ok(schema.includes(from), `fixture bug: ${from}`);
  return schema.replace(from, to);
};

const MALFORMED: Record<string, string> = {
  'files: a column is missing': variant('  info     TEXT NOT NULL\n', '  extra_dummy TEXT NOT NULL\n').replace('  mtime_ms INTEGER NOT NULL,\n', ''),
  'files: an extra column': variant('  info     TEXT NOT NULL\n', '  info     TEXT NOT NULL,\n  note     TEXT\n'),
  'files: columns in another order': variant('  hash     TEXT NOT NULL,\n  size     INTEGER NOT NULL,', '  size     INTEGER NOT NULL,\n  hash     TEXT NOT NULL,'),
  'files: info is a BLOB': variant('info     TEXT NOT NULL', 'info     BLOB NOT NULL'),
  'files: size is TEXT': variant('size     INTEGER NOT NULL', 'size     TEXT NOT NULL'),
  'files: no type at all': variant('hash     TEXT NOT NULL', 'hash NOT NULL'),
  'files: hash is nullable': variant('hash     TEXT NOT NULL', 'hash     TEXT'),
  'files: info is nullable': variant('info     TEXT NOT NULL', 'info     TEXT'),
  'files: no primary key': variant('path     TEXT PRIMARY KEY', 'path     TEXT'),
  'files: a different primary key': variant('path     TEXT PRIMARY KEY,\n  hash     TEXT NOT NULL', 'path     TEXT,\n  hash     TEXT NOT NULL PRIMARY KEY'),
  'files: an extra unique constraint': variant('  info     TEXT NOT NULL\n)', '  info     TEXT NOT NULL,\n  UNIQUE (hash)\n)'),
  'files: a CHECK constraint': variant('size     INTEGER NOT NULL', 'size     INTEGER NOT NULL CHECK (size > 0)'),
  'files: a default value': variant('hash     TEXT NOT NULL', "hash     TEXT NOT NULL DEFAULT 'x'"),
  'files: a collation': variant('path     TEXT PRIMARY KEY', 'path     TEXT COLLATE NOCASE PRIMARY KEY'),
  'files: a conflict clause': variant('path     TEXT PRIMARY KEY', 'path     TEXT PRIMARY KEY ON CONFLICT IGNORE'),
  'files: a foreign key': variant('info     TEXT NOT NULL\n)', 'info     TEXT NOT NULL REFERENCES usage(id)\n)'),
  'files: a generated column': variant('  info     TEXT NOT NULL\n', '  info     TEXT NOT NULL,\n  g        TEXT AS (hash) VIRTUAL\n'),
  'files: WITHOUT ROWID': schema.replace(/(CREATE TABLE IF NOT EXISTS files \([^;]*?\n)\);/, '$1) WITHOUT ROWID;'),
  'files: STRICT': schema.replace(/(CREATE TABLE IF NOT EXISTS files \([^;]*?\n)\);/, '$1) STRICT;'),
  'usage: a column is missing': variant('  tool        TEXT NOT NULL,\n', ''),
  'usage: an extra column': variant('  sent_tokens INTEGER NOT NULL\n', '  sent_tokens INTEGER NOT NULL,\n  who TEXT\n'),
  'usage: tool is INTEGER': variant('tool        TEXT NOT NULL', 'tool        INTEGER NOT NULL'),
  'usage: nullable tokens': variant('raw_tokens  INTEGER NOT NULL', 'raw_tokens  INTEGER'),
  'usage: no AUTOINCREMENT': variant('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER PRIMARY KEY'),
  'usage: id is not the primary key': variant('id          INTEGER PRIMARY KEY AUTOINCREMENT', 'id          INTEGER'),
  'usage: a CHECK constraint': variant('at          INTEGER NOT NULL', 'at          INTEGER NOT NULL CHECK (at >= 0)'),
};

for (const [name, ddl] of Object.entries(MALFORMED)) {
  test(`a database with a malformed table is replaced: ${name}`, () => {
    const root = shipped((db) => db.exec(ddl));
    assert.notEqual(describe(root).problem, null, 'the fixture really differs from the supported schema');
    assertReplacedByCleanCache(root, name);
  });
}

const EXTRA: Record<string, string> = {
  'a trigger': 'CREATE TRIGGER sneaky AFTER INSERT ON files BEGIN DELETE FROM usage; END',
  'a trigger on usage': 'CREATE TRIGGER sneaky2 AFTER INSERT ON usage BEGIN DELETE FROM files; END',
  'a view': 'CREATE VIEW v AS SELECT 1 AS x',
  'a view that shadows nothing but reads files': 'CREATE VIEW files_view AS SELECT path FROM files',
  'an extra index on files': 'CREATE INDEX by_hash ON files(hash)',
  'a unique index on files': 'CREATE UNIQUE INDEX one_hash ON files(hash)',
  'a partial index': 'CREATE INDEX part ON files(hash) WHERE size > 0',
  'an index on usage': 'CREATE INDEX by_tool ON usage(tool)',
  'an unexpected table': 'CREATE TABLE extra (a TEXT)',
  'a statistics table (ANALYZE)': "INSERT INTO files (path, hash, size, mtime_ms, info) VALUES ('a', 'h', 1, 1, 'x'); ANALYZE",
  'a virtual table': 'CREATE VIRTUAL TABLE search USING fts5(body)',
};

for (const [name, ddl] of Object.entries(EXTRA)) {
  test(`a database with ${name} next to the supported tables is replaced`, () => {
    const root = shipped((db) => {
      db.exec(schema);
      db.exec(ddl);
    });
    assert.notEqual(describe(root).problem, null);
    assertReplacedByCleanCache(root, name);
  });
}

test('a virtual table in place of files is refused and never dropped or queried', () => {
  const root = shipped((db) => db.exec('CREATE VIRTUAL TABLE files USING fts5(path, hash, size, mtime_ms, info); CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tool TEXT NOT NULL, raw_tokens INTEGER NOT NULL, sent_tokens INTEGER NOT NULL)'));
  assertReplacedByCleanCache(root, 'virtual files');
});

test('a virtual table in place of files is refused in an older database too', () => {
  const root = shipped((db) => db.exec('CREATE VIRTUAL TABLE files USING fts5(path, hash)'), OLDEST_MIGRATABLE_VERSION);
  assertReplacedByCleanCache(root, 'virtual files, version 5');
});

test('a virtual table of a module this process does not have cannot make opening fail', () => {
  // Written with the module available, then the module's name is rewritten in the schema text so the module cannot be found.
  const root = shipped((db) => {
    db.exec(schema);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.exec("INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'ghost', 'ghost', 0, 'CREATE VIRTUAL TABLE ghost USING nosuchmodule(a)')");
    db.pragma('writable_schema = OFF');
  });
  const db = tracked(root);
  assert.equal(inMemory(db), false);
});

const VERSIONS: Array<[string, number]> = [
  ['a negative version', -1],
  ['version 1', 1],
  ['version 4 (older than the oldest supported)', OLDEST_MIGRATABLE_VERSION - 1],
  ['a version newer than this release', CACHE_VERSION + 1],
  ['a far-future version', 2 ** 31 - 1],
];

for (const [name, version] of VERSIONS) {
  test(`an unsupported schema version is not trusted: ${name}`, () => {
    // Structurally the current schema, with a row in it, but promising a version this code cannot vouch for.
    const root = shipped((db) => {
      db.exec(schema);
      db.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (1, ?, 2, 1)').run('kept?');
    }, version);
    assertReplacedByCleanCache(root, name);
    const now = new Database(cacheFile(root), { readonly: true });
    assert.equal((now.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n, 0, 'nothing from the unsupported database was carried over');
    now.close();
  });
}

test('an unversioned database that already holds tables is not trusted', () => {
  const root = shipped((db) => db.exec(schema), 0);
  assertReplacedByCleanCache(root, 'version 0 with content');
});

test('a normal existing database is kept as it is, with its signed results', () => {
  const root = workspace();
  const first = tracked(root);
  applyCacheWrites(first, [{ kind: 'save', row: { path: 'a.ts', hash: 'abc', size: 1, mtime_ms: 2, info: '{"v":1}' } }]);
  first.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (1, ?, 10, 4)').run('get_codebase_context');
  const before = fs.statSync(cacheFile(root), { bigint: true }).ino;
  closeDb(first);
  open.length = 0;

  const second = tracked(root);
  assert.equal(inMemory(second), false);
  assert.deepEqual([...loadCache(second).keys()], ['a.ts'], 'the file results survived');
  assert.equal((second.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n, 1, 'the usage rows survived');
  assert.equal(fs.statSync(cacheFile(root), { bigint: true }).ino, before, 'the file was not replaced');
  closeDb(second);
  open.length = 0;
  assert.deepEqual(describe(root), { version: CACHE_VERSION, objects: SUPPORTED_OBJECTS, problem: null });
});

test('a fresh, empty cache.db is accepted and initialised', () => {
  const root = workspace();
  const db = tracked(root);
  assert.equal(inMemory(db), false);
  closeDb(db);
  open.length = 0;
  assert.deepEqual(describe(root), { version: CACHE_VERSION, objects: SUPPORTED_OBJECTS, problem: null });
});

test('a database created from schema.ts always passes the validation', () => {
  const raw = new Database(':memory:');
  raw.exec(schema);
  assert.deepEqual(inspectSchema(raw, CACHE_VERSION), { state: 'current', problem: null });
  raw.close();
});

test('migration from the oldest supported version: file results are rebuilt, usage statistics are kept', () => {
  const root = shipped((db) => {
    // The older layout: its own files table (the row format differed), the same usage table.
    db.exec(schema);
    db.exec('DROP TABLE files; CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, info TEXT NOT NULL, legacy TEXT)');
    db.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, 1, 1, ?)').run('old.ts', 'h', '{"unsigned":true}');
    db.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (7, ?, 100, 40)').run('optimize_prompt');
  }, OLDEST_MIGRATABLE_VERSION);

  const db = tracked(root);
  assert.equal(inMemory(db), false, 'migrated in place, not replaced by a memory cache');
  assert.equal(loadCache(db).size, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n, 0, 'the old results are gone');
  assert.deepEqual(db.prepare('SELECT at, tool, raw_tokens, sent_tokens FROM usage').all(), [{ at: 7, tool: 'optimize_prompt', raw_tokens: 100, sent_tokens: 40 }], 'the statistics were kept');
  closeDb(db);
  open.length = 0;
  assert.deepEqual(describe(root), { version: CACHE_VERSION, objects: SUPPORTED_OBJECTS, problem: null });
});

test('migration refuses an older database whose usage table, or extra objects, are not supported', () => {
  const badUsage = shipped((db) => db.exec(MALFORMED['usage: tool is INTEGER']), OLDEST_MIGRATABLE_VERSION);
  assertReplacedByCleanCache(badUsage, 'older database with a malformed usage table');
  const withTrigger = shipped((db) => {
    db.exec(schema);
    db.exec('CREATE TRIGGER t AFTER INSERT ON usage BEGIN DELETE FROM usage; END');
  }, OLDEST_MIGRATABLE_VERSION);
  assertReplacedByCleanCache(withTrigger, 'older database with a trigger');
});

test('rows of the wrong type in a correctly declared table are still skipped, not believed', () => {
  // Declared affinities do not stop SQLite storing a text value in an INTEGER column; loadCache filters such rows itself.
  const root = shipped((db) => {
    db.exec(schema);
    const add = db.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)');
    add.run('a.ts', 'h1', 'not a number', 1, '{}');
    add.run('b.ts', 'h2', 1, 'nor this', '{}');
    add.run('c.ts', 'h3', 1, 1, Buffer.from('blob'));
  });
  const db = tracked(root);
  assert.equal(inMemory(db), false, 'the structure is the supported one, so the file is kept');
  assert.equal(loadCache(db).size, 0);
});

test('a database with too many schema objects is refused without being read further', () => {
  const root = shipped((db) => {
    db.exec(schema);
    for (let i = 0; i < 40; i++) db.exec(`CREATE TABLE junk_${i} (a)`);
  });
  assertReplacedByCleanCache(root, 'many objects');
});
