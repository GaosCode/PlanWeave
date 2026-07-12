import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpConnection } from "./acpConnection.js";
import {
  respondToPendingRunnerRequest,
  type JsonRpcValue,
  type LiveOwnership,
  type RunnerLiveControl
} from "./liveControl.js";
import {
  executeRunnerLifecycleTransition,
  transitionRunnerLifecycle
} from "./runnerLifecycle.js";
import type {
  RunnerLifecycleState,
  RunnerRequestActionIdentity,
  RunnerSessionActionIdentity,
  RunnerTerminalState
} from "./runnerContractSchemas.js";

export type ActiveAgentRunIdentity = {
  scope: string;
  desktopRunId?: string;
  runSessionId?: string;
  executorRunId: string;
  claimRef: string;
  sessionId?: string;
};

export type ActiveAgentRunHandle = {
  identity: ActiveAgentRunIdentity;
  connection: AcpConnection;
  abortController: AbortController;
  eventSink: (notification: SessionNotification) => void | Promise<void>;
  ownership: LiveOwnership;
  control: RunnerLiveControl;
  lifecycleState: RunnerLifecycleState;
};

export type IdentityKind = "desktopRunId" | "runSessionId" | "executorRunId" | "claimRef" | "sessionId";
export type ActiveAgentRunLookup = Pick<ActiveAgentRunIdentity, "scope" | "executorRunId"> &
  Partial<Pick<ActiveAgentRunIdentity, "desktopRunId" | "runSessionId" | "claimRef" | "sessionId">>;
export type ActiveAgentRunSessionActionIdentity = RunnerSessionActionIdentity;
export type ActiveAgentRunActionIdentity = RunnerRequestActionIdentity;
const identityKinds: readonly IdentityKind[] = ["desktopRunId", "runSessionId", "executorRunId", "claimRef", "sessionId"];

function key(scope: string, value: string): string {
  return `${scope}\0${value}`;
}

export class ActiveAgentRunRegistry {
  private readonly handles = new Set<ActiveAgentRunHandle>();
  private readonly indexes = new Map<IdentityKind, Map<string, ActiveAgentRunHandle>>(
    identityKinds.map((kind) => [kind, new Map()])
  );
  private readonly removals = new WeakMap<ActiveAgentRunHandle, Promise<boolean>>();
  private readonly interactionSubscribers = new Set<(handle: ActiveAgentRunHandle) => void>();

  subscribeInteractionChanges(subscriber: (handle: ActiveAgentRunHandle) => void): () => void {
    this.interactionSubscribers.add(subscriber);
    return () => this.interactionSubscribers.delete(subscriber);
  }

  notifyInteractionChanged(handle: ActiveAgentRunHandle): void {
    if (!this.handles.has(handle)) return;
    for (const subscriber of this.interactionSubscribers) subscriber(handle);
  }

  register(handle: ActiveAgentRunHandle): void {
    if (this.handles.has(handle)) throw new Error("Active ACP run is already registered.");
    this.assertAvailable(handle.identity);
    this.handles.add(handle);
    this.index(handle);
  }

  bindSession(handle: ActiveAgentRunHandle, sessionId: string): void {
    if (!this.handles.has(handle)) throw new Error("Cannot bind a session to an inactive ACP run.");
    if (handle.identity.sessionId) throw new Error("Active ACP run already has a session id.");
    const sessionIndex = this.indexes.get("sessionId");
    const sessionKey = key(handle.identity.scope, sessionId);
    if (sessionIndex?.has(sessionKey)) throw new Error(`Active ACP sessionId collision for '${sessionId}' in run scope.`);
    handle.identity.sessionId = sessionId;
    handle.control.sessionId = sessionId;
    sessionIndex?.set(sessionKey, handle);
  }

  transition(handle: ActiveAgentRunHandle, state: RunnerLifecycleState): void {
    const result = transitionRunnerLifecycle({
      from: handle.lifecycleState,
      to: state,
      cause: "normal",
      ownership: handle.ownership
    });
    handle.lifecycleState = result.state;
  }

