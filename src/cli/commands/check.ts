import { createContext } from '../../context.js';
import { out } from '../output.js';
import { indexProject } from '../../core/ast/indexer.js';
import { describeCoverage, renderValidation } from '../../core/ast/report.js';
import type { Severity } from '../../core/ast/analysis.js';
import { validateProject } from '../../core/validation/delta.js';
import { closeDb } from '../../db/client.js';

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export async function check(opts: { root?: string; base?: string; json?: boolean; all?: boolean; failOn?: string }): Promise<void> {
  if (opts.failOn && !(opts.failOn in RANK)) throw new Error('--fail-on must be high, medium or low');

  const ctx = createContext(opts.root);
  try {
    const project = await indexProject(ctx);
    const { validation } = await validateProject(ctx, project, { base: opts.base });

    if (opts.json) {
      out(JSON.stringify({ complete: project.complete, configProblems: project.configProblems, ...validation }, null, 2));
    } else {
      out(renderValidation(validation, { includeExisting: opts.all }));
      if (!project.complete) out(`\n${describeCoverage(project, ctx.config.maxFiles)}`);
    }

    const limit = opts.failOn as Severity | undefined;
    if (limit && validation.introduced.some((f) => RANK[f.severity] <= RANK[limit])) process.exitCode = 1;
  } finally {
    closeDb(ctx.db);
  }
}
