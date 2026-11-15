import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { UnsafeFileError, createFileExclusive } from '../src/core/security/safe-file.js';
import { cleanup, createDirectoryLink, directoryLinksWork, fileSymlinksWork, hardLinksWork, workspace } from './helpers.js';

// createFileExclusive must behave like appendToRegularFile: the descriptor from the exclusive open is compared with
// the path and with the directory it was opened in, before and after the write. Each test swaps something at one exact
// moment through the test seams and asserts two things: nothing outside the intended file was touched, and whatever
// this call created is cleaned up only when it is verifiably the file it created.

after(cleanup);

const NAME = 'created.txt';
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A directory that can be renamed or replaced: `parent/ws`.
function replaceable(): { parent: string; dir: string; file: string } {
  const parent = workspace();
  const dir = path.join(parent, 'ws');
  fs.mkdirSync(dir);
  return { parent, dir, file: path.join(dir, NAME) };
}

function victim(content = 'precious outside data\n'): { dir: string; file: string; before: string } {
  const dir = workspace({ 'victim.txt': content });
  const file = path.join(dir, 'victim.txt');
  return { dir, file, before: sha(file) };
}

// Directory swaps while a file is open inside the directory are not attempted on Windows, where renaming a directory
// that contains an open handle is refused by the file system rather than by this code.
const skipOpenDirSwap = process.platform === 'win32' ? 'a directory holding an open file cannot be renamed on Windows' : false;

