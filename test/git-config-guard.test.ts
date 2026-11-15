import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { InputError } from '../src/utils/errors.js';
import { collectChanges, detectRepo } from '../src/core/git/git.js';

// `git diff <commit>` compares the working tree and so runs the clean filter of any file whose attributes name one. The command
// comes from the repository's own .git/config, which a repository handed over as a directory or archive controls.

const scratch: string[] = [];
after(() => scratch.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-gitcfg-')));
  scratch.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); // modified, so git has to look at the content
  return dir;
}

async function changes(root: string) {
  const state = await detectRepo(root);
  assert.ok(state.ok);
  return collectChanges(root, state);
}

test('a clean filter defined in the repository configuration is refused and never run', async () => {
  const root = repo();
  const marker = path.join(root, '..', `${path.basename(root)}-PWNED`);
  scratch.push(marker);
  const command = `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(marker.replace(/\\/g, '/'))}`;
  git(root, 'config', 'filter.pwn.clean', command);
  fs.writeFileSync(path.join(root, '.gitattributes'), '* filter=pwn\n');

  await assert.rejects(changes(root), (err: unknown) => err instanceof InputError && err.code === 'unsafe_repository_config');
  assert.equal(fs.existsSync(marker), false, 'the filter command must not have run');
});

test('smudge and process filters are refused as well', async () => {
  for (const key of ['filter.x.smudge', 'filter.x.process']) {
    const root = repo();
    git(root, 'config', key, 'echo hi');
    await assert.rejects(changes(root), (err: unknown) => err instanceof InputError && err.code === 'unsafe_repository_config', key);
  }
});

test('the filter commands Git LFS installs are accepted', async () => {
  const root = repo();
  git(root, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
  git(root, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
  git(root, 'config', 'filter.lfs.process', 'git-lfs filter-process');
  const result = await changes(root);
  assert.deepEqual(result.changes.map((c) => c.path), ['a.txt']);
});

test('a lookalike of the LFS command is not accepted', async () => {
  const root = repo();
  git(root, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f; echo pwned');
  await assert.rejects(changes(root), (err: unknown) => err instanceof InputError && err.code === 'unsafe_repository_config');
});

test('a repository without filters is unaffected', async () => {
  const root = repo();
  const result = await changes(root);
  assert.deepEqual(result.changes.map((c) => c.path), ['a.txt']);
});
