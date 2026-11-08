import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { complete, resetProviderState } from '../src/core/llm/provider.js';
import { describePolicy, resolvePolicy } from '../src/core/llm/policy.js';
import { MAX_PROMPT_CHARS, describeLlm, refinePrompt } from '../src/core/prompt/refiner.js';
import { extractCriteria } from '../src/core/prompt/criteria.js';
import { OutboundBlocked, prepareOutbound } from '../src/core/security/outbound.js';
import { log } from '../src/utils/logger.js';
import { InputError } from '../src/utils/errors.js';
import { cleanup, context, workspace } from './helpers.js';

const realFetch = globalThis.fetch;
const saved = { gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY, mode: process.env.GUARDIAN_LLM };
let bodies: string[];

const AWS = 'AKIAABCDEFGHIJKLMNOP';
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const SK = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';

const geminiOk = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reuse: [{ symbol: 'formatDate', file: 'src/date.ts', why: 'already formats dates' }], assumptions: ['UTC is fine'], questions: [] }) }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: {} };

function capture(respond: () => Response = () => Response.json(geminiOk)) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    bodies.push(String(init?.body ?? ''));
    return respond();
  }) as typeof fetch;
}

beforeEach(() => {
  bodies = [];
  resetProviderState();
  process.env.GEMINI_API_KEY = 'test-gemini-key-000000';
  delete process.env.GROQ_API_KEY;
  process.env.GUARDIAN_LLM = 'on';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of [['GEMINI_API_KEY', saved.gemini], ['GROQ_API_KEY', saved.groq], ['GUARDIAN_LLM', saved.mode]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanup();
});

const project = {
  'src/date.ts': `export function formatDate(d: Date, token = "${SK}") { return d.toISOString(); }\n`,
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 1;\n',
  'src/c.ts': 'export const c = 1;\n',
};

test('the full outbound payload is masked at the provider boundary', async () => {
  capture();
  const answer = await complete(`system with ${GH}`, `<request>use ${AWS}</request>\n<existing_symbols>token = "${SK}"</existing_symbols>`);
  assert.ok(answer);
  assert.ok(answer.redactions >= 3);
  assert.equal(bodies.length, 1);
  for (const secret of [AWS, GH, SK]) assert.ok(!bodies[0].includes(secret), `${secret.slice(0, 8)}… leaked`);
  assert.match(bodies[0], /REDACTED/);
});

test('secrets in the prompt, in symbol signatures and in repository metadata never reach the provider', async () => {
  const ctx = context(workspace(project));
  const indexed = await indexProject(ctx);
  const { graph } = analyzeProject(indexed, ctx.config);
  capture();

  const refined = await refinePrompt(ctx, indexed, graph, `format the date using ${AWS} and keep ${GH} secret`, resolvePolicy(ctx.config));
  assert.equal(refined.mode, 'used');
  assert.equal(bodies.length, 1);
  for (const secret of [AWS, GH, SK]) {
    assert.ok(!bodies[0].includes(secret), `${secret.slice(0, 8)}… reached the provider`);
    assert.ok(!refined.text.includes(secret), `${secret.slice(0, 8)}… is in the prompt window`);
  }
  assert.ok(refined.redactions > 0);
});

test('prepareOutbound masks both halves and counts the redactions', () => {
  const out = prepareOutbound(`system ${GH}`, `user ${AWS} and password = "hunter2hunter2"`);
  assert.ok(!out.system.includes(GH));
  assert.ok(!out.prompt.includes(AWS) && !out.prompt.includes('hunter2hunter2'));
  assert.equal(out.redactions, 3);
});

test('fully local mode makes no network request, and external mode needs an explicit opt-in', async () => {
  const ctx = context(workspace(project));
  const indexed = await indexProject(ctx);
  const { graph } = analyzeProject(indexed, ctx.config);
  capture();

  process.env.GUARDIAN_LLM = 'off';
  const off = await refinePrompt(ctx, indexed, graph, 'format the date', resolvePolicy(ctx.config));
  assert.equal(off.mode, 'local');
  assert.match(describePolicy(off.policy), /Fully local mode/);
  assert.match(describeLlm(off), /Built locally/);

  delete process.env.GUARDIAN_LLM;
  assert.equal(resolvePolicy(ctx.config).mode, 'local');
  assert.equal(resolvePolicy(ctx.config).reason, 'env-unset');

  process.env.GUARDIAN_LLM = 'on';
  assert.equal(resolvePolicy({ llm: false }).reason, 'config-off');
  assert.equal(resolvePolicy(ctx.config, { disabled: true }).reason, 'flag-off');
  assert.equal(bodies.length, 0);

  const external = resolvePolicy(ctx.config);
  assert.equal(external.mode, 'external');
  assert.match(describePolicy(external), /External LLM mode.*No file contents/);
});

test('dry run shows the masked payload and sends nothing', async () => {
  const ctx = context(workspace(project));
  const indexed = await indexProject(ctx);
  const { graph } = analyzeProject(indexed, ctx.config);
  capture();

  const refined = await refinePrompt(ctx, indexed, graph, `format the date with ${AWS}`, resolvePolicy(ctx.config), { dryRun: true });
  assert.equal(refined.mode, 'dry-run');
  assert.equal(bodies.length, 0);
  assert.ok(refined.payload);
  assert.ok(!refined.payload.prompt.includes(AWS) && !refined.payload.prompt.includes(SK));
  assert.match(refined.payload.prompt, /<request>/);
  assert.match(refined.payload.prompt, /<layout>/);
});

test('log output is masked', () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const previous = process.env.GUARDIAN_LOG;
  process.env.GUARDIAN_LOG = 'debug';
  process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    log.error(`failed with ${GH}`, new Error(`bad ${AWS}`));
  } finally {
    process.stderr.write = original;
    if (previous === undefined) delete process.env.GUARDIAN_LOG;
    else process.env.GUARDIAN_LOG = previous;
  }
  assert.equal(written.length, 1);
  assert.ok(!written[0].includes(GH) && !written[0].includes(AWS));
});

