import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { analyzeProject } from '../../core/ast/analysis.js';
import { indexProject } from '../../core/ast/indexer.js';
import { resolvePolicy } from '../../core/llm/policy.js';
import { MAX_PROMPT_CHARS, describeLlm, refinePrompt } from '../../core/prompt/refiner.js';
import { InputError } from '../../utils/errors.js';
import { describeTokens } from '../../utils/tokens.js';
import { indexNotes, reply } from './result.js';

const inputSchema = {
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS).describe('The developer request to turn into a precise, codebase-aware task.'),
};

export function registerOptimizePrompt(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'optimize_prompt',
    {
      title: 'Optimize prompt',
      description:
        'Adds codebase context to a coding request: the existing functions and modules to reuse, constraints against duplication and bloat, ' +
        'and the acceptance criteria found in the request. The original request is kept verbatim. Call it first for any request that adds or changes code.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ prompt }, extra) =>
      reply(async () => {
        if (!prompt.trim()) throw new InputError('The prompt is empty');
        const project = await indexProject(ctx, { signal: extra.signal });
        const { graph } = analyzeProject(project, ctx.config);
        const refined = await refinePrompt(ctx, project, graph, prompt, resolvePolicy(ctx.config));

        const notes = [describeTokens({ sent: refined.sentTokens, baseline: refined.baselineTokens, baselineFiles: refined.baselineFiles, truncated: false })];
        notes.push(describeLlm(refined), ...indexNotes(project, ctx));
        if (refined.redactions > 0) notes.push(`${refined.redactions} secret(s) were redacted.`);
        return `${refined.text}\n\n${notes.join(' ')}`;
      }),
  );
}
