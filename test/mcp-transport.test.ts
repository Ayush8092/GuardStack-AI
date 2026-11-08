// Drives the real MCP server through the SDK's client over a linked in-memory transport, so requests, responses,
// input validation, concurrency and protocol-level cancellation (notifications/cancelled) go through the same protocol layer a
// real client uses. It does not exercise stdio framing or a separate process: for that, see "Known limits" in the README.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import type { Config } from '../src/utils/config.js';
import { cleanup, context, workspace } from './helpers.js';

const open: Client[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.close().catch(() => undefined);
  cleanup();
});

const many = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${String(i).padStart(4, '0')}.ts`, `export function work${i}(value: number) {\n  return value + ${i};\n}\n`]));

async function connect(files: Record<string, string>, overrides: Partial<Config> = {}): Promise<Client> {
  const ctx = context(workspace(files), overrides);
  const server = createServer(ctx, 'test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'transport-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client);
  return client;
}

type Reply = { isError?: boolean; content?: unknown };
const textOf = (result: Reply): string => (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
const call = (client: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> => client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined) as Promise<Reply>;

test('the server lists its four tools over the protocol', async () => {
  const client = await connect(many(3));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['find_reusable_code', 'get_codebase_context', 'optimize_prompt', 'validate_rules']);
  for (const tool of tools) assert.ok(tool.inputSchema && tool.description, `${tool.name} has no schema or description`);
});

test('a tool call returns a text result through the protocol', async () => {
  const client = await connect(many(5));
  const result = await call(client, 'get_codebase_context', { query: 'work3' });
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(textOf(result), /src\/m0003\.ts/);
});

test('invalid arguments are refused by the protocol layer and do no work', async () => {
  const client = await connect(many(3));
  const outcomes: string[] = [];
  for (const args of [{ max_tokens: 5 }, { query: 'x'.repeat(501) }, { paths: 'src' }]) {
    try {
      const result = await call(client, 'get_codebase_context', args);
      outcomes.push(result.isError === true ? 'error-result' : 'accepted');
    } catch {
      outcomes.push('rejected');
    }
  }
  assert.ok(outcomes.every((o) => o !== 'accepted'), `arguments that violate the schema were accepted: ${outcomes.join(', ')}`);
  const unknown = await call(client, 'no_such_tool', {}).then((r) => r.isError === true, () => true);
  assert.equal(unknown, true);
});

test('concurrent requests all complete, and identical requests give identical answers', async () => {
  const client = await connect(many(60));
  const results = await Promise.all([
    call(client, 'get_codebase_context', { query: 'work7' }),
    call(client, 'get_codebase_context', { query: 'work7' }),
    call(client, 'find_reusable_code', { query: 'add a value' }),
    call(client, 'get_codebase_context', { query: 'work7' }),
    call(client, 'find_reusable_code', { query: 'add a value' }),
    call(client, 'get_codebase_context', { max_tokens: 800 }),
  ]);
  for (const result of results) assert.notEqual(result.isError, true, textOf(result));
  assert.equal(textOf(results[0]), textOf(results[1]));
  assert.equal(textOf(results[0]), textOf(results[3]));
  assert.equal(textOf(results[2]), textOf(results[4]));
});

test('a cheap request is answered while a large scan is still running', async () => {
  const client = await connect(many(1500));
  let scanDone = false;
  const scan = call(client, 'get_codebase_context', { query: 'work1' }).finally(() => {
    scanDone = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  const { tools } = await client.listTools();
  const waited = performance.now() - started;
  assert.equal(tools.length, 4);
  assert.equal(scanDone, false, `the scan had already finished, so this did not test anything (listTools took ${waited.toFixed(0)} ms)`);
  assert.notEqual((await scan).isError, true);
});

test('cancelling a request over the protocol rejects it, and the server keeps working', async () => {
  const client = await connect(many(1500));
  const controller = new AbortController();
  const pending = call(client, 'get_codebase_context', { query: 'work1' }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending);

  // The cancelled scan kept what it had cached; the next request completes normally.
  const again = await call(client, 'get_codebase_context', { query: 'work1' });
  assert.notEqual(again.isError, true, textOf(again));
  assert.match(textOf(again), /src\/m0001\.ts/);
  assert.doesNotMatch(textOf(again), /cancelled/i);
});

test('cancelling one request does not disturb another that is running at the same time', async () => {
  const client = await connect(many(800));
  const controller = new AbortController();
  const doomed = call(client, 'get_codebase_context', { query: 'work1' }, controller.signal);
  const survivor = call(client, 'find_reusable_code', { query: 'add a value' });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(doomed);
  const result = await survivor;
  assert.notEqual(result.isError, true, textOf(result));
});
