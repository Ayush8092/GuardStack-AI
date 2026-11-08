import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Ctx } from '../../context.js';
import { describeCoverage } from '../../core/ast/report.js';
import type { Project } from '../../core/ast/indexer.js';
import { maskSecrets } from '../../core/security/masker.js';
import { InputError, errorMessage } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import { isAbort } from '../../utils/pace.js';

const INTERNAL_MESSAGE = 'CodeGuardian could not complete this request. Details were written to the server log.';

function failure(err: unknown): CallToolResult {
  const known = err instanceof InputError;
  // A cancelled request is not a fault: the client asked to stop, and indexing kept what it had already cached.
  if (isAbort(err)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'cancelled', message: 'The request was cancelled.' } }) }] };
  if (!known) log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));

  const error = {
    code: known ? err.code : 'internal_error',
    message: maskSecrets(known ? errorMessage(err) : INTERNAL_MESSAGE).text,
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
}

// Every byte returned to an MCP client leaves through here, so masking here covers all tools.
export async function reply(work: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: maskSecrets(await work()).text }] };
  } catch (err) {
    return failure(err);
  }
}

export function indexNotes(project: Project, ctx: Ctx): string[] {
  return project.complete ? [] : [describeCoverage(project, ctx.config.maxFiles)];
}
