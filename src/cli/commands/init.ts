import { out, err as err_ } from '../output.js';
import path from 'node:path';
import { prepareStateDir } from '../../db/client.js';
import { UnsafeFileError } from '../../core/security/safe-file.js';
import { resolveWorkspaceRoot } from '../../core/security/sandbox.js';
import { configFileName, loadEnv, packageRoot } from '../../utils/config.js';
import { describePolicy, resolvePolicy } from '../../core/llm/policy.js';
import { loadConfig } from '../../utils/config.js';
import { errorCode, errorMessage } from '../../utils/errors.js';
import { ensureConfig, ensureGitignore } from './init-files.js';

const NUDGE =
  'Before writing or changing code, call the CodeGuardian tool optimize_prompt with the task and follow its "Reuse existing code" list. ' +
  'After making changes, call validate_rules and fix what it reports.';

function attempt(label: string, work: () => void): boolean {
  try {
    work();
    return true;
  } catch (err) {
    if (err instanceof UnsafeFileError) {
      // A link or special file where a plain file belongs: report it, leave it untouched and fail the command.
      err_(`Refusing to ${label}: ${err.message}. The file was left untouched; remove it or replace it with a regular file.`);
      process.exitCode = 2;
      return false;
    }
    err_(`Could not ${label}: ${errorCode(err) ?? errorMessage(err)}`);
    return false;
  }
}

export function init(rootArg?: string): void {
  loadEnv();
  const root = resolveWorkspaceRoot(rootArg ?? process.env.GUARDIAN_ROOT ?? process.cwd());

  out(`Workspace: ${root}`);
  const cacheReady = prepareStateDir(root) !== null;
  out(`Cache:     ${cacheReady ? '.guardian/ ready' : 'unavailable, an in-memory cache will be used'}`);
  if (attempt(`create ${configFileName}`, () => ensureConfig(root, configFileName))) out(`Config:    ${configFileName} ready`);
  attempt('update .gitignore', () => ensureGitignore(root));

  out(`Gemini key: ${process.env.GEMINI_API_KEY ? 'set' : 'not set'}`);
  out(`Groq key:   ${process.env.GROQ_API_KEY ? 'set' : 'not set'}`);
  out(`\nPrivacy:    ${describePolicy(resolvePolicy(loadConfig(root)))}`);
  out('            To allow the optional external step, set GUARDIAN_LLM=on and add a key. Run "guardian optimize --dry-run" to see exactly what would be sent.');

  const cli = path.join(packageRoot, 'bin', 'cli.js');
  const mcpConfig = { mcpServers: { codeguardian: { command: 'node', args: [cli, 'serve', '--root', root] } } };

  out('\nClaude Code:');
  out(`  claude mcp add codeguardian -- node ${cli} serve`);
  out('\nClaude Desktop / Cursor (add to the MCP servers config):');
  out(JSON.stringify(mcpConfig, null, 2));
  out('\nAdd this to CLAUDE.md or .cursorrules so the assistant actually calls the tools:');
  out(`  ${NUDGE}`);
}
