import { execFile } from 'node:child_process';
import { out } from '../output.js';
import os from 'node:os';
import { promisify } from 'node:util';
import { resolvePolicy, describePolicy } from '../../core/llm/policy.js';
import { loadEnv } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';

const run = promisify(execFile);

type Check = { name: string; ok: boolean; detail: string; required: boolean };

async function sqlite(): Promise<string> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  try {
    return `SQLite ${(db.prepare('select sqlite_version() as v').get() as { v: string }).v}`;
  } finally {
    db.close();
  }
}

async function treeSitter(): Promise<string> {
  const { loadLanguages, parseFile } = await import('../../core/ast/parser.js');
  await loadLanguages(['typescript', 'tsx', 'javascript', 'python']);
  const info = parseFile('probe.ts', 'typescript', 'export const probe = 1;\n');
  if (!info || info.symbols.length !== 1) throw new Error('parser returned no symbols');
  return 'grammars load and parse';
}

async function git(): Promise<string> {
  const { stdout } = await run('git', ['--version']);
  return stdout.trim();
}

async function attempt(name: string, required: boolean, work: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await work(), required };
  } catch (err) {
    return { name, ok: false, detail: errorMessage(err), required };
  }
}

export async function doctor(): Promise<void> {
  loadEnv();
  const major = Number(process.versions.node.split('.')[0]);
  const checks = [
    { name: 'Node.js', ok: major >= 22, detail: `${process.version} on ${os.platform()}-${os.arch()}${major >= 22 ? '' : ' (22 or newer is required)'}`, required: true },
    await attempt('better-sqlite3', true, sqlite),
    await attempt('tree-sitter', true, treeSitter),
    await attempt('git', false, git),
  ];

  for (const c of checks) out(`${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.name}: ${c.detail}`);
  out(`\n${describePolicy(resolvePolicy({ llm: true }))}`);
  if (checks.some((c) => c.required && !c.ok)) process.exitCode = 1;
  else if (!checks[3].ok) out('git is missing: validate_rules and check will fall back to scanning the whole workspace.');
}
