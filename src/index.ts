import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { closeDb } from './db/client.js';
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
    closeDb(ctx.db);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  process.stdout.on('error', (err) => (errorCode(err) === 'EPIPE' ? shutdown() : log.error(err)));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection:', reason));
  process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));

  server.server.onerror = (err) => log.error('Protocol error:', err);
  server.server.onclose = shutdown;

  await server.connect(new StdioServerTransport());
  log.info(`MCP server ready, workspace: ${ctx.root}`);
}
