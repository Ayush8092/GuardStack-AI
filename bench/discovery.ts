// Compares the previous synchronous directory walk with the bounded, yielding one, and measures how long the event loop
// was blocked while each ran (the time an MCP request would have waited). Needs no Tree-sitter or database:
//   tsx bench/discovery.ts [files=20000] [runs=5] [layout=tree|flat]
// `flat` puts every file in one directory: the case where listing and sorting a single huge directory is the whole job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { walk } from '../src/core/ast/discovery.js';

const files = Number(process.argv[2] ?? 20_000);
const runs = Number(process.argv[3] ?? 5);
const flat = (process.argv[4] ?? 'tree') === 'flat';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-bench-discovery-'));
for (let i = 0; i < files; i++) {
  const dir = flat ? root : path.join(root, `pkg${i % 40}`, `src${i % 25}`, `mod${i % 9}`);
  if (!flat && i < 40 * 25 * 9) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `f${i}.ts`), 'export const a = 1;\n');
}

// The walk as it was before: one synchronous pass over the whole tree.
function legacyWalk(): number {
  let found = 0;
  const pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(rel);
      else if (entry.isFile() && entry.name.endsWith('.ts') && fs.statSync(path.join(root, rel)).size > 0) found++;
    }
  }
  return found;
}

// Longest time the event loop went without running a timer while `work` ran.
async function measure<T>(work: () => Promise<T> | T): Promise<{ value: T; totalMs: number; maxStallMs: number }> {
  let last = performance.now();
  let maxStall = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - last);
    last = now;
  }, 1);
  await new Promise((r) => setTimeout(r, 5));
  last = performance.now();
  maxStall = 0;
  const start = performance.now();
  const value = await work();
  const totalMs = performance.now() - start;
  await new Promise((r) => setImmediate(r));
  maxStall = Math.max(maxStall, performance.now() - last);
  clearInterval(probe);
  return { value, totalMs, maxStallMs: maxStall };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const env = { root, ignores: () => false, maxBytes: 1 << 20, isTsConfig: () => false, isSensitive: () => false };
const unbounded = { maxEntries: Number.MAX_SAFE_INTEGER, maxMs: 600_000 };

const rows: Record<string, { total: number[]; stall: number[]; found: number; stopped?: string }> = {
  'before: synchronous walk': { total: [], stall: [], found: 0 },
  'after: yielding walk, no limit': { total: [], stall: [], found: 0 },
  'after: yielding walk, maxEntries=5000': { total: [], stall: [], found: 0 },
};

for (let run = 0; run < runs; run++) {
  const a = await measure(legacyWalk);
  rows['before: synchronous walk'].total.push(a.totalMs);
  rows['before: synchronous walk'].stall.push(a.maxStallMs);
  rows['before: synchronous walk'].found = a.value;

  const b = await measure(() => walk(env, unbounded));
  rows['after: yielding walk, no limit'].total.push(b.totalMs);
  rows['after: yielding walk, no limit'].stall.push(b.maxStallMs);
  rows['after: yielding walk, no limit'].found = b.value.eligible.length;

  const c = await measure(() => walk(env, { maxEntries: 5000, maxMs: 600_000 }));
  rows['after: yielding walk, maxEntries=5000'].total.push(c.totalMs);
  rows['after: yielding walk, maxEntries=5000'].stall.push(c.maxStallMs);
  rows['after: yielding walk, maxEntries=5000'].found = c.value.eligible.length;
  rows['after: yielding walk, maxEntries=5000'].stopped = c.value.stopped;
}

console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, cpu: `${os.cpus()[0]?.model.trim() ?? 'unknown'} x${os.cpus().length}`, files, runs, layout: flat ? 'flat' : 'tree' }, null, 2));
console.log('\n' + 'scenario'.padEnd(42) + 'files found'.padStart(12) + 'median total'.padStart(14) + 'median max stall'.padStart(18) + '  stopped');
for (const [name, r] of Object.entries(rows)) {
  console.log(name.padEnd(42) + String(r.found).padStart(12) + `${median(r.total).toFixed(0)} ms`.padStart(14) + `${median(r.stall).toFixed(1)} ms`.padStart(18) + `  ${r.stopped ?? '-'}`);
}
fs.rmSync(root, { recursive: true, force: true });
