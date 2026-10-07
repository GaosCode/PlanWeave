import type { CanvasExecutionRuntimeLease } from "./canvas/executionRuntimePort.js";
import type { RemoteOperationRepository } from "./remoteOperations.js";
import { classifyReenterFailure, diagnosticFromReenterFailure } from "./remoteReenterRecovery.js";

/** Release one acquired lease without replacing a fatal primary failure with a transient cleanup failure. */
export async function withRemoteRuntimeLease<T>(
  operations: RemoteOperationRepository,
  operationId: string,
  lease: CanvasExecutionRuntimeLease,
  execute: () => Promise<T>
): Promise<T> {
  let outcome: { kind: "success"; value: T } | { kind: "failure"; error: unknown };
  try {
    outcome = { kind: "success", value: await execute() };
  } catch (error) {
    outcome = { kind: "failure", error };
  }
  const primary = outcome.kind === "failure" ? outcome : undefined;
  try {
    await lease.release();
  } catch (cleanupError) {
    const cleanup = diagnosticFromReenterFailure(cleanupError);
    const preferredError =
      primary && classifyReenterFailure(primary.error) === "fatal"
        ? primary.error
        : classifyReenterFailure(cleanupError) === "fatal" || !primary
          ? cleanupError
          : primary.error;
    const preferred = diagnosticFromReenterFailure(preferredError);
    operations.recordDiagnostic(
      operationId,
      cleanup.code,
      `Runtime lease release failed: ${cleanup.message}`.slice(0, 4096),
      { includeTerminal: true }
    );
    operations.recordDiagnostic(
      operationId,
      preferred.code,
      `${preferred.message}; Runtime lease release failed: ${cleanup.message}`.slice(0, 4096),
      { includeTerminal: true }
    );
    throw preferredError;
  }
  if (outcome.kind === "failure") throw outcome.error;
  return outcome.value;
}
