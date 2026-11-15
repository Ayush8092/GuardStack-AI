// A real MCP client over a real process: it spawns the server, speaks newline-delimited JSON-RPC on its stdin/stdout, and checks
// the handshake, the tool list, one tool call, a clean shutdown and that no process is left behind. It imports nothing from src/
// or from the MCP SDK, so it exercises exactly the files it is pointed at (the installed package in scripts/pack-smoke.mjs).
// Works on Linux, macOS and Windows.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE = 10 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves with `fallback` after ms, unless `promise` settles first; the timer never outlives the race (a pending timer would keep
// the runner alive after everything else has finished).
async function within(promise, ms, fallback = null) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// --- stdout framing -------------------------------------------------------------------------------------------------------------

// Splits a byte stream into lines. Every complete line is a protocol message or it is noise; the caller decides what noise means.
export class LineSplitter {
  #pending = '';

  push(text) {
    this.#pending += text;
    const lines = [];
    let index;
    while ((index = this.#pending.indexOf('\n')) !== -1) {
      lines.push(this.#pending.slice(0, index).replace(/\r$/, ''));
      this.#pending = this.#pending.slice(index + 1);
    }
    if (this.#pending.length > MAX_LINE) throw new Error(`a stdout line exceeded ${MAX_LINE} bytes without a newline`);
    return lines;
  }

  // Whatever followed the last newline: a well-behaved server leaves nothing here.
  get rest() {
    return this.#pending;
  }
}

// null when the line is a JSON-RPC 2.0 message, otherwise the reason it is not. A blank line is noise too: the protocol
// has no use for one, and a stray console.log("") would otherwise pass unnoticed.
export function classifyLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { message: null, problem: 'not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value.jsonrpc !== '2.0') return { message: null, problem: 'JSON, but not a JSON-RPC 2.0 message' };
  return { message: value, problem: null };
}

// --- process table --------------------------------------------------------------------------------------------------------------

export function parsePidPairs(text) {
  const table = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[,\s]\s*(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

// wmic's CSV: a header row names the columns (Node,ParentProcessId,ProcessId), whose order is not guaranteed.
export function parseWmicCsv(text) {
  const table = new Map();
  let parentAt = -1;
  let pidAt = -1;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.trim().split(',');
    if (cells.includes('ProcessId') && cells.includes('ParentProcessId')) {
      parentAt = cells.indexOf('ParentProcessId');
      pidAt = cells.indexOf('ProcessId');
    } else if (parentAt >= 0 && cells.length > Math.max(parentAt, pidAt) && /^\d+$/.test(cells[pidAt]) && /^\d+$/.test(cells[parentAt])) {
      table.set(Number(cells[pidAt]), Number(cells[parentAt]));
    }
  }
  return table;
}

function linuxProcTable() {
  const table = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // pid (comm) state ppid ...: comm can contain spaces and parentheses, so read from the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      table.set(Number(name), Number(fields[1]));
    } catch {
      // The process ended while the table was being read.
    }
  }
  return table;
}

const tryRead = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, windowsHide: true });
  } catch {
    return null;
  }
};

