import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { complete, resetProviderState } from '../src/core/llm/provider.js';

const realFetch = globalThis.fetch;
let hosts: string[];

const geminiOk = { candidates: [{ content: { parts: [{ text: 'from gemini' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: {} };
const groqOk = { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'from groq' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

function stubFetch(handler: (host: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    return handler(host);
  }) as typeof fetch;
}

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

test('uses Gemini when it answers', async () => {
  stubFetch(() => Response.json(geminiOk));
  assert.deepEqual(await complete('s', 'p'), { text: 'from gemini', provider: 'gemini', redactions: 0 });
  assert.deepEqual(hosts, ['generativelanguage.googleapis.com']);
});

test('falls back to Groq on a 429', async () => {
  stubFetch((host) => (host.includes('googleapis') ? Response.json({ error: { message: 'quota' } }, { status: 429 }) : Response.json(groqOk)));
  assert.deepEqual(await complete('s', 'p'), { text: 'from groq', provider: 'groq', redactions: 0 });
  assert.deepEqual(hosts, ['generativelanguage.googleapis.com', 'api.groq.com']);
});

test('returns null when every provider fails', async () => {
  stubFetch(() => Response.json({ error: { message: 'down' } }, { status: 503 }));
  assert.equal(await complete('s', 'p'), null);
});

test('returns null without any API key and makes no request', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  stubFetch(() => Response.json(geminiOk));
  assert.equal(await complete('s', 'p'), null);
  assert.equal(hosts.length, 0);
});

const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));

function stubWith(handler: (host: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    return handler(host, init);
  }) as typeof fetch;
}

test('falls back to Groq when Gemini times out', async () => {
  stubWith((host, init) => (host.includes('googleapis') ? hang(init) : Response.json(groqOk)));
  const started = Date.now();
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.ok(Date.now() - started < 3000);
});

test('falls back on invalid JSON and non-JSON bodies', async () => {
  stubWith((host) => (host.includes('googleapis') ? new Response('{"candidates": [', { status: 200 }) : Response.json(groqOk)));
  assert.equal((await complete('s', 'p'))?.provider, 'groq');

  hosts = [];
  resetProviderState();
  stubWith((host) => (host.includes('googleapis') ? new Response('<html>bad gateway</html>', { status: 200 }) : Response.json(groqOk)));
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
});

test('falls back on an empty answer', async () => {
  const empty = { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: {} };
  stubWith((host) => (host.includes('googleapis') ? Response.json(empty) : Response.json(groqOk)));
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
});

test('falls back on a network failure', async () => {
  stubWith((host) => {
    if (host.includes('googleapis')) throw new TypeError('fetch failed');
    return Response.json(groqOk);
  });
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
});

test('stays bounded when every provider hangs', async () => {
  stubWith((_, init) => hang(init));
  const started = Date.now();
  assert.equal(await complete('s', 'p'), null);
  assert.ok(Date.now() - started < 2000);
});

test('skips a rate-limited provider on the next call', async () => {
  stubWith((host) => (host.includes('googleapis') ? Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '30' } }) : Response.json(groqOk)));
  await complete('s', 'p');
  hosts = [];
  assert.equal((await complete('s', 'p'))?.provider, 'groq');
  assert.deepEqual(hosts, ['api.groq.com']);
});
