import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { indexProject } from '../src/core/ast/indexer.js';
import { validateProject } from '../src/core/validation/delta.js';
import { cleanup, context, workspace, write } from './helpers.js';

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

const ids = (list: { rule: string; file: string }[]): string[] => list.map((f) => `${f.rule}:${f.file}`).sort();
const kinds = (v: { configDowngrades: { kind: string }[] }): string[] => v.configDowngrades.map((d) => d.kind).sort();

// `: any` is reported by the suppression rule.
const BAD = 'export const old: any = 1;\n';
const FINDING = 'suppression:src/old.ts';

test('disabling an existing rule is a downgrade, and its findings are not counted as fixed', async () => {
  const root = repo({ 'src/old.ts': BAD, 'src/a.ts': 'export const a = 1;\n' });
  write(root, '.guardianrc', JSON.stringify({ rules: { suppression: 'off' } }));

  const result = await validate(root);
  assert.deepEqual(kinds(result), ['rule-disabled']);
  assert.ok(ids(result.suppressedByPolicy).includes(FINDING));
  assert.ok(!ids(result.fixed).includes(FINDING), 'turning a rule off does not fix anything');
});

test('lowering a rule\'s severity is a downgrade', async () => {
  const root = repo({ '.guardianrc': JSON.stringify({ rules: { suppression: 'high' } }), 'src/old.ts': BAD });
  write(root, '.guardianrc', JSON.stringify({ rules: { suppression: 'low' } }));

  const result = await validate(root);
  assert.ok(kinds(result).includes('severity-lowered'), kinds(result).join());
  assert.deepEqual(ids(result.fixed), []);
});

test('adding ignore patterns is a downgrade', async () => {
  const root = repo({ 'src/old.ts': BAD, 'src/a.ts': 'export const a = 1;\n' });
  write(root, '.guardianrc', JSON.stringify({ ignore: ['src/old.ts'] }));

  const result = await validate(root);
  assert.ok(kinds(result).includes('ignore-added'));
  assert.ok(ids(result.suppressedByPolicy).includes(FINDING));
  assert.ok(!ids(result.fixed).includes(FINDING));
});

test('adding an exception or an entry point is a downgrade', async () => {
  const root = repo({ 'src/old.ts': BAD, 'src/orphan.ts': 'export const o = 1;\n' });
  write(root, '.guardianrc', JSON.stringify({ exceptions: [{ rule: 'suppression', path: 'src/old.ts' }], entryPoints: ['src/orphan.ts'] }));

  const result = await validate(root);
  assert.deepEqual(kinds(result), ['entry-point-added', 'exception-added']);
  assert.ok(ids(result.suppressedByPolicy).includes(FINDING));
  assert.ok(!ids(result.fixed).includes(FINDING));
});

test('excluding previously analysed files through .gitignore is a downgrade', async () => {
  const root = repo({ 'src/old.ts': BAD, 'src/a.ts': 'export const a = 1;\n' });
  // The file stays tracked by git; only the analysis stops looking at it.
  write(root, '.gitignore', 'src/old.ts\n');

  const result = await validate(root);
  assert.ok(kinds(result).includes('files-excluded'), kinds(result).join());
  assert.ok(ids(result.suppressedByPolicy).includes(FINDING));
  assert.ok(!ids(result.fixed).includes(FINDING));
});

test('deleting a file is a code change, not an exclusion', async () => {
  const root = repo({ 'src/old.ts': BAD, 'src/a.ts': 'export const a = 1;\n' });
  git(root, 'rm', '-q', 'src/old.ts');

  const result = await validate(root);
  assert.deepEqual(kinds(result), []);
  assert.ok(ids(result.fixed).includes(FINDING));
});

test('a legitimate configuration improvement is not a downgrade', async () => {
  const root = repo({ '.guardianrc': JSON.stringify({ rules: { suppression: 'off' }, ignore: ['legacy/'] }), 'src/old.ts': BAD, 'legacy/x.ts': 'export const x: any = 1;\n' });
  write(root, '.guardianrc', JSON.stringify({}));

  const result = await validate(root);
  assert.deepEqual(kinds(result), []);
  assert.deepEqual(result.suppressedByPolicy, []);
  // Rules that were off, and files that were ignored, are now looked at: their findings are new to the analysis.
  assert.ok(ids(result.introduced).includes(FINDING));
});

test('a normal code fix without a configuration change is still a fix', async () => {
  const root = repo({ 'src/old.ts': BAD });
  write(root, 'src/old.ts', 'export const old = 1;\n');

  const result = await validate(root);
  assert.deepEqual(kinds(result), []);
  assert.deepEqual(result.suppressedByPolicy, []);
  assert.ok(ids(result.fixed).includes(FINDING));
});

// ---- the CI policy ----

const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'check', ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, GUARDIAN_LLM: 'off' } });

function weakened(): string {
  const root = repo({ 'src/old.ts': BAD, 'src/a.ts': 'export const a = 1;\n' });
  write(root, '.guardianrc', JSON.stringify({ rules: { suppression: 'off' } }));
  return root;
}

test('--config-policy fail exits 1 when the configuration was weakened, and names the reason', () => {
  const run = cli(weakened(), '--config-policy', 'fail');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /CONFIGURATION WEAKENED/);
  assert.match(run.stderr, /weakens the analysis configuration/);
});

test('--config-policy warn (the default) reports the downgrade without failing', () => {
  for (const args of [[], ['--config-policy', 'warn']]) {
    const run = cli(weakened(), ...args);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /CONFIGURATION WEAKENED/);
  }
});

test('--config-policy approve accepts the downgrade explicitly and still reports it', () => {
  const run = cli(weakened(), '--config-policy', 'approve');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /CONFIGURATION WEAKENED/);
  assert.match(run.stdout, /approved/);
});

test('--config-policy fail does not fail an unchanged configuration, and --json stays parseable', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/a.ts', 'export const a = 2;\n');
  const run = cli(root, '--config-policy', 'fail', '--json');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.configDowngrades, []);
  assert.deepEqual(report.failures, []);
});

test('an unknown --config-policy is a usage error', () => {
  assert.equal(cli(weakened(), '--config-policy', 'nonsense').status, 2);
});
