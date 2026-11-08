import type { Ctx } from '../../context.js';
import { analyze, analyzeProject, type Analysis, type Finding } from '../ast/analysis.js';
import { languageOf, type Project } from '../ast/indexer.js';
import { loadLanguages, parseFile } from '../ast/parser.js';
import type { FileInfo } from '../ast/types.js';
import { collectChanges, detectRepo, readBlob, type Change } from '../git/git.js';
import { compareText } from '../../utils/text.js';
import { TSCONFIG_NAME } from '../ast/tsconfig.js';
import { configFileName } from '../../utils/config.js';
import { reconstructBaseline, type BaselineRules } from './baseline.js';

export type Introduced = Finding & { inChangedFile: boolean };

export type SkipReason = 'over-limit' | 'baseline-unreadable' | 'baseline-too-large' | 'baseline-unparseable';
export type SkippedFile = { path: string; reason: SkipReason };

// What the comparison actually looked at. Anything in `skipped` makes the result provisional.
export type ValidationCoverage = {
  relevantChanges: number;
  evaluated: string[];
  skipped: SkippedFile[];
  limit: number;
};

export type Validation = {
  scope: 'changes' | 'workspace';
  // Set when the tool could not isolate changes and fell back to the whole workspace.
  fallback?: string;
  baseLabel?: string;
  changes: Change[];
  introduced: Introduced[];
  fixed: Finding[];
  existing: Finding[];
  // True when the baseline could not be rebuilt completely. Introduced and fixed are then provisional.
  partial: boolean;
  partialReasons: string[];
  coverage?: ValidationCoverage;
  baselineNotes: string[];
};

export const MAX_CHANGED_FILES = 400;

const FALLBACKS = {
  'git-not-found': 'git is not installed or not on PATH',
  'not-a-repository': 'this workspace is not a git repository',
} as const;

function countMap(findings: Finding[]): Map<string, Finding> {
  return new Map(findings.map((f) => [f.key, f]));
}

// Identity is the finding key, so line shifts caused by edits do not make old findings look new.
export function diffFindings(before: Finding[], after: Finding[], changedFiles: Set<string>): { introduced: Introduced[]; fixed: Finding[]; existing: Finding[] } {
  const was = countMap(before);
  const now = countMap(after);
  const introduced: Introduced[] = [];
  const existing: Finding[] = [];

  for (const finding of after) {
    const previous = was.get(finding.key);
    if (!previous) {
      introduced.push({ ...finding, inChangedFile: changedFiles.has(finding.file) });
    } else if (finding.count > previous.count) {
      const added = finding.count - previous.count;
      introduced.push({ ...finding, count: added, message: `${added} new (${previous.count} before): ${finding.message}`, inChangedFile: changedFiles.has(finding.file) });
    } else {
      existing.push(finding);
    }
  }

  const fixed = before.filter((f) => {
    const current = now.get(f.key);
    return !current || current.count < f.count;
  });
  return { introduced, fixed, existing };
}

type Baseline = {
  files: FileInfo[];
  known: string[];
  skipped: SkippedFile[];
  rules: BaselineRules | null;
  identify: (path: string) => string;
  notes: string[];
};

// Files that change how every other file is read: touching one invalidates the whole baseline, not just itself.
const isConfigFile = (p: string): boolean => TSCONFIG_NAME.test(p.split('/').pop() ?? '') || p === configFileName || p === '.gitignore' || ['package.json', 'pyproject.toml'].includes(p.split('/').pop() ?? '');

const basePathOf = (change: Change): string => (change.status === 'renamed' && change.oldPath ? change.oldPath : change.path);

