import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, type LanguageModel } from 'ai';
import { log } from '../../utils/logger.js';
import { OutboundBlocked, prepareOutbound } from '../security/outbound.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const DEFAULT_TIMEOUT_MS = 12_000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;
const MAX_CALLS_PER_MINUTE = 20;
// Repeated transient failures (network, timeout, 5xx, unusable answer) of one provider start a cooldown that doubles with
// every further failure, up to MAX_COOLDOWN_MS, with jitter so that several processes do not return at the same moment.
// The first failure only falls back to the next provider: a single blip does not take a provider out of the chain.
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_AFTER_FAILURES = 2;
const MODEL_ID = /^[\w./:-]{1,100}$/;

type Provider = { name: 'gemini' | 'groq'; model: LanguageModel };
export type Completion = { text: string; provider: string; redactions: number };

const recentCalls: number[] = [];
const cooldownUntil = new Map<Provider['name'], number>();
const transientFailures = new Map<Provider['name'], number>();

export function resetProviderState(): void {
  recentCalls.length = 0;
  cooldownUntil.clear();
  transientFailures.clear();
}

// Cooldown after the Nth consecutive transient failure (N >= BACKOFF_AFTER_FAILURES): exponential, capped, between half
// and the full value ("equal jitter"), so it is never zero and never above the cap.
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, failures - BACKOFF_AFTER_FAILURES);
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(exponent, 20), MAX_COOLDOWN_MS);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function withinRateLimit(): boolean {
  const now = Date.now();
  while (recentCalls.length > 0 && now - recentCalls[0] > 60_000) recentCalls.shift();
  if (recentCalls.length >= MAX_CALLS_PER_MINUTE) return false;
  recentCalls.push(now);
  return true;
}

function perProviderTimeout(): number {
  const configured = Number(process.env.GUARDIAN_LLM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.max(configured, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

// `outer` is the caller's cancellation (an MCP client that gave up): it stops the request at once and its reason is thrown as it is.
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  outer?.throwIfAborted();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onOuterAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`No answer within ${ms} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, ms);
    if (outer) {
      onOuterAbort = () => {
        controller.abort(outer.reason);
        reject(outer.reason);
      };
      outer.addEventListener('abort', onOuterAbort, { once: true });
    }
  });
  try {
    return await Promise.race([work(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    if (outer && onOuterAbort) outer.removeEventListener('abort', onOuterAbort);
  }
}

function modelId(envName: string, fallback: string): string {
  const value = process.env[envName];
  return value && MODEL_ID.test(value) ? value : fallback;
}

function providers(): Provider[] {
  const chain: Provider[] = [];
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (geminiKey) {
    const google = createGoogleGenerativeAI({ apiKey: geminiKey });
    chain.push({ name: 'gemini', model: google(modelId('GEMINI_MODEL', DEFAULT_GEMINI_MODEL)) });
  }
  if (groqKey) {
    const groq = createOpenAI({ apiKey: groqKey, baseURL: GROQ_BASE_URL, name: 'groq' });
    chain.push({ name: 'groq', model: groq.chat(modelId('GROQ_MODEL', DEFAULT_GROQ_MODEL)) });
  }
  return chain;
}

export function hasLlmKeys(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);
}

function retryAfterMs(err: APICallError): number {
  const seconds = Number(err.responseHeaders?.['retry-after']);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;
}

// What a failure says about trying again:
//   rate-limited  the provider asked us to wait (429)
//   permanent     the request itself is refused (bad key, bad model, bad payload): the same call fails the same way
//   transient     network error, timeout, 5xx, 408/409/425, or an answer that could not be used
type FailureKind = 'rate-limited' | 'permanent' | 'transient';

function failureKind(err: unknown): FailureKind {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 429) return 'rate-limited';
    if (status !== undefined && status >= 400 && status < 500 && ![408, 409, 425].includes(status)) return 'permanent';
  }
  return 'transient';
}

function classify(err: unknown): string {
  if (APICallError.isInstance(err)) {
    if (err.statusCode === 429) return 'rate limited (429)';
    return err.statusCode ? `HTTP ${err.statusCode}` : 'network error';
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timed out';
  return 'unusable response';
}

function recordFailure(name: Provider['name'], kind: FailureKind, err: unknown): string {
  const now = Date.now();
  if (kind === 'rate-limited') {
    cooldownUntil.set(name, now + retryAfterMs(err as APICallError));
    return '';
  }
  if (kind === 'permanent') {
    // Retrying a refused request only repeats the refusal (and, for a bad key, can lock the account): rest the provider.
    cooldownUntil.set(name, now + MAX_COOLDOWN_MS);
    return ', not retried for a while';
  }
  const failures = (transientFailures.get(name) ?? 0) + 1;
  transientFailures.set(name, failures);
  if (failures < BACKOFF_AFTER_FAILURES) return '';
  const wait = backoffMs(failures);
  cooldownUntil.set(name, now + wait);
  return `, resting for ${Math.ceil(wait / 1000)} s after ${failures} failures in a row`;
}

async function run(rawSystem: string, rawPrompt: string, strict: boolean, signal?: AbortSignal): Promise<Completion | null> {
  signal?.throwIfAborted();
  const chain = providers();
  if (chain.length === 0) return null;
  const { system, prompt, redactions } = prepareOutbound(rawSystem, rawPrompt, { strict });
  // Providers that are resting are skipped before the rate budget is spent: a call that cannot reach any provider
  // must not use up the 20-per-minute allowance of the calls that can.
  const available = chain.filter((p) => (cooldownUntil.get(p.name) ?? 0) <= Date.now());
  if (available.length === 0) return null;
  if (!withinRateLimit()) {
    log.warn('LLM call limit reached (20 per minute), using the local result instead');
    return null;
  }

  const timeout = perProviderTimeout();
  const deadline = Date.now() + timeout * chain.length;

  for (const [index, provider] of available.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const { text } = await withDeadline(
        Math.min(timeout, remaining),
        (abortSignal) => generateText({ model: provider.model, system, prompt, maxOutputTokens: 2000, maxRetries: 0, abortSignal }),
        signal,
      );
      if (text.trim()) {
        transientFailures.delete(provider.name);
        return { text: text.trim(), provider: provider.name, redactions };
      }
      log.warn(`${provider.name} returned an empty answer${recordFailure(provider.name, 'transient', undefined)}`);
    } catch (err) {
      // The caller gave up: that is not a provider fault, so it is neither counted nor swallowed.
      if (signal?.aborted) throw signal.reason;
      const next = available[index + 1];
      const outcome = recordFailure(provider.name, failureKind(err), err);
      log.warn(`${provider.name} ${classify(err)}${next ? `, falling back to ${next.name}` : ''}${outcome}`);
    }
  }
  return null;
}

export async function complete(system: string, prompt: string, options: { strict?: boolean; signal?: AbortSignal } = {}): Promise<Completion | null> {
  try {
    return await run(system, prompt, options.strict ?? false, options.signal);
  } catch (err) {
    // A blocked payload is a deliberate refusal the caller must be able to report, not a provider failure.
    if (err instanceof OutboundBlocked) throw err;
    // A cancelled request is reported as cancelled, not turned into "no answer".
    if (options.signal?.aborted) throw err;
    log.warn(`LLM step failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
