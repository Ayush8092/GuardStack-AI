import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { closeDb, openDb, prepareStateDir, type Db } from '../src/db/client.js';

// tightenStateDir() must fail closed. fchmod can fail (a foreign or read-only file system, a policy), and a failed call says
// nothing about the permissions the directory has. These tests make the real fchmodSync/fstatSync fail or lie at the exact point
// where prepareStateDir uses them, and check that the file cache is only used when the verified directory really is 0700.

const posixOnly = process.platform === 'win32' && 'POSIX modes and descriptors only; Windows keeps its previous behaviour';
const created: string[] = [];
const open: Db[] = [];
const restores: Array<() => void> = [];
const savedHome = process.env.GUARDIAN_STATE_HOME;

beforeEach(() => {
  process.env.GUARDIAN_STATE_HOME = path.join(temp('guardian-failkey-'), 'state');
});
afterEach(() => {
  restores.splice(0).reverse().forEach((restore) => restore());
  open.splice(0).forEach(closeDb);
});
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

// Replaces one function of the real fs module for the rest of the test (restored in afterEach). client.ts calls fs.<name> at run
// time, so this is the very call the production code makes.
function patch(name: 'fchmodSync' | 'fstatSync' | 'openSync' | 'closeSync', make: (original: (...args: any[]) => any) => (...args: any[]) => any): void {
  const target = fs as unknown as Record<string, (...args: any[]) => any>;
  const original = target[name]!;
  target[name] = make(original);
  restores.push(() => {
    target[name] = original;
  });
}

const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
const failingFchmod = (): void => patch('fchmodSync', () => () => {
  throw eperm();
});
// fchmod that reports success and does nothing: the call returned, the mode did not change.
const lyingFchmod = (): void => patch('fchmodSync', () => () => undefined);

// Directory descriptors opened (and closed) through the real openSync/closeSync during one call.
function trackDescriptors(): { opened: number[]; closed: number[] } {
  const seen = { opened: [] as number[], closed: [] as number[] };
  patch('openSync', (original) => (...args) => {
    const fd = original(...args) as number;
    if (typeof args[0] === 'string' && args[0].endsWith('.guardian')) seen.opened.push(fd);
    return fd;
  });
  patch('closeSync', (original) => (fd: number) => {
    seen.closed.push(fd);
    return original(fd);
  });
  return seen;
}
const fdCount = (): number | null => {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
};

function workspaceWith(mode: number): string {
  const root = temp('guardian-fc-');
  fs.mkdirSync(state(root));
  fs.chmodSync(state(root), mode);
  return root;
}

function outsideDir(mode = 0o755): string {
  const dir = temp('guardian-fc-outside-');
  fs.chmodSync(dir, mode);
  return dir;
}

const swapForLink = (root: string, to: string) => (): void => {
  fs.renameSync(state(root), `${state(root)}.moved`);
  fs.symlinkSync(to, state(root), 'dir');
};
const swapForDirectory = (root: string, mode = 0o755) => (): void => {
  fs.renameSync(state(root), `${state(root)}.moved`);
  fs.mkdirSync(state(root));
  fs.chmodSync(state(root), mode);
};

test('fchmod throws and the directory is 0755: the file cache is rejected and the directory is left as it was', { skip: posixOnly }, () => {
  const root = workspaceWith(0o755);
  failingFchmod();
  const descriptors = trackDescriptors();
  assert.equal(prepareStateDir(root), null, 'an unverified directory is not used');
  assert.equal(modeOf(state(root)), 0o755, 'nothing else changed it');
  assert.deepEqual(entries(state(root)), [], 'nothing was created in it');
  assert.deepEqual(descriptors.opened.filter((fd) => !descriptors.closed.includes(fd)), [], 'the descriptor was closed');
});

test('fchmod throws but the directory already is 0700: it is accepted, because the mode was verified', { skip: posixOnly }, () => {
  const root = workspaceWith(0o700);
  failingFchmod();
  assert.equal(prepareStateDir(root), state(root));
  assert.equal(modeOf(state(root)), 0o700);
});

test('fchmod reports success but the mode is not 0700 afterwards: rejected (verification fails after fchmod)', { skip: posixOnly }, () => {
  for (const mode of [0o755, 0o750, 0o770, 0o777, 0o701, 0o600]) {
    const root = workspaceWith(mode);
    lyingFchmod();
    assert.equal(prepareStateDir(root), null, `mode ${mode.toString(8)} must not be accepted`);
    assert.equal(modeOf(state(root)), mode, 'and it is not changed behind the verification');
    restores.pop()!();
  }
});