  lookup(kind: IdentityKind, scope: string, value: string, expectedExecutorRunId?: string): ActiveAgentRunHandle | null {
    const handle = this.indexes.get(kind)?.get(key(scope, value)) ?? null;
    if (handle && expectedExecutorRunId !== undefined && handle.identity.executorRunId !== expectedExecutorRunId) {
      throw new Error(`Active ACP ${kind} '${value}' belongs to a different executor run in this scope.`);
    }
    return handle;
  }

  lookupExact(identity: ActiveAgentRunLookup): ActiveAgentRunHandle | null {
    const handle = this.lookup("executorRunId", identity.scope, identity.executorRunId);
    if (!handle) return null;
    for (const kind of identityKinds) {
      const expected = identity[kind];
      if (expected !== undefined && handle.identity[kind] !== expected) {
        throw new Error(`Active ACP ${kind} '${expected}' does not match executor run '${identity.executorRunId}'.`);
      }
    }
    return handle;
  }

  listPending(identity: ActiveAgentRunActionIdentity) {
    const handle = this.resolveAction(identity);
    if (!handle) return [];
    const request = handle.control.pendingRequests.get(identity.requestId);
    if (!request) return [];
    return [{
      requestId: request.requestId,
      interactionId: request.interactionId,
      kind: request.kind,
      requestedAt: request.requestedAt,
      summary: request.summary
    }];
  }

  async respond(identity: ActiveAgentRunActionIdentity, value: JsonRpcValue): Promise<void> {
    const handle = this.resolveAction(identity);
    if (!handle) throw new Error(`Active ACP executor run '${identity.executorRunId}' does not exist.`);
    const request = handle.control.pendingRequests.get(identity.requestId);
    if (!request) throw new Error(`Live runner request '${identity.requestId}' does not exist.`);
    if (request.kind === "authentication") {
      throw new Error("Authentication intervention is not supported by the Desktop runner.");
    }
    if (request.kind === "permission" && !handle.control.interventionCapabilities.permission) {
      throw new Error("Permission intervention is not negotiated for this Desktop ACP session.");
    }
    if (request.kind === "elicitation" && !handle.control.interventionCapabilities.elicitationPreview) {
      throw new Error("Preview elicitation is not negotiated for this Desktop ACP session.");
    }
    await respondToPendingRunnerRequest({
      control: handle.control,
      ownership: handle.ownership,
      requestId: identity.requestId,
      value
    });
  }

  async cancel(identity: ActiveAgentRunSessionActionIdentity): Promise<void> {
    const handle = this.resolveSessionAction(identity);
    if (!handle) throw new Error(`Active ACP executor run '${identity.executorRunId}' does not exist.`);
    if (handle.lifecycleState !== "running" && handle.lifecycleState !== "waiting_interaction") {
      throw new Error(`Active ACP session '${identity.sessionId}' is not cancellable in state '${handle.lifecycleState}'.`);
    }
    if (!handle.control.interventionCapabilities.cancel) {
      throw new Error("ACP session cancellation is not negotiated for this Desktop session.");
    }
    const removed = await this.remove(handle, "Desktop requested ACP session cancellation.", "cancelled");
    if (!removed) throw new Error(`Active ACP executor run '${identity.executorRunId}' is no longer available.`);
  }

  lookupDesktopRun(desktopRunId: string): ActiveAgentRunHandle | null {
    return [...this.handles].find(
      (handle) => handle.identity.desktopRunId === desktopRunId
    ) ?? null;
  }

  remove(
    handle: ActiveAgentRunHandle,
    reason: string,
    terminalState: RunnerTerminalState = "cancelled",
    artifactValidated = false
  ): Promise<boolean> {
    const existing = this.removals.get(handle);
    if (existing) return existing;
    const removal = this.removeOnce(handle, reason, terminalState, artifactValidated);
    this.removals.set(handle, removal);
    return removal;
  }

