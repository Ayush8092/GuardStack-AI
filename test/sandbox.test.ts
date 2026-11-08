import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SandboxError, isSensitivePath, readInside, resolveInside, resolveWorkspaceRoot } from '../src/core/security/sandbox.js';
import { symlinksWork } from './helpers.js';

let base: string;
let root: string;
let outside: string;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-sandbox-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  if (!symlinksWork) {
    fs.symlinkSync(outside, path.join(root, 'link'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'stolen.ts'));
  }
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test('allows files inside the workspace', () => {
  const lexical = path.resolve(root, 'src/a.ts');
  const real = fs.realpathSync.native(lexical);


  assert.equal(resolveInside(root, 'src/a.ts'), real);
  assert.equal(readInside(root, 'src/a.ts', 1000).toString(), 'export const a = 1;');
});

test('blocks .. traversal and absolute paths outside', () => {
  assert.throws(() => resolveInside(root, '../outside/secret.txt'), SandboxError);
  assert.throws(() => resolveInside(root, path.join(outside, 'secret.txt')), SandboxError);
  assert.throws(() => resolveInside(root, 'src/../../outside'), SandboxError);
});

test('blocks symlinks that point outside', { skip: symlinksWork }, () => {
  assert.throws(() => resolveInside(root, 'link'), SandboxError);
  assert.throws(() => readInside(root, 'src/stolen.ts', 1000), SandboxError);
});

test('rejects null bytes, empty paths and oversized files', () => {
  assert.throws(() => resolveInside(root, 'src/a.ts\0.png'), SandboxError);
  assert.throws(() => resolveInside(root, ''), SandboxError);
  assert.throws(() => readInside(root, 'src/a.ts', 5), SandboxError);
});

test('refuses to read sensitive files', () => {
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1');
  assert.throws(() => readInside(root, '.env', 1000), SandboxError);
  assert.ok(isSensitivePath('config/.env.local'));
  assert.ok(isSensitivePath('keys/server.pem'));
  assert.ok(isSensitivePath('src/secrets.ts'));
  assert.ok(!isSensitivePath('src/utils/date.ts'));
});

test('refuses filesystem root and home directory as workspace', () => {
  assert.throws(() => resolveWorkspaceRoot(path.parse(process.cwd()).root), SandboxError);
  assert.throws(() => resolveWorkspaceRoot(os.homedir()), SandboxError);
  assert.throws(() => resolveWorkspaceRoot(path.join(base, 'missing')), SandboxError);
  assert.equal(resolveWorkspaceRoot(root), fs.realpathSync.native(root));
});

test('does not hang on a FIFO named like a source file', { skip: process.platform === 'win32', timeout: 5000 }, () => {
  execFileSync('mkfifo', [path.join(root, 'pipe.ts')]);
  assert.throws(() => readInside(root, 'pipe.ts', 1000), SandboxError);
});

test('blocks a symlink that points at a sensitive file inside the workspace', { skip: symlinksWork }, () => {
  fs.writeFileSync(path.join(root, '.env'), 'KEY=supersecret');
  fs.symlinkSync('.env', path.join(root, 'harmless.ts'));
  assert.throws(() => readInside(root, 'harmless.ts', 1000), SandboxError);
});

test('gives the same answer for missing and existing paths outside the workspace', () => {
  const message = (target: string) => {
    try {
      resolveInside(root, target);
    } catch (err) {
      return (err as Error).message.replace(target, '');
    }
    return '';
  };
  assert.equal(message('../outside/secret.txt'), message('../outside/does-not-exist'));
});

test('survives symlink loops and odd path forms', { skip: symlinksWork }, () => {
  fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
  fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
  assert.throws(() => resolveInside(root, 'loop-a'), SandboxError);
  assert.throws(() => resolveInside(root, 'x'.repeat(5000)), SandboxError);
  assert.throws(() => resolveInside(root, 'src/../../project-evil'), SandboxError);
  assert.equal(resolveInside(root, 'src/'), fs.realpathSync.native(path.join(root, 'src')));
});

test('refuses the parent of the home directory', () => {
  assert.throws(() => resolveWorkspaceRoot(path.dirname(os.homedir())), SandboxError);
});
