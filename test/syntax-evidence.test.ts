// A finding that was made less certain because a file did not parse cleanly has to say so: not only that its confidence is low,
// but which files are damaged and how (the same wording describeHealth gives everywhere else). Findings about files that parsed
// cleanly, and findings of a complete scan, are left exactly as they were.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/core/ast/analysis.js';
import { describeHealth, type ParseHealth } from '../src/core/ast/health.js';
import type { FileInfo, Sym } from '../src/core/ast/types.js';

const sym = (name: string): Sym => ({ name, kind: 'function', line: 1, signature: `def ${name}()`, exportName: name });
const file = (path: string, symbols: Sym[] = [], extra: Partial<FileInfo> = {}): FileInfo => ({ path, lang: 'python', bytes: 100, lines: 5, symbols, imports: [], reexports: [], unusedImports: [], suppressions: [], dynamicLoads: [], decorated: false, script: false, ...extra });

// dead-export needs a file that IS imported, but whose export nobody uses: this one imports `used` from `./<target>` only.
const importer = (path: string, target: string, extra: Partial<FileInfo> = {}): FileInfo =>
  file(path, [sym('main')], { lang: 'typescript', imports: [{ source: `./${target}`, names: ['used'], line: 1, kind: 'import', typeOnly: false }], ...extra });
const lib = (path: string, extra: Partial<FileInfo> = {}): FileInfo => file(path, [sym('used'), sym('helper')], { lang: 'typescript', ...extra });

const degraded: ParseHealth = { status: 'degraded', errors: 1, missing: 0, lines: [3] };
const recovered: ParseHealth = { status: 'recovered', errors: 2, missing: 1, lines: [7, 9] };
const known = (files: FileInfo[]): string[] => files.map((f) => f.path);
const evidenceOf = (rule: string, path: string, files: FileInfo[]): string[] => {
  const { findings } = analyze(files, { known: known(files), complete: true });
  const found = findings.find((f) => f.rule === rule && f.file === path);
  assert.ok(found, `no ${rule} finding for ${path}`);
  return found.evidence;
};

test('orphan-file evidence names the damaged files and says what the damage may have hidden', () => {
  const files = [file('pkg/lonely.py', [sym('f')]), file('pkg/broken.py', [sym('g')], { parse: degraded })];
  const evidence = evidenceOf('orphan-file', 'pkg/lonely.py', files);
  assert.ok(evidence.some((e) => e === `pkg/broken.py: ${describeHealth(degraded)}`), `evidence was: ${JSON.stringify(evidence)}`);
  assert.ok(evidence.some((e) => /1 file\(s\) have syntax errors/.test(e)));
});

test('dead-export evidence names the damaged file once, with the same wording', () => {
  const files = [lib('src/lib.ts', { parse: recovered }), importer('src/main.ts', 'lib')];
  const evidence = evidenceOf('dead-export', 'src/lib.ts', files);
  const detail = describeHealth(recovered);
  assert.equal(evidence.filter((e) => e.includes(detail)).length, 1, `the file's own details must appear exactly once: ${JSON.stringify(evidence)}`);
});

test('a dead export in a clean file still learns which other files are damaged', () => {
  const files = [lib('src/lib.ts'), importer('src/main.ts', 'lib'), file('src/broken.ts', [], { lang: 'typescript', parse: degraded })];
  const evidence = evidenceOf('dead-export', 'src/lib.ts', files);
  assert.ok(evidence.some((e) => e.includes('src/broken.ts') && e.includes(describeHealth(degraded))), JSON.stringify(evidence));
  assert.ok(!evidence.some((e) => /may be incompletely extracted/.test(e)), 'the clean file itself is not damaged');
});

test('a dead export in a damaged file keeps its own explanation when more than three files are damaged', () => {
  const others = ['a', 'b', 'c', 'd'].map((n) => file(`src/${n}.ts`, [], { lang: 'typescript', parse: degraded }));
  const damaged = [...others, lib('src/zlib.ts', { parse: degraded }), importer('src/zmain.ts', 'zlib')];
  const evidence = evidenceOf('dead-export', 'src/zlib.ts', damaged);
  assert.ok(evidence.some((e) => /and 2 more file\(s\) with syntax errors/.test(e)), JSON.stringify(evidence));
  assert.ok(evidence.some((e) => e.includes('src/zlib.ts has syntax errors') && e.includes(describeHealth(degraded))), `src/zlib.ts was not among the first three, so it must be explained on its own: ${JSON.stringify(evidence)}`);
  assert.equal(evidence.filter((e) => e.startsWith('src/a.ts:')).length, 1);
});

test('the findings are low confidence, and unused-import carries the details too', () => {
  const unused = file('pkg/mod.py', [], { parse: recovered, unusedImports: [{ name: 'os', source: 'os', line: 1 }] });
  const { findings } = analyze([unused, file('pkg/other.py', [sym('x')])], { known: ['pkg/mod.py', 'pkg/other.py'], complete: true });
  const item = findings.find((f) => f.rule === 'unused-import');
  assert.equal(item?.confidence, 'low');
  assert.ok(item?.evidence.some((e) => e.includes(describeHealth(recovered))), JSON.stringify(item?.evidence));
  for (const f of findings.filter((x) => x.rule === 'orphan-file' || x.rule === 'dead-export')) assert.equal(f.confidence, 'low');
});

test('a partial scan with damaged files reports both reasons', () => {
  const files = [file('pkg/lonely.py', [sym('f')]), file('pkg/broken.py', [], { parse: degraded })];
  const { findings } = analyze(files, { known: known(files), complete: false });
  const orphan = findings.find((f) => f.rule === 'orphan-file' && f.file === 'pkg/lonely.py');
  assert.ok(orphan?.evidence.some((e) => /did not see every file/.test(e)));
  assert.ok(orphan?.evidence.some((e) => e.includes(describeHealth(degraded))));
});

test('clean projects and complete scans are unchanged: no syntax notes appear', () => {
  const files = [file('pkg/lonely.py', [sym('f')]), lib('src/lib.ts'), importer('src/main.ts', 'lib')];
  for (const [rule, path] of [['orphan-file', 'pkg/lonely.py'], ['dead-export', 'src/lib.ts']] as const) {
    const evidence = evidenceOf(rule, path, files);
    assert.ok(!evidence.some((e) => /syntax error/i.test(e)), `${rule}: ${JSON.stringify(evidence)}`);
  }
});
