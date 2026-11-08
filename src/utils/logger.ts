import { maskSecrets } from '../core/security/masker.js';

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

function threshold(): number {
  const name = process.env.GUARDIAN_LOG;
  return levels[name && name in levels ? (name as Level) : 'warn'];
}

// stdout carries the MCP protocol, so every diagnostic line goes to stderr
function write(level: Level, args: unknown[]): void {
  if (levels[level] < threshold()) return;
  const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  process.stderr.write(`[guardian:${level}] ${maskSecrets(line).text}\n`);
}

export const log = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