test('normal creation writes the data, keeps the requested mode and leaves one plain file', () => {
  const { dir, file } = replaceable();

  assert.equal(createFileExclusive(dir, NAME, 'hello\n', 0o600), true);

  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
  assert.deepEqual(fs.readdirSync(dir), [NAME]);
  assert.equal(fs.lstatSync(file).nlink, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('empty data creates an empty file (the cache database is created this way)', () => {
  const { dir, file } = replaceable();

  assert.equal(createFileExclusive(dir, NAME, '', 0o600), true);

  assert.equal(fs.statSync(file).size, 0);
});

test('an existing regular file is left untouched and reported as already present', () => {
  const { dir, file } = replaceable();
  fs.writeFileSync(file, 'original\n');

  assert.equal(createFileExclusive(dir, NAME, 'new\n'), false);

  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
});

test('a directory sitting at the name is refused', () => {
  const { dir, file } = replaceable();
  fs.mkdirSync(file);

  assert.throws(() => createFileExclusive(dir, NAME, 'x'), /not a regular file/);

  assert.equal(fs.statSync(file).isDirectory(), true);
});

test('a symlink to an existing file is refused and the target is untouched', { skip: fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const ext = victim();
  fs.symlinkSync(ext.file, file);

  assert.throws(() => createFileExclusive(dir, NAME, 'x'), UnsafeFileError);

  assert.equal(sha(ext.file), ext.before);
});

test('a dangling symlink is refused and its target is never created', { skip: fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const missing = path.join(workspace(), 'would-be-created');
  fs.symlinkSync(missing, file);

  assert.throws(() => createFileExclusive(dir, NAME, 'x'), UnsafeFileError);

  assert.equal(fs.existsSync(missing), false);
});

test('a symlink planted between the check and the open is refused and nothing is created behind it', { skip: fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const missing = path.join(workspace(), 'would-be-created');

  assert.throws(
    () => createFileExclusive(dir, NAME, 'x', 0o644, { beforeOpen: () => fs.symlinkSync(missing, file) }),
    UnsafeFileError,
  );

  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'the planted link is not ours to remove');
});

test('a regular file planted between the check and the open wins the race and is not modified', () => {
  const { dir, file } = replaceable();

  assert.equal(createFileExclusive(dir, NAME, 'new\n', 0o644, { beforeOpen: () => fs.writeFileSync(file, 'planted\n') }), false);

  assert.equal(fs.readFileSync(file, 'utf8'), 'planted\n');
});

test('a directory replaced by a new real directory before the open is detected and the created file is removed', () => {
  const { parent, dir, file } = replaceable();

  // Same path, same realpath string, different directory: only its dev/ino can tell.
  assert.throws(
    () =>
      createFileExclusive(dir, NAME, 'x', 0o644, {
        beforeOpen: () => {
          fs.renameSync(dir, path.join(parent, 'ws-old'));
          fs.mkdirSync(dir);
        },
      }),
    /changed while it was being created/,
  );

  assert.deepEqual(fs.readdirSync(dir), [], 'the file created in the replacement directory was removed');
  assert.deepEqual(fs.readdirSync(path.join(parent, 'ws-old')), []);
  assert.equal(fs.existsSync(file), false);
});

test('a directory replaced by a symlink to another directory before the open is detected and cleaned up', { skip: directoryLinksWork }, () => {
  const { parent, dir } = replaceable();
  const elsewhere = workspace();

  assert.throws(
    () =>
      createFileExclusive(dir, NAME, 'x', 0o644, {
        beforeOpen: () => {
          fs.renameSync(dir, path.join(parent, 'ws-old'));
          createDirectoryLink(elsewhere, dir);
        },
      }),
    /changed while it was being created/,
  );

  assert.deepEqual(fs.readdirSync(elsewhere), [], 'the file that landed in the other directory was removed again');
});

test('a directory swapped for a link after the open never gets the data and a planted file there survives', { skip: directoryLinksWork || skipOpenDirSwap }, () => {
  const { parent, dir } = replaceable();
  const elsewhere = workspace({ [NAME]: 'planted\n' });

  assert.throws(
    () =>
      createFileExclusive(dir, NAME, 'x', 0o644, {
        afterOpen: () => {
          fs.renameSync(dir, path.join(parent, 'ws-old'));
          createDirectoryLink(elsewhere, dir);
        },
      }),
    UnsafeFileError,
  );

  assert.equal(fs.readFileSync(path.join(elsewhere, NAME), 'utf8'), 'planted\n', 'a file that is not ours is never removed or written');
});

test('a different regular file swapped in after the open is detected and left alone', () => {
  const { dir, file } = replaceable();
  const replacement = path.join(workspace(), 'replacement');
  fs.writeFileSync(replacement, 'other\n');

  assert.throws(
    () =>
      createFileExclusive(dir, NAME, 'x', 0o644, {
        afterOpen: () => {
          // Windows refuses to rename over a file that is still open, so remove the name first (the open descriptor
          // keeps the original inode alive) and then move the prepared substitute into its place.
          fs.rmSync(file);
          fs.renameSync(replacement, file);
        },
      }),
    /changed while it was being created/,
  );

  assert.equal(fs.readFileSync(file, 'utf8'), 'other\n', 'the substitute is not ours to remove or write');
});

test('a symlink swapped in after the open is detected, the target is untouched and the link is left alone', { skip: fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const ext = victim();

  assert.throws(
    () =>
      createFileExclusive(dir, NAME, 'x', 0o644, {
        afterOpen: () => {
          fs.rmSync(file);
          fs.symlinkSync(ext.file, file);
        },
      }),
    UnsafeFileError,
  );

  assert.equal(sha(ext.file), ext.before);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('a file removed after the open is reported as changed', () => {
  const { dir, file } = replaceable();

  assert.throws(() => createFileExclusive(dir, NAME, 'x', 0o644, { afterOpen: () => fs.rmSync(file) }), /changed while it was being created/);

  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a hard link made after the open is detected before a byte is written and our name is removed', { skip: hardLinksWork }, () => {
  const { dir, file } = replaceable();
  const alias = path.join(workspace(), 'alias');

  assert.throws(() => createFileExclusive(dir, NAME, 'secret data', 0o644, { afterOpen: () => fs.linkSync(file, alias) }), /hard link/);

  assert.equal(fs.statSync(alias).size, 0, 'nothing was written through the extra link');
  assert.equal(fs.existsSync(file), false, 'the created name was removed');
});

test('a hard link made after the write is detected and our name is removed', { skip: hardLinksWork }, () => {
  const { dir, file } = replaceable();
  const alias = path.join(workspace(), 'alias');

  assert.throws(() => createFileExclusive(dir, NAME, 'data', 0o644, { afterWrite: () => fs.linkSync(file, alias) }), /hard link/);

  assert.equal(fs.existsSync(file), false);
});

test('a different regular file swapped in after the write is detected and left alone', () => {
  const { dir, file } = replaceable();
  const replacement = path.join(workspace(), 'replacement');
  fs.writeFileSync(replacement, 'other\n');

  assert.throws(
    () =>
      createFileExclusive(dir, NAME, 'data', 0o644, {
        afterWrite: () => {
          fs.rmSync(file); // see the afterOpen test above: no rename over an open file, which Windows refuses
          fs.renameSync(replacement, file);
        },
      }),
    /changed while it was being created/,
  );

  assert.equal(fs.readFileSync(file, 'utf8'), 'other\n');
});

test('a pre-existing hard-linked file is refused and neither name is changed or removed', { skip: hardLinksWork }, () => {
  const { dir, file } = replaceable();
  const ext = victim();
  fs.linkSync(ext.file, file);

  assert.throws(() => createFileExclusive(dir, NAME, 'x'), /hard link/);

  assert.equal(sha(ext.file), ext.before);
  assert.equal(sha(file), ext.before);
});
