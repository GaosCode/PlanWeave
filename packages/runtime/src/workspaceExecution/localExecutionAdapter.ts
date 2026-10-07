import {
  capturePackageSnapshot,
  packageSnapshotGraphFingerprint
} from "../package/packageSnapshot.js";
import { packageExecutionSnapshot } from "../package/packageExecutionSnapshot.js";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { runWithSession } from "../runSessions/runWithSession.js";
import {
  localWorkspaceExecutionHandleSchema,
  type LocalWorkspaceAuthorityBinding
} from "./contracts.js";
import {
  assertValidatedWorkspaceAuthorityBinding,
  assertWorkspaceContentMatches
} from "./authorityBinding.js";
import type { LocalWorkspaceExecutionAdapter } from "./ports.js";

export function createLocalWorkspaceExecutionAdapter(
  input: { run?: typeof runWithSession } = {}
): LocalWorkspaceExecutionAdapter {
  const run = input.run ?? runWithSession;
  return {
    async launch({ request, binding, signal }) {
      assertValidatedWorkspaceAuthorityBinding(binding);
      if (binding.kind !== "local") {
        throw new Error("workspace_execution_local_binding_required");
      }
      const localBinding: LocalWorkspaceAuthorityBinding = binding;
      const workspace = localBinding.canvasId
        ? await resolveTaskCanvasWorkspace(localBinding.packageWorkspace, localBinding.canvasId)
        : await resolvePackageWorkspace(localBinding.packageWorkspace);
      const captured = await capturePackageSnapshot({ projectRoot: workspace });
      assertWorkspaceContentMatches(localBinding, {
        ...localBinding,
        contentRevision: captured.snapshot.sourceRevision,
        graphFingerprint: packageSnapshotGraphFingerprint(captured.snapshot)
      });
      if (workspace.packageDir !== captured.resolvedPackageDir)
        throw new Error("runtime_package_location_mismatch");
      const executionSnapshot = packageExecutionSnapshot(workspace, captured.snapshot);
      const result = await run({
        executionSnapshot,
        projectRoot: workspace,
        scope: request.scope,
        executorName: request.executorOverride,
        once: true,
        signal
      });
      const terminal =
        result.terminalReason === "manual" || result.terminalReason === "blocked"
          ? ({ terminal: false, reason: "action_required" } as const)
          : ({
              terminal: true,
              outcome:
                result.terminalReason === "cancelled"
                  ? "cancelled"
                  : result.ok
                    ? "completed"
                    : "failed"
            } as const);
      return {
        session: result.session,
        handle: localWorkspaceExecutionHandleSchema.parse({
          version: "planweave.workspace-execution-handle/v1",
          target: "local",
          runSessionId: result.session.sessionId,
          authorityBindingId: localBinding.bindingId,
          localRunId: result.session.sessionId,
          scope: request.scope,
          capabilities: { interactionResponse: false },
          cursor: { target: "local", sequence: result.steps.length }
        }),
        terminal
      };
    }
  };
}
