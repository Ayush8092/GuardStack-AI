import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { indexProject } from '../src/core/ast/indexer.js';
import { loadMachineKey } from '../src/db/cache-key.js';
import { closeDb } from '../src/db/client.js';
import { CACHE_LIMITS } from '../src/db/schema.js';
import { cleanup, context, workspace } from './helpers.js';

// The indexer end to end over a cache a repository has filled with hostile rows: the scan still finishes, the answer is
// computed from the real files, and the junk does not stay behind.

const home = workspace({}, 'guardian-limits-index-home-');
// TEMP may grant broad inherited permissions. Keep the test state directory
// private so loadMachineKey() can create a persistent key on Windows.
if (process.platform === 'win32') {
  execFileSync('icacls.exe', [
    home,
    '/inheritance:r',
    '/grant:r', `*${currentUserSid()}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ], { stdio: 'ignore', windowsHide: true });
}
const savedHome = process.env.GUARDIAN_STATE_HOME;
let counter = 0;
beforeEach(() => {
  process.env.GUARDIAN_STATE_HOME = path.join(home, `state-${counter++}`);
});
after(() => {
  if (savedHome === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = savedHome;
  cleanup();
});

const cacheFile = (root: string): string => path.join(root, '.guardian', 'cache.db');
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const SOURCE = 'export const real = 1;\n';

async function seeded(): Promise<string> {
  const root = workspace({ 'a.ts': SOURCE });
  const ctx = context(root);
  await indexProject(ctx);
  closeDb(ctx.db);
  return root;
}

// Closed afterwards, so that the test can read the database file directly.
const symbolsOf = async (root: string): Promise<string[]> => {
  const ctx = context(root);
  try {
    const project = await indexProject(ctx);
    return project.files.find((f) => f.path === 'a.ts')!.symbols.map((s) => s.name);
  } finally {
    closeDb(ctx.db);
  }
};

test('an oversized row for a real file, even one signed with this machine\'s key, is recomputed and then replaced by a normal row', async () => {
  const root = await seeded();
  const key = loadMachineKey(root)!;
  const hash = sha(SOURCE);
  const huge = `{"pad":"${'x'.repeat(CACHE_LIMITS.maxInfoBytes)}"}`;
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(['guardian-cache', 1, 'a.ts', hash, huge])).digest('hex');
  const raw = new Database(cacheFile(root));
  raw.prepare('UPDATE files SET info = ? WHERE path = ?').run(`g1.${mac}.${huge}`, 'a.ts');
  raw.close();

  assert.deepEqual(await symbolsOf(root), ['real']);

  const after = new Database(cacheFile(root), { readonly: true });
  const stored = (after.prepare('SELECT info FROM files WHERE path = ?').get('a.ts') as { info: string }).info;
  after.close();
  assert.ok(stored.length < 1024 * 1024, 'the oversized value was overwritten by the real result');
});

test('junk rows for files that do not exist are removed by a complete scan, however they are typed', async () => {
  const root = await seeded();
  const raw = new Database(cacheFile(root));
  const add = raw.prepare('INSERT OR REPLACE INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, ?, ?, ?)');
  raw.transaction(() => {
    for (let i = 0; i < 500; i++) add.run(`ghost${i}.ts`, sha(String(i)), 1, 1, '{}');
    add.run(Buffer.from('blob-path'), sha('b'), 1, 1, '{}');
    add.run('g'.repeat(CACHE_LIMITS.maxPathBytes + 1), sha('l'), 1, 1, '{}');
  })();
  raw.close();

  assert.deepEqual(await symbolsOf(root), ['real']);

  const check = new Database(cacheFile(root), { readonly: true });
  const paths = (check.prepare('SELECT path FROM files').all() as { path: string }[]).map((r) => r.path);
  check.close();
  assert.deepEqual(paths, ['a.ts']);
});

test('a cache.db over the size limit does not stop a scan: the real files are indexed in memory and the file is left alone', async () => {
  const root = await seeded();
  const size = CACHE_LIMITS.maxDbBytes + 1;
  fs.truncateSync(cacheFile(root), size);

  assert.deepEqual(await symbolsOf(root), ['real']);
  assert.equal(fs.statSync(cacheFile(root)).size, size);
});
