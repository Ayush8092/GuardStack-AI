import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { indexProject } from '../src/core/ast/indexer.js';
import { validateProject } from '../src/core/validation/delta.js';
import { cleanup, context, workspace, write } from './helpers.js';

// End to end: the settings checked in test/policy-downgrade.test.ts, edited in a real repository and judged against its
// base commit, and the CI exit code that goes with them.

after(cleanup);

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo(files: Record<string, string>): string {
  const root = workspace(files);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline');
  return root;
}

async function validate(root: string) {
  const ctx = context(root);
  const project = await indexProject(ctx);
  return (await validateProject(ctx, project)).validation;
}

const kinds = (v: { configDowngrades: { kind: string }[] }): string[] => v.configDowngrades.map((d) => d.kind).sort();
const ids = (list: { rule: string; file: string }[]): string[] => list.map((f) => `${f.rule}:${f.file}`).sort();
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'check', ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, GUARDIAN_LLM: 'off' } });

const ORPHAN = 'src/page.ts';
const FILES = { '.guardianrc': JSON.stringify({ profile: 'none' }), 'src/index.ts': 'export const a = 1;\n', [ORPHAN]: 'export const page = 1;\n' };

test('switching the profile off "none" hides an orphan file; that is reported and the finding is not counted as fixed', async () => {
  const root = repo({ ...FILES, 'package.json': JSON.stringify({ name: 'x', dependencies: { next: '^15.0.0' } }) });
  write(root, '.guardianrc', JSON.stringify({ profile: 'next' }));

  const result = await validate(root);
  assert.ok(kinds(result).includes('profile-changed'), kinds(result).join());
  assert.ok(!ids(result.fixed).includes(`orphan-file:${ORPHAN}`), 'a profile change does not fix an orphan');
});

test('lowering a configured severity is reported although no finding changed', async () => {
  const root = repo({ ...FILES, '.guardianrc': JSON.stringify({ profile: 'none', rules: { 'orphan-file': 'high' } }) });
  write(root, '.guardianrc', JSON.stringify({ profile: 'none', rules: { 'orphan-file': 'low' } }));

  assert.ok(kinds(await validate(root)).includes('severity-lowered'));
});

test('removing a mask literal from .guardianrc is reported as weakened outbound protection', async () => {
  const root = repo({ ...FILES, '.guardianrc': JSON.stringify({ profile: 'none', maskLiterals: ['internal-token-value'] }) });
  write(root, '.guardianrc', JSON.stringify({ profile: 'none' }));

  const result = await validate(root);
  assert.ok(kinds(result).includes('outbound-weakened'));
  assert.ok(!JSON.stringify(result.configDowngrades).includes('internal-token-value'));
});

test('an unchanged profile and pythonRoots are not a downgrade', async () => {
  const root = repo({ ...FILES, '.guardianrc': JSON.stringify({ profile: 'none', pythonRoots: ['', 'src'] }) });
  write(root, 'src/index.ts', 'export const a = 2;\n');

  assert.deepEqual(kinds(await validate(root)), []);
});

test('--config-policy fail exits 1 for a profile change and --config-policy approve does not', () => {
  const root = repo({ ...FILES, 'package.json': JSON.stringify({ name: 'x', dependencies: { next: '^15.0.0' } }) });
  write(root, '.guardianrc', JSON.stringify({ profile: 'next' }));

  const failed = cli(root, '--config-policy', 'fail');
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /weakens the analysis configuration/);
  assert.equal(cli(root, '--config-policy', 'approve').status, 0);
});
