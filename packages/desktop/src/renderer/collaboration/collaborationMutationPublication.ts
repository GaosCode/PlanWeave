import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workItemKey,
  type CollaborationBoundaryErrorView,
  type CollaborationMutationRecord
} from "../../shared/collaborationReadModels.js";
import { collaborationBoundaryErrorFromUnknown } from "./collaborationBoundaryError.js";
import type { CollaborationMutationLedger } from "./collaborationRetention.js";

export interface CollaborationMutationInput<T> {
  kind: CollaborationMutationRecord["kind"];
  workItem?: WorkItemRef;
  expectedRevision?: number;
  execute: () => Promise<T>;
  onConfirmed: (result: T) => void;
}

/** Server completion survives scope retirement; only local publication is fenced. */
export async function publishCollaborationMutation<T extends { revision?: number }>(
  input: CollaborationMutationInput<T>,
  owner: {
    mutationId: string;
    ledger: CollaborationMutationLedger;
    now: () => string;
    isCurrent: () => boolean;
    emit: () => void;
    onConfirmed: () => void;
    onError: (error: CollaborationBoundaryErrorView) => void;
  }
): Promise<T | null> {
  const record: CollaborationMutationRecord = {
    mutationId: owner.mutationId,
    kind: input.kind,
    workItemKey: input.workItem ? workItemKey(input.workItem) : undefined,
    status: "pending",
    expectedRevision: input.expectedRevision,
    submittedAt: owner.now()
  };
  owner.ledger.setPending(record);
  try {
    // Start against the captured connection before notifying potentially reentrant subscribers.
    const completion = input.execute();
    if (owner.isCurrent()) owner.emit();
    const result = await completion;
    owner.ledger.setTerminal({
      ...record,
      status: "confirmed",
      confirmedRevision:
        typeof result.revision === "number" ? result.revision : input.expectedRevision,
      resolvedAt: owner.now()
    });
    if (!owner.isCurrent()) return result;
    input.onConfirmed(result);
    owner.onConfirmed();
    owner.emit();
    return result;
  } catch (error) {
    const mapped = collaborationBoundaryErrorFromUnknown(error);
    owner.ledger.setTerminal({
      ...record,
      status: mapped.kind === "offline" || mapped.kind === "timeout" ? "offline" : "rejected",
      errorKind: mapped.kind,
      errorCode: mapped.code,
      errorMessage: mapped.message,
      resolvedAt: owner.now()
    });
    if (!owner.isCurrent()) throw error;
    owner.onError(mapped);
    owner.emit();
    return null;
  }
}
