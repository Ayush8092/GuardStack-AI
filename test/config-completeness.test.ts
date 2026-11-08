import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { pythonScriptTargets } from '../src/core/ast/packages.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { validateProject } from '../src/core/validation/delta.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

const FILES = { 'src/a.ts': "import { b } from './b';\nexport const a = b;\n", 'src/b.ts': 'export const b = 1;\n', 'src/lonely.ts': 'export const lonely = 1;\n' };

async function index(files: Record<string, string>) {
  const ctx = context(workspace(files));
  return { ctx, project: await indexProject(ctx) };
}

test('a valid project is complete and its coverage line says so', async () => {
  const { project } = await index({ ...FILES, 'package.json': '{"name":"x"}', 'tsconfig.json': '{"compilerOptions":{"strict":true}}' });
  assert.deepEqual(project.configProblems, []);
  assert.equal(project.complete, true);
  assert.match(describeCoverage(project, 100), /Analysis is complete/);
});

test('an invalid package.json makes the analysis partial and names the file', async () => {
  const { project } = await index({ ...FILES, 'package.json': '{ "name": ' });
  assert.deepEqual(project.configProblems, ['package.json could not be read or parsed']);
  assert.equal(project.complete, false);
  const text = describeCoverage(project, 100);
  assert.match(text, /PARTIAL/);
  assert.match(text, /configuration was unavailable \(package\.json could not be read or parsed\)/);
});

test('an invalid tsconfig in a subdirectory makes the analysis partial and names the file', async () => {
  const { project } = await index({ ...FILES, 'tsconfig.json': '{}', 'packages/web/tsconfig.json': '{ "compilerOptions": { "paths": ' });
  assert.deepEqual(project.configProblems, ['packages/web/tsconfig.json could not be read or parsed']);
  assert.equal(project.complete, false);
});

test('a tsconfig that extends a file that does not exist is reported, not silently treated as having no aliases', async () => {
  const { project } = await index({ ...FILES, 'tsconfig.json': JSON.stringify({ extends: './missing-base.json' }) });
  assert.deepEqual(project.configProblems, ['tsconfig.json extends a configuration file that could not be loaded']);
  assert.equal(project.complete, false);
});

test('a tsconfig that extends a package that is not installed is not treated as broken', async () => {
  const { project } = await index({ ...FILES, 'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node22/tsconfig.json' }) });
  assert.deepEqual(project.configProblems, []);
});

test('absence-based findings are not definitive when configuration could not be loaded', async () => {
  const good = await index({ ...FILES, 'package.json': '{"name":"x"}' });
  const bad = await index({ ...FILES, 'package.json': '{ broken' });
  const orphan = (r: { project: Parameters<typeof analyzeProject>[0]; ctx: { config: Parameters<typeof analyzeProject>[1] } }) =>
    analyzeProject(r.project, r.ctx.config).findings.find((f) => f.rule === 'orphan-file' && f.file === 'src/lonely.ts');
  assert.equal(orphan(good)?.classification, 'confidently-unused');
  assert.notEqual(orphan(bad)?.classification, 'confidently-unused', 'with package.json unavailable the orphan cannot be called confidently unused');
  assert.equal(orphan(bad)?.confidence, 'low');
});

test('validation of the working tree reports the unavailable configuration as a reason for a partial result', async () => {
  const root = workspace({ ...FILES, 'package.json': '{"name":"x"}' });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.c', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const fs = await import('node:fs');
  fs.writeFileSync(`${root}/package.json`, '{ broken');
  fs.appendFileSync(`${root}/src/a.ts`, '// edit\n');
  const ctx = context(root);
  const project = await indexProject(ctx);
  const { validation } = await validateProject(ctx, project);
  assert.equal(validation.partial, true);
  assert.match(validation.partialReasons.join('|'), /package\.json could not be read or parsed/);
});

test('pythonScriptTargets reads console scripts from pyproject.toml and nothing else', () => {
  const toml = [
    '[project]', 'name = "x"', 'dependencies = ["click"]', '',
    '[project.scripts]', 'naval = "naval:cli"', "tool = 'pkg.sub.main:run'  # comment", '',
    '[tool.poetry.scripts]', 'poet = "poetpkg.cli:main"', '',
    '[tool.other]', 'ignored = "should.not:count"',
  ].join('\n');
  const targets = pythonScriptTargets(toml);
  assert.ok(targets.includes('naval.py') && targets.includes('src/naval/__init__.py'));
  assert.ok(targets.includes('pkg/sub/main.py') && targets.includes('src/pkg/sub/main/__init__.py'));
  assert.ok(targets.includes('poetpkg/cli.py'));
  assert.ok(!targets.some((t) => t.includes('should')), 'other tables are not entry points');
  assert.deepEqual(pythonScriptTargets('[project]\nname = "x"\n'), []);
});

