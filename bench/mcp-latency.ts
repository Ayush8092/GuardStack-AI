// Two different things are measured here, and the output keeps them apart.
//
//   1. INTERNAL WORKFLOW (default). The functions the MCP tools call (discovery, indexing with parsing, graph construction and
//      analysis, context building, validation, output masking), run in-process, with the longest event-loop stall of each
//      phase. This is NOT MCP protocol performance: no request is framed, serialized or dispatched.
//   2. MCP PROTOCOL, IN-MEMORY TRANSPORT (--transport). The same tool calls made through the real server and the SDK client
//      over a linked in-memory transport: request validation, dispatch, result serialization and concurrent requests
//      are included. It does NOT include stdio framing, a separate process, or a network, so it is still not an end-to-end
//      client latency. Functional checks of the protocol (cancellation, concurrency) are in test/mcp-transport.test.ts.
//
//   node --import tsx bench/mcp-latency.ts [--sizes 500,2000,5000] [--runs 5] [--threshold 50] [--root <dir>] [--transport] [--json]
//
// Every run starts from a fresh copy of the repository with an empty cache (cold), then repeats on the same copy (warm). Results
// are reported as median and p95 over --runs runs; with fewer than 20 runs the p95 is simply close to the maximum. The
// synthetic repositories are generated deterministically (no randomness), so two machines measure the same input. Nothing outside the
// temporary directories is modified: --root is copied first. Temporary directories, database handles, timers and the MCP
// connection are released in `finally` blocks, including when a phase throws.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { walk } from '../src/core/ast/discovery.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { buildContext } from '../src/core/prompt/compressor.js';
import { maskSecrets } from '../src/core/security/masker.js';
import { validateProject } from '../src/core/validation/delta.js';
import { createContext, type Ctx } from '../src/context.js';
import { closeDb } from '../src/db/client.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sizes = (option('--sizes') ?? '500,2000,5000').split(',').map((n) => Math.max(10, Math.min(20_000, Number(n)))).filter(Number.isFinite);
const runs = Math.max(1, Math.min(30, Number(option('--runs') ?? 5)));
const threshold = Math.max(1, Number(option('--threshold') ?? 50));
const rootArg = option('--root');
const withTransport = args.includes('--transport');
const asJson = args.includes('--json');

const tempDirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
const cleanup = (): void => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@e.c', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'b@e.c', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (cwd: string, ...gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (root: string): void => {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'bench');
};

// A chain of modules that import each other, so the graph and the analysis have real work. Deterministic.
function synthetic(count: number): string {
  const root = temp('guardian-bench-mcp-');
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, 'src', `m${i % 20}`);
    fs.mkdirSync(dir, { recursive: true });
    const imports = i > 0 ? `import { fn${i - 1} } from '../m${(i - 1) % 20}/f${i - 1}';\n` : '';
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `${imports}export function fn${i}(x: number) {\n  const y = x * ${i} + 1;\n  return y > 10 ? y : ${i > 0 ? `fn${i - 1}(y)` : 'y'};\n}\nexport const unusedConst${i} = ${i};\n`);
  }
  commit(root);
  return root;
}

// One source file just under the default maxFileKb (512 KB). Parsing it is a single synchronous call that no amount of
// yielding between files can split, so this is the case that would justify a worker thread if anything does.
function largestFile(): string {
  const root = temp('guardian-bench-mcp-big-');
  const parts: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < 500 * 1024; i++) {
    const part = `export function big${i}(a: number, b: number) {\n  const s = a * ${i} + b;\n  if (s > ${i}) { return [s, a, b].map((n) => n + ${i}).filter(Boolean); }\n  return [];\n}\n`;
    parts.push(part);
    bytes += part.length;
  }
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'big.ts'), parts.join(''));
  commit(root);
  return root;
}

function copyOf(source: string): string {
  const dir = temp('guardian-bench-mcp-copy-');
  fs.cpSync(source, dir, { recursive: true, filter: (from) => !/(^|[\\/])(node_modules|\.guardian)([\\/]|$)/.test(path.relative(source, from)) });
  return dir;
}

