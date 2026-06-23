import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopAgentDetection } from "@planweave-ai/runtime";
import { bridge } from "../bridge";

export function useDetectedAgents() {
  const [agentDetections, setAgentDetections] = useState<DesktopAgentDetection[]>([]);
  const [agentDetectionRefreshing, setAgentDetectionRefreshing] = useState(false);

  const refreshAgentDetections = useCallback(async () => {
    if (!bridge) {
      return;
    }
    setAgentDetectionRefreshing(true);
    try {
      const detectedAgents = await bridge.detectAgentTools();
      setAgentDetections(detectedAgents);
    } finally {
      setAgentDetectionRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshInitialAgents = async () => {
      if (!bridge) {
        return;
      }
      const detectedAgents = await bridge.detectAgentTools();
      if (!cancelled) {
        setAgentDetections(detectedAgents);
      }
    };

    void refreshInitialAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  const executorOptions = useMemo(() => ["manual", ...agentDetections.filter((agent) => agent.installed).map((agent) => agent.kind)], [agentDetections]);

  return { agentDetectionRefreshing, agentDetections, executorOptions, refreshAgentDetections };
}
