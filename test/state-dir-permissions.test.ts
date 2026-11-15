import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { closeDb, openDb, prepareStateDir, type Db } from '../src/db/client.js';

// prepareStateDir tightens .guardian to 0700. chmod(path) follows symbolic links, so a lstat followed by a chmod would let a
// .guardian that is swapped in between redirect the change to another directory. The change is made with fchmod on a descriptor
// that was opened with O_DIRECTORY | O_NOFOLLOW and checked against the directory that was seen first. Each test swaps .guardian
// at one exact point (the hooks) and checks the same things: nothing outside the verified directory changed, and the session
// falls back to the in-memory cache instead of trusting a directory that was not verified.

const posixOnly = process.platform === 'win32' && 'POSIX modes and descriptors only; Windows keeps its previous behaviour';
const created: string[] = [];
const open: Db[] = [];
const savedHome = process.env.GUARDIAN_STATE_HOME;
let keyHome = '';

beforeEach(() => {
  // The machine key lives outside every workspace; a fresh directory per test keeps one test's key out of another.
  keyHome = temp('guardian-permkey-');
  process.env.GUARDIAN_STATE_HOME = path.join(keyHome, 'state');
});
afterEach(() => open.splice(0).forEach(closeDb));
after(() => {
  if (savedHome === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = savedHome;
  for (const dir of created.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

const state = (root: string): string => path.join(root, '.guardian');
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;
const entries = (dir: string): string[] => fs.readdirSync(dir).sort();
const inMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const descriptors = (): number | null => {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
};

// A directory outside the workspace, with a mode that the attack would like to change.
function target(mode = 0o755): string {
  const dir = temp('guardian-outside-');
  fs.chmodSync(dir, mode);
  return dir;
}

// What an attacker does at the wrong moment: the verified directory is moved away and a link to `to` takes its place.
const swapForLink = (root: string, to: string) => (): void => {
  fs.renameSync(state(root), `${state(root)}.moved`);
  fs.symlinkSync(to, state(root), 'dir');
};
const swapForDirectory = (root: string, mode = 0o755) => (): void => {
  fs.renameSync(state(root), `${state(root)}.moved`);
  fs.mkdirSync(state(root));
  fs.chmodSync(state(root), mode);
};

test('a legitimate directory is created and tightened to 0700', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  assert.equal(prepareStateDir(root), state(root));
  assert.equal(modeOf(state(root)), 0o700);

  const loose = temp('guardian-perm-');
  fs.mkdirSync(state(loose), { mode: 0o755 });
  fs.chmodSync(state(loose), 0o755);
  assert.equal(prepareStateDir(loose), state(loose));
  assert.equal(modeOf(state(loose)), 0o700, 'an existing, looser directory is tightened');
  assert.equal(prepareStateDir(loose), state(loose), 'and the call is repeatable');
});

test('.guardian swapped for a symlink between the check and the permission change: the target keeps its permissions', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  const outside = target(0o755);
  fs.mkdirSync(state(root));
  const before = entries(outside);
  const result = prepareStateDir(root, { beforePermissionOpen: swapForLink(root, outside) });
  assert.equal(result, null, 'nothing that was swapped in is trusted');
  assert.equal(modeOf(outside), 0o755, 'fchmod never reached the link target');
  assert.deepEqual(entries(outside), before);
});

test('.guardian swapped for a symlink after the descriptor was verified: the change lands on the verified directory only', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  const outside = target(0o755);
  fs.mkdirSync(state(root));
  fs.chmodSync(state(root), 0o755);
  const result = prepareStateDir(root, { afterPermissionOpen: swapForLink(root, outside) });
  assert.equal(result, null, 'the path no longer names the directory that was verified');
  assert.equal(modeOf(outside), 0o755, 'the link target was not changed');
  assert.equal(modeOf(`${state(root)}.moved`), 0o700, 'the descriptor still referred to the verified directory');
});

test('.guardian replaced by another real directory: it is not modified and the session falls back', { skip: posixOnly }, () => {
  for (const hook of ['beforePermissionOpen', 'afterPermissionOpen', 'afterPermissionChange'] as const) {
    const root = temp('guardian-perm-');
    fs.mkdirSync(state(root));
    fs.chmodSync(state(root), 0o755);
    const result = prepareStateDir(root, { [hook]: swapForDirectory(root, 0o755) });
    assert.equal(result, null, hook);
    if (hook === 'beforePermissionOpen') assert.equal(modeOf(state(root)), 0o755, 'the directory that was swapped in was never changed');
  }
});

test('.guardian swapped for a symlink after the permission change is noticed', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  const outside = target(0o755);
  fs.mkdirSync(state(root));
  assert.equal(prepareStateDir(root, { afterPermissionChange: swapForLink(root, outside) }), null);
  assert.equal(modeOf(outside), 0o755);
});

test('a .guardian that already is a symlink (even to a directory inside the workspace) is refused and its target untouched', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  const inside = path.join(root, 'elsewhere');
  fs.mkdirSync(inside);
  fs.chmodSync(inside, 0o755);
  fs.symlinkSync(inside, state(root), 'dir');
  assert.equal(prepareStateDir(root), null);
  assert.equal(modeOf(inside), 0o755, 'chmod through the link would have made this 0700');
});

test('a refused directory leaves no trusted state: memory cache, no file created anywhere, no descriptor left open, and a later call works', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  const outside = target(0o755);
  fs.mkdirSync(state(root));
  const openBefore = descriptors();
  const outsideBefore = entries(outside);

  const db = openDb(root, { beforePermissionOpen: swapForLink(root, outside) });
  open.push(db);
  assert.ok(inMemory(db), 'the session cache is in memory');
  assert.deepEqual(entries(outside), outsideBefore, 'no cache.db, journal or key appeared in the link target');
  assert.deepEqual(entries(`${state(root)}.moved`), [], 'nor in the directory that was moved away');
  assert.equal(modeOf(outside), 0o755);
  if (openBefore !== null) assert.ok((descriptors() ?? 0) <= openBefore + 2, 'the directory descriptor was closed (the in-memory database may hold its own)');

  // No sticky state: with the attacker gone, the same workspace is usable again.
  fs.rmSync(state(root));
  fs.renameSync(`${state(root)}.moved`, state(root));
  const again = openDb(root);
  open.push(again);
  assert.equal(inMemory(again), false, 'a verified directory gets the file cache');
  assert.equal(modeOf(state(root)), 0o700);
});

test('a legitimate workspace still gets the file cache through openDb', { skip: posixOnly }, () => {
  const root = temp('guardian-perm-');
  const db = openDb(root);
  open.push(db);
  assert.equal(inMemory(db), false);
  assert.ok(fs.existsSync(path.join(state(root), 'cache.db')));
  assert.equal(modeOf(state(root)), 0o700);
});
