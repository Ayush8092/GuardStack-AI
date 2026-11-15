import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ensureConfig, ensureGitignore } from '../src/cli/commands/init-files.js';
import { UnsafeFileError } from '../src/core/security/safe-file.js';
import { appendToRegularFile } from '../src/core/security/safe-file.js';
import { cleanup, fileSymlinksWork, workspace } from './helpers.js';

after(cleanup);

const RC = '.guardianrc';
const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isLink = (file: string): boolean => fs.lstatSync(file).isSymbolicLink();

// An "outside" directory that holds a file the attack wants to modify or create.
function outside(): { dir: string; victim: string; missing: string; before: string } {
  const dir = workspace({ 'victim.txt': 'precious outside data\n' });
  const victim = path.join(dir, 'victim.txt');
  return { dir, victim, missing: path.join(dir, 'does-not-exist-yet'), before: sha(victim) };
}

test('.gitignore symlink to a file outside the workspace is refused and the target is untouched', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const ext = outside();
  fs.symlinkSync(ext.victim, path.join(root, '.gitignore'));

  assert.throws(() => ensureGitignore(root), UnsafeFileError);

  assert.equal(sha(ext.victim), ext.before);
  assert.ok(isLink(path.join(root, '.gitignore')), 'the planted link is left as it was');
});

test('.gitignore dangling symlink is refused and its target is never created', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const ext = outside();
  fs.symlinkSync(ext.missing, path.join(root, '.gitignore'));

  assert.throws(() => ensureGitignore(root), UnsafeFileError);

  assert.equal(fs.existsSync(ext.missing), false);
  assert.ok(isLink(path.join(root, '.gitignore')));
});

test('.guardianrc symlink to a file outside the workspace is refused and the target is untouched', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const ext = outside();
  fs.symlinkSync(ext.victim, path.join(root, RC));

  assert.throws(() => ensureConfig(root, RC), UnsafeFileError);

  assert.equal(sha(ext.victim), ext.before);
  assert.ok(isLink(path.join(root, RC)));
});

test('.guardianrc dangling symlink is refused and its target is never created', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const ext = outside();
  fs.symlinkSync(ext.missing, path.join(root, RC));

  assert.equal(fs.existsSync(path.join(root, RC)), false, 'precondition: existsSync is fooled by a dangling link');
  assert.throws(() => ensureConfig(root, RC), UnsafeFileError);

  assert.equal(fs.existsSync(ext.missing), false);
  assert.ok(isLink(path.join(root, RC)));
});

test('a symlink that stays inside the workspace is refused too', { skip: fileSymlinksWork }, () => {
  const root = workspace({ 'real-ignore': 'node_modules/\n' });
  fs.symlinkSync(path.join(root, 'real-ignore'), path.join(root, '.gitignore'));

  assert.throws(() => ensureGitignore(root), UnsafeFileError);
  assert.equal(fs.readFileSync(path.join(root, 'real-ignore'), 'utf8'), 'node_modules/\n');
});

test('a directory where a file belongs is refused', () => {
  const root = workspace({ '.gitignore/keep': 'x', '.guardianrc/keep': 'x' });

  assert.throws(() => ensureGitignore(root), UnsafeFileError);
  assert.throws(() => ensureConfig(root, RC), UnsafeFileError);
});

test('files that do not exist are created with the expected content', () => {
  const root = workspace();

  ensureConfig(root, RC);
  ensureGitignore(root);

  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.guardian/\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, RC), 'utf8')), { ignore: [], llm: true });
});

test('existing regular files keep their content; .gitignore gains one entry and a second run changes nothing', () => {
  const root = workspace({ '.gitignore': 'node_modules/\ndist', [RC]: '{"ignore":["gen/**"],"llm":false}\n' });

  ensureConfig(root, RC);
  ensureGitignore(root);
  const once = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  ensureGitignore(root);

  assert.equal(once, 'node_modules/\ndist\n.guardian/\n');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), once);
  assert.equal(fs.readFileSync(path.join(root, RC), 'utf8'), '{"ignore":["gen/**"],"llm":false}\n');
});

test('a .gitignore that already lists .guardian is not modified', () => {
  const root = workspace({ '.gitignore': '/.guardian\nbuild/\n' });
  const before = sha(path.join(root, '.gitignore'));

  ensureGitignore(root);

  assert.equal(sha(path.join(root, '.gitignore')), before);
});

test('an oversized .gitignore is refused instead of being read into memory', () => {
  const root = workspace({ '.gitignore': 'x'.repeat(2 * 1024 * 1024) });

  assert.throws(() => ensureGitignore(root), /too large/);
});

test('a symlink swapped in after the file was opened is detected before anything is written', { skip: fileSymlinksWork }, () => {
  const root = workspace({ '.gitignore': 'build/\n' });
  const ext = outside();
  const file = path.join(root, '.gitignore');

  assert.throws(
    () =>
      appendToRegularFile(root, '.gitignore', 1024, (current) => {
        fs.rmSync(file);
        fs.symlinkSync(ext.victim, file);
        return `${current}.guardian/\n`;
      }),
    UnsafeFileError,
  );

  assert.equal(sha(ext.victim), ext.before);
});

test('a different regular file swapped in after the file was opened is detected too', () => {
  const root = workspace({ '.gitignore': 'build/\n', 'replacement': 'other\n' });
  const file = path.join(root, '.gitignore');

  assert.throws(
    () =>
      appendToRegularFile(root, '.gitignore', 1024, () => {
        // Windows refuses to rename over a file that is still open: remove the name first, then move the substitute in.
        fs.rmSync(file);
        fs.renameSync(path.join(root, 'replacement'), file);
        return '.guardian/\n';
      }),
    UnsafeFileError,
  );

  assert.equal(fs.readFileSync(file, 'utf8'), 'other\n');
});

test('only plain file names directly inside the directory are accepted', () => {
  const root = workspace();

  for (const name of ['../escape', 'sub/file', '..', '.', '', 'a\\b']) {
    assert.throws(() => ensureConfig(root, name), UnsafeFileError, `rejects ${JSON.stringify(name)}`);
  }
});
