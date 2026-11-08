import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PROFILES, RULES } from '../core/ast/rules.js';
import { checkMaskPattern } from '../core/security/masker.js';
import { readOptionalInside } from '../core/security/sandbox.js';
import { log } from './logger.js';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const configFileName = '.guardianrc';

const schema = z.strictObject({
  ignore: z.array(z.string().max(200)).max(100).default([]),
  maxFiles: z.number().int().min(1).max(20000).default(5000),
  maxFileKb: z.number().int().min(1).max(2048).default(512),
  // Resource limits for indexing. When one is hit the scan stops, says so, and is reported as partial; files already
  // processed stay cached, so the next call continues from there.
  // maxDiscoveryEntries caps the entries PROCESSED, in sorted order. It does not cap the entries READ: choosing the first N
  // names of a directory in name order means reading that whole directory (the time limit bounds that), while memory is
  // bounded separately, by what is retained. maxDiscoveryMs and maxIndexMs are cooperative: they are checked between units of
  // work, so one file system call or one parse can overrun them (see README, "Resource limits").
  maxDiscoveryEntries: z.number().int().min(100).max(10_000_000).default(500_000),
  maxDiscoveryMs: z.number().int().min(100).max(600_000).default(20_000),
  maxIndexMs: z.number().int().min(100).max(600_000).default(30_000),
  contextTokens: z.number().int().min(500).max(32000).default(4000),
  llm: z.boolean().default(true),
  pythonRoots: z.array(z.string().max(200)).max(20).default(['', 'src']),
  // Framework profile for entry points: 'auto' detects it from package.json dependencies, 'none' trusts only entryPoints.
  profile: z.enum(PROFILES).default('auto'),
  // Gitignore-style patterns for files loaded by something other than an import (plugins, routes, scripts, DI).
  entryPoints: z.array(z.string().min(1).max(200)).max(100).default([]),
  // Severity per rule, or 'off'.
  rules: z.partialRecord(z.enum(RULES), z.enum(['off', 'low', 'medium', 'high'])).default({}),
  // Project-specific exceptions: a finding of `rule` in files matching `path` (and mentioning `symbol`, if given) is not reported.
  exceptions: z
    .array(z.strictObject({ rule: z.enum(RULES), path: z.string().min(1).max(200), symbol: z.string().min(1).max(100).optional() }))
    .max(200)
    .default([]),
  // Fail closed: refuse to send an external request whose content could not be verified as free of secrets.
  strictOutbound: z.boolean().default(false),
  maskPatterns: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[\w-]{1,40}$/),
        pattern: z.string().superRefine((value, ctx) => {
          const problem = checkMaskPattern(value);
          if (problem) ctx.addIssue({ code: 'custom', message: `pattern ${problem}` });
        }),
      }),
    )
    .max(20)
    .default([]),
  maskLiterals: z.array(z.string().min(6).max(200)).max(50).default([]),
});

export type Config = z.infer<typeof schema>;

// Keys come from the tool's own .env, never from the workspace being analysed.
export function loadEnv(): void {
  const file = process.env.GUARDIAN_ENV_FILE ?? path.join(packageRoot, '.env');
  if (!fs.existsSync(file)) return;
  try {
    if (process.platform !== 'win32' && fs.statSync(file).mode & 0o077) {
      log.warn(`${file} is readable by other users, run: chmod 600 "${file}"`);
    }
    process.loadEnvFile(file);
  } catch (err) {
    log.warn(`Could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

export function parseConfig(raw: unknown): Config {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${configFileName}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const MAX_CONFIG_BYTES = 64 * 1024;

export function parseConfigText(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${configFileName} is not valid JSON`);
  }
  return parseConfig(raw);
}

// The workspace config goes through the same sandbox as every other workspace read.
export function loadConfig(root: string): Config {
  const data = readOptionalInside(root, configFileName, MAX_CONFIG_BYTES);
  return data === null ? parseConfig({}) : parseConfigText(data.toString('utf8'));
}

export function llmEnabled(config: Config): boolean {
  return config.llm && process.env.GUARDIAN_LLM?.toLowerCase() !== 'off';
}
