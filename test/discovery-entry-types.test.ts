import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { walk, type WalkEnv } from '../src/core/ast/discovery.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { cleanup, context } from './helpers.js';

const created: string[] = [];
after(() => {
  cleanup();
  for (const dir of created){
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const env = (root: string): WalkEnv => ({ root, ignores: () => false, maxBytes: 1 << 20, isTsConfig: () => false, isSensitive: () => false });
const BIG = { maxEntries: 1_000_000, maxMs: 60_000 };

function scratch(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-kinds-')));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

// Some file systems (and network mounts) report DT_UNKNOWN: a Dirent for which no type predicate is true. Linux ext4/tmpfs never do, so
// the predicates are made to answer false for entries whose name starts with `unk-`, which is exactly what such a listing looks like.
const TYPE_PREDICATES = ['isFile', 'isDirectory', 'isSymbolicLink', 'isSocket', 'isFIFO', 'isCharacterDevice', 'isBlockDevice'] as const;
const originals = new Map<string, (this: fs.Dirent) => boolean>();
const originalLstat = fs.lstatSync;

function listUnknownTypes(prefix = 'unk-'): void {
  for (const name of TYPE_PREDICATES) {
    const original = fs.Dirent.prototype[name] as (this: fs.Dirent) => boolean;
    originals.set(name, original);
    (fs.Dirent.prototype as unknown as Record<string, unknown>)[name] = function (this: fs.Dirent): boolean {
      return this.name.startsWith(prefix) ? false : original.call(this);
    };
  }
}

afterEach(() => {
  for (const [name, original] of originals) (fs.Dirent.prototype as unknown as Record<string, unknown>)[name] = original;
  originals.clear();
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
});

test('entries with an unknown type are classified with lstat: unknown files are indexed and unknown directories are entered', async () => {
  const root = scratch({ 'plain.ts': 'export const a = 1;\n', 'unk-file.ts': 'export const b = 2;\n', 'unk-dir/inner.ts': 'export const c = 3;\n', 'unk-dir/deeper/leaf.ts': 'export const d = 4;\n' });
  listUnknownTypes();
  const result = await walk(env(root), BIG);
  assert.deepEqual(result.eligible.map((f) => f.rel), ['plain.ts', 'unk-dir/deeper/leaf.ts', 'unk-dir/inner.ts', 'unk-file.ts']);
  assert.deepEqual(result.unclassified, []);
  assert.equal(result.stopped, undefined);
});

test('an unknown-type entry that is really a symbolic link is skipped, never followed', async () => {
  const outside = scratch({ 'secret.ts': 'export const secret = 1;\n', 'tree/hidden.ts': 'export const hidden = 1;\n' });
  const root = scratch({ 'plain.ts': 'export const a = 1;\n' });
  try {
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'unk-link-file.ts'));
    fs.symlinkSync(path.join(outside, 'tree'), path.join(root, 'unk-link-dir'), 'dir');
  } catch {
    return; // the platform refuses to create symbolic links: nothing to verify
  }
  listUnknownTypes();
  const result = await walk(env(root), BIG);
  assert.deepEqual(result.eligible.map((f) => f.rel), ['plain.ts']);
  assert.deepEqual(result.unclassified, []);
});

test('a symbolic link with a known type is skipped too, and so is a file swapped for a link after it was listed', async () => {
  const outside = scratch({ 'secret.ts': 'export const secret = 1;\n' });
  const root = scratch({ 'plain.ts': 'export const a = 1;\n', 'swapped.ts': 'export const b = 2;\n' });
  try {
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'link.ts'));
  } catch {
    return;
  }
  const real = fs.lstatSync;
  // Between the listing and the size check, swapped.ts becomes a link: the size check must not follow it.
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).endsWith('swapped.ts')) {
      fs.rmSync(p, { force: true });
      fs.symlinkSync(path.join(outside, 'secret.ts'), p);
    }
    return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
  }) as typeof fs.lstatSync;
  const result = await walk(env(root), BIG);
  assert.deepEqual(result.eligible.map((f) => f.rel), ['plain.ts']);
});

test('an entry that cannot be classified is reported, and the scan that contains it is never complete', async () => {
  const root = scratch({ 'plain.ts': 'export const a = 1;\n', 'unk-gone.ts': 'export const b = 2;\n' });
  listUnknownTypes();
  const real = fs.lstatSync;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).endsWith('unk-gone.ts')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
  }) as typeof fs.lstatSync;

  const result = await walk(env(root), BIG);
  assert.deepEqual(result.unclassified, ['unk-gone.ts']);
  assert.deepEqual(result.eligible.map((f) => f.rel), ['plain.ts']);

  const project = await indexProject(context(root));
  assert.equal(project.complete, false);
  assert.ok(project.skipped.some((s) => s.path === 'unk-gone.ts' && s.reason === 'unclassified'), JSON.stringify(project.skipped));
});

test('sockets and other special files are neither indexed nor reported as unclassified', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix sockets are not file-system entries on Windows');
  const root = scratch({ 'plain.ts': 'export const a = 1;\n' });
  const net = await import('node:net');
  const server = net.createServer();
  const socketPath = path.join(root, 'sock.ts');
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  } catch {
    return t.skip('the platform cannot create a Unix socket here');
  }
  try {
    assert.ok(fs.lstatSync(socketPath).isSocket());
    const result = await walk(env(root), BIG);
    assert.deepEqual(result.eligible.map((f) => f.rel), ['plain.ts'], 'a socket named like a source file is not a file');
    assert.deepEqual(result.unclassified, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- metrics ---------------------------------------------------------------------------------------------------------

function flatTree(dirs: number, filesPerDir: number): string {
  const files: Record<string, string> = {};
  for (let d = 0; d < dirs; d++) for (let f = 0; f < filesPerDir; f++) files[`d${String(d).padStart(3, '0')}/f${String(f).padStart(4, '0')}.ts`] = 'export const v = 1;\n';
  return scratch(files);
}

test('entries counts processed entries only and never exceeds the limit', async () => {
  const root = flatTree(1, 500);
  for (const maxEntries of [1, 10, 100, 499]) {
    const result = await walk(env(root), { ...BIG, maxEntries });
    assert.equal(result.stopped, 'entry-limit', `maxEntries=${maxEntries}`);
    assert.equal(result.entries, maxEntries, `maxEntries=${maxEntries}: the entry that would exceed the limit is not counted`);
    assert.ok(result.listed >= result.entries);
  }
});

test('a tree whose size equals the limit exactly is complete: the limit is only hit by an entry beyond it', async () => {
  const root = flatTree(1, 40);
  const exactly = await walk(env(root), { ...BIG, maxEntries: 41 });
  assert.equal(exactly.stopped, undefined);
  assert.equal(exactly.entries, 41, '40 files plus the directory');
  const oneShort = await walk(env(root), { ...BIG, maxEntries: 40 });
  assert.equal(oneShort.stopped, 'entry-limit');
  assert.equal(oneShort.entries, 40);
});

test('peakListingBuffer measures only the directory-listing buffer, not total discovery memory', async () => {
  const root = flatTree(50, 100);
  const result = await walk(env(root), BIG);
  assert.equal(result.eligible.length, 5000, 'five thousand candidates are retained for the whole walk');
  assert.ok(result.peakListingBuffer <= 100, `the listing buffer never held more than one directory: ${result.peakListingBuffer}`);
  assert.ok(result.peakListingBuffer < result.eligible.length, 'so it says nothing about the memory used by the candidates');
});
