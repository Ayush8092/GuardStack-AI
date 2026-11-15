import ignore from 'ignore';
import type { Finding, Severity } from '../ast/analysis.js';
import type { Rule } from '../ast/rules.js';
import type { Change } from '../git/git.js';

// Findings can disappear for two different reasons: the code was fixed, or the project's own configuration was changed so
// the check no longer looks. A change can edit .guardianrc (or .gitignore) in the same commit as the code it is judged on,
// so the weakening is detected by comparing the effective configuration at the base commit with the working tree, and
// every finding that vanished because of it is kept apart from the real fixes.

export type DowngradeKind =
  | 'rule-disabled'
  | 'severity-lowered'
  | 'ignore-added'
  | 'exception-added'
  | 'entry-point-added'
  | 'files-excluded'
  | 'profile-changed'
  | 'python-roots-added'
  | 'outbound-weakened';

export type ConfigDowngrade = {
  kind: DowngradeKind;
  detail: string;
};

type ExceptionRule = { rule: Rule; path: string; symbol?: string | undefined };

// The part of the configuration that decides what the checks look at. Structurally a subset of Config.
export type PolicyView = {
  ignore: readonly string[];
  rules: Partial<Record<Rule, string>>;
  exceptions: readonly ExceptionRule[];
  entryPoints: readonly string[];
  // Optional so a view built from an older shape still works; an absent field is treated as unchanged.
  profile?: string | undefined;
  pythonRoots?: readonly string[] | undefined;
  strictOutbound?: boolean | undefined;
  maskPatterns?: readonly { name: string; pattern: string }[] | undefined;
  maskLiterals?: readonly string[] | undefined;
};

export type PolicyResult = {
  downgrades: ConfigDowngrade[];
  // Findings present at the base that are gone now only because of a downgrade above, not because the code was fixed.
  suppressed: Finding[];
  // What is left of `fixed` once those are taken out.
  fixed: Finding[];
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const MAX_LISTED = 5;
// A configured level replaces a finding's own severity. An unset rule counts as 'high' here, the strongest it can be,
// so setting it to medium or low is reported as a possible lowering (the default of some rules is already lower).
const levelRank = (level: string | undefined): number => (level === 'high' || level === 'medium' || level === 'low' ? RANK[level] : 0);

// 'src/', './src' and 'src' are the same root, and '.' and '' are the project root.
const rootKey = (root: string): string => root.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, '');
const PYTHON_FILE = /\.pyi?$/i;
const PYTHON_RESOLUTION_RULES = new Set<string>(['unresolved-import', 'orphan-file', 'dead-export']);
const ENTRY_RULES = new Set<string>(['orphan-file', 'dead-export']);

const sample = (items: string[]): string => `${items.slice(0, MAX_LISTED).join(', ')}${items.length > MAX_LISTED ? `, and ${items.length - MAX_LISTED} more` : ''}`;
const exceptionKey = (e: ExceptionRule): string => `${e.rule}\u0000${e.path}\u0000${e.symbol ?? ''}`;
const added = <T>(now: readonly T[], before: readonly T[], key: (item: T) => string): T[] => {
  const had = new Set(before.map(key));
  return now.filter((item) => !had.has(key(item)));
};

// Source files that were analysed at the base and still exist, but are no longer eligible: excluded by an ignore pattern,
// .gitignore or similar. A file that was deleted or renamed away is a code change, not an exclusion.
export function excludedFiles(basePaths: readonly string[], eligibleNow: readonly string[], changes: readonly Change[]): string[] {
  const now = new Set(eligibleNow);
  const gone = new Set<string>();
  for (const c of changes) {
    if (c.status === 'deleted') gone.add(c.path);
    if (c.status === 'renamed' && c.oldPath) gone.add(c.oldPath);
  }
  return basePaths.filter((p) => !now.has(p) && !gone.has(p));
}

export type PolicyInput = {
  before: PolicyView;
  now: PolicyView;
  // Source files analysed at the base commit and the ones eligible now. Leave `excluded` out when the current scan did not
  // see every path (a stopped scan), because an unseen file would look excluded.
  excluded?: string[];
  fixed: Finding[];
  // Findings that exist both before and now, with their severity before the change.
  lowered: { finding: Finding; was: Severity }[];
};

