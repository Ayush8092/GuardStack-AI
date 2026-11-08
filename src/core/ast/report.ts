import { describeHealth } from './health.js';
import type { Project } from './indexer.js';
import type { Finding, Rule } from './analysis.js';
import { safe } from '../../utils/text.js';
import type { SkipReason, Validation } from '../validation/delta.js';

const TITLES: Record<Rule, string> = {
  'duplicate-body': 'Textually identical implementations',
  'similar-structure': 'Structurally similar implementations',
  'duplicate-symbol': 'Same name defined in several files',
  'circular-dependency': 'Circular dependencies',
  'unresolved-import': 'Imports that could not be resolved',
  'orphan-file': 'Orphan files (nothing imports them)',
  'dead-export': 'Exports nobody imports',
  'unused-import': 'Unused imports',
  suppression: 'Suppressed type/lint checks',
};

const ORDER: Rule[] = [
  'duplicate-body',
  'similar-structure',
  'duplicate-symbol',
  'circular-dependency',
  'suppression',
  'unresolved-import',
  'orphan-file',
  'dead-export',
  'unused-import',
];

export function renderFindings(findings: Finding[], perRule = 15, explain = false): string {
  if (findings.length === 0) return 'No issues found.';

  const sections: string[] = [];
  for (const rule of ORDER) {
    const group = findings.filter((f) => f.rule === rule);
    if (group.length === 0) continue;
    const lines = group.slice(0, perRule).map((f) => {
      const where = f.line ? `${safe(f.file)}:${f.line}` : safe(f.file);
      const label = f.classification ? `${f.severity}, ${f.confidence} confidence, ${f.classification}` : `${f.severity}, ${f.confidence} confidence`;
      const head = `- [${label}] ${where}  ${safe(f.message)}`;
      if (!explain) return head;
      const why = f.evidence.map((e) => `    · ${safe(e)}`).join('\n');
      return `${head}\n${why}\n    → ${safe(f.remediation)}`;
    });
    if (group.length > perRule) lines.push(`- … and ${group.length - perRule} more`);
    sections.push(`## ${TITLES[rule]} (${group.length})\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

const STOP_TEXT: Record<NonNullable<Project['stopped']>, string> = {
  'entry-limit': 'file discovery stopped at maxDiscoveryEntries, so part of the workspace was never listed',
  'time-limit': 'file discovery stopped at maxDiscoveryMs, so part of the workspace was never listed',
  'index-time-limit': 'indexing stopped at maxIndexMs before every file was processed (files already processed are cached: run again to continue)',
};

type Coverage = Pick<Project, 'files' | 'eligible' | 'truncated' | 'skipped' | 'complete'> & Partial<Pick<Project, 'configProblems' | 'parseIssues' | 'stopped' | 'unindexed'>>;

export function describeCoverage(project: Coverage, maxFiles: number): string {
  if (project.complete) return `Analysis is complete: all ${project.files.length} eligible files were indexed.`;

  const reasons: string[] = [];
  if (project.stopped) {
    const left = project.unindexed ?? 0;
    reasons.push(`${STOP_TEXT[project.stopped]}${left > 0 ? ` (${left} discovered file(s) not processed)` : ''}; raise the limit in .guardianrc`);
  }
  if (project.truncated) reasons.push(`only the first ${maxFiles} of ${project.eligible} eligible files (sorted by path) were indexed, raise maxFiles in .guardianrc`);
  if (project.skipped.length > 0) {
    const sample = project.skipped.slice(0, 3).map((s) => `${safe(s.path)} (${s.reason})`).join(', ');
    reasons.push(`${project.skipped.length} file(s) were skipped: ${sample}${project.skipped.length > 3 ? ', …' : ''}`);
  }
  const issues = project.parseIssues ?? [];
  if (issues.length > 0) {
    const degraded = issues.filter((i) => i.status === 'degraded').length;
    const sample = issues.slice(0, 3).map((i) => `${safe(i.path)} (${describeHealth(i)})`).join('; ');
    reasons.push(`${issues.length} file(s) have syntax errors the parser had to repair${degraded > 0 ? `, ${degraded} of them at the top level or inside an import/export` : ''}: ${sample}${issues.length > 3 ? '; …' : ''}. Their valid symbols were kept, but the extraction may be incomplete`);
  }
  const configProblems = project.configProblems ?? [];
  if (configProblems.length > 0) {
    const sample = configProblems.slice(0, 3).map(safe).join(', ');
    reasons.push(`configuration was unavailable (${sample}${configProblems.length > 3 ? ', …' : ''}), so path aliases, workspace packages or entry points may be missing`);
  }
  return `Analysis is PARTIAL: ${reasons.join('; ')}. Findings that depend on seeing every file are marked low confidence.`;
}

const countOf = (findings: Finding[]): number => findings.reduce((n, f) => n + f.count, 0);

const SKIP_TEXT: Record<SkipReason, string> = {
  'over-limit': 'over the comparison limit',
  'baseline-unreadable': 'base version unreadable',
  'baseline-too-large': 'base version too large',
  'baseline-unparseable': 'base version could not be parsed',
};

function partialNotice(v: Validation): string {
  const lines = ['PARTIAL VALIDATION: the baseline could not be rebuilt completely, so what follows is provisional, not a definitive list of introduced or fixed problems.'];
  for (const reason of v.partialReasons) lines.push(`- ${safe(reason)}`);
  const c = v.coverage;
  if (c) {
    lines.push(`- Compared ${c.evaluated.length} of ${c.relevantChanges} changed source file(s) (limit ${c.limit}).`);
    if (c.skipped.length > 0) {
      const sample = c.skipped.slice(0, 5).map((s) => `${safe(s.path)} (${SKIP_TEXT[s.reason]})`).join(', ');
      lines.push(`- Not compared (${c.skipped.length}): ${sample}${c.skipped.length > 5 ? ', …' : ''}`);
    }
  }
  return lines.join('\n');
}

export function renderValidation(v: Validation, options: { includeExisting?: boolean; scopes?: string[] } = {}): string {
  const scopes = options.scopes ?? [];
  const inScope = <T extends Finding>(list: T[]): T[] =>
    scopes.length === 0 ? list : list.filter((f) => scopes.some((s) => f.file === s || f.file.startsWith(`${s}/`)));
  const out: string[] = [];

  if (v.scope === 'workspace') {
    out.push(`Scope: whole workspace. Could not isolate your changes: ${v.fallback}.`);
    out.push(renderFindings(inScope(v.introduced)));
    return out.join('\n\n');
  }

  const kinds = new Map<string, number>();
  for (const c of v.changes) kinds.set(c.status, (kinds.get(c.status) ?? 0) + 1);
  const summary = [...kinds].map(([status, n]) => `${n} ${status}`).join(', ') || 'no source files changed';
  out.push(`Scope: changes against ${safe(v.baseLabel ?? 'HEAD')}, ${summary}.`);
  if (v.partial) out.push(partialNotice(v));
  for (const note of v.baselineNotes) out.push(`Note: ${safe(note)}`);

  const introduced = inScope(v.introduced);
  const direct = introduced.filter((f) => f.inChangedFile);
  const indirect = introduced.filter((f) => !f.inChangedFile);
  const heading = v.partial ? 'Possibly introduced by this change (provisional)' : 'Introduced by this change';

  out.push(introduced.length === 0 ? `## ${heading} (0)\n${v.partial ? 'None found in the part that could be compared.' : 'No new problems.'}` : `## ${heading} (${introduced.length})\n${renderFindings(direct.length > 0 ? direct : introduced, 15, true)}`);
  if (direct.length > 0 && indirect.length > 0) {
    out.push(`## Caused in files you did not edit (${indirect.length})\n${renderFindings(indirect, 15, true)}`);
  }
  if (v.fixed.length > 0) out.push(v.partial ? `Possibly fixed by this change (provisional): ${v.fixed.length} finding(s).` : `Fixed by this change: ${v.fixed.length} finding(s).`);

  const existing = inScope(v.existing);
  if (options.includeExisting) out.push(`## Pre-existing (${existing.length})\n${renderFindings(existing)}`);
  else if (existing.length > 0) out.push(`Pre-existing findings not shown: ${existing.length} (${countOf(existing)} occurrences). Pass include_existing to list them.`);
  return out.join('\n\n');
}
