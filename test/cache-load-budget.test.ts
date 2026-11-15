import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { SEALED_OVERHEAD, loadMachineKey } from '../src/db/cache-key.js';
import { closeDb, loadCache, openDb, type Db } from '../src/db/client.js';
import { CACHE_LIMITS, type CacheLimits } from '../src/db/schema.js';

// The aggregate budget of one cache load (CacheLimits.maxLoadBytes) is a number of bytes of stored data. These tests prove it is
// measured in UTF-8 bytes: text outside ASCII has fewer UTF-16 code units than bytes (a three-byte character is one unit, a
// four-byte character is two), so a budget counted with String.length would let a database through that holds three to four
// times the intended amount. They also prove that once the budget is spent no further signature is computed, and that the
// per-row limits are still enforced in bytes.

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-budget-home-')));
// TEMP may grant broad inherited permissions. Keep the machine-key directory private on Windows.
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
afterEach(() => {
  mock.restoreAll();
  open.splice(0).forEach(closeDb);
});
after(() => {
  if (saved === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = saved;
  for (const dir of [home, ...roots]) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

// A row signed exactly as this installation signs it, so that a row is skipped for the budget and not for a missing signature.
function signed(key: Buffer, file: string, hash: string, info: string): string {
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(['guardian-cache', 1, file, hash, info])).digest('hex');
  return `g1.${mac}.${info}`;
}

// The bytes the loader reads for one stored row: the signature wrapper plus the result, in UTF-8.
const stored = (info: string): number => SEALED_OVERHEAD + Buffer.byteLength(info, 'utf8');

// A database with the real layout holding exactly these results (in this order), every one correctly signed.
function database(infos: string[]): Db {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-budget-')));
  roots.push(root);
  closeDb(openDb(root));
  const key = loadMachineKey(root)!;
  const raw = new Database(path.join(root, '.guardian', 'cache.db'));
  try {
    const insert = raw.prepare('INSERT INTO files (path, hash, size, mtime_ms, info) VALUES (?, ?, 1, 2, ?)');
    raw.transaction(() => {
      for (const [i, info] of infos.entries()) {
        const file = `src/f${i}.ts`;
        const hash = sha(file);
        insert.run(file, hash, signed(key, file, hash, info));
      }
    })();
  } finally {
    raw.close();
  }
  const db = openDb(root);
  open.push(db);
  return db;
}

// The number of signatures computed while fn runs.
function hmacCalls(fn: () => void): number {
  const spy = mock.method(crypto, 'createHmac');
  fn();
  const calls = spy.mock.callCount();
  spy.mock.restore();
  return calls;
}

function load(db: Db, limits: CacheLimits): { loaded: string[]; calls: number } {
  let loaded: string[] = [];
  const calls = hmacCalls(() => {
    loaded = [...loadCache(db, limits).keys()];
  });
  return { loaded, calls };
}

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);

// Rows of one fixed size made of `unit`, which is `bytesPerUnit` bytes of UTF-8 and so a different number of UTF-16 code units.
const padded = (unit: string, count: number): string => `{"pad":"${unit.repeat(count)}"}`;

// --- the unit of the budget is the byte -----------------------------------------------------------------------------------

test('the budget counts the bytes of ASCII values, and a budget of exactly n rows admits n rows', () => {
  const info = padded('x', 1000);
  const db = database(Array.from({ length: 10 }, () => info));
  const one = stored(info);

  const exact = load(db, { ...CACHE_LIMITS, maxLoadBytes: 5 * one });
  assert.deepEqual(exact.loaded, names(5), 'five rows fit exactly, the sixth does not');
  assert.equal(exact.calls, 5, 'one signature per row read, none after the budget ran out');

  const short = load(db, { ...CACHE_LIMITS, maxLoadBytes: 5 * one - 1 });
  assert.deepEqual(short.loaded, names(4), 'one byte short of five rows admits four');
  assert.equal(short.calls, 4);

  assert.equal(load(db, CACHE_LIMITS).loaded.length, 10, 'with the default budget everything is read');
});

test('three-byte UTF-8 characters are counted as three bytes, not as one UTF-16 code unit', () => {
  const info = padded('€', 500); // 1510 bytes, 510 code units
  assert.equal(Buffer.byteLength(info), 1510);
  assert.ok(info.length < Buffer.byteLength(info) / 2.9, 'the string is about a third as long as its encoding');
  const db = database(Array.from({ length: 10 }, () => info));

  const { loaded, calls } = load(db, { ...CACHE_LIMITS, maxLoadBytes: 5 * stored(info) });
  assert.deepEqual(loaded, names(5), 'counted in code units this budget would have admitted all ten rows');
  assert.equal(calls, 5);
});

test('four-byte characters outside the BMP are counted as four bytes, not as two code units', () => {
  const info = padded('😀', 400); // 1610 bytes, 810 code units
  assert.equal(Buffer.byteLength(info), 1610);
  assert.equal(info.length, 810);
  const db = database(Array.from({ length: 10 }, () => info));

  const { loaded, calls } = load(db, { ...CACHE_LIMITS, maxLoadBytes: 5 * stored(info) });
  assert.deepEqual(loaded, names(5), 'counted in code units this budget would have admitted all ten rows');
  assert.equal(calls, 5);
});

test('rows of mixed widths are charged what each one actually occupies', () => {
  const infos = [padded('x', 300), padded('€', 300), padded('😀', 300), padded('x', 300), padded('€', 300)];
  const db = database(infos);
  const firstThree = infos.slice(0, 3).reduce((sum, info) => sum + stored(info), 0);

  const fits = load(db, { ...CACHE_LIMITS, maxLoadBytes: firstThree });
  assert.deepEqual(fits.loaded, names(3));
  assert.equal(fits.calls, 3);

  const short = load(db, { ...CACHE_LIMITS, maxLoadBytes: firstThree - 1 });
  assert.deepEqual(short.loaded, names(2), 'one byte short of the third row, so the third is not read');
  assert.equal(short.calls, 2);
});

// --- the real limit ---------------------------------------------------------------------------------------------------------

test('the default limit means 64 MiB of data: three-byte text near the per-row ceiling stops at 16 rows, not 48', () => {
  assert.equal(CACHE_LIMITS.maxLoadBytes, 64 * 1024 * 1024);
  const info = padded('€', 1_398_000); // 4,194,010 bytes: under maxInfoBytes, but only 1,398,010 code units
  assert.ok(Buffer.byteLength(info) <= CACHE_LIMITS.maxInfoBytes);
  assert.ok(info.length * 3 > CACHE_LIMITS.maxInfoBytes * 0.99);
  const db = database(Array.from({ length: 20 }, () => info));

  const { loaded, calls } = load(db, CACHE_LIMITS);
  const expected = Math.floor(CACHE_LIMITS.maxLoadBytes / stored(info));
  assert.equal(expected, 16);
  assert.deepEqual(loaded, names(expected));
  assert.equal(calls, expected, 'no signature for the rows beyond the limit');
});

// --- once the budget is spent, nothing more is done ---------------------------------------------------------------------------

test('a row that does not fit ends the load: later rows are not read, even small ones that would fit, and cost no signature', () => {
  const small = padded('x', 100);
  const big = padded('€', 400);
  const db = database([small, big, small, small]);
  const limits = { ...CACHE_LIMITS, maxLoadBytes: stored(small) + stored(big) - 1 };

  const { loaded, calls } = load(db, limits);
  assert.deepEqual(loaded, ['src/f0.ts']);
  assert.equal(calls, 1, 'the oversized row and the rows after it were never signed');
});

test('a budget smaller than the first row loads nothing and computes no signature', () => {
  const info = padded('😀', 100);
  const db = database([info, info]);
  const { loaded, calls } = load(db, { ...CACHE_LIMITS, maxLoadBytes: stored(info) - 1 });
  assert.deepEqual(loaded, []);
  assert.equal(calls, 0);
});

// --- the per-row limit is unchanged, and is also in bytes -------------------------------------------------------------------

test('an individual value over maxInfoBytes is rejected by its byte size and does not consume the budget', () => {
  const limits = { ...CACHE_LIMITS, maxInfoBytes: 1000, maxLoadBytes: 10_000 };
  const ok = padded('x', 100);
  const wide = padded('€', 400); // 1210 bytes: over 1000 bytes, although it has only 410 code units
  const wider = padded('😀', 300); // 1210 bytes, 610 code units
  assert.ok(wide.length < limits.maxInfoBytes && Buffer.byteLength(wide) > limits.maxInfoBytes);
  assert.ok(wider.length < limits.maxInfoBytes && Buffer.byteLength(wider) > limits.maxInfoBytes);
  const db = database([ok, wide, wider, ok]);

  const { loaded, calls } = load(db, limits);
  assert.deepEqual(loaded, ['src/f0.ts', 'src/f3.ts'], 'the oversized values are skipped, the rows around them still load');
  assert.equal(calls, 2, 'no signature was computed for an oversized value');
});

test('a value of exactly maxInfoBytes still loads, one byte more does not', () => {
  const limits = { ...CACHE_LIMITS, maxInfoBytes: 1000, maxLoadBytes: 100_000 };
  const exact = padded('€', 330); // 10 + 990 = 1000 bytes
  const edge = padded('€', 330).replace('"}', 'x"}'); // one byte more
  assert.equal(Buffer.byteLength(exact), 1000);
  assert.equal(Buffer.byteLength(edge), 1001);
  const db = database([exact, edge]);

  const { loaded, calls } = load(db, limits);
  assert.deepEqual(loaded, ['src/f0.ts']);
  assert.equal(calls, 1);
});

test('a value that is a few bytes over the budget but within the per-row limit is still subject to the budget', () => {
  const info = padded('€', 300);
  const db = database([info]);
  assert.equal(load(db, { ...CACHE_LIMITS, maxLoadBytes: stored(info) }).loaded.length, 1);
  assert.equal(load(db, { ...CACHE_LIMITS, maxLoadBytes: stored(info) - 1 }).loaded.length, 0);
});

// --- signature checks are unchanged ---------------------------------------------------------------------------------------

test('rows inside the budget are still verified: a tampered row is dropped and its bytes were still charged', () => {
  const info = padded('€', 200);
  const db = database([info, info, info]);
  // Corrupt the signature of the middle row.
  const file = (db.prepare('PRAGMA database_list').get() as { file: string }).file;
  closeDb(db);
  open.length = 0;
  const raw = new Database(file);
  try {
    raw.prepare("UPDATE files SET info = replace(info, 'g1.', 'g1.0') WHERE path = 'src/f1.ts'").run();
  } finally {
    raw.close();
  }
  const root = path.dirname(path.dirname(file));
  const reopened = openDb(root);
  open.push(reopened);

  const { loaded, calls } = load(reopened, { ...CACHE_LIMITS, maxLoadBytes: 10 * stored(info) });
  assert.deepEqual(loaded, ['src/f0.ts', 'src/f2.ts']);
  assert.ok(calls <= 3, 'at most one signature per row read');
});
