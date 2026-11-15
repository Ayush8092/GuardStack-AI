
// Proves the published package works: npm pack, install the tarball into a clean project, install it globally into a
// throwaway prefix, and run the CLI from both. The installed MCP server is also started as a real process and driven over
// stdin/stdout (scripts/mcp-stdio-smoke.mjs). Works on Linux, macOS and Windows: node scripts/pack-smoke.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkOutput, verifyDist } from './dist-integrity.mjs';
import { runMcpStdioSmoke } from './mcp-stdio-smoke.mjs';

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
// A lifecycle script (prepack verifies dist/) may print its own header lines before the JSON on stdout: parse from the array.
const packOutput = run(npm, ['pack', '--json', '--pack-destination', tmp], repo);
const packed = JSON.parse(packOutput.slice(Math.max(0, packOutput.search(/^\[/m))));

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

// The tarball is built from dist/, which is build output and not tracked: a stale dist ships old code. These two checks make
// that fail loudly instead of passing on whatever was built last. `npm run pack:smoke` rebuilds first; running this script on
// its own after editing a source file is exactly the case they catch.
const sourceRoot = path.join(repo, 'src');
const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []));

check('dist is not older than the source it was built from', () => {
  const stale = sourceFiles(sourceRoot).filter((file) => {
    const built = path.join(repo, 'dist', path.relative(sourceRoot, file).replace(/\.ts$/, '.js'));
    return !fs.existsSync(built) || fs.statSync(built).mtimeMs < fs.statSync(file).mtimeMs;
  });
  if (stale.length) throw new Error(`stale or missing build output for ${stale.length} file(s), run npm run build: ${stale.slice(0, 3).map((f) => path.relative(repo, f)).join(', ')}`);
});

// Content based, unlike the file-time check above: dist/ must record the hash of every current source file, hold output for every
// module, and contain the security implementations. The installed copy gets the checks that need no source next to it.
check('dist was built from exactly the current source (build manifest)', () => {
  const problems = verifyDist(repo);
  if (problems.length) throw new Error(`${problems.length} problem(s), run npm run build: ${problems.slice(0, 3).join('; ')}`);
});

check('the installed package is complete: every module, import, bin entry and security implementation', () => {
  const problems = checkOutput(path.join(consumer, 'node_modules', 'code-guardian-ai'));
  if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
});

check('the installed package contains the current safe-file implementation', () => {
  const source = fs.readFileSync(path.join(repo, 'src', 'core', 'security', 'safe-file.ts'), 'utf8');
  const installed = fs.readFileSync(path.join(consumer, 'node_modules', 'code-guardian-ai', 'dist', 'core', 'security', 'safe-file.js'), 'utf8');
  // Every exported function, class and constant of the source (this includes the Windows hard-link publication) must be in what was installed.
  const exported = [...source.matchAll(/^export (?:async )?(?:function|class|const) (\w+)/gm)].map((m) => m[1]);
  if (exported.length === 0) throw new Error('found no exports in src/core/security/safe-file.ts, the check itself is broken');
  const missing = exported.filter((name) => !new RegExp(`\\b${name}\\b`).test(installed));
  if (missing.length) throw new Error(`the installed safe-file.js lacks: ${missing.join(', ')}`);
});

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

// 3b. The MCP server of the installed package, as a client starts it: `guardian serve` as its own process, spoken to over real
// stdin/stdout. Nothing is imported from src/ and no in-memory transport is involved; the files that run are the installed ones.
{
  const installedRoot = path.join(consumer, 'node_modules', 'code-guardian-ai');
  const label = 'installed MCP server (stdio)';
  const mcpWorkspace = path.join(tmp, 'mcp-workspace');
  fs.mkdirSync(path.join(mcpWorkspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(mcpWorkspace, 'src', 'math.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(mcpWorkspace, 'src', 'main.ts'), "import { addNumbers } from './math';\nconsole.log(addNumbers(1, 2));\n");

  // A clean environment for the server: no credentials of the machine that runs the test, and a key directory of its own outside the
  // workspace (the cache key is created there, never in the real home). The most verbose logging is on purpose: all of it must
  // stay on stderr, because stdout is the protocol.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)));
  delete env.GUARDIAN_ROOT;
  delete env.GUARDIAN_ENV_FILE;
  env.GUARDIAN_LOG = 'debug';
  env.GUARDIAN_STATE_HOME = path.join(tmp, 'mcp-state');

  let reported = false;
  try {
    const installedVersion = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version;
    const { stderr } = await runMcpStdioSmoke({
      command: process.execPath,
      args: [path.join(installedRoot, 'bin', 'cli.js'), '--root', mcpWorkspace, 'serve'],
      cwd: mcpWorkspace,
      env,
      expectedServerName: 'codeguardian',
      expectedVersion: installedVersion,
      expectedTools: ['find_reusable_code', 'get_codebase_context', 'optimize_prompt', 'validate_rules'],
      tool: {
        name: 'get_codebase_context',
        arguments: { query: 'add numbers' },
        check: (text) => {
          if (!text.includes('src/math.ts') || !text.includes('function addNumbers(a: number, b: number): number')) {
            throw new Error(`the context does not list the function of the workspace: ${JSON.stringify(text.slice(0, 200))}`);
          }
        },
      },
      report: (name, err) => {
        reported = true;
        if (err) {
          failures.push(`${label}: ${name}`);
          console.log(`FAIL ${label}: ${name}: ${err.message.split('\n').slice(0, 8).join(' | ')}`);
        } else {
          console.log(`ok   ${label}: ${name}`);
        }
      },
    });
    // Positive control for the stdout check: the server did log, and the log went to the other stream.
    if (!/MCP server ready/.test(stderr)) {
      failures.push(`${label}: stderr control`);
      console.log(`FAIL ${label}: the server never logged "MCP server ready" to stderr, so the check that logs stay off stdout proved nothing`);
    } else {
      console.log(`ok   ${label}: the server's own log reached stderr`);
    }
  } catch (err) {
    // A failed step has been reported already; anything else (the process could not be started, the package.json is unreadable) has not.
    if (!reported || !failures.some((f) => f.startsWith(label))) {
      failures.push(`${label}: ${err.message}`);
      console.log(`FAIL ${label}: ${String(err.message).split('\n').slice(0, 4).join(' | ')}`);
    }
    console.log(`     the remaining ${label} steps were not run because an earlier one failed`);
  }
}

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
