// Reproducible measurements: node --import tsx bench/run.ts [--root <dir>] [--runs <n>] [--files <n>] [--json]
// Without --root it builds a deterministic synthetic repository (fixed contents, fixed commit hash) so numbers can be
// compared between machines and runs. Timings are the median of --runs runs (default 3) with the range; memory is the
// peak resident set size of the process as reported by the operating system.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { retrieve } from '../src/core/prompt/relevance.js';
import { validateProject } from '../src/core/validation/delta.js';
import { createContext } from '../src/context.js';
import { closeDb } from '../src/db/client.js';
import { fixtures } from '../test/fixtures/projects.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const rootArg = option('--root');
const runs = Math.max(1, Math.min(10, Number(option('--runs') ?? 3)));
const syntheticFiles = Math.max(10, Math.min(20000, Number(option('--files') ?? 2000)));
const asJson = args.includes('--json');

// Every directory this script creates is removed on exit, on an error, and on Ctrl-C. The repository under test is
// never touched: it is copied first, so the cold-start measurement, the modified files of the validation measurement
// and the `.guardian` cache all live in the copy.
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

// Fixed identity and dates make the synthetic repository's commit hash identical on every run and machine.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@e.c', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'b@e.c', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (cwd: string, ...gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function synthetic(files: number): string {
  const root = temp('guardian-bench-');
  for (let i = 0; i < files; i++) {
    const dir = path.join(root, 'src', `m${i % 20}`);
    fs.mkdirSync(dir, { recursive: true });
    const imports = i > 0 ? `import { fn${i - 1} } from '../m${(i - 1) % 20}/f${i - 1}';\n` : '';
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `${imports}export function fn${i}(x: number) {\n  const y = x * ${i} + 1;\n  return y > 10 ? y : ${i > 0 ? `fn${i - 1}(y)` : 'y'};\n}\nexport const unusedConst${i} = ${i};\n`);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'bench');
  return root;
}

// A throwaway copy of the project under test: tracked files at HEAD for a git repository, otherwise a plain copy.
function workingCopy(source: string): string {
  const dir = temp('guardian-bench-copy-');
  if (fs.existsSync(path.join(source, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    git(os.tmpdir(), 'clone', '-q', '--local', '--no-hardlinks', source, dir);
    tempDirs.push(dir);
  } else {
    fs.cpSync(source, dir, { recursive: true, filter: (from) => !/(^|[\\/])(node_modules|\.git|\.guardian)([\\/]|$)/.test(path.relative(source, from)) });
  }
  return dir;
}

const time = async <T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> => {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
};

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const spread = (values: number[]): string => `${median(values)} ms (min ${Math.min(...values)}, max ${Math.max(...values)})`;

// Peak resident set size of this whole process so far, from the operating system, not the size at the moment of asking.
const peakRssMB = (): number => Math.round(process.resourceUsage().maxRSS / 1024);

const source = rootArg ? path.resolve(rootArg) : synthetic(syntheticFiles);
const startRssMB = peakRssMB();
const results: Record<string, unknown> = {
  root: rootArg ? source : `synthetic (${syntheticFiles} files)`,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: `${os.cpus()[0]?.model.trim() ?? 'unknown'} x${os.cpus().length}`,
  runs,
};

const samples = { cold: [] as number[], warm: [] as number[], analyze: [] as number[], retrieval: [] as number[], validate: [] as number[] };
const queries = ['format a date', 'parse the configuration file', 'validate user input', 'send an http request', 'cache the result'];

for (let run = 0; run < runs; run++) {
  const work = workingCopy(source);
  const ctx = createContext(work);
  try {
    const cold = await time(() => indexProject(ctx));
    const project = cold.value;
    const warm = await time(() => indexProject(ctx));
    const analysis = await time(() => analyzeProject(project, ctx.config));
    const retrieval = await time(() => queries.map((q) => retrieve(project.files, analysis.value.graph, q)));
    samples.cold.push(cold.ms);
    samples.warm.push(warm.ms);
    samples.analyze.push(analysis.ms);
    samples.retrieval.push(retrieval.ms / queries.length);

    if (run === 0) {
      results.files = project.files.length;
      results.complete = project.complete;
      results.findings = analysis.value.findings.length;
    }

    if (fs.existsSync(path.join(work, '.git'))) {
      const touched = project.files.slice(0, Math.min(25, project.files.length)).map((f) => f.path);
      for (const [i, p] of touched.entries()) fs.appendFileSync(path.join(work, p), `\nexport const benchTouched${i} = ${i};\n`);
      const reindexed = await indexProject(ctx);
      const validation = await time(() => validateProject(ctx, reindexed));
      samples.validate.push(validation.ms);
      if (run === 0) {
        results.validateChangedFiles = validation.value.validation.changes.length;
        results.validatePartial = validation.value.validation.partial;
      }
    }
  } finally {
    closeDb(ctx.db);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

results.indexCold = spread(samples.cold);
results.indexWarm = spread(samples.warm);
results.analyze = spread(samples.analyze);
results.retrievalPerQuery = `${Math.round(median(samples.retrieval) * 10) / 10} ms`;
if (samples.validate.length > 0) results.validate25Changed = spread(samples.validate);
results.startRssMB = startRssMB;
results.peakRssMB = peakRssMB();

// Retrieval quality on the labelled fixtures: did the right symbol come back, and how much else came with it?
const labelled: { fixture: string; query: string; want: string }[] = [
  { fixture: 'small TypeScript project', query: 'format a date for display', want: 'formatDate' },
  { fixture: 'small TypeScript project', query: 'run the helper', want: 'helper' },
  { fixture: 'monorepo with workspace packages', query: 'render a button', want: 'Button' },
  { fixture: 'monorepo with workspace packages', query: 'add two numbers', want: 'sum' },
  { fixture: 'Next.js application', query: 'greet a visitor', want: 'greet' },
  { fixture: 'Python package', query: 'make a url slug from text', want: 'slugify' },
];
let hits = 0;
let returned = 0;
let relevantReturned = 0;
const noise: string[] = [];
for (const item of labelled) {
  const fixture = fixtures.find((f) => f.name === item.fixture);
  if (!fixture) continue;
  const dir = temp('guardian-bench-q-');
  for (const [rel, content] of Object.entries(fixture.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const c = createContext(dir);
  try {
    const p = await indexProject(c);
    const found = retrieve(p.files, analyzeProject(p, c.config).graph, item.query).symbols;
    returned += found.length;
    if (found.some((s) => s.sym.name === item.want)) {
      hits++;
      relevantReturned++;
    } else noise.push(`${item.query} -> missed ${item.want}`);
  } finally {
    closeDb(c.db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
results.retrievalRecall = `${hits}/${labelled.length}`;
results.retrievalPrecision = returned === 0 ? 'n/a' : `${relevantReturned}/${returned} returned symbols were the wanted one`;
if (noise.length) results.retrievalMisses = noise;

console.log(asJson ? JSON.stringify(results, null, 2) : Object.entries(results).map(([k, v]) => `${k.padEnd(24)} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
