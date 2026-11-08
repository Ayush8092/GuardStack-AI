import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { indexProject } from '../src/core/ast/indexer.js';
import { renderValidation } from '../src/core/ast/report.js';
import { diffFindings, validateProject } from '../src/core/validation/delta.js';
import { parseNameStatus, collectChanges, detectRepo } from '../src/core/git/git.js';
import { InputError } from '../src/utils/errors.js';
import { cleanup, context, workspace, write } from './helpers.js';

after(cleanup);

const body = "const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate()]; return parts.map((p) => String(p).padStart(2, '0')).join('-');";

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(files: Record<string, string>, commit = true): string {
  const root = workspace(files);
  git(root, 'init', '-q', '-b', 'main');
  if (commit) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'baseline');
  }
  return root;
}

const baseline = {
  'src/util.ts': `export function formatDate(d: Date) { ${body} }\n`,
  'src/main.ts': "import { formatDate } from './util';\nconsole.log(formatDate(new Date()));\n",
  'src/legacy.ts': 'export const legacy: any = 1;\n',
  'src/dead.ts': 'export const dead = 1;\n',
};

async function validate(root: string, base?: string) {
  const ctx = context(root);
  const project = await indexProject(ctx);
  return (await validateProject(ctx, project, { base })).validation;
}

const rules = (list: { rule: string; file: string }[]) => list.map((f) => `${f.rule}:${f.file}`).sort();

test('parses NUL-separated name-status output including renames', () => {
  const raw = ['M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R092', 'old.ts', 'new.ts', 'T', 'link.ts', ''].join('\0');
  assert.deepEqual(parseNameStatus(raw), [
    { status: 'modified', path: 'a.ts' },
    { status: 'added', path: 'b.ts' },
    { status: 'deleted', path: 'c.ts' },
    { status: 'renamed', path: 'new.ts', oldPath: 'old.ts' },
    { status: 'modified', path: 'link.ts' },
  ]);
});

test('separates pre-existing findings from the ones this change introduced', async () => {
  const root = repo(baseline);
  const before = await validate(root);
  assert.equal(before.scope, 'changes');
  assert.deepEqual(before.introduced, []);
  assert.ok(before.existing.some((f) => f.rule === 'orphan-file' && f.file === 'src/legacy.ts'));

  write(root, 'src/copy.ts', `export function dateToString(d: Date) { ${body} }\n`);
  write(root, 'src/main.ts', "import { formatDate } from './util';\nimport { dateToString } from './copy';\n// @ts-ignore\nconsole.log(formatDate(new Date()), dateToString(new Date()));\n");
  write(root, 'src/lonely.ts', 'export const lonely = 1;\n');
  write(root, 'src/legacy.ts', 'export const legacy: any = 1;\nexport const more: any = 2;\n');

  const after = await validate(root);
  const introduced = rules(after.introduced);

  assert.ok(introduced.includes('duplicate-body:src/copy.ts') || introduced.includes('duplicate-body:src/util.ts'), introduced.join());
  assert.ok(introduced.includes('orphan-file:src/lonely.ts'));
  assert.ok(introduced.includes('suppression:src/main.ts'));
  assert.ok(!introduced.includes('orphan-file:src/legacy.ts'), 'a pre-existing orphan must not be blamed on this change');
  assert.ok(!introduced.includes('orphan-file:src/dead.ts'));

  const legacy = after.introduced.find((f) => f.rule === 'suppression' && f.file === 'src/legacy.ts');
  assert.equal(legacy?.count, 1);
  assert.match(legacy?.message ?? '', /1 new \(1 before\)/);

  assert.ok(after.existing.some((f) => f.rule === 'orphan-file' && f.file === 'src/legacy.ts'));
  assert.deepEqual(after.changes.map((c) => `${c.status}:${c.path}`), ['added:src/copy.ts', 'modified:src/legacy.ts', 'added:src/lonely.ts', 'modified:src/main.ts']);

  const text = renderValidation(after);
  assert.match(text, /Introduced by this change/);
  assert.match(text, /Pre-existing findings not shown/);
  assert.ok(!text.includes('src/dead.ts'));
});