test('a module declared as a console script in pyproject.toml is an entry point, not an orphan', async () => {
  const { project, ctx } = await index({
    'examples/naval/pyproject.toml': '[project]\nname = "n"\n\n[project.scripts]\nnaval = "naval:cli"\n',
    'examples/naval/naval.py': 'import click\n\n\n@click.command()\ndef cli():\n    pass\n',
    'examples/other/other.py': 'def helper():\n    return 1\n',
  });
  const orphans = analyzeProject(project, ctx.config).findings.filter((f) => f.rule === 'orphan-file').map((f) => f.file);
  assert.deepEqual(orphans, ['examples/other/other.py']);
});

test('an alias import is not reported as broken when the tsconfig that defines the alias could not be read', async () => {
  const { project, ctx } = await index({
    'tsconfig.json': '{ "compilerOptions": { "paths": ',
    'src/ui/button.ts': 'export const button = 1;\n',
    'src/app.ts': "import { button } from '@/ui/button';\nexport const app = button;\n",
  });
  assert.equal(project.complete, false);
  const a = analyzeProject(project, ctx.config);
  assert.ok(!a.unresolved.some((u) => u.file === 'src/app.ts'), 'without the tsconfig the alias is unknown, not proven broken');
  assert.ok(a.findings.every((f) => f.rule !== 'unresolved-import'));
});

test('the CLI explains which configuration was unavailable, in text and in JSON, and still exits 0', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = workspace({ ...FILES, 'package.json': '{ "name": ' });
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, GUARDIAN_LLM: 'off' } });
  const text = run('scan');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /PARTIAL/);
  assert.match(text.stdout, /configuration was unavailable \(package\.json could not be read or parsed\)/);
  const json = JSON.parse(run('scan', '--json').stdout);
  assert.equal(json.complete, false);
  assert.deepEqual(json.configProblems, ['package.json could not be read or parsed']);
  const find = JSON.parse(run('find', '--json', 'anything').stdout);
  assert.deepEqual(find.configProblems, ['package.json could not be read or parsed']);
});

// ---- pyproject.toml and legacy entry points: configuration that decides which Python files are entry points ----

const PY = { 'pkg/__init__.py': '', 'pkg/runner.py': 'import click\n\n\n@click.command()\ndef main():\n    pass\n', 'pkg/util.py': 'def helper():\n    return 1\n', 'pkg/main.py': 'from .util import helper\n\nhelper()\n' };
const SCRIPTS = '[project]\nname = "p"\n\n[project.scripts]\ncli = "pkg.runner:main"\n';

test('a valid pyproject.toml, with or without scripts, leaves a Python project complete', async () => {
  for (const toml of [SCRIPTS, '[project]\nname = "p"\n']) {
    const { project } = await index({ ...PY, 'pyproject.toml': toml });
    assert.deepEqual(project.configProblems, [], toml);
    assert.equal(project.complete, true);
  }
});

test('an unreadable pyproject.toml in a Python project makes the analysis partial', async () => {
  // Larger than the configuration size limit, so it is listed but cannot be read.
  const { project } = await index({ ...PY, 'pyproject.toml': `${SCRIPTS}\n# ${'x'.repeat(300 * 1024)}\n` });
  assert.deepEqual(project.configProblems, ['pyproject.toml could not be read or parsed']);
  assert.equal(project.complete, false);
  assert.match(describeCoverage(project, 100), /configuration was unavailable \(pyproject\.toml could not be read or parsed\)/);
});

test('a malformed console script table makes the analysis partial and names the line', async () => {
  const { project } = await index({ ...PY, 'pyproject.toml': '[project]\nname = "p"\n\n[project.scripts]\ncli = pkg.runner:main\n' });
  assert.deepEqual(project.configProblems, ['pyproject.toml has a console script entry that could not be parsed (line 5)']);
  assert.equal(project.complete, false);
});

