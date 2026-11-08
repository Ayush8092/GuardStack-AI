import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { analyzeProject } from '../../core/ast/analysis.js';
import { indexProject } from '../../core/ast/indexer.js';
import { findReusable, renderFind } from '../../core/prompt/find.js';
import { indexNotes, reply } from './result.js';

const inputSchema = {
  query: z.string().min(1).max(2000).describe('What you are about to write, in plain words or with identifiers, e.g. "format a date for display".'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum number of candidates (default 8).'),
};

export function registerFindReusable(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'find_reusable_code',
    {
      title: 'Find reusable code',
      description:
        'Looks up existing functions and classes in this workspace that match what you are about to write, with the reason each one matched. ' +
        'Runs locally and never contacts a model. Says so plainly when nothing matches, so do not invent a helper in that case.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ query, limit }, extra) =>
      reply(async () => {
        const project = await indexProject(ctx, { signal: extra.signal });
        const { graph } = analyzeProject(project, ctx.config);
        return [renderFind(findReusable(project, graph, query, limit ?? 8)), ...indexNotes(project, ctx)].join('\n\n');
      }),
  );
}