// pid -> parent pid for every process. Throws when the system offers no way to read it: a check that cannot run must fail
// loudly and not pass for "no children".
export function readProcessTable() {
  const attempts =
    process.platform === 'win32'
      ? [
          () => {
            const script = "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + ',' + $_.ParentProcessId.ToString() }";
            for (const shell of ['powershell.exe', 'pwsh.exe']) {
              const out = tryRead(shell, ['-NoProfile', '-NonInteractive', '-Command', script]);
              if (out !== null) return parsePidPairs(out);
            }
            return new Map();
          },
          () => parseWmicCsv(tryRead('wmic', ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv']) ?? ''),
        ]
      : [
          () => parsePidPairs(tryRead('ps', ['-A', '-o', 'pid=,ppid=']) ?? ''),
          () => parsePidPairs(tryRead('ps', ['-e', '-o', 'pid=,ppid=']) ?? ''),
          () => (process.platform === 'linux' ? linuxProcTable() : new Map()),
        ];
  for (const attempt of attempts) {
    const table = attempt();
    // A readable table always contains this very process.
    if (table.has(process.pid)) return table;
  }
  throw new Error('the process table cannot be read on this system, so "no child processes remain" cannot be verified');
}

export function descendantsOf(table, root) {
  const found = new Set();
  const queue = [root];
  while (queue.length) {
    const parent = queue.pop();
    for (const [pid, ppid] of table) {
      if (ppid === parent && !found.has(pid) && pid !== root) {
        found.add(pid);
        queue.push(pid);
      }
    }
  }
  return [...found];
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function forceKill(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// --- the session ----------------------------------------------------------------------------------------------------------------

class Session {
  constructor({ command, args, cwd, env, timeoutMs }) {
    this.timeoutMs = timeoutMs;
    this.noise = [];
    this.messages = [];
    this.stderr = '';
    this.exit = null;
    this.waiting = new Map();
    this.splitter = new LineSplitter();
    this.nextId = 1;

    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pid = this.child.pid;
    if (typeof this.pid !== 'number') throw new Error(`could not start ${command}`);
    this.closed = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.exit = { code, signal };
        for (const { reject, timer } of this.waiting.values()) {
          clearTimeout(timer);
          reject(new Error(`the server exited (code ${code}, signal ${signal}) while a request was pending${this.tail()}`));
        }
        this.waiting.clear();
        resolve(this.exit);
      });
    });
    this.child.once('error', (err) => {
      this.exit ??= { code: null, signal: null, error: err.message };
    });
    // Writing to a server that already exited must surface as a failed request, not as an unhandled 'error' event.
    this.child.stdin.on('error', () => undefined);

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      if (this.stderr.length < MAX_STDERR) this.stderr += chunk;
    });
  }

  tail() {
    const lines = this.stderr.trim().split('\n').filter(Boolean).slice(-6);
    return lines.length ? `\n  server stderr (last lines):\n    ${lines.join('\n    ')}` : '';
  }

  #onStdout(chunk) {
    let lines;
    try {
      lines = this.splitter.push(chunk);
    } catch (err) {
      this.noise.push(err.message);
      return;
    }
    for (const line of lines) {
      const { message, problem } = classifyLine(line);
      if (message === null) {
        this.noise.push(`${problem}: ${JSON.stringify(line.slice(0, 120))}`);
        continue;
      }
      this.messages.push(message);
      if ('id' in message && !('method' in message) && this.waiting.has(message.id)) {
        const { resolve, timer } = this.waiting.get(message.id);
        clearTimeout(timer);
        this.waiting.delete(message.id);
        resolve(message);
      }
    }
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (this.exit) return reject(new Error(`the server has already exited (code ${this.exit.code})${this.tail()}`));
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  async request(method, params) {
    const id = this.nextId++;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no response to ${method} within ${this.timeoutMs} ms${this.tail()}`));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
    });
    // A rejected answer is awaited below; this keeps a send failure from leaving it unhandled.
    answer.catch(() => undefined);
    try {
      await this.send({ jsonrpc: '2.0', id, method, params });
    } catch (err) {
      const pending = this.waiting.get(id);
      if (pending) clearTimeout(pending.timer);
      this.waiting.delete(id);
      throw err;
    }
    const response = await answer;
    if (response.error) throw new Error(`${method} returned an error: ${JSON.stringify(response.error).slice(0, 300)}`);
    if (typeof response.result !== 'object' || response.result === null) throw new Error(`${method} returned no result`);
    return response.result;
  }

  notify(method, params) {
    return this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  kill(known = []) {
    for (const pid of [...known, this.pid]) forceKill(pid);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const textOf = (result) => (Array.isArray(result.content) ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n') : '');

/**
 * Runs the whole check against `command args`. `report(name, error)` is called once per step (error is null on success); the
 * returned promise rejects on the first failed step, after the server and anything it started have been shut down.
 *
 * options: command, args, cwd, env, expectedTools (names), expectedServerName, expectedVersion, tool: { name, arguments, check(text) },
 *          timeoutMs (per request), shutdownMs (grace for exiting after stdin closes), report
 */
export async function runMcpStdioSmoke(options) {
  const { command, args = [], cwd, env, expectedTools, expectedServerName, expectedVersion, tool, timeoutMs = 60_000, shutdownMs = 15_000, report = () => undefined } = options;
  const session = new Session({ command, args, cwd, env, timeoutMs });
  const descendants = new Set();
  const onSignal = () => session.kill([...descendants]);
  // The runner can itself be interrupted or crash; the server must not outlive it.
  const onExit = () => {
    if (!session.exit) session.kill([...descendants]);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const step = async (name, fn) => {
    try {
      const value = await fn();
      report(name, null);
      return value;
    } catch (err) {
      report(name, err);
      throw err;
    }
  };
  const track = () => {
    for (const pid of descendantsOf(readProcessTable(), session.pid)) descendants.add(pid);
  };

  try {
    await step('initialize: the server answers with its identity and capabilities', async () => {
      const result = await session.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'guardian-pack-smoke', version: '1.0.0' } });
      assert(typeof result.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion), `unexpected protocolVersion ${JSON.stringify(result.protocolVersion)}`);
      assert(result.protocolVersion === PROTOCOL_VERSION, `the server did not accept protocol ${PROTOCOL_VERSION} (it answered ${result.protocolVersion})`);
      assert(result.serverInfo && result.serverInfo.name === expectedServerName, `serverInfo.name is ${JSON.stringify(result.serverInfo?.name)}, expected ${expectedServerName}`);
      if (expectedVersion !== undefined) assert(result.serverInfo.version === expectedVersion, `serverInfo.version is ${JSON.stringify(result.serverInfo.version)}, the installed package is ${expectedVersion}`);
      assert(result.capabilities && typeof result.capabilities.tools === 'object' && result.capabilities.tools !== null, 'the server does not advertise the tools capability');
      assert(typeof result.instructions === 'string' && result.instructions.length > 0, 'the server sent no instructions');
      await session.notify('notifications/initialized');
    });

    await step('tools/list: every expected tool is offered, each with a description and an input schema', async () => {
      const listed = await session.request('tools/list', {});
      assert(Array.isArray(listed.tools), 'tools/list returned no tools array');
      const names = listed.tools.map((t) => t.name).sort();
      assert(JSON.stringify(names) === JSON.stringify([...expectedTools].sort()), `tools are [${names.join(', ')}], expected [${[...expectedTools].sort().join(', ')}]`);
      for (const t of listed.tools) {
        assert(typeof t.description === 'string' && t.description.length > 0, `${t.name} has no description`);
        assert(t.inputSchema && t.inputSchema.type === 'object', `${t.name} has no object input schema`);
      }
    });

    await step(`tools/call ${tool.name}: a safe tool answers for the temporary workspace`, async () => {
      const result = await session.request('tools/call', { name: tool.name, arguments: tool.arguments });
      assert(result.isError !== true, `the tool reported an error: ${textOf(result).slice(0, 300)}`);
      const text = textOf(result);
      assert(text.length > 0, 'the tool returned no text');
      tool.check(text);
      track();
    });

    await step('shutdown: closing stdin ends the server with exit code 0', async () => {
      session.child.stdin.end();
      const outcome = await within(session.closed, shutdownMs);
      assert(outcome !== null, `the server was still running ${shutdownMs} ms after stdin was closed`);
      assert(outcome.code === 0 && outcome.signal === null, `the server exited with code ${outcome.code}, signal ${outcome.signal}${session.tail()}`);
    });

    await step('stdout carried only protocol messages (logs and debug output stayed on stderr)', async () => {
      assert(session.noise.length === 0, `stdout held ${session.noise.length} line(s) that are not JSON-RPC: ${session.noise.slice(0, 3).join(' | ')}`);
      assert(session.splitter.rest === '', `stdout ended with an unterminated fragment: ${JSON.stringify(session.splitter.rest.slice(0, 80))}`);
      const responses = session.messages.filter((m) => 'id' in m && !('method' in m));
      assert(responses.length === 3, `expected 3 responses (initialize, tools/list, tools/call), saw ${responses.length}`);
    });

    await step('no process is left: the server and everything it started are gone', async () => {
      const pids = [session.pid, ...descendants];
      const deadline = Date.now() + 10_000;
      while (pids.some(isAlive) && Date.now() < deadline) await sleep(100);
      const left = pids.filter(isAlive);
      assert(left.length === 0, `still running after shutdown: ${left.join(', ')}`);
      // Anything still hanging from the (dead) server would now be adopted by init, so also look for survivors by lineage.
      const table = readProcessTable();
      const stray = [...table].filter(([, ppid]) => ppid === session.pid).map(([pid]) => pid);
      assert(stray.length === 0, `processes still name the server as their parent: ${stray.join(', ')}`);
    });
  } catch (err) {
    session.kill([...descendants]);
    await within(session.closed, 5000);
    throw err;
  } finally {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!session.exit) session.kill([...descendants]);
  }
  return { stderr: session.stderr, descendants: [...descendants] };
}
