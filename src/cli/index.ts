import { createRequire } from 'node:module';
import { Command } from 'commander';
import { maskSecrets } from '../core/security/masker.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

// Commands load lazily so that "guardian doctor" can still report when a native module fails to load.
const program = new Command()
  .name('guardian')
  .description('Keeps AI coding assistants inside your codebase\'s real structure')
  .version(version)
  .option('-r, --root <dir>', 'workspace root (default: current directory)');

const root = (): string | undefined => program.opts<{ root?: string }>().root;

program
  .command('init')
  .description('set up the workspace and print MCP client config')
  .action(async () => (await import('./commands/init.js')).init(root()));

program
  .command('serve')
  .description('start the MCP server on stdio')
  .action(async () => (await import('../index.js')).startServer(root()));

program
  .command('doctor')
  .description('check that native modules, parsers and git work on this machine')
  .action(async () => (await import('./commands/doctor.js')).doctor());

program
  .command('scan')
  .description('find duplicates, cycles, unused imports, orphan files, unused exports and suppressed checks')
  .option('--json', 'print the full report with the dependency graph as JSON')
  .option('--explain', 'show the evidence and a recommended action under each finding')
  .action(async (opts: { json?: boolean; explain?: boolean }) => (await import('./commands/scan.js')).scan({ root: root(), ...opts }));

program
  .command('check')
  .description('report only the problems introduced by your uncommitted git changes')
  .option('--base <ref>', 'compare against this git ref instead of HEAD')
  .option('--all', 'also list pre-existing findings')
  .option('--json', 'print the result as JSON')
  .option('--fail-on <severity>', 'exit with code 1 if a new finding is at least this severe (high, medium, low)')
  .action(async (opts: { base?: string; all?: boolean; json?: boolean; failOn?: string }) =>
    (await import('./commands/check.js')).check({ root: root(), ...opts }),
  );

program
  .command('find <query...>')
  .description('look up existing code that could be reused for a task (local, no model)')
  .option('--json', 'print the result as JSON')
  .option('--limit <n>', 'maximum number of candidates (1-50, default 8)')
  .action(async (query: string[], opts: { json?: boolean; limit?: string }) =>
    (await import('./commands/find.js')).find(query.join(' '), { root: root(), ...opts }),
  );

program
  .command('optimize [prompt]')
  .description('add codebase context to a prompt (reads stdin if no prompt is given)')
  .option('--no-llm', 'do not contact any external model')
  .option('--dry-run', 'print the exact payload that would be sent externally, then exit without sending')
  .action(async (prompt: string | undefined, opts: { llm: boolean; dryRun?: boolean }) =>
    (await import('./commands/optimize.js')).optimize(prompt, { root: root(), llm: opts.llm, dryRun: opts.dryRun }),
  );

// Exit codes, the same on every platform: 0 success, 1 the check found something (check --fail-on, doctor), 2 usage or runtime error.
const usageExit = (err: { exitCode: number }): never => process.exit(err.exitCode === 0 ? 0 : 2);
program.exitOverride(usageExit);
for (const command of program.commands) command.exitOverride(usageExit);

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${maskSecrets(message).text}`);
  process.exit(2);
});