test('scripts declared in a form the reader does not follow are reported, not silently ignored', async () => {
  const { project } = await index({ ...PY, 'pyproject.toml': '[project]\nname = "p"\nscripts = { cli = "pkg.runner:main" }\n' });
  assert.match(project.configProblems.join('|'), /declares console scripts in a form that is not read \(line 3\)/);
});

test('a broken pyproject.toml does not matter for a project with no Python source', async () => {
  const { project } = await index({ ...FILES, 'pyproject.toml': '[project\nname = "x"\n' });
  assert.deepEqual(project.configProblems, []);
  assert.equal(project.complete, true);
});

test('setup.cfg or setup.py console scripts, which are not read, make a Python project partial unless pyproject.toml has scripts', async () => {
  const cfg = '[options.entry_points]\nconsole_scripts =\n    cli = pkg.runner:main\n';
  const a = await index({ ...PY, 'setup.cfg': cfg });
  assert.deepEqual(a.project.configProblems, ['setup.cfg declares console entry points, which are not read (only pyproject.toml scripts are)']);
  const b = await index({ ...PY, 'setup.py': "from setuptools import setup\nsetup(entry_points={'console_scripts': ['cli=pkg.runner:main']})\n" });
  assert.match(b.project.configProblems.join('|'), /setup\.py declares console entry points/);
  // A setup file with no entry points, or one next to a pyproject.toml that declares scripts, is not a problem.
  assert.deepEqual((await index({ ...PY, 'setup.py': 'from setuptools import setup\nsetup(name="p")\n' })).project.configProblems, []);
  assert.deepEqual((await index({ ...PY, 'setup.cfg': cfg, 'pyproject.toml': SCRIPTS })).project.configProblems, []);
});

test('with the entry-point configuration unavailable, a script module is not called confidently unused', async () => {
  const good = await index({ ...PY, 'pyproject.toml': SCRIPTS });
  const bad = await index({ ...PY, 'pyproject.toml': '[project.scripts]\ncli = pkg.runner:main\n' });
  const cli = (r: Awaited<ReturnType<typeof index>>) => analyzeProject(r.project, r.ctx.config).findings.find((f) => f.rule === 'orphan-file' && f.file === 'pkg/runner.py');
  assert.equal(cli(good), undefined, 'declared in pyproject.toml, so it is an entry point');
  assert.ok(cli(bad), 'with the scripts table unreadable the file is reported');
  assert.notEqual(cli(bad)?.classification, 'confidently-unused');
  assert.equal(cli(bad)?.confidence, 'low');
});

test('validation: a pyproject.toml that cannot be read at the base commit makes the result partial', async () => {
  const fs = await import('node:fs');
  const root = workspace({ ...PY, 'pyproject.toml': '[project.scripts]\ncli = pkg.runner:main\n' });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.c', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // Fixed in the working tree, so only the base is broken.
  fs.writeFileSync(`${root}/pyproject.toml`, SCRIPTS);
  fs.appendFileSync(`${root}/pkg/util.py`, '# edit\n');
  const ctx = context(root);
  const { validation } = await validateProject(ctx, await indexProject(ctx));
  assert.equal(validation.partial, true);
  assert.match(validation.partialReasons.join('|'), /pyproject\.toml could not be read or parsed at the base commit/);
});

// --- Poetry's file-based scripts: `name = { reference = "pkg/tool.py", type = "file" }` ----------------------------------------
// The module is named runner.py / worker.py on purpose: names like cli.py or main.py are exempt from the orphan rule by
// name, so a test using them would pass even if the table were ignored.

const POETRY = (entries: string): string => `[tool.poetry]\nname = "mypackage"\n\n[tool.poetry.scripts]\n${entries}\n`;
const FILE_ENTRY = 'my-tool = { reference = "mypackage/runner.py", type = "file" }';
const RUNNER = { 'mypackage/__init__.py': '', 'mypackage/runner.py': 'def main():\n    return 1\n', 'mypackage/unused_helper.py': 'def helper():\n    return 2\n' };
const orphansOf = (r: { project: Parameters<typeof analyzeProject>[0]; ctx: { config: Parameters<typeof analyzeProject>[1] } }) =>
  analyzeProject(r.project, r.ctx.config).findings.filter((f) => f.rule === 'orphan-file');

test('pythonScriptTargets resolves a Poetry file reference to exactly that file', () => {
  assert.deepEqual(pythonScriptTargets(POETRY(FILE_ENTRY)), ['mypackage/runner.py'], 'no src/ variants and no __init__.py guesses for an explicit file');
});