const REQUEST = [
  'Add CSV export to the user profile page.',
  '',
  'Acceptance criteria:',
  '- The file must contain every column that is visible on screen',
  '- Export should finish within 2 seconds for 10000 rows',
  '- Do not add any new dependency',
  '',
  'It should also keep working for users without an email address.',
].join('\n');

test('criteria are extracted from sections, lists and obligation sentences', () => {
  const criteria = extractCriteria(REQUEST);
  assert.ok(criteria.includes('The file must contain every column that is visible on screen'));
  assert.ok(criteria.includes('Export should finish within 2 seconds for 10000 rows'));
  assert.ok(criteria.includes('Do not add any new dependency'));
  assert.ok(criteria.some((c) => c.includes('keep working for users without an email address')));
  assert.deepEqual(extractCriteria('add a button'), []);
});

test('the original request and every acceptance criterion survive refinement unchanged', async () => {
  const ctx = context(workspace(project));
  const indexed = await indexProject(ctx);
  const { graph } = analyzeProject(indexed, ctx.config);

  for (const mode of ['off', 'on']) {
    process.env.GUARDIAN_LLM = mode;
    capture(() => Response.json({ candidates: [{ content: { parts: [{ text: '# Heading\n```ts\nconst injected = 1;\n```\nOnly a short note.' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: {} }));
    const refined = await refinePrompt(ctx, indexed, graph, REQUEST, resolvePolicy(ctx.config));

    assert.ok(refined.text.includes(REQUEST), `request was altered in ${mode} mode`);
    assert.equal(refined.criteria, 4);
    for (const criterion of extractCriteria(REQUEST)) assert.ok(refined.text.includes(`- ${criterion}`));
    assert.ok(refined.text.indexOf('## Task') < refined.text.indexOf('## Constraints'));
    assert.ok(!refined.text.includes('injected'), 'model output must not add code blocks');
    assert.ok(!refined.text.includes('# Heading'));
  }
});

test('an over-long prompt is rejected instead of being silently truncated', async () => {
  const ctx = context(workspace(project));
  const indexed = await indexProject(ctx);
  const { graph } = analyzeProject(indexed, ctx.config);
  await assert.rejects(refinePrompt(ctx, indexed, graph, 'x'.repeat(MAX_PROMPT_CHARS + 1), resolvePolicy(ctx.config)), InputError);
});

test('a masking failure or a custom-pattern timeout never lets raw text reach the provider', async () => {
  const { configureMasking } = await import('../src/core/security/masker.js');
  // A masking step that throws blocks the send.
  assert.throws(() => prepareOutbound(undefined as unknown as string, 'x'), (err: Error) => err instanceof OutboundBlocked && /nothing was sent/.test(err.message));

  // A pattern that times out redacts the line it could not scan; the payload that is sent holds none of it.
  configureMasking({ literals: [], patterns: [{ name: 'slow', pattern: '[^x]{3,}[^x]{1,64}(?:\\s|[^x])[^x]{1,8}a' }] });
  try {
    const out = prepareOutbound('system text', `${'k'.repeat(3000)}\nSECRETLINE-ZZZ`);
    assert.ok(!out.prompt.includes('kkkkkkkk'));
    assert.ok(out.prompt.includes('[REDACTED:unscanned]'));
  } catch (err) {
    // Refusing to send is also fail-closed.
    assert.ok(err instanceof OutboundBlocked);
  } finally {
    configureMasking({ literals: [], patterns: [] });
  }
});
