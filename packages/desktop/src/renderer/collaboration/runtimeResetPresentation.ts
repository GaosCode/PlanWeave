import type { CanvasRuntimeResetFailureCode } from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import type { TranslationKey } from "../i18nCatalog";

export type WorkspaceRuntimeResetPresentationCode =
  | CanvasRuntimeResetFailureCode
  | "projection_postcondition_failed";

const resetFailureKeys: Record<WorkspaceRuntimeResetPresentationCode, TranslationKey> = {
  forbidden: "runtimeResetForbidden",
  host_offline: "runtimeResetHostOffline",
  active_lease: "runtimeResetActiveLease",
  source_drift: "runtimeResetSourceDrift",
  persist_failed: "runtimeResetPersistFailed",
  reconcile_required: "runtimeResetReconcileRequired",
  unavailable: "runtimeResetUnavailable",
  conflict: "runtimeResetConflict",
  invalid_request: "runtimeResetInvalidRequest",
  projection_postcondition_failed: "runtimeResetProjectionPostconditionFailed"
};

export class WorkspaceRuntimeResetPresentationError extends Error {
  constructor(
    readonly diagnosticCode: WorkspaceRuntimeResetPresentationCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkspaceRuntimeResetPresentationError";
  }
}

export function presentWorkspaceRuntimeResetError(
  translate: (key: TranslationKey) => string,
  caught: unknown
): WorkspaceRuntimeResetPresentationError {
  if (caught instanceof WorkspaceRuntimeResetPresentationError) return caught;
  const diagnostic =
    caught && typeof caught === "object" && "code" in caught
      ? String(caught.code)
      : caught instanceof Error
        ? caught.message
        : "";
  const code: WorkspaceRuntimeResetPresentationCode = diagnostic.includes(
    "projection_postcondition"
  )
    ? "projection_postcondition_failed"
    : diagnostic.includes("operation_id_mismatch") || diagnostic.includes("reconcile")
      ? "reconcile_required"
      : "unavailable";
  return new WorkspaceRuntimeResetPresentationError(code, translate(resetFailureKeys[code]), {
    cause: caught
  });
}

export function workspaceRuntimeResetError(
  translate: (key: TranslationKey) => string,
  code: WorkspaceRuntimeResetPresentationCode
): WorkspaceRuntimeResetPresentationError {
  return new WorkspaceRuntimeResetPresentationError(code, translate(resetFailureKeys[code]));
}
