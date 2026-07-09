export function reachable(adjacency: Map<string, string[]>, from: string, to: string): boolean {
  if (!adjacency.has(from) || !adjacency.has(to)) {
    return false;
  }
  const visited = new Set<string>();
  const stack = [...(adjacency.get(from) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || visited.has(id)) {
      continue;
    }
    if (id === to) {
      return true;
    }
    visited.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return false;
}

export function findCycle(adjacency: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const id of adjacency.keys()) {
    if (visited.has(id)) {
      continue;
    }
    const stack: Array<{ id: string; nextIndex: number }> = [{ id, nextIndex: 0 }];
    visiting.add(id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = adjacency.get(frame.id)?.[frame.nextIndex];
      if (!next) {
        visiting.delete(frame.id);
        visited.add(frame.id);
        stack.pop();
        continue;
      }
      frame.nextIndex += 1;
      if (!adjacency.has(next)) {
        continue;
      }
      if (visiting.has(next)) {
        const cycleStart = stack.findIndex((item) => item.id === next);
        return stack
          .slice(cycleStart)
          .map((item) => item.id)
          .concat(next);
      }
      if (!visited.has(next)) {
        visiting.add(next);
        stack.push({ id: next, nextIndex: 0 });
      }
    }
  }
  return null;
}

export function addAdjacency(adjacency: Map<string, string[]>, from: string, to: string): void {
  if (!adjacency.has(from)) {
    adjacency.set(from, []);
  }
  if (!adjacency.has(to)) {
    adjacency.set(to, []);
  }
  adjacency.get(from)?.push(to);
}
