import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error plain .mjs build script, it has no type declarations
import { SECURITY_MARKERS, checkOutput, verifyDist, writeManifest } from '../scripts/dist-integrity.mjs';

// dist/ is generated and shipped. These tests prove the check that stops a stale or incomplete dist/ from being packed, on
// small fixture trees, so they need no build. `npm run verify:dist` runs the same check on the real tree.

// The same probe as helpers.ts (false when links can be made here, otherwise the reason to skip), kept local so that this test
// needs nothing but the build script.
const fileSymlinksWork: string | false = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-dist-probe-'));
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

function workspace(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-dist-')));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const repoRoot = path.resolve(import.meta.dirname, '..');
type Problems = string[];
const verify = (root: string, markers: [string, string][] = []): Problems => verifyDist(root, { markers });

// A tiny project whose dist/ is a faithful build: two modules, a dynamic import, a bin entry.
function project(): string {
  const root = workspace({
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', bin: { fx: 'bin/cli.js' }, files: ['bin', 'dist'] }),
    'tsconfig.json': '{ "compilerOptions": {}, "include": ["src"] }',
    'src/index.ts': "import { a } from './util/a.js';\nexport const run = async () => (await import('./late.js')).late(a);\n",
    'src/util/a.ts': 'export const a = 1;\n',
    'src/late.ts': 'export const late = (n: number) => n;\n',
    'bin/cli.js': "#!/usr/bin/env node\nimport '../dist/index.js';\n",
    'dist/index.js': "import { a } from './util/a.js';\nexport const run = async () => (await import('./late.js')).late(a);\n",
    'dist/util/a.js': 'export const a = 1;\n',
    'dist/late.js': 'export const late = (n) => n;\n',
  });
  writeManifest(root);
  return root;
}

test('a faithful build verifies', () => {
  assert.deepEqual(verify(project()), []);
});

test('a source module with no compiled output is reported (the missing cache-key.js / cached-info.js case)', () => {
  const root = project();
  write(root, 'src/db/cache-key.ts', 'export const k = 1;\n');
  fs.rmSync(path.join(root, 'dist', 'late.js'));
  const problems = verify(root);
  assert.ok(problems.some((p) => p.includes('missing build output dist/db/cache-key.js')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('missing build output dist/late.js')), problems.join('\n'));
});

test('a source file edited after the build is reported even when every output file exists', () => {
  const root = project();
  write(root, 'src/util/a.ts', 'export const a = 2;\n');
  assert.ok(verify(root).some((p) => p.includes('src/util/a.ts changed after dist/ was built')));
});

test('a source file added after the build is reported', () => {
  const root = project();
  write(root, 'src/extra.ts', 'export const x = 1;\n');
  write(root, 'dist/extra.js', 'export const x = 1;\n');
  const problems = verify(root);
  assert.ok(problems.some((p) => p.includes('src/extra.ts is newer than dist/')));
  assert.ok(problems.some((p) => p.includes('dist/extra.js is not recorded')), 'and so is its unrecorded output');
});

test('output of a deleted source file, and a changed tsconfig, are reported', () => {
  const root = project();
  fs.rmSync(path.join(root, 'src', 'late.ts'));
  write(root, 'tsconfig.json', '{ "compilerOptions": { "strict": true }, "include": ["src"] }');
  const problems = verify(root);
  assert.ok(problems.some((p) => p.includes('src/late.ts, which no longer exists')));
  assert.ok(problems.some((p) => p.includes('dist/late.js has no source file')));
  assert.ok(problems.some((p) => p.includes('tsconfig.json changed')));
});

test('a dist/ with no manifest (not built by npm run build) is refused', () => {
  const root = project();
  fs.rmSync(path.join(root, 'dist', 'build-manifest.json'));
  assert.ok(verify(root).some((p) => p.includes('build-manifest.json is missing')));
  assert.ok(checkOutput(root, { markers: [] }).some((p: string) => p.includes('build-manifest.json is missing')));
});

test('a relative import that does not resolve in the output, static or dynamic, is reported; comments are not', () => {
  const root = project();
  write(root, 'dist/index.js', "// import { x } from './not-a-module.js'\nimport { a } from './util/gone.js';\nexport const run = async () => (await import('./also-gone.js'));\nexport { a };\n");
  writeManifest(root); // re-record, so that only the imports are at issue here
  const problems = verify(root);
  assert.ok(problems.some((p) => p.includes('imports ./util/gone.js')));
  assert.ok(problems.some((p) => p.includes('imports ./also-gone.js')));
  assert.ok(!problems.some((p) => p.includes('not-a-module')), 'a commented-out import is not an import');
});

test('a bin entry must exist and lead into dist/', () => {
  const root = project();
  write(root, 'bin/cli.js', "#!/usr/bin/env node\nimport '../dist/missing.js';\n");
  assert.ok(verify(root).some((p) => p.includes('bin/cli.js imports ../dist/missing.js')));

  write(root, 'bin/cli.js', "#!/usr/bin/env node\nimport '../src/index.ts';\n");
  assert.ok(verify(root).some((p) => p.includes('does not load anything from dist/')));

  fs.rmSync(path.join(root, 'bin', 'cli.js'));
  assert.ok(verify(root).some((p) => p.includes('bin entry bin/cli.js does not exist')));
});

test('a security marker missing from the output is reported, and so is a marker the source no longer has', () => {
  const root = project();
  write(root, 'src/util/a.ts', 'export const a = 1; // createHmac\n');
  writeManifest(root);
  write(root, 'dist/util/a.js', 'export const a = 1;\n');
  writeManifest(root); // the output is recorded as it is, so only the missing marker is at issue
  assert.ok(verify(root, [['src/util/a.ts', 'createHmac']]).some((p) => p.includes('dist/util/a.js lacks createHmac')));
  assert.ok(verify(root, [['src/util/a.ts', 'taskkill']]).some((p) => p.includes('update SECURITY_MARKERS')));
});

test('the installed-package check needs no source, and finds a missing module', () => {
  const root = project();
  fs.rmSync(path.join(root, 'src'), { recursive: true });
  assert.deepEqual(checkOutput(root, { markers: [] }), []);
  fs.rmSync(path.join(root, 'dist', 'util', 'a.js'));
  assert.ok(checkOutput(root, { markers: [] }).some((p: string) => p.includes('missing build output dist/util/a.js')));
});

// ---------------------------------------------------------------------------------------------------------------------
// Compiled-output hashes (manifest version 2). A compiled file edited after the build keeps its imports and its security
// markers, so only its recorded hash can show the change.
// ---------------------------------------------------------------------------------------------------------------------

const MARKER = 'createHmac';
const markedProject = (): { root: string; markers: [string, string][] } => {
  const root = workspace({
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', bin: { fx: 'bin/cli.js' } }),
    'tsconfig.json': '{ "compilerOptions": {}, "include": ["src"] }',
    'src/index.ts': `export const seal = () => '${MARKER}';\n`,
    'bin/cli.js': "#!/usr/bin/env node\nimport '../dist/index.js';\n",
    'dist/index.js': `export const seal = () => '${MARKER}';\n`,
  });
  writeManifest(root);
  return { root, markers: [['src/index.ts', MARKER]] };
};
const manifestPath = (root: string): string => path.join(root, 'dist', 'build-manifest.json');
const readManifest = (root: string): Record<string, unknown> => JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')) as Record<string, unknown>;
const writeRaw = (root: string, value: unknown): void => fs.writeFileSync(manifestPath(root), typeof value === 'string' ? value : JSON.stringify(value));

test('the manifest records a SHA-256 for every compiled file, in a deterministic order', () => {
  const root = project();
  const manifest = readManifest(root) as { version: number; sources: Record<string, string>; outputs: Record<string, string> };
  assert.equal(manifest.version, 2);
  assert.deepEqual(Object.keys(manifest.outputs), ['dist/index.js', 'dist/late.js', 'dist/util/a.js']);
  assert.deepEqual(Object.keys(manifest.outputs), Object.keys(manifest.sources).map((s) => s.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')), 'one output per source, same order');
  for (const [out, hash] of Object.entries(manifest.outputs)) assert.equal(hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, out))).digest('hex'), out);
  const again = fs.readFileSync(manifestPath(root), 'utf8');
  writeManifest(root);
  assert.equal(fs.readFileSync(manifestPath(root), 'utf8'), again, 'recording the same build twice gives the same bytes');
});

