
// Proves the published package works: npm pack, install the tarball into a clean project, install it globally into a
// throwaway prefix, and run the CLI from both. Works on Linux, macOS and Windows: node scripts/pack-smoke.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const npm =
  process.platform === 'win32'
    ? path.join(
        path.dirname(process.execPath),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      )
    : 'npm';

const run = (cmd, args, cwd, env = {}) => {
  const options = {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  // On Windows, invoke npm's JavaScript CLI directly instead of npm.cmd.
  if (process.platform === 'win32' && cmd === npm) {
    return execFileSync(process.execPath, [npm, ...args], options);
  }

  // Execute packaged JavaScript CLI entry points through Node.
  if (cmd.endsWith('.js')) {
    return execFileSync(process.execPath, [cmd, ...args], options);
  }

  return execFileSync(cmd, args, options);
};

const repo = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-pack-'));
const failures = [];

const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(
      `FAIL ${name}: ${(err.stderr || err.message || '')
        .toString()
        .split('\n')
        .slice(0, 4)
        .join(' | ')}`,
    );
  }
};

// 1. What ends up in the tarball
const packed = JSON.parse(
  run(npm, ['pack', '--json', '--pack-destination', tmp], repo),
);

const tarball = path.join(tmp, packed[0].filename);
const files = packed[0].files.map((f) => f.path);

check('tarball contains LICENSE, README, bin and dist', () => {
  for (const need of [
    'LICENSE',
    'README.md',
    'bin/cli.js',
    'dist/cli/index.js',
  ]) {
    if (!files.includes(need)) {
      throw new Error(`missing ${need}`);
    }
  }
});

check('tarball contains no tests, sources, caches or secrets', () => {
  const bad = files.filter(
    (f) =>
      /^(test|src|bench|scripts|\.guardian)\//.test(f) ||
      /(^|\/)\.env$/.test(f) ||
      /\.test\./.test(f),
  );

  if (bad.length) {
    throw new Error(`unexpected files: ${bad.slice(0, 5).join(', ')}`);
  }
});

// 2. Create a sample project to scan
const project = path.join(tmp, 'project');

fs.mkdirSync(path.join(project, 'src'), { recursive: true });

fs.writeFileSync(
  path.join(project, 'src', 'a.ts'),
  'export const a = 1;\n',
);

fs.writeFileSync(
  path.join(project, 'src', 'main.ts'),
  "import { a } from './a';\nconsole.log(a);\n",
);

// 3. Clean local install
const consumer = path.join(tmp, 'consumer');

fs.mkdirSync(consumer);

fs.writeFileSync(
  path.join(consumer, 'package.json'),
  '{"name":"consumer","private":true}',
);

check('clean install of the tarball', () =>
  run(npm, ['install', '--no-audit', '--no-fund', tarball], consumer),
);

const localBin = path.join(
  consumer,
  'node_modules',
  'code-guardian-ai',
  'bin',
  'cli.js',
);

if (process.platform === 'win32') {
  check('Windows CLI launcher exists', () => {
    const launcher = path.join(
      consumer,
      'node_modules',
      '.bin',
      'guardian.cmd',
    );

    if (!fs.existsSync(launcher)) {
      throw new Error('guardian.cmd was not generated');
    }
  });
}

check('installed CLI: doctor', () =>
  run(localBin, ['doctor'], project),
);

check('installed CLI: scan', () => {
  const out = run(localBin, ['scan', '--root', project], project);

  if (!/scan|file/i.test(out)) {
    throw new Error('unexpected scan output');
  }
});

check('installed CLI: find', () =>
  run(localBin, ['find', '--root', project, 'a constant'], project),
);

check('installed CLI: usage error exits with 2', () => {
  try {
    run(localBin, ['no-such-command'], project);
  } catch (err) {
    if (err.status === 2) return;
    throw new Error(`exit code ${err.status}`);
  }

  throw new Error('expected a non-zero exit');
});

// 4. Global install into a throwaway prefix
const prefix = path.join(tmp, 'global');

check('global install (--prefix)', () =>
  run(
    npm,
    [
      'install',
      '-g',
      '--no-audit',
      '--no-fund',
      '--prefix',
      prefix,
      tarball,
    ],
    tmp,
  ),
);

const globalRoot = run(
  npm,
  ['root', '-g', '--prefix', prefix],
  tmp,
).trim();

const globalBin = path.join(
  globalRoot,
  'code-guardian-ai',
  'bin',
  'cli.js',
);

if (!fs.existsSync(globalBin)) {
  throw new Error(`global CLI entry point not found: ${globalBin}`);
}

if (process.platform === 'win32') {
  check('Global Windows CLI launcher exists', () => {
    const launcher = path.join(prefix, 'guardian.cmd');

    if (!fs.existsSync(launcher)) {
      throw new Error('global guardian.cmd was not generated');
    }
  });
}

check('global CLI: doctor and scan', () => {
  run(globalBin, ['doctor'], project);
  run(globalBin, ['scan', '--root', project], project);
});

// 5. Cleanup and report
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(
    `\n${failures.length} check(s) failed on ${process.platform}`,
  );
  process.exit(1);
}

console.log(
  `\npackage verified on ${process.platform}-${process.arch}, node ${process.version}`,
);
