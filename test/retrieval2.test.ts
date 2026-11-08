import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { resolvePolicy } from '../src/core/llm/policy.js';
import { refinePrompt } from '../src/core/prompt/refiner.js';
import { retrieve } from '../src/core/prompt/relevance.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

const files: Record<string, string> = {
  'src/utils/date.ts': "function padTwo(n: number) { return String(n).padStart(2, '0'); }\nexport function formatDate(d: Date) { return [d.getFullYear(), padTwo(d.getMonth() + 1), padTwo(d.getDate())].join('-'); }\n",
  'src/core/logger.ts': 'export function log(message: string) { console.log(message); }\n',
  'src/core/events.ts': 'export function emit(name: string) { return name; }\n',
};
for (let i = 0; i < 6; i++) files[`src/features/f${i}.ts`] = `import { log } from '../core/logger';\nimport { emit } from '../core/events';\nexport const run${i} = () => { log('x'); emit('y'); };\n`;
files['src/main.ts'] = "import { formatDate } from './utils/date';\n" + [0, 1, 2, 3, 4, 5].map((i) => `import './features/f${i}';`).join('\n') + '\nconsole.log(formatDate(new Date()));\n';

async function load() {
  const ctx = context(workspace(files));
  const project = await indexProject(ctx);
  return { ctx, project, graph: analyzeProject(project, ctx.config).graph };
}

test('an internal helper is offered as a reuse candidate and marked as not exported', async () => {
  const { project, graph } = await load();
  const found = retrieve(project.files, graph, 'pad a number with zeros').symbols.find((s) => s.sym.name === 'padTwo');
  assert.ok(found, 'padTwo should be found');
  assert.equal(found.internal, true);
  assert.ok(found.reasons.some((r) => /pad/.test(r)));
});

test('popular files are not returned as related when nothing matched', async () => {
  const { project, graph } = await load();
  const nothing = retrieve(project.files, graph, 'quantum entanglement scheduler');
  assert.equal(nothing.confident, false);
  assert.deepEqual(nothing.symbols, []);
  assert.deepEqual(nothing.related, []);
  assert.ok(nothing.files.every((f) => !f.relevant));
});

test('every candidate explains why it was selected', async () => {
  const { project, graph } = await load();
  const result = retrieve(project.files, graph, 'format the date for display');
  assert.equal(result.confident, true);
  const top = result.symbols[0];
  assert.equal(top.sym.name, 'formatDate');
  assert.equal(top.strength, 'strong');
  assert.ok(top.reasons.length > 0);
});

test('the refined prompt says so when there is no confident match, and includes reasons when there is', async () => {
  const { ctx, project, graph } = await load();
  const policy = resolvePolicy({ ...ctx.config, llm: 'off' });
  const none = await refinePrompt(ctx, project, graph, 'quantum entanglement scheduler', policy, { dryRun: true });
  assert.match(none.text, /## No confident match/);
  assert.equal(none.noConfidentMatch, true);
  assert.ok(!/## Reuse existing code/.test(none.text));

  const some = await refinePrompt(ctx, project, graph, 'format the date for display', policy, { dryRun: true });
  assert.match(some.text, /## Reuse existing code/);
  assert.match(some.text, /why: /);
  assert.ok(!/## No confident match/.test(some.text));
});
