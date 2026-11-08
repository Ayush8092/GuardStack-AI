import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { analyzeProject } from '../../core/ast/analysis.js';
import { indexProject } from '../../core/ast/indexer.js';
import { buildContext } from '../../core/prompt/compressor.js';
import { resolveInside, toRelative } from '../../core/security/sandbox.js';
import { recordUsage } from '../../db/client.js';
import { describeTokens } from '../../utils/tokens.js';
import { indexNotes, reply } from './result.js';

const inputSchema = {
  query: z.string().max(500).optional().describe('What you are about to build. Files and symbols related to it are listed first.'),
  paths: z.array(z.string().max(300)).max(20).optional().describe('Limit the map to these files or folders (relative to the workspace).'),
  max_tokens: z.number().int().min(500).max(16000).optional().describe('Size budget for the map.'),
};

export function registerGetContext(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'get_codebase_context',
    {
      title: 'Get codebase context',
      description:
        'Returns a compact map of the files, exported functions, classes and types that already exist in this workspace. ' +
        'Call it before writing new code so existing helpers are reused instead of duplicated.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ query, paths, max_tokens }, extra) =>
      reply(async () => {
        const project = await indexProject(ctx, { signal: extra.signal });
        const { graph } = analyzeProject(project, ctx.config);
        const scopes = (paths ?? []).map((p) => toRelative(ctx.root, resolveInside(ctx.root, p)));
        const built = buildContext(project, graph, { query, paths: scopes, budgetTokens: max_tokens ?? ctx.config.contextTokens });
        recordUsage(ctx.db, 'get_codebase_context', built.baselineTokens, built.sentTokens);

        const notes = [
          describeTokens({ sent: built.sentTokens, baseline: built.baselineTokens, baselineFiles: built.includedFiles, truncated: built.truncated }),
        ];
        if (built.omittedFiles > 0) notes.push(`${built.omittedFiles} file(s) did not fit the budget.`);
        if (built.symbolsDropped > 0) notes.push(`${built.symbolsDropped} export(s) were cut from partially listed files.`);
        if (built.redactions > 0) notes.push(`${built.redactions} secret(s) were redacted.`);
        notes.push(...indexNotes(project, ctx));
        return `${built.text}\n\n${notes.join(' ')}`;
      }),
  );
}
