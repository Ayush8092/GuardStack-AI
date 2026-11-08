import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';
import { registerFindReusable } from './tools/find-reusable.js';
import { registerGetContext } from './tools/get-context.js';
import { registerOptimizePrompt } from './tools/optimize-prompt.js';
import { registerValidateRules } from './tools/validate-rules.js';

// MCP is pull-based: the client decides whether and when to call these tools. Nothing here intercepts a prompt,
// so the instructions below only work if the assistant follows them.
const instructions = [
  'CodeGuardian keeps generated code consistent with the existing codebase.',
  'Before writing code, call find_reusable_code for each helper you are about to write, or optimize_prompt for the whole task.',
  'Reuse what they list instead of writing new functions. After your changes, call validate_rules.',
].join(' ');

export function createServer(ctx: Ctx, version: string): McpServer {
  const server = new McpServer({ name: 'codeguardian', version }, { instructions });
  registerGetContext(server, ctx);
  registerValidateRules(server, ctx);
  registerOptimizePrompt(server, ctx);
  registerFindReusable(server, ctx);
  return server;
}
