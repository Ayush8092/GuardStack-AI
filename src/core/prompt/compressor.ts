import path from 'node:path';
import { estimateTokens, tokensFromBytes } from '../../utils/tokens.js';
import { compareText } from '../../utils/text.js';
import { isTest, type Graph } from '../ast/analysis.js';
import type { Project } from '../ast/indexer.js';
import type { FileInfo } from '../ast/types.js';
import { maskSecrets } from '../security/masker.js';
import { DAY_ONE_RULES } from './guidelines.js';
import { retrieve } from './relevance.js';
import { promptLine, promptText, REPOSITORY_DATA_NOTICE } from './untrusted.js';

export type BuiltContext = {
  text: string;
  sentTokens: number;
  // Reading every file that appears in the map, in full.
  baselineTokens: number;
  includedFiles: number;
  omittedFiles: number;
  symbolsDropped: number;
  truncated: boolean;
  day1: boolean;
  redactions: number;
};

const DAY_ONE_MAX_FILES = 4;
const OMITTED_RESERVE = 60;
const MIN_PARTIAL_BLOCK = 60;

export function isDayOne(files: FileInfo[]): boolean {
  return files.filter((f) => !isTest(f.path)).length < DAY_ONE_MAX_FILES;
}

export function describeSymbol(file: FileInfo, signature: string, exportName?: string): string {
  return `${promptLine(file.path)}: ${exportName === 'default' ? 'default ' : ''}${promptText(signature)}`;
}

function exportedLines(file: FileInfo): string[] {
  return file.symbols
    .filter((s) => s.exportName && s.kind !== 'reexport')
    .map((s) => `  ${s.exportName === 'default' ? 'default ' : ''}${promptLine(s.signature)}`);
}

function languageCounts(files: FileInfo[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = f.lang === 'tsx' ? 'typescript' : f.lang;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts].map(([lang, n]) => `${lang} ${n}`).join(', ');
}

function summarizeOmitted(files: FileInfo[]): string {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.posix.dirname(f.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path.posix.basename(f.path)]);
  }
  return [...byDir]
    .slice(0, 8)
    .map(([dir, names]) => `${promptLine(dir)}/: ${names.slice(0, 3).map(promptText).join(', ')}${names.length > 3 ? ` (+${names.length - 3})` : ''}`)
    .join('\n');
}

type Options = { query?: string; paths?: string[]; budgetTokens: number };

type Packed = { parts: string[]; used: number; included: FileInfo[]; omitted: FileInfo[]; symbolsDropped: number };

// Adds file blocks in order until the budget is spent. A block that does not fit is cut down instead of skipped when there is room.
function pack(ordered: FileInfo[], startUsed: number, limit: number): Packed {
  const packed: Packed = { parts: [], used: startUsed, included: [], omitted: [], symbolsDropped: 0 };

  for (const file of ordered) {
    const lines = exportedLines(file);
    if (lines.length === 0) continue;

    const full = [promptLine(file.path), ...lines].join('\n');
    const cost = estimateTokens(full) + 1;
    if (packed.used + cost <= limit) {
      packed.parts.push(full);
      packed.used += cost;
      packed.included.push(file);
      continue;
    }

    const room = limit - packed.used;
    if (room >= MIN_PARTIAL_BLOCK) {
      const kept: string[] = [];
      let spent = estimateTokens(promptLine(file.path)) + 8;
      for (const line of lines) {
        const next = estimateTokens(line) + 1;
        if (spent + next > room) break;
        kept.push(line);
        spent += next;
      }
      if (kept.length > 0) {
        packed.parts.push([promptLine(file.path), ...kept, `  … +${lines.length - kept.length} more exports`].join('\n'));
        packed.used += spent;
        packed.included.push(file);
        packed.symbolsDropped += lines.length - kept.length;
        continue;
      }
    }
    packed.omitted.push(file);
  }
  return packed;
}

export function buildContext(project: Project, graph: Graph, options: Options): BuiltContext {
  const scopes = (options.paths ?? []).filter(Boolean);
  const files = project.files.filter(
    (f) => !isTest(f.path) && (scopes.length === 0 || scopes.some((p) => f.path === p || f.path.startsWith(`${p}/`))),
  );
  const day1 = isDayOne(project.files);
  const query = (options.query ?? '').trim();

  const popularity = new Map(graph.nodes.map((n) => [n.id, n.importedBy]));
  const ordered = query
    ? retrieve(files, graph, query).files.map((r) => r.file)
    : [...files].sort((a, b) => (popularity.get(b.path) ?? 0) - (popularity.get(a.path) ?? 0) || compareText(a.path, b.path));

  const head: string[] = [];
  if (day1) head.push('# New workspace\n' + DAY_ONE_RULES.map((rule) => `- ${rule}`).join('\n'));
  else head.push(`# Codebase map: ${files.length} files (${languageCounts(files)}). Exported symbols only. ${REPOSITORY_DATA_NOTICE}`);

  const headCost = estimateTokens(head.join('\n\n'));
  const packed = pack(ordered, headCost, Math.max(options.budgetTokens - OMITTED_RESERVE, headCost));

  const parts = [...head];
  if (packed.parts.length > 0) parts.push(day1 ? `# Existing code (${REPOSITORY_DATA_NOTICE})\n${packed.parts.join('\n')}` : packed.parts.join('\n'));
  if (packed.omitted.length > 0) {
    const detail = summarizeOmitted(packed.omitted);
    const withDetail = `# ${packed.omitted.length} more files left out to stay within budget\n${detail}`;
    const summary = packed.used + estimateTokens(withDetail) <= options.budgetTokens ? withDetail : `# ${packed.omitted.length} more files left out to stay within budget`;
    parts.push(summary);
  }

  const masked = maskSecrets(parts.join('\n\n'));
  const baselineBytes = packed.included.reduce((total, f) => total + f.bytes, 0);
  return {
    text: masked.text,
    sentTokens: estimateTokens(masked.text),
    baselineTokens: tokensFromBytes(baselineBytes),
    includedFiles: packed.included.length,
    omittedFiles: packed.omitted.length,
    symbolsDropped: packed.symbolsDropped,
    truncated: packed.omitted.length > 0 || packed.symbolsDropped > 0,
    day1,
    redactions: masked.count,
  };
}
