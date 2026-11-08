import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Ctx } from '../src/context.js';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { buildContext } from '../src/core/prompt/compressor.js';
import { openDb } from '../src/db/client.js';
import { loadConfig } from '../src/utils/config.js';

const body = "const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate()]; return parts.map((p) => String(p).padStart(2, '0')).join('-');";

const project: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'src/utils/date.ts': `export function formatDate(d: Date) { ${body} }\nexport const unused = 1;\n`,
  'src/utils/copy.ts': `export function dateToString(d: Date) { ${body} }\n`,
  'src/services/a.ts': `import { formatDate } from '@/utils/date';\nimport { dateToString } from '../utils/copy.js';\nexport const x = [formatDate, dateToString];\n// eslint-disable-next-line\nconst y: any = 1;\n`,
  'src/services/orphan.ts': 'export const lonely = 1;\n',
  'src/index.ts': "import { x } from './services/a.js';\nconsole.log(x);\n",
  'pkg/models.py': 'class User:\n    pass\n',
  'pkg/app.py': 'from .models import User  # noqa\n',
  'src/secrets.ts': 'export const t = "abc";\n',
};

let dir: string;
let ctx: Ctx;

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-index-')));
  for (const [rel, content] of Object.entries(project)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  ctx = { root: dir, config: loadConfig(dir), db: openDb(dir) };
});

after(() => {
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('indexes source files and skips sensitive ones', async () => {
  const { files } = await indexProject(ctx);
  assert.ok(files.some((f) => f.path === 'src/utils/date.ts'));
  assert.ok(!files.some((f) => f.path === 'src/secrets.ts'));
});

test('reports duplicates, orphans, dead exports and suppressions', async () => {
  const { findings, graph } = analyzeProject(await indexProject(ctx), ctx.config);
  const has = (rule: string, text: string) => findings.some((f) => f.rule === rule && (f.message + f.file).includes(text));

  assert.ok(has('duplicate-body', 'dateToString'));
  assert.ok(has('orphan-file', 'orphan.ts'));
  assert.ok(has('dead-export', 'unused'));
  assert.ok(has('suppression', 'eslint-disable'));
  assert.ok(has('suppression', 'any'));
  assert.ok(has('suppression', 'noqa'));
  assert.ok(!has('orphan-file', 'index.ts'));
  assert.ok(!has('dead-export', 'formatDate'));
  assert.ok(graph.links.some((l) => l.source === 'pkg/app.py' && l.target === 'pkg/models.py'));
  assert.ok(graph.links.some((l) => l.source === 'src/services/a.ts' && l.target === 'src/utils/date.ts'));
});

test('serves unchanged files from the cache and re-parses edited ones', async () => {
  await indexProject(ctx);
  const before = ctx.db.prepare("SELECT hash FROM files WHERE path = 'src/services/orphan.ts'").get() as { hash: string };

  fs.writeFileSync(path.join(dir, 'src/services/orphan.ts'), 'export const lonely = 2;\nexport const more = 3;\n');
  const { files } = await indexProject(ctx);
  const after = ctx.db.prepare("SELECT hash FROM files WHERE path = 'src/services/orphan.ts'").get() as { hash: string };

  assert.notEqual(before.hash, after.hash);
  assert.equal(files.find((f) => f.path === 'src/services/orphan.ts')?.symbols.length, 2);
});

test('drops deleted files from the cache', async () => {
  fs.rmSync(path.join(dir, 'src/services/orphan.ts'));
  await indexProject(ctx);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE path = 'src/services/orphan.ts'").get()?.n, 0);
});

test('context lists relevant files first and respects the budget', async () => {
  const p = await indexProject(ctx);
  const { graph } = analyzeProject(p, ctx.config);
  const built = buildContext(p, graph, { query: 'format date', budgetTokens: 4000 });
  assert.ok(built.text.indexOf('src/utils/date.ts') < built.text.indexOf('pkg/models.py'));

  const tiny = buildContext(p, graph, { budgetTokens: 30 });
  assert.match(tiny.text, /left out/);
});

test('small workspaces get day-one guidelines', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-empty-'));
  const emptyCtx: Ctx = { root: fs.realpathSync(empty), config: loadConfig(empty), db: openDb(empty) };
  const emptyProject = await indexProject(emptyCtx);
  const built = buildContext(emptyProject, analyzeProject(emptyProject, emptyCtx.config).graph, { budgetTokens: 1000 });
  assert.equal(built.day1, true);
  assert.match(built.text, /New workspace/);
  emptyCtx.db.close();
  fs.rmSync(empty, { recursive: true, force: true });
});
