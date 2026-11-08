import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { findReusable, renderFind } from '../src/core/prompt/find.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

async function find(files: Record<string, string>, query: string, limit = 8) {
  const ctx = context(workspace(files));
  const project = await indexProject(ctx);
  const { graph } = analyzeProject(project, ctx.config);
  return findReusable(project, graph, query, limit);
}

// A realistic corpus: IDF only means something when most symbols do not share the query's words.
const vocabulary = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
const filler: Record<string, string> = Object.fromEntries(
  vocabulary.map((w, i) => [`src/misc/${w}.ts`, `export function run${w[0]?.toUpperCase()}${w.slice(1)}(${vocabulary[(i + 7) % vocabulary.length]}Count: number): number { return ${i}; }\n`]),
);

const files = {
  ...filler,
  // Name says nothing about dates; only the doc comment and the signature do.
  'src/lib/fmt2.ts': '/**\n * Formats a date as YYYY-MM-DD for display.\n */\nexport function fmt2(input: Date): string { return input.toISOString().slice(0, 10); }\n',
  // Name matches, no description.
  'src/lib/money.ts': 'export function formatMoney(cents: number): string { return (cents / 100).toFixed(2); }\n',
  // Matches only through its parameter types.
  'src/lib/clock.ts': 'export function tick(now: Date, zone: string): number { return now.getTime(); }\n',
  // Python docstring.
  'tools/slug.py': 'def make_slug(title):\n    """Convert a title into a url friendly slug."""\n    return title.lower().replace(" ", "-")\n',
  'src/main.ts': "import { fmt2 } from './lib/fmt2';\nconsole.log(fmt2(new Date()));\n",
};

test('a function whose name says nothing is found through its doc comment and shown with it', async () => {
  const result = await find(files, 'format a date for display');
  const hit = result.candidates.find((c) => c.name === 'fmt2');
  assert.ok(hit, 'fmt2 must not be silently excluded');
  assert.equal(hit.strength, 'strong');
  assert.equal(result.candidates[0]?.name, 'fmt2', 'three terms covered by the doc comment outrank one name hit');
  assert.ok(hit.matchedIn.includes('description') && !hit.matchedIn.includes('name'));
  assert.match(hit.description ?? '', /Formats a date as YYYY-MM-DD/);
  assert.equal(result.status, 'strong');
  const text = renderFind(result);
  assert.match(text, /Strong matches/);
  assert.match(text, /matched by description.*not by name/);
  assert.match(text, /doc: Formats a date/);
});

test('a function that matches only through its signature is listed as a weak match, not dropped', async () => {
  const result = await find(files, 'zone timezone');
  const hit = result.candidates.find((c) => c.name === 'tick');
  assert.ok(hit, 'tick matches through its parameter named zone');
  assert.equal(hit.strength, 'weak');
  assert.deepEqual(hit.matchedIn, ['signature']);
  assert.equal(result.confident, false);
  assert.match(renderFind(result), /No confident match\. Weak candidates only/);
});

test('Python docstrings are searchable', async () => {
  const result = await find(files, 'convert a title to a url slug');
  assert.equal(result.candidates[0]?.name, 'make_slug');
  assert.match(result.candidates[0]?.description ?? '', /url friendly slug/);
});

test('strong, weak, related and none are reported as separate states', async () => {
  assert.equal((await find(files, 'format a date for display')).status, 'strong');
  assert.equal((await find(files, 'zone timezone')).status, 'weak');
  assert.equal((await find(files, 'quantum entanglement scheduler')).status, 'none');
  assert.match(renderFind(await find(files, 'quantum entanglement scheduler')), /^No confident match/);

  // Only the directory name matches: no function qualifies as a candidate, the files are offered as related.
  const related = await find({ ...filler, 'src/billing/ledger.ts': 'export function post(x: number) { return x; }\n', 'src/billing/audit.ts': 'export function stamp(y: number) { return y; }\n' }, 'billing');
  assert.equal(related.status, 'related');
  assert.equal(related.candidates.length, 0);
  assert.equal(related.confident, false);
  const text = renderFind(related);
  assert.match(text, /^No confident match\. No function matched by name, signature or description/);
  assert.match(text, /src\/billing\/ledger\.ts/);
});

test('a strong match does not hide weaker matches, and truncation is counted', async () => {
  const many: Record<string, string> = { ...filler };
  for (let i = 0; i < 12; i++) many[`src/v${i}.ts`] = `export function ${vocabulary[i]}Record(x: number) { return x; }\n`;
  many['src/exact.ts'] = 'export function formatRecordDate(d: Date) { return d; }\n';
  const result = await find(many, 'format record date', 4);
  assert.equal(result.candidates.length, 4);
  assert.ok(result.omitted > 0);
  assert.equal(result.candidates[0]?.name, 'formatRecordDate');
  assert.match(renderFind(result), /more weaker candidate\(s\) matched and were not shown/);
});

test('popularity alone never creates a candidate', async () => {
  const result = await find({ ...files, 'src/a.ts': "import { fmt2 } from './lib/fmt2';\nexport const a = fmt2;\n" }, 'completely unrelated words here');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.status, 'none');
});

test('two-letter words in names (ok, id, db) are searchable', async () => {
  const result = await find({ ...filler, 'src/http.ts': 'export function isResponseOk(status: number): boolean { return status < 400; }\n' }, 'check whether the response status is ok');
  assert.equal(result.candidates[0]?.name, 'isResponseOk');
});
