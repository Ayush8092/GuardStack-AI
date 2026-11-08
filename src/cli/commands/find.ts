import { createContext } from '../../context.js';
import { analyzeProject } from '../../core/ast/analysis.js';
import { indexProject } from '../../core/ast/indexer.js';
import { describeCoverage } from '../../core/ast/report.js';
import { findReusable, renderFind } from '../../core/prompt/find.js';
import { closeDb } from '../../db/client.js';
import { InputError } from '../../utils/errors.js';
import { out } from '../output.js';

export async function find(query: string, opts: { root?: string; json?: boolean; limit?: string }): Promise<void> {
  if (!query.trim()) throw new InputError('Describe what you are looking for, e.g. guardian find "format a date"');
  const limit = opts.limit === undefined ? 8 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new InputError('--limit must be a whole number from 1 to 50');

  const ctx = createContext(opts.root);
  try {
    const project = await indexProject(ctx);
    const { graph } = analyzeProject(project, ctx.config);
    const result = findReusable(project, graph, query, limit);
    if (opts.json) {
      out(JSON.stringify({ complete: project.complete, configProblems: project.configProblems, ...result }, null, 2));
      return;
    }
    out(renderFind(result));
    if (!project.complete) out(`\n${describeCoverage(project, ctx.config.maxFiles)}`);
  } finally {
    closeDb(ctx.db);
  }
}
