import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { cleanup, context, workspace } from './helpers.js';

after(cleanup);

// Run through the current Node with the tsx loader: node_modules/.bin/tsx is a .cmd shim on Windows and cannot be spawned directly.
const tsx = process.execPath;
const loader = ['--import', 'tsx'];
const entry = path.resolve('src/cli/index.ts');
const cli = (root: string, ...args: string[]) => spawnSync(tsx, [...loader, entry, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, GUARDIAN_LLM: 'off' } });

const files = {
  'src/utils/date.ts': 'export function formatDate(d: Date) { return d.toISOString().slice(0, 10); }\n',
  'src/main.ts': "import { formatDate } from './utils/date';\nconsole.log(formatDate(new Date()));\n",
};

test('guardian find lists candidates with reasons, and says so when nothing matches', () => {
  const root = workspace(files);
  const hit = cli(root, 'find', 'format', 'a', 'date');
  assert.equal(hit.status, 0, hit.stderr);
  assert.match(hit.stdout, /src\/utils\/date\.ts:1/);
  assert.match(hit.stdout, /why: /);

  const none = cli(root, 'find', 'quantum entanglement scheduler');
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No confident match/);

  const json = JSON.parse(cli(root, 'find', '--json', 'format a date').stdout);
  assert.equal(json.confident, true);
  assert.equal(json.candidates[0].name, 'formatDate');
});

test('exit codes: 0 success, 2 for usage and runtime errors, 1 only for findings', () => {
  const root = workspace(files);
  assert.equal(cli(root, 'find', '--limit', '0', 'x').status, 2);
  assert.equal(cli(root, 'no-such-command').status, 2);
  assert.equal(cli(root, 'scan', '--bogus').status, 2);
  assert.equal(cli(root, 'check', '--fail-on', 'nonsense').status, 2);
  assert.equal(cli(root, 'scan').status, 0);
});

test('the MCP server exposes find_reusable_code next to the existing tools and documents that it is pull-based', async () => {
  const ctx = context(workspace(files));
  const server = createServer(ctx, 'test');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['find_reusable_code', 'get_codebase_context', 'optimize_prompt', 'validate_rules']);

  const result = await client.callTool({ name: 'find_reusable_code', arguments: { query: 'format a date' } });
  const text = (result.content as { text: string }[])[0].text;
  assert.match(text, /formatDate/);
  assert.match(text, /why:/);
  assert.match(client.getInstructions() ?? '', /find_reusable_code/);
  await client.close();
});
