// Heuristic only: about four bytes per token. Every figure shown to a user is labelled "estimated".
export const tokensFromBytes = (bytes: number): number => Math.ceil(bytes / 4);

export const estimateTokens = (text: string): number => tokensFromBytes(Buffer.byteLength(text));

export type TokenReport = {
  sent: number;
  // What the model would otherwise have to read: the referenced files in full (plus the prompt, for optimize_prompt).
  baseline: number;
  baselineFiles: number;
  truncated: boolean;
};

export function describeTokens(report: TokenReport): string {
  const { sent, baseline, baselineFiles, truncated } = report;
  const cut = truncated ? ' Output was truncated to fit the token budget.' : '';

  if (baselineFiles === 0) return `~${sent} estimated tokens (no referenced files to compare against).${cut}`;
  const files = `${baselineFiles} referenced file${baselineFiles === 1 ? '' : 's'}`;
  if (baseline <= sent) return `~${sent} estimated tokens, no saving compared with reading the ${files} in full (~${baseline}).${cut}`;

  const pct = Math.round((1 - sent / baseline) * 100);
  return `~${sent} estimated tokens instead of ~${baseline} for reading the ${files} in full (${pct}% fewer).${cut}`;
}
