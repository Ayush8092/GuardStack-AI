import { performance } from 'node:perf_hooks';

// Cooperative scheduling for long synchronous loops. `tick()` is cheap; once a time slice has been used up it hands the
// event loop back (so pending MCP requests and I/O callbacks run) and honours cancellation.
export type Pacer = { tick: () => Promise<void>; yields: () => number };

export function createPacer(options: { sliceMs?: number; signal?: AbortSignal } = {}): Pacer {
  const sliceMs = options.sliceMs ?? 10;
  let sliceStart = performance.now();
  let yielded = 0;

  return {
    async tick() {
      options.signal?.throwIfAborted();
      if (performance.now() - sliceStart < sliceMs) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      yielded++;
      options.signal?.throwIfAborted();
      sliceStart = performance.now();
    },
    yields: () => yielded,
  };
}

export const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
