import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { indexProject, readGitignore, readGitignoreState } from '../src/core/ast/indexer.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { validateProject } from '../src/core/validation/delta.js';
import { cleanup, context, fileSymlinksWork, workspace } from './helpers.js';

after(cleanup);

// A missing .gitignore is normal and leaves the scan complete. A .gitignore that exists but cannot be applied (unreadable,
// unsafe, oversized, not a regular file) changes which files get analysed, so the scan is partial and says why.

const SOURCES = { 'src/a.ts': 'export const a = 1;\n', 'build-output/gen.ts': 'export const generated = 1;\n' };
const paths = async (root: string) => {
  const ctx = context(root);
  const project = await indexProject(ctx);
  return { project, ctx, files: project.files.map((f) => f.path).sort() };
};

test('no .gitignore at all: a normal complete scan', async () => {
  const { project, files } = await paths(workspace(SOURCES));
  assert.deepEqual(project.configProblems, []);
  assert.equal(project.complete, true);
  assert.deepEqual(files, ['build-output/gen.ts', 'src/a.ts']);
  assert.deepEqual(readGitignoreState(workspace(SOURCES)), { text: '', problem: null });
});

test('a readable .gitignore is applied and the scan stays complete', async () => {
  const { project, files } = await paths(workspace({ ...SOURCES, '.gitignore': 'build-output/\n' }));
  assert.deepEqual(files, ['src/a.ts']);
  assert.deepEqual(project.configProblems, []);
  assert.equal(project.complete, true);
});

test('an oversized .gitignore is not applied, and the scan is partial and says so', async () => {
  const root = workspace({ ...SOURCES, '.gitignore': `build-output/\n${'# padding\n'.repeat(40_000)}` });
  assert.ok(fs.statSync(path.join(root, '.gitignore')).size > 256 * 1024);
  const { project, ctx, files } = await paths(root);
  assert.equal(project.complete, false, 'a scan whose ignore rules were not applied is never complete');
  assert.ok(project.configProblems.some((p) => /\.gitignore was not applied/.test(p) && /too large/i.test(p)), project.configProblems.join('|'));
  assert.deepEqual(files, ['build-output/gen.ts', 'src/a.ts'], 'the rules were not applied, which the report must not hide');
  assert.match(describeCoverage(project, ctx.config.maxFiles), /\.gitignore was not applied/);
  assert.equal(readGitignore(root), '', 'the string API keeps returning an empty ignore file');
});

test('a .gitignore that is a directory is a problem, not an absent file', async () => {
  const { project } = await paths(workspace({ ...SOURCES, '.gitignore/keep': 'x' }));
  assert.equal(project.complete, false);
  assert.ok(project.configProblems.some((p) => /\.gitignore was not applied/.test(p)));
});

test('a .gitignore symlinked outside the workspace is not applied and is reported', { skip: fileSymlinksWork }, async () => {
  const root = workspace(SOURCES);
  const outside = workspace({ 'rules': 'src/\n' });
  fs.symlinkSync(path.join(outside, 'rules'), path.join(root, '.gitignore'));
  const { project, files } = await paths(root);
  assert.equal(project.complete, false);
  assert.ok(project.configProblems.some((p) => /\.gitignore was not applied/.test(p)));
  assert.ok(files.includes('src/a.ts'), 'the outside file\'s rules did not reach the analysis');
});

test('a dangling .gitignore symlink is a problem, not an absent file', { skip: fileSymlinksWork }, async () => {
  const root = workspace(SOURCES);
  fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(root, '.gitignore'));
  const { project } = await paths(root);
  assert.equal(project.complete, false);
  assert.ok(project.configProblems.some((p) => /\.gitignore was not applied/.test(p)));
});

test('a hard-linked .gitignore is not applied and is reported', async (t) => {
  const root = workspace({ ...SOURCES, 'rules.txt': 'build-output/\n' });
  try {
    fs.linkSync(path.join(root, 'rules.txt'), path.join(root, '.gitignore'));
  } catch {
    t.skip('hard links cannot be created here');
    return;
  }
  if (fs.statSync(path.join(root, '.gitignore')).nlink < 2) {
    t.skip('this file system does not report hard link counts');
    return;
  }
  const { project, files } = await paths(root);
  assert.equal(project.complete, false);
  assert.ok(project.configProblems.some((p) => /\.gitignore was not applied/.test(p) && /hard-linked/.test(p)));
  assert.ok(files.includes('build-output/gen.ts'));
});

test('an unreadable .gitignore is reported', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'permissions cannot make a file unreadable here' : false }, async () => {
  const root = workspace({ ...SOURCES, '.gitignore': 'build-output/\n' });
  fs.chmodSync(path.join(root, '.gitignore'), 0o000);
  try {
    const { project } = await paths(root);
    assert.equal(project.complete, false);
    assert.ok(project.configProblems.some((p) => /\.gitignore was not applied/.test(p)));
  } finally {
    fs.chmodSync(path.join(root, '.gitignore'), 0o644);
  }
});

test('a validation that could not apply .gitignore is partial', async () => {
  const root = workspace(SOURCES);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), `x\n${'# padding\n'.repeat(40_000)}`);

  const ctx = context(root);
  const project = await indexProject(ctx);
  const { validation } = await validateProject(ctx, project);
  assert.equal(validation.partial, true);
  assert.match(validation.partialReasons.join('|'), /configuration|\.gitignore/i);
});
