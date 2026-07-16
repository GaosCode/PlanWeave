import { useEffect, useMemo, useRef, useState } from "react";
import { acpEventSubscriptionCloseRecoverable } from "@planweave-ai/runtime/browser";
import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  DesktopRunnerRecordSubscriptionUpdate,
  NormalizedRunnerEvent,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";

/** Fixed, small reconnect backoff schedule. No infinite exponential growth. */
const RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

function mergeEvents(
  existing: readonly NormalizedRunnerEvent[],
  incoming: readonly NormalizedRunnerEvent[]
): NormalizedRunnerEvent[] {
  const bySequence = new Map(existing.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function mergeModel(
  current: RunnerRecordReadModel,
  incoming: RunnerRecordReadModel,
  authoritativeState = true
): RunnerRecordReadModel {
  const events = mergeEvents(current.events, incoming.events);
  const cursor =
    incoming.cursor.afterSequence > current.cursor.afterSequence ? incoming.cursor : current.cursor;
  return {
    ...incoming,
    events,
    conversation: authoritativeState ? incoming.conversation : current.conversation,
    timeline: authoritativeState ? incoming.timeline : current.timeline,
    diagnostics: mergeDiagnostics(current.diagnostics, incoming.diagnostics),
    cursor: { ...cursor, terminal: current.terminal || incoming.terminal || cursor.terminal },
    terminal: current.terminal || incoming.terminal,
    intervention: authoritativeState ? incoming.intervention : current.intervention,
    interaction: authoritativeState ? incoming.interaction : current.interaction
  };
}

function mergeDiagnostics(
  existing: readonly RunnerRecordReadModel["diagnostics"][number][],
  incoming: readonly RunnerRecordReadModel["diagnostics"][number][]
): RunnerRecordReadModel["diagnostics"] {
  const diagnostics = new Map<string, RunnerRecordReadModel["diagnostics"][number]>();
  for (const diagnostic of [...existing, ...incoming]) {
    diagnostics.set(
      `${diagnostic.code}\0${diagnostic.line ?? ""}\0${diagnostic.message}`,
      diagnostic
    );
  }
  return [...diagnostics.values()];
}

type RunnerRecordMonitorOptions = {
  api?: Pick<DesktopBridgeApi, "subscribeRunnerRecord"> | null;
  canvasRef?: DesktopCanvasReference | null;
  initialModel: RunnerRecordReadModel | null;
  recordId: string | null;
};

function getInitialModelRevision(model: RunnerRecordReadModel | null): string {
  if (!model) return "null";
  const lastEventSequence = model.events.at(-1)?.sequence ?? null;
  const lastConversationSequence = model.conversation.at(-1)?.sequence ?? null;
  const lastTimelineSequence = model.timeline.at(-1)?.sequence ?? null;
  return JSON.stringify({
    cursor: model.cursor,
    terminal: model.terminal,
    interaction: model.interaction,
    intervention: model.intervention,
    actualConfiguration: model.actualConfiguration,
    eventBoundary: [model.events.length, lastEventSequence],
    conversationBoundary: [model.conversation.length, lastConversationSequence],
    timelineBoundary: [model.timeline.length, lastTimelineSequence],
    diagnostics: model.diagnostics
  });
}

/**
 * Subscription lifetime key: record + real cursor progress + terminal/prompt gates.
 * Deliberately excludes diagnostics/interaction/intervention revision so external model
 * refreshes at the same cursor cannot recreate the effect and reset reconnect budget.
 */
function getSubscriptionLifetimeKey(
  recordId: string | null,
  model: RunnerRecordReadModel | null,
  promptCapable: boolean
): string {
  if (!recordId || !model) return "null";
  return JSON.stringify({
    recordId,
    afterSequence: model.cursor.afterSequence,
    terminal: model.terminal,
    promptCapable
  });
}

export function useRunnerRecordMonitor(
  options: RunnerRecordMonitorOptions & {
    initialModel: RunnerRecordReadModel;
    recordId: string;
  }
): { model: RunnerRecordReadModel; subscriptionError: string | null };
export function useRunnerRecordMonitor(options: RunnerRecordMonitorOptions): {
  model: RunnerRecordReadModel | null;
  subscriptionError: string | null;
};
export function useRunnerRecordMonitor(options: RunnerRecordMonitorOptions) {
  const { api = bridge, canvasRef, initialModel, recordId } = options;
  const initialModelRevision = getInitialModelRevision(initialModel);
  const [modelState, setModelState] = useState({
    model: initialModel,
    recordId,
    initialModelRevision
  });
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const updateSequence = useRef(0);
  const initialModelRef = useRef(initialModel);
  const initialModelRevisionRef = useRef(initialModelRevision);
  initialModelRef.current = initialModel;
  initialModelRevisionRef.current = initialModelRevision;
  const promptCapable = (initialModel?.intervention.prompt.identity ?? null) !== null;
  const initialCursor = initialModel?.cursor.afterSequence ?? -1;
  const monitoredCursor = modelState.model?.cursor.afterSequence ?? -1;
  const canvasProjectRoot = canvasRef?.projectRoot ?? null;
  const canvasId = canvasRef?.canvasId ?? null;
  const subscriptionLifetimeKey = getSubscriptionLifetimeKey(recordId, initialModel, promptCapable);
  const model =
    modelState.recordId !== recordId ||
    initialCursor > monitoredCursor ||
    (initialCursor === monitoredCursor && modelState.initialModelRevision !== initialModelRevision)
      ? initialModel
      : modelState.model;

  // Merge parent read-model revisions into local state without resetting subscription lifecycle.
  useEffect(() => {
    setModelState((current) => {
      if (current.recordId !== recordId) {
        return { model: initialModel, recordId, initialModelRevision };
      }
      const currentCursor = current.model?.cursor.afterSequence ?? -1;
      if (currentCursor > initialCursor) {
        return current.initialModelRevision === initialModelRevision
          ? current
          : { ...current, initialModelRevision };
      }
      if (
        currentCursor === initialCursor &&
        current.initialModelRevision === initialModelRevision
      ) {
        return current;
      }
      return { model: initialModel, recordId, initialModelRevision };
    });
  }, [initialCursor, initialModel, initialModelRevision, recordId]);

  // Clear sticky lifecycle error only when the subscription identity changes (record/cursor/gates).
  useEffect(() => {
    setSubscriptionError(null);
    updateSequence.current = 0;
  }, [subscriptionLifetimeKey]);

  useEffect(() => {
    const seedModel = initialModelRef.current;
    if (
      !api ||
      canvasProjectRoot === null ||
      !seedModel ||
      !recordId ||
      (seedModel.terminal && !promptCapable)
    ) {
      return;
    }
    let disposed = false;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => Promise<void>) | null = null;
    // Local to this subscription lifetime so record resets cannot clobber reconnect cursor.
    let reconnectCursor: RunnerRecordReadModel["cursor"] = seedModel.cursor;
    // Generation closure, user-facing error, and reconnect policy are independent states.
    let generationClosed = false;
    let generationBusinessError: string | null = null;
    const subscriptionCanvasRef: DesktopCanvasReference = {
      projectRoot: canvasProjectRoot,
      canvasId
    };

    const clearReconnectTimer = (): void => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const applySnapshot = (
      snapshot: RunnerRecordReadModel,
      nextUpdateSequence: number,
      authoritativeProjection: boolean,
      acceptUpdateSequence = authoritativeProjection
    ): void => {
      if (acceptUpdateSequence) updateSequence.current = nextUpdateSequence;
      // Only real cursor progress resets the consecutive recoverable-close budget.
      // Reconnect start snapshots often restate the same afterSequence; treating those
      // as progress would restart 250ms backoff forever under backpressure/callback failures.
      const priorAfterSequence = reconnectCursor.afterSequence;
      const cursorAdvanced = snapshot.cursor.afterSequence > priorAfterSequence;
      if (snapshot.cursor.afterSequence >= reconnectCursor.afterSequence) {
        reconnectCursor = {
          ...snapshot.cursor,
          terminal: reconnectCursor.terminal || snapshot.terminal || snapshot.cursor.terminal
        };
      }
      const revisionForState = initialModelRevisionRef.current;
      const fallbackModel = initialModelRef.current;
      setModelState((current) => {
        const currentModel = current.recordId === recordId ? current.model : fallbackModel;
        const merged = currentModel
          ? mergeModel(currentModel, snapshot, authoritativeProjection)
          : snapshot;
        if (merged.cursor.afterSequence >= reconnectCursor.afterSequence) {
          reconnectCursor = merged.cursor;
        }
        return {
          model: merged,
          recordId,
          initialModelRevision: revisionForState
        };
      });
      if (cursorAdvanced) {
        reconnectAttempt = 0;
        // Snapshot may merge after a closed push; never clear same-generation lifecycle errors.
        if (generationBusinessError === null) {
          setSubscriptionError(null);
        }
      }
    };

    const handleUpdate = (update: DesktopRunnerRecordSubscriptionUpdate, gen: number): void => {
      if (disposed || gen !== generation || generationClosed) return;
      if (update.updateSequence <= updateSequence.current) return;
      updateSequence.current = update.updateSequence;

      if (update.kind === "closed") {
        generationClosed = true;
        unsubscribe = null;
        // Reason policy is authoritative; boolean is validated on the wire but not trusted alone.
        const recoverable = acpEventSubscriptionCloseRecoverable(update.close.reason);
        if (!recoverable) {
          if (
            update.close.reason !== "terminal" &&
            update.close.reason !== "explicit_unsubscribe" &&
            update.close.reason !== "owner_disposed"
          ) {
            generationBusinessError = update.close.message;
            setSubscriptionError(update.close.message);
          }
          return;
        }
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          generationBusinessError = update.close.message;
          setSubscriptionError(update.close.message);
          return;
        }
        const delay = RECONNECT_BACKOFF_MS[reconnectAttempt] ?? RECONNECT_BACKOFF_MS.at(-1)!;
        reconnectAttempt += 1;
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!disposed) void openSubscription();
        }, delay);
        return;
      }

      applySnapshot(update.snapshot, update.updateSequence, true);
    };

    const openSubscription = async (): Promise<void> => {
      if (disposed) return;
      const gen = ++generation;
      // Each generation starts a fresh updateSequence space so stale pushes cannot win.
      updateSequence.current = 0;
      generationClosed = false;
      generationBusinessError = null;
      const cursor = reconnectCursor;
      try {
        const subscription = await api.subscribeRunnerRecord(
          { ref: subscriptionCanvasRef, recordId, cursor },
          (update) => handleUpdate(update, gen)
        );
        if (disposed || gen !== generation) {
          await subscription.unsubscribe();
          return;
        }
        // A close push can arrive before the invoke result for both silent terminal and
        // error-bearing null-subscription paths. Never re-arm a closed generation.
        const closedBeforeStart = generationClosed;
        if (!closedBeforeStart) {
          unsubscribe = subscription.unsubscribe;
        } else {
          await subscription.unsubscribe();
        }
        const snapshot = subscription.snapshot;
        if (snapshot) {
          const acceptUpdateSequence = subscription.updateSequence >= updateSequence.current;
          // A null-subscription start snapshot is a complete disk replay even when its invoke
          // result arrives after the lifecycle close push. Adopt that projection without
          // rolling the already-observed lifecycle update sequence backward.
          const authoritativeProjection = closedBeforeStart || acceptUpdateSequence;
          applySnapshot(
            snapshot,
            subscription.updateSequence,
            authoritativeProjection,
            acceptUpdateSequence
          );
        }
      } catch (error: unknown) {
        if (disposed || gen !== generation) return;
        // Invoke/setup failures are not publisher close-results; surface once without polling.
        if (!generationClosed && generationBusinessError === null) {
          setSubscriptionError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void openSubscription();

    return () => {
      disposed = true;
      generation += 1;
      clearReconnectTimer();
      const activeUnsubscribe = unsubscribe;
      unsubscribe = null;
      void activeUnsubscribe?.();
    };
  }, [
    api?.subscribeRunnerRecord,
    canvasId,
    canvasProjectRoot,
    promptCapable,
    recordId,
    subscriptionLifetimeKey
  ]);

  return useMemo(() => ({ model, subscriptionError }), [model, subscriptionError]);
}
