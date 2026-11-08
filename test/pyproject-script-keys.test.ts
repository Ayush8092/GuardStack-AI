import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { pyprojectProblem, pythonScriptTargets } from '../src/core/ast/packages.js';
import { describeCoverage } from '../src/core/ast/report.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

// Every string below was checked with Python's tomllib: they are all valid TOML. They differ only in how a script is spelled.
const SPELLINGS: Record<string, string> = {
  'bare key': '[project.scripts]\nmy-cmd = "pkg.mod:fn"\n',
  'double-quoted key': '[project.scripts]\n"my-cmd" = "pkg.mod:fn"\n',
  'single-quoted key': "[project.scripts]\n'my-cmd' = \"pkg.mod:fn\"\n",
  'literal-string value': "[project.scripts]\n\"my-cmd\" = 'pkg.mod:fn'\n",
  'comments after header and entry': '[project.scripts]  # entry points\n"my-cmd" = "pkg.mod:fn"  # run it\n',
  'spaces inside the header': '[ project.scripts ]\n"my-cmd" = "pkg.mod:fn"\n',
  'quoted header part': '[project."scripts"]\n"my-cmd" = "pkg.mod:fn"\n',
  'extras after the callable': '[project.scripts]\n"my-cmd" = "pkg.mod:fn [extra]"\n',
  'gui-scripts table': '[project.gui-scripts]\n"my-cmd" = "pkg.mod:fn"\n',
  'Poetry scripts table': '[tool.poetry.scripts]\n"my-cmd" = "pkg.mod:fn"\n',
};

// Valid TOML that names an entry point in a way this reader does not interpret.
const UNINTERPRETED: Record<string, string> = {
  'unicode escape in the value': '[project.scripts]\n"my-cmd" = "pkg.\\u006dod:fn"\n',
  'module name that is not an identifier': '[project.scripts]\n"my-cmd" = "my-pkg.mod:fn"\n',
};

const TARGETS = ['pkg/mod.py', 'pkg/mod/__init__.py', 'src/pkg/mod.py', 'src/pkg/mod/__init__.py'];
const PKG = { 'pkg/__init__.py': '', 'pkg/mod.py': 'def fn():\n    pass\n', 'pkg/dead.py': 'def unused():\n    return 1\n' };

async function analyse(toml: string) {
  const ctx = context(workspace({ ...PKG, 'pyproject.toml': toml }));
  const project = await indexProject(ctx);
  return { project, analysis: analyzeProject(project, ctx.config) };
}

const orphans = (a: Awaited<ReturnType<typeof analyse>>) => a.analysis.findings.filter((f) => f.rule === 'orphan-file');

test('target resolution: every spelling of the same script resolves to the same targets', () => {
  for (const [name, toml] of Object.entries(SPELLINGS)) assert.deepEqual([...pythonScriptTargets(toml)].sort(), TARGETS, name);
});

test('a quoted key and a bare key resolve to identical targets, in identical order', () => {
  assert.deepEqual(pythonScriptTargets(SPELLINGS['double-quoted key'] as string), pythonScriptTargets(SPELLINGS['bare key'] as string));
  assert.deepEqual(pythonScriptTargets(SPELLINGS['single-quoted key'] as string), pythonScriptTargets(SPELLINGS['bare key'] as string));
});

test('a mix of quoted and bare keys contributes every script, and a quoted key may contain anything but a quote', () => {
  const toml = '[project.scripts]\nplain = "pkg.mod:fn"\n"with space" = "pkg.other:run"\n\'dots.and-dashes\' = "tools.cli:main"\n';
  assert.deepEqual([...pythonScriptTargets(toml)].sort(), ['pkg/mod.py', 'pkg/mod/__init__.py', 'pkg/other.py', 'pkg/other/__init__.py', 'src/pkg/mod.py', 'src/pkg/mod/__init__.py', 'src/pkg/other.py', 'src/pkg/other/__init__.py', 'src/tools/cli.py', 'src/tools/cli/__init__.py', 'tools/cli.py', 'tools/cli/__init__.py'].sort());
});

test('every interpreted spelling is accepted by the reader, so none reports a limitation', () => {
  for (const [name, toml] of Object.entries(SPELLINGS)) assert.equal(pyprojectProblem(toml), null, name);
});

test('orphan detection: the script module is an entry point and the analysis is identical for every spelling', async () => {
  const baseline = await analyse(SPELLINGS['bare key'] as string);
  assert.deepEqual(orphans(baseline).map((f) => f.file), ['pkg/dead.py'], 'pkg/mod.py is run by the console script; pkg/dead.py is still an orphan');
  assert.deepEqual(baseline.project.configProblems, []);
  assert.equal(baseline.project.complete, true);

  for (const [name, toml] of Object.entries(SPELLINGS)) {
    const result = await analyse(toml);
    assert.deepEqual(result.analysis.findings, baseline.analysis.findings, `${name}: findings`);
    assert.deepEqual(result.project.configProblems, [], `${name}: configProblems`);
    assert.equal(result.project.complete, true, `${name}: complete`);
  }
});

test('configuration completeness: valid TOML that cannot be interpreted is reported as a limitation, with the line', async () => {
  for (const [name, toml] of Object.entries(UNINTERPRETED)) {
    assert.match(pyprojectProblem(toml) ?? '', /console script entry in a form that is not read \(line 2\)/, name);
    const { project } = await analyse(toml);
    assert.equal(project.complete, false, name);
    assert.match(project.configProblems.join('|'), /pyproject\.toml has a console script entry in a form that is not read \(line 2\)/, name);
    assert.match(describeCoverage(project, 100), /PARTIAL.*pyproject\.toml has a console script entry/, name);
  }
});

test('an entry point that could not be read never turns its module into a confident unused finding', async () => {
  for (const [name, toml] of Object.entries(UNINTERPRETED)) {
    const mod = orphans(await analyse(toml)).find((f) => f.file === 'pkg/mod.py');
    assert.ok(mod, `${name}: the file is still reported, because nothing is known to run it`);
    assert.notEqual(mod.classification, 'confidently-unused', name);
    assert.equal(mod.confidence, 'low', name);
  }
});

test('one entry that cannot be interpreted does not hide the ones that can', async () => {
  const toml = '[project.scripts]\n"good-cmd" = "pkg.mod:fn"\n"odd-cmd" = "pkg.\\u0064ead:fn"\n';
  assert.deepEqual([...pythonScriptTargets(toml)].sort(), TARGETS);
  assert.match(pyprojectProblem(toml) ?? '', /\(line 3\)/);
  const a = await analyse(toml);
  assert.equal(a.project.complete, false);
  assert.equal(orphans(a).find((f) => f.file === 'pkg/mod.py'), undefined, 'the readable entry still makes pkg/mod.py an entry point');
});
