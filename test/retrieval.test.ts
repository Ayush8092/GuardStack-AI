import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { buildContext } from '../src/core/prompt/compressor.js';
import { retrieve, understandQuery } from '../src/core/prompt/relevance.js';
import { describeTokens, estimateTokens } from '../src/utils/tokens.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

const body = "const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate()]; return parts.map((p) => String(p).padStart(2, '0')).join('-');";

const files = {
  'src/utils/date.ts': `export function formatDate(d: Date) { ${body} }\nexport function parseDate(s: string) { return new Date(s); }\n`,
  'src/utils/money.ts': 'export function formatPrice(cents: number) { return (cents / 100).toFixed(2); }\n',
  'src/services/user.ts': "import { formatDate } from '../utils/date';\nexport function describeUser(u: { created: Date }) { return formatDate(u.created); }\n",
  'src/services/billing.ts': 'export function chargeCustomer(id: string, cents: number) { return { id, cents }; }\n',
  'src/http/client.ts': 'export async function request(url: string) { return fetch(url); }\n',
  'src/auth/login.ts': 'export function loginUser(name: string) { return name; }\n',
};

async function load() {
  const ctx = context(workspace(files));
  const project = await indexProject(ctx);
  return { ctx, project, graph: analyzeProject(project, ctx.config).graph };
}

test('stage 1 understands stems, synonyms, identifiers and path hints', () => {
  const q = understandQuery('Fix `formatDate` formatting dates in src/utils/date.ts and user_profile');
  assert.ok(q.identifiers.includes('formatDate'));
  assert.ok(q.identifiers.includes('user_profile'));
  assert.deepEqual(q.pathHints, ['src/utils/date.ts']);
  const format = q.terms.find((t) => t.text === 'formatting');
  assert.equal(format?.stem, 'formatt');
  assert.ok(q.terms.find((t) => t.text === 'date')?.synonyms.includes('timestamp'));
});

test('stage 2 matches symbols by stem and synonym, not only exact words', async () => {
  const { project, graph } = await load();
  const byStem = retrieve(project.files, graph, 'formatting the dates');
  assert.equal(byStem.symbols[0].sym.name, 'formatDate');

  const bySynonym = retrieve(project.files, graph, 'render a timestamp');
  assert.ok(bySynonym.symbols.map((s) => s.sym.name).includes('formatDate'));

  const exact = retrieve(project.files, graph, 'something about `chargeCustomer`');
  assert.equal(exact.symbols[0].sym.name, 'chargeCustomer');
});

test('stage 3 expands to dependencies and importers of the best match', async () => {
  const { project, graph } = await load();
  const result = retrieve(project.files, graph, 'parse date');
  assert.equal(result.symbols[0].file.path, 'src/utils/date.ts');
  const related = result.related.map((r) => `${r.file.path}:${r.via}`);
  assert.ok(related.includes('src/services/user.ts:importer'), related.join());
});

test('stage 4 ranks directly matched files above unrelated ones', async () => {
  const { project, graph } = await load();
  const order = retrieve(project.files, graph, 'login the user').files.map((r) => r.file.path);
  assert.equal(order[0], 'src/auth/login.ts');
  assert.ok(order.indexOf('src/auth/login.ts') < order.indexOf('src/http/client.ts'));
});

test('an empty or meaningless query returns no matches', async () => {
  const { project, graph } = await load();
  assert.deepEqual(retrieve(project.files, graph, 'please make it work').symbols, []);
});

test('the token budget is enforced and truncation is reported', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, Array.from({ length: 6 }, (__, j) => `export function helper${i}x${j}(input: string): string { return input + '${i}${j}'; }`).join('\n') + '\n']),
  );
  const ctx = context(workspace(many));
  const project = await indexProject(ctx);
  const { graph } = analyzeProject(project, ctx.config);

  const small = buildContext(project, graph, { budgetTokens: 500 });
  assert.ok(small.sentTokens <= 500, `sent ${small.sentTokens}`);
  assert.equal(small.truncated, true);
  assert.ok(small.omittedFiles > 0);
  assert.match(small.text, /left out/);

  const big = buildContext(project, graph, { budgetTokens: 16_000 });
  assert.equal(big.truncated, false);
  assert.equal(big.includedFiles, 30);
  assert.ok(big.baselineTokens > big.sentTokens);
});

test('baseline counts only files that actually appear in the output', async () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/m${i}.ts`, `export function fn${i}(a: string) { return a; }\n${'// padding\n'.repeat(40)}`]));
  const ctx = context(workspace(many));
  const project = await indexProject(ctx);
  const { graph } = analyzeProject(project, ctx.config);
  const tight = buildContext(project, graph, { budgetTokens: 150 });
  const everything = buildContext(project, graph, { budgetTokens: 16_000 });

  assert.ok(tight.includedFiles < 20);
  assert.ok(tight.baselineTokens < everything.baselineTokens);
  const perFile = everything.baselineTokens / 20;
  assert.ok(Math.abs(tight.baselineTokens - perFile * tight.includedFiles) < perFile);
});

test('day-one workspaces respect the budget too', async () => {
  const exports = Array.from({ length: 200 }, (_, i) => `export function starter${i}(value: string): string { return value; }`).join('\n');
  const ctx = context(workspace({ 'a.ts': exports, 'b.ts': exports.replaceAll('starter', 'other') }));
  const project = await indexProject(ctx);
  const built = buildContext(project, analyzeProject(project, ctx.config).graph, { budgetTokens: 500 });

  assert.equal(built.day1, true);
  assert.match(built.text, /New workspace/);
  assert.ok(built.sentTokens <= 500, `sent ${built.sentTokens}`);
  assert.equal(built.truncated, true);
  assert.ok(built.symbolsDropped > 0 || built.omittedFiles > 0);
});

test('token descriptions are labelled as estimates and never claim a negative saving', () => {
  assert.match(describeTokens({ sent: 100, baseline: 1000, baselineFiles: 3, truncated: false }), /estimated tokens instead of ~1000 .* \(90% fewer\)/);
  assert.match(describeTokens({ sent: 100, baseline: 80, baselineFiles: 1, truncated: false }), /no saving/);
  assert.match(describeTokens({ sent: 100, baseline: 0, baselineFiles: 0, truncated: true }), /no referenced files.*truncated/);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('é'), 1);
});
