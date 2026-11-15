import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error the script is plain JavaScript without declarations
import { REQUIRED, evidenceProblems, parseTap } from '../scripts/assert-windows-evidence.mjs';

// The gate that stops a skipped Windows test from counting as Windows evidence. It runs on every platform, on sample TAP text.

const tap = (lines: string[]): string => `TAP version 13\n${lines.join('\n')}\n1..${lines.length}\n`;
const allOk = (): string[] => (REQUIRED as string[]).map((name, i) => `ok ${i + 1} - ${name}`);

test('every required test ran and passed: no problems', () => {
  assert.deepEqual(evidenceProblems(tap(allOk())), []);
});

test('a skipped required test is a problem, however it is worded', () => {
  const lines = allOk();
  lines[2] += ' # SKIP the process tree behaviour under test is specific to Windows';
  assert.deepEqual(evidenceProblems(tap(lines)), [`was skipped: ${(REQUIRED as string[])[2]}`]);
});

test('a TODO directive does not count as a pass either', () => {
  const lines = allOk();
  lines[0] += ' # TODO later';
  assert.equal(evidenceProblems(tap(lines)).length, 1);
});

test('a required test that never appeared is a problem', () => {
  assert.deepEqual(evidenceProblems(tap(allOk().slice(1))), [`did not run at all: ${(REQUIRED as string[])[0]}`]);
});

test('a failing required test, and a failing test of the same files, are problems', () => {
  const lines = allOk();
  lines[4] = `not ok 5 - ${(REQUIRED as string[])[4]}`;
  lines.push('not ok 99 - some other test in those files');
  assert.deepEqual(evidenceProblems(tap(lines)), [`failed: ${(REQUIRED as string[])[4]}`, 'failed: some other test in those files']);
});

test('an empty or unrelated stream proves nothing', () => {
  assert.equal(evidenceProblems('').length, REQUIRED.length);
  assert.equal(evidenceProblems(tap(['ok 1 - something unrelated'])).length, REQUIRED.length);
});

test('the parser reads names with # inside them and CRLF line ends', () => {
  const parsed = parseTap('ok 1 - a # b\r\nok 2 - c # SKIP why\r\nnot ok 3 - d\r\n');
  assert.deepEqual(parsed, [
    { name: 'a # b', ok: true, directive: null },
    { name: 'c', ok: true, directive: 'SKIP' },
    { name: 'd', ok: false, directive: null },
  ]);
});

test('every required name exists in the Windows test files, so the gate cannot require a test that was renamed away', async () => {
  const { readFileSync } = await import('node:fs');
  const source = ['test/process-safety-windows.test.ts', 'test/cache-key-windows.test.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const name of REQUIRED as string[]) {
    const literal = name.replace(/^when taskkill is (missing|hung),/, 'when taskkill is ${mode},');
    assert.ok(source.includes(literal) || source.includes(name), `no test is named: ${name}`);
  }
});