test('pythonScriptTargets accepts the spellings of a file reference that TOML allows', () => {
  const cases: [name: string, entry: string, expected: string[]][] = [
    ['reversed keys, single quotes, a ./ prefix and a comment', "my-tool = { type = 'file', reference = './mypackage/runner.py' }  # run it", ['mypackage/runner.py']],
    ['quoted key', '"my-tool" = { reference = "scripts/dev/tool.py", type = "file" }', ['scripts/dev/tool.py']],
    ['redundant path segments are normalised', 'my-tool = { reference = "scripts//dev/../tool.py", type = "file" }', ['scripts/tool.py']],
    ['no spaces inside the braces', 'my-tool={reference="a/b.py",type="file"}', ['a/b.py']],
    ['a file that is not Python source is understood and names nothing to track', 'my-tool = { reference = "bin/devtool", type = "file" }', []],
    ['type = "console" in a table works like the string form', 'my-tool = { reference = "mypackage.runner:main", type = "console" }', ['mypackage/runner.py', 'mypackage/runner/__init__.py', 'src/mypackage/runner.py', 'src/mypackage/runner/__init__.py']],
  ];
  for (const [name, entry, expected] of cases) assert.deepEqual(pythonScriptTargets(POETRY(entry)), expected, name);
});

test('pythonScriptTargets mixes string and file entries without changing what the string form returns', () => {
  const targets = pythonScriptTargets(POETRY(`naval = "naval:cli"\n${FILE_ENTRY}`));
  assert.deepEqual(targets, ['naval.py', 'naval/__init__.py', 'src/naval.py', 'src/naval/__init__.py', 'mypackage/runner.py']);
  assert.deepEqual(pythonScriptTargets(POETRY(`${FILE_ENTRY}\nnaval = "naval:cli"`)).sort(), [...targets].sort(), 'order of entries does not matter');
  assert.deepEqual(pythonScriptTargets(POETRY(FILE_ENTRY)), pythonScriptTargets(POETRY(FILE_ENTRY)), 'deterministic');
});

test('pythonScriptTargets never turns an entry it cannot interpret into a target', () => {
  const refused: Record<string, string> = {
    'path leaves the project': 'my-tool = { reference = "../x/runner.py", type = "file" }',
    'absolute path': 'my-tool = { reference = "/opt/runner.py", type = "file" }',
    'windows drive': 'my-tool = { reference = "C:/x/runner.py", type = "file" }',
    'escaped backslash': 'my-tool = { reference = "a\\\\b.py", type = "file" }',
    'unknown key': 'my-tool = { reference = "mypackage/runner.py", type = "file", extras = ["x"] }',
    'unknown type': 'my-tool = { reference = "mypackage/runner.py", type = "url" }',
    'no type': 'my-tool = { reference = "mypackage/runner.py" }',
    'no reference': 'my-tool = { type = "file" }',
    'non-string reference': 'my-tool = { reference = 1, type = "file" }',
    'repeated key': 'my-tool = { reference = "a.py", reference = "mypackage/runner.py", type = "file" }',
  };
  for (const [name, entry] of Object.entries(refused)) assert.deepEqual(pythonScriptTargets(POETRY(entry)), [], name);
});

test('a file table only counts under [tool.poetry.scripts]', () => {
  const entry = 'my-tool = { reference = "mypackage/runner.py", type = "file" }';
  assert.deepEqual(pythonScriptTargets(`[project.scripts]\n${entry}\n`), [], 'PEP 621 script values are strings');
  assert.deepEqual(pythonScriptTargets(`[tool.other]\n${entry}\n`), [], 'any other table is not a script declaration');
  assert.deepEqual(pythonScriptTargets(`[tool.poetry.scripts]\n[tool.other]\n${entry}\n`), [], 'a later table ends the script table');
});

test('a module declared by a Poetry file reference is an entry point, not an orphan, and its neighbours are still judged', async () => {
  const r = await index({ 'pyproject.toml': POETRY(FILE_ENTRY), ...RUNNER });
  assert.deepEqual(r.project.configProblems, []);
  assert.equal(r.project.complete, true);
  const orphans = orphansOf(r);
  assert.deepEqual(orphans.map((f) => f.file), ['mypackage/unused_helper.py'], 'only the file nothing declares or imports');
  assert.equal(orphans[0]?.classification, 'confidently-unused', 'the finding for a valid project is as strong as before');
  assert.deepEqual(analyzeProject(r.project, r.ctx.config).findings.filter((f) => f.file === 'mypackage/runner.py'), [], 'its exports are the script, not dead code');
});

