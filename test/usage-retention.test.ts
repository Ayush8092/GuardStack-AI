import assert from 'node:assert/strict';
import { execFileSync,spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { USAGE_SQL, closeDb, lifetimeUsage, openDb, recordUsage, type Db } from '../src/db/client.js';
import { CACHE_LIMITS, CACHE_VERSION, schema } from '../src/db/schema.js';
import { inspectSchema } from '../src/db/schema-check.js';

// The usage table is bounded while the server runs, not only when the database is opened: every recordUsage call keeps it within
// CACHE_LIMITS.maxUsageRows, folds the rows it trims into usage_archive so the lifetime totals stay exact, and never scans the table.

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-usage-home-')));

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

const roots: string[] = [];
const open: Db[] = [];
const saved = process.env.GUARDIAN_STATE_HOME;
let counter = 0;

beforeEach(() => {
  process.env.GUARDIAN_STATE_HOME = path.join(home, `state-${counter++}`);
});
afterEach(() => open.splice(0).forEach(closeDb));
after(() => {
  if (saved === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = saved;
  for (const dir of [home, ...roots]) fs.rmSync(dir, { recursive: true, force: true });
});

const workspace = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-usage-')));
  roots.push(dir);
  return dir;
};
const opened = (root: string): Db => {
  const db = openDb(root);
  open.push(db);
  return db;
};
const isMemory = (db: Db): boolean => (db.prepare('PRAGMA database_list').get() as { file: string }).file === '';
const rows = (db: Db): { n: number; lo: number; hi: number } => db.prepare('SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM usage').get() as { n: number; lo: number; hi: number };
const archive = (db: Db): unknown => db.prepare('SELECT calls, raw_tokens, sent_tokens FROM usage_archive WHERE id = 1').get();
const small = (maxUsageRows: number) => ({ ...CACHE_LIMITS, maxUsageRows });

test('more than the limit in one open session: the table stays bounded, the newest rows stay, the lifetime totals stay exact', () => {
  const db = opened(workspace());
  assert.equal(isMemory(db), false, 'this test is about the file-backed cache');
  const total = CACHE_LIMITS.maxUsageRows + 250;
  let raw = 0;
  for (let i = 1; i <= total; i++) {
    recordUsage(db, i === total ? 'last' : 'tool', i, 1);
    raw += i;
    // A count is a scan, so it is only taken now and then; the bound itself is checked at the end of every 20,000 writes.
    if (i % 20_000 === 0 || i === CACHE_LIMITS.maxUsageRows + 1) assert.ok(rows(db).n <= CACHE_LIMITS.maxUsageRows, `after ${i} records`);
  }
  const now = rows(db);
  assert.equal(now.n, CACHE_LIMITS.maxUsageRows, 'exactly the limit is kept');
  assert.equal(now.hi, total);
  assert.equal(now.lo, total - CACHE_LIMITS.maxUsageRows + 1, 'the oldest rows are the ones that went');
  const newest = db.prepare('SELECT tool, raw_tokens FROM usage WHERE id = ?').get(total) as { tool: string; raw_tokens: number };
  assert.deepEqual({ ...newest }, { tool: 'last', raw_tokens: total });
  const oldestKept = db.prepare('SELECT raw_tokens FROM usage WHERE id = ?').get(now.lo) as { raw_tokens: number };
  assert.equal(oldestKept.raw_tokens, now.lo, 'the oldest retained row is intact');
  assert.deepEqual({ ...lifetimeUsage(db) }, { calls: total, raw, sent: total }, 'trimmed rows are still counted');
  assert.equal((archive(db) as { calls: number }).calls, 250);
});

test('no statement of a usage write scans the table', () => {
  const db = opened(workspace());
  const plan = (sql: string, ...params: unknown[]): string[] => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
  const plans = {
    insert: plan(USAGE_SQL.insert, 1, 't', 1, 1),
    expiring: plan(USAGE_SQL.expiring, { cutoff: 5, maxTokens: 1000 }),
    archive: plan(USAGE_SQL.archive, { calls: 1, raw: 1, sent: 1, cap: 10 }),
    trim: plan(USAGE_SQL.trim, 5),
  };
  for (const [name, details] of Object.entries(plans)) {
    assert.ok(!details.some((d) => /\bSCAN (usage|usage_archive)\b/.test(d)), `${name} scans a table: ${details.join(' | ')}`);
  }
  assert.ok(plans.expiring.some((d) => /SEARCH usage USING INTEGER PRIMARY KEY/.test(d)), `the range to trim is found by rowid: ${plans.expiring.join(' | ')}`);
  assert.ok(plans.trim.some((d) => /SEARCH usage USING INTEGER PRIMARY KEY/.test(d)), `the delete is a rowid range: ${plans.trim.join(' | ')}`);
});

test('each write trims only what it displaces: in steady state one row, never a table-sized delete', () => {
  const db = opened(workspace());
  const limits = small(10);
  for (let i = 0; i < 10; i++) recordUsage(db, 't', 1, 1, limits);
  const deletes: number[] = [];
  for (let i = 0; i < 25; i++) {
    const before = rows(db).lo;
    recordUsage(db, 't', 1, 1, limits);
    deletes.push(rows(db).lo - before);
  }
  assert.ok(deletes.every((d) => d === 1), `each call removed exactly the one row it displaced: ${deletes.join(',')}`);
});

test('two connections to one file, interleaved: both leave the table within the limit', () => {
  const root = workspace();
  const a = opened(root);
  const b = opened(root);
  assert.ok(!isMemory(a) && !isMemory(b));
  const limits = small(7);
  for (let i = 0; i < 60; i++) {
    recordUsage(i % 2 ? a : b, 't', 2, 1, limits);
    assert.ok(rows(a).n <= 7, `after write ${i}`);
  }
  assert.deepEqual({ ...lifetimeUsage(a, limits) }, { calls: 60, raw: 120, sent: 60 });
});

test('separate processes writing at once never leave the table above the limit, and the totals match the highest id', async () => {
  const root = workspace();
  closeDb(opened(root));
  open.length = 0;
  const script = path.join(root, 'writer.ts');
  const client = path.resolve(import.meta.dirname, '../src/db/client.ts');
  fs.writeFileSync(
    script,
    `import { closeDb, openDb, recordUsage } from ${JSON.stringify(client)};
const root = process.argv[2];
const db = openDb(root);
const limits = { maxDbBytes: 1 << 30, maxRows: 20000, maxInfoBytes: 1 << 20, maxPathBytes: 4096, maxLoadBytes: 1 << 26, maxUsageRows: 20, maxUsageTokens: 1e9 };
for (let i = 0; i < 150; i++) recordUsage(db, 'child', 3, 1, limits);
closeDb(db);
`,
  );
  const children = [0, 1, 2].map(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script, root], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
        let err = '';
        child.stderr.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(0) : reject(new Error(`writer exited ${code}: ${err.slice(0, 500)}`))));
      }),
  );
  await Promise.all(children);
  const db = opened(root);
  const now = rows(db);
  assert.equal(now.n, 20, 'bounded');
  assert.equal(now.hi - now.lo, 19, 'the retained rows are the newest, contiguous ids');
  const usage = lifetimeUsage(db, small(20));
  // A write that lost the lock for 5 s would be dropped, and its id rolled back with it, so the highest id is exactly the number of records kept.
  assert.equal(usage.calls, now.hi);
  assert.equal(usage.raw, now.hi * 3);
  assert.ok(usage.calls > 20, 'the writers really did exceed the limit between them');
});

