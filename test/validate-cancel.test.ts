import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { indexProject } from '../src/core/ast/indexer.js';
import { collectChanges, detectRepo, listTreeAtCommit, readBlob } from '../src/core/git/git.js';
import { refinePrompt } from '../src/core/prompt/refiner.js';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { reconstructBaseline } from '../src/core/validation/baseline.js';
import { validateProject } from '../src/core/validation/delta.js';
import { isAbort } from '../src/utils/pace.js';
import { cleanup, context, workspace, write } from './helpers.js';

after(cleanup);

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo(): string {
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const root = workspace(files);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline');
  for (let i = 0; i < 20; i++) write(root, `src/f${i}.ts`, `export const v${i} = ${i + 1};\n`);
  return root;
}

const cancelled = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};
const isCancel = (err: unknown): boolean => isAbort(err);

// A cancelled request must surface as a cancellation. Each of these used to be able to turn into "not a repository",
// "file unreadable" or "baseline unavailable", which a caller reads as a result.
test('every git helper rejects with the cancellation instead of reporting a git failure', async () => {
  const root = repo();
  const sha = git(root, 'rev-parse', 'HEAD').trim();
  const signal = cancelled();
  await assert.rejects(() => detectRepo(root, signal), isCancel);
  await assert.rejects(() => collectChanges(root, { ok: true, head: sha }, undefined, signal), isCancel);
  await assert.rejects(() => readBlob(root, sha, 'src/f1.ts', 1024, signal), isCancel);
  await assert.rejects(() => listTreeAtCommit(root, sha, signal), isCancel);
});

test('baseline reconstruction and validation reject with the cancellation', async () => {
  const root = repo();
  const ctx = context(root);
  const project = await indexProject(ctx);
  const sha = git(root, 'rev-parse', 'HEAD').trim();
  await assert.rejects(() => reconstructBaseline(ctx, sha, project, cancelled()), isCancel);
  await assert.rejects(() => validateProject(ctx, project, { signal: cancelled() }), isCancel);
});

test('without a signal nothing changes: the same repository validates normally', async () => {
  const root = repo();
  const ctx = context(root);
  const project = await indexProject(ctx);
  const { validation } = await validateProject(ctx, project);
  assert.equal(validation.scope, 'changes');
  assert.equal(validation.changes.length, 20);
});

test('a cancel that arrives while the baseline is being read stops the work', async () => {
  const root = repo();
  const ctx = context(root);
  const project = await indexProject(ctx);
  const controller = new AbortController();
  // Fires after the first event-loop turn, i.e. while git processes are still being spawned for the baseline.
  setImmediate(() => controller.abort());
  await assert.rejects(() => validateProject(ctx, project, { signal: controller.signal }), isCancel);
});

test('a cancelled optimize_prompt request is reported as cancelled, not as a skipped model step', async () => {
  const root = workspace({ 'src/a.ts': 'export function a() { return 1; }\n' });
  const ctx = context(root);
  const project = await indexProject(ctx);
  const { graph } = analyzeProject(project, ctx.config);
  await assert.rejects(() => refinePrompt(ctx, project, graph, 'add a helper', { mode: 'external', reason: 'enabled' }, { signal: cancelled() }), isCancel);
});
