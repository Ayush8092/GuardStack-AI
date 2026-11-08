import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Ctx } from '../src/context.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { resolvePolicy } from '../src/core/llm/policy.js';
import { refinePrompt } from '../src/core/prompt/refiner.js';
import { closeDb, openDb } from '../src/db/client.js';
import { reply } from '../src/mcp/tools/result.js';
import { symlinksWork } from './helpers.js';
import { SandboxError } from '../src/core/security/sandbox.js';
import { loadConfig } from '../src/utils/config.js';

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const cli = path.join(repo, 'src/cli/index.ts');
const dirs: string[] = [];

function workspace(files: Record<string, string | Buffer> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-hardening-')));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const context = (root: string): Ctx => ({ root, config: loadConfig(root), db: openDb(root) });

after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('malformed, binary and non-UTF8 files never break indexing', async () => {
  const root = workspace({
    'good.ts': 'export const good = 1;\n',
    'syntax.ts': 'export function ((( {{{ => ;;; import from',
    'binary.ts': Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x80, 0x81, 0x00, 0x00]),
    'latin1.py': Buffer.from('def caf\xe9(): pass\n', 'latin1'),
    'long.js': `export const x = "${'a'.repeat(100_000)}";\n`,
  });
  const ctx = context(root);
  const project = await indexProject(ctx);
  assert.ok(project.files.some((f) => f.path === 'good.ts'));
  assert.ok(Array.isArray(project.skipped));
  // A file with syntax errors is indexed but not fully understood, so it also keeps the scan from being called complete.
  assert.equal(project.complete, project.skipped.length === 0 && !project.truncated && project.parseIssues.length === 0);
  closeDb(ctx.db);
});

test('a corrupted cache row is re-parsed instead of failing the index', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const ctx = context(root);
  await indexProject(ctx);
  ctx.db.prepare("UPDATE files SET info = '{broken'").run();
  const project = await indexProject(ctx);
  assert.equal(project.files.length, 1);
  assert.equal(project.files[0].symbols[0].name, 'a');
  closeDb(ctx.db);
});

test('a corrupted cache.db is rebuilt', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  fs.mkdirSync(path.join(root, '.guardian'));
  fs.writeFileSync(path.join(root, '.guardian/cache.db'), 'this is not sqlite '.repeat(50));
  const ctx = context(root);
  assert.equal((await indexProject(ctx)).files.length, 1);
  assert.ok(fs.readFileSync(path.join(root, '.guardian/cache.db')).subarray(0, 15).toString() === 'SQLite format 3');
  closeDb(ctx.db);
});

test('falls back to an in-memory cache when .guardian is a file', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n', '.guardian': 'not a directory' });
  const ctx = context(root);
  assert.equal((await indexProject(ctx)).files.length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.guardian'), 'utf8'), 'not a directory');
  closeDb(ctx.db);
});

test('never writes through a .guardian symlink that leaves the workspace', { skip: symlinksWork }, async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  const elsewhere = workspace();
  fs.symlinkSync(elsewhere, path.join(root, '.guardian'));
  const ctx = context(root);
  assert.equal((await indexProject(ctx)).files.length, 1);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  closeDb(ctx.db);
});

test('falls back to memory in a read-only workspace', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n' });
  fs.chmodSync(root, 0o555);
  const ctx = context(root);
  assert.equal((await indexProject(ctx)).files.length, 1);
  closeDb(ctx.db);
  fs.chmodSync(root, 0o755);
});

test('parallel processes can share one cold cache without locking errors', { timeout: 90_000 }, async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/m${i}.ts`, `export const v${i} = ${i};\n`]));
  const root = workspace(files);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', cli, 'scan', '--json', '--root', root], { cwd: repo })),
  );
  for (const { stdout } of results) assert.equal(JSON.parse(stdout).files, 60);
});

test('tool errors become structured payloads and do not leak internals', async () => {
  const internal = await reply(async () => {
    throw new Error('ENOENT: /secret/path/internal.ts');
  });
  assert.equal(internal.isError, true);
  const body = JSON.parse((internal.content[0] as { text: string }).text);
  assert.equal(body.error.code, 'internal_error');
  assert.ok(!JSON.stringify(body).includes('/secret/path'));

  const known = await reply(async () => {
    throw new SandboxError('Path is outside the workspace: ../x');
  });
  assert.equal(JSON.parse((known.content[0] as { text: string }).text).error.code, 'invalid_path');
});

test('optimize falls back to local output when the LLM is off, keyless or failing', async () => {
  const root = workspace({ 'src/date.ts': 'export function formatDate(d: Date) { return d.toISOString(); }\n', 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n' });
  const ctx = context(root);
  const project = await indexProject(ctx);
  const { graph } = analyzeProject(project, ctx.config);
  const saved = { gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY, mode: process.env.GUARDIAN_LLM, fetch: globalThis.fetch };

  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    process.env.GUARDIAN_LLM = 'on';
    const keyless = await refinePrompt(ctx, project, graph, 'format the date', resolvePolicy(ctx.config));
    assert.equal(keyless.policy.reason, 'no-keys');
    assert.equal(keyless.mode, 'local');
    assert.match(keyless.text, /formatDate/);

    process.env.GEMINI_API_KEY = 'test-key-000000000000';
    process.env.GUARDIAN_LLM = 'off';
    const off = await refinePrompt(ctx, project, graph, 'format the date', resolvePolicy(ctx.config));
    assert.equal(off.policy.mode, 'local');

    delete process.env.GUARDIAN_LLM;
    assert.equal(resolvePolicy(ctx.config).reason, 'env-unset');

    process.env.GUARDIAN_LLM = 'on';
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const failing = await refinePrompt(ctx, project, graph, 'format the date', resolvePolicy(ctx.config));
    assert.equal(failing.mode, 'unavailable');
    assert.match(failing.text, /## Constraints/);
  } finally {
    for (const [name, value] of [['GEMINI_API_KEY', saved.gemini], ['GROQ_API_KEY', saved.groq], ['GUARDIAN_LLM', saved.mode]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = saved.fetch;
    closeDb(ctx.db);
  }
});

test('the stdio server survives bad input and keeps answering', { timeout: 60_000 }, async () => {
  const root = workspace({
    'good.ts': 'export function formatDate(d: Date) { return d.toISOString(); }\n',
    'broken.ts': 'export function ((( {{{',
    'binary.py': Buffer.from([0, 255, 254, 0]),
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', cli, 'serve', '--root', root],
    cwd: repo,
    env: { ...(process.env as Record<string, string>), GUARDIAN_LLM: 'off' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'hardening-test', version: '1' });
  await client.connect(transport);

  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]).text;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  const escape = await call('get_codebase_context', { paths: ['../../etc'] });
  assert.equal(escape.isError, true);
  assert.equal(JSON.parse(text(escape)).error.code, 'invalid_path');

  const blank = await call('optimize_prompt', { prompt: '   ' });
  assert.equal(blank.isError, true);
  assert.equal(JSON.parse(text(blank)).error.code, 'invalid_input');

  assert.match(text(await call('get_codebase_context', { query: 'format date' })), /formatDate/);
  assert.ok(text(await call('validate_rules', {})).length > 0);
  assert.match(text(await call('optimize_prompt', { prompt: 'format the date' })), /Built locally/);

  await client.close();
});
