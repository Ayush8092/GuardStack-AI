import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { walk, type WalkEnv } from '../src/core/ast/discovery.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { cleanup, context } from './helpers.js';

// Real file-system tests of discovery under races and failures. A "race" is made deterministic by running the change from inside a call that
// discovery makes (a Dirent predicate, lstat, opendir), at exactly the point between two steps of discovery. Nothing here fakes a result:
// the directories really are replaced and the files really are removed.

const created: string[] = [];
after(() => {
  cleanup();
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const env = (root: string): WalkEnv => ({ root, ignores: () => false, maxBytes: 1 << 20, isTsConfig: () => false, isSensitive: () => false });
const BIG = { maxEntries: 1_000_000, maxMs: 60_000 };

function scratch(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-race-')));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

// ---- hooks, always undone -----------------------------------------------------------------------------------------------------------
type Fs = { lstatSync: typeof fs.lstatSync };
const mutable = fs as unknown as Fs & { promises: { opendir: typeof fs.promises.opendir } };
const realLstat = fs.lstatSync;
const realOpendir = fs.promises.opendir;
const direntNames = ['isFile', 'isDirectory'] as const;
const realDirent = new Map<string, unknown>();

afterEach(() => {
  mutable.lstatSync = realLstat;
  mutable.promises.opendir = realOpendir;
  for (const [name, original] of realDirent) (fs.Dirent.prototype as unknown as Record<string, unknown>)[name] = original;
  realDirent.clear();
});

// Runs `change` the first time discovery asks whether the entry called `name` is a file or a directory: the entry has just been listed
// with its type, and the change happens before discovery acts on that type.
function afterListed(name: string, predicate: (typeof direntNames)[number], change: () => void): void {
  const original = fs.Dirent.prototype[predicate] as (this: fs.Dirent) => boolean;
  realDirent.set(predicate, original);
  let done = false;
  (fs.Dirent.prototype as unknown as Record<string, unknown>)[predicate] = function (this: fs.Dirent): boolean {
    const answer = original.call(this);
    if (!done && this.name === name && answer) {
      done = true;
      change();
    }
    return answer;
  };
}

const symlinkOk = (target: string, link: string, type?: 'dir'): boolean => {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false; // the platform refuses to create links: the race cannot be staged
  }
};

function external(): string {
  return scratch({ 'evil.ts': 'export const evil = 1;\n', 'deep/evil2.ts': 'export const evil2 = 1;\n' });
}

function swapForExternalLink(root: string, name: string, outside: string): () => void {
  return () => {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    symlinkOk(outside, path.join(root, name), 'dir');
  };
}

const rels = (r: Awaited<ReturnType<typeof walk>>): string[] => r.eligible.map((f) => f.rel);

// ---- 1. a listed directory replaced by a symbolic link ---------------------------------------------------------------------------------

test('a directory replaced by an external symlink after it was listed is not entered, and the scan is partial', async (t) => {
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'a/inside.ts': 'export const inside = 1;\n' });
  if (!symlinkOk(outside, path.join(scratch({}), 'probe'), 'dir')) return t.skip('symbolic links cannot be created here');
  afterListed('a', 'isDirectory', swapForExternalLink(root, 'a', outside));

  const result = await walk(env(root), BIG);
  assert.deepEqual(rels(result), ['ok.ts'], 'neither the replaced directory nor anything outside the workspace was discovered');
  assert.ok(!rels(result).some((r) => r.includes('evil')));
  assert.deepEqual(result.replacedDirs, ['a']);
  assert.deepEqual(result.unreadableDirs, []);
});

test('a directory replaced by a link between the lstat check and the open is refused by the kernel (O_NOFOLLOW)', async (t) => {
  if (process.platform === 'win32') return t.skip('O_NOFOLLOW does not exist on Windows');
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'a/inside.ts': 'export const inside = 1;\n' });
  if (!symlinkOk(outside, path.join(scratch({}), 'probe'), 'dir')) return t.skip('symbolic links cannot be created here');
  const swap = swapForExternalLink(root, 'a', outside);
  let armed = true;
  // The check passes (it sees the real directory), and the directory is replaced right after, before the open.
  mutable.lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    const stats = (realLstat as (...a: unknown[]) => fs.Stats)(p, ...rest);
    if (armed && path.basename(String(p)) === 'a' && stats.isDirectory()) {
      armed = false;
      swap();
    }
    return stats;
  }) as typeof fs.lstatSync;

  const result = await walk(env(root), BIG);
  assert.equal(armed, false, 'the race was staged');
  assert.deepEqual(rels(result), ['ok.ts']);
  assert.deepEqual(result.replacedDirs, ['a']);
});

