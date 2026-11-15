import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { indexProject } from '../src/core/ast/indexer.js';
import { RESOURCE_CEILINGS, effectiveLimit, loadConfig, parseConfig, parseConfigText, type ResourceLimit } from '../src/utils/config.js';
import { cleanup, context, workspace } from './helpers.js';

// .guardianrc is controlled by the repository being analysed. It may lower the resource limits but must never raise them past
// the trusted ceilings that live in the application.

after(cleanup);

const names = Object.keys(RESOURCE_CEILINGS) as ResourceLimit[];
const rc = (settings: unknown): string => JSON.stringify(settings);

test('a normal configuration, and a missing one, keep the documented defaults', () => {
  const none = parseConfig({});
  assert.deepEqual([none.maxFiles, none.maxFileKb, none.maxDiscoveryEntries, none.maxDiscoveryMs, none.maxIndexMs], [5000, 512, 500_000, 20_000, 30_000]);
  const some = parseConfig({ maxFiles: 100, maxIndexMs: 5000 });
  assert.equal(some.maxFiles, 100);
  assert.equal(some.maxIndexMs, 5000);
  assert.equal(some.maxFileKb, 512, 'settings that are not given keep their defaults');
  for (const name of names) assert.ok(none[name] <= RESOURCE_CEILINGS[name], `${name}: the default is within its ceiling`);
});

test('every ceiling is accepted exactly, and one above it is refused with the setting named', () => {
  for (const name of names) {
    assert.equal(parseConfig({ [name]: RESOURCE_CEILINGS[name] })[name], RESOURCE_CEILINGS[name], `${name} at its ceiling`);
    assert.throws(() => parseConfig({ [name]: RESOURCE_CEILINGS[name] + 1 }), new RegExp(name), `${name} above its ceiling`);
  }
});

test('lowering a limit is always allowed down to its minimum', () => {
  assert.equal(parseConfig({ maxFiles: 1 }).maxFiles, 1);
  assert.equal(parseConfig({ maxFileKb: 1 }).maxFileKb, 1);
  assert.equal(parseConfig({ maxDiscoveryEntries: 100 }).maxDiscoveryEntries, 100);
  assert.equal(parseConfig({ maxDiscoveryMs: 100 }).maxDiscoveryMs, 100);
  assert.equal(parseConfig({ maxIndexMs: 100 }).maxIndexMs, 100);
});

test('negative, zero, non-integer, non-finite and extremely large values are refused', () => {
  for (const name of names) {
    for (const bad of [-1, 0, -RESOURCE_CEILINGS[name], 1.5, Number.MAX_SAFE_INTEGER, 1e308, Number.MAX_VALUE]) {
      assert.throws(() => parseConfig({ [name]: bad }), new RegExp(name), `${name}=${bad}`);
    }
    // JSON cannot carry Infinity or NaN, but a caller of parseConfig can pass them.
    for (const bad of [Infinity, -Infinity, NaN]) assert.throws(() => parseConfig({ [name]: bad }), new RegExp(name), `${name}=${bad}`);
  }
  assert.throws(() => parseConfigText('{"maxIndexMs": 1e400}'), /maxIndexMs|not valid JSON/);
});

test('values of the wrong type are refused', () => {
  for (const name of names) {
    for (const bad of ['100', '1e9', null, true, [], {}, [100]]) assert.throws(() => parseConfig({ [name]: bad }), new RegExp(name), `${name}=${JSON.stringify(bad)}`);
  }
});

test('configuration loaded from an untrusted repository cannot raise a limit', () => {
  for (const name of names) {
    const root = workspace({ '.guardianrc': rc({ [name]: RESOURCE_CEILINGS[name] * 10 }) });
    assert.throws(() => loadConfig(root), new RegExp(name), `${name} above its ceiling in a repository file`);
  }
  const old = workspace({ '.guardianrc': rc({ maxIndexMs: 600_000, maxFileKb: 2048, maxDiscoveryEntries: 10_000_000 }) });
  assert.throws(() => loadConfig(old), /maxIndexMs/, 'the former maxima are no longer accepted');
  const lowering = workspace({ '.guardianrc': rc({ maxFiles: 10, maxIndexMs: 1000 }) });
  assert.equal(loadConfig(lowering).maxFiles, 10);
  assert.equal(loadConfig(lowering).maxIndexMs, 1000);
});

test('effectiveLimit bounds a config that was built without the schema', () => {
  for (const name of names) {
    assert.equal(effectiveLimit({ [name]: RESOURCE_CEILINGS[name] * 100 }, name), RESOURCE_CEILINGS[name]);
    assert.equal(effectiveLimit({ [name]: Number.MAX_VALUE }, name), RESOURCE_CEILINGS[name]);
    assert.equal(effectiveLimit({ [name]: Infinity }, name), RESOURCE_CEILINGS[name]);
    assert.equal(effectiveLimit({ [name]: 100 }, name), 100, 'a lower value passes through');
    for (const bad of [undefined, null, NaN, '5', {}]) assert.equal(effectiveLimit({ [name]: bad }, name), parseConfig({})[name], `${name}=${String(bad)} falls back to the default`);
  }
  assert.equal(effectiveLimit({ maxIndexMs: -1 }, 'maxIndexMs'), -1, 'an already-expired deadline stays expired');
});

test('the indexer works within the ceilings even when handed an oversized config', async () => {
  const root = workspace({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });
  const ctx = context(root, { maxFiles: Number.MAX_SAFE_INTEGER, maxFileKb: Number.MAX_SAFE_INTEGER, maxDiscoveryEntries: Infinity, maxDiscoveryMs: 1e12, maxIndexMs: 1e12 });
  const project = await indexProject(ctx);
  assert.equal(project.files.length, 2);
  assert.equal(project.complete, true);

  // The ceiling on file size is enforced even though the config asked for far more.
  const big = workspace({ 'big.ts': `export const x = "${'a'.repeat((RESOURCE_CEILINGS.maxFileKb + 1) * 1024)}";\n`, 'small.ts': 'export const s = 1;\n' });
  const bounded = await indexProject(context(big, { maxFileKb: Number.MAX_SAFE_INTEGER }));
  assert.deepEqual(bounded.files.map((f) => f.path), ['small.ts']);
  assert.ok(bounded.skipped.some((s) => s.path === 'big.ts' && s.reason === 'too-large'));
});
