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
const MODEL_ID = /^[\w./:-]{1,100}$/;

type Provider = { name: 'gemini' | 'groq'; model: LanguageModel };
export type Completion = { text: string; provider: string; redactions: number };

const recentCalls: number[] = [];
const cooldownUntil = new Map<Provider['name'], number>();

export function resetProviderState(): void {
  recentCalls.length = 0;
  cooldownUntil.clear();
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

async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`No answer within ${ms} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
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

function classify(err: unknown): string {
  if (APICallError.isInstance(err)) {
    if (err.statusCode === 429) return 'rate limited (429)';
    return err.statusCode ? `HTTP ${err.statusCode}` : 'network error';
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timed out';
  return 'unusable response';
}

async function run(rawSystem: string, rawPrompt: string, strict: boolean): Promise<Completion | null> {
  const chain = providers();
  if (chain.length === 0) return null;
  const { system, prompt, redactions } = prepareOutbound(rawSystem, rawPrompt, { strict });
  if (!withinRateLimit()) {
    log.warn('LLM call limit reached (20 per minute), using the local result instead');
    return null;
  }

  const timeout = perProviderTimeout();
  const deadline = Date.now() + timeout * chain.length;
  const available = chain.filter((p) => (cooldownUntil.get(p.name) ?? 0) <= Date.now());

  for (const [index, provider] of available.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const { text } = await withDeadline(Math.min(timeout, remaining), (abortSignal) =>
        generateText({ model: provider.model, system, prompt, maxOutputTokens: 2000, maxRetries: 0, abortSignal }),
      );
      if (text.trim()) return { text: text.trim(), provider: provider.name, redactions };
      log.warn(`${provider.name} returned an empty answer`);
    } catch (err) {
      if (APICallError.isInstance(err) && err.statusCode === 429) {
        cooldownUntil.set(provider.name, Date.now() + retryAfterMs(err));
      }
      const next = available[index + 1];
      log.warn(`${provider.name} ${classify(err)}${next ? `, falling back to ${next.name}` : ''}`);
    }
  }
  return null;
}

export async function complete(system: string, prompt: string, options: { strict?: boolean } = {}): Promise<Completion | null> {
  try {
    return await run(system, prompt, options.strict ?? false);
  } catch (err) {
    // A blocked payload is a deliberate refusal the caller must be able to report, not a provider failure.
    if (err instanceof OutboundBlocked) throw err;
    log.warn(`LLM step failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
