import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { parseCachedInfo } from '../src/core/ast/cached-info.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { loadLanguages, parseFile } from '../src/core/ast/parser.js';
import type { FileInfo } from '../src/core/ast/types.js';
import { loadMachineKey, machineStateDir, openInfo, sealInfo } from '../src/db/cache-key.js';
import { closeDb, loadCache, openDb, type Db } from '../src/db/client.js';
import { CACHE_VERSION, schema } from '../src/db/schema.js';
import { cleanup, context, fileSymlinksWork, info, workspace } from './helpers.js';

// A repository can ship .guardian/cache.db. The cache trusts a row when the content hash matches, so a database that
// carries fabricated results for a file's real hash must not be believed. Rows are signed with a key kept outside the
// workspace, and every nested field of a cached result is checked before it is used.

const home = workspace({}, 'guardian-keyhome-');
// TEMP may grant broad inherited permissions. Keep the test machine-key directory
// private so loadMachineKey() can exercise persistent-cache paths on Windows.
if (process.platform === 'win32') {
  execFileSync('icacls.exe', [
    home,
    '/inheritance:r',
    '/grant:r', `*${currentUserSid()}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ], { stdio: 'ignore', windowsHide: true });
}
const savedHome = process.env.GUARDIAN_STATE_HOME;
const open: Db[] = [];
// A fresh key directory per test, so one test's key (or a deliberately broken one) never reaches another.
let counter = 0;
beforeEach(() => {
  process.env.GUARDIAN_STATE_HOME = path.join(home, `state-${counter++}`);
});
afterEach(() => open.splice(0).forEach(closeDb));
after(() => {
  if (savedHome === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = savedHome;
  cleanup();
});

const cacheFile = (root: string): string => path.join(root, '.guardian', 'cache.db');
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const FORGED: FileInfo = { ...info('a.ts'), symbols: [{ name: 'forged', kind: 'function', line: 1, signature: 'function forged()', exportName: 'forged' }] };

// Index once through the product's own path, so the stored row is exactly what a real run writes.
async function seeded(files: Record<string, string> = { 'a.ts': 'export const real = 1;\n' }): Promise<{ root: string; hashOf: (p: string) => string }> {
  const root = workspace(files);
  const ctx = context(root);
  await indexProject(ctx);
  const hashes = Object.fromEntries((ctx.db.prepare('SELECT path, hash FROM files').all() as { path: string; hash: string }[]).map((r) => [r.path, r.hash]));
  closeDb(ctx.db);
  return { root, hashOf: (p) => hashes[p]! };
}

// What an attacker with the repository can do: edit the database file directly, with no access to the machine key.
function edit(root: string, sql: string, ...args: unknown[]): void {
  const raw = new Database(cacheFile(root));
  raw.prepare(sql).run(...args);
  raw.close();
}

const symbolsOf = async (root: string, rel: string): Promise<string[]> => {
  const ctx = context(root);
  const project = await indexProject(ctx);
  return project.files.find((f) => f.path === rel)!.symbols.map((s) => s.name);
};

test('a result written by a real run is signed, verifies after a restart, and is reused', async () => {
  const { root, hashOf } = await seeded();
  const raw = new Database(cacheFile(root), { readonly: true });
  const stored = (raw.prepare('SELECT info FROM files').get() as { info: string }).info;
  raw.close();
  assert.match(stored, /^g1\.[0-9a-f]{64}\.\{/);

  const db = openDb(root);
  open.push(db);
  const rows = loadCache(db);
  assert.equal(rows.size, 1);
  assert.equal(rows.get('a.ts')?.hash, hashOf('a.ts'));
  assert.ok(rows.get('a.ts')?.info.startsWith('{'), 'callers get the result, not the envelope');
  assert.deepEqual(await symbolsOf(root, 'a.ts'), ['real']);
});

test('unsigned fabricated results for a file\'s real hash are ignored', async () => {
  const { root, hashOf } = await seeded();
  edit(root, 'UPDATE files SET info = ? WHERE path = ?', JSON.stringify({ ...FORGED, path: 'a.ts' }), 'a.ts');
  assert.equal(hashOf('a.ts').length, 64, 'the forged row carries the correct hash');
  assert.deepEqual(await symbolsOf(root, 'a.ts'), ['real']);
});

test('results signed with some other key are ignored', async () => {
  const { root, hashOf } = await seeded();
  const forged = sealInfo(Buffer.alloc(32, 7), 'a.ts', hashOf('a.ts'), JSON.stringify({ ...FORGED, path: 'a.ts' }));
  edit(root, 'UPDATE files SET info = ? WHERE path = ?', forged, 'a.ts');
  assert.deepEqual(await symbolsOf(root, 'a.ts'), ['real']);
});

test('a whole database shipped in the repository is not believed', async () => {
  const root = workspace({ 'a.ts': 'export const real = 1;\n' });
  const hash = sha('export const real = 1;\n');
  fs.mkdirSync(path.join(root, '.guardian'));
  const shipped = new Database(cacheFile(root));
  shipped.exec(schema);
  shipped.pragma(`user_version = ${CACHE_VERSION}`);
  shipped.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)').run('a.ts', hash, 23, 1, JSON.stringify({ ...FORGED, path: 'a.ts' }));
  shipped.close();
  assert.deepEqual(await symbolsOf(root, 'a.ts'), ['real']);
});

test('a genuine result moved to another path, or to other content, does not verify', async () => {
  const { root } = await seeded({ 'a.ts': 'export const same = 1;\n', 'b.ts': 'export const same = 1;\n' });
  // Identical content, so identical hashes: only the path binding can tell the two rows apart.
  const raw = new Database(cacheFile(root));
  const rows = raw.prepare('SELECT path, info FROM files ORDER BY path').all() as { path: string; info: string }[];
  raw.prepare('UPDATE files SET info = ? WHERE path = ?').run(rows[1]!.info, 'a.ts');
  raw.close();
  const db = openDb(root);
  open.push(db);
  const trusted = loadCache(db);
  assert.equal(trusted.has('a.ts'), false, 'a.ts carried the signature made for b.ts');
  assert.equal(trusted.has('b.ts'), true);

  edit(root, 'UPDATE files SET hash = ? WHERE path = ?', sha('something else'), 'b.ts');
  const again = openDb(root);
  open.push(again);
  assert.equal(loadCache(again).has('b.ts'), false, 'the signature covers the content hash');
});

test('a signed result whose text was edited does not verify', async () => {
  const { root } = await seeded();
  edit(root, "UPDATE files SET info = REPLACE(info, '\"real\"', '\"fake\"')");
  const db = openDb(root);
  open.push(db);
  assert.equal(loadCache(db).size, 0);
  assert.deepEqual(await symbolsOf(root, 'a.ts'), ['real']);
});

test('a database carrying a trigger or a view is replaced, not trusted', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.guardian'));
  const shipped = new Database(cacheFile(root));
  shipped.exec(schema);
  shipped.pragma(`user_version = ${CACHE_VERSION}`);
  shipped.exec('CREATE TRIGGER sneaky AFTER INSERT ON files BEGIN DELETE FROM usage; END; CREATE VIEW v AS SELECT 1;');
  shipped.close();

  const db = openDb(root);
  open.push(db);
  assert.equal((db.prepare('PRAGMA database_list').get() as { file: string }).file === '', false, 'a clean file cache is back');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger', 'view')").get() as { n: number }).n,0,
  );
});

test('a database whose files table has a different layout is replaced', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.guardian'));
  const shipped = new Database(cacheFile(root));
  shipped.exec('CREATE TABLE files (path TEXT, payload BLOB); CREATE UNIQUE INDEX one ON files(payload)');
  shipped.pragma(`user_version = ${CACHE_VERSION}`);
  shipped.close();

  const db = openDb(root);
  open.push(db);
  const columns = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, ['path', 'hash', 'size', 'mtime_ms', 'info']);
});

// ---- the machine key ----

test('the key lives outside the workspace, is private, and is the same on every run', () => {
  const root = workspace();
  const first = loadMachineKey(root);
  const second = loadMachineKey(root);
  assert.ok(first && second);
  assert.equal(first.length, 32);
  assert.ok(first.equals(second));
  const file = path.join(machineStateDir(), 'cache-key');
  assert.ok(fs.existsSync(file));
  assert.equal(path.relative(root, file).startsWith('..'), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by the owner only');
});

test('a key directory inside the workspace is refused: the repository could have written the key', () => {
  const root = workspace();
  process.env.GUARDIAN_STATE_HOME = path.join(root, 'state');
  assert.equal(loadMachineKey(root), null);
  assert.equal(fs.existsSync(path.join(root, 'state', 'cache-key')), false);
  // Without a key the file cache is not used at all.
  const db = openDb(root);
  open.push(db);
  assert.equal((db.prepare('PRAGMA database_list').get() as { file: string }).file, '');
});

test('a key file that is not a valid key is refused, and is not overwritten', () => {
  const root = workspace();
  fs.mkdirSync(machineStateDir(), { recursive: true, mode: 0o700 });
  const file = path.join(machineStateDir(), 'cache-key');
  fs.writeFileSync(file, 'not a key\n', { mode: 0o600 });
  assert.equal(loadMachineKey(root), null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a key\n');
});

test('a symlinked key file is refused', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  const elsewhere = workspace({ 'k': `${'ab'.repeat(32)}\n` });
  fs.mkdirSync(machineStateDir(), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(elsewhere, 'k'), path.join(machineStateDir(), 'cache-key'));
  assert.equal(loadMachineKey(root), null);
});

test('sealing is bound to the key, the path, the hash and the text', () => {
  const key = Buffer.alloc(32, 1);
  const sealed = sealInfo(key, 'a.ts', 'h1', '{"x":1}');
  assert.equal(openInfo(key, 'a.ts', 'h1', sealed), '{"x":1}');
  assert.equal(openInfo(Buffer.alloc(32, 2), 'a.ts', 'h1', sealed), null);
  assert.equal(openInfo(key, 'b.ts', 'h1', sealed), null);
  assert.equal(openInfo(key, 'a.ts', 'h2', sealed), null);
  assert.equal(openInfo(key, 'a.ts', 'h1', sealed.replace('1}', '2}')), null);
  for (const junk of ['', '{}', 'g1.', `g1.${'0'.repeat(64)}`, `g1.${'z'.repeat(64)}.{}`, `g2.${'0'.repeat(64)}.{}`]) assert.equal(openInfo(key, 'a.ts', 'h1', junk), null, junk);
});

// ---- nested validation ----

const GOOD: FileInfo = {
  path: 'a.ts', lang: 'typescript', bytes: 10, lines: 3,
  symbols: [{ name: 'f', kind: 'function', line: 1, signature: 'function f()', exportName: 'f', bodyHash: 'b', structHash: 's', doc: 'd', partial: true }],
  imports: [{ source: './x', names: ['a'], line: 1, kind: 'import', typeOnly: false }],
  reexports: [{ source: './y', imported: '*', exported: '*' }],
  unusedImports: [{ name: 'a', source: './x', line: 1 }],
  suppressions: [{ kind: 'ts-ignore', line: 2 }],
  dynamicLoads: [{ line: 3, kind: 'import', prefix: './p/' }],
  decorated: false, script: false,
  parse: { status: 'recovered', errors: 1, missing: 0, lines: [2], limit: 'depth' },
};
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(GOOD));

test('a well-formed cached result is accepted', () => {
  assert.ok(parseCachedInfo(JSON.stringify(GOOD), 'a.ts'));
  const bare: Record<string, any> = clone();
  delete bare.parse;
  for (const s of bare.symbols) for (const k of ['doc', 'exportName', 'bodyHash', 'structHash', 'partial']) delete s[k];
  delete bare.dynamicLoads[0].prefix;
  assert.ok(parseCachedInfo(JSON.stringify(bare), 'a.ts'));
});

test('every nested field is checked: a wrongly shaped value anywhere rejects the result', () => {
  const mutations: [string, (v: Record<string, any>) => void][] = [
    ['symbol name', (v) => (v.symbols[0].name = 5)],
    ['symbol kind', (v) => (v.symbols[0].kind = 'macro')],
    ['symbol line', (v) => (v.symbols[0].line = -1)],
    ['symbol signature', (v) => delete v.symbols[0].signature],
    ['symbol partial', (v) => (v.symbols[0].partial = false)],
    ['null symbol', (v) => (v.symbols[0] = null)],
    ['import names', (v) => (v.imports[0].names = 'a')],
    ['import name entry', (v) => (v.imports[0].names = [1])],
    ['import kind', (v) => (v.imports[0].kind = 'eval')],
    ['import typeOnly', (v) => (v.imports[0].typeOnly = 'no')],
    ['reexport source', (v) => delete v.reexports[0].source],
    ['unused import line', (v) => (v.unusedImports[0].line = '1')],
    ['suppression kind', (v) => (v.suppressions[0].kind = {})],
    ['dynamic load kind', (v) => (v.dynamicLoads[0].kind = 'shell')],
    ['dynamic load prefix', (v) => (v.dynamicLoads[0].prefix = 1)],
    ['parse status', (v) => (v.parse.status = 'fine')],
    ['parse lines', (v) => (v.parse.lines = ['a'])],
    ['parse limit', (v) => (v.parse.limit = 'time')],
    ['language', (v) => (v.lang = 'ruby')],
    ['bytes', (v) => (v.bytes = Infinity)],
    ['decorated', (v) => (v.decorated = 'false')],
    ['symbols not an array', (v) => (v.symbols = {})],
    ['path', (v) => (v.path = 'other.ts')],
  ];
  for (const [name, mutate] of mutations) {
    const v = clone();
    mutate(v);
    assert.equal(parseCachedInfo(JSON.stringify(v), 'a.ts'), null, name);
  }
  for (const junk of ['', '{', 'null', '[]', '"x"', '1']) assert.equal(parseCachedInfo(junk, 'a.ts'), null, junk);
  assert.equal(parseCachedInfo(undefined as unknown as string), null);
});

test('what the real parser produces passes the nested validation, so reuse really happens', async () => {
  await loadLanguages(['typescript', 'tsx', 'javascript', 'python']);
  const sources: [string, 'typescript' | 'tsx' | 'javascript' | 'python', string][] = [
    ['a.ts', 'typescript', "import type { T } from './t';\nimport { used, unused } from './u';\nexport * from './all';\nexport { x as y } from './x';\n/** Docs. */\nexport function f(a: number): T { return used(a); }\nexport class C {}\nexport enum E { A }\nexport interface I {}\nexport type Alias = string;\nexport const v = 1;\nexport default function () {}\n// @ts-ignore\nconst d = await import(`./plugins/${name}`);\n"],
    ['b.js', 'javascript', "const fs = require('fs');\nmodule.exports = { a() {} };\nrequire(name);\n"],
    ['c.py', 'python', "import os\nfrom . import sibling\n\n@decorator\nclass K:\n    \"\"\"Doc.\"\"\"\n\ndef run():\n    return os.name\n\nif __name__ == '__main__':\n    run()\n"],
    ['broken.ts', 'typescript', 'export function (\n'],
  ];
  for (const [file, lang, source] of sources) {
    const parsed = parseFile(file, lang, source);
    assert.ok(parsed, file);
    assert.ok(parseCachedInfo(JSON.stringify(parsed), file), `${file}: real parser output was rejected`);
  }
});
