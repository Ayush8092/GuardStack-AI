import vm from 'node:vm';
type Rule = [label: string, pattern: RegExp, replacement?: string];

const rules: Rule[] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['pgp-private-key', /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g],
  ['aws-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['groq-key', /\bgsk_[A-Za-z0-9]{20,}/g],
  ['llm-key', /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g],
  ['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['stripe-webhook', /\bwhsec_[A-Za-z0-9]{24,}/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['google-oauth', /\bya29\.[A-Za-z0-9_-]{20,}/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['azure-account-key', /\bAccountKey=[A-Za-z0-9+/=]{20,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['pypi-token', /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g],
  ['docker-token', /\bdckr_pat_[A-Za-z0-9_-]{20,}/g],
  ['digitalocean-token', /\bdo[por]_v1_[a-f0-9]{64}\b/g],
  ['shopify-token', /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}\b/g],
  ['square-token', /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,}/g],
  ['twilio-key', /\bSK[0-9a-f]{32}\b/g],
  ['mailgun-key', /\bkey-[0-9a-f]{32}\b/g],
  ['telegram-token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['discord-token', /\b[MNO][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['basic-auth', /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED:url-credentials]@'],
  [
    'query-secret',
    /([?&](?:access[_-]?token|api[_-]?key|apikey|auth|token|secret|password|passwd|signature|sig|key)=)[^&\s"'`)]{8,}/gi,
    '$1[REDACTED:query-secret]',
  ],
];

const NAME = String.raw`[\w.-]{0,40}(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|apikey|private[_-]?key|credential|access[_-]?key|auth)[\w.-]{0,40}`;
const LITERAL = String.raw`(?:"[^"\n]*"|'[^'\n]*')`;

const quotedAssignment = new RegExp(String.raw`(\b${NAME}["']?\s*[:=]\s*)(["'\`])([^"'\`\n]{8,})\2`, 'gi');
// "part one" + \n "part two": every segment of a concatenated literal belongs to the secret.
const concatenatedAssignment = new RegExp(String.raw`(\b${NAME}["']?\s*[:=]\s*)(${LITERAL}(?:\s*\+\s*${LITERAL})+)`, 'gi');
const templateAssignment = new RegExp(String.raw`(\b${NAME}["']?\s*[:=]\s*)\`([^\`]{8,})\``, 'gi');
const tripleQuoted = new RegExp(String.raw`(\b${NAME}\s*=\s*)("""|''')([\s\S]{8,}?)\2`, 'gi');
const blockScalar = new RegExp(String.raw`(^[ \t]*(?:-[ \t]+)?${NAME}[ \t]*:[ \t]*[|>][-+]?[ \t]*\n)((?:[ \t]+\S[^\n]*(?:\n|$))+)`, 'gim');
const envLine = new RegExp(String.raw`^(\s*(?:export\s+)?${NAME}\s*=\s*)(\S.*)$`, 'gim');
const yamlLine = new RegExp(String.raw`^([ \t]*(?:-[ \t]+)?${NAME}[ \t]*:[ \t]+)([^\s"'\[{|>#][^\n]*)$`, 'gim');

