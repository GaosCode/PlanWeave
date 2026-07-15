import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAgentPromptIdentity, DesktopBridgeApi } from "@planweave-ai/runtime";

export function useAgentPrompt(options: {
  api: Partial<Pick<DesktopBridgeApi, "sendAgentPrompt">> | null;
  identity: DesktopAgentPromptIdentity | null;
  runtimeInFlight: boolean;
}) {
  const { api, identity, runtimeInFlight } = options;
  const mounted = useRef(true);
  const activeOperation = useRef<symbol | null>(null);
  const [localInFlight, setLocalInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!api?.sendAgentPrompt || !identity || activeOperation.current || runtimeInFlight)
        return false;
      const operation = Symbol("agent-prompt");
      activeOperation.current = operation;
      setLocalInFlight(true);
      setError(null);
      try {
        await api.sendAgentPrompt(identity, text);
        return true;
      } catch (caught) {
        if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      } finally {
        if (activeOperation.current === operation) {
          activeOperation.current = null;
          if (mounted.current) setLocalInFlight(false);
        }
      }
    },
    [api, identity, runtimeInFlight]
  );

  return { error, inFlight: localInFlight || runtimeInFlight, send };
}
