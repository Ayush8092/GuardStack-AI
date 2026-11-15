import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Finding } from '../src/core/ast/analysis.js';
import { assessPolicy, type PolicyView } from '../src/core/validation/policy.js';

// assessPolicy is pure, so these tests need no repository. They cover the settings that decide what the checks look at
// and are not findings themselves: profile, pythonRoots, configured severities and the outbound protections.

const view = (over: Partial<PolicyView> = {}): PolicyView => ({ ignore: [], rules: {}, exceptions: [], entryPoints: [], profile: 'auto', pythonRoots: ['', 'src'], strictOutbound: false, maskPatterns: [], maskLiterals: [], ...over });

const finding = (rule: Finding['rule'], file: string, severity: Finding['severity'] = 'medium'): Finding => ({
  rule,
  severity,
  file,
  message: `${rule} in ${file}`,
  key: `${rule}:${file}`,
  count: 1,
  confidence: 'high',
  method: 'import-graph',
  evidence: [],
  remediation: '',
});

const assess = (before: PolicyView, now: PolicyView, fixed: Finding[] = [], lowered: { finding: Finding; was: Finding['severity'] }[] = []) => assessPolicy({ before, now, fixed, lowered });
const kinds = (r: { downgrades: { kind: string }[] }): string[] => r.downgrades.map((d) => d.kind).sort();
const names = (list: Finding[]): string[] => list.map((f) => f.key).sort();

// ---- profile ----

test('moving from profile none to a framework profile is a downgrade, and vanished unused-file findings are not fixes', () => {
  const gone = [finding('orphan-file', 'src/page.ts'), finding('dead-export', 'src/util.ts'), finding('suppression', 'src/old.ts')];
  const result = assess(view({ profile: 'none' }), view({ profile: 'next' }), gone);

  assert.deepEqual(kinds(result), ['profile-changed']);
  assert.deepEqual(names(result.suppressed), ['dead-export:src/util.ts', 'orphan-file:src/page.ts']);
  assert.deepEqual(names(result.fixed), ['suppression:src/old.ts'], 'a rule the profile cannot affect is still a real fix');
  assert.match(result.downgrades[0]?.detail ?? '', /none to next/);
});

test('moving from auto to a fixed framework profile is a downgrade', () => {
  assert.deepEqual(kinds(assess(view({ profile: 'auto' }), view({ profile: 'node' }))), ['profile-changed']);
});

test('moving to profile none (fewer entry points) or keeping the profile is not a downgrade', () => {
  assert.deepEqual(kinds(assess(view({ profile: 'next' }), view({ profile: 'none' }))), []);
  assert.deepEqual(kinds(assess(view({ profile: 'next' }), view({ profile: 'next' }))), []);
});

// ---- pythonRoots ----

test('adding a Python root is a downgrade; vanished Python resolution findings are not fixes, other languages are unaffected', () => {
  const gone = [finding('unresolved-import', 'app/main.py'), finding('orphan-file', 'lib/helper.py'), finding('unresolved-import', 'web/app.ts')];
  const result = assess(view({ pythonRoots: ['', 'src'] }), view({ pythonRoots: ['', 'src', 'lib'] }), gone);

  assert.deepEqual(kinds(result), ['python-roots-added']);
  assert.deepEqual(names(result.suppressed), ['orphan-file:lib/helper.py', 'unresolved-import:app/main.py']);
  assert.deepEqual(names(result.fixed), ['unresolved-import:web/app.ts']);
  assert.match(result.downgrades[0]?.detail ?? '', /lib/);
});

test('removing a Python root, or spelling the same roots differently, is not a downgrade', () => {
  assert.deepEqual(kinds(assess(view({ pythonRoots: ['', 'src'] }), view({ pythonRoots: [''] }))), []);
  assert.deepEqual(kinds(assess(view({ pythonRoots: ['', 'src'] }), view({ pythonRoots: ['.', './src/'] }))), []);
});

test('an added project-root entry is described readably', () => {
  const result = assess(view({ pythonRoots: ['src'] }), view({ pythonRoots: ['src', '.'] }));
  assert.deepEqual(kinds(result), ['python-roots-added']);
  assert.match(result.downgrades[0]?.detail ?? '', /project root/);
});