const harmlessValue = /^(?:process\.env|os\.environ|os\.getenv|import\.meta|getenv|env\.|\$\{|\$[A-Z_]+|<|\[REDACTED|your[_-]|xxx|changeme|example|placeholder)/i;
const sensitiveEnvName = /(?:key|token|secret|passw)/i;

// An unquoted `token: string;` is a type annotation, `password: hunter2pass99` is a secret: require a digit or symbol.
const looksLikeSecretValue = (value: string): boolean => {
  const trimmed = value.trim().replace(/[,;]+$/, '');
  return trimmed.length >= 10 && /[0-9_\-+/=@!#$%^&*]/.test(trimmed) && !/\s/.test(trimmed) && !harmlessValue.test(trimmed);
};

type Custom = { regexes: [label: string, pattern: RegExp][]; literals: string[] };
let custom: Custom = { regexes: [], literals: [] };

export type CustomMasking = { patterns: { name: string; pattern: string }[]; literals: string[] };

// Patterns come from workspace configuration, which an untrusted repository controls. A blacklist of "bad shapes"
// cannot make an arbitrary regex safe ((a|a)+, (a|aa)*, a*a*a*a*b all slip through one), so patterns are limited to
// a small subset that cannot backtrack catastrophically: literals, escapes, classes, `.`, anchors, groups with
// alternation, and quantifiers on single atoms only. A group can never be repeated, so quantifiers never nest, and
// at most MAX_UNBOUNDED unbounded quantifiers keep the worst case polynomial in a short, bounded input.
const MAX_UNBOUNDED = 2;
const MAX_QUANTIFIERS = 4;
const MAX_REPEAT = 64;

export function checkMaskPattern(source: string): string | null {
  if (source.length === 0 || source.length > 200) return 'must be 1 to 200 characters';
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, 'g');
  } catch {
    return 'is not a valid regular expression';
  }

  let unbounded = 0;
  let quantifiers = 0;
  let groups = 0;
  let canRepeat = false;
  const quantifier = (isUnbounded: boolean): string | null => {
    if (!canRepeat) return 'a quantifier must follow a single character, class or escape';
    canRepeat = false;
    quantifiers++;
    if (isUnbounded) unbounded++;
    if (quantifiers > MAX_QUANTIFIERS) return `at most ${MAX_QUANTIFIERS} quantifiers are allowed`;
    if (unbounded > MAX_UNBOUNDED) return `at most ${MAX_UNBOUNDED} unbounded quantifiers (*, + or {n,}) are allowed`;
    return null;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9kK]/.test(next)) return 'back-references are not allowed';
      if (/[pPu]/.test(next) && source[i + 2] === '{') return 'unicode property and code point escapes are not allowed';
      i++;
      canRepeat = !/[bB]/.test(next);
    } else if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      i = j;
      canRepeat = true;
    } else if (c === '(') {
      if (source[i + 1] === '?') {
        if (source.slice(i + 1, i + 3) !== '?:') return 'only plain and (?:...) groups are allowed (no look-around or named groups)';
        i += 2;
      }
      if (++groups > 5) return 'at most 5 groups are allowed';
      canRepeat = false;
    } else if (c === ')') {
      if (/^(?:[*+?]|\{\d)/.test(source.slice(i + 1))) return 'a group cannot be repeated (nested quantifiers are not allowed)';
      canRepeat = false;
    } else if (c === '|' || c === '^' || c === '$') {
      canRepeat = false;
    } else if (c === '*' || c === '+') {
      const problem = quantifier(true);
      if (problem) return problem;
      if (source[i + 1] === '?') i++;
    } else if (c === '?') {
      const problem = quantifier(false);
      if (problem) return problem;
    } else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
      if (m) {
        const low = Number(m[1]);
        const high = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : low;
        if (low > MAX_REPEAT || (high !== Infinity && high > MAX_REPEAT)) return `repeat counts above ${MAX_REPEAT} are not allowed`;
        const problem = quantifier(high === Infinity);
        if (problem) return problem;
        i += m[0].length - 1;
        if (source[i + 1] === '?') i++;
      } else {
        canRepeat = true;
      }
    } else {
      canRepeat = true;
    }
  }
  return compiled.test('') ? 'must not match an empty string' : null;
}


// Defence in depth behind checkMaskPattern: the pattern runs over the whole text in a vm context with a hard time limit,
// which V8 enforces even inside a regex that is backtracking. The text is never cut into pieces (a secret straddling a cut
// would pass through unmasked) and never split into lines (a pattern that spans lines would silently stop matching).
// Patterns are compiled with the `m` flag, so ^ and $ anchor at every line, including before a CR in CRLF text, while
// \s and negated classes can still match across a newline. If the limit is hit, nothing in the text can be called
// scanned: every non-empty line is replaced by [REDACTED:unscanned] and the line structure is kept.
const sandbox = vm.createContext({ text: '', re: /x/g, marker: '', n: 0 });
const replaceScript = new vm.Script('n = 0; text.replace(re, () => { n++; return marker; })');
const PATTERN_TIMEOUT_MS = 250;

function applyCustom(input: string, pattern: RegExp, label: string): { text: string; count: number } {
  pattern.lastIndex = 0;
  Object.assign(sandbox, { text: input, re: pattern, marker: `[REDACTED:${label}]` });
  try {
    const out = replaceScript.runInContext(sandbox, { timeout: PATTERN_TIMEOUT_MS }) as string;
    return { text: out, count: sandbox.n as number };
  } catch {
    return { text: input.split('\n').map((line) => (line.length > 0 ? '[REDACTED:unscanned]' : line)).join('\n'), count: 1 };
  }
}