test('credits the change for findings it fixes and blames it for damage in files it did not edit', async () => {
  const root = repo({ ...baseline, 'src/main.ts': "import { formatDate } from './util';\nimport { dead } from './dead';\nconsole.log(formatDate(new Date()), dead);\n" });
  write(root, 'src/main.ts', "import { formatDate } from './util';\nconsole.log(formatDate(new Date()));\n");
  write(root, 'src/legacy.ts', 'export const legacy = 1;\n');

  const result = await validate(root);
  assert.ok(result.fixed.some((f) => f.rule === 'suppression' && f.file === 'src/legacy.ts'));
  const indirect = result.introduced.find((f) => f.rule === 'orphan-file' && f.file === 'src/dead.ts');
  assert.ok(indirect, 'dead.ts became an orphan because main.ts stopped importing it');
  assert.equal(indirect.inChangedFile, false);
  assert.match(renderValidation(result), /Caused in files you did not edit|Introduced by this change/);
});

test('handles renames and deleted files', async () => {
  const root = repo(baseline);
  git(root, 'mv', 'src/dead.ts', 'src/renamed.ts');
  fs.rmSync(path.join(root, 'src/legacy.ts'));
  const result = await validate(root);

  assert.ok(result.changes.some((c) => c.status === 'renamed' && c.oldPath === 'src/dead.ts'));
  assert.ok(result.changes.some((c) => c.status === 'deleted' && c.path === 'src/legacy.ts'));
  assert.ok(result.fixed.some((f) => f.file === 'src/legacy.ts'));
  assert.ok(!result.introduced.some((f) => f.rule === 'orphan-file' && f.file === 'src/renamed.ts'), 'an already-orphaned file that was only renamed is not a new problem');
});

test('compares against a base ref and rejects unsafe or unknown refs', async () => {
  const root = repo(baseline);
  write(root, 'src/feature.ts', 'export const feature = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature');

  const clean = await validate(root);
  assert.deepEqual(clean.introduced, []);

  const sinceFirst = await validate(root, 'HEAD~1');
  assert.deepEqual(rules(sinceFirst.introduced), ['orphan-file:src/feature.ts']);

  const ctx = context(root);
  const project = await indexProject(ctx);
  await assert.rejects(validateProject(ctx, project, { base: '--upload-pack=evil' }), InputError);
  await assert.rejects(validateProject(ctx, project, { base: 'no-such-branch' }), /Unknown git ref/);
});

test('a repository with no commits treats every file as new', async () => {
  const root = repo({ 'a.ts': 'export const a: any = 1;\n' }, false);
  const state = await detectRepo(root);
  assert.deepEqual(state, { ok: true, head: null });
  const set = await collectChanges(root, { ok: true, head: null });
  assert.equal(set.baseSha, null);

  const result = await validate(root);
  assert.equal(result.scope, 'changes');
  assert.ok(result.introduced.some((f) => f.rule === 'suppression'));
});

test('outside a git repository the whole workspace is checked and the limitation is stated', async () => {
  const root = workspace({ 'a.ts': 'export const a: any = 1;\n' }, 'guardian-nogit-');
  const result = await validate(root);
  assert.equal(result.scope, 'workspace');
  assert.match(result.fallback ?? '', /not a git repository/);
  assert.match(renderValidation(result), /Could not isolate your changes/);
});

test('a workspace that is a subdirectory of a repository only sees its own changes', async () => {
  const top = repo({ 'app/src/a.ts': 'export const a = 1;\n', 'other/b.ts': 'export const b: any = 1;\n' });
  write(top, 'app/src/new.ts', 'export const fresh = 1;\n');
  write(top, 'other/b.ts', 'export const b: any = 2;\nexport const c: any = 3;\n');

  const result = await validate(path.join(top, 'app'));
  assert.deepEqual(result.changes.map((c) => c.path), ['src/new.ts']);
});

test('diffFindings keys findings by identity, not line number', () => {
  const finding = (line: number, count = 1) => ({ rule: 'suppression' as const, severity: 'low' as const, file: 'a.ts', line, message: 'any', key: 'suppression|a.ts|any', count, confidence: 'high' as const });
  assert.deepEqual(diffFindings([finding(3)], [finding(40)], new Set()).introduced, []);
  assert.equal(diffFindings([finding(3)], [finding(3, 2)], new Set(['a.ts'])).introduced[0].count, 1);
  assert.equal(diffFindings([finding(3, 2)], [finding(3)], new Set()).fixed.length, 1);
});
