import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pyprojectProblem } from '../src/core/ast/packages.js';

// Every "valid" case below was checked with Python's tomllib (a real TOML parser) before it was written here, so the reader
// is held to the rule that it never flags a file a real parser accepts, except for script declarations it does not follow.
const valid: Record<string, string> = {
  "multiline array with bracket lines": "[tool.x]\ncommands = [\n    [\"mypy\"],\n    [\"pyright\", \"--flag\"],\n]\n[project.scripts]\nnaval = \"naval:cli\"\n",
  "nested inline tables and arrays": "[tool.x]\nitems = [{a = 1}, {b = [1, 2]}]\nmatrix = [[1, 2], [3, 4]]\n",
  "triple quoted string containing brackets": "[project]\nname = \"x\"\ndescription = \"\"\"\n[not a header]\nstill text ] [\n\"\"\"\n[project.scripts]\ncli = \"pkg.cli:main\"\n",
  "literal triple quote": "[tool.x]\ntext = '''\n[nope\n'''\n",
  "comments with brackets": "# [project.scripts\n[project]\nname = \"x\"  # ] [\n",
  "array of tables": "[[tool.mypy.overrides]]\nmodule = \"a\"\n[[tool.mypy.overrides]]\nmodule = \"b\"\n",
  "quoted keys and dotted headers": "[project.scripts]\n\"my-cmd\" = \"pkg.mod:fn\"\nother = 'pkg.o:fn'  # note\n",
  "poetry inline table script": "[tool.poetry.scripts]\nfoo = { reference = \"x.sh\", type = \"file\" }\nbar = \"pkg:main\"\n",
  "strings containing brackets": "[tool.x]\npattern = \"a[0-9]+\"\nother = 'b{2}'\n",
  "poetry file entry": "[tool.poetry.scripts]\nmy-tool = { reference = \"mypackage/runner.py\", type = \"file\" }\n",
  "poetry file entry, reversed keys, single quotes, ./ prefix and a comment": "[tool.poetry.scripts]\nmy-tool = { type = 'file', reference = './mypackage/runner.py' }  # note\n",
  "poetry file entry with a quoted key": "[tool.poetry.scripts]\n\"my-tool\" = { reference = \"scripts/dev/tool.py\", type = \"file\" }\n",
  "poetry console entry in a table": "[tool.poetry.scripts]\nmy-tool = { reference = \"mypackage.runner:main\", type = \"console\" }\n",
  "empty file": "",
  "windows line endings": "[project]\r\nname = \"x\"\r\n[project.scripts]\r\nc = \"p:f\"\r\n",
};

const problems: Record<string, [string, RegExp]> = {
  "unclosed table header": ["[project\nname = \"x\"\n", /not closed/],
  "unquoted script value": ["[project.scripts]\nnaval = naval:cli\n", /could not be parsed/],
  "scripts as inline table in project": ["[project]\nname = \"x\"\nscripts = { cli = \"pkg:main\" }\n", /not read/],
  "dotted scripts key": ["[project]\nscripts.cli = \"pkg:main\"\n", /not read/],
  // Valid TOML that this reader does not interpret. Each must be reported, never silently skipped.
  "poetry table with an unknown key": ["[tool.poetry.scripts]\nmy-tool = { reference = \"mypackage/runner.py\", type = \"file\", extras = [\"x\"] }\n", /console script entry in a form that is not read \(line 2\)/],
  "poetry table with an unknown type": ["[tool.poetry.scripts]\nmy-tool = { reference = \"mypackage/runner.py\", type = \"url\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "poetry table without a type": ["[tool.poetry.scripts]\nmy-tool = { reference = \"mypackage/runner.py\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "poetry table without a reference": ["[tool.poetry.scripts]\nmy-tool = { type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "poetry table with a non-string reference": ["[tool.poetry.scripts]\nmy-tool = { reference = 1, type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "file reference that leaves the project": ["[tool.poetry.scripts]\nmy-tool = { reference = \"../x/runner.py\", type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "absolute file reference": ["[tool.poetry.scripts]\nmy-tool = { reference = \"/opt/runner.py\", type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "windows drive file reference": ["[tool.poetry.scripts]\nmy-tool = { reference = \"C:/x/runner.py\", type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "file reference with an escaped backslash": ["[tool.poetry.scripts]\nmy-tool = { reference = \"a\\\\b.py\", type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "file table under [project.scripts], where values must be strings": ["[project.scripts]\nmy-tool = { reference = \"mypackage/runner.py\", type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  // Not valid TOML 1.0 (a repeated key; a newline inside an inline table, which TOML 1.1 allows). Still reported, not skipped.
  "poetry table with a repeated key": ["[tool.poetry.scripts]\nmy-tool = { reference = \"a.py\", reference = \"b.py\", type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "poetry table spread over several lines": ["[tool.poetry.scripts]\nmy-tool = {\n  reference = \"mypackage/runner.py\",\n  type = \"file\" }\n", /console script entry in a form that is not read \(line 2\)/],
  "unclosed array": ["[tool.x]\nitems = [\n  1,\n", /unclosed/],
  "unclosed triple string": ["[tool.x]\ntext = \"\"\"\nabc\n", /unclosed/],
};

test('pyprojectProblem accepts every file a real TOML parser accepts', () => {
  for (const [name, toml] of Object.entries(valid)) assert.equal(pyprojectProblem(toml), null, name);
});

test('pyprojectProblem flags malformed or unreadable-by-us console script declarations', () => {
  for (const [name, [toml, expected]] of Object.entries(problems)) assert.match(pyprojectProblem(toml) ?? '', expected, name);
});
