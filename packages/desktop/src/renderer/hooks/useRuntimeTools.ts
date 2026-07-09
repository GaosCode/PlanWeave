import { useCallback, useEffect, useState } from "react";
import type { DesktopRuntimeToolAvailability } from "@planweave-ai/runtime";
import { bridge } from "../bridge";

const unavailableRuntimeTools: DesktopRuntimeToolAvailability = {
  tmux: {
    available: false,
    command: "tmux"
  }
};

export function useRuntimeTools() {
  const [runtimeTools, setRuntimeTools] =
    useState<DesktopRuntimeToolAvailability>(unavailableRuntimeTools);

  const refreshRuntimeTools = useCallback(async () => {
    if (!bridge) {
      setRuntimeTools(unavailableRuntimeTools);
      return;
    }
    try {
      setRuntimeTools(await bridge.detectRuntimeTools());
    } catch {
      setRuntimeTools(unavailableRuntimeTools);
    }
  }, []);

  useEffect(() => {
    void refreshRuntimeTools();
  }, [refreshRuntimeTools]);

  return {
    runtimeTools,
    refreshRuntimeTools
  };
}
