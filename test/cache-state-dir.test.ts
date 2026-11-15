import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { closeDb, openDb, type Db, type OpenHooks } from '../src/db/client.js';
import { cleanup, createDirectoryLink, directoryLinksWork, fileSymlinksWork, workspace } from './helpers.js';

// The cache directory must be used through the identity that was verified, never through a path that can be swapped, and
// a corrupt cache may only be deleted through that directory. Every test checks the same two outcomes: the session falls
// back to memory, and what lives outside the verified directory is untouched.

const open: Db[] = [];
const track = (db: Db): Db => (open.push(db), db);
const home = workspace({}, 'guardian-keyhome-');
// TEMP may grant broad inherited permissions. Keep the test machine-key directory
// private so loadMachineKey() can exercise the persistent-cache paths on Windows.
if (process.platform === 'win32') {
  execFileSync('icacls.exe', [
    home,
    '/inheritance:r',
    '/grant:r', `*${currentUserSid()}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ], { stdio: 'ignore', windowsHide: true });
}
const savedHome = process.env.GUARDIAN_STATE_HOME;
// A fresh key directory per test, so one test's key (or a deliberately broken one) never reaches another.
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

const inMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const state = (root: string, name = ''): string => path.join(root, '.guardian', name);
const JUNK = 'this is not a sqlite database '.repeat(40);

// A directory outside the workspace holding files an attacker would love us to modify or delete.
function precious(): { dir: string; snapshot: () => Record<string, string> } {
  const dir = workspace({}, 'guardian-outside-');
  const seed = new Database(path.join(dir, 'cache.db'));
  seed.exec("CREATE TABLE files (note TEXT); INSERT INTO files VALUES ('precious');");
  seed.close();
  for (const suffix of ['-wal', '-shm', '-journal']) fs.writeFileSync(path.join(dir, `cache.db${suffix}`), `precious ${suffix}\n`);
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, sha(path.join(dir, n))]));
  return { dir, snapshot };
}

// What an attacker does at the wrong moment: the verified directory is renamed away and a link to `target` takes its place.
function swapForLink(root: string, target: string): () => void {
  return () => {
    fs.renameSync(state(root), `${state(root)}.moved`);
    createDirectoryLink(target, state(root));
  };
}

function swapForDirectory(root: string): () => void {
  return () => {
    fs.renameSync(state(root), `${state(root)}.moved`);
    fs.mkdirSync(state(root));
  };
}

const withHooks = (root: string, hooks: OpenHooks): Db => track(openDb(root, hooks));

test('.guardian replaced by a symlink right after it was verified: memory cache, nothing is written outside', { skip: directoryLinksWork }, () => {
  const root = workspace();
  const outside = precious();
  const before = outside.snapshot();
  const db = withHooks(root, { afterStateDir: swapForLink(root, outside.dir) });
  assert.ok(inMemory(db));
  assert.deepEqual(outside.snapshot(), before, 'the directory the link pointed to was not touched');
});

test('.guardian replaced by a symlink after cache.db was created: SQLite never writes through it', { skip: directoryLinksWork }, () => {
  const root = workspace();
  const outside = precious();
  const before = outside.snapshot();
  const db = withHooks(root, { afterGuard: swapForLink(root, outside.dir) });
  assert.ok(inMemory(db));
  assert.deepEqual(outside.snapshot(), before, 'not even a journal or sidecar appeared next to the other database');
  assert.equal(fs.readFileSync(path.join(`${state(root)}.moved`, 'cache.db')).length, 0, 'the original, still empty, was left alone');
});

test('.guardian replaced by a different real directory at the same path is detected, and nothing is deleted', () => {
  const root = workspace();
  const db = withHooks(root, { afterGuard: swapForDirectory(root) });
  assert.ok(inMemory(db));
  assert.deepEqual(fs.readdirSync(state(root)), [], 'nothing was created in the directory that took its place');
  assert.equal(fs.readFileSync(path.join(`${state(root)}.moved`, 'cache.db')).length, 0, 'the original file was left alone');
});

test('.guardian replaced between the checks and the creation of cache.db', () => {
  const root = workspace();
  const db = withHooks(root, { afterStateDir: swapForDirectory(root) });
  assert.ok(inMemory(db));
  assert.deepEqual(fs.readdirSync(state(root)), []);
});

test('a .guardian symlink that stays inside the workspace is refused too', { skip: directoryLinksWork }, () => {
  const root = workspace({ 'elsewhere/keep.txt': 'x' });
  createDirectoryLink(path.join(root, 'elsewhere'), state(root));
  const db = track(openDb(root));
  assert.ok(inMemory(db));
  assert.deepEqual(fs.readdirSync(path.join(root, 'elsewhere')), ['keep.txt']);
});

test('corruption recovery never deletes through a directory that was replaced by a symlink', { skip: directoryLinksWork }, () => {
  const root = workspace();
  fs.mkdirSync(state(root));
  fs.writeFileSync(state(root, 'cache.db'), JUNK);
  const outside = precious();
  const before = outside.snapshot();

  const db = withHooks(root, { beforeRecovery: swapForLink(root, outside.dir) });
  assert.ok(inMemory(db));
  assert.deepEqual(outside.snapshot(), before, 'the other directory kept its database and every sidecar');
  assert.equal(fs.readFileSync(path.join(`${state(root)}.moved`, 'cache.db'), 'utf8'), JUNK, 'the original was not deleted either');
});

test('corruption recovery never deletes a directory that was replaced by another real directory', () => {
  const root = workspace();
  fs.mkdirSync(state(root));
  fs.writeFileSync(state(root, 'cache.db'), JUNK);
  const db = withHooks(root, {
    beforeRecovery: () => {
      swapForDirectory(root)();
      fs.writeFileSync(state(root, 'cache.db'), 'someone else\n');
    },
  });
  assert.ok(inMemory(db));
  assert.equal(fs.readFileSync(state(root, 'cache.db'), 'utf8'), 'someone else\n', 'a file in the replaced directory is not ours to delete');
  assert.equal(fs.readFileSync(path.join(`${state(root)}.moved`, 'cache.db'), 'utf8'), JUNK);
});

test('corruption recovery refuses to delete a cache.db that is no longer the file that was checked', () => {
  const root = workspace();
  fs.mkdirSync(state(root));
  fs.writeFileSync(state(root, 'cache.db'), JUNK);
  const db = withHooks(root, {
    beforeRecovery: () => {
      // Moved aside rather than deleted, so the new file cannot be handed the old file's inode number.
      fs.renameSync(state(root, 'cache.db'), state(root, 'cache.db.old'));
      fs.writeFileSync(state(root, 'cache.db'), 'a different file\n');
    },
  });
  assert.ok(inMemory(db));
  assert.equal(fs.readFileSync(state(root, 'cache.db'), 'utf8'), 'a different file\n');
});

test('corruption recovery does not follow a sidecar that became a symlink', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  fs.mkdirSync(state(root));
  fs.writeFileSync(state(root, 'cache.db'), JUNK);
  const outside = workspace({ 'victim.txt': 'precious\n' });
  const victim = path.join(outside, 'victim.txt');
  const db = withHooks(root, { beforeRecovery: () => fs.symlinkSync(victim, state(root, 'cache.db-shm')) });
  assert.ok(inMemory(db));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  assert.ok(fs.lstatSync(state(root, 'cache.db-shm')).isSymbolicLink(), 'the link itself is left for the user to look at');
});

test('a hard-linked sidecar found during recovery is not deleted', () => {
  const root = workspace();
  fs.mkdirSync(state(root));
  fs.writeFileSync(state(root, 'cache.db'), JUNK);
  const outside = workspace({ 'victim.txt': 'precious\n' });
  let linked = true;
  const db = withHooks(root, {
    beforeRecovery: () => {
      try {
        fs.linkSync(path.join(outside, 'victim.txt'), state(root, 'cache.db-wal'));
      } catch {
        linked = false;
      }
    },
  });
  assert.ok(inMemory(db));
  assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'precious\n');
  if (linked) assert.ok(fs.existsSync(state(root, 'cache.db-wal')), 'the sidecar was refused, not deleted');
});

test('a constructor failure (cache.db vanished before SQLite opened it) falls back to memory without throwing', () => {
  const root = workspace();
  const db = withHooks(root, { afterGuard: () => fs.rmSync(state(root, 'cache.db')) });
  assert.ok(inMemory(db));
  assert.equal(fs.existsSync(state(root, 'cache.db')), false, 'nothing was created behind the failed open');
});

test('an ordinary corrupt cache.db is still rebuilt in place, with the same directory', () => {
  const root = workspace();
  fs.mkdirSync(state(root));
  fs.writeFileSync(state(root, 'cache.db'), JUNK);
  fs.writeFileSync(state(root, 'cache.db-wal'), 'stale wal\n');
  const db = track(openDb(root));
  assert.equal(inMemory(db), false, 'the file cache works again');
  assert.equal(fs.readFileSync(state(root, 'cache.db')).subarray(0, 15).toString(), 'SQLite format 3');
  assert.notEqual(fs.existsSync(state(root, 'cache.db-wal')) ? fs.readFileSync(state(root, 'cache.db-wal'), 'utf8') : '', 'stale wal\n', 'the stale sidecar of the corrupt database was removed');
});

test('a normal workspace gets a private persistent cache', () => {
  const root = workspace();
  const db = track(openDb(root));
  assert.equal(inMemory(db), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(state(root, 'cache.db')).mode & 0o077, 0);
});
