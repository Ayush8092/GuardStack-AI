import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { after, test } from 'node:test';
import { cleanup, workspace } from './helpers.js';

after(cleanup);

// `scan`, `check` and `find` are separate commands with separate JSON builders. They must all say the same thing about
// configuration that could not be loaded, because a consumer of any one of them cannot tell the analysis was partial otherwise.
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, GUARDIAN_LLM: 'off' } });

function repo(files: Record<string, string>): string {
  const root = workspace(files);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.c', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  fs.appendFileSync(`${root}/src/a.ts`, '// edit\n');
  return root;
}

function reports(root: string) {
  const parse = (args: string[]) => {
    const run = cli(root, ...args);
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
    return JSON.parse(run.stdout);
  };
  return { scan: parse(['scan', '--json']), find: parse(['find', '--json', 'anything']), check: parse(['check', '--json']) };
}

const SRC = { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': "import { a } from './a';\nexport const b = a;\n" };

test('check --json lists the unavailable configuration, exactly as scan and find do', () => {
  const root = repo({ ...SRC, 'package.json': '{ "name": ' });
  const { scan, find, check } = reports(root);
  const expected = ['package.json could not be read or parsed'];
  assert.deepEqual(check.configProblems, expected);
  assert.deepEqual(scan.configProblems, expected);
  assert.deepEqual(find.configProblems, expected);
  for (const report of [scan, find, check]) assert.equal(report.complete, false);
  // check also carries the validation verdict: partial, with the configuration named as a reason.
  assert.equal(check.partial, true);
  assert.match(check.partialReasons.join('|'), /package\.json could not be read or parsed/);
});

test('every command reports an empty configProblems array, not a missing field, for a valid project', () => {
  const root = repo({ ...SRC, 'package.json': '{"name":"x"}', 'tsconfig.json': '{}' });
  const { scan, find, check } = reports(root);
  for (const [name, report] of Object.entries({ scan, find, check })) {
    assert.deepEqual(report.configProblems, [], name);
    assert.equal(report.complete, true, name);
  }
  assert.equal(check.partial, false);
});

test('a pyproject.toml problem in a Python project appears in all three commands', () => {
  const root = repo({
    'src/a.ts': 'export const a = 1;\n',
    'pkg/__init__.py': '',
    'pkg/runner.py': 'def main():\n    pass\n',
    'pyproject.toml': '[project.scripts]\ncli = pkg.runner:main\n',
  });
  const { scan, find, check } = reports(root);
  const expected = ['pyproject.toml has a console script entry that could not be parsed (line 2)'];
  assert.deepEqual(scan.configProblems, expected);
  assert.deepEqual(find.configProblems, expected);
  assert.deepEqual(check.configProblems, expected);
  assert.equal(check.partial, true);
});

test('text output of check names the unavailable configuration too', () => {
  const root = repo({ ...SRC, 'tsconfig.json': '{ "compilerOptions": ' });
  const run = cli(root, 'check');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PARTIAL/);
  assert.match(run.stdout, /tsconfig\.json could not be read or parsed/);
});
