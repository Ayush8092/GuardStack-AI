import { createContext } from '../../context.js';
import { out } from '../output.js';
import { analyzeProject } from '../../core/ast/analysis.js';
import { indexProject } from '../../core/ast/indexer.js';
import { describeCoverage, renderFindings } from '../../core/ast/report.js';
import { closeDb, lifetimeUsage } from '../../db/client.js';

export async function scan(opts: { root?: string; json?: boolean; explain?: boolean }): Promise<void> {
  const ctx = createContext(opts.root);
  try {
    const project = await indexProject(ctx);
    const { graph, findings, cycles, unresolved, unsupported } = analyzeProject(project, ctx.config);

    if (opts.json) {
      const report = {
        complete: project.complete,
        configProblems: project.configProblems,
        files: project.files.length,
        eligible: project.eligible,
        truncated: project.truncated,
        skipped: project.skipped,
        parseIssues: project.parseIssues,
        stopped: project.stopped ?? null,
        unindexed: project.unindexed,
        graph,
        cycles,
        unresolved,
        unsupported,
        findings,
      };
      out(JSON.stringify(report, null, 2));
      return;
    }

    const exported = project.files.reduce((n, f) => n + f.symbols.filter((s) => s.exportName).length, 0);
    out(`Scanned ${project.files.length} files, ${exported} exported symbols, ${graph.links.length} import links, ${cycles.length} cycle(s).`);
    out(describeCoverage(project, ctx.config.maxFiles));
    out(`\n${renderFindings(findings, 15, opts.explain)}`);
    if (unsupported.length > 0) {
      out(`\n${unsupported.length} import(s) use aliases or built packages this tool cannot resolve (for example ${unsupported[0].spec}); they were not counted as broken. List them with scan --json.`);
    }

    const usage = lifetimeUsage(ctx.db);
    if (usage.calls > 0) {
      out(`\nEstimated tokens across ${usage.calls} tool calls: ~${usage.sent} sent vs ~${usage.raw} for reading the referenced files in full.`);
    }
  } finally {
    closeDb(ctx.db);
  }
}
