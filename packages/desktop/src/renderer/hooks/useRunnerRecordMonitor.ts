import { useEffect, useMemo, useRef, useState } from "react";
import {
  projectAcpConversation,
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
    conversation: projectAcpConversation(events),
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

export function useRunnerRecordMonitor(options: {
  api?: Pick<DesktopBridgeApi, "subscribeRunnerRecord"> | null;
  canvasRef?: DesktopCanvasReference | null;
  initialModel: RunnerRecordReadModel;
  recordId: string;
}) {
  const { api = bridge, canvasRef, initialModel, recordId } = options;
  const [model, setModel] = useState(initialModel);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const updateSequence = useRef(0);

  useEffect(() => {
    setModel(initialModel);
    setSubscriptionError(null);
    updateSequence.current = 0;
  }, [initialModel, recordId]);

  useEffect(() => {
    if (!api || !canvasRef || initialModel.terminal) return;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    void api
      .subscribeRunnerRecord(
        { ref: canvasRef, recordId, cursor: initialModel.cursor },
        (update) => {
          if (disposed || update.updateSequence <= updateSequence.current) return;
          updateSequence.current = update.updateSequence;
          setModel((current) => mergeModel(current, update.snapshot));
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
          setModel((current) => mergeModel(current, snapshot, authoritativeState));
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
  }, [api, canvasRef, initialModel.cursor, initialModel.terminal, recordId]);

  return useMemo(() => ({ model, subscriptionError }), [model, subscriptionError]);
}