test('a failed write is rolled back whole: no row without its trim, nothing thrown, and recording resumes afterwards', () => {
  const db = opened(workspace());
  const limits = small(3);
  for (let i = 0; i < 3; i++) recordUsage(db, 't', 10, 1, limits);
  db.exec("CREATE TRIGGER refuse BEFORE INSERT ON usage_archive BEGIN SELECT RAISE(ABORT, 'refused'); END");
  assert.doesNotThrow(() => recordUsage(db, 't', 10, 1, limits));
  assert.deepEqual({ ...rows(db) }, { n: 3, lo: 1, hi: 3 }, 'the new row went with the failed trim');
  db.exec('DROP TRIGGER refuse');
  recordUsage(db, 't', 10, 1, limits);
  assert.deepEqual({ ...rows(db) }, { n: 3, lo: 2, hi: 4 });
  assert.deepEqual({ ...lifetimeUsage(db, limits) }, { calls: 4, raw: 40, sent: 4 });
});

test('a read-only or locked database makes recordUsage drop the record, not throw', () => {
  const db = opened(workspace());
  recordUsage(db, 't', 1, 1);
  db.pragma('query_only = ON');
  assert.doesNotThrow(() => recordUsage(db, 't', 1, 1));
  db.pragma('query_only = OFF');
  assert.equal(rows(db).n, 1);
});

