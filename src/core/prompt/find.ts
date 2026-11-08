import type { Graph } from '../ast/analysis.js';
import type { Project } from '../ast/indexer.js';
import { promptText, REPOSITORY_DATA_NOTICE } from './untrusted.js';
import { retrieve, type MatchStatus, type SymbolHit } from './relevance.js';

export type Candidate = {
  name: string;
  file: string;
  line: number;
  signature: string;
  exported: boolean;
  strength: SymbolHit['strength'];
  matchedIn: SymbolHit['via'];
  description?: string;
  score: number;
  reasons: string[];
};

// status: strong | weak | related | none. `omitted` is the number of further candidates that matched but did not fit under the limit.
export type FindResult = { query: string; confident: boolean; status: MatchStatus; candidates: Candidate[]; omitted: number; related: string[] };

// Local, read-only lookup of existing code that could be reused for a request. No model is involved.
export function findReusable(project: Project, graph: Graph, query: string, limit = 8): FindResult {
  const retrieval = retrieve(project.files, graph, query, limit);
  return {
    query,
    confident: retrieval.confident,
    status: retrieval.status,
    omitted: retrieval.omitted,
    candidates: retrieval.symbols.map((h) => ({
      name: h.sym.name,
      file: h.file.path,
      line: h.sym.line,
      signature: h.sym.signature,
      exported: !h.internal,
      strength: h.strength,
      matchedIn: h.via,
      ...(h.sym.doc ? { description: h.sym.doc } : {}),
      score: Math.round(h.score * 10) / 10,
      reasons: h.reasons,
    })),
    related: retrieval.related.map((r) => r.file.path),
  };
}

const NO_MATCH = 'No confident match: nothing in the indexed code matches this request. Search the project yourself before writing new code; do not assume a helper exists.';

export function renderFind(result: FindResult): string {
  const line = (c: Candidate): string => {
    const flags = [c.exported ? null : 'not exported: export it to reuse', c.matchedIn.length > 0 && !c.matchedIn.includes('name') ? `matched by ${c.matchedIn.join(' and ')}, not by name` : null].filter(Boolean).join(', ');
    const doc = c.description ? `\n    doc: ${promptText(c.description)}` : '';
    return `- ${promptText(c.file)}:${c.line}  ${promptText(c.signature)}${flags ? `  [${flags}]` : ''}${doc}\n    why: ${promptText(c.reasons.slice(0, 3).join('; '))}`;
  };
  const strong = result.candidates.filter((c) => c.strength === 'strong');
  const weak = result.candidates.filter((c) => c.strength === 'weak');
  const out: string[] = [];

  if (strong.length > 0) out.push('Strong matches (best first):', ...strong.map(line));
  if (weak.length > 0) {
    out.push(strong.length > 0 ? 'Weak matches (check before reusing):' : 'No confident match. Weak candidates only; check each before reusing:', ...weak.map(line));
  }
  if (result.omitted > 0) out.push(`${result.omitted} more weaker candidate(s) matched and were not shown; raise --limit to see them.`);
  if (result.related.length > 0) {
    out.push(result.candidates.length === 0 ? 'No confident match. No function matched by name, signature or description, but these files matched by path:' : 'Related files:', ...result.related.map((r) => `- ${promptText(r)}`));
  }
  return out.length > 0 ? [...out, '', REPOSITORY_DATA_NOTICE].join('\n') : NO_MATCH;
}
