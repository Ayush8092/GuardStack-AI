import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error plain .mjs build script, it has no type declarations
import { LineSplitter, classifyLine, descendantsOf, isAlive, parsePidPairs, parseWmicCsv, readProcessTable, runMcpStdioSmoke } from '../scripts/mcp-stdio-smoke.mjs';

// scripts/pack-smoke.mjs drives the installed package's `guardian serve` over real stdin/stdout with this client. These tests
// prove the client itself: it passes a well-behaved server (the real one, started from source, and a minimal fake), and it
// fails, with a reason, for every way a server can be wrong: noise on stdout, no answer, a wrong tool list, refusing to exit,
// a non-zero exit, and a process left behind. A check that cannot fail would prove nothing about a package.

const repoRoot = path.resolve(import.meta.dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-mcp-smoke-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

type Step = { name: string; error: Error | null };
const TOOLS = ['alpha', 'beta'];

// A minimal MCP server over stdio. `mode` makes it misbehave in one specific way.
const FAKE = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [mode, pidFile] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
if (mode === 'noise-first') console.log('debug: starting up');
if (mode === 'blank-line') process.stdout.write('\\n');
let buffer = '';
const tools = mode === 'wrong-tools' ? [{ name: 'alpha', description: 'd', inputSchema: { type: 'object' } }] : ['alpha', 'beta'].map((name) => ({ name, description: 'd', inputSchema: { type: 'object' } }));
function handle(message) {
  if (mode === 'silent') return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.2.3' }, instructions: 'hello' } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  } else if (message.method === 'tools/call') {
    let text = 'ok result';
    if (mode === 'leak') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      text = 'child ' + child.pid;
    }
    if (mode === 'noise-late') console.log('stray log after the call');
    if (mode === 'tool-error') return send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('close', () => {
  if (mode === 'stubborn') return;
  process.exit(mode === 'bad-exit' ? 3 : 0);
});
if (mode === 'stubborn') setInterval(() => {}, 1000);
`;
const fakeFile = path.join(dir, 'fake-server.cjs');
fs.writeFileSync(fakeFile, FAKE);

let counter = 0;
async function fake(mode: string, overrides: Record<string, unknown> = {}): Promise<{ steps: Step[]; error: Error | null; serverPid: number; toolText: string }> {
  const pidFile = path.join(dir, `pid-${counter++}`);
  const steps: Step[] = [];
  let toolText = '';
  let error: Error | null = null;
  try {
    await runMcpStdioSmoke({
      command: process.execPath,
      args: [fakeFile, mode, pidFile],
      cwd: dir,
      env: process.env,
      expectedServerName: 'fake',
      expectedVersion: '1.2.3',
      expectedTools: TOOLS,
      tool: { name: 'alpha', arguments: {}, check: (text: string) => (toolText = text) },
      timeoutMs: 5000,
      shutdownMs: 1500,
      report: (name: string, err: Error | null) => steps.push({ name, error: err }),
      ...overrides,
    });
  } catch (err) {
    error = err as Error;
  }
  return { steps, error, serverPid: Number(fs.readFileSync(pidFile, 'utf8')), toolText };
}

const settled = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
const failed = (steps: Step[]): Step | undefined => steps.find((s) => s.error !== null);

// --- the client passes a correct server ------------------------------------------------------------------------------------------

test('a well-behaved server passes every step, and nothing is left running', async () => {
  const { steps, error, serverPid } = await fake('good');
  assert.equal(error, null, error?.message);
  assert.equal(steps.length, 6, steps.map((s) => s.name).join('\n'));
  assert.ok(steps.every((s) => s.error === null));
  assert.ok(steps.some((s) => s.name.startsWith('initialize')) && steps.some((s) => s.name.startsWith('tools/list')) && steps.some((s) => s.name.startsWith('tools/call')));
  assert.equal(await settled(serverPid), true);
});

test('the real server, started from source over real stdio, passes the same steps', { timeout: 120_000 }, async () => {
  const workspace = path.join(dir, 'real-workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n');
  const steps: Step[] = [];
  const { stderr } = await runMcpStdioSmoke({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(repoRoot, 'src', 'cli', 'index.ts'), '--root', workspace, 'serve'],
    cwd: repoRoot,
    env: { ...process.env, GUARDIAN_LOG: 'debug', GUARDIAN_STATE_HOME: path.join(dir, 'real-state') },
    expectedServerName: 'codeguardian',
    expectedTools: ['find_reusable_code', 'get_codebase_context', 'optimize_prompt', 'validate_rules'],
    tool: {
      name: 'get_codebase_context',
      arguments: { query: 'add numbers' },
      check: (text: string) => assert.match(text, /src\/math\.ts[\s\S]*addNumbers/),
    },
    report: (name: string, err: Error | null) => steps.push({ name, error: err }),
  });
  assert.equal(steps.length, 6);
  assert.equal(failed(steps), undefined);
  assert.match(stderr, /MCP server ready/, 'at debug level the log is on stderr, where it belongs');
});

// --- and fails each way a server can be wrong ---------------------------------------------------------------------------------

test('a line of text on stdout before the first message is reported, even though the protocol itself works', async () => {
  const { steps, error } = await fake('noise-first');
  assert.ok(error);
  assert.match(failed(steps)?.name ?? '', /^stdout carried only protocol messages/);
  assert.match(error.message, /not JSON-RPC.*not JSON.*debug: starting up/s);
});

test('a log line on stdout after a tool call is reported', async () => {
  const { error } = await fake('noise-late');
  assert.match(error?.message ?? '', /not JSON.*stray log after the call/s);
});

test('a blank line on stdout is noise too', async () => {
  const { error } = await fake('blank-line');
  assert.match(error?.message ?? '', /not JSON/);
});

test('a server that never answers fails on a timeout and is killed', async () => {
  const { steps, error, serverPid } = await fake('silent', { timeoutMs: 400 });
  assert.match(error?.message ?? '', /no response to initialize within 400 ms/);
  assert.match(failed(steps)?.name ?? '', /^initialize/);
  assert.equal(steps.length, 1, 'no later step ran');
  assert.equal(await settled(serverPid), true, 'the hung server was killed');
});

test('a wrong tool list is reported with both lists', async () => {
  const { error } = await fake('wrong-tools');
  assert.match(error?.message ?? '', /tools are \[alpha\], expected \[alpha, beta\]/);
});

test('a tool that reports an error fails the call step', async () => {
  const { steps, error } = await fake('tool-error');
  assert.match(error?.message ?? '', /the tool reported an error: boom/);
  assert.match(failed(steps)?.name ?? '', /^tools\/call/);
});

test('a server that is not the expected one, or not the installed version, is reported', async () => {
  assert.match((await fake('good', { expectedServerName: 'other' })).error?.message ?? '', /serverInfo\.name is "fake", expected other/);
  assert.match((await fake('good', { expectedVersion: '9.9.9' })).error?.message ?? '', /serverInfo\.version is "1\.2\.3", the installed package is 9\.9\.9/);
});

test('a server that keeps running after stdin closes fails the shutdown step and is then killed', async () => {
  const { steps, error, serverPid } = await fake('stubborn', { shutdownMs: 600 });
  assert.match(error?.message ?? '', /still running 600 ms after stdin was closed/);
  assert.match(failed(steps)?.name ?? '', /^shutdown/);
  assert.equal(await settled(serverPid), true, 'the stubborn server was killed');
});

test('a non-zero exit code is a failed shutdown', async () => {
  const { error } = await fake('bad-exit');
  assert.match(error?.message ?? '', /exited with code 3/);
});

test('a process the server started and left behind is reported, and cleaned up', async () => {
  const { steps, error, toolText, serverPid } = await fake('leak');
  const leaked = Number(/child (\d+)/.exec(toolText)?.[1]);
  assert.ok(Number.isInteger(leaked) && leaked > 0, `the fake server did not report a child: ${toolText}`);
  assert.ok(error, 'the leaked child must fail the run');
  assert.match(failed(steps)?.name ?? '', /^no process is left/);
  assert.match(error.message, new RegExp(`still running after shutdown: .*${leaked}`));
  assert.equal(await settled(leaked), true, 'the leaked child was killed by the cleanup');
  assert.equal(await settled(serverPid), true);
});

// --- the pieces ------------------------------------------------------------------------------------------------------------

test('LineSplitter yields whole lines across chunks, drops the CR of CRLF, and keeps a partial line as the rest', () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push('{"a":'), []);
  assert.deepEqual(splitter.push('1}\r\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
  assert.equal(splitter.rest, '{"c"');
  assert.deepEqual(splitter.push(':3}\n'), ['{"c":3}']);
  assert.equal(splitter.rest, '');
});

test('classifyLine accepts only JSON-RPC 2.0 objects', () => {
  assert.equal(classifyLine('{"jsonrpc":"2.0","id":1,"result":{}}').problem, null);
  for (const line of ['', 'hello', '[1]', '42', 'null', '{"id":1}', '{"jsonrpc":"1.0"}', '{"jsonrpc":"2.0"', '[{"jsonrpc":"2.0"}]']) {
    assert.notEqual(classifyLine(line).problem, null, JSON.stringify(line));
  }
});

test('process tables are parsed from ps, PowerShell and wmic output, and descendants are found through the tree', () => {
  const ps = parsePidPairs('    1     0\n  100     1\n  200   100\n  300   200\n  400     1\nPID PPID\n');
  assert.deepEqual([...ps], [[1, 0], [100, 1], [200, 100], [300, 200], [400, 1]]);
  assert.deepEqual(parsePidPairs('100,1\r\n200,100\r\n'), new Map([[100, 1], [200, 100]]));
  const wmic = parseWmicCsv('\r\nNode,ParentProcessId,ProcessId\r\nHOST,4,100\r\nHOST,100,200\r\n\r\n');
  assert.deepEqual([...wmic], [[100, 4], [200, 100]]);
  assert.deepEqual(descendantsOf(ps, 100).sort(), [200, 300]);
  assert.deepEqual(descendantsOf(ps, 300), []);
  assert.deepEqual(descendantsOf(ps, 999), []);
});

test('the real process table of this machine can be read and contains this process and its own child', async () => {
  const table = readProcessTable();
  assert.ok(table.has(process.pid));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    assert.ok(descendantsOf(readProcessTable(), process.pid).includes(child.pid));
  } finally {
    child.kill();
  }
});

test('pack-smoke starts the installed `guardian serve` through the client, and imports neither the sources nor an in-memory transport', () => {
  const smoke = fs.readFileSync(path.join(repoRoot, 'scripts', 'pack-smoke.mjs'), 'utf8');
  const client = fs.readFileSync(path.join(repoRoot, 'scripts', 'mcp-stdio-smoke.mjs'), 'utf8');
  assert.match(smoke, /from '\.\/mcp-stdio-smoke\.mjs'/);
  assert.match(smoke, /'node_modules', 'code-guardian-ai'/, 'it runs files of the installed package');
  assert.match(smoke, /'bin', 'cli\.js'\), '--root', mcpWorkspace, 'serve'/, 'it launches the installed bin with the serve command');
  assert.match(smoke, /GUARDIAN_LOG = 'debug'/, 'the most verbose logging is on while stdout is checked');
  for (const text of [smoke, client]) {
    assert.doesNotMatch(text, /from ['"]\.\.\/(src|dist)\//, 'no module of the repository is imported');
    assert.doesNotMatch(text, /InMemoryTransport|@modelcontextprotocol/, 'no SDK transport stands in for the process');
  }
});