test('crafted archive values are not believed and do not break writing or reading', () => {
  const db = opened(workspace());
  db.prepare("INSERT INTO usage_archive (id, calls, raw_tokens, sent_tokens) VALUES (1, -5, 9000000000000000000, 'lots')").run();
  const limits = small(2);
  for (let i = 0; i < 4; i++) recordUsage(db, 't', 5, 2, limits);
  const usage = lifetimeUsage(db, limits);
  assert.deepEqual({ ...usage }, { calls: 4, raw: 20, sent: 8 }, 'bad archived values count as 0; the real rows are all counted');
  assert.ok(Number.isSafeInteger(usage.calls) && Number.isSafeInteger(usage.raw) && Number.isSafeInteger(usage.sent));
});

test('a database of the previous layout keeps its usage rows and gains the archive table', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.guardian'), { mode: 0o700 });
  const raw = new Database(path.join(root, '.guardian', 'cache.db'));
  raw.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, info TEXT NOT NULL);
    CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tool TEXT NOT NULL, raw_tokens INTEGER NOT NULL, sent_tokens INTEGER NOT NULL)`);
  raw.prepare('INSERT INTO usage (at, tool, raw_tokens, sent_tokens) VALUES (1, ?, 100, 40)').run('optimize_prompt');
  raw.pragma(`user_version = ${CACHE_VERSION - 1}`);
  raw.close();
  const db = opened(root);
  assert.equal(isMemory(db), false, 'migrated, not replaced by a memory fallback');
  assert.equal(db.pragma('user_version', { simple: true }), CACHE_VERSION);
  assert.deepEqual({ ...lifetimeUsage(db) }, { calls: 1, raw: 100, sent: 40 });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'usage_archive'").get());
});

// usage_archive is part of the exact structure that is trusted: a shipped database that declares it differently is replaced.
for (const [what, from, to] of [
  ['an extra column', '  sent_tokens INTEGER NOT NULL\n);\n', '  sent_tokens INTEGER NOT NULL,\n  who TEXT\n);\n'],
  ['nullable calls', 'calls       INTEGER NOT NULL', 'calls       INTEGER'],
  ['a CHECK constraint', 'calls       INTEGER NOT NULL', 'calls       INTEGER NOT NULL CHECK (calls >= 0)'],
  ['a default', 'calls       INTEGER NOT NULL', 'calls       INTEGER NOT NULL DEFAULT 0'],
] as const) {
  test(`usage_archive declared differently (${what}) is replaced by the supported cache`, () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, '.guardian'), { mode: 0o700 });
    const index = schema.indexOf('CREATE TABLE IF NOT EXISTS usage_archive');
    const hostile = schema.slice(0, index) + schema.slice(index).replace(from, to);
    assert.notEqual(hostile, schema, 'fixture bug');
    const raw = new Database(path.join(root, '.guardian', 'cache.db'));
    raw.exec(hostile);
    raw.pragma(`user_version = ${CACHE_VERSION}`);
    raw.close();
    const db = opened(root);
    assert.equal(isMemory(db), false);
    assert.equal(inspectSchema(db, CACHE_VERSION).problem, null);
    assert.ok(!(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_archive'").get() as { sql: string }).sql.match(/CHECK|DEFAULT|who|calls\s+INTEGER,/));
  });
}
