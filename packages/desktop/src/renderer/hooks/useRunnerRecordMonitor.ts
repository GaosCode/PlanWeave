import { useEffect, useMemo, useRef, useState } from "react";
import {
  type DesktopBridgeApi,
  type DesktopCanvasReference,
  type NormalizedRunnerEvent,
  type RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";

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
  const promptCapable = (initialModel?.intervention.prompt.identity ?? null) !== null;
  const initialCursor = initialModel?.cursor.afterSequence ?? -1;
  const monitoredCursor = modelState.model?.cursor.afterSequence ?? -1;
  const model =
    modelState.recordId !== recordId ||
    initialCursor > monitoredCursor ||
    (initialCursor === monitoredCursor && modelState.initialModelRevision !== initialModelRevision)
      ? initialModel
      : modelState.model;

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
    setSubscriptionError(null);
    updateSequence.current = 0;
  }, [initialCursor, initialModelRevision, recordId]);

  useEffect(() => {
    if (
      !api ||
      !canvasRef ||
      !initialModel ||
      !recordId ||
      (initialModel.terminal && !promptCapable)
    ) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    void api
      .subscribeRunnerRecord(
        { ref: canvasRef, recordId, cursor: initialModel.cursor },
        (update) => {
          if (disposed || update.updateSequence <= updateSequence.current) return;
          updateSequence.current = update.updateSequence;
          setModelState((current) => {
            const currentModel = current.recordId === recordId ? current.model : initialModel;
            return {
              model: currentModel ? mergeModel(currentModel, update.snapshot) : update.snapshot,
              recordId,
              initialModelRevision
            };
          });
        }
      )
      .then((subscription) => {
        if (disposed) {
          return subscription.unsubscribe();
        }
        unsubscribe = subscription.unsubscribe;
        const snapshot = subscription.snapshot;
        if (snapshot) {
          const authoritativeState = subscription.updateSequence >= updateSequence.current;
          if (authoritativeState) updateSequence.current = subscription.updateSequence;
          setModelState((current) => {
            const currentModel = current.recordId === recordId ? current.model : initialModel;
            return {
              model: currentModel
                ? mergeModel(currentModel, snapshot, authoritativeState)
                : snapshot,
              recordId,
              initialModelRevision
            };
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSubscriptionError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      disposed = true;
      void unsubscribe?.();
    };
  }, [
    api,
    canvasRef,
    initialModel?.cursor.afterSequence,
    initialModel?.terminal,
    initialModelRevision,
    promptCapable,
    recordId
  ]);

  return useMemo(() => ({ model, subscriptionError }), [model, subscriptionError]);
}
