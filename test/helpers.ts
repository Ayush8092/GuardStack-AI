import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/context.js';
import type { FileInfo, Lang } from '../src/core/ast/types.js';
import { closeDb, openDb } from '../src/db/client.js';
import { loadConfig, type Config } from '../src/utils/config.js';

const created: string[] = [];
const open: Ctx[] = [];

export function workspace(files: Record<string, string | Buffer> = {}, prefix = 'guardian-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

export function write(root: string, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

export function context(root: string, overrides: Partial<Config> = {}): Ctx {
  const ctx: Ctx = { root, config: { ...loadConfig(root), ...overrides }, db: openDb(root) };
  open.push(ctx);
  return ctx;
}

export function cleanup(): void {
  for (const ctx of open.splice(0)) closeDb(ctx.db);
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function info(filePath: string, lang: Lang = 'typescript'): FileInfo {
  return { path: filePath, lang, bytes: 100, lines: 5, symbols: [], imports: [], reexports: [], unusedImports: [], suppressions: [], dynamicLoads: [], decorated: false, script: false };
}

// Creating symlinks needs a privilege on some Windows setups. A test that needs one is skipped (and shown as skipped) only
// when the platform refuses to create it; if the link can be made, the test runs and must pass.
export const symlinksWork: string | false = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-symlink-probe-'));

  try {
    const targetDir = path.join(dir, 'target-dir');
    const targetFile = path.join(dir, 'target.txt');

    fs.mkdirSync(targetDir);
    fs.writeFileSync(targetFile, 'test');

    fs.symlinkSync(targetDir, path.join(dir, 'directory-link'), 'dir');
    fs.symlinkSync(targetFile, path.join(dir, 'file-link'), 'file');

    return false;
  } catch {
    return 'this platform cannot create the required directory and file symlinks here';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();