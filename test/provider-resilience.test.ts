import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { backoffMs, complete, resetProviderState } from '../src/core/llm/provider.js';

const realFetch = globalThis.fetch;
let hosts: string[];

const geminiOk = { candidates: [{ content: { parts: [{ text: 'from gemini' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: {} };
const groqOk = { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'from groq' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

function stub(handler: (host: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    return handler(host, init);
  }) as typeof fetch;
}
const isGemini = (host: string): boolean => host.includes('googleapis');
const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
const geminiCalls = (): number => hosts.filter(isGemini).length;

beforeEach(() => {
  hosts = [];
  resetProviderState();
  process.env.GUARDIAN_LLM_TIMEOUT_MS = '300';
  process.env.GEMINI_API_KEY = 'test-gemini-key-000000';
  process.env.GROQ_API_KEY = 'test-groq-key-000000';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GUARDIAN_LLM_TIMEOUT_MS;
});

test('backoff doubles, stays between half and the full value, and never exceeds the cap', () => {
  const low = (n: number) => backoffMs(n, () => 0);
  const high = (n: number) => backoffMs(n, () => 1);
  assert.equal(high(2), 5_000);
  assert.equal(low(2), 2_500);
  assert.equal(high(3), 10_000);
  assert.equal(high(4), 20_000);
  for (let n = 2; n < 200; n++) {
    assert.ok(low(n) >= 2_500 && high(n) <= 300_000, `failure ${n}`);
    assert.ok(high(n) >= high(n - 1 || 2), `non-decreasing at ${n}`);
  }
  assert.equal(high(500), 300_000);
});

test('a single transient failure falls back but does not rest the provider', async () => {
  stub((host) => (isGemini(host) ? Response.json({ error: { message: 'down' } }, { status: 503 }) : Response.json(groqOk)));
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.equal(geminiCalls(), 2, 'the second call still tried Gemini first');
});

test('repeated transient failures rest the provider, so it is not contacted again', async () => {
  stub((host) => (isGemini(host) ? Response.json({ error: { message: 'down' } }, { status: 503 }) : Response.json(groqOk)));
  await complete('s', 'p');
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2);
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.equal(geminiCalls(), 2, 'resting: no further request reached Gemini');
});

test('repeated network failures and timeouts rest the provider as well', async () => {
  stub((host, init) => {
    if (!isGemini(host)) return Response.json(groqOk);
    if (geminiCalls() === 1) throw new TypeError('fetch failed');
    return hang(init);
  });
  await complete('s', 'p');
  await complete('s', 'p');
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2);
});

test('a success resets the count of failures in a row', async () => {
  let failing = true;
  stub((host) => (isGemini(host) ? (failing ? Response.json({ error: { message: 'down' } }, { status: 500 }) : Response.json(geminiOk)) : Response.json(groqOk)));
  await complete('s', 'p');
  failing = false;
  assert.equal((await complete('s', 'p'))?.provider, 'gemini');
  failing = true;
  await complete('s', 'p');
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.equal(geminiCalls(), 4, 'one failure after a success does not rest the provider');
});

test('a permanent error is not retried on the next call', async () => {
  for (const status of [400, 401, 403, 404]) {
    hosts = [];
    resetProviderState();
    stub((host) => (isGemini(host) ? Response.json({ error: { message: 'refused' } }, { status }) : Response.json(groqOk)));
    assert.equal((await complete('s', 'p'))?.provider, 'groq');
    assert.equal((await complete('s', 'p'))?.provider, 'groq');
    assert.equal(geminiCalls(), 1, `HTTP ${status} was retried`);
  }
});

test('408 and 5xx are transient, not permanent', async () => {
  stub((host) => (isGemini(host) ? Response.json({ error: { message: 'slow' } }, { status: 408 }) : Response.json(groqOk)));
  await complete('s', 'p');
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2);
});

test('a 429 still honours Retry-After', async () => {
  stub((host) => (isGemini(host) ? Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '30' } }) : Response.json(groqOk)));
  await complete('s', 'p');
  await complete('s', 'p');
  assert.equal(geminiCalls(), 1);
});

test('a cancelled request makes no call and reports the cancellation, not "no answer"', async () => {
  stub(() => Response.json(geminiOk));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => complete('s', 'p', { signal: controller.signal }), (err: Error) => err.name === 'AbortError');
  assert.equal(hosts.length, 0);
});

test('cancelling while a provider is hanging stops promptly and does not rest the provider', async () => {
  process.env.GUARDIAN_LLM_TIMEOUT_MS = '5000';
  stub((_host, init) => hang(init));
  const controller = new AbortController();
  const started = Date.now();
  const pending = assert.rejects(() => complete('s', 'p', { signal: controller.signal }), (err: Error) => err.name === 'AbortError');
  setTimeout(() => controller.abort(), 50);
  await pending;
  assert.ok(Date.now() - started < 2000, 'returned long before the 5 s provider timeout');

  // The client's cancel is not the provider's fault: the next call tries Gemini again.
  stub((host) => (isGemini(host) ? Response.json(geminiOk) : Response.json(groqOk)));
  assert.equal((await complete('s', 'p'))?.provider, 'gemini');
});