test('a directory replaced by a link after it was opened is detected, and nothing from it or from outside is used', async (t) => {
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'a/inside.ts': 'export const inside = 1;\n' });
  if (!symlinkOk(outside, path.join(scratch({}), 'probe'), 'dir')) return t.skip('symbolic links cannot be created here');
  const swap = swapForExternalLink(root, 'a', outside);
  let calls = 0;
  // The second opendir of the walk is the one for `a` (the first is the root). Replace the directory just before it runs.
  mutable.promises.opendir = (async (p: fs.PathLike, ...rest: unknown[]) => {
    if (++calls === 2) swap();
    return (realOpendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest);
  }) as typeof fs.promises.opendir;

  const result = await walk(env(root), BIG);
  assert.equal(calls >= 2, true, 'the race was staged');
  assert.ok(!rels(result).some((r) => r.includes('evil')), `outside files were discovered: ${rels(result)}`);
  assert.ok(!rels(result).includes('a/inside.ts'), 'a listing taken while the path was a link is discarded');
  assert.deepEqual(result.replacedDirs, ['a']);
});

test('on Linux the listing is read from the verified directory itself, so a replacement that is undone is harmless', async (t) => {
  if (process.platform !== 'linux') return t.skip('listing through /proc/self/fd is Linux only (README: "Directory races")');
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'a/inside.ts': 'export const inside = 1;\n' });
  if (!symlinkOk(outside, path.join(scratch({}), 'probe'), 'dir')) return t.skip('symbolic links cannot be created here');
  let calls = 0;
  mutable.promises.opendir = (async (p: fs.PathLike, ...rest: unknown[]) => {
    if (++calls !== 2) return (realOpendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest);
    // Swap in the link, open, swap the directory back: a path-based open would have listed the outside directory.
    const aside = path.join(root, 'a.moved');
    fs.renameSync(path.join(root, 'a'), aside);
    symlinkOk(outside, path.join(root, 'a'), 'dir');
    const dir = await (realOpendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest);
    fs.rmSync(path.join(root, 'a'), { force: true });
    fs.renameSync(aside, path.join(root, 'a'));
    return dir;
  }) as typeof fs.promises.opendir;

  const result = await walk(env(root), BIG);
  assert.deepEqual(rels(result), ['a/inside.ts', 'ok.ts'], 'the directory that was verified is the directory that was listed');
  assert.ok(!rels(result).some((r) => r.includes('evil')));
  assert.deepEqual(result.replacedDirs, []);
});

test('a symbolic link to an outside directory is never entered, and a link as the workspace root is resolved once', async (t) => {
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n' });
  if (!symlinkOk(outside, path.join(root, 'linked'), 'dir')) return t.skip('symbolic links cannot be created here');
  assert.deepEqual(rels(await walk(env(root), BIG)), ['ok.ts']);

  const viaLink = path.join(scratch({}), 'root-link');
  symlinkOk(root, viaLink, 'dir');
  assert.deepEqual(rels(await walk(env(viaLink), BIG)), ['ok.ts'], 'the workspace root itself may be a link');
});

test('a directory that is removed after it was listed is recorded as vanished, not as a gap', async () => {
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'a/inside.ts': 'export const inside = 1;\n' });
  afterListed('a', 'isDirectory', () => fs.rmSync(path.join(root, 'a'), { recursive: true, force: true }));
  const result = await walk(env(root), BIG);
  assert.deepEqual(result.vanished, ['a']);
  assert.deepEqual(result.unreadableDirs, []);
  assert.deepEqual(rels(result), ['ok.ts']);
});

// ---- 2. classification failures can never produce a falsely complete scan ---------------------------------------------------------------

function failLstat(match: string, code: string, before?: () => void): void {
  let armed = true;
  mutable.lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (armed && String(p).replace(/\\/g, '/').endsWith(match)) {
      armed = false;
      before?.();
      throw Object.assign(new Error(code), { code });
    }
    return (realLstat as (...a: unknown[]) => fs.Stats)(p, ...rest);
  }) as typeof fs.lstatSync;
}

test('a source file whose lstat fails with a permission or I/O error is reported, and the scan is partial', async () => {
  for (const code of ['EACCES', 'EIO']) {
    const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'src/hidden.ts': 'export const hidden = 1;\n' });
    failLstat('src/hidden.ts', code);
    const result = await walk(env(root), BIG);
    assert.deepEqual(result.unclassified, ['src/hidden.ts'], code);
    assert.deepEqual(rels(result), ['ok.ts'], code);

    mutable.lstatSync = realLstat;
    failLstat('src/hidden.ts', code);
    const project = await indexProject(context(root));
    assert.equal(project.complete, false, `${code}: a source file that could not be examined must not leave the scan complete`);
    assert.ok(project.skipped.some((s) => s.path === 'src/hidden.ts' && s.reason === 'unclassified'), JSON.stringify(project.skipped));
    mutable.lstatSync = realLstat;
  }
});