test('a compiled file edited after the build is refused even though its markers and imports are intact', () => {
  const { root, markers } = markedProject();
  assert.deepEqual(verify(root, markers), []);
  write(root, 'dist/index.js', `export const seal = () => { globalThis.leak?.(); return '${MARKER}'; };\n`);
  for (const problems of [verify(root, markers), checkOutput(root, { markers }) as Problems]) {
    assert.ok(problems.some((p) => p.includes('dist/index.js was modified after the build')), problems.join('\n'));
    assert.ok(!problems.some((p) => p.includes('lacks')), 'the marker is still there: only the hash shows the change');
  }
});

test('a compiled file that was deleted, and one that was added, are refused (source build and installed package)', () => {
  const root = project();
  fs.rmSync(path.join(root, 'dist', 'util', 'a.js'));
  assert.ok(verify(root).some((p) => p.includes('missing build output dist/util/a.js')));
  assert.ok((checkOutput(root, { markers: [] }) as Problems).some((p) => p.includes('missing build output dist/util/a.js')));

  const other = project();
  write(other, 'dist/injected.js', "import('node:child_process');\n");
  write(other, 'dist/notes.txt', 'not a compiled file\n');
  for (const problems of [verify(other), checkOutput(other, { markers: [] }) as Problems]) {
    assert.ok(problems.some((p) => p.includes('dist/injected.js is not recorded')), problems.join('\n'));
    assert.ok(problems.some((p) => p.includes('dist/notes.txt is not recorded')), 'dist/ holds nothing but the manifest and the recorded outputs');
  }
});