test('the mode cannot be read back (fstat fails after fchmod): rejected, even when fchmod failed on a directory that happens to be 0700', { skip: posixOnly }, () => {
  for (const [label, fchmodFails] of [['fchmod succeeded', false], ['fchmod failed', true]] as const) {
    const root = workspaceWith(0o700);
    if (fchmodFails) failingFchmod();
    let armed = false;
    patch('fstatSync', (original) => (...args) => {
      if (armed) throw Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' });
      return original(...args);
    });
    const descriptors = trackDescriptors();
    const result = prepareStateDir(root, { afterPermissionChange: () => void (armed = true) });
    assert.equal(result, null, label);
    assert.deepEqual(descriptors.opened.filter((fd) => !descriptors.closed.includes(fd)), [], `${label}: the descriptor was closed`);
    restores.splice(0).reverse().forEach((restore) => restore());
  }
});

test('the descriptor is not the same directory any more when the mode is read back: rejected', { skip: posixOnly }, () => {
  const root = workspaceWith(0o755);
  // The read-back returns the identity of some other directory, as a swapped descriptor would.
  const foreign = fs.statSync(outsideDir(0o700), { bigint: true });
  let armed = false;
  patch('fstatSync', (original) => (...args) => {
    const real = original(...args);
    return armed ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino: foreign.ino + 1n }) : real;
  });
  assert.equal(prepareStateDir(root, { afterPermissionChange: () => void (armed = true) }), null);
});

test('with a failing fchmod, a symlink or a replacement directory swapped in at any point is still refused and nothing outside changes', { skip: posixOnly }, () => {
  for (const hook of ['beforePermissionOpen', 'afterPermissionOpen', 'afterPermissionChange'] as const) {
    const root = workspaceWith(0o755);
    const outside = outsideDir(0o755);
    const outsideBefore = entries(outside);
    failingFchmod();
    assert.equal(prepareStateDir(root, { [hook]: swapForLink(root, outside) }), null, `symlink at ${hook}`);
    assert.equal(modeOf(outside), 0o755, `the link target was not changed (${hook})`);
    assert.deepEqual(entries(outside), outsideBefore);
    restores.pop()!();

    const replaced = workspaceWith(0o755);
    failingFchmod();
    assert.equal(prepareStateDir(replaced, { [hook]: swapForDirectory(replaced, 0o700) }), null, `directory at ${hook}`);
    restores.pop()!();
  }
});

test('a state directory that already is a symlink stays refused, whatever fchmod does', { skip: posixOnly }, () => {
  const root = temp('guardian-fc-');
  const inside = path.join(root, 'elsewhere');
  fs.mkdirSync(inside);
  fs.chmodSync(inside, 0o700);
  fs.symlinkSync(inside, state(root), 'dir');
  assert.equal(prepareStateDir(root), null);
  lyingFchmod();
  assert.equal(prepareStateDir(root), null);
  assert.equal(modeOf(inside), 0o700);
});

test('no descriptor is leaked on any path: success, failed fchmod, failed verification, replaced directory', { skip: posixOnly }, () => {
  const before = fdCount();
  const descriptors = trackDescriptors();
  const run = (root: string, hooks = {}): unknown => prepareStateDir(root, hooks);

  run(workspaceWith(0o755));
  failingFchmod();
  run(workspaceWith(0o755));
  run(workspaceWith(0o700));
  restores.pop()!();
  lyingFchmod();
  run(workspaceWith(0o755));
  restores.pop()!();
  const root = workspaceWith(0o755);
  run(root, { afterPermissionOpen: swapForDirectory(root) });

  assert.equal(descriptors.opened.length, 5, 'one directory descriptor per call');
  assert.deepEqual(descriptors.opened.filter((fd) => !descriptors.closed.includes(fd)), [], 'every one was closed');
  restores.splice(0).reverse().forEach((restore) => restore());
  if (before !== null) assert.equal(fdCount(), before, 'the process holds the same number of descriptors as before');
});

test('openDb after a permission failure: in-memory cache, no cache.db or sidecar, nothing outside touched; a later legitimate call uses the file cache', { skip: posixOnly }, () => {
  const root = workspaceWith(0o755);
  const outside = outsideDir(0o755);
  const outsideBefore = entries(outside);
  failingFchmod();
  const refused = openDb(root);
  open.push(refused);
  assert.ok(inMemory(refused), 'the session cache is in memory');
  assert.deepEqual(entries(state(root)), [], 'no cache.db, -wal, -shm or -journal was created');
  assert.equal(modeOf(state(root)), 0o755, 'the directory was not touched');
  assert.deepEqual(entries(outside), outsideBefore);
  assert.equal(modeOf(outside), 0o755);

  // The verification failing after a "successful" fchmod is refused the same way.
  restores.pop()!();
  lyingFchmod();
  const lied = openDb(root);
  open.push(lied);
  assert.ok(inMemory(lied));
  assert.deepEqual(entries(state(root)), []);
  restores.pop()!();

  // No sticky state: with fchmod working again, the same workspace gets the file cache and a 0700 directory.
  const again = openDb(root);
  open.push(again);
  assert.equal(inMemory(again), false, 'a later legitimate invocation works normally');
  assert.equal(modeOf(state(root)), 0o700);
  assert.ok(fs.existsSync(path.join(state(root), 'cache.db')));
});
