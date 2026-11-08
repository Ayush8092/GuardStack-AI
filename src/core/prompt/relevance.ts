import { compareText } from '../../utils/text.js';
import { isTest, type Graph } from '../ast/analysis.js';
import type { FileInfo, Sym } from '../ast/types.js';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'add', 'use', 'make', 'new', 'get', 'set',
  'should', 'want', 'need', 'please', 'can', 'you', 'how', 'when', 'not', 'but', 'all', 'are', 'our', 'out',
  'has', 'have', 'will', 'also', 'then', 'than', 'just', 'like', 'code', 'file', 'files', 'function',
  'to', 'of', 'in', 'is', 'be', 'an', 'on', 'at', 'as', 'by', 'it', 'or', 'if', 'do', 'so', 'we', 'my', 'me', 'up', 'no',
  'create', 'update', 'fix', 'implement', 'change', 'build', 'write', 'show', 'must', 'each', 'every',
]);

const SYNONYM_GROUPS = [
  ['format', 'fmt', 'render', 'display', 'stringify', 'pretty'],
  ['date', 'time', 'datetime', 'timestamp', 'day', 'calendar'],
  ['user', 'account', 'profile', 'member', 'customer'],
  ['auth', 'login', 'signin', 'authenticate', 'session', 'token', 'credential'],
  ['delete', 'remove', 'destroy', 'drop', 'erase'],
  ['parse', 'decode', 'deserialize', 'read', 'load'],
  ['serialize', 'encode', 'dump', 'save', 'write'],
  ['error', 'exception', 'failure', 'fault'],
  ['config', 'configuration', 'settings', 'options', 'env', 'preferences'],
  ['request', 'http', 'fetch', 'client', 'api'],
  ['validate', 'check', 'verify', 'assert', 'sanitize', 'guard'],
  ['convert', 'transform', 'map', 'normalize', 'coerce'],
  ['cache', 'memoize', 'store', 'persist'],
  ['log', 'logger', 'logging', 'trace', 'debug'],
  ['path', 'dir', 'directory', 'folder', 'filename'],
  ['money', 'price', 'currency', 'amount', 'cost'],
];

const SYNONYMS = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYMS.set(word, new Set(group.filter((w) => w !== word)));
}

export type QueryTerm = { text: string; stem: string; weight: number; synonyms: string[] };
export type Query = { raw: string; terms: QueryTerm[]; identifiers: string[]; pathHints: string[] };

export function words(text: string): string[] {
  const split = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  // Two-letter words are kept (ok, id, db, io): they are real parts of names like isResponseOk. Common ones are stop words.
  return [...new Set(split.filter((w) => w.length >= 2 && !STOP_WORDS.has(w)))];
}

