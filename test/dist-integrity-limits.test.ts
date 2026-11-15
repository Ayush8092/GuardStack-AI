import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error plain .mjs build script, it has no type declarations
import { DEFAULT_LIMITS, SECURITY_MARKERS, checkOutput, sourceHashes, verifyDist, writeManifest } from '../scripts/dist-integrity.mjs';

// Aggregate resource limits and the remaining regression cases of the distribution verifier. Every test runs the real functions
// (and, where it matters, the real script as a process) on small fixture trees. Limits are lowered through the `limits` option
// so that the tests need no huge files; the tests that use the shipped defaults use sparse files, which cost no disk.

const fileSymlinksWork: string | false = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-limits-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'x');
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
    return false;
  } catch {
    return 'this platform cannot create symbolic links here';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

const created: string[] = [];
after(() => created.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

type Limits = Record<string, number>;
type Stats = { peakRetainedBytes: number; retainedBytes: number; sourcesHashed: number; outputsHashed: number; entriesVisited: number };
const scriptPath = path.resolve(import.meta.dirname, '..', 'scripts', 'dist-integrity.mjs');
const manifestFile = (root: string): string => path.join(root, 'dist', 'build-manifest.json');

function write(root: string, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-limits-')));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

const BASE = {
  'package.json': JSON.stringify({ name: 'fixture', type: 'module', bin: { fx: 'bin/cli.js' } }),
  'tsconfig.json': '{ "compilerOptions": {}, "include": ["src"] }',
  'bin/cli.js': "#!/usr/bin/env node\nimport '../dist/index.js';\n",
  'src/index.ts': 'export const a = 1;\n',
  'dist/index.js': 'export const a = 1;\n',
};

// A faithful build with `extra` additional modules, each `size` bytes (padding in a comment, the same in source and output).
function project(extra = 0, size = 0, overrides: Record<string, string> = {}, limits?: Limits): string {
  const files: Record<string, string> = { ...BASE, ...overrides };
  for (let i = 0; i < extra; i++) {
    const body = `export const v${i} = ${i};\n${size > 0 ? `// ${'x'.repeat(size)}\n` : ''}`;
    files[`src/m${i}.ts`] = body;
    files[`dist/m${i}.js`] = body;
  }
  const root = workspace(files);
  writeManifest(root, limits ? { limits } : {});
  return root;
}

const verify = (root: string, limits?: Limits, stats?: Stats): string[] => verifyDist(root, { markers: [], limits, stats }) as string[];
const stopped = (problems: string[], text: RegExp): void => assert.ok(problems.some((p) => /verification stopped/.test(p) && text.test(p)), `expected a limit failure matching ${text}:\n${problems.join('\n') || '(accepted)'}`);

test('normal projects still verify, with the default limits, and the manifest is deterministic', () => {
  const root = project(10, 100);
  assert.deepEqual(verify(root), []);
  assert.deepEqual(checkOutput(root, { markers: [] }), []);
  const first = fs.readFileSync(manifestFile(root), 'utf8');
  writeManifest(root);
  assert.equal(fs.readFileSync(manifestFile(root), 'utf8'), first, 'the same build records the same bytes');
});

test('outputs are processed one at a time: many outputs never sit in memory together', () => {
  const count = 40;
  const size = 256 * 1024;
  const root = project(count, size);
  const stats: Stats = { peakRetainedBytes: 0, retainedBytes: 0, sourcesHashed: 0, outputsHashed: 0, entriesVisited: 0 };
  assert.deepEqual(verify(root, undefined, stats), []);
  assert.equal(stats.outputsHashed, count + 1);
  assert.equal(stats.retainedBytes, 0, 'everything that was read was released');
  const total = (count + 1) * size;
  // One output is held as bytes and once more as decoded text; never more than one output at a time.
  assert.ok(stats.peakRetainedBytes <= 2 * (size + 200) + 64 * 1024, `peak ${stats.peakRetainedBytes} bytes for ${total} bytes of outputs`);
  assert.ok(stats.peakRetainedBytes < total / 10, 'the peak is a small fraction of the combined size of the outputs');
});

test('many outputs that together exceed the aggregate budget are refused, and the scan does not report success', () => {
  const root = project(20, 1000);
  assert.deepEqual(verify(root), [], 'within the default budget');
  const problems = verify(root, { maxTotalOutputBytes: 8 * 1024 });
  stopped(problems, /compiled outputs together exceed the aggregate limit of 8192 bytes/);
  assert.ok(checkOutput(root, { markers: [], limits: { maxTotalOutputBytes: 8 * 1024 } }).length > 0, 'the installed-package check stops too');
  assert.throws(() => writeManifest(root, { limits: { maxTotalOutputBytes: 8 * 1024 } }), /cannot record the build[\s\S]*aggregate limit/);
});

test('the shipped aggregate output budget is enforced on real (sparse) files without being read past it', () => {
  const perFile = DEFAULT_LIMITS.maxOutputBytes as number;
  const files = Math.floor((DEFAULT_LIMITS.maxTotalOutputBytes as number) / perFile) + 1;
  const root = project(files, 0, {}, { maxTotalOutputBytes: files * perFile + 1 });
  for (let i = 0; i < files; i++) fs.truncateSync(path.join(root, 'dist', `m${i}.js`), perFile); // sparse: no disk used
  const stats: Stats = { peakRetainedBytes: 0, retainedBytes: 0, sourcesHashed: 0, outputsHashed: 0, entriesVisited: 0 };
  const problems = verify(root, undefined, stats);
  stopped(problems, /aggregate limit/);
  assert.ok(stats.outputsHashed <= files, 'stopped before every output was read');
  assert.ok(stats.peakRetainedBytes <= 2 * perFile + 64 * 1024, 'and never held more than one output');
});

test('a single oversized output is refused before it is read (shipped limit, sparse file)', () => {
  const root = project();
  fs.truncateSync(path.join(root, 'dist', 'index.js'), (DEFAULT_LIMITS.maxOutputBytes as number) + 1);
  const stats: Stats = { peakRetainedBytes: 0, retainedBytes: 0, sourcesHashed: 0, outputsHashed: 0, entriesVisited: 0 };
  stopped(verify(root, undefined, stats), /dist\/index\.js is larger than \d+ bytes/);
  assert.equal(stats.peakRetainedBytes < 1024 * 1024, true, 'the oversized file was never allocated');
});

test('too many source files are refused before any source is hashed', () => {
  // Three sources are on record; five more appear afterwards, so the manifest is within the limit and only the tree is not.
  const root = project(2);
  for (let i = 0; i < 5; i++) write(root, `src/added${i}.ts`, `export const added${i} = ${i};\n`);
  const stats: Stats = { peakRetainedBytes: 0, retainedBytes: 0, sourcesHashed: 0, outputsHashed: 0, entriesVisited: 0 };
  const problems = verify(root, { maxSourceFiles: 3 }, stats);
  stopped(problems, /src\/ holds more than 3 source files/);
  assert.equal(stats.sourcesHashed, 0, 'the count is checked before hashing starts');
  assert.throws(() => sourceHashes(root, { limits: { maxSourceFiles: 3 } }), /more than 3 source files/);
  assert.throws(() => writeManifest(root, { limits: { maxSourceFiles: 3 } }), /cannot record the build[\s\S]*more than 3 source files/);

  // A manifest that lists more files than the limit allows is refused as a manifest.
  const listed = project(5);
  assert.ok(verify(listed, { maxSourceFiles: 3 }).some((p) => /lists more than 3 sources/.test(p)));
});

test('an oversized source file, and sources that together exceed the budget, are refused', () => {
  const big = project(0, 0, { 'src/index.ts': `export const a = 1;\n// ${'x'.repeat(5000)}\n`, 'dist/index.js': 'export const a = 1;\n' });
  stopped(verify(big, { maxSourceBytes: 4096 }), /src\/index\.ts is larger than 4096 bytes/);

  const many = project(10, 1000);
  const stats: Stats = { peakRetainedBytes: 0, retainedBytes: 0, sourcesHashed: 0, outputsHashed: 0, entriesVisited: 0 };
  stopped(verify(many, { maxTotalSourceBytes: 4096 }, stats), /source files together exceed the aggregate limit of 4096 bytes/);
  assert.ok(stats.sourcesHashed < 11, 'the scan stopped when the budget ran out');
  assert.equal(stats.retainedBytes, 0, 'and released what it held');
});

test('the shipped per-source limit is enforced on a real (sparse) file', () => {
  const root = project();
  fs.truncateSync(path.join(root, 'src', 'index.ts'), (DEFAULT_LIMITS.maxSourceBytes as number) + 1);
  stopped(verify(root), /src\/index\.ts is larger than \d+ bytes/);
});

test('excessive directory entries are refused, in src/ and in dist/', () => {
  const root = project(0);
  for (let i = 0; i < 30; i++) write(root, `src/notes/n${i}.txt`, 'x');
  stopped(verify(root, { maxTreeEntries: 20 }), /src\/ holds more than 20 directory entries/);

  const dist = project(0);
  for (let i = 0; i < 30; i++) write(dist, `dist/junk/j${i}.js`, 'x');
  stopped(verify(dist, { maxTreeEntries: 20 }), /dist\/ holds more than 20 directory entries/);
  stopped(checkOutput(dist, { markers: [], limits: { maxTreeEntries: 20 } }) as string[], /dist\/ holds more than 20 directory entries/);
});

test('a deep directory structure is refused, in src/ and in dist/', () => {
  const root = project(0);
  write(root, 'src/a/b/c/d/e/f/deep.ts', 'export const d = 1;\n');
  stopped(verify(root, { maxDepth: 4 }), /src\/a\/b\/c\/d is nested deeper than 4 directory levels|nested deeper than 4/);

  const dist = project(0);
  write(dist, 'dist/a/b/c/d/e/f/deep.js', 'export const d = 1;\n');
  stopped(verify(dist, { maxDepth: 4 }), /nested deeper than 4/);

  // Still fine at the shipped depth for an ordinary layout.
  const ok = project(0);
  write(ok, 'src/core/security/x.ts', 'export const x = 1;\n');
  write(ok, 'dist/core/security/x.js', 'export const x = 1;\n');
  writeManifest(ok);
  assert.deepEqual(verify(ok), []);
});

test('symlinked and non-regular sources are refused, never followed', { skip: fileSymlinksWork }, () => {
  const root = project();
  const outside = path.join(root, 'outside.ts');
  fs.writeFileSync(outside, 'export const a = 1;\n');
  fs.rmSync(path.join(root, 'src', 'index.ts'));
  fs.symlinkSync(outside, path.join(root, 'src', 'index.ts'));
  const problems = verify(root);
  assert.ok(problems.some((p) => p.includes('src/index.ts is a symbolic link')), problems.join('\n'));
  assert.throws(() => writeManifest(root), /cannot record the build[\s\S]*src\/index\.ts is a symbolic link/);

  const dir = project();
  const real = path.join(dir, 'real-src');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'hidden.ts'), 'export const h = 1;\n');
  fs.symlinkSync(real, path.join(dir, 'src', 'linked'), 'dir');
  assert.ok(verify(dir).some((p) => p.includes('src/linked is a symbolic link')), 'a linked directory cannot hide sources');

  const srcLink = project();
  fs.renameSync(path.join(srcLink, 'src'), path.join(srcLink, 'src-real'));
  fs.symlinkSync(path.join(srcLink, 'src-real'), path.join(srcLink, 'src'), 'dir');
  assert.ok(verify(srcLink).some((p) => p.includes('src is a symbolic link')));

  const dirSource = project();
  fs.mkdirSync(path.join(dirSource, 'src', 'tricky.ts'));
  assert.deepEqual(verify(dirSource), [], 'a directory named like a source is traversed, never read as a file');
});

test('a symlinked bin entry, package.json or tsconfig.json is refused', { skip: fileSymlinksWork }, () => {
  const bin = project();
  fs.copyFileSync(path.join(bin, 'bin', 'cli.js'), path.join(bin, 'cli-real.js'));
  fs.rmSync(path.join(bin, 'bin', 'cli.js'));
  fs.symlinkSync(path.join(bin, 'cli-real.js'), path.join(bin, 'bin', 'cli.js'));
  for (const problems of [verify(bin), checkOutput(bin, { markers: [] }) as string[]]) assert.ok(problems.some((p) => p.includes('bin/cli.js is a symbolic link')), problems.join('\n'));

  const binDir = project();
  fs.renameSync(path.join(binDir, 'bin'), path.join(binDir, 'bin-real'));
  fs.symlinkSync(path.join(binDir, 'bin-real'), path.join(binDir, 'bin'), 'dir');
  assert.ok(verify(binDir).some((p) => p.includes('bin is a symbolic link')), 'a linked directory above the entry is refused too');

  const pkg = project();
  fs.copyFileSync(path.join(pkg, 'package.json'), path.join(pkg, 'pkg-real.json'));
  fs.rmSync(path.join(pkg, 'package.json'));
  fs.symlinkSync(path.join(pkg, 'pkg-real.json'), path.join(pkg, 'package.json'));
  assert.ok(verify(pkg).some((p) => p.includes('package.json is a symbolic link')));

  const ts = project();
  fs.copyFileSync(path.join(ts, 'tsconfig.json'), path.join(ts, 'tsconfig-real.json'));
  fs.rmSync(path.join(ts, 'tsconfig.json'));
  fs.symlinkSync(path.join(ts, 'tsconfig-real.json'), path.join(ts, 'tsconfig.json'));
  assert.ok(verify(ts).some((p) => p.includes('tsconfig.json is a symbolic link')));
});

test('a non-regular bin entry (a directory) is refused', () => {
  const root = project();
  fs.rmSync(path.join(root, 'bin', 'cli.js'));
  fs.mkdirSync(path.join(root, 'bin', 'cli.js'));
  for (const problems of [verify(root), checkOutput(root, { markers: [] }) as string[]]) assert.ok(problems.some((p) => p.includes('bin/cli.js is not a regular file')), problems.join('\n'));
});

test('unexpected package metadata is refused with a clear message', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['not JSON', '{ nope', /package\.json is missing or not valid JSON/],
    ['an array', '[]', /package\.json is not a JSON object/],
    ['a numeric bin', JSON.stringify({ name: 'f', bin: 7 }), /unexpected bin field/],
    ['an array bin', JSON.stringify({ name: 'f', bin: ['bin/cli.js'] }), /unexpected bin field/],
    ['an object entry', JSON.stringify({ name: 'f', bin: { fx: { a: 1 } } }), /invalid bin path/],
    ['a traversing bin', JSON.stringify({ name: 'f', bin: { fx: '../outside.js' } }), /invalid bin path "\.\.\/outside\.js"/],
    ['an absolute bin', JSON.stringify({ name: 'f', bin: { fx: '/etc/passwd' } }), /invalid bin path/],
    ['a backslash bin', JSON.stringify({ name: 'f', bin: { fx: 'bin\\cli.js' } }), /invalid bin path/],
    ['a hidden-segment bin', JSON.stringify({ name: 'f', bin: { fx: 'bin/.hidden.js' } }), /invalid bin path/],
    ['too many bins', JSON.stringify({ name: 'f', bin: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`b${i}`, 'bin/cli.js'])) }), /more than 16 bin entries/],
  ];
  for (const [name, content, expected] of cases) {
    const root = project();
    write(root, 'package.json', content);
    for (const [where, problems] of [['verifyDist', verify(root)], ['checkOutput', checkOutput(root, { markers: [] }) as string[]]] as const) {
      assert.ok(problems.some((p) => expected.test(p)), `${name} (${where}): ${problems.join(' | ') || 'accepted'}`);
    }
  }
  const root = project();
  write(root, 'package.json', JSON.stringify({ name: 'f', bin: './bin/cli.js' }));
  assert.deepEqual(verify(root), [], 'a plain "./bin/cli.js" string is the normal npm form and is accepted');
});

