import { useEffect, useRef, useState } from "react";
import type {
  CollaborationOperationDiagnostics,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationBridge } from "../bridge.js";

export type UseCollaborationOperationDiagnosticsArgs = {
  enabled: boolean;
  api?: CollaborationOperationDiagnosticsApi | null;
};

export type CollaborationOperationDiagnosticsApi = Pick<
  PlanWeaveCollaborationApi,
  "getCollaborationOperationDiagnostics" | "onCollaborationOperationDiagnosticsChanged"
>;

export function useCollaborationOperationDiagnostics({
  enabled,
  api: injectedApi
}: UseCollaborationOperationDiagnosticsArgs): {
  diagnostics: CollaborationOperationDiagnostics | null;
  unavailable: boolean;
} {
  const api = injectedApi === undefined ? collaborationBridge : injectedApi;
  const [diagnostics, setDiagnostics] = useState<CollaborationOperationDiagnostics | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || !api) {
      setDiagnostics(null);
      setUnavailable(enabled && !api);
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    setUnavailable(false);
    void api
      .getCollaborationOperationDiagnostics()
      .then((next) => {
        if (!cancelled && generationRef.current === generation) setDiagnostics(next);
      })
      .catch(() => {
        if (!cancelled && generationRef.current === generation) setUnavailable(true);
      });
    const unsubscribe = api.onCollaborationOperationDiagnosticsChanged((next) => {
      generationRef.current += 1;
      setDiagnostics(next);
      setUnavailable(false);
    });
    return () => {
      cancelled = true;
      generationRef.current += 1;
      unsubscribe();
    };
  }, [api, enabled]);

  return { diagnostics, unavailable };
}