export function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ['ing', 'ed', 'es', 'ly', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

// Stage 1: turn free text into weighted terms, explicit identifiers and path hints.
export function understandQuery(raw: string): Query {
  const quoted = [...raw.matchAll(/`([^`\n]{2,80})`/g)].map((m) => m[1]);
  const identifiers = [
    ...new Set([
      ...quoted.filter((q) => /^[\w$.]+$/.test(q) && !q.includes('/')),
      ...(raw.match(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? []),
    ]),
  ];
  const pathHints = [...new Set(raw.match(/[\w.-]+(?:\/[\w.-]+)+(?:\.[a-z]{1,4})?/g) ?? [])].map((p) => p.replace(/^\.\//, ''));

  const emphasized = new Set(words([...identifiers, ...quoted].join(' ')));
  const terms = words(raw).map((text): QueryTerm => {
    const base = stem(text);
    const related = new Set([...(SYNONYMS.get(text) ?? []), ...(SYNONYMS.get(base) ?? [])]);
    return { text, stem: base, weight: emphasized.has(text) ? 1.6 : 1, synonyms: [...related] };
  });
  return { raw, terms, identifiers, pathHints };
}

type Match = 1 | 0.85 | 0.6 | 0;

function matchKind(term: QueryTerm, token: string): Match {
  if (token === term.text) return 1;
  if (stem(token) === term.stem) return 0.85;
  if (term.synonyms.includes(token)) return 0.6;
  if (Math.min(token.length, term.text.length) >= 4 && (token.startsWith(term.text) || term.text.startsWith(token))) return 0.6;
  return 0;
}

// `named` is true when the symbol's own name matched. Path-only matches still rank files but are not offered as reuse candidates.
// strong: the request names the symbol, mentions its file, or matches its name by stem or on two separate terms.
// weak: one loose (synonym or prefix) match in the name. Weak matches are suggestions, not recommendations.
export type SymbolHit = {
  file: FileInfo;
  sym: Sym;
  score: number;
  matched: string[];
  named: boolean;
  strength: 'strong' | 'weak';
  // Which parts of the symbol matched: its name, its signature (parameter and return types) or its doc comment.
  // A path-only match is not a reuse candidate, so it never appears here.
  via: ('name' | 'signature' | 'description')[];
  // Plain-language account of why this symbol was selected.
  reasons: string[];
  // Declared in the file but not exported, so reusing it means exporting it first.
  internal: boolean;
};
export type RankedFile = { file: FileInfo; score: number; direct: number; relevant: boolean; via: 'match' | 'dependency' | 'importer' | 'sibling' | 'prior' };
// `confident` is false when nothing in the project matched the request strongly: callers should say so instead of guessing.
// `omitted` counts candidates that matched but did not fit under the limit, so nothing is dropped without being counted.
// status: strong (at least one strong candidate), weak (candidates, none strong), related (no symbol matched but files
// did), none (nothing matched).
export type MatchStatus = 'strong' | 'weak' | 'related' | 'none';
export type Retrieval = { query: Query; files: RankedFile[]; symbols: SymbolHit[]; related: RankedFile[]; confident: boolean; omitted: number; status: MatchStatus };

type Doc = { file: FileInfo; sym: Sym; name: string[]; location: string[]; signature: string[]; description: string[]; internal: boolean };

const FIELD_WEIGHT = { name: 3, description: 1.5, location: 1, signature: 0.8 } as const;

const INTERNAL_KINDS = new Set(['function', 'class']);
const INTERNAL_PENALTY = 0.85;

// Exported symbols, plus functions and classes that are declared but not exported: a useful helper is worth finding
// even when reusing it means exporting it first.
function symbolDocs(files: FileInfo[]): Doc[] {
  const docs: Doc[] = [];
  for (const file of files) {
    const location = words(file.path.replace(/\.[a-z]+$/, ''));
    for (const sym of file.symbols) {
      if (sym.kind === 'reexport') continue;
      const internal = !sym.exportName;
      if (internal && (!INTERNAL_KINDS.has(sym.kind) || sym.name.startsWith('_'))) continue;
      docs.push({ file, sym, name: words(sym.name), location, signature: words(sym.signature.slice(0, 200)), description: words(sym.doc ?? ''), internal });
    }
  }
  return docs;
}

// Stage 2: score exported symbols with an IDF-weighted lexical match over name, location and signature.
export function matchSymbols(files: FileInfo[], query: Query): SymbolHit[] {
  const docs = symbolDocs(files);
  if (docs.length === 0 || (query.terms.length === 0 && query.identifiers.length === 0 && query.pathHints.length === 0)) return [];

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set([...doc.name, ...doc.location, ...doc.signature, ...doc.description])) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const idf = (token: string): number => Math.log(1 + (docs.length - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));

  const hits: SymbolHit[] = [];
  const lowerIdentifiers = new Set(query.identifiers.map((i) => i.toLowerCase()));

  for (const doc of docs) {
    let score = 0;
    let named = false;
    let strongTerms = 0;
    let nameTerms = 0;
    let descriptionTerms = 0;
    let termsMatched = 0;
    const via = new Set<'name' | 'signature' | 'description'>();
    let identifier = false;
    let pathHint = false;
    const matched = new Set<string>();
    const reasons: string[] = [];

    for (const term of query.terms) {
      let best = 0;
      let bestWhere = '';
      let nameKind = 0;
      let descriptionKind = 0;
      for (const [field, tokens] of [['name', doc.name], ['description', doc.description], ['location', doc.location], ['signature', doc.signature]] as const) {
        for (const token of tokens) {
          const kind = matchKind(term, token);
          if (kind > 0 && FIELD_WEIGHT[field] * kind * idf(token) > best) {
            best = FIELD_WEIGHT[field] * kind * idf(token);
            bestWhere = `${field === 'location' ? 'path' : field} "${token}"${token === term.text ? '' : kind === 0.85 ? ' (same stem)' : ' (related word)'}`;
          }
          if (kind > 0 && field === 'name') {
            named = true;
            nameKind = Math.max(nameKind, kind);
          }
          if (kind > 0 && field === 'description') descriptionKind = Math.max(descriptionKind, kind);
          if (kind > 0 && field !== 'location') via.add(field);
        }
      }
      if (best > 0) {
        termsMatched++;
        score += best * term.weight;
        matched.add(term.text);
        reasons.push(`"${term.text}" matches ${bestWhere}`);
      }
      if (nameKind > 0) nameTerms++;
      if (nameKind >= 0.85) strongTerms++;
      if (descriptionKind >= 0.85) descriptionTerms++;
    }

    // Coordination factor: covering more of the request's distinct terms is stronger evidence than one heavy match.
    if (query.terms.length >= 2) score *= 0.4 + 0.6 * (termsMatched / query.terms.length);
    if (lowerIdentifiers.has(doc.sym.name.toLowerCase())) {
      score += 10;
      named = true;
      via.add('name');
      identifier = true;
      matched.add(doc.sym.name);
      reasons.unshift(`the request names ${doc.sym.name}`);
    }
    if (query.pathHints.some((hint) => doc.file.path === hint || doc.file.path.endsWith(`/${hint}`) || doc.file.path.includes(hint))) {
      score += 4;
      pathHint = true;
      matched.add(doc.file.path);
      reasons.push(`the request mentions ${doc.file.path}`);
    }
    if (doc.internal) score *= INTERNAL_PENALTY;
    if (score > 0) {
      // A doc comment is the author's own statement of intent, so two request terms in it count as strongly as two in the name.
      const strong = identifier || (pathHint && named) || strongTerms >= 1 || nameTerms >= 2 || descriptionTerms >= 2;
      hits.push({ file: doc.file, sym: doc.sym, score, matched: [...matched], named, via: [...via], strength: strong ? 'strong' : 'weak', reasons, internal: doc.internal });
    }
  }

  // Only a floor against noise: a weak hit is labelled weak and ranked last, not discarded because a stronger one exists.
  return hits
    .filter((h) => h.score >= 1)
    .sort((a, b) => b.score - a.score || compareText(a.file.path, b.file.path) || a.sym.line - b.sym.line);
}

type Neighbours = { imports: Map<string, string[]>; importers: Map<string, string[]> };

function neighbours(graph: Graph): Neighbours {
  const imports = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  for (const { source, target } of graph.links) {
    imports.set(source, [...(imports.get(source) ?? []), target]);
    importers.set(target, [...(importers.get(target) ?? []), source]);
  }
  return { imports, importers };
}

const DEPENDENCY_DECAY = 0.35;
const IMPORTER_DECAY = 0.25;
const SIBLING_DECAY = 0.15;
const SEED_FILES = 4;

// Stages 3 and 4: spread score along the import graph, then rank with a small popularity prior.
export function rankFiles(files: FileInfo[], graph: Graph, hits: SymbolHit[]): RankedFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const { imports, importers } = neighbours(graph);
  const popularity = new Map(graph.nodes.map((n) => [n.id, n.importedBy]));

  const direct = new Map<string, number>();
  for (const hit of hits) {
    const current = direct.get(hit.file.path);
    direct.set(hit.file.path, current === undefined ? hit.score : current + hit.score * 0.3);
  }

  const seeds = [...direct].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).slice(0, SEED_FILES);
  const inherited = new Map<string, { score: number; via: RankedFile['via'] }>();
  const inherit = (path: string, score: number, via: RankedFile['via']): void => {
    if (!byPath.has(path) || isTest(path)) return;
    const current = inherited.get(path);
    if (!current || score > current.score) inherited.set(path, { score, via });
  };

  for (const [seed, score] of seeds) {
    for (const target of imports.get(seed) ?? []) inherit(target, score * DEPENDENCY_DECAY, 'dependency');
    for (const source of importers.get(seed) ?? []) inherit(source, score * IMPORTER_DECAY, 'importer');
    const dir = seed.slice(0, seed.lastIndexOf('/') + 1);
    for (const file of files) if (file.path !== seed && file.path.startsWith(dir) && !file.path.slice(dir.length).includes('/')) inherit(file.path, score * SIBLING_DECAY, 'sibling');
  }

  const ranked: RankedFile[] = [];
  for (const file of files) {
    if (isTest(file.path)) continue;
    const directScore = direct.get(file.path) ?? 0;
    const spread = direct.has(file.path) ? undefined : inherited.get(file.path);
    const relevant = directScore > 0 || (spread?.score ?? 0) > 0;
    // Popularity only breaks ties between files that already matched; it never makes an unrelated file look relevant.
    const prior = relevant ? 0.15 * Math.log1p(popularity.get(file.path) ?? 0) : 0.001 * Math.log1p(popularity.get(file.path) ?? 0);
    ranked.push({
      file,
      direct: directScore,
      relevant,
      score: directScore + (spread?.score ?? 0) + prior,
      via: directScore > 0 ? 'match' : (spread?.via ?? 'prior'),
    });
  }
  return ranked.sort((a, b) => b.score - a.score || compareText(a.file.path, b.file.path));
}

export function retrieve(files: FileInfo[], graph: Graph, queryText: string, symbolLimit = 8): Retrieval {
  const query = understandQuery(queryText);
  const hits = matchSymbols(files.filter((f) => !isTest(f.path)), query);
  const ranked = rankFiles(files, graph, hits);
  // A symbol is a reuse candidate when its name, signature or doc comment matched. Matching only through the file's
  // path would list every function in a file, so those files are reported as related instead.
  const candidates = hits.filter((h) => h.via.length > 0);
  const related = ranked.filter((r) => r.relevant && (r.via === 'dependency' || r.via === 'importer' || r.via === 'sibling' || r.via === 'match')).slice(0, 5);
  const confident = candidates.some((h) => h.strength === 'strong');
  return {
    query,
    files: ranked,
    symbols: candidates.slice(0, symbolLimit),
    related: related.filter((r) => !candidates.slice(0, symbolLimit).some((h) => h.file.path === r.file.path)),
    confident,
    omitted: Math.max(0, candidates.length - symbolLimit),
    status: confident ? 'strong' : candidates.length > 0 ? 'weak' : ranked.some((r) => r.direct > 0) ? 'related' : 'none',
  };
}
