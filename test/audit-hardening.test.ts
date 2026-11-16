import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SandboxError, isSensitivePath, resolveWorkspaceRoot } from '../src/core/security/sandbox.js';

test('credential files without a conventional extension are treated as sensitive', () => {
  for (const name of ['.aws/credentials', 'home/.git-credentials', 'infra/prod.tfvars', 'infra/terraform.tfstate', 'vault.kdbx', '.pgpass', '.htpasswd', '.dockercfg']) {
    assert.ok(isSensitivePath(name), name);
  }
  for (const name of ['src/utils/date.ts', 'src/keys.ts', 'README.md', 'src/credentials-helper-docs.md']) {
    assert.ok(!isSensitivePath(name), name);
  }
});

test('a project directory is still accepted as the workspace', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-root-')));
  try {
    assert.equal(resolveWorkspaceRoot(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a system directory is refused as the workspace', { skip: process.platform === 'win32' || !fs.existsSync('/etc') }, () => {
  assert.throws(() => resolveWorkspaceRoot('/etc'), SandboxError);
});

test('canonical system directory aliases are refused as the workspace', { skip: process.platform !== 'darwin' || !fs.existsSync('/private/etc') }, () => {
  assert.throws(() => resolveWorkspaceRoot('/private/etc'), SandboxError);
});

test('the key and credential folders of the home directory are refused, including everything below them', { skip: process.platform === 'win32' }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-home-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    fs.mkdirSync(path.join(home, '.ssh', 'project'), { recursive: true });
    fs.mkdirSync(path.join(home, 'work', 'app'), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.throws(() => resolveWorkspaceRoot(path.join(home, '.ssh')), SandboxError);
    assert.throws(() => resolveWorkspaceRoot(path.join(home, '.ssh', 'project')), SandboxError);
    assert.equal(resolveWorkspaceRoot(path.join(home, 'work', 'app')), path.join(home, 'work', 'app'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
