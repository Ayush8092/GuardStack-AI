import { createContext } from '../../context.js';
import { err as printError, out } from '../output.js';
import { indexProject } from '../../core/ast/indexer.js';
import { describeCoverage, renderValidation } from '../../core/ast/report.js';
import type { Severity } from '../../core/ast/analysis.js';
import { validateProject } from '../../core/validation/delta.js';
import { closeDb } from '../../db/client.js';

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

// What to do when the change weakens the project's own analysis configuration (rules off or lowered, ignore patterns,
// exceptions, entry points, files no longer analysed):
//   warn    report it prominently; the exit code is not affected (default, the historical behaviour)
//   fail    exit 1
//   approve the caller accepts the weakening explicitly: it is still reported, and the exit code is not affected
// The choice is made by whoever runs the command (a CI job), never by a file in the repository being checked.
export const CONFIG_POLICIES = ['warn', 'fail', 'approve'] as const;
export type ConfigPolicy = (typeof CONFIG_POLICIES)[number];

export type CheckOptions = {
  root?: string;
  base?: string;
  json?: boolean;
  all?: boolean;
  failOn?: string;
  failOnPartial?: boolean;
  configPolicy?: string;
};

// Exit code 1 means the check failed one of the requested conditions; 0 means none was triggered. Usage and runtime
// errors exit 2 (see src/cli/index.ts). Without --fail-on, --fail-on-partial and --config-policy fail, the exit code is
// 0 whatever was found, as before.
export async function check(opts: CheckOptions): Promise<void> {
  if (opts.failOn && !(opts.failOn in RANK)) throw new Error('--fail-on must be high, medium or low');
  const policy = (opts.configPolicy ?? 'warn') as ConfigPolicy;
  if (!CONFIG_POLICIES.includes(policy)) throw new Error('--config-policy must be warn, fail or approve');

  const ctx = createContext(opts.root);
  try {
    const project = await indexProject(ctx);
    const { validation } = await validateProject(ctx, project, { base: opts.base });

    const failures: string[] = [];
    const limit = opts.failOn as Severity | undefined;
    if (limit && validation.introduced.some((f) => RANK[f.severity] <= RANK[limit])) failures.push(`a new finding is at least ${limit} severity (--fail-on ${limit})`);
    if (opts.failOnPartial && validation.partial) failures.push('the validation is partial, so it cannot be treated as a definitive pass (--fail-on-partial)');
    if (policy === 'fail' && validation.configDowngrades.length > 0) failures.push('the change weakens the analysis configuration (--config-policy fail)');

    if (opts.json) {
      out(JSON.stringify({ complete: project.complete, configProblems: project.configProblems, ...validation, configPolicy: policy, failures }, null, 2));
    } else {
      out(renderValidation(validation, { includeExisting: opts.all }));
      if (!project.complete) out(`\n${describeCoverage(project, ctx.config.maxFiles)}`);
      if (policy === 'approve' && validation.configDowngrades.length > 0) out('\nThe configuration downgrade above was approved with --config-policy approve.');
      out(`\nValidation: ${validation.partial ? 'PARTIAL (provisional, see the reasons above)' : 'COMPLETE'}.`);
    }

    // The reasons go to stderr so that --json output stays machine-readable.
    for (const reason of failures) printError(`Check failed: ${reason}.`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    closeDb(ctx.db);
  }
}
