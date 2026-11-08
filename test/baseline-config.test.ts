import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('a package.json edit that removes a public entry is judged against the manifest of the base commit', async () => {
  const root = repo({
    'package.json': JSON.stringify({ name: 'lib', exports: './src/public.ts' }),
    'src/public.ts': 'export const api = 1;\n',
    'src/other.ts': 'export const x = 1;\n',
  });
  // Today's manifest no longer exposes src/public.ts, so it is now an orphan. At the base it was a public entry.
  write(root, 'package.json', JSON.stringify({ name: 'lib' }));
  write(root, 'src/other.ts', 'export const x = 2;\n');

  const result = await validate(root);
  assert.ok(ids(result.introduced).includes('orphan-file:src/public.ts'), `introduced: ${ids(result.introduced).join()}`);
  assert.ok(result.baselineNotes.some((n) => /package\.json/.test(n)), result.baselineNotes.join('|'));
  assert.equal(result.partial, false, result.partialReasons.join('|'));
});

test('a package.json edit alone is validated even when no source file changed', async () => {
  const root = repo({
    'package.json': JSON.stringify({ name: 'lib', exports: './src/public.ts' }),
    'src/public.ts': 'export const api = 1;\n',
  });
  write(root, 'package.json', JSON.stringify({ name: 'lib' }));
  const result = await validate(root);
  assert.equal(result.scope, 'changes');
  assert.ok(ids(result.introduced).includes('orphan-file:src/public.ts'), ids(result.introduced).join());
});

test('framework detection uses the dependencies of the base commit', async () => {
  const root = repo({
    'package.json': JSON.stringify({ name: 'site', dependencies: { next: '^15.0.0' } }),
    'pages/about.ts': 'export default function About() { return 1; }\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  // Without `next` today, pages/about.ts is just an unimported file. At the base it was a framework route.
  write(root, 'package.json', JSON.stringify({ name: 'site' }));
  const result = await validate(root);
  assert.ok(ids(result.introduced).includes('orphan-file:pages/about.ts'), `introduced: ${ids(result.introduced).join()}`);
  assert.ok(result.baselineNotes.some((n) => /package\.json/.test(n)));
});

test('an invalid .guardianrc at the base commit makes the validation partial', async () => {
  const root = repo({ '.guardianrc': '{"bogusKey": true}', 'src/a.ts': 'export const a = 1;\n' });
  write(root, '.guardianrc', '{}');
  write(root, 'src/a.ts', 'export const a = 2;\n');
  const result = await validate(root);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.some((r) => /\.guardianrc/.test(r) && /invalid/.test(r)), result.partialReasons.join('|'));
});

test('an unparseable tsconfig or package.json at the base commit makes the validation partial', async () => {
  const root = repo({
    'tsconfig.json': '{ not json',
    'package.json': '{ also not json',
    'src/a.ts': 'export const a = 1;\n',
  });
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
  write(root, 'package.json', JSON.stringify({ name: 'x' }));
  const result = await validate(root);
  assert.equal(result.partial, true);
  const reasons = result.partialReasons.join('|');
  assert.match(reasons, /tsconfig\.json could not be read or parsed/);
  assert.match(reasons, /package\.json could not be read or parsed/);
});

// Changed deliberately: a broken tsconfig in the working tree now makes the analysis partial on its own (it is unavailable
// configuration), but it is reported as that, not as a failure to reconstruct the base commit.
test('a config that is equally broken before and after is reported as unavailable now, not as a base reconstruction failure', async () => {
  const root = repo({ 'tsconfig.json': '{ not json', 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/a.ts', 'export const a = 2;\n');
  const result = await validate(root);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.some((r) => /Configuration unavailable in the working tree: tsconfig\.json could not be read or parsed/.test(r)), result.partialReasons.join('|'));
  assert.ok(!result.partialReasons.some((r) => /Base configuration not reconstructed/.test(r)), 'the base commit was reconstructed as well as it can be');
});

test('unchanged, valid configuration stays a definitive result', async () => {
  const root = repo({ '.guardianrc': '{"ignore":["gen/"]}', 'package.json': '{"name":"x"}', 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/a.ts', 'export const a = 2;\n');
  const result = await validate(root);
  assert.equal(result.partial, false, result.partialReasons.join('|'));
  assert.deepEqual(result.baselineNotes, []);
});
