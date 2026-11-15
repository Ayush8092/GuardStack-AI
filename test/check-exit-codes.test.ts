import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { indexProject } from '../src/core/ast/indexer.js';
import { MAX_CHANGED_FILES, validateProject } from '../src/core/validation/delta.js';
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

const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'check', ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, GUARDIAN_LLM: 'off' } });

async function validate(root: string) {
  const ctx = context(root);
  const project = await indexProject(ctx);
  return (await validateProject(ctx, project)).validation;
}

// For every partial situation: the validation says so, the default run still exits 0 (an interactive report), and
// --fail-on-partial turns it into exit code 1 with the reason on stderr.
function assertFailsClosed(root: string, reason: RegExp): void {
  const interactive = cli(root);
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.match(interactive.stdout, /Validation: PARTIAL/);

  const strict = cli(root, '--fail-on-partial');
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /validation is partial/);
  assert.match(strict.stdout, reason);
}

test('complete validation with no introduced findings passes, with or without --fail-on-partial', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/a.ts', 'export const a = 2;\n');
  for (const args of [[], ['--fail-on-partial'], ['--fail-on', 'low', '--fail-on-partial']]) {
    const run = cli(root, ...args);
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stdout, /Validation: COMPLETE/);
  }
});

test('more than the changed-file limit makes the validation partial and --fail-on-partial fails it', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < MAX_CHANGED_FILES + 1; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const root = repo(files);
  for (let i = 0; i < MAX_CHANGED_FILES + 1; i++) write(root, `src/f${i}.ts`, `export const v${i} = ${i + 1};\n`);

  const result = await validate(root);
  assert.equal(result.partial, true);
  assert.match(result.partialReasons.join('|'), /only the first 400 were compared/);
  assertFailsClosed(root, /only the first 400 were compared/);
});

test('a base file that cannot be read back makes the validation partial', async () => {
  // Over the default 512 KB limit at the base commit, small now.
  const big = `export const big = "${'x'.repeat(600 * 1024)}";\n`;
  const root = repo({ 'src/big.ts': big, 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/big.ts', 'export const big = 1;\n');

  const result = await validate(root);
  assert.equal(result.partial, true);
  assert.match(result.partialReasons.join('|'), /could not be read back from the base commit/);
  assertFailsClosed(root, /could not be read back from the base commit/);
});

test('an incomplete working-tree index makes the validation partial', async () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'tsconfig.json', '{ "compilerOptions": ');
  write(root, 'src/a.ts', 'export const a = 2;\n');

  const result = await validate(root);
  assert.equal(result.partial, true);
  assertFailsClosed(root, /tsconfig\.json could not be read or parsed/);
});

test('an unavailable baseline configuration makes the validation partial', async () => {
  // .guardianrc is invalid at the base commit and valid in the working tree.
  const root = repo({ '.guardianrc': '{ not json', 'src/a.ts': 'export const a = 1;\n' });
  write(root, '.guardianrc', '{}');
  write(root, 'src/a.ts', 'export const a = 2;\n');

  const result = await validate(root);
  assert.equal(result.partial, true);
  assert.match(result.partialReasons.join('|'), /Base configuration not reconstructed/);
  assertFailsClosed(root, /Base configuration not reconstructed/);
});

test('--json says why the check failed, and its stdout stays valid JSON', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'tsconfig.json', '{ "compilerOptions": ');
  const run = cli(root, '--json', '--fail-on-partial');
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.partial, true);
  assert.match(report.failures.join('|'), /--fail-on-partial/);
});
