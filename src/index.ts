import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { closeDb } from './db/client.js';
import { terminateGitChildren } from './core/git/git.js';
import { createServer } from './mcp/server.js';
import { errorCode } from './utils/errors.js';
import { log } from './utils/logger.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export async function startServer(rootArg?: string): Promise<void> {
  const ctx = createContext(rootArg);
  const server = createServer(ctx, version);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Running git processes would otherwise outlive the server: their timeout and cancellation signal die with it.
    terminateGitChildren();
    try {
      closeDb(ctx.db);
    } catch (err) {
      log.error('Closing the cache failed:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  process.stdout.on('error', (err) => (errorCode(err) === 'EPIPE' ? shutdown() : log.error(err)));
  // After an uncaught exception or an unhandled rejection the process state is unknown (a half-finished write, a stuck
  // request). Log it, close the cache and exit non-zero instead of serving further requests from that state; the MCP client
  // restarts the server. Tool errors are handled per request and never reach here.
  const fatal = (what: string) => (reason: unknown) => {
    log.error(`${what}:`, reason);
    terminateGitChildren();
    if (!closing) {
      closing = true;
      try {
        closeDb(ctx.db);
      } catch (err) {
        log.error('Closing the cache failed:', err);
      }
    }
    process.exit(1);
  };
  process.on('unhandledRejection', fatal('Unhandled rejection'));
  process.on('uncaughtException', fatal('Uncaught exception'));

  server.server.onerror = (err) => log.error('Protocol error:', err);
  server.server.onclose = shutdown;

  await server.connect(new StdioServerTransport());
  log.info(`MCP server ready, workspace: ${ctx.root}`);
}