  async shutdown(reason = "PlanWeave runtime shutdown."): Promise<void> {
    const results = await Promise.allSettled([...this.handles].map((handle) => this.remove(handle, reason)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Active ACP run shutdown did not complete cleanly.");
  }

  async shutdownDesktopRun(desktopRunId: string, reason: string): Promise<void> {
    const matches = [...this.handles].filter(
      (handle) => handle.identity.desktopRunId === desktopRunId
    );
    const results = await Promise.allSettled(matches.map((handle) => this.remove(handle, reason)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, `ACP cleanup failed for Desktop run '${desktopRunId}'.`);
  }

  get size(): number { return this.handles.size; }

  private resolveAction(identity: ActiveAgentRunActionIdentity): ActiveAgentRunHandle | null {
    this.assertActionIdentity(identity, ["scope", "executorRunId", "desktopRunId", "runSessionId", "claimRef", "sessionId", "requestId"]);
    return this.lookupExact(identity);
  }

  private resolveSessionAction(identity: ActiveAgentRunSessionActionIdentity): ActiveAgentRunHandle | null {
    this.assertActionIdentity(identity, ["scope", "executorRunId", "desktopRunId", "runSessionId", "claimRef", "sessionId"]);
    return this.lookupExact(identity);
  }

  private assertActionIdentity<T extends Record<string, string>>(
    identity: T,
    fields: readonly (keyof T)[]
  ): void {
    for (const field of fields) {
      if (typeof identity[field] !== "string" || identity[field].length === 0) {
        throw new Error(`Active ACP action requires a non-empty ${String(field)}.`);
      }
    }
  }

  private assertAvailable(identity: ActiveAgentRunIdentity): void {
    for (const kind of identityKinds) {
      const value = identity[kind];
      if (value && this.indexes.get(kind)?.has(key(identity.scope, value))) {
        throw new Error(`Active ACP ${kind} collision for '${value}' in run scope.`);
      }
    }
  }

  private index(handle: ActiveAgentRunHandle): void {
    for (const kind of identityKinds) {
      const value = handle.identity[kind];
      if (value) this.indexes.get(kind)?.set(key(handle.identity.scope, value), handle);
    }
  }

  private async removeOnce(
    handle: ActiveAgentRunHandle,
    reason: string,
    terminalState: RunnerTerminalState,
    artifactValidated: boolean
  ): Promise<boolean> {
    if (!this.handles.delete(handle)) return false;
    for (const kind of identityKinds) {
      const value = handle.identity[kind];
      const scopedKey = value ? key(handle.identity.scope, value) : null;
      if (scopedKey && this.indexes.get(kind)?.get(scopedKey) === handle) this.indexes.get(kind)?.delete(scopedKey);
    }
    handle.abortController.abort(new Error(reason));
    if (
      terminalState === "cancelled" &&
      (handle.lifecycleState === "running" || handle.lifecycleState === "waiting_interaction")
    ) {
      const cancelling = transitionRunnerLifecycle({
        from: handle.lifecycleState,
        to: "cancelling",
        cause: "normal",
        ownership: handle.ownership
      });
      handle.lifecycleState = cancelling.state;
    }
    await executeRunnerLifecycleTransition({
      transition: {
        from: handle.lifecycleState,
        to: terminalState,
        cause: "normal",
        ownership: handle.ownership,
        outcome: {
          version: "planweave.runner/v1",
          state: terminalState,
          exitCode: terminalState === "succeeded" ? 0 : null,
          finishedAt: new Date().toISOString(),
          diagnostic: terminalState === "succeeded" ? null : reason,
          artifactValidated
        }
      },
      live: { kind: "present", control: handle.control, cleanupReason: reason }
    });
    handle.lifecycleState = terminalState;
    return true;
  }
}

export const activeAgentRunRegistry = new ActiveAgentRunRegistry();
export function shutdownActiveAgentRuns(reason?: string): Promise<void> {
  return activeAgentRunRegistry.shutdown(reason);
}
export function shutdownDesktopAgentRun(desktopRunId: string, reason: string): Promise<void> {
  return activeAgentRunRegistry.shutdownDesktopRun(desktopRunId, reason);
}