// Fails closed: a pattern or literal that cannot be applied safely is an error, never silently skipped, because a skipped
// pattern is a secret that is no longer protected and nothing would say so.
export function configureMasking(rulesFromConfig?: Partial<CustomMasking>): void {
  const regexes: Custom['regexes'] = [];
  for (const { name, pattern } of rulesFromConfig?.patterns ?? []) {
    const problem = checkMaskPattern(pattern);
    if (problem !== null) throw new Error(`maskPatterns "${name}" cannot be used: ${problem}`);
    regexes.push([name, new RegExp(pattern, 'gm')]);
  }
  const literals = rulesFromConfig?.literals ?? [];
  const tooShort = literals.find((l) => l.length < 6);
  if (tooShort !== undefined) throw new Error('maskLiterals entries must be at least 6 characters, shorter ones would redact ordinary text');
  custom = { regexes, literals: [...literals].sort((a, b) => b.length - a.length) };
}

function envSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => sensitiveEnvName.test(name) && value && value.length >= 12 && !/\s/.test(value))
    .map(([, value]) => value as string);
}

export function maskSecrets(input: string): { text: string; count: number } {
  let count = 0;
  let text = input;

  for (const value of [...envSecrets(), ...custom.literals]) {
    if (text.includes(value)) {
      count += text.split(value).length - 1;
      text = text.split(value).join('[REDACTED:custom]');
    }
  }

  for (const [label, pattern, replacement] of rules) {
    text = text.replace(pattern, (match) => {
      count++;
      return replacement ? match.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement) : `[REDACTED:${label}]`;
    });
  }
  for (const [label, pattern] of custom.regexes) {
    const result = applyCustom(text, pattern, label);
    text = result.text;
    count += result.count;
  }

  text = text.replace(concatenatedAssignment, (whole, head: string, chain: string) => {
    const inner = chain.replace(/["']\s*\+\s*["']/g, '').slice(1, -1);
    if (inner.length < 8 || harmlessValue.test(inner)) return whole;
    count++;
    return `${head}"[REDACTED:secret]"`;
  });

  text = text.replace(tripleQuoted, (whole, head: string, quote: string, value: string) => {
    if (harmlessValue.test(value.trim())) return whole;
    count++;
    return `${head}${quote}[REDACTED:secret]${quote}`;
  });

  text = text.replace(templateAssignment, (whole, head: string, value: string) => {
    if (harmlessValue.test(value) || /^\$\{[^}]*\}$/.test(value.trim())) return whole;
    count++;
    return `${head}\`[REDACTED:secret]\``;
  });

  text = text.replace(quotedAssignment, (whole, head: string, quote: string, value: string) => {
    if (harmlessValue.test(value)) return whole;
    count++;
    return `${head}${quote}[REDACTED:secret]${quote}`;
  });

  text = text.replace(blockScalar, (_whole: string, head: string) => {
    count++;
    return `${head}  [REDACTED:secret]\n`;
  });

  text = text.replace(envLine, (whole, head: string, value: string) => {
    if (harmlessValue.test(value.replace(/^["']/, ''))) return whole;
    count++;
    return `${head}[REDACTED:env-value]`;
  });

  text = text.replace(yamlLine, (whole, head: string, value: string) => {
    if (!looksLikeSecretValue(value)) return whole;
    count++;
    return `${head}[REDACTED:secret]`;
  });

  return { text, count };
}

export type Unverifiable = { kind: 'high-entropy-token' | 'encoded-blob' | 'binary-content' | 'oversized'; count: number };

const MAX_SCAN_CHARS = 100_000;
const TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

// What masking cannot vouch for: text that still looks like key material after every rule has run, or that
// cannot be read as text at all. Strict mode refuses to send a payload with any of these in it.
export function findUnverifiable(text: string): Unverifiable[] {
  const found: Unverifiable[] = [];
  if (text.length > MAX_SCAN_CHARS) found.push({ kind: 'oversized', count: 1 });

  const scanned = text.slice(0, MAX_SCAN_CHARS);
  let tokens = 0;
  let blobs = 0;
  for (const match of scanned.matchAll(TOKEN)) {
    const token = match[0];
    if (token.includes('REDACTED')) continue;
    if (token.length >= 200 || /^data:/.test(token)) blobs++;
    else if (/[0-9]/.test(token) && /[A-Za-z]/.test(token) && entropy(token) >= 4.2 && !/^[\w-]+(?:\/[\w.-]+)+$/.test(token)) tokens++;
  }
  blobs += (scanned.match(/data:[\w/+.-]+;base64,/g) ?? []).length;
  if (tokens > 0) found.push({ kind: 'high-entropy-token', count: tokens });
  if (blobs > 0) found.push({ kind: 'encoded-blob', count: blobs });

  const odd = (scanned.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g) ?? []).length;
  if (odd > 0) found.push({ kind: 'binary-content', count: odd });
  return found;
}
