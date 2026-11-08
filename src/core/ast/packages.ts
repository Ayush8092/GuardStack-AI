import path from 'node:path';
import type { ConfigReader } from './tsconfig.js';

export type PackageInfo = {
  file: string;
  dir: string;
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  bin: string[];
  exports?: unknown;
  imports?: Record<string, unknown>;
  // Frameworks recognised from dependencies; they decide which implicit aliases apply.
  frameworks: string[];
};

const FRAMEWORK_DEPENDENCIES: [framework: string, dependency: RegExp][] = [
  ['nuxt', /^(?:nuxt|nuxt3|@nuxt\/kit)$/],
  ['sveltekit', /^@sveltejs\/kit$/],
  ['next', /^next$/],
  ['vite', /^vite$/],
  ['astro', /^astro$/],
];

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const dirOf = (file: string): string => (path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file));

// Console-script entry points declared in pyproject.toml ([project.scripts], [project.gui-scripts], [tool.poetry.scripts]):
// `name = "pkg.module:function"` makes pkg/module.py (or pkg/module/__init__.py) a file that is run, not imported.
// Under [tool.poetry.scripts] Poetry also accepts a table, read by inlineScriptTargets below:
// `name = { reference = "pkg/tool.py", type = "file" }`.
const SCRIPT_TABLES = new Set(['project.scripts', 'project.gui-scripts', 'tool.poetry.scripts']);

// The dotted name of a table header, however TOML spells it: `[ project . "scripts" ]  # comment` is project.scripts.
function tableName(header: string): string {
  const inner = /^\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(header)?.[1] ?? '';
  return inner.split('.').map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2')).join('.');
}

// A script declared as a string: `name = "pkg.mod:fn"`, where the name may be bare, "quoted" or 'quoted', and the value may be
// followed by extras (`pkg.mod:fn [extra]`). Returns null for anything else that TOML allows (an escape sequence, a module name
// that is not an identifier), so the caller can report it instead of dropping it.
const STRING_ENTRY = /^(?:[\w.-]+|"[^"]+"|'[^']+')\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/;
const CALLABLE = /^([A-Za-z_][\w.]*)(?:\s*:\s*[\w.]+)?(?:\s*\[[^\]]*\])?$/;
function stringScriptTargets(line: string): string[] | null {
  const match = STRING_ENTRY.exec(line);
  const value = match?.[1] ?? match?.[2];
  const module = value === undefined ? undefined : CALLABLE.exec(value.trim())?.[1];
  return module === undefined ? null : moduleTargets(module.replace(/\./g, '/'));
}
const moduleTargets = (module: string): string[] => ['', 'src/'].flatMap((base) => [`${base}${module}.py`, `${base}${module}/__init__.py`]);

export function pythonScriptTargets(toml: string): string[] {
  const targets = new Set<string>();
  let table: string | null = null; // the script table being read, null outside one
  for (const line of toml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const name = tableName(trimmed);
      table = SCRIPT_TABLES.has(name) ? name : null;
      continue;
    }
    if (table === null) continue;
    const found = stringScriptTargets(trimmed) ?? inlineScriptTargets(table, trimmed) ?? [];
    for (const target of found) targets.add(target);
  }
  return [...targets];
}

// A single-line table of string values, the only shape of table entry that is interpreted. Poetry's documented keys are
// `reference` and `type`; a table with any other key, a non-string value, a repeated key or text this does not account for is
// not interpreted, and pyprojectProblem reports it instead of letting the entry point silently disappear.
const INLINE_ENTRY = /^(?:[\w.-]+|"[^"]+"|'[^']+')\s*=\s*\{(.*)\}\s*(?:#.*)?$/;
const INLINE_PAIR = /\s*([\w-]+)\s*=\s*("[^"\\]*"|'[^']*')\s*(?:,|$)/y;

function inlineValues(body: string): Record<string, string> | null {
  const text = body.trim();
  const pair = new RegExp(INLINE_PAIR);
  const values: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    pair.lastIndex = at;
    const match = pair.exec(text);
    const key = match?.[1];
    if (!match || key === undefined || (key !== 'reference' && key !== 'type') || Object.hasOwn(values, key)) return null;
    values[key] = (match[2] as string).slice(1, -1);
    at = pair.lastIndex;
  }
  return values;
}

// The file a `type = "file"` reference names, relative to the pyproject.toml. Absolute paths, Windows paths, backslashes and
// anything that leaves the project directory are refused rather than guessed at.
function referencedFile(reference: string): string | null {
  if (reference === '' || /[\\\0]/.test(reference) || reference.startsWith('/') || /^[A-Za-z]:/.test(reference)) return null;
  const normal = path.posix.normalize(reference);
  return normal === '.' || normal === '..' || normal.startsWith('../') ? null : normal;
}

