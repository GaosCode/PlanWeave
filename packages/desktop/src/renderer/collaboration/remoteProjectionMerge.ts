import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type { CollaborationRemoteRunProjection } from "../../shared/collaborationReadModels.js";
import { workItemKey } from "../../shared/collaborationReadModels.js";

type OrderedProjection = {
  identity: string;
  observedAt: string;
  revision?: number;
  scopeKey: string;
};

/**
 * Select by Server persistence order within one explicit scope. A projection without a
 * revision can seed an empty scope, but cannot overwrite a revisioned observer/read result.
 */
export function selectMonotonicRemoteProjection<T>(input: {
  current: T | null;
  incoming: T;
  expectedScopeKey: string;
  order: (value: T) => OrderedProjection;
}): T | null {
  const incomingOrder = input.order(input.incoming);
  if (incomingOrder.scopeKey !== input.expectedScopeKey) return input.current;
  if (!input.current) return input.incoming;
  const currentOrder = input.order(input.current);
  if (currentOrder.scopeKey !== input.expectedScopeKey) return input.incoming;
  if (currentOrder.revision !== undefined || incomingOrder.revision !== undefined) {
    if (incomingOrder.revision === undefined) return input.current;
    if (currentOrder.revision === undefined) return input.incoming;
    if (incomingOrder.revision !== currentOrder.revision) {
      return incomingOrder.revision > currentOrder.revision ? input.incoming : input.current;
    }
  }
  if (incomingOrder.identity === currentOrder.identity) {
    return incomingOrder.observedAt >= currentOrder.observedAt ? input.incoming : input.current;
  }
  return incomingOrder.observedAt > currentOrder.observedAt ? input.incoming : input.current;
}

export function remoteOperationScopeKey(input: {
  projectId: string;
  canvasId: string;
  blockRef: string;
}): string {
  return JSON.stringify([input.projectId, input.canvasId, input.blockRef]);
}

export function selectRemoteOperationObservation(input: {
  current: RemoteOperationObservation | null;
  incoming: RemoteOperationObservation;
  expectedScopeKey: string;
}): RemoteOperationObservation | null {
  return selectMonotonicRemoteProjection({
    ...input,
    order: (value) => ({
      identity: value.operationId,
      observedAt: value.updatedAt,
      revision: value.diagnostics?.revision,
      scopeKey: remoteOperationScopeKey(value)
    })
  });
}

export function remoteRunProjectionScopeKey(value: CollaborationRemoteRunProjection): string {
  return JSON.stringify([
    value.projectId,
    value.workItem ? workItemKey(value.workItem) : value.dispatchId
  ]);
}

export function selectRemoteRunProjection(input: {
  current: CollaborationRemoteRunProjection | null;
  incoming: CollaborationRemoteRunProjection;
}): CollaborationRemoteRunProjection {
  return (
    selectMonotonicRemoteProjection({
      ...input,
      expectedScopeKey: remoteRunProjectionScopeKey(input.incoming),
      order: (value) => ({
        identity: value.dispatchId,
        observedAt: value.updatedAt,
        revision: value.observerCursor,
        scopeKey: remoteRunProjectionScopeKey(value)
      })
    }) ?? input.incoming
  );
}
