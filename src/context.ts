import { configureMasking } from './core/security/masker.js';
import { resolveWorkspaceRoot } from './core/security/sandbox.js';
import { openDb, type Db } from './db/client.js';
import { loadConfig, loadEnv, type Config } from './utils/config.js';

export type Ctx = {
  root: string;
  config: Config;
  db: Db;
};

export function createContext(rootArg?: string): Ctx {
  loadEnv();
  const root = resolveWorkspaceRoot(rootArg ?? process.env.GUARDIAN_ROOT ?? process.cwd());
  const config = loadConfig(root);
  configureMasking({ patterns: config.maskPatterns, literals: config.maskLiterals });
  return { root, config, db: openDb(root) };
}