// Rebuilds the project as it was at `sha`: the files tracked then, parsed from their content then, resolved with
// the tsconfig, ignore rules and path aliases that existed then. A renamed file comes back at its ORIGINAL path, so
// every import that pointed at it in the base still resolves, and its findings are matched to the new path by identity.
async function buildBaseline(ctx: Ctx, project: Project, evaluated: Change[], overflow: Change[], sha: string, limit: number): Promise<Baseline> {
  const maxBytes = ctx.config.maxFileKb * 1024;
  const current = new Map(project.files.map((f) => [f.path, f]));
  const files = new Map<string, FileInfo>();
  const skipped: SkippedFile[] = overflow.map((c) => ({ path: c.path, reason: 'over-limit' }));
  const notes: string[] = [];
  const renames = new Map<string, string>();
  let reads = 0;

  const rules = await reconstructBaseline(ctx, sha, project);
  if (rules) notes.push(...rules.notes);
  else notes.push('The file list and configuration at the base commit could not be read; they were approximated from the working tree.');

  const restore = async (rel: string): Promise<void> => {
    const lang = languageOf(rel);
    if (!lang) return;
    reads++;
    const blob = await readBlob(ctx.root, sha, rel, maxBytes);
    if (!blob.ok) {
      skipped.push({ path: rel, reason: blob.reason === 'too-large' ? 'baseline-too-large' : 'baseline-unreadable' });
      return;
    }
    if (blob.data.length === 0) return;
    await loadLanguages([lang]);
    const info = parseFile(rel, lang, blob.data.toString('utf8').replace(/^\uFEFF/, ''));
    if (info) files.set(rel, info);
    else skipped.push({ path: rel, reason: 'baseline-unparseable' });
  };

  const evaluatedByBase = new Map<string, Change>();
  for (const change of evaluated) {
    if (change.status === 'added') continue;
    evaluatedByBase.set(basePathOf(change), change);
    if (change.status === 'renamed' && change.oldPath) renames.set(change.oldPath, change.path);
  }
  const overflowByBase = new Set(overflow.filter((c) => c.status !== 'added').map(basePathOf));

  if (rules) {
    for (const rel of rules.paths) {
      if (evaluatedByBase.has(rel)) {
        await restore(rel);
        continue;
      }
      const existing = current.get(rel);
      if (existing) {
        files.set(rel, existing);
      } else if (overflowByBase.has(rel) || reads >= limit) {
        // Tracked at the base but absent from today's index, and no budget left to read it back.
        if (!overflowByBase.has(rel)) skipped.push({ path: rel, reason: 'over-limit' });
      } else {
        await restore(rel);
      }
    }
  } else {
    for (const f of project.files) files.set(f.path, f);
    for (const change of evaluated) {
      if (change.status === 'added') files.delete(change.path);
      else if (change.status === 'renamed' && change.oldPath) {
        files.delete(change.path);
        await restore(change.oldPath);
      } else {
        files.delete(change.path);
        await restore(change.path);
      }
    }
  }

  const known = rules
    ? rules.paths
    : [...new Set([...project.knownPaths.filter((p) => !evaluated.some((c) => c.status !== 'deleted' && c.path === p && (c.status === 'added' || c.status === 'renamed'))), ...evaluated.map(basePathOf).filter((p) => files.has(p))])].sort(compareText);

  return {
    files: [...files.values()].sort((a, b) => compareText(a.path, b.path)),
    known,
    skipped: skipped.sort((a, b) => compareText(a.path, b.path) || compareText(a.reason, b.reason)),
    rules,
    identify: (p) => renames.get(p) ?? p,
    notes,
  };
}

export type ValidateOptions = { base?: string; maxChangedFiles?: number };