// Runs `work` and returns its duration and the longest time the event loop went without servicing a 1 ms timer while it ran.
async function measure<T>(work: () => Promise<T> | T): Promise<{ value: T; totalMs: number; maxStallMs: number }> {
  let last = performance.now();
  let stall = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 1);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    last = performance.now();
    stall = 0;
    const start = performance.now();
    const value = await work();
    const totalMs = performance.now() - start;
    await new Promise((resolve) => setImmediate(resolve));
    return { value, totalMs, maxStallMs: Math.max(stall, performance.now() - last) };
  } finally {
    clearInterval(probe);
  }
}

type Samples = { totals: number[]; stalls: number[] };
const phases = new Map<string, Samples>();
const order: string[] = [];
const record = (name: string, m: { totalMs: number; maxStallMs: number }): void => {
  if (!phases.has(name)) {
    phases.set(name, { totals: [], stalls: [] });
    order.push(name);
  }
  phases.get(name)?.totals.push(m.totalMs);
  phases.get(name)?.stalls.push(m.maxStallMs);
};
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const median = (xs: number[]): number => sorted(xs)[Math.floor((xs.length - 1) / 2)] as number;
const p95 = (xs: number[]): number => sorted(xs)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)] as number;
const round = (n: number): number => Math.round(n * 10) / 10;

