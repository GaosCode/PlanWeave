import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { DesktopAgentDetection, ExecutionHost } from "@planweave-ai/runtime";
import { desktopAgentHostKey } from "../../shared/desktopSettings";
import { bridge } from "../bridge";

type DetectionContext = { hostKey: string };

type DetectionState = {
  context: DetectionContext;
  detections: DesktopAgentDetection[];
  error: string | null;
  refreshing: boolean;
};

export type RefreshAgentDetections = (
  onPublished?: (detections: DesktopAgentDetection[]) => void
) => Promise<void>;

const noDetections: DesktopAgentDetection[] = [];

export function useDetectedAgents(host: ExecutionHost | null) {
  const hostKey = host ? desktopAgentHostKey(host) : null;
  const contextRef = useRef<DetectionContext | null>(null);
  const generationRef = useRef(0);
  const [state, setState] = useState<DetectionState | null>(null);

  const refreshAgentDetections = useCallback<RefreshAgentDetections>(
    async (onPublished) => {
      const context = contextRef.current;
      if (!bridge || !context || context.hostKey !== hostKey) return;

      const generation = ++generationRef.current;
      setState((previous) => ({
        context,
        detections: previous?.context === context ? previous.detections : noDetections,
        error: null,
        refreshing: true
      }));

      let detections = noDetections;
      let error: string | null = null;
      try {
        const result = await bridge.detectAgentTools();
        if (
          result.some(
            (agent) =>
              !agent.executionHost || desktopAgentHostKey(agent.executionHost) !== context.hostKey
          )
        ) {
          throw new Error("Agent detection returned results for a different execution host.");
        }
        detections = result;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      if (contextRef.current !== context || generationRef.current !== generation) return;
      setState({ context, detections, error, refreshing: false });
      if (error === null) onPublished?.(detections);
    },
    [hostKey]
  );

  useLayoutEffect(() => {
    if (!bridge || hostKey === null) return;
    contextRef.current = { hostKey };
    void refreshAgentDetections();
    return () => {
      contextRef.current = null;
    };
  }, [hostKey, refreshAgentDetections]);

  const dismissAgentDetectionError = useCallback(() => {
    setState((previous) => (previous?.error ? { ...previous, error: null } : previous));
  }, []);
  const current = state?.context.hostKey === hostKey ? state : null;
  return {
    agentDetections: current?.detections ?? noDetections,
    agentDetectionError: current?.error ?? null,
    agentDetectionRefreshing: current?.refreshing ?? false,
    dismissAgentDetectionError,
    refreshAgentDetections
  };
}