test('a source file that is really gone (ENOENT) is recorded as vanished and does not make the scan partial', async () => {
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'src/gone.ts': 'export const gone = 1;\n' });
  failLstat('src/gone.ts', 'ENOENT', () => fs.rmSync(path.join(root, 'src/gone.ts')));
  const result = await walk(env(root), BIG);
  assert.deepEqual(result.vanished, ['src/gone.ts']);
  assert.deepEqual(result.unclassified, []);

  const root2 = scratch({ 'ok.ts': 'export const ok = 1;\n', 'src/gone.ts': 'export const gone = 1;\n' });
  mutable.lstatSync = realLstat;
  failLstat('src/gone.ts', 'ENOENT', () => fs.rmSync(path.join(root2, 'src/gone.ts')));
  const project = await indexProject(context(root2));
  assert.equal(project.complete, true, 'a file that no longer exists is not a gap in the scan');
  assert.deepEqual(project.files.map((f) => f.path), ['ok.ts']);
});

test('a source file replaced by a link or a directory after it was listed is not followed and is reported', async (t) => {
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'swap.ts': 'export const swap = 1;\n' });
  if (!symlinkOk(path.join(outside, 'evil.ts'), path.join(scratch({}), 'probe'))) return t.skip('symbolic links cannot be created here');
  afterListed('swap.ts', 'isFile', () => {
    fs.rmSync(path.join(root, 'swap.ts'));
    symlinkOk(path.join(outside, 'evil.ts'), path.join(root, 'swap.ts'));
  });
  const result = await walk(env(root), BIG);
  assert.deepEqual(rels(result), ['ok.ts']);
  assert.deepEqual(result.unclassified, ['swap.ts']);

  const root2 = scratch({ 'ok.ts': 'export const ok = 1;\n', 'was-file.ts': 'export const w = 1;\n' });
  afterListed('was-file.ts', 'isFile', () => {
    fs.rmSync(path.join(root2, 'was-file.ts'));
    fs.mkdirSync(path.join(root2, 'was-file.ts'));
  });
  const project = await indexProject(context(root2));
  assert.equal(project.complete, false);
  assert.ok(project.skipped.some((s) => s.path === 'was-file.ts' && s.reason === 'unclassified'));
});

test('an entry of unknown type whose lstat fails is unclassified, or vanished when it is really gone', async () => {
  const names = ['isFile', 'isDirectory', 'isSymbolicLink', 'isSocket', 'isFIFO', 'isCharacterDevice', 'isBlockDevice'] as const;
  const saved = new Map<string, unknown>();
  for (const name of names) {
    const original = fs.Dirent.prototype[name] as (this: fs.Dirent) => boolean;
    saved.set(name, original);
    (fs.Dirent.prototype as unknown as Record<string, unknown>)[name] = function (this: fs.Dirent): boolean {
      return this.name.startsWith('unk-') ? false : original.call(this);
    };
  }
  try {
    const root = scratch({ 'unk-denied.ts': 'x\n', 'unk-gone.ts': 'x\n', 'plain.ts': 'export const a = 1;\n' });
    mutable.lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      const name = path.basename(String(p));
      if (name === 'unk-denied.ts') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      if (name === 'unk-gone.ts') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return (realLstat as (...a: unknown[]) => fs.Stats)(p, ...rest);
    }) as typeof fs.lstatSync;
    const result = await walk(env(root), BIG);
    assert.deepEqual(result.unclassified, ['unk-denied.ts']);
    assert.deepEqual(result.vanished, ['unk-gone.ts']);
    assert.deepEqual(rels(result), ['plain.ts']);
  } finally {
    for (const [name, original] of saved) (fs.Dirent.prototype as unknown as Record<string, unknown>)[name] = original;
  }
});

test('a directory that cannot be opened is reported as unreadable and the scan is partial', async () => {
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'locked/inside.ts': 'export const inside = 1;\n' });
  let calls = 0;
  mutable.promises.opendir = (async (p: fs.PathLike, ...rest: unknown[]) => {
    if (++calls === 2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return (realOpendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest);
  }) as typeof fs.promises.opendir;
  const result = await walk(env(root), BIG);
  assert.deepEqual(result.unreadableDirs, ['locked']);
  mutable.promises.opendir = realOpendir;
  calls = 0;
  mutable.promises.opendir = (async (p: fs.PathLike, ...rest: unknown[]) => {
    if (++calls === 2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return (realOpendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest);
  }) as typeof fs.promises.opendir;
  const project = await indexProject(context(root));
  assert.equal(project.complete, false);
});

test('a replaced directory makes the indexed project partial, and findings that depend on seeing everything are not confident', async (t) => {
  const outside = external();
  const root = scratch({ 'ok.ts': 'export const ok = 1;\n', 'a/inside.ts': 'export const inside = 1;\n' });
  if (!symlinkOk(outside, path.join(scratch({}), 'probe'), 'dir')) return t.skip('symbolic links cannot be created here');
  afterListed('a', 'isDirectory', swapForExternalLink(root, 'a', outside));
  const project = await indexProject(context(root));
  assert.equal(project.complete, false);
  assert.deepEqual(project.skipped.map((s) => [s.path, s.reason]), [['a', 'directory-replaced']]);
  assert.ok(!project.files.some((f) => f.path.includes('evil')));
});