test('package.json, tsconfig.json and a bin entry are read within their limits (shipped limits, sparse files)', () => {
  const pkg = project();
  fs.truncateSync(path.join(pkg, 'package.json'), (DEFAULT_LIMITS.maxMetadataBytes as number) + 1);
  stopped(verify(pkg), /package\.json is larger than \d+ bytes/);
  stopped(checkOutput(pkg, { markers: [] }) as string[], /package\.json is larger than \d+ bytes/);

  const ts = project();
  fs.truncateSync(path.join(ts, 'tsconfig.json'), (DEFAULT_LIMITS.maxMetadataBytes as number) + 1);
  stopped(verify(ts), /tsconfig\.json is larger than \d+ bytes/);

  const bin = project();
  fs.truncateSync(path.join(bin, 'bin', 'cli.js'), (DEFAULT_LIMITS.maxBinBytes as number) + 1);
  stopped(verify(bin), /bin\/cli\.js is larger than \d+ bytes/);
});

test('a file with an absurd number of relative imports is refused, not scanned without bound', () => {
  const imports = Array.from({ length: 60 }, (_, i) => `import './m${i % 2}.js';`).join('\n');
  const root = project(2, 0, { 'src/index.ts': `${imports}\n`, 'dist/index.js': `${imports}\n` });
  stopped(verify(root, { maxImportsPerFile: 50 }), /more than 50 relative imports/);
});