export function assessPolicy(input: PolicyInput): PolicyResult {
  const { before, now } = input;
  const downgrades: ConfigDowngrade[] = [];

  const disabled = (Object.entries(now.rules) as [Rule, string][]).filter(([rule, level]) => level === 'off' && before.rules[rule] !== 'off').map(([rule]) => rule);
  if (disabled.length > 0) downgrades.push({ kind: 'rule-disabled', detail: `rule(s) turned off: ${disabled.sort().join(', ')}` });

  const byRule = new Map<string, number>();
  for (const { finding } of input.lowered) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
  if (byRule.size > 0) {
    const parts = [...byRule].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rule, n]) => `${rule} (${n} finding(s))`);
    downgrades.push({ kind: 'severity-lowered', detail: `severity lowered for existing findings of: ${parts.join(', ')}` });
  }

  // A rule whose configured severity went down, even if no current finding shows it yet: --fail-on and every later
  // report read that level.
  const reduced = (Object.entries(now.rules) as [Rule, string][])
    .filter(([rule, level]) => level !== 'off' && before.rules[rule] !== 'off' && levelRank(level) > levelRank(before.rules[rule]))
    .map(([rule]) => rule);
  const reducedFromFindings = new Set(input.lowered.map(({ finding }) => finding.rule as string));
  const reducedOnly = reduced.filter((rule) => !reducedFromFindings.has(rule));
  if (reducedOnly.length > 0) downgrades.push({ kind: 'severity-lowered', detail: `configured severity lowered for rule(s): ${reducedOnly.sort().join(', ')}` });

  // profile decides which files count as entry points. Moving to 'none' only makes the check stricter; any other change can
  // add entry points and hide unused-file and unused-export findings.
  const profileWeakened = now.profile !== undefined && before.profile !== undefined && now.profile !== before.profile && now.profile !== 'none';
  if (profileWeakened) downgrades.push({ kind: 'profile-changed', detail: `profile changed from ${before.profile} to ${now.profile} (it can add entry points that hide unused-file and unused-export findings; review it)` });

  // pythonRoots decide how Python imports resolve. A root that was not there before can make unresolved imports resolve and
  // make files look referenced; removing a root can only do the opposite.
  const hadRoots = new Set((before.pythonRoots ?? []).map(rootKey));
  const newRoots = now.pythonRoots === undefined || before.pythonRoots === undefined ? [] : [...new Set(now.pythonRoots.map(rootKey))].filter((r) => !hadRoots.has(r));
  if (newRoots.length > 0) downgrades.push({ kind: 'python-roots-added', detail: `pythonRoots added: ${sample(newRoots.map((r) => r || '(project root)'))} (they change how Python imports resolve; review them)` });

  // Protection for what leaves the machine: strict mode switched off, or masking rules and literals removed.
  const outbound: string[] = [];
  if (before.strictOutbound === true && now.strictOutbound === false) outbound.push('strictOutbound turned off');
  const patternsNow = new Set((now.maskPatterns ?? []).map((m) => `${m.name}\u0000${m.pattern}`));
  const patternsLost = (before.maskPatterns ?? []).filter((m) => !patternsNow.has(`${m.name}\u0000${m.pattern}`));
  if (now.maskPatterns !== undefined && patternsLost.length > 0) outbound.push(`maskPatterns removed: ${sample(patternsLost.map((m) => m.name))}`);
  const literalsNow = new Set(now.maskLiterals ?? []);
  const literalsLost = (before.maskLiterals ?? []).filter((l) => !literalsNow.has(l));
  if (now.maskLiterals !== undefined && literalsLost.length > 0) outbound.push(`${literalsLost.length} maskLiterals entr${literalsLost.length === 1 ? 'y' : 'ies'} removed`);
  if (outbound.length > 0) downgrades.push({ kind: 'outbound-weakened', detail: `outbound protection weakened: ${outbound.join('; ')}` });

  const newIgnores = added(now.ignore, before.ignore, (p) => p);
  if (newIgnores.length > 0) downgrades.push({ kind: 'ignore-added', detail: `ignore pattern(s) added: ${sample(newIgnores)}` });

  const newExceptions = added(now.exceptions, before.exceptions, exceptionKey);
  if (newExceptions.length > 0) downgrades.push({ kind: 'exception-added', detail: `exception(s) added: ${sample(newExceptions.map((e) => `${e.rule} in ${e.path}${e.symbol ? ` for ${e.symbol}` : ''}`))}` });

  const newEntries = added(now.entryPoints, before.entryPoints, (p) => p);
  if (newEntries.length > 0) downgrades.push({ kind: 'entry-point-added', detail: `entry point pattern(s) added (they hide unused-file and unused-export findings): ${sample(newEntries)}` });

  const excluded = new Set(input.excluded ?? []);
  if (excluded.size > 0) downgrades.push({ kind: 'files-excluded', detail: `${excluded.size} source file(s) analysed at the base commit are no longer analysed: ${sample([...excluded].sort())}` });

  // A vanished finding counts as suppressed when something above explains it; anything else stays a real fix.
  const disabledRules = new Set<string>(disabled);
  const exceptionMatchers = newExceptions.map((e) => ({ e, matcher: ignore().add(e.path) }));
  const entryMatcher = ignore().add(newEntries);
  const explained = (f: Finding): boolean => {
    if (disabledRules.has(f.rule) || excluded.has(f.file)) return true;
    if (ENTRY_RULES.has(f.rule) && newEntries.length > 0 && entryMatcher.ignores(f.file)) return true;
    // Which files a changed profile or new Python root now covers is not recomputed here: every finding of the rules it
    // can affect that vanished alongside it is kept out of "fixed", the safe side of an unavoidable guess.
    if (profileWeakened && ENTRY_RULES.has(f.rule)) return true;
    if (newRoots.length > 0 && PYTHON_RESOLUTION_RULES.has(f.rule) && PYTHON_FILE.test(f.file)) return true;
    return exceptionMatchers.some(({ e, matcher }) => e.rule === f.rule && matcher.ignores(f.file) && (!e.symbol || f.message.includes(e.symbol) || f.key.includes(e.symbol)));
  };

  const suppressed: Finding[] = [];
  const fixed: Finding[] = [];
  for (const f of input.fixed) (explained(f) ? suppressed : fixed).push(f);
  return { downgrades, suppressed, fixed };
}

// Existing findings whose severity is lower than it was at the base commit.
export function loweredSeverities(before: Finding[], after: Finding[]): { finding: Finding; was: Severity }[] {
  const was = new Map(before.map((f) => [f.key, f]));
  const lowered: { finding: Finding; was: Severity }[] = [];
  for (const finding of after) {
    const previous = was.get(finding.key);
    if (previous && RANK[finding.severity] > RANK[previous.severity]) lowered.push({ finding, was: previous.severity });
  }
  return lowered;
}