test('a symlinked or non-regular compiled output is refused, and a symlinked directory in dist/ is not followed', { skip: fileSymlinksWork }, () => {
  const root = project();
  const real = path.join(root, 'elsewhere.js');
  fs.copyFileSync(path.join(root, 'dist', 'late.js'), real);
  fs.rmSync(path.join(root, 'dist', 'late.js'));
  fs.symlinkSync(real, path.join(root, 'dist', 'late.js'));
  for (const problems of [verify(root), checkOutput(root, { markers: [] }) as Problems]) {
    assert.ok(problems.some((p) => p.includes('dist/late.js is a symbolic link')), `identical bytes behind a link are still refused:\n${problems.join('\n')}`);
  }

  const dirs = project();
  const target = path.join(dirs, 'moved-util');
  fs.renameSync(path.join(dirs, 'dist', 'util'), target);
  fs.symlinkSync(target, path.join(dirs, 'dist', 'util'), 'dir');
  for (const problems of [verify(dirs), checkOutput(dirs, { markers: [] }) as Problems]) {
    assert.ok(problems.some((p) => p.includes('dist/util is a symbolic link')), problems.join('\n'));
  }

  const nonRegular = project();
  fs.rmSync(path.join(nonRegular, 'dist', 'late.js'));
  fs.mkdirSync(path.join(nonRegular, 'dist', 'late.js'));
  assert.ok(verify(nonRegular).some((p) => p.includes('dist/late.js')), 'a directory in the place of an output is refused');
});

test('a manifest that is corrupt, unsupported, incomplete or has extra entries is refused with a clear message', () => {
  const cases: Array<[string, (m: Record<string, any>) => unknown, RegExp]> = [
    ['not JSON', () => '{ nope', /is not valid JSON/],
    ['not an object', () => '[]', /is not a JSON object/],
    ['truncated', () => '{"version": 2, "sources": {', /is not valid JSON/],
    ['old version', (m) => ({ ...m, version: 1, outputs: undefined }), /unsupported version 1/],
    ['future version', (m) => ({ ...m, version: 3 }), /unsupported version 3/],
    ['no version', (m) => ({ ...m, version: undefined }), /unsupported version/],
    ['no outputs', (m) => ({ ...m, outputs: undefined }), /no valid outputs list/],
    ['outputs is an array', (m) => ({ ...m, outputs: [] }), /no valid outputs list/],
    ['an unexpected field', (m) => ({ ...m, extra: 1 }), /unexpected field "extra"/],
    ['bad tsconfig hash', (m) => ({ ...m, tsconfig: 'abc' }), /invalid tsconfig hash/],
    ['bad output hash', (m) => ({ ...m, outputs: { ...m.outputs, 'dist/late.js': 'XYZ' } }), /invalid hash for dist\/late\.js/],
    ['uppercase hash', (m) => ({ ...m, outputs: { ...m.outputs, 'dist/late.js': 'A'.repeat(64) } }), /invalid hash for dist\/late\.js/],
    ['bad source hash', (m) => ({ ...m, sources: { ...m.sources, 'src/late.ts': 7 } }), /invalid hash for src\/late\.ts/],
    ['traversal in an output', (m) => ({ ...m, outputs: { ...m.outputs, 'dist/../package.json.js': '0'.repeat(64) } }), /invalid outputs path/],
    ['traversal in a source', (m) => ({ ...m, sources: { ...m.sources, 'src/../../x.ts': '0'.repeat(64) } }), /invalid sources path/],
    ['absolute path', (m) => ({ ...m, outputs: { ...m.outputs, '/etc/passwd.js': '0'.repeat(64) } }), /invalid outputs path/],
    ['backslash path', (m) => ({ ...m, outputs: { ...m.outputs, 'dist\\late.js': '0'.repeat(64) } }), /invalid outputs path/],
    ['an output outside dist/', (m) => ({ ...m, outputs: { ...m.outputs, 'bin/cli.js': '0'.repeat(64) } }), /invalid outputs path/],
    ['an output that is not .js', (m) => ({ ...m, outputs: { ...m.outputs, 'dist/late.mjs': '0'.repeat(64) } }), /invalid outputs path/],
    ['a declaration as a source', (m) => ({ ...m, sources: { ...m.sources, 'src/types.d.ts': '0'.repeat(64) } }), /invalid sources path/],
    ['a source without an output', (m) => ({ ...m, outputs: Object.fromEntries(Object.entries(m.outputs).filter(([k]) => k !== 'dist/late.js')) }), /lists no output for src\/late\.ts/],
    ['an output without a source', (m) => ({ ...m, outputs: { ...m.outputs, 'dist/ghost.js': '0'.repeat(64) } }), /lists dist\/ghost\.js, which no listed source produces/],
    ['no entries at all', (m) => ({ ...m, sources: {}, outputs: {} }), /lists no sources/],
  ];
  for (const [name, mutate, expected] of cases) {
    const root = project();
    writeRaw(root, mutate(readManifest(root)));
    for (const [where, problems] of [['verifyDist', verify(root)], ['checkOutput', checkOutput(root, { markers: [] }) as Problems]] as const) {
      assert.ok(problems.length > 0 && problems.some((p) => expected.test(p)), `${name} (${where}): ${problems.join(' | ') || 'accepted'}`);
    }
  }
});

