// Runs the analysis on every repository and writes the findings and a per-rule summary:
//   node --import tsx eval/analyze.mts <repos directory> <output directory>
import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { createContext } from '../src/context.js';
import { closeDb } from '../src/db/client.js';
import { indexProject } from '../src/core/ast/indexer.js';

const reposDir = path.resolve(process.argv[2] ?? 'eval/repos');
const outDir = path.resolve(process.argv[3] ?? 'eval/out');
const repos: { name: string; commit: string; kind: string }[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'repos.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const summary: Record<string, unknown> = {};
for (const repo of repos) {
  const root = path.join(reposDir, repo.name);
  const ctx = createContext(root);
  try {
    const project = await indexProject(ctx);
    const analysis = analyzeProject(project, ctx.config);
    const rules: Record<string, number> = {};
    for (const f of analysis.findings) rules[f.rule] = (rules[f.rule] ?? 0) + 1;
    fs.writeFileSync(path.join(outDir, `${repo.name}.findings.json`), `${JSON.stringify(analysis.findings, null, 1)}\n`);
    summary[repo.name] = { commit: repo.commit, files: project.files.length, complete: project.complete, configProblems: project.configProblems, findings: analysis.findings.length, rules: Object.fromEntries(Object.entries(rules).sort()) };
  } finally {
    closeDb(ctx.db);
    fs.rmSync(path.join(root, '.guardian'), { recursive: true, force: true });
  }
}
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