// ---- configured severities ----

test('lowering a configured severity is a downgrade even when no current finding shows it', () => {
  const result = assess(view({ rules: { suppression: 'high' } }), view({ rules: { suppression: 'low' } }));
  assert.deepEqual(kinds(result), ['severity-lowered']);
  assert.match(result.downgrades[0]?.detail ?? '', /suppression/);
});

test('setting a severity on a rule that had none counts as a possible lowering', () => {
  assert.deepEqual(kinds(assess(view(), view({ rules: { 'orphan-file': 'low' } }))), ['severity-lowered']);
  assert.deepEqual(kinds(assess(view(), view({ rules: { 'orphan-file': 'high' } }))), [], 'high is the strongest level');
});

test('raising a severity, or turning a rule from off to a level, is not a lowering', () => {
  assert.deepEqual(kinds(assess(view({ rules: { suppression: 'low' } }), view({ rules: { suppression: 'high' } }))), []);
  assert.deepEqual(kinds(assess(view({ rules: { suppression: 'off' } }), view({ rules: { suppression: 'low' } }))), []);
});

test('a severity lowering already shown by existing findings is reported once, not twice', () => {
  const f = finding('suppression', 'src/old.ts', 'low');
  const result = assess(view({ rules: { suppression: 'high' } }), view({ rules: { suppression: 'low' } }), [], [{ finding: f, was: 'high' }]);
  assert.equal(result.downgrades.filter((d) => d.kind === 'severity-lowered').length, 1);
});

// ---- outbound protection ----

test('turning strictOutbound off is a downgrade; turning it on is not', () => {
  assert.deepEqual(kinds(assess(view({ strictOutbound: true }), view({ strictOutbound: false }))), ['outbound-weakened']);
  assert.deepEqual(kinds(assess(view({ strictOutbound: false }), view({ strictOutbound: true }))), []);
});

test('removing a mask pattern or a mask literal is a downgrade; adding one is not', () => {
  const pattern = { name: 'internal-id', pattern: 'ID-\\d{6}' };
  const removedPattern = assess(view({ maskPatterns: [pattern] }), view({ maskPatterns: [] }));
  assert.deepEqual(kinds(removedPattern), ['outbound-weakened']);
  assert.match(removedPattern.downgrades[0]?.detail ?? '', /internal-id/);

  const removedLiteral = assess(view({ maskLiterals: ['super-secret-value'] }), view({ maskLiterals: [] }));
  assert.deepEqual(kinds(removedLiteral), ['outbound-weakened']);
  assert.doesNotMatch(removedLiteral.downgrades[0]?.detail ?? '', /super-secret-value/, 'the secret itself must not be echoed into reports');

  assert.deepEqual(kinds(assess(view(), view({ maskPatterns: [pattern], maskLiterals: ['super-secret-value'] }))), []);
});

test('a pattern that was edited counts as a removal of the old one', () => {
  const result = assess(view({ maskPatterns: [{ name: 'tok', pattern: 'tok_[a-z]{20}' }] }), view({ maskPatterns: [{ name: 'tok', pattern: 'tok_x' }] }));
  assert.deepEqual(kinds(result), ['outbound-weakened']);
});

// ---- compatibility ----

test('a view without the newer fields still works and reports nothing for them', () => {
  const old: PolicyView = { ignore: [], rules: {}, exceptions: [], entryPoints: [] };
  assert.deepEqual(kinds(assess(old, old)), []);
  assert.deepEqual(kinds(assess(old, view({ profile: 'next', pythonRoots: ['x'], strictOutbound: false }))), []);
});

test('an unchanged configuration reports nothing and keeps every fix', () => {
  const fixed = [finding('orphan-file', 'src/a.ts')];
  const result = assess(view(), view(), fixed);
  assert.deepEqual(result.downgrades, []);
  assert.deepEqual(names(result.fixed), ['orphan-file:src/a.ts']);
  assert.deepEqual(result.suppressed, []);
});
