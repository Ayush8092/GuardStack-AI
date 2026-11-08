import { createContext } from '../../context.js';
import { out, err } from '../output.js';
import { analyzeProject } from '../../core/ast/analysis.js';
import { indexProject } from '../../core/ast/indexer.js';
import { resolvePolicy } from '../../core/llm/policy.js';
import { describeLlm, refinePrompt } from '../../core/prompt/refiner.js';
import { closeDb } from '../../db/client.js';
import { describeTokens } from '../../utils/tokens.js';

const MAX_STDIN_BYTES = 64 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('Prompt on stdin is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function optimize(promptArg: string | undefined, opts: { root?: string; llm: boolean; dryRun?: boolean }): Promise<void> {
  if (!promptArg && process.stdin.isTTY) throw new Error('Pass the prompt as an argument or pipe it on stdin');
  const prompt = (promptArg ?? (await readStdin())).trim();
  if (!prompt) throw new Error('The prompt is empty');

  const ctx = createContext(opts.root);
  try {
    const project = await indexProject(ctx);
    const { graph } = analyzeProject(project, ctx.config);
    const policy = resolvePolicy(ctx.config, { disabled: !opts.llm });
    const refined = await refinePrompt(ctx, project, graph, prompt, policy, { dryRun: opts.dryRun });

    if (opts.dryRun) {
      if (refined.payload) {
        out('--- system ---\n' + refined.payload.system + '\n--- message (secrets already masked) ---\n' + refined.payload.prompt);
        err(`\n${refined.payload.redactions} secret(s) were redacted from this payload.`);
      } else {
        out('Nothing would be sent: fully local mode.');
      }
      err(describeLlm(refined));
      return;
    }

    out(refined.text);
    err(`\n${describeTokens({ sent: refined.sentTokens, baseline: refined.baselineTokens, baselineFiles: refined.baselineFiles, truncated: false })}`);
    err(describeLlm(refined));
    if (refined.redactions > 0) err(`${refined.redactions} secret(s) were redacted.`);
  } finally {
    closeDb(ctx.db);
  }
}