test('a manifest that is a symlink or too large is refused', { skip: fileSymlinksWork }, () => {
  const root = project();
  const copy = path.join(root, 'manifest-copy.json');
  fs.renameSync(manifestPath(root), copy);
  fs.symlinkSync(copy, manifestPath(root));
  assert.ok(verify(root).some((p) => p.includes('build-manifest.json') && p.includes('symbolic link')));

  const big = project();
  writeRaw(big, ' '.repeat(5 * 1024 * 1024));
  assert.ok(verify(big).some((p) => p.includes('larger than')));
});

test('writeManifest refuses an incomplete or unexpected dist/ instead of recording it', () => {
  const missing = project();
  fs.rmSync(path.join(missing, 'dist', 'late.js'));
  assert.throws(() => writeManifest(missing), /cannot record the build[\s\S]*missing build output dist\/late\.js/);

  const extra = project();
  write(extra, 'dist/stray.js', 'export {};\n');
  assert.throws(() => writeManifest(extra), /dist\/stray\.js is not recorded/);

  const odd = workspace({ 'tsconfig.json': '{}', 'src/has space.ts': 'export {};\n', 'dist/has space.js': 'export {};\n' });
  assert.throws(() => writeManifest(odd), /invalid sources path/, 'a name the strict manifest cannot hold fails the build, not the install');
});

test('the build script records hashes only after tsc has succeeded (clean, then tsc, then write)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.build!, /dist-integrity\.mjs clean && tsc && node scripts\/dist-integrity\.mjs write$/, 'tsc must succeed before anything is hashed');
});

test('every security marker names a token that the real source contains', () => {
  for (const [srcFile, token] of SECURITY_MARKERS as [string, string][]) {
    assert.ok(fs.readFileSync(path.join(repoRoot, srcFile), 'utf8').includes(token), `${srcFile} must contain ${token}`);
  }
  const modules = new Set((SECURITY_MARKERS as [string, string][]).map(([f]) => f));
  for (const needed of ['src/db/cache-key.ts', 'src/core/ast/cached-info.ts', 'src/core/ast/shared-index.ts', 'src/db/windows-acl.ts', 'src/db/schema-check.ts', 'src/core/security/safe-file.ts', 'src/core/git/git.ts', 'src/db/client.ts']) {
    assert.ok(modules.has(needed), `${needed} must be covered by a marker`);
  }
});

test('the real package builds through the integrity script, publishes only after verifying, and has a bin that points into dist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string>; bin: Record<string, string> };
  const build = pkg.scripts.build!;
  assert.ok(build.indexOf('dist-integrity.mjs clean') < build.indexOf('tsc') && build.indexOf('tsc') < build.indexOf('dist-integrity.mjs write'), 'clean, then tsc, then record the manifest');
  assert.match(pkg.scripts.prepack!, /dist-integrity\.mjs verify/, 'npm pack and npm publish refuse a stale dist');
  assert.match(pkg.scripts['verify:dist']!, /dist-integrity\.mjs verify/);
  assert.equal(pkg.bin.guardian, 'bin/cli.js');
  assert.match(fs.readFileSync(path.join(repoRoot, 'bin', 'cli.js'), 'utf8'), /import '\.\.\/dist\/cli\/index\.js'/);
  assert.ok(fs.existsSync(path.join(repoRoot, 'src', 'cli', 'index.ts')), 'the compiled entry point has a source');
  const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')) as { compilerOptions: { noEmitOnError?: boolean; rootDir: string }; include: string[] };
  assert.equal(tsconfig.compilerOptions.noEmitOnError, true, 'a build with type errors must not leave output behind');
  assert.deepEqual(tsconfig.include, ['src'], 'every module under src/ is compiled');
});
