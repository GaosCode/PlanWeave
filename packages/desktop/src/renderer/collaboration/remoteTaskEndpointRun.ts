import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";

const HARD_TERMINAL_OPERATION_STATES = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

/**
 * Wait exits on hard terminals, and on interrupted only when the dispatch is not
 * still holding durable writeback evidence. Interrupted + awaiting_writeback means
 * the Host already finished; keep polling until Server seals the package.
 */
export function isRemoteOperationWaitTerminal(observation: RemoteOperationObservation): boolean {
  if (HARD_TERMINAL_OPERATION_STATES.has(observation.state)) return true;
  if (observation.state !== "interrupted") return false;
  return observation.dispatchStatus !== "awaiting_writeback";
}

export type RemoteOperationObserver = {
  observeCollaborationRemoteOperation: (input: {
    operationId: string;
  }) => Promise<RemoteOperationObservation>;
  onCollaborationObserverSignal: (
    callback: (signal: CollaborationObserverSignal) => void
  ) => () => void;
};

export function waitForRemoteOperationTerminal(input: {
  api: RemoteOperationObserver;
  initial: RemoteOperationObservation;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<RemoteOperationObservation> {
  if (isRemoteOperationWaitTerminal(input.initial)) return Promise.resolve(input.initial);

  return new Promise((resolve, reject) => {
    let settled = false;
    let refreshInFlight = false;
    let refreshQueued = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (observation: RemoteOperationObservation) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(observation);
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const scheduleFallback = () => {
      if (settled) return;
      timer = setTimeout(() => void refresh(), input.fallbackRefreshMs ?? 10_000);
    };
    const refresh = async () => {
      if (settled) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const observation = await input.api.observeCollaborationRemoteOperation({
          operationId: input.initial.operationId
        });
        if (isRemoteOperationWaitTerminal(observation)) {
          finish(observation);
          return;
        }
        scheduleFallback();
      } catch (caught) {
        fail(caught);
      } finally {
        refreshInFlight = false;
        if (refreshQueued && !settled) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    const onAbort = () => fail(new Error("remote_task_run_cancelled"));
    const unsubscribe = input.api.onCollaborationObserverSignal((signal) => {
      if (
        signal.type === "human.observer.event" &&
        signal.event.kind === "remote_run" &&
        signal.event.dispatchId === input.initial.dispatchId
      ) {
        void refresh();
      }
    });

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void refresh();
  });
}
