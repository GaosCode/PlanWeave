import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectWorkspace } from "../types.js";
import { acquireExecutorResultsWriteLease } from "../package/executorResultsWriteLease.js";

const resultsWriters = new AsyncLocalStorage<Set<object>>();

/** Each continuous producer must confirm its process/session and queued output have stopped. */
export function beginExecutorResultsWriter(): () => void {
  const writers = resultsWriters.getStore();
  const writer = {};
  writers?.add(writer);
  return () => {
    writers?.delete(writer);
  };
}

export async function withExecutorResultsWriteLease<T>(
  workspace: ProjectWorkspace,
  identity: string,
  execute: () => Promise<T>
): Promise<T> {
  const lease = await acquireExecutorResultsWriteLease(workspace, identity);
  const writers = new Set<object>();
  return resultsWriters.run(writers, async () => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await execute() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      if (writers.size === 0) await lease.release();
      else await lease.markUncertain();
    } catch (storageError) {
      if (!outcome.ok)
        throw new AggregateError(
          [outcome.error, storageError],
          "Executor failed and its results lease could not finalize."
        );
      throw storageError;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
}