// The Python files a table entry runs, or null when the entry cannot be safely interpreted. An empty list means it was
// understood and names nothing this analysis tracks (a reference to a file that is not Python source).
function inlineScriptTargets(table: string, line: string): string[] | null {
  const body = INLINE_ENTRY.exec(line)?.[1];
  if (body === undefined) return null;
  if (table !== 'tool.poetry.scripts') return null; // PEP 621 script values are strings, so a table there is not a script declaration
  const values = inlineValues(body);
  const reference = values?.reference;
  if (!values || reference === undefined) return null;

  if (values.type === 'file') {
    const file = referencedFile(reference);
    return file === null ? null : file.endsWith('.py') ? [file] : [];
  }
  if (values.type === 'console') {
    const module = /^([A-Za-z_][\w.]*)(?::[\w.]+)?$/.exec(reference)?.[1];
    return module === undefined ? null : moduleTargets(module.replace(/\./g, '/'));
  }
  return null;
}

// pyproject.toml is read only for its console-script tables, so only what affects that is checked, and the reader is not a
// TOML parser: a header that is never closed, a script entry that is not `name = "module:function"`, or scripts declared in a
// form this reader does not follow (a dotted key or an inline table under [project]) all mean the entry points are unknown.
const SCRIPT_ENTRY = /^(?:[\w.-]+|"[^"]+"|'[^']+')\s*=\s*(?:"[^"]*"|'[^']*'|\{.*\})\s*(?:#.*)?$/;
const TABLE_HEADER = /^\[\[?[^[\]]+\]\]?\s*(?:#.*)?$/;
const STRINGS = /"(?:\\.|[^"\\])*"|'[^']*'/g;
export function pyprojectProblem(toml: string): string | null {
  let table = '';
  let depth = 0; // open brackets of a multi-line array or inline table
  let block: string | null = null; // inside a multi-line """ or ''' string
  const lines = toml.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    if (block !== null) {
      if (raw.includes(block)) block = null;
      continue;
    }
    const line = raw.trim();
    if (depth > 0) {
      depth += bracketDelta(line);
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (!TABLE_HEADER.test(line)) return `has a table header that is not closed (line ${index + 1})`;
      table = tableName(line);
      continue;
    }
    const opener = /("""|''')/.exec(line);
    if (opener && line.indexOf(opener[1] as string) === line.lastIndexOf(opener[1] as string)) {
      block = opener[1] as string;
      continue;
    }
    depth = Math.max(0, bracketDelta(line.slice(line.indexOf('=') + 1)));
    const inScripts = SCRIPT_TABLES.has(table);
    if (inScripts && depth === 0 && !SCRIPT_ENTRY.test(line)) return `has a console script entry that could not be parsed (line ${index + 1})`;
    // Valid TOML that was not interpreted is reported, never dropped: a dropped entry point makes its module look unused.
    const inline = INLINE_ENTRY.test(line);
    if (inScripts && (depth > 0 || (inline && inlineScriptTargets(table, line) === null) || (!inline && stringScriptTargets(line) === null))) {
      return `has a console script entry in a form that is not read (line ${index + 1}); supported: "module:function" or, under [tool.poetry.scripts], { reference = "file.py", type = "file" }`;
    }
    if ((table === 'project' || table === 'tool.poetry') && /^(?:gui-)?scripts\s*[.=]/.test(line)) return `declares console scripts in a form that is not read (line ${index + 1}); use a [project.scripts] table`;
  }
  return depth > 0 || block !== null ? 'ends inside an unclosed array or string' : null;
}

// Brackets and braces opened minus closed on a line, ignoring those inside strings and comments.
function bracketDelta(text: string): number {
  const bare = text.replace(STRINGS, '""').replace(/#.*$/, '');
  return (bare.match(/[[{]/g)?.length ?? 0) - (bare.match(/[\]}]/g)?.length ?? 0);
}

// Console entry points can also be declared in setup.cfg or setup.py; those are not read, so a project that relies on them
// has entry points this analysis cannot see.
const LEGACY_ENTRY_POINTS = /console_scripts|gui_scripts|\[options\.entry_points\]/;

// Configuration problems that affect Python entry-point detection. Only relevant when the project has Python source.
export function pythonConfigProblems(read: ConfigReader, files: { pyproject: string[]; legacy: string[] }): string[] {
  const problems: string[] = [];
  const withScripts = new Set<string>();
  for (const file of [...files.pyproject].sort()) {
    const text = read(file);
    if (text === null) {
      problems.push(`${file} could not be read or parsed`);
      continue;
    }
    const problem = pyprojectProblem(text);
    if (problem) problems.push(`${file} ${problem}`);
    else if (pythonScriptTargets(text).length > 0) withScripts.add(dirOf(file));
  }
  for (const file of [...files.legacy].sort()) {
    if (withScripts.has(dirOf(file))) continue;
    const text = read(file);
    if (text !== null && LEGACY_ENTRY_POINTS.test(text)) problems.push(`${file} declares console entry points, which are not read (only pyproject.toml scripts are)`);
  }
  return problems;
}

export function loadPackages(read: ConfigReader, files: string[]): PackageInfo[] {
  const found: PackageInfo[] = [];
  for (const file of [...files].sort()) {
    const content = read(file);
    if (content === null) continue;
    if (path.posix.basename(file) === 'pyproject.toml') {
      const bin = pythonScriptTargets(content);
      if (bin.length > 0) found.push({ file, dir: dirOf(file), bin, frameworks: [] });
      continue;
    }
    let json: Record<string, unknown> | undefined;
    try {
      json = asObject(JSON.parse(content));
    } catch {
      continue;
    }
    if (!json) continue;

    const dependencies = Object.keys({ ...asObject(json.dependencies), ...asObject(json.devDependencies), ...asObject(json.peerDependencies) });
    found.push({
      file,
      dir: dirOf(file),
      name: str(json.name),
      main: str(json.main),
      module: str(json.module),
      types: str(json.types) ?? str(json.typings),
      bin: typeof json.bin === 'string' ? [json.bin] : Object.values(asObject(json.bin) ?? {}).filter((v): v is string => typeof v === 'string'),
      exports: json.exports,
      imports: asObject(json.imports),
      frameworks: FRAMEWORK_DEPENDENCIES.filter(([, pattern]) => dependencies.some((d) => pattern.test(d))).map(([name]) => name),
    });
  }
  return found;
}

const CONDITIONS = new Set(['types', 'import', 'require', 'node', 'default', 'module']);

// Conditions are tried in the order the object lists them, as Node does.
function pick(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pick(item);
      if (found) return found;
    }
    return undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  for (const [key, inner] of Object.entries(object)) {
    if (!CONDITIONS.has(key)) continue;
    const found = pick(inner);
    if (found) return found;
  }
  return undefined;
}

function patternMatch(pattern: string, subpath: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === subpath ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return null;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

// `subpath` is "." for the package itself or "./thing" for a deep import. Returns the file the map points at, relative to the package.
export function resolveMap(map: unknown, subpath: string): string | undefined {
  const object = asObject(map);
  if (typeof map === 'string' || Array.isArray(map) || (object && !Object.keys(object).some((k) => k.startsWith('.') || k.startsWith('#')))) {
    return subpath === '.' ? pick(map) : undefined;
  }
  if (!object) return undefined;
  if (subpath in object) return pick(object[subpath]);

  let best: { key: string; capture: string } | undefined;
  for (const key of Object.keys(object)) {
    const capture = key.includes('*') ? patternMatch(key, subpath) : null;
    if (capture !== null && (!best || key.indexOf('*') > best.key.indexOf('*'))) best = { key, capture };
  }
  const target = best ? pick(object[best.key]) : undefined;
  return target && best ? target.replace(/\*/g, best.capture) : undefined;
}

// Every target a package could serve for a subpath, in the order its map lists them. Custom conditions such as
// "@scope/source" or "development" often point straight at source files, so unknown conditions are kept as fallbacks.
function pickAll(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(pickAll);
  const object = asObject(value);
  return object ? Object.values(object).flatMap(pickAll) : [];
}

export function packageEntries(pkg: PackageInfo, subpath: string): string[] {
  const primary = packageEntry(pkg, subpath);
  if (pkg.exports === undefined) return primary ? [primary] : [];
  const object = asObject(pkg.exports);
  let selected: unknown;
  if (typeof pkg.exports === 'string' || Array.isArray(pkg.exports)) selected = subpath === '.' ? pkg.exports : undefined;
  else if (object && !Object.keys(object).some((k) => k.startsWith('.'))) selected = subpath === '.' ? object : undefined;
  else if (object) selected = object[subpath];
  const all = pickAll(selected);
  return [...new Set([...(primary ? [primary] : []), ...all])];
}

export function packageEntry(pkg: PackageInfo, subpath: string): string | undefined {
  if (pkg.exports !== undefined) return resolveMap(pkg.exports, subpath);
  if (subpath !== '.') return `./${subpath.slice(2)}`;
  return pkg.types ?? pkg.module ?? pkg.main ?? './index';
}

function leaves(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => leaves(v, into));
  else for (const inner of Object.values(asObject(value) ?? {})) leaves(inner, into);
}

// Every file a package publishes as its public surface: exports, main, module, types and bin.
export function publicTargets(pkg: PackageInfo): string[] {
  const found: string[] = [];
  leaves(pkg.exports, found);
  for (const single of [pkg.main, pkg.module, pkg.types]) if (single) found.push(single);
  found.push(...pkg.bin);
  return [...new Set(found.filter((t) => t.startsWith('.') || !t.includes(':')))];
}