test('without the declaration the same file is an orphan, so the table is what exempts it', async () => {
  const r = await index({ 'pyproject.toml': '[tool.poetry]\nname = "mypackage"\n', ...RUNNER });
  assert.deepEqual(orphansOf(r).map((f) => f.file).sort(), ['mypackage/runner.py', 'mypackage/unused_helper.py']);
});

test('a file reference and the equivalent string reference give identical findings', async () => {
  const viaFile = await index({ 'pyproject.toml': POETRY(FILE_ENTRY), ...RUNNER });
  const viaString = await index({ 'pyproject.toml': POETRY('my-tool = "mypackage.runner:main"'), ...RUNNER });
  const summary = (r: Parameters<typeof orphansOf>[0]) => analyzeProject(r.project, r.ctx.config).findings.map((f) => [f.rule, f.file, f.classification, f.confidence]);
  assert.deepEqual(summary(viaFile), summary(viaString));
});

test('a file reference is relative to the pyproject.toml that declares it', async () => {
  const r = await index({
    'services/api/pyproject.toml': POETRY('api = { reference = "app/worker.py", type = "file" }'),
    'services/api/app/__init__.py': '',
    'services/api/app/worker.py': 'def run():\n    return 1\n',
    'app/worker.py': 'def run():\n    return 2\n', // same relative path at the repository root: declared by nobody
  });
  assert.deepEqual(r.project.configProblems, []);
  assert.deepEqual(orphansOf(r).map((f) => f.file), ['app/worker.py']);
});

test('a file reference works with a src layout', async () => {
  const r = await index({
    'pyproject.toml': POETRY('my-tool = { reference = "src/mypackage/runner.py", type = "file" }'),
    'src/mypackage/__init__.py': '',
    'src/mypackage/runner.py': 'def main():\n    return 1\n',
  });
  assert.deepEqual(orphansOf(r), []);
});

test('an entry that cannot be interpreted is reported as a configuration limitation, and its file is not called confidently unused', async () => {
  for (const entry of [
    'my-tool = { reference = "mypackage/runner.py", type = "file", extras = ["x"] }',
    'my-tool = { reference = "../mypackage/runner.py", type = "file" }',
    'my-tool = { reference = "mypackage/runner.py", type = "url" }',
  ]) {
    const r = await index({ 'pyproject.toml': POETRY(entry), ...RUNNER });
    assert.equal(r.project.configProblems.length, 1, entry);
    assert.match(r.project.configProblems[0] as string, /^pyproject\.toml has a console script entry in a form that is not read \(line 5\); supported: /, entry);
    assert.equal(r.project.complete, false, entry);
    assert.match(describeCoverage(r.project, 100), /configuration was unavailable \(pyproject\.toml has a console script entry/, entry);

    const runner = orphansOf(r).find((f) => f.file === 'mypackage/runner.py');
    assert.ok(runner, `${entry}: still reported as unreferenced`);
    assert.notEqual(runner.classification, 'confidently-unused', entry);
    assert.equal(runner.confidence, 'low', entry);
  }
});

test('an entry that cannot be interpreted does not hide the valid entries beside it', async () => {
  const entries = `${FILE_ENTRY}\nbad-tool = { reference = "mypackage/other.py", type = "url" }`;
  const r = await index({ 'pyproject.toml': POETRY(entries), ...RUNNER, 'mypackage/other.py': 'X = 1\n' });
  assert.equal(r.project.configProblems.length, 1);
  assert.match(r.project.configProblems[0] as string, /\(line 6\)/, 'names the line of the entry that is not read');
  assert.ok(!orphansOf(r).some((f) => f.file === 'mypackage/runner.py'), 'the valid declaration still exempts its file');
});

test('a script table spread over several lines is reported, not silently dropped', async () => {
  const r = await index({ 'pyproject.toml': POETRY('my-tool = {\n  reference = "mypackage/runner.py",\n  type = "file" }'), ...RUNNER });
  assert.match(r.project.configProblems.join('|'), /console script entry in a form that is not read \(line 5\)/);
  assert.equal(r.project.complete, false);
});
