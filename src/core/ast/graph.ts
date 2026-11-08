import { compareText } from '../../utils/text.js';

export type Cycle = {
  modules: string[];
  path: string[];
};

// Iterative Tarjan: dependency graphs can be deep enough to overflow a recursive implementation.
export function stronglyConnected(nodes: string[], adjacency: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
  };

  for (const start of nodes) {
    if (index.has(start)) continue;
    const frames: { node: string; next: number }[] = [{ node: start, next: 0 }];
    visit(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const out = adjacency.get(frame.node) ?? [];

      if (frame.next < out.length) {
        const target = out[frame.next++];
        if (!index.has(target)) {
          visit(target);
          frames.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(target) ?? 0));
        }
        continue;
      }

      frames.pop();
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component.sort(compareText));
      }

      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
    }
  }
  return components;
}

function shortestCycle(start: string, members: Set<string>, adjacency: Map<string, string[]>): string[] {
  const previous = new Map<string, string>();
  const queue: string[] = [];
  for (const next of adjacency.get(start) ?? []) {
    if (members.has(next) && !previous.has(next)) {
      previous.set(next, start);
      queue.push(next);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node === start) break;
    for (const next of adjacency.get(node) ?? []) {
      if (members.has(next) && !previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }
  }

  const chain: string[] = [];
  for (let node = previous.get(start); node !== undefined && node !== start; node = previous.get(node)) chain.unshift(node);
  return [start, ...chain, start];
}

export function findCycles(nodes: string[], edges: Map<string, string[]>): Cycle[] {
  const sorted = [...nodes].sort(compareText);
  const adjacency = new Map<string, string[]>();
  for (const [node, targets] of edges) adjacency.set(node, [...new Set(targets)].sort(compareText));

  // A strongly connected component of one file is a cycle only when that file imports itself.
  const isCycle = (component: string[]): boolean => component.length > 1 || (adjacency.get(component[0]) ?? []).includes(component[0]);

  return stronglyConnected(sorted, adjacency)
    .filter(isCycle)
    .map((modules) => ({ modules, path: shortestCycle(modules[0], new Set(modules), adjacency) }))
    .sort((a, b) => compareText(a.modules[0], b.modules[0]));
}
