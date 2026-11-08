import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ignore from 'ignore';

const root = path.resolve('.');
const SKIP = new Set(['node_modules', 'dist', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) walk(full, out);
  }
  return out;
}

const ARTIFACT = /(^|\/)\.guardian\/|\.(?:db|db-journal|db-shm|db-wal|sqlite|log|tgz)$|(^|\/)\.DS_Store$/;

test('the source tree holds no generated databases, caches, logs or tarballs', () => {
  const found = walk(root).filter((p) => ARTIFACT.test(p));
  assert.deepEqual(found, [], `remove these runtime artifacts and keep them ignored: ${found.join(', ')}`);
});

test('.gitignore covers every kind of runtime artifact, and keeps .env.example tracked', () => {
  const rules = ignore().add(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  for (const artifact of ['.guardian/cache.db', 'test/fixtures/.guardian/cache.db', 'cache.db', 'x.db-wal', 'x.db-shm', 'x.db-journal', 'x.sqlite', 'debug.log', 'code-guardian-ai-0.3.0.tgz', '.env', '.env.local', 'dist/cli/index.js', 'node_modules/x/index.js']) {
    assert.ok(rules.ignores(artifact), `${artifact} must be ignored`);
  }
  assert.equal(rules.ignores('.env.example'), false);
  assert.equal(rules.ignores('src/db/client.ts'), false, 'source under src/db must stay tracked');
});

test('the published package whitelist excludes tests, sources and runtime state', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] };
  assert.deepEqual([...pkg.files].sort(), ['.env.example', 'LICENSE', 'README.md', 'bin', 'dist']);
});
