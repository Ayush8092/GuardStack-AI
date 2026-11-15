import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { currentUserSid } from '../src/db/windows-acl.js';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { loadMachineKey, type KeyOptions } from '../src/db/cache-key.js';

// The machine key is 64 hexadecimal characters. It is read through one descriptor, never more than a few bytes of it, and only
// if it is a regular, singly linked file that stays the same file around the read. Every failure ends the same way: no key
// (null), which keeps the cache in memory. Each test also says why, so a rejection for the wrong reason does not pass.

const created: string[] = [];
const saved = process.env.GUARDIAN_STATE_HOME;
const posixOnly = process.platform === 'win32' && 'POSIX owners and modes only';
const symlinks: string | false = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-keyprobe-'));
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

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-keyread-')));
created.push(base);
// TEMP may grant broad inherited permissions. Keep the test key directory
// private so loadMachineKey() can exercise key creation on Windows.
if (process.platform === 'win32') {
  execFileSync('icacls.exe', [
    base,
    '/inheritance:r',
    '/grant:r', `*${currentUserSid()}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ], { stdio: 'ignore', windowsHide: true });
}
let counter = 0;
let workspace = '';
let stateDir = '';
const keyFile = (): string => path.join(stateDir, 'cache-key');

beforeEach(() => {
  const n = counter++;
  workspace = path.join(base, `ws-${n}`);
  stateDir = path.join(base, `state-${n}`);
  fs.mkdirSync(workspace);
  process.env.GUARDIAN_STATE_HOME = stateDir;
});
after(() => {
  if (saved === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = saved;
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

// Runs `fn` and returns what it wrote to stderr (the logger's warnings).
function warnings<T>(fn: () => T): { result: T; text: string } {
  const original = process.stderr.write.bind(process.stderr);
  let text = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), text };
  } finally {
    process.stderr.write = original;
  }
}

// Creates the real key (so the directory and file are exactly what production makes), then lets the test change the file.
function install(content?: string | Buffer, mode = 0o600): void {
  let exists = true;
  try {
    fs.lstatSync(keyFile());
  } catch {
    exists = false;
  }
  if (!exists) assert.ok(loadMachineKey(workspace), 'the first call creates a key');
  if (content !== undefined) {
    fs.writeFileSync(keyFile(), content);
    fs.chmodSync(keyFile(), mode);
  }
}

const load = (options: KeyOptions = {}): { key: Buffer | null; text: string } => {
  const { result, text } = warnings(() => loadMachineKey(workspace, options));
  return { key: result, text };
};

function refused(content: string | Buffer, reason: RegExp, mode = 0o600): void {
  install(content, mode);
  const { key, text } = load();
  assert.equal(key, null, `${JSON.stringify(String(content).slice(0, 24))} must not be accepted`);
  assert.match(text, reason);
}

test('a correct key is created, read back, and equal on every load', () => {
  const first = loadMachineKey(workspace);
  assert.ok(first && first.length === 32);
  assert.match(fs.readFileSync(keyFile(), 'utf8'), /^[0-9a-f]{64}\n$/);
  assert.deepEqual(loadMachineKey(workspace), first);
});

test('the key may end with one line ending, "\\n" or "\\r\\n", or none', () => {
  for (const ending of ['\n', '\r\n', '']) {
    install(`${HEX}${ending}`);
    assert.deepEqual(load().key, Buffer.from(HEX, 'hex'), JSON.stringify(ending));
  }
});

test('an empty key is refused after a short wait, and a key that appears while waiting is used', () => {
  install('');
  const { key, text } = load();
  assert.equal(key, null);
  assert.match(text, /does not hold a valid key/);

  fs.writeFileSync(keyFile(), '');
  let attempts = 0;
  const waited = load({
    hooks: {
      beforeOpen: () => {
        if (++attempts === 3) fs.writeFileSync(keyFile(), `${HEX}\n`);
      },
    },
  });
  assert.deepEqual(waited.key, Buffer.from(HEX, 'hex'), 'the creator finished writing during the wait');
  assert.equal(attempts, 3);
});

test('malformed content is refused: bad characters, wrong length, truncation, case', () => {
  refused(`${HEX.slice(0, 63)}g\n`, /does not hold a valid key/);
  refused(`${'z'.repeat(64)}\n`, /does not hold a valid key/);
  refused(`${HEX.slice(0, 63)}\n`, /does not hold a valid key/); // truncated by one character
  refused(`${HEX.slice(0, 32)}\n`, /does not hold a valid key/);
  refused('not a key at all\n', /does not hold a valid key/);
  refused(`${HEX.toUpperCase()}\n`, /does not hold a valid key/);
  refused(Buffer.from([0xff, 0xfe, 0x00, 0x41]), /does not hold a valid key/);
  refused(`${HEX}0\n`, /does not hold a valid key/); // 65 characters
});

test('unexpected extra content is refused, even when a valid key is in it', () => {
  refused(`${HEX}\n${OTHER}\n`, /larger than a key can be/);
  refused(`${HEX}\nextra`, /larger than a key can be|does not hold a valid key/);
  refused(`${HEX}\n\n`, /does not hold a valid key/);
  refused(` ${HEX}\n`, /does not hold a valid key/);
  refused(`${HEX} \n`, /does not hold a valid key/);
  refused(`${HEX}\0`, /does not hold a valid key/);
  refused(`# comment\n${HEX}\n`, /larger than a key can be|does not hold a valid key/);
});

test('an oversized key file is refused from its size, before any of it is read', () => {
  refused('a'.repeat(4096), /larger than a key can be/);
  // A sparse 1 GiB file costs nothing to create and a great deal to read in full: the refusal must not depend on reading it.
  install('');
  fs.truncateSync(keyFile(), 1024 * 1024 * 1024);
  const started = Date.now();
  const { key, text } = load();
  assert.equal(key, null);
  assert.match(text, /larger than a key can be/);
  assert.ok(Date.now() - started < 2000, 'the size is checked on the descriptor, not by reading');
});

test('a file that grows after its size was checked cannot make the read unbounded or be accepted', () => {
  install();
  const { key, text } = load({ hooks: { afterOpen: () => fs.appendFileSync(keyFile(), 'x'.repeat(1024 * 1024)) } });
  assert.equal(key, null);
  assert.match(text, /changed while it was being read|does not hold a valid key|larger than/);
  fs.writeFileSync(keyFile(), `${HEX}\n`);
  fs.chmodSync(keyFile(), 0o600);
  assert.ok(load().key, 'the key file itself is fine once it is restored');
});

test('a file that is cut short while it is read is refused', () => {
  install();
  const { key, text } = load({ hooks: { afterOpen: () => fs.truncateSync(keyFile(), 10) } });
  assert.equal(key, null);
  assert.match(text, /changed while it was being read/);
});

test('a symbolic link in the key\'s place is refused, whether it is there from the start or appears at the wrong moment', { skip: symlinks }, () => {
  const decoy = path.join(base, `decoy-${counter}`);
  fs.writeFileSync(decoy, `${HEX}\n`, { mode: 0o600 });
  const replaceWithLink = (): void => {
    fs.rmSync(keyFile());
    fs.symlinkSync(decoy, keyFile());
  };

  install();
  replaceWithLink();
  assert.match(load().text, /cache-key is a symbolic link/);
  assert.equal(load().key, null, 'there from the start');

  for (const point of ['beforeOpen', 'afterOpen', 'afterRead'] as const) {
    install(`${HEX}\n`);
    fs.rmSync(keyFile(), { force: true });
    fs.writeFileSync(keyFile(), `${HEX}\n`, { mode: 0o600 });
    const { key } = load({ hooks: { [point]: replaceWithLink } });
    assert.equal(key, null, `swapped in at ${point}`);
  }
  assert.equal(fs.readFileSync(decoy, 'utf8'), `${HEX}\n`, 'the link target was only ever read, never written');
});

test('a hard link to the key file is refused, whether it exists from the start or is made while it is read', () => {
  install();
  const alias = path.join(base, `alias-${counter}`);
  fs.linkSync(keyFile(), alias);
  const { key, text } = load();
  assert.equal(key, null);
  assert.match(text, /more than one hard link/);
  fs.rmSync(alias);
  assert.ok(load().key, 'the key is usable again once the extra link is gone');

  for (const point of ['afterOpen', 'afterRead'] as const) {
    fs.rmSync(`${alias}-${point}`, { force: true });
    const hooks = { [point]: () => fs.linkSync(keyFile(), `${alias}-${point}`) };
    const raced = load({ hooks });
    assert.equal(raced.key, null, `a link made at ${point}`);
    assert.match(raced.text, /more than one hard link/);
    fs.rmSync(`${alias}-${point}`, { force: true });
  }
});

test('a key file replaced by another file while it is read is refused', () => {
  for (const point of ['beforeOpen', 'afterOpen', 'afterRead'] as const) {
    install();
    const swap = (): void => {
      fs.renameSync(keyFile(), `${keyFile()}.old-${point}`);
      fs.writeFileSync(keyFile(), `${OTHER}\n`, { mode: 0o600 });
    };
    const { key, text } = load({ hooks: { [point]: swap } });
    // beforeOpen: the descriptor is of the new file, which differs from what the path named. The others: the path no longer names the file that was read.
    assert.equal(key, null, point);
    assert.match(text, /changed while it was being read/);
    fs.rmSync(keyFile(), { force: true });
  }
});

test('a key file that is not a regular file is refused', () => {
  install();
  fs.rmSync(keyFile());
  fs.mkdirSync(keyFile());
  const { key, text } = load();
  assert.equal(key, null);
  assert.match(text, /not a regular file/);
});

test('POSIX: a key that other users can read or write is refused, a private one is used', { skip: posixOnly }, () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o602]) {
    install(`${HEX}\n`, mode);
    const { key, text } = load();
    assert.equal(key, null, mode.toString(8));
    assert.match(text, /accessible to other users/);
  }
  install(`${HEX}\n`, 0o600);
  assert.ok(load().key);
  fs.chmodSync(keyFile(), 0o400);
  assert.ok(load().key, 'read-only for the owner is private too');
});

