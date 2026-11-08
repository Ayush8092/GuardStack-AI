import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { analyzeProject } from '../src/core/ast/analysis.js';
import { indexProject } from '../src/core/ast/indexer.js';
import { cleanup, context, workspace } from './helpers.js';
import { fixtures } from './fixtures/projects.js';

after(cleanup);

// Rules whose output has an unambiguous ground truth in these fixtures.
const SCORED = new Set(['orphan-file', 'dead-export', 'unused-import', 'circular-dependency', 'unresolved-import', 'suppression', 'duplicate-body', 'similar-structure']);

type Score = { name: string; truePositives: number; falsePositives: string[]; falseNegatives: string[]; tpKeys: string[]; knownMisses: string[]; nowDetected: string[] };
const ruleOf = (key: string): string => key.split('|')[0] as string;

async function score(fixture: (typeof fixtures)[number]): Promise<Score> {
  const ctx = context(workspace(fixture.files), fixture.config);
  const { findings } = analyzeProject(await indexProject(ctx), ctx.config);
  const scored = findings.filter((f) => SCORED.has(f.rule));
  const reported = new Set(scored.map((f) => f.key));
  const expected = new Set(fixture.expected);
  const possible = new Set(fixture.possible ?? []);
  // A "possible" finding is fine as long as it never claims to be confidently unused.
  const overclaimed = scored.filter((f) => possible.has(f.key) && f.classification === 'confidently-unused').map((f) => f.key);
  return {
    name: fixture.name,
    truePositives: [...reported].filter((k) => expected.has(k)).length,
    tpKeys: [...reported].filter((k) => expected.has(k)),
    knownMisses: (fixture.knownMisses ?? []).filter((k) => !reported.has(k)),
    nowDetected: (fixture.knownMisses ?? []).filter((k) => reported.has(k)),
    falsePositives: [...[...reported].filter((k) => !expected.has(k) && !possible.has(k) && !(fixture.knownMisses ?? []).includes(k)), ...overclaimed].sort(),
    falseNegatives: [...expected].filter((k) => !reported.has(k)).sort(),
  };
}

test('findings match hand-labelled ground truth on representative projects (false positives and false negatives)', async () => {
  const rows: string[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let known = 0;
  const failures: string[] = [];
  const perRule = new Map<string, { tp: number; fp: number; fn: number }>();
  const bump = (rule: string, field: 'tp' | 'fp' | 'fn', n: number): void => {
    const row = perRule.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
    row[field] += n;
    perRule.set(rule, row);
  };

  for (const fixture of fixtures) {
    const s = await score(fixture);
    for (const k of s.tpKeys) bump(ruleOf(k), 'tp', 1);
    for (const k of s.falsePositives) bump(ruleOf(k), 'fp', 1);
    for (const k of s.falseNegatives) bump(ruleOf(k), 'fn', 1);
    tp += s.truePositives;
    fp += s.falsePositives.length;
    fn += s.falseNegatives.length;
    const total = s.truePositives + s.falsePositives.length;
    rows.push(`${s.name.padEnd(68)} tp=${s.truePositives} fp=${s.falsePositives.length} fn=${s.falseNegatives.length} precision=${total ? (s.truePositives / total).toFixed(2) : 'n/a'}`);
    for (const k of s.knownMisses) bump(ruleOf(k), 'fn', 1);
    known += s.knownMisses.length;
    if (s.nowDetected.length) failures.push(`${s.name}: documented misses are now detected, move them to expected: ${JSON.stringify(s.nowDetected)}`);
    if (s.falsePositives.length) failures.push(`${s.name}: false positives ${JSON.stringify(s.falsePositives)}`);
    if (s.falseNegatives.length) failures.push(`${s.name}: false negatives ${JSON.stringify(s.falseNegatives)}`);
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn + known || 1);
  const rules = [...perRule].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rule, r]) => `${rule.padEnd(22)} tp=${r.tp} fp=${r.fp} fn=${r.fn}`);
  console.log(`\n${rows.join('\n')}\n\nPer rule:\n${rules.join('\n')}\nOVERALL tp=${tp} fp=${fp} fn=${fn} (+${known} documented misses) precision=${precision.toFixed(2)} recall=${recall.toFixed(2)}\n`);
  assert.deepEqual(failures, []);
});
