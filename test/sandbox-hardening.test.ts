
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  SandboxError,
  readInside,
  readOptionalInside,
  resolveInside,
} from '../src/core/security/sandbox.js';
import { loadConfig } from '../src/utils/config.js';
import {
  directoryLinksWork,
  fileSymlinksWork,
  createDirectoryLink,
} from './helpers.js';

let base: string;
let root: string;
let outside: string;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-sbx2-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');

  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);

  fs.writeFileSync(
    path.join(root, 'sub', 'file.ts'),
    'export const inside = 1;\n',
  );
  fs.writeFileSync(
    path.join(outside, 'file.ts'),
    'export const stolen = 1;\n',
  );
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test(
  'a parent directory swapped for a symlink after the path check is caught',
  { skip: directoryLinksWork },
  () => {
    const sub = path.join(root, 'sub');
    const backup = path.join(root, 'sub.bak');

    try {
      assert.throws(
        () =>
          readInside(root, 'sub/file.ts', 1000, {
            afterResolve: () => {
              fs.renameSync(sub, backup);
              createDirectoryLink(outside, sub);
            },
          }),
        (err: unknown) =>
          err instanceof SandboxError && /changed|outside/.test(err.message),
      );
    } finally {
      if (fs.existsSync(sub)) {
        fs.rmSync(sub, { recursive: true, force: true });
      }

      if (fs.existsSync(backup)) {
        fs.renameSync(backup, sub);
      }
    }
  },
);

test(
  'swapping the file itself for a symlink after the path check is caught',
  { skip: fileSymlinksWork },
  () => {
    const file = path.join(root, 'sub', 'file.ts');

    try {
      assert.throws(
        () =>
          readInside(root, 'sub/file.ts', 1000, {
            afterResolve: () => {
              fs.rmSync(file);
              fs.symlinkSync(path.join(outside, 'file.ts'), file);
            },
          }),
        SandboxError,
      );
    } finally {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
      }

      fs.writeFileSync(file, 'export const inside = 1;\n');
    }
  },
);

test('an unchanged file still reads normally', () => {
  assert.equal(
    readInside(root, 'sub/file.ts', 1000).toString(),
    'export const inside = 1;\n',
  );
});

test('malicious path forms are rejected', () => {
  for (const bad of [
    '../outside/file.ts',
    'sub/../../outside/file.ts',
    '/etc/passwd',
    'sub/\0file.ts',
    '',
    'a'.repeat(5000),
  ]) {
    assert.throws(
      () => resolveInside(root, bad),
      SandboxError,
      JSON.stringify(bad).slice(0, 40),
    );
  }

  assert.throws(
    () => resolveInside(root, 'sub/missing.ts'),
    SandboxError,
  );
});

test(
  'a symlinked directory that leaves the workspace cannot be read through',
  { skip: directoryLinksWork },
  () => {
    const link = path.join(root, 'escape');
    createDirectoryLink(outside, link);

    try {
      assert.throws(
        () => readInside(root, 'escape/file.ts', 1000),
        SandboxError,
      );
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  },
);

test(
  'a symlink loop does not hang or leak',
  { skip: fileSymlinksWork },
  () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');

    try {
      fs.symlinkSync('b', a);
      fs.symlinkSync('a', b);

      assert.throws(
        () => readInside(root, 'a', 1000),
        SandboxError,
      );
    } finally {
      fs.rmSync(a, { force: true });
      fs.rmSync(b, { force: true });
    }
  },
);

test(
  '.guardianrc is read through the sandbox: absent means defaults, a symlink out is refused',
  { skip: fileSymlinksWork },
  () => {
    assert.equal(readOptionalInside(root, '.guardianrc', 1000), null);
    assert.equal(loadConfig(root).maxFiles, 5000);

    fs.writeFileSync(
      path.join(outside, 'rc.json'),
      JSON.stringify({ maxFiles: 1 }),
    );

    fs.symlinkSync(
      path.join(outside, 'rc.json'),
      path.join(root, '.guardianrc'),
    );

    assert.throws(() => loadConfig(root), SandboxError);
    fs.rmSync(path.join(root, '.guardianrc'));

    fs.writeFileSync(
      path.join(root, '.guardianrc'),
      JSON.stringify({ maxFiles: 7 }),
    );

    assert.equal(loadConfig(root).maxFiles, 7);

    fs.writeFileSync(path.join(root, '.guardianrc'), '{ nope');
    assert.throws(() => loadConfig(root), /not valid JSON/);

    fs.rmSync(path.join(root, '.guardianrc'));
  },
);
