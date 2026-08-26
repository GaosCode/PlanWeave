import { RemoteBlockRuntimeError, RemoteOwnershipConflictError } from "@planweave-ai/runtime";
import { AgentEndpointCatalogError } from "./agentEndpointCatalog.js";
import { CanvasRuntimeUnavailableError } from "./canvas/executionRuntimePort.js";

/**
 * Startup / batch reenter policy for a single remote operation.
 * Infrastructure failures stay fatal; op-local failures must not abort the whole server.
 */
export type ReenterFailureDecision = "defer_host" | "seal_failed" | "fatal";

const OP_LOCAL_ERROR_NAMES = new Set(["RemoteBlockRuntimeError", "RemoteOwnershipConflictError"]);

const OP_LOCAL_MESSAGE_CODES = new Set([
  "remote_source_changed",
  "remote_operation_candidate_missing",
  "remote_completion_evidence_missing",
  "remote_failure_evidence_missing",
  "remote_dispatch_not_awaiting_writeback",
  "remote_dispatch_not_found",
  "remote_terminal_attempt_not_bound",
  "remote_terminal_persistence_conflict",
  "runtime_reconciliation_conflict"
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/** True when package writeback rejected Host complete evidence (any runtime domain code). */
export function isWritebackDomainFailure(error: unknown): boolean {
  return error instanceof RemoteBlockRuntimeError;
}

/** Ownership already unbound; Server can still seal dispatch/operation terminal state. */
export function isMissingActiveOwnership(error: unknown): boolean {
  return (
    error instanceof RemoteOwnershipConflictError && error.code === "remote_ownership_not_active"
  );
}

export function diagnosticFromReenterFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AgentEndpointCatalogError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof CanvasRuntimeUnavailableError) {
    return { code: error.reason, message: error.reason };
  }
  if (error instanceof RemoteBlockRuntimeError || error instanceof RemoteOwnershipConflictError) {
    return { code: error.code, message: error.message };
  }
  const message = errorMessage(error);
  if (OP_LOCAL_MESSAGE_CODES.has(message)) {
    return { code: message, message };
  }
  return {
    code: "remote_reenter_operation_failed",
    message: message || "Remote operation recovery failed."
  };
}

/**
 * Classify a failure thrown while recovering one operation in {@link RemoteBlockCoordinator.reenterPending}.
 * Checkpoint / crash-injection failures remain fatal so restart can continue from a consistent cut.
 */
export function classifyReenterFailure(error: unknown): ReenterFailureDecision {
  if (
    error instanceof AgentEndpointCatalogError ||
    error instanceof CanvasRuntimeUnavailableError
  ) {
    return "defer_host";
  }

  const message = errorMessage(error);
  if (message.startsWith("injected_crash:")) return "fatal";
  if (error instanceof AggregateError) return "fatal";

  if (isWritebackDomainFailure(error) || isMissingActiveOwnership(error)) return "seal_failed";
  if (OP_LOCAL_ERROR_NAMES.has(errorName(error))) return "seal_failed";
  if (OP_LOCAL_MESSAGE_CODES.has(message)) return "seal_failed";

  return "fatal";
}
