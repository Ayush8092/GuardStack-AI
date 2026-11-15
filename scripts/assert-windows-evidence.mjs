// Windows evidence gate. The Windows-only tests (process-tree termination, ACL checks) are skipped on every other platform, and a
// skipped test is reported as a pass. This script reads the TAP output of those test files and fails unless every required test
// actually RAN and passed, so a green run on Windows cannot be a run in which they were skipped. It proves nothing on other
// platforms: it requires process.platform to be win32 unless --allow-non-windows is given (used only by its own unit test).
//
//   node --import tsx --test --test-reporter=tap test/process-safety-windows.test.ts test/cache-key-windows.test.ts > evidence.tap
//   node scripts/assert-windows-evidence.mjs evidence.tap

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUIRED = [
  'terminateGitChildren ends the git process and the process it started',
  'cancelling a request ends the git process and the process it started',
  'killing the tree leaves an unrelated process running',
  'a git call that ends normally leaves nothing for shutdown to kill, and nothing is started to kill it',
  'when taskkill is missing, cancelling still ends the launcher and releases the caller',
  'when taskkill is hung, cancelling still ends the launcher and releases the caller',
  'terminateGitChildren with nothing running does nothing on Windows either',
  'real Windows: a custom directory that is private to the user works',
  'real Windows: the standard user-local state directory works',
  'real Windows: a custom directory that Everyone can access is refused',
  'real Windows: an existing key that was opened up to Everyone is refused',
  'real Windows: a missing key is created with an ACL that passes the check',
  'real Windows: a state directory that does not exist and cannot be created falls back safely',
];

// Top-level result lines of a TAP stream: "ok 3 - name", "not ok 4 - name", with an optional "# SKIP ..." / "# TODO ..." directive.
export function parseTap(text) {
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (m) results.push({ name: m[2], ok: !m[1], directive: m[3] ?? null });
  }
  return results;
}

// The problems that make the evidence unusable; an empty list means every required test ran and passed.
export function evidenceProblems(text) {
  const results = parseTap(text);
  const problems = [];
  for (const name of REQUIRED) {
    const found = results.filter((r) => r.name === name);
    if (found.length === 0) problems.push(`did not run at all: ${name}`);
    else if (found.some((r) => r.directive !== null)) problems.push(`was skipped: ${name}`);
    else if (found.some((r) => !r.ok)) problems.push(`failed: ${name}`);
  }
  const failed = results.filter((r) => !r.ok && !REQUIRED.includes(r.name));
  for (const r of failed) problems.push(`failed: ${r.name}`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/assert-windows-evidence.mjs <tap-file> [--allow-non-windows]');
    process.exit(2);
  }
  if (process.platform !== 'win32' && !process.argv.includes('--allow-non-windows')) {
    console.error(`NOT RUN: this is ${process.platform}, not Windows. The Windows tests prove nothing here.`);
    process.exit(3);
  }
  const problems = evidenceProblems(fs.readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error(`Windows evidence is incomplete (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.error(`Windows evidence complete: ${REQUIRED.length} required tests ran and passed on ${process.platform}-${process.arch}, node ${process.version}`);
}
