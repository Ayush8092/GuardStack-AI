import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyCacheWrites, closeDb, loadCache, openDb, type Db } from '../src/db/client.js';
import { cleanup, fileSymlinksWork, workspace } from './helpers.js';

const open: Db[] = [];
const track = (db: Db): Db => (open.push(db), db);
// One hook, in this order: node:test runs `after` hooks in the order they were registered, and Windows cannot delete a
// directory that still holds an open SQLite file. Every connection tracked here is closed before cleanup() removes
// the temporary directories, and cleanup() runs even if closing one of them throws.
after(() => {
  try {
    open.splice(0).forEach(closeDb);
  } finally {
    cleanup();
  }
});

const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const state = (root: string, name = ''): string => path.join(root, '.guardian', `cache.db${name}`);
const stateDir = (root: string): string => {
  fs.mkdirSync(path.join(root, '.guardian'), { recursive: true });
  return path.join(root, '.guardian');
};

// A foreign SQLite database outside the workspace. With user_version 0 it looks like an old cache, which is
// exactly what makes the schema step DROP its `files` table.
function externalDb(): { dir: string; file: string; before: string; listing: string[] } {
  const dir = workspace();
  const file = path.join(dir, 'other.db');
  const db = new Database(file);
  db.exec("CREATE TABLE files (note TEXT); INSERT INTO files VALUES ('precious');");
  db.close();
  return { dir, file, before: sha(file), listing: fs.readdirSync(dir).sort() };
}

function assertUntouched(ext: { dir: string; file: string; before: string; listing: string[] }): void {
  assert.equal(sha(ext.file), ext.before, 'external database bytes changed');
  assert.deepEqual(fs.readdirSync(ext.dir).sort(), ext.listing, 'files appeared next to the external database');
}

const link = (target: string, at: string): void => fs.symlinkSync(target, at);

test('cache.db symlinked to an external SQLite database is refused and the database is untouched', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const ext = externalDb();
  stateDir(root);
  link(ext.file, state(root));

  const db = track(openDb(root));

  assert.ok(inMemory(db), 'falls back to an in-memory cache');
  assertUntouched(ext);
  assert.ok(fs.lstatSync(state(root)).isSymbolicLink(), 'the planted link is left in place, not followed or deleted');
});

test('a dangling cache.db symlink is refused and its target is never created', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const outsideDir = workspace();
  const missing = path.join(outsideDir, 'created-by-sqlite.db');
  stateDir(root);
  link(missing, state(root));

  const db = track(openDb(root));

  assert.ok(inMemory(db));
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

test('a cache.db symlink that stays inside the workspace is refused too', { skip: fileSymlinksWork }, () => {
  const root = workspace({ 'real.db': '' });
  stateDir(root);
  link(path.join(root, 'real.db'), state(root));

  assert.ok(inMemory(track(openDb(root))));
  assert.equal(fs.readFileSync(path.join(root, 'real.db'), 'utf8'), '');
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`a symlinked cache.db${suffix} is refused and its target is untouched`, { skip: fileSymlinksWork }, () => {
    const root = workspace();
    const outsideDir = workspace({ 'victim.bin': 'precious outside data\n' });
    const victim = path.join(outsideDir, 'victim.bin');
    const before = sha(victim);
    track(openDb(root)).close(); // a normal cache first, so cache.db itself is legitimate
    link(victim, state(root, suffix));

    const db = track(openDb(root));

    assert.ok(inMemory(db));
    assert.equal(sha(victim), before);
    assert.deepEqual(fs.readdirSync(outsideDir), ['victim.bin']);
  });
}

test('a dangling symlinked cache.db-wal is refused and its target is never created', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const outsideDir = workspace();
  track(openDb(root)).close();
  link(path.join(outsideDir, 'wal-target'), state(root, '-wal'));

  assert.ok(inMemory(track(openDb(root))));
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

test('a directory in place of cache.db is refused', () => {
  const root = workspace();
  fs.mkdirSync(state(root), { recursive: true });

  const db = track(openDb(root));

  assert.ok(inMemory(db));
  assert.ok(fs.statSync(state(root)).isDirectory());
});

test('cache.db swapped for a symlink to an external database during initialization is detected', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const ext = externalDb();

  const db = track(
    openDb(root, {
      afterGuard: () => {
        fs.rmSync(state(root));
        link(ext.file, state(root));
      },
    }),
  );

  assert.ok(inMemory(db), 'the swap is noticed and the cache falls back to memory');
  assertUntouched(ext);
});

test('cache.db swapped for a dangling symlink during initialization never creates the target', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const outsideDir = workspace();

  const db = track(
    openDb(root, {
      afterGuard: () => {
        fs.rmSync(state(root));
        link(path.join(outsideDir, 'created-by-sqlite.db'), state(root));
      },
    }),
  );

  assert.ok(inMemory(db));
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

test('cache.db replaced by another regular file during initialization is detected', () => {
  const root = workspace();

  const db = track(
    openDb(root, {
      afterGuard: () => {
        // Created before the original is removed, so it cannot reuse the original's inode number.
        const replacement = path.join(root, 'replacement.db');
        fs.writeFileSync(replacement, '');
        fs.renameSync(replacement, state(root));
      },
    }),
  );

  assert.ok(inMemory(db));
});

test('normal creation makes a private, working cache.db', () => {
  const root = workspace();

  const db = track(openDb(root));

  assert.equal(inMemory(db), false);
  assert.equal(fs.readFileSync(state(root)).subarray(0, 15).toString(), 'SQLite format 3');
  if (process.platform !== 'win32') assert.equal(fs.statSync(state(root)).mode & 0o077, 0, 'cache.db is not readable by other users');
});

test('an existing cache.db is reused with its contents', () => {
  const root = workspace();
  const first = openDb(root);
  applyCacheWrites(first, [{ kind: 'save', row: { path: 'a.ts', hash: 'h', size: 1, mtime_ms: 2, info: '{}' } }]);
  closeDb(first);

  const second = track(openDb(root));

  assert.equal(inMemory(second), false);
  assert.equal(loadCache(second).get('a.ts')?.hash, 'h');
});

test('a corrupted cache.db is rebuilt in place', () => {
  const root = workspace();
  stateDir(root);
  fs.writeFileSync(state(root), 'this is not sqlite '.repeat(50));

  const db = track(openDb(root));

  assert.equal(inMemory(db), false);
  assert.equal(loadCache(db).size, 0);
  assert.equal(fs.readFileSync(state(root)).subarray(0, 15).toString(), 'SQLite format 3');
});