async function internalWorkflow(source: string, label: string, withValidation: boolean): Promise<void> {
  const work = copyOf(source);
  let ctx: Ctx | undefined;
  try {
    ctx = createContext(work);
    const c = ctx;
    const env = { root: c.root, ignores: (rel: string) => /(^|\/)(node_modules|\.git|\.guardian)\//.test(rel), maxBytes: c.config.maxFileKb * 1024, isTsConfig: (n: string) => /^tsconfig/.test(n), isSensitive: () => false };
    const tag = (name: string): string => `[internal] ${label}: ${name}`;

    record(tag('discovery only'), await measure(() => walk(env, { maxEntries: c.config.maxDiscoveryEntries, maxMs: c.config.maxDiscoveryMs })));
    const cold = await measure(() => indexProject(c));
    record(tag('index, cold cache (read, hash, parse, cache write)'), cold);
    const warm = await measure(() => indexProject(c));
    record(tag('index, warm cache'), warm);
    const analysis = await measure(() => analyzeProject(warm.value, c.config));
    record(tag('analyze (graph construction and rules)'), analysis);
    record(tag('build context (retrieval and packing)'), await measure(() => buildContext(warm.value, analysis.value.graph, { query: 'parse the configuration file', paths: [], budgetTokens: c.config.contextTokens })));

    const toolCall = async (): Promise<string> => {
      const p = await indexProject(c);
      const { graph } = analyzeProject(p, c.config);
      return maskSecrets(buildContext(p, graph, { query: 'format a date', paths: [], budgetTokens: c.config.contextTokens }).text).text;
    };
    // The whole tool body as an MCP request runs it. The cache is already warm from the phases above; the cold case is the index row.
    record(tag('get_codebase_context body, warm cache'), await measure(toolCall));

    if (withValidation) {
      for (const [i, f] of warm.value.files.slice(0, Math.min(25, warm.value.files.length)).entries()) fs.appendFileSync(path.join(work, f.path), `\nexport const benchTouched${i} = ${i};\n`);
      record(tag('validate_rules body (25 changed files)'), await measure(async () => {
        const p = await indexProject(c);
        const { validation } = await validateProject(c, p, {});
        return maskSecrets(JSON.stringify(validation.changes)).text;
      }));
    }
  } finally {
    if (ctx) closeDb(ctx.db);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The same tool calls through the real MCP server and the SDK client, over a linked in-memory transport.
async function protocolWorkflow(source: string, label: string): Promise<void> {
  const [{ Client }, { InMemoryTransport }, { createServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
    import('../src/mcp/server.js'),
  ]);
  const work = copyOf(source);
  let ctx: Ctx | undefined;
  let client: InstanceType<typeof Client> | undefined;
  try {
    ctx = createContext(work);
    const server = createServer(ctx, 'bench');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'bench-client', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const c = client;
    const tag = (name: string): string => `[mcp in-memory transport] ${label}: ${name}`;
    const ask = (name: string, toolArgs: Record<string, unknown>) => (): Promise<unknown> => c.callTool({ name, arguments: toolArgs });

    record(tag('get_codebase_context request, cold cache'), await measure(ask('get_codebase_context', { query: 'format a date' })));
    record(tag('get_codebase_context request, warm cache'), await measure(ask('get_codebase_context', { query: 'format a date' })));
    record(tag('find_reusable_code request, warm cache'), await measure(ask('find_reusable_code', { query: 'format a date' })));
    record(tag('4 concurrent get_codebase_context requests, warm cache (total for all four)'), await measure(() => Promise.all(Array.from({ length: 4 }, () => ask('get_codebase_context', { query: 'format a date' })()))));
    record(tag('listTools while a get_codebase_context request is running (time to answer listTools)'), await measure(async () => {
      const running = ask('get_codebase_context', { query: 'format a date' })();
      const t = performance.now();
      await c.listTools();
      const answered = performance.now() - t;
      await running;
      return answered;
    }));
  } finally {
    await client?.close().catch(() => undefined);
    if (ctx) closeDb(ctx.db);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const sources: { label: string; root: string; validate: boolean }[] = rootArg
  ? [{ label: 'project', root: path.resolve(rootArg), validate: fs.existsSync(path.join(path.resolve(rootArg), '.git')) }]
  : sizes.map((n) => ({ label: `${n} files`, root: synthetic(n), validate: true }));
sources.push({ label: 'one 500 KB file', root: largestFile(), validate: false });

try {
  for (let run = 0; run < runs; run++) {
    for (const s of sources) {
      await internalWorkflow(s.root, s.label, s.validate);
      if (withTransport && s.label !== 'one 500 KB file') await protocolWorkflow(s.root, s.label);
    }
  }
} finally {
  cleanup();
}

const read = (): string => {
  try {
    return git(path.resolve(import.meta.dirname, '..'), 'rev-parse', '--short', 'HEAD').trim();
  } catch {
    return 'not a git checkout';
  }
};
const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
const rows = order.map((phase) => {
  const s = phases.get(phase) as Samples;
  return { phase, runs: s.totals.length, medianMs: round(median(s.totals)), p95Ms: round(p95(s.totals)), medianStallMs: round(median(s.stalls)), p95StallMs: round(p95(s.stalls)), overThreshold: p95(s.stalls) > threshold };
});
const environment = {
  package: `code-guardian-ai ${pkg.version} (${read()})`,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: `${os.cpus()[0]?.model.trim() ?? 'unknown'} x${os.cpus().length}`,
  memoryGb: round(os.totalmem() / 1024 ** 3),
  repositories: rootArg ? 'project (copied)' : `synthetic, deterministic: ${sizes.join(', ')} files, plus one 500 KB file`,
  runs,
  stallThresholdMs: threshold,
  kinds: withTransport ? ['internal workflow', 'mcp in-memory transport (not stdio, not a separate process)'] : ['internal workflow only: not MCP protocol performance'],
};
const needsAttention = rows.filter((r) => r.overThreshold).map((r) => r.phase);

if (asJson) console.log(JSON.stringify({ environment, rows, needsAttention }, null, 2));
else {
  console.log(JSON.stringify(environment, null, 2));
  console.log('\n' + 'phase'.padEnd(110) + 'median'.padStart(10) + 'p95'.padStart(10) + 'stall med'.padStart(11) + 'stall p95'.padStart(11) + '  over?');
  for (const r of rows) console.log(r.phase.padEnd(110) + `${r.medianMs}`.padStart(10) + `${r.p95Ms}`.padStart(10) + `${r.medianStallMs}`.padStart(11) + `${r.p95StallMs}`.padStart(11) + (r.overThreshold ? '  YES' : '  no'));
  console.log('\nTimes are milliseconds. "stall" is the longest gap in event-loop timer service during the phase.');
  console.log(needsAttention.length === 0 ? `No phase had a p95 stall above ${threshold} ms over ${runs} run(s): these numbers do not justify yielding or workers.` : `${needsAttention.length} phase(s) had a p95 stall above ${threshold} ms: only these are candidates for yielding.`);
  if (!withTransport) console.log('Re-run with --transport to include requests made through the MCP server and client (in-memory transport).');
}
