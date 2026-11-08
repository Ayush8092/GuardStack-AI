import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { indexProject } from '../../core/ast/indexer.js';
import { renderValidation } from '../../core/ast/report.js';
import { resolveInside, toRelative } from '../../core/security/sandbox.js';
import { validateProject } from '../../core/validation/delta.js';
import { indexNotes, reply } from './result.js';

const inputSchema = {
  paths: z.array(z.string().max(300)).max(20).optional().describe('Only report findings in these files or folders (relative to the workspace).'),
  base: z.string().max(200).optional().describe('Git ref to compare against, for example main. Defaults to HEAD, so staged, unstaged and untracked changes are checked.'),
  include_existing: z.boolean().optional().describe('Also list findings that were already there before your changes.'),
};

export function registerValidateRules(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'validate_rules',
    {
      title: 'Validate your changes',
      description:
        'Checks what you just changed in git for duplicate functions, circular dependencies, unused imports, orphan files, unused exports and suppressed type or lint errors ' +
        '(@ts-ignore, eslint-disable, any, # noqa, # type: ignore). Only problems introduced by your changes are reported; pre-existing ones are counted, not listed. ' +
        'Outside a git repository the whole workspace is checked. Call it after making changes.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ paths, base, include_existing }, extra) =>
      reply(async () => {
        const project = await indexProject(ctx, { signal: extra.signal });
        const scopes = (paths ?? []).map((p) => toRelative(ctx.root, resolveInside(ctx.root, p))).filter(Boolean);
        const { validation } = await validateProject(ctx, project, { base });
        const body = renderValidation(validation, { includeExisting: include_existing, scopes });
        const notes = indexNotes(project, ctx);
        return notes.length > 0 ? `${body}\n\n${notes.join(' ')}` : body;
      }),
  );
}