export async function validateChanges(ctx: Ctx, project: Project, current: Analysis, options: ValidateOptions = {}): Promise<Validation> {
  const limit = options.maxChangedFiles ?? MAX_CHANGED_FILES;
  const indexReasons = (): string[] => {
    if (project.complete) return [];
    const unavailable = project.configProblems.map((p) => `Configuration unavailable in the working tree: ${p}.`);
    const reasons = [...unavailable];
    if (project.stopped) reasons.push('A resource limit stopped the scan, so the working tree was only partly indexed.');
    if (project.parseIssues.length > 0) reasons.push(`${project.parseIssues.length} file(s) in the working tree have syntax errors, so their extraction may be incomplete.`);
    return reasons.length > 0 ? reasons : ['The working tree was only partly indexed (see the coverage notes).'];
  };

  const whole = (fallback: string): Validation => ({
    scope: 'workspace',
    fallback,
    changes: [],
    introduced: current.findings.map((f) => ({ ...f, inChangedFile: false })),
    fixed: [],
    existing: [],
    partial: !project.complete,
    partialReasons: indexReasons(),
    baselineNotes: [],
  });

  const repo = await detectRepo(ctx.root);
  if (!repo.ok) return whole(`${FALLBACKS[repo.reason]}, so existing findings cannot be told apart from new ones`);

  const set = await collectChanges(ctx.root, repo, options.base);
  const relevant = set.changes.filter((c) => languageOf(c.path) || (c.oldPath && languageOf(c.oldPath)));
  const evaluated = relevant.slice(0, limit);
  const overflow = relevant.slice(limit);
  const changedFiles = new Set(evaluated.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])));

  const coverage = (skipped: SkippedFile[]): ValidationCoverage => ({
    relevantChanges: relevant.length,
    evaluated: evaluated.map((c) => c.path),
    skipped,
    limit,
  });

  const configTouched = set.changes.filter((c) => isConfigFile(c.path) || (c.oldPath !== undefined && isConfigFile(c.oldPath)));

  if (evaluated.length === 0 && configTouched.length === 0) {
    return { scope: 'changes', baseLabel: set.baseLabel, changes: [], introduced: [], fixed: [], existing: current.findings, partial: !project.complete, partialReasons: indexReasons(), coverage: coverage([]), baselineNotes: [] };
  }

  const base: Baseline = set.baseSha
    ? await buildBaseline(ctx, project, evaluated, overflow, set.baseSha, limit)
    : { files: [], known: [], skipped: [], rules: null, identify: (p) => p, notes: [] };

  const before = analyze(base.files, {
    identify: base.identify,
    tsconfigs: base.rules?.tsconfigs ?? project.tsconfigs,
    packages: base.rules?.packages ?? project.packages,
    foreignExtensions: base.rules?.foreignExtensions ?? project.foreignExtensions,
    pythonRoots: base.rules?.config.pythonRoots ?? ctx.config.pythonRoots,
    known: base.known,
    complete: project.complete && base.skipped.length === 0 && (base.rules?.unreconstructable.length ?? 0) === 0,
    config: base.rules?.config ?? ctx.config,
  });

  const { introduced, fixed, existing } = diffFindings(before.findings, current.findings, changedFiles);

  const reasons = indexReasons();
  if (overflow.length > 0) reasons.push(`${relevant.length} source files changed but only the first ${limit} were compared; the other ${overflow.length} were not restored from the base commit.`);
  const unreadable = base.skipped.filter((s) => s.reason !== 'over-limit');
  if (unreadable.length > 0) reasons.push(`${unreadable.length} file(s) could not be read back from the base commit.`);
  if (!base.rules && set.baseSha) reasons.push('The base commit file list could not be read.');
  for (const problem of base.rules?.unreconstructable ?? []) reasons.push(`Base configuration not reconstructed: ${problem}.`);

  return {
    scope: 'changes',
    baseLabel: set.baseLabel,
    changes: evaluated,
    introduced,
    fixed,
    existing,
    partial: reasons.length > 0,
    partialReasons: reasons,
    coverage: coverage(base.skipped),
    baselineNotes: base.notes,
  };
}

export async function validateProject(ctx: Ctx, project: Project, options: ValidateOptions = {}): Promise<{ analysis: Analysis; validation: Validation }> {
  const analysis = analyzeProject(project, ctx.config);
  return { analysis, validation: await validateChanges(ctx, project, analysis, options) };
}