test('an invalid limit option is a programming error, not silently ignored', () => {
  const root = project();
  assert.throws(() => verify(root, { maxDepth: 0 }), /must be a positive integer/);
  assert.throws(() => verify(root, { notALimit: 5 }), /unknown limit/);
});

test('a limit stops the run even when nothing else is wrong, and an unfinished scan is never an empty result', () => {
  const root = project(3);
  write(root, 'src/sub/s2/n.ts', 'export const n = 1;\n');
  write(root, 'dist/sub/s2/n.js', 'export const n = 1;\n');
  writeManifest(root);
  assert.deepEqual(verify(root), [], 'the tree is fine with the shipped limits');
  for (const limits of [{ maxSourceFiles: 2 }, { maxTotalSourceBytes: 10 }, { maxTotalOutputBytes: 10 }, { maxTreeEntries: 2 }, { maxDepth: 1 }]) {
    const problems = verify(root, limits);
    assert.ok(problems.length > 0, `${JSON.stringify(limits)} must not verify`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The remaining cases of the brief, run through the real script as a process and through the installed-package layout.
// ---------------------------------------------------------------------------------------------------------------------

function runScript(root: string, command: string): { status: number | null; stderr: string } {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(root, 'scripts', 'dist-integrity.mjs'));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'dist-integrity.mjs'), command], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

// The script run as a process checks the real SECURITY_MARKERS, so this fixture has a module for each marker file that holds its tokens.
function markedProject(): string {
  const byFile = new Map<string, string[]>();
  for (const [file, token] of SECURITY_MARKERS as [string, string][]) byFile.set(file, [...(byFile.get(file) ?? []), token]);
  const files: Record<string, string> = { ...BASE, 'src/index.ts': 'export const a = 1;\n' };
  for (const [file, tokens] of byFile) {
    const body = `export const markers = ${JSON.stringify(tokens)};\n`;
    files[file] = body;
    files[file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')] = body;
  }
  const root = workspace(files);
  writeManifest(root);
  return root;
}

test('the real script: a version 1 manifest is rejected, a freshly written manifest is accepted', () => {
  const root = markedProject();
  const first = runScript(root, 'verify');
  assert.equal(first.status, 0, first.stderr);

  const manifest = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(manifestFile(root), JSON.stringify({ version: 1, tsconfig: manifest.tsconfig, sources: manifest.sources }));
  const old = runScript(root, 'verify');
  assert.equal(old.status, 1);
  assert.match(old.stderr, /unsupported version 1/);

  // `write` regenerates it from what is on disk (it is never a version bump of the old file), and the result verifies.
  assert.equal(runScript(root, 'write').status, 0);
  const again = runScript(root, 'verify');
  assert.equal(again.status, 0, again.stderr);
  const regenerated = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')) as { version: number; outputs: Record<string, string>; sources: Record<string, string> };
  assert.equal(regenerated.version, 2);
  assert.equal(Object.keys(regenerated.outputs).length, Object.keys(regenerated.sources).length, 'one hashed output per source');
});

test('the real script: a limit makes `verify` exit with failure and `write` refuse to write a manifest', () => {
  const root = project();
  fs.truncateSync(path.join(root, 'dist', 'index.js'), (DEFAULT_LIMITS.maxOutputBytes as number) + 1);
  const run = runScript(root, 'verify');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /verification stopped/);

  fs.rmSync(manifestFile(root));
  const write = runScript(root, 'write');
  assert.equal(write.status, 1);
  assert.match(write.stderr, /cannot record the build/);
  assert.equal(fs.existsSync(manifestFile(root)), false, 'no manifest is written for a build that could not be fully read');
});

test('the installed package (bin, dist, package.json; no src, no tsconfig): accepted as built, rejected when an output is modified', () => {
  const built = project(3, 50);
  const installed = workspace({});
  for (const entry of ['bin', 'dist', 'package.json']) fs.cpSync(path.join(built, entry), path.join(installed, entry), { recursive: true });
  assert.deepEqual(checkOutput(installed, { markers: [] }), []);

  fs.appendFileSync(path.join(installed, 'dist', 'm1.js'), "globalThis.leak = () => import('node:child_process');\n");
  const problems = checkOutput(installed, { markers: [] }) as string[];
  assert.ok(problems.some((p) => p.includes('dist/m1.js was modified after the build')), problems.join('\n'));

  const extra = workspace({});
  for (const entry of ['bin', 'dist', 'package.json']) fs.cpSync(path.join(built, entry), path.join(extra, entry), { recursive: true });
  write(extra, 'dist/unexpected.js', 'export {};\n');
  fs.rmSync(path.join(extra, 'dist', 'm0.js'));
  const more = checkOutput(extra, { markers: [] }) as string[];
  assert.ok(more.some((p) => p.includes('dist/unexpected.js is not recorded')), more.join('\n'));
  assert.ok(more.some((p) => p.includes('missing build output dist/m0.js')), more.join('\n'));
});
