import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopAgentPromptIdentity,
  DesktopAgentPromptTurnIdentity,
  DesktopBridgeApi
} from "@planweave-ai/runtime";
import {
  promptIdentityKey,
  samePromptIdentity
} from "../task-workspace/conversation/actionIdentity";

type PendingTurn = {
  turn: DesktopAgentPromptTurnIdentity;
  send: symbol | null;
  cancel: symbol | null;
  cancellable: boolean;
};
type RecoveredTurn = {
  key: string;
  turn: DesktopAgentPromptTurnIdentity;
  cancellable: boolean;
};

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
  scopeKey?: string;
}) {
  const { api, identity, runtimeInFlight, runtimeVersion, completedContinuation, scopeKey } =
    options;
  const stableIdentityRef = useRef(identity);
  if (!samePromptIdentity(stableIdentityRef.current, identity))
    stableIdentityRef.current = identity;
  const stableIdentity = stableIdentityRef.current;
  const key = stableIdentity ? promptIdentityKey(stableIdentity) : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const mounted = useRef(true);
  const owner = useMemo(() => ({ scopeKey, pending: new Map<string, PendingTurn>() }), [scopeKey]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const pending = owner.pending;
  const recoveryOperation = useRef<object | null>(null);
  const [recovered, setRecovered] = useState<RecoveredTurn | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [, setVersion] = useState(0);
  const notify = useCallback(() => {
    if (mounted.current) setVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    setFailure(null);
    const operations = pending;
    return () => {
      mounted.current = false;
      operations.clear();
      recoveryOperation.current = null;
    };
  }, [pending]);

  useEffect(() => {
    const token = { runtimeInFlight, runtimeVersion, owner };
    recoveryOperation.current = token;
    setRecovered(null);
    if (!completedContinuation || !stableIdentity || !key || !api?.getCurrentAgentPromptTurn)
      return;
    const operation = pending.get(key);
    const ownsRecovery = () =>
      mounted.current &&
      currentOwner.current === owner &&
      currentKey.current === key &&
      recoveryOperation.current === token &&
      pending.get(key) === operation;
    void api
      .getCurrentAgentPromptTurn(stableIdentity)
      .then((result) => {
        if (!ownsRecovery() || !result.found || result.state.terminal !== null) return;
        if (!samePromptIdentity(stableIdentity, result.state.identity)) {
          throw new Error("ACP continuation recovery failed: identity_mismatch.");
        }
        if (operation && operation.turn.turnId === result.state.identity.turnId) {
          operation.cancellable = result.state.cancellable;
          notify();
        }
        setRecovered({ key, turn: result.state.identity, cancellable: result.state.cancellable });
      })
      .catch((caught: unknown) => {
        if (ownsRecovery())
          setFailure({ key, message: caught instanceof Error ? caught.message : String(caught) });
      })
      .finally(() => {
        if (recoveryOperation.current === token) recoveryOperation.current = null;
      });
    return () => {
      if (recoveryOperation.current === token) recoveryOperation.current = null;
    };
  }, [
    api,
    completedContinuation,
    key,
    stableIdentity,
    runtimeInFlight,
    runtimeVersion,
    notify,
    owner,
    pending
  ]);

  const local = key ? pending.get(key) : undefined;
  const recoveredCurrent = recovered?.key === key ? recovered : null;
  const inFlight = runtimeInFlight || Boolean(local) || recoveredCurrent !== null;

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (
        !api?.sendAgentPrompt ||
        !identity ||
        !key ||
        currentKey.current !== key ||
        currentOwner.current !== owner ||
        pending.has(key) ||
        runtimeInFlight ||
        recovered?.key === key
      )
        return false;
      const token = Symbol("send-prompt-turn");
      const operation: PendingTurn = {
        turn: {
          ...identity,
          version: "planweave.agent-prompt-turn/v1",
          turnId: crypto.randomUUID()
        },
        send: token,
        cancel: null,
        cancellable: true
      };
      pending.set(key, operation);
      recoveryOperation.current = null;
      setFailure(null);
      notify();
      const ownsOperation = () =>
        mounted.current &&
        currentOwner.current === owner &&
        pending.get(key) === operation &&
        operation.send === token;
      try {
        const result = await api.sendAgentPrompt({
          version: "planweave.send-agent-prompt/v1",
          identity: operation.turn,
          text
        });
        return ownsOperation() && result.terminal !== "cancelled";
      } catch (caught) {
        if (ownsOperation() && currentKey.current === key)
          setFailure({ key, message: caught instanceof Error ? caught.message : String(caught) });
        return false;
      } finally {
        if (ownsOperation()) {
          operation.send = null;
          operation.cancellable = false;
          if (!operation.cancel) pending.delete(key);
          setRecovered((current) =>
            current?.key === key && current.turn.turnId === operation.turn.turnId ? null : current
          );
          notify();
        }
      }
    },
    [api, identity, key, notify, recovered, runtimeInFlight, pending, owner]
  );

  const cancel = useCallback(async (): Promise<boolean> => {
    if (
      !completedContinuation ||
      !api?.cancelAgentPromptTurn ||
      !key ||
      currentKey.current !== key ||
      currentOwner.current !== owner
    )
      return false;
    const existing = pending.get(key);
    const selected = existing ?? (recovered?.key === key ? recovered : null);
    if (!selected || !selected.cancellable || existing?.cancel) return false;
    const token = Symbol("cancel-prompt-turn");
    const operation: PendingTurn = existing ?? {
      turn: selected.turn,
      cancellable: selected.cancellable,
      send: null,
      cancel: null
    };
    operation.cancel = token;
    pending.set(key, operation);
    recoveryOperation.current = null;
    setFailure(null);
    notify();
    const ownsOperation = () =>
      mounted.current &&
      currentOwner.current === owner &&
      pending.get(key) === operation &&
      operation.cancel === token;
    try {
      const result = await api.cancelAgentPromptTurn(operation.turn);
      if (!ownsOperation()) return false;
      if (result.outcome === "identity_mismatch" || result.outcome === "not_found") {
        throw new Error(`ACP continuation cancellation failed: ${result.outcome}.`);
      }
      operation.cancellable = false;
      setRecovered((current) =>
        current?.key === key && current.turn.turnId === operation.turn.turnId
          ? { ...current, cancellable: false }
          : current
      );
      return result.outcome !== "not_cancellable";
    } catch (caught) {
      if (ownsOperation() && currentKey.current === key)
        setFailure({ key, message: caught instanceof Error ? caught.message : String(caught) });
      return false;
    } finally {
      if (ownsOperation()) {
        operation.cancel = null;
        if (!operation.send) pending.delete(key);
        notify();
      }
    }
  }, [api, completedContinuation, key, notify, recovered, pending, owner]);

  return {
    cancel,
    cancelling: Boolean(local?.cancel),
    error: failure?.key === key ? failure.message : null,
    inFlight,
    send,
    turnCancellable:
      completedContinuation &&
      inFlight &&
      Boolean(local?.cancellable ?? recoveredCurrent?.cancellable)
  };
}
