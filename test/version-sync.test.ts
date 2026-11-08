// package.json and package-lock.json must describe the same package: a stale lockfile root makes `npm ci` and the
// published metadata disagree about which version this is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('package.json and package-lock.json agree on name, version and direct dependencies', () => {
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version, 'the lockfile top-level version is stale');
  assert.equal(lock.packages[''].version, pkg.version, 'the lockfile root package version is stale');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
});