test('Windows ACL verification still decides (stubbed ACL reader)', () => {
  const win = (acl: KeyOptions['acl'], extra: Partial<KeyOptions> = {}): KeyOptions => ({ platform: 'win32', acl, ...extra });
  const open = (): string | null => null;

  assert.ok(loadMachineKey(workspace, win(open)), 'a private key directory and file are accepted');
  assert.ok(loadMachineKey(workspace, win(open)), 'and read again');

  const asked: string[][] = [];
  loadMachineKey(workspace, win((targets) => (asked.push(targets.map((t) => t.what)), null)));
  assert.deepEqual(asked, [['the key directory', 'cache-key']], 'an existing key is inspected together with its directory');

  const refusedFile = load(win((targets) => (targets.some((t) => t.what === 'cache-key') ? 'cache-key is accessible to other users' : null)));
  assert.equal(refusedFile.key, null);
  assert.match(refusedFile.text, /accessible to other users/);

  const unreadable = load(win(() => 'the permissions of cache-key could not be read'));
  assert.equal(unreadable.key, null);
  assert.match(unreadable.text, /could not be read/);
});

test('Windows: the key that was inspected is the key that is read', () => {
  assert.ok(loadMachineKey(workspace, { platform: 'win32', acl: () => null }));
  // The ACL reader runs on the path; a file swapped in right after it must not be read in the inspected file's place.
  const swapAfterInspection: KeyOptions['acl'] = () => {
    fs.renameSync(keyFile(), `${keyFile()}.inspected`);
    fs.writeFileSync(keyFile(), `${OTHER}\n`, { mode: 0o600 });
    return null;
  };
  const { key, text } = load({ platform: 'win32', acl: swapAfterInspection });
  assert.equal(key, null);
  assert.match(text, /changed while it was being read/);
});
