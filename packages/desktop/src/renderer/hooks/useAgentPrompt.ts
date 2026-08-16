import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopAgentPromptIdentity,
  DesktopAgentPromptTurnIdentity,
  DesktopBridgeApi
} from "@planweave-ai/runtime";

export function useAgentPrompt(options: {
  api: Partial<
    Pick<
      DesktopBridgeApi,
      "sendAgentPrompt" | "cancelAgentPromptTurn" | "getCurrentAgentPromptTurn"
    >
  > | null;
  identity: DesktopAgentPromptIdentity | null;
  runtimeInFlight: boolean;
  runtimeVersion?: unknown;
  completedContinuation: boolean;
}) {
  const { api, identity, runtimeInFlight, runtimeVersion, completedContinuation } = options;
  const mounted = useRef(true);
  const activeOperation = useRef<symbol | null>(null);
  const [localInFlight, setLocalInFlight] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTurn = useRef<DesktopAgentPromptTurnIdentity | null>(null);
  const recoveredTurn = useRef(false);
  const recoveryOperation = useRef<object | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const operation = { runtimeInFlight, runtimeVersion };
    recoveryOperation.current = operation;
    let current = true;
    activeTurn.current = null;
    recoveredTurn.current = false;
    setLocalInFlight(false);
    setCancelling(false);
    setCancellable(false);
    if (!completedContinuation || !identity || !api?.getCurrentAgentPromptTurn) {
      return () => {
        current = false;
      };
    }
    void api
      .getCurrentAgentPromptTurn(identity)
      .then((result) => {
        if (
          !current ||
          recoveryOperation.current !== operation ||
          !mounted.current ||
          !result.found ||
          result.state.terminal !== null
        )
          return;
        activeTurn.current = result.state.identity;
        recoveredTurn.current = true;
        setLocalInFlight(true);
        setCancellable(result.state.cancellable);
      })
      .catch((caught) => {
        if (current && mounted.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      current = false;
      if (recoveryOperation.current === operation) recoveryOperation.current = null;
    };
  }, [api, completedContinuation, identity, runtimeInFlight, runtimeVersion]);

  useEffect(() => {
    if (runtimeInFlight || !recoveredTurn.current) return;
    recoveredTurn.current = false;
    activeTurn.current = null;
    setLocalInFlight(false);
    setCancellable(false);
  }, [runtimeInFlight]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!api?.sendAgentPrompt || !identity || activeOperation.current || runtimeInFlight)
        return false;
      const operation = Symbol("agent-prompt");
      const turnIdentity: DesktopAgentPromptTurnIdentity = {
        ...identity,
        version: "planweave.agent-prompt-turn/v1",
        turnId: crypto.randomUUID()
      };
      activeOperation.current = operation;
      activeTurn.current = turnIdentity;
      recoveredTurn.current = false;
      setLocalInFlight(true);
      setCancellable(true);
      setCancelling(false);
      setError(null);
      try {
        const result = await api.sendAgentPrompt({
          version: "planweave.send-agent-prompt/v1",
          identity: turnIdentity,
          text
        });
        return result.terminal !== "cancelled";
      } catch (caught) {
        if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      } finally {
        if (activeOperation.current === operation) {
          activeOperation.current = null;
          activeTurn.current = null;
          if (mounted.current) {
            setLocalInFlight(false);
            setCancellable(false);
          }
        }
      }
    },
    [api, identity, runtimeInFlight]
  );

  const cancel = useCallback(async (): Promise<boolean> => {
    const turnIdentity = activeTurn.current;
    if (
      !completedContinuation ||
      !api?.cancelAgentPromptTurn ||
      !turnIdentity ||
      !cancellable ||
      cancelling
    ) {
      return false;
    }
    setCancelling(true);
    setError(null);
    try {
      const result = await api.cancelAgentPromptTurn(turnIdentity);
      if (
        result.outcome === "not_cancellable" ||
        result.outcome === "already_cancelling" ||
        result.outcome === "already_terminal"
      ) {
        if (mounted.current) setCancellable(false);
        return result.outcome !== "not_cancellable";
      }
      if (result.outcome === "identity_mismatch" || result.outcome === "not_found") {
        throw new Error(`ACP continuation cancellation failed: ${result.outcome}.`);
      }
      if (mounted.current) setCancellable(false);
      return true;
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      if (mounted.current) setCancelling(false);
    }
  }, [api, cancellable, cancelling, completedContinuation]);

  const inFlight = localInFlight || runtimeInFlight;
  return {
    cancel,
    cancelling,
    error,
    inFlight,
    send,
    turnCancellable: completedContinuation && inFlight && cancellable && activeTurn.current !== null
  };
}
