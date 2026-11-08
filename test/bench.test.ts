import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Run through the current Node with the tsx loader: node_modules/.bin/tsx is a .cmd shim on Windows and cannot be spawned directly.
const tsx = process.execPath;
const loader = ['--import', 'tsx'];
const leftovers = (): string[] => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('guardian-bench'));

test('the benchmark reports peak memory, is deterministic in what it measures, and removes its temporary directories', () => {
  const before = new Set(leftovers());
  const run = () => spawnSync(tsx, [...loader, 'bench/run.ts', '--files', '30', '--runs', '2', '--json'], { encoding: 'utf8', timeout: 120_000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const a = JSON.parse(first.stdout);

  assert.equal(a.files, 30);
  assert.equal(a.runs, 2);
  assert.equal(typeof a.peakRssMB, 'number');
  assert.ok(a.peakRssMB >= a.startRssMB, 'peak memory can never be below the starting size');
  assert.match(a.indexCold, /^\d+ ms \(min \d+, max \d+\)$/);

  const second = JSON.parse(run().stdout);
  for (const key of ['files', 'complete', 'findings', 'validateChangedFiles', 'validatePartial', 'retrievalRecall', 'retrievalPrecision']) {
    assert.deepEqual(second[key], a[key], `${key} must not vary between runs`);
  }
  assert.deepEqual(leftovers().filter((d) => !before.has(d)), [], 'temporary benchmark directories must be removed');
});

test('benchmarking a directory leaves it untouched: no cache, no modified files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-test-bench-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.c', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x'], { cwd: dir });
    const run = spawnSync(tsx, [...loader, 'bench/run.ts', '--root', dir, '--runs', '1', '--json'], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(path.join(dir, '.guardian')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
