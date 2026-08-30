const basePollDelayMs = 1_000;
const maximumPollDelayMs = 30_000;
const jitterWindowMs = 97;

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function workspaceExecutionPollingKey(scopeKey: string, operationId: string): string {
  return `${scopeKey}\u0000${operationId}`;
}

export function workspaceExecutionSuccessPollDelay(
  noProgressCount: number,
  pollingKey: string
): number {
  const boundedBackoff = Math.min(
    basePollDelayMs * 2 ** noProgressCount,
    maximumPollDelayMs - jitterWindowMs
  );
  const jitter = stableHash(`${pollingKey}\u0000${noProgressCount}`) % jitterWindowMs;
  return boundedBackoff + jitter;
}
