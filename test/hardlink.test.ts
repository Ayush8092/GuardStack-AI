import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { ensureConfig, ensureGitignore } from '../src/cli/commands/init-files.js';
import { readGitignore } from '../src/core/ast/indexer.js';
import { UnsafeFileError, appendToRegularFile, createFileExclusive, isHardLinked, regularFileIdentity } from '../src/core/security/safe-file.js';
import { readInside } from '../src/core/security/sandbox.js';
import { closeDb, openDb, type Db } from '../src/db/client.js';
import { loadConfig } from '../src/utils/config.js';
import { cleanup, hardLinksWork, workspace } from './helpers.js';

// A hard link is a second name for the same inode. Unlike a symlink it cannot be seen by lstat's file type, so the
// only signal is the link count. Every test here plants a link to a file the attack wants changed and asserts that
// the file is refused and that the other name's content is untouched. Skipped where hard links cannot be created
// (some Windows file systems without privileges, FAT, certain network mounts).

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

const RC = '.guardianrc';
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const state = (root: string, name = ''): string => path.join(root, '.guardian', `cache.db${name}`);

function victimFile(content = 'precious outside data\n'): { dir: string; victim: string; before: string } {
  const dir = workspace({ 'victim.txt': content });
  const victim = path.join(dir, 'victim.txt');
  return { dir, victim, before: sha(victim) };
}

const skip = hardLinksWork;

test('isHardLinked treats only counts above one as linked, for numbers and bigints', () => {
  assert.equal(isHardLinked({ nlink: 1 }), false);
  assert.equal(isHardLinked({ nlink: 1n }), false);
  assert.equal(isHardLinked({ nlink: 2 }), true);
  assert.equal(isHardLinked({ nlink: 2n }), true);
});

test('a hard-linked .gitignore is refused and the other name is untouched', { skip }, () => {
  const root = workspace();
  const ext = victimFile('node_modules/\n');
  fs.linkSync(ext.victim, path.join(root, '.gitignore'));

  assert.throws(() => ensureGitignore(root), UnsafeFileError);

  assert.equal(sha(ext.victim), ext.before, 'the linked file must not gain a .guardian/ entry');
});

test('a hard-linked .guardianrc is refused by init and its content is never replaced', { skip }, () => {
  const root = workspace();
  const ext = victimFile('{"llm":false}\n');
  fs.linkSync(ext.victim, path.join(root, RC));

  assert.throws(() => ensureConfig(root, RC), UnsafeFileError);

  assert.equal(sha(ext.victim), ext.before);
});

test('createFileExclusive does not report a hard-linked file as "already present, fine"', { skip }, () => {
  const root = workspace();
  const ext = victimFile();
  fs.linkSync(ext.victim, path.join(root, 'file.txt'));

  assert.throws(() => createFileExclusive(root, 'file.txt', 'x'), /hard link/);
  assert.equal(sha(ext.victim), ext.before);
});

test('a hard link planted after the file was opened is detected before anything is written', { skip }, () => {
  const root = workspace({ '.gitignore': 'build/\n' });
  const ext = victimFile();
  // Hard link to the *same inode the descriptor holds*, created while `decide` runs.
  const alias = path.join(ext.dir, 'alias');

  assert.throws(
    () =>
      appendToRegularFile(root, '.gitignore', 1024, (current) => {
        fs.linkSync(path.join(root, '.gitignore'), alias);
        return `${current}.guardian/\n`;
      }),
    /hard link/,
  );

  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'build/\n', 'nothing was appended');
  assert.equal(sha(ext.victim), ext.before);
});

test('a file is accepted again once the extra link is gone', { skip }, () => {
  const root = workspace({ '.gitignore': 'build/\n' });
  const alias = path.join(workspace(), 'alias');
  fs.linkSync(path.join(root, '.gitignore'), alias);
  assert.throws(() => regularFileIdentity(path.join(root, '.gitignore')), UnsafeFileError);

  fs.rmSync(alias);

  assert.ok(regularFileIdentity(path.join(root, '.gitignore')));
  ensureGitignore(root);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'build/\n.guardian/\n');
});

test('a hard-linked .guardianrc is not trusted when the configuration is loaded', { skip }, () => {
  const root = workspace();
  const ext = victimFile('{"llm":false,"ignore":["src/**"]}\n');
  fs.linkSync(ext.victim, path.join(root, RC));

  assert.throws(() => loadConfig(root), /hard-linked/);
});

test('a hard-linked .gitignore is not trusted when ignore rules are read', { skip }, () => {
  const root = workspace();
  const ext = victimFile('src/\n');
  fs.linkSync(ext.victim, path.join(root, '.gitignore'));

  assert.equal(readGitignore(root), '', 'treated as absent, like a symlinked one');
});

test('ordinary hard-linked source files are still readable (the check is opt-in)', { skip }, () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  fs.linkSync(path.join(root, 'a.ts'), path.join(root, 'b.ts'));

  assert.equal(readInside(root, 'b.ts', 1024).toString('utf8'), 'export const a = 1;\n');
  assert.throws(() => readInside(root, 'b.ts', 1024, { rejectHardLinks: true }), /hard-linked/);
});

test('a hard-linked cache.db is refused, the cache falls back to memory and the other name is untouched', { skip }, () => {
  const root = workspace();
  const outsideDir = workspace();
  const external = path.join(outsideDir, 'other.db');
  const seed = new Database(external);
  seed.exec("CREATE TABLE files (note TEXT); INSERT INTO files VALUES ('precious');");
  seed.close();
  const before = sha(external);
  fs.mkdirSync(path.join(root, '.guardian'), { recursive: true });
  fs.linkSync(external, state(root));

  const db = track(openDb(root));

  assert.ok(inMemory(db));
  assert.equal(sha(external), before, 'the external database was not migrated, dropped or switched to WAL');
  assert.deepEqual(fs.readdirSync(outsideDir), ['other.db'], 'no sidecars appeared next to it');
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`a hard-linked cache.db${suffix} is refused and the other name is untouched`, { skip }, () => {
    const root = workspace();
    const ext = victimFile();
    track(openDb(root)).close(); // a normal cache first, so cache.db itself is legitimate
    fs.linkSync(ext.victim, state(root, suffix));

    const db = track(openDb(root));

    assert.ok(inMemory(db));
    assert.equal(sha(ext.victim), ext.before);
  });
}

test('a hard link made to cache.db during initialization is detected', { skip }, () => {
  const root = workspace();
  const outsideDir = workspace();

  const db = track(
    openDb(root, {
      afterGuard: () => fs.linkSync(state(root), path.join(outsideDir, 'alias.db')),
    }),
  );

  assert.ok(inMemory(db), 'the new link is noticed and the cache falls back to memory');
});

test('a normal single-link cache.db still works', () => {
  const root = workspace();

  const db = track(openDb(root));

  assert.equal(inMemory(db), false);
  assert.equal(fs.statSync(state(root)).nlink, 1);
});
