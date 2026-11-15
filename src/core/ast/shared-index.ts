import type { Ctx } from '../../context.js';
import { indexProject, type IndexOptions, type Project } from './indexer.js';

// One shared entry point for MCP requests that need an index. Each request used to run its own indexProject, so a client that
// sent N requests at once started N scans of the same workspace. Now:
//
// - Coalescing. Requests for the same context share one scan. A request only joins a scan that has NOT started reading the
//   workspace yet; one that arrives while a scan is running waits for the next scan, which starts when the current one ends. So
//   every request gets a result from a scan that began after it arrived (never one that predates a file change it may be
//   reporting on), and there is at most one running and one waiting scan per context.
// - A global bound. At most MAX_CONCURRENT_INDEXES scans run at once across all workspaces; the rest queue.
// - Cancellation is per request. A request that is cancelled leaves immediately with its signal's reason; the scan itself is only
//   aborted once no request is waiting for it, so one client cancelling never cancels work another one still needs. (An aborted
//   scan keeps what it already cached, exactly as before.)
// - Nothing is shared mutably: the first caller gets the Project the scan built, every other caller a structured clone of it.
// - Every slot is released in a finally, and a failed scan is forgotten as soon as it ends, so a failure never blocks later requests.

export const MAX_CONCURRENT_INDEXES = 2;

type Index = (ctx: Ctx, options: IndexOptions) => Promise<Project>;
type Run = { controller: AbortController; waiters: number; started: boolean; handedOut: boolean; promise: Promise<Project>; settled: Promise<void> };
type Slot = { running?: Run; queued?: Run };

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  // Resolves with a release function once a slot is free; rejects (and leaves the queue) when the signal aborts first.
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.shift()?.();
        });
      };
      const onAbort = (): void => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      };
      if (this.active < this.limit) return grant();
      this.waiting.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export type IndexCoordinator = (ctx: Ctx, signal?: AbortSignal) => Promise<Project>;

export function createIndexCoordinator(options: { maxConcurrent?: number; index?: Index } = {}): IndexCoordinator {
  const gate = new Gate(Math.max(1, options.maxConcurrent ?? MAX_CONCURRENT_INDEXES));
  const index = options.index ?? indexProject;
  const slots = new WeakMap<Ctx, Slot>();

  function start(ctx: Ctx, slot: Slot): Run {
    const controller = new AbortController();
    const prior = slot.running;
    const run = { controller, waiters: 0, started: false, handedOut: false } as Run;
    run.promise = (async () => {
      // The next scan of a context starts only when the previous one is over, so two scans of one workspace never overlap.
      if (prior) await prior.settled;
      const release = await gate.acquire(controller.signal);
      try {
        controller.signal.throwIfAborted();
        run.started = true;
        if (slot.queued === run) slot.queued = undefined;
        slot.running = run;
        return await index(ctx, { signal: controller.signal });
      } finally {
        release();
        if (slot.running === run) slot.running = undefined;
        if (slot.queued === run) slot.queued = undefined;
      }
    })();
    run.settled = run.promise.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return (ctx, signal) => {
    // Always a promise, even for a request that was cancelled before it arrived.
    if (signal?.aborted) return Promise.reject(signal.reason);
    let slot = slots.get(ctx);
    if (!slot) slots.set(ctx, (slot = {}));
    const state = slot;
    const run = state.queued ?? (state.queued = start(ctx, state));

    return new Promise<Project>((resolve, reject) => {
      run.waiters++;
      let done = false;
      const finish = (): boolean => {
        if (done) return false;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = (): void => {
        if (!finish()) return;
        if (--run.waiters === 0) {
          // Nobody needs this scan any more. A scan that has not started must also stop being joinable at once.
          if (state.queued === run) state.queued = undefined;
          run.controller.abort(signal?.reason);
        }
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      run.promise.then(
        (project) => {
          if (!finish()) return;
          run.waiters--;
          const own = !run.handedOut;
          run.handedOut = true;
          resolve(own ? project : structuredClone(project));
        },
        (err) => {
          if (!finish()) return;
          run.waiters--;
          reject(err);
        },
      );
    });
  };
}

export const indexShared: IndexCoordinator = createIndexCoordinator();
