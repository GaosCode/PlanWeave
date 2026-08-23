import type { CanvasRuntimeInitializeFailureCode } from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import type { TranslationKey } from "../i18nCatalog";

export type WorkspaceRuntimeInitializePresentationCode =
  | CanvasRuntimeInitializeFailureCode
  | "projection_postcondition_failed";

const initializeFailureKeys: Record<WorkspaceRuntimeInitializePresentationCode, TranslationKey> = {
  forbidden: "runtimeInitializeForbidden",
  host_offline: "runtimeInitializeHostOffline",
  active_lease: "runtimeInitializeActiveLease",
  source_drift: "runtimeInitializeSourceDrift",
  persist_failed: "runtimeInitializePersistFailed",
  unavailable: "runtimeInitializeUnavailable",
  conflict: "runtimeInitializeConflict",
  invalid_request: "runtimeInitializeInvalidRequest",
  projection_postcondition_failed: "runtimeInitializeProjectionPostconditionFailed"
};

export class WorkspaceRuntimeInitializePresentationError extends Error {
  constructor(
    readonly diagnosticCode: WorkspaceRuntimeInitializePresentationCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkspaceRuntimeInitializePresentationError";
  }
}

export function workspaceRuntimeInitializeError(
  translate: (key: TranslationKey) => string,
  code: WorkspaceRuntimeInitializePresentationCode
): WorkspaceRuntimeInitializePresentationError {
  return new WorkspaceRuntimeInitializePresentationError(
    code,
    translate(initializeFailureKeys[code])
  );
}

export function presentWorkspaceRuntimeInitializeError(
  translate: (key: TranslationKey) => string,
  caught: unknown
): WorkspaceRuntimeInitializePresentationError {
  if (caught instanceof WorkspaceRuntimeInitializePresentationError) return caught;
  const diagnostic =
    caught && typeof caught === "object" && "code" in caught
      ? String(caught.code)
      : caught instanceof Error
        ? caught.message
        : "";
  const code: WorkspaceRuntimeInitializePresentationCode = diagnostic.includes(
    "projection_postcondition"
  )
    ? "projection_postcondition_failed"
    : "unavailable";
  return new WorkspaceRuntimeInitializePresentationError(
    code,
    translate(initializeFailureKeys[code]),
    { cause: caught }
  );
}
