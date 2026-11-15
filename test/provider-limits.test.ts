import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { complete, resetProviderState } from '../src/core/llm/provider.js';

// Rate limit and cooldown expiry, with a controllable clock (only Date.now is replaced; timeouts stay real).
const realFetch = globalThis.fetch;
const realNow = Date.now.bind(Date);
let hosts: string[];
let offset: number;

const geminiOk = { candidates: [{ content: { parts: [{ text: 'from gemini' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: {} };
const groqOk = { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'from groq' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

function stub(handler: (host: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    return handler(host);
  }) as typeof fetch;
}
const isGemini = (host: string): boolean => host.includes('googleapis');
const geminiCalls = (): number => hosts.filter(isGemini).length;
const advance = (ms: number): void => {
  offset += ms;
};

beforeEach(() => {
  hosts = [];
  offset = 0;
  resetProviderState();
  mock.method(Date, 'now', () => realNow() + offset);
  process.env.GUARDIAN_LLM_TIMEOUT_MS = '300';
  process.env.GEMINI_API_KEY = 'test-gemini-key-000000';
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GUARDIAN_LLM_TIMEOUT_MS;
});

test('the 21st call within a minute makes no request and the limit lifts after a minute', async () => {
  stub(() => Response.json(geminiOk));
  for (let i = 0; i < 20; i++) assert.equal((await complete('s', 'p'))?.provider, 'gemini');
  assert.equal(hosts.length, 20);
  assert.equal(await complete('s', 'p'), null);
  assert.equal(hosts.length, 20, 'the limited call reached no provider');
  advance(61_000);
  assert.equal((await complete('s', 'p'))?.provider, 'gemini');
});

test('calls that cannot reach any provider do not use up the rate budget', async () => {
  stub(() => Response.json({ error: { message: 'down' } }, { status: 503 }));
  await complete('s', 'p');
  await complete('s', 'p'); // second failure in a row: Gemini rests (at most 5 s)
  const before = hosts.length;
  for (let i = 0; i < 40; i++) assert.equal(await complete('s', 'p'), null);
  assert.equal(hosts.length, before, 'the resting provider was not contacted');
  advance(6_000);
  stub(() => Response.json(geminiOk));
  assert.equal((await complete('s', 'p'))?.provider, 'gemini', 'the 40 skipped calls left the budget intact');
});

test('a provider is contacted again once its backoff has passed', async () => {
  stub(() => Response.json({ error: { message: 'down' } }, { status: 500 }));
  await complete('s', 'p');
  await complete('s', 'p');
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2);
  advance(6_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 3);
});

test('every 5xx status is transient: falls back to Groq, rests after two in a row', async () => {
  process.env.GROQ_API_KEY = 'test-groq-key-000000';
  for (const status of [500, 502, 503, 504]) {
    hosts = [];
    resetProviderState();
    stub((host) => (isGemini(host) ? Response.json({ error: { message: 'down' } }, { status }) : Response.json(groqOk)));
    assert.equal((await complete('s', 'p'))?.provider, 'groq');
    assert.equal((await complete('s', 'p'))?.provider, 'groq');
    await complete('s', 'p');
    assert.equal(geminiCalls(), 2, `HTTP ${status}`);
  }
});

test('a 429 cooldown ends after Retry-After, and without the header after 60 s', async () => {
  stub(() => Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '30' } }));
  await complete('s', 'p');
  advance(29_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 1, 'still cooling down');
  advance(2_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2, 'contacted again after Retry-After');

  hosts = [];
  resetProviderState();
  stub(() => Response.json({ error: { message: 'quota' } }, { status: 429 }));
  await complete('s', 'p');
  advance(59_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 1);
  advance(2_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2);
});

test('a huge Retry-After is capped at five minutes', async () => {
  stub(() => Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '86400' } }));
  await complete('s', 'p');
  advance(299_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 1);
  advance(2_000);
  await complete('s', 'p');
  assert.equal(geminiCalls(), 2);
});

test('with every provider failing the answer is null, not an exception', async () => {
  process.env.GROQ_API_KEY = 'test-groq-key-000000';
  stub(() => {
    throw new TypeError('fetch failed');
  });
  for (let i = 0; i < 5; i++) assert.equal(await complete('s', 'p'), null);
});
