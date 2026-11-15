import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { UnsafeFileError, createFileByHardLink, createFileExclusive } from '../src/core/security/safe-file.js';
import { errorCode } from '../src/utils/errors.js';
import { cleanup, createDirectoryLink, directoryLinksWork, fileSymlinksWork, hardLinksWork, workspace } from './helpers.js';

// On Windows O_CREAT|O_EXCL without O_NOFOLLOW follows a dangling symlink and creates its target, so createFileExclusive
// publishes there with a hard link instead: a private staging directory next to the destination, then
// fs.linkSync(staged, destination), which refuses every existing entry. These tests run that strategy directly, so
// they exercise the same code on every platform, and pin the dispatch with a platform override. Each swap happens at
// one exact moment through the CreateHooks seams, and each test checks that nothing outside the intended file was
// created, modified or removed and that no staging directory is left behind (unless the test says why it must be).

after(cleanup);

const NAME = 'created.txt';
const STAGE = /^\.guardian-stage-/;
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stageDirs = (dir: string): string[] => fs.readdirSync(dir).filter((entry) => STAGE.test(entry));

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

// Moves `dir` aside and puts something else at its path. Returns false if the operating system refused the rename
// (Windows normally refuses to rename a directory that holds an open handle, which also stops this attack); the caller
// then asserts the matching outcome instead.
function swapDirectory(parent: string, dir: string, replacement: { real: true } | { link: string }): boolean {
  try {
    fs.renameSync(dir, path.join(parent, 'ws-old'));
  } catch (err) {
    if (['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(err) ?? '')) return false;
    throw err;
  }
  if ('link' in replacement) createDirectoryLink(replacement.link, dir);
  else fs.mkdirSync(dir);
  return true;
}

function attempt(run: () => boolean): { result?: boolean; error?: unknown } {
  try {
    return { result: run() };
  } catch (error) {
    return { error };
  }
}

const skip = hardLinksWork;

test('normal creation publishes the data, keeps the mode, and leaves no staging directory', { skip }, () => {
  const { dir, file } = replaceable();
  let stagedDuringPublish: string[] = [];

  assert.equal(
    createFileByHardLink(dir, NAME, 'hello\n', 0o600, {
      beforePublish: () => {
        stagedDuringPublish = stageDirs(dir);
      },
    }),
    true,
  );

  assert.equal(stagedDuringPublish.length, 1, 'the file really was staged first, in a directory next to the destination');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
  assert.deepEqual(fs.readdirSync(dir), [NAME], 'the staging directory was removed after success');
  assert.equal(fs.lstatSync(file).nlink, 1, 'the staged name is gone, one link remains');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('empty data creates an empty file (the cache database is created this way)', { skip }, () => {
  const { dir, file } = replaceable();

  assert.equal(createFileByHardLink(dir, NAME, '', 0o600), true);

  assert.equal(fs.statSync(file).size, 0);
  assert.deepEqual(fs.readdirSync(dir), [NAME]);
});

test('an existing regular file stays byte for byte unchanged and nothing is staged', { skip }, () => {
  const { dir, file } = replaceable();
  fs.writeFileSync(file, 'original\n');
  const before = sha(file);

  assert.equal(createFileByHardLink(dir, NAME, 'new\n'), false);

  assert.equal(sha(file), before);
  assert.deepEqual(fs.readdirSync(dir), [NAME]);
});

test('a regular file planted right before publication wins, is not modified, and staging is removed', { skip }, () => {
  const { dir, file } = replaceable();

  assert.equal(createFileByHardLink(dir, NAME, 'new\n', 0o644, { beforePublish: () => fs.writeFileSync(file, 'planted\n') }), false);

  assert.equal(fs.readFileSync(file, 'utf8'), 'planted\n');
  assert.deepEqual(fs.readdirSync(dir), [NAME]);
});

test('a dangling symlink planted right before publication is refused and its target is never created', { skip: skip || fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const missing = path.join(workspace(), 'would-be-created');

  assert.throws(() => createFileByHardLink(dir, NAME, 'x', 0o644, { beforePublish: () => fs.symlinkSync(missing, file) }), UnsafeFileError);

  assert.equal(fs.existsSync(missing), false, 'nothing was created through the link');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'the planted link is not ours to remove');
  assert.deepEqual(stageDirs(dir), [], 'staging was cleaned up after the failed publication');
});

test('a symlink to an existing file planted right before publication is refused and the target is untouched', { skip: skip || fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const ext = victim();

  assert.throws(() => createFileByHardLink(dir, NAME, 'x', 0o644, { beforePublish: () => fs.symlinkSync(ext.file, file) }), UnsafeFileError);

  assert.equal(sha(ext.file), ext.before);
  assert.deepEqual(stageDirs(dir), []);
});

test('a symlink planted before staging begins is refused as well', { skip: skip || fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const missing = path.join(workspace(), 'would-be-created');

  assert.throws(() => createFileByHardLink(dir, NAME, 'x', 0o644, { beforeOpen: () => fs.symlinkSync(missing, file) }), UnsafeFileError);

  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(stageDirs(dir), []);
});

test('a directory planted at the name is refused and left alone', { skip }, () => {
  const { dir, file } = replaceable();

  assert.throws(() => createFileByHardLink(dir, NAME, 'x', 0o644, { beforePublish: () => fs.mkdirSync(file) }), /not a regular file/);

  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.deepEqual(stageDirs(dir), []);
});

test('a failure after publication removes the file this call created and the staging directory', { skip }, () => {
  const { dir } = replaceable();
  const boom = new Error('hook failed');

  assert.throws(
    () =>
      createFileByHardLink(dir, NAME, 'x', 0o644, {
        afterOpen: () => {
          throw boom;
        },
      }),
    boom,
  );

  assert.deepEqual(fs.readdirSync(dir), [], 'neither the published file nor any staging leftover remains');
});

test('a hard link made right after publication is detected before any byte is written, and everything is cleaned up', { skip }, () => {
  const { dir, file } = replaceable();
  const alias = path.join(workspace(), 'alias');

  assert.throws(() => createFileByHardLink(dir, NAME, 'secret data', 0o644, { afterOpen: () => fs.linkSync(file, alias) }), /hard link/);

  assert.equal(fs.statSync(alias).size, 0, 'nothing was written through the extra link');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a different regular file swapped in after publication is detected and left alone', { skip }, () => {
  const { dir, file } = replaceable();
  const replacement = path.join(workspace(), 'replacement');
  fs.writeFileSync(replacement, 'other\n');

  assert.throws(
    () =>
      createFileByHardLink(dir, NAME, 'x', 0o644, {
        afterOpen: () => {
          fs.rmSync(file);
          fs.renameSync(replacement, file);
        },
      }),
    /changed while it was being created/,
  );

  assert.equal(fs.readFileSync(file, 'utf8'), 'other\n', 'the substitute is not ours to remove or write');
  assert.deepEqual(stageDirs(dir), []);
});

test('a symlink swapped in after publication is detected, the target is untouched and the link is left alone', { skip: skip || fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const ext = victim();

  assert.throws(
    () =>
      createFileByHardLink(dir, NAME, 'x', 0o644, {
        afterWrite: () => {
          fs.rmSync(file);
          fs.symlinkSync(ext.file, file);
        },
      }),
    UnsafeFileError,
  );

  assert.equal(sha(ext.file), ext.before);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('the staged file swapped for a symlink inside the staging directory is caught before publication', { skip: skip || fileSymlinksWork }, () => {
  const { dir, file } = replaceable();
  const ext = victim();

  assert.throws(
    () =>
      createFileByHardLink(dir, NAME, 'x', 0o644, {
        beforePublish: () => {
          const staged = path.join(dir, stageDirs(dir)[0] ?? '', 'file');
          fs.rmSync(staged);
          fs.symlinkSync(ext.file, staged);
        },
      }),
    /changed while it was being created/,
  );

  assert.equal(sha(ext.file), ext.before, 'the link target was neither linked nor written');
  assert.equal(fs.existsSync(file), false, 'nothing was published');
});

test('cleanup removes only what this call created: foreign content in the staging directory survives', { skip }, () => {
  const { dir, file } = replaceable();
  let foreign = '';

  assert.equal(
    createFileByHardLink(dir, NAME, 'x', 0o644, {
      beforePublish: () => {
        foreign = path.join(dir, stageDirs(dir)[0] ?? '', 'foreign.txt');
        fs.writeFileSync(foreign, 'not ours\n');
      },
    }),
    true,
  );

  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'not ours\n', 'a non-recursive rmdir never deletes what it did not create');
  assert.equal(fs.existsSync(path.join(path.dirname(foreign), 'file')), false, 'the staged name itself was removed');
});

test('a staging directory that cannot be removed while the descriptor is open is removed once it is closed', { skip }, (t: TestContext) => {
  const { dir, file } = replaceable();
  const originalRmdir = fs.rmdirSync;
  let refused = 0;
  // Windows can refuse to remove a directory while a handle inside it is still open. Simulate that for the first call.
  t.mock.method(fs, 'rmdirSync', (...args: Parameters<typeof fs.rmdirSync>) => {
    if (refused++ === 0) throw Object.assign(new Error('directory is busy'), { code: 'EBUSY' });
    return originalRmdir(...args);
  });

  assert.equal(createFileByHardLink(dir, NAME, 'x'), true);

  assert.equal(refused >= 2, true, 'removal was retried after the descriptor was closed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(dir), [NAME], 'no staging directory is left behind');
});

test('a directory replaced by a new real directory during creation is detected and nothing is created in it', { skip }, () => {
  const { parent, dir, file } = replaceable();
  let swapped = false;

  const { result, error } = attempt(() =>
    createFileByHardLink(dir, NAME, 'x', 0o644, { beforePublish: () => void (swapped = swapDirectory(parent, dir, { real: true })) }),
  );

  if (swapped) {
    assert.ok(error instanceof UnsafeFileError);
    assert.match((error as Error).message, /changed while it was being created/);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing was published into, or left in, the replacement directory');
    // Documented limit: the staging directory travelled with the renamed directory and cannot be reached by path.
    assert.equal(fs.existsSync(path.join(parent, 'ws-old', NAME)), false, 'but nothing was published there either');
  } else {
    assert.equal(error, undefined, 'the operating system refused the swap, so the creation proceeds normally');
    assert.equal(result, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  }
});

test('a directory replaced by a symlink during creation is detected and nothing is created behind it', { skip: skip || directoryLinksWork }, () => {
  const { parent, dir } = replaceable();
  const elsewhere = workspace();
  let swapped = false;

  const { error } = attempt(() =>
    createFileByHardLink(dir, NAME, 'x', 0o644, { beforePublish: () => void (swapped = swapDirectory(parent, dir, { link: elsewhere })) }),
  );

  if (swapped) {
    assert.ok(error instanceof UnsafeFileError);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'no file and no staging directory in the directory the link points to');
  } else {
    assert.equal(error, undefined, 'the operating system refused the swap, so the creation proceeds normally');
  }
});

test('a directory swapped for a link after publication never gets the data and a planted file there survives', { skip: skip || directoryLinksWork }, () => {
  const { parent, dir } = replaceable();
  const elsewhere = workspace({ [NAME]: 'planted\n' });
  let swapped = false;

  const { error } = attempt(() =>
    createFileByHardLink(dir, NAME, 'x', 0o644, { afterOpen: () => void (swapped = swapDirectory(parent, dir, { link: elsewhere })) }),
  );

  if (swapped) assert.ok(error instanceof UnsafeFileError);
  else assert.equal(error, undefined);
  assert.equal(fs.readFileSync(path.join(elsewhere, NAME), 'utf8'), 'planted\n', 'a file that is not ours is never removed or written');
});

test('when hard links cannot be used the creation fails closed and the destination is never opened', (t: TestContext) => {
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'UNKNOWN']) {
    const { dir, file } = replaceable();
    const originalOpen = fs.openSync;
    const opened: string[] = [];
    t.mock.method(fs, 'linkSync', () => {
      throw Object.assign(new Error('link refused'), { code });
    });
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      opened.push(String(args[0]));
      return originalOpen(...args);
    });

    assert.throws(
      () => createFileByHardLink(dir, NAME, 'x'),
      (err: unknown) => err instanceof UnsafeFileError && /hard link/.test(err.message) && err.message.includes(code),
      code,
    );

    assert.equal(fs.existsSync(file), false, `${code}: nothing was created`);
    assert.deepEqual(fs.readdirSync(dir), [], `${code}: staging was cleaned up`);
    assert.ok(!opened.includes(file), `${code}: there is no fallback that opens the destination with O_EXCL`);
    t.mock.restoreAll();
  }
});

test('a link that fails because the directory vanished is reported as a change, not as a missing feature', (t: TestContext) => {
  const { dir } = replaceable();
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  });

  assert.throws(() => createFileByHardLink(dir, NAME, 'x'), /changed while it was being created/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('createFileExclusive publishes by hard link on Windows and never opens the destination with O_EXCL', { skip }, (t: TestContext) => {
  const { dir, file } = replaceable();
  const missing = path.join(workspace(), 'would-be-created');
  const originalOpen = fs.openSync;
  const opened: string[] = [];
  let published = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0]));
    return originalOpen(...args);
  });

  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(createFileExclusive(dir, NAME, 'hello\n', 0o600, { beforePublish: () => void published++ }), true);
    assert.equal(published, 1, 'the hard-link strategy ran');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
    assert.ok(!opened.includes(file), 'the destination itself was never opened');

    // The confirmed defect: a dangling symlink at the destination must not get its target created.
    if (fileSymlinksWork === false) {
      const second = path.join(dir, 'second.txt');
      assert.throws(() => createFileExclusive(dir, 'second.txt', 'x', 0o644, { beforePublish: () => fs.symlinkSync(missing, second) }), UnsafeFileError);
      assert.equal(fs.existsSync(missing), false);
    }
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
});
