import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';
import { UnsafeFileError, appendToRegularFile, createFileExclusive } from '../src/core/security/safe-file.js';
import { loadMachineKey } from '../src/db/cache-key.js';

// Regression tests from the final integration audit. They import only the modules under test, so they run without the
// native and third-party dependencies.

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-audit-')));
const savedState = process.env.GUARDIAN_STATE_HOME;
const realWriteSync = fs.writeSync;
let counter = 0;
const fresh = (): string => {
  const dir = path.join(base, `case-${counter++}`);
  fs.mkdirSync(dir);
  return dir;
};

afterEach(() => {
  mock.restoreAll();
  if (savedState === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = savedState;
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

// Wraps fs.writeSync so that each call writes at most `chunk` bytes (0 = writes nothing), which is what a full disk does.
function limitWrites(chunk: number): { calls: () => number } {
  const spy = mock.method(fs, 'writeSync', ((fd: number, data: NodeJS.ArrayBufferView | string, ...rest: unknown[]) => {
    if (chunk === 0) return 0;
    // A string is written as its UTF-8 bytes, so a short write can end in the middle of a character, as a real one can.
    const view = typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as Uint8Array);
    const offset = typeof data === 'string' ? 0 : typeof rest[0] === 'number' ? rest[0] : 0;
    const length = typeof data === 'string' ? view.byteLength : typeof rest[1] === 'number' ? rest[1] : view.byteLength - offset;
    return realWriteSync(fd, view, offset, Math.min(length, chunk));
  }) as typeof fs.writeSync);
  return { calls: () => spy.mock.callCount() };
}

test('createFileExclusive writes the whole text when the system accepts only a few bytes per call', () => {
  const dir = fresh();
  const text = 'abcdefghij'.repeat(10);
  const writes = limitWrites(7);
  assert.equal(createFileExclusive(dir, 'out.txt', text, 0o600), true);
  assert.ok(writes.calls() > 1, 'the text needed several write calls');
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), text);
});

test('createFileExclusive counts bytes, not characters, when it writes text outside ASCII', () => {
  const dir = fresh();
  const text = 'é€😀'.repeat(20);
  limitWrites(5);
  assert.equal(createFileExclusive(dir, 'wide.txt', text, 0o600), true);
  assert.equal(fs.readFileSync(path.join(dir, 'wide.txt'), 'utf8'), text);
});

test('createFileExclusive fails, and removes what it created, when nothing can be written', () => {
  const dir = fresh();
  limitWrites(0);
  assert.throws(() => createFileExclusive(dir, 'out.txt', 'content', 0o600), (err: unknown) => err instanceof UnsafeFileError && /completely/.test(err.message));
  mock.restoreAll();
  assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'a file that could not be written is not left behind as if it were created');
});

test('appendToRegularFile writes the whole addition across short writes', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  limitWrites(3);
  assert.equal(appendToRegularFile(dir, '.gitignore', 1024, () => '.guardian/\n*.db\n'), true);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.guardian/\n*.db\n');
});

test('appendToRegularFile reports an incomplete write as an error, not as success', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  limitWrites(0);
  assert.throws(() => appendToRegularFile(dir, '.gitignore', 1024, () => '.guardian/\n'), UnsafeFileError);
});

test('a key directory whose name starts with two dots inside the workspace is still recognised as inside it', () => {
  const workspace = fresh();
  const state = path.join(workspace, '..state');
  process.env.GUARDIAN_STATE_HOME = state;
  assert.equal(loadMachineKey(workspace), null, 'no key may be established inside the workspace');
  assert.equal(fs.existsSync(path.join(state, 'cache-key')), false, 'and none may be written there');
});

test('a key directory next to the workspace is accepted (the check is not over-broad)', { skip: process.platform === 'win32' && 'Windows needs its ACL inspection' }, () => {
  const workspace = fresh();
  const state = path.join(base, `state-${counter++}`);
  process.env.GUARDIAN_STATE_HOME = state;
  const key = loadMachineKey(workspace);
  assert.ok(key && key.length === 32);
});
