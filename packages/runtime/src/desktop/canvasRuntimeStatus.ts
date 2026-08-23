import {
  canvasRuntimeStatusProjectionSchema,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-protocol/canvas/status";
import { loadPlanGraphPackage } from "../plangraph/index.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../types.js";
import {
  loadDesktopGraphViewModelContext,
  type DesktopGraphViewModelContext
} from "./graph/readModel.js";

export type ReadAuthorizedCanvasRuntimeStatusInput = {
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  expectedPackageDir: string;
  scope: CanvasRuntimeStatusProjection["scope"];
  capturedAt?: string;
};

/**
 * Projects the owner Runtime state into the small, path-free status surface that
 * collaborators may read. Run identifiers, feedback bodies, ownership leases,
 * device paths, and executor state never cross this boundary.
 */
export async function readAuthorizedCanvasRuntimeStatus(
  input: ReadAuthorizedCanvasRuntimeStatusInput
): Promise<CanvasRuntimeStatusProjection> {
  const workspace =
    typeof input.projectRoot === "string"
      ? await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId)
      : await resolvePackageWorkspace(input.projectRoot);
  if (workspace.packageDir !== input.expectedPackageDir) {
    throw new Error("runtime_package_location_mismatch");
  }
  const context = await loadDesktopGraphViewModelContext(workspace);
  return buildAuthorizedCanvasRuntimeStatusProjection({
    context,
    scope: input.scope,
    capturedAt: input.capturedAt
  });
}

/**
 * Builds the redacted status from one Runtime context and its matching PlanGraph snapshot.
 * The package fingerprint can therefore never describe a later manifest than claim readiness.
 */
export async function buildAuthorizedCanvasRuntimeStatusProjection(input: {
  context: DesktopGraphViewModelContext;
  scope: CanvasRuntimeStatusProjection["scope"];
  capturedAt?: string;
}): Promise<CanvasRuntimeStatusProjection> {
  const { context } = input;
  const planGraphPackage = await loadPlanGraphPackage(context.workspace, {
    snapshot: {
      workspace: context.workspace,
      manifest: context.manifest,
      compiledGraph: context.graph
    }
  });
  const claimHintByRef = new Map(context.claimReadiness.claimHints.map((hint) => [hint.ref, hint]));
  return canvasRuntimeStatusProjectionSchema.parse({
    schemaVersion: "canvas-runtime-status/v2",
    scope: input.scope,
    packageFingerprint: planGraphPackage.graph.packageFingerprint,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    tasks: context.status.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      openFeedbackCount: task.openFeedbackCount
    })),
    blocks: context.status.blocks.map((block) => {
      const state = context.state.blocks[block.ref];
      if (!state) throw new Error(`runtime_block_state_missing:${block.ref}`);
      const claimHint = claimHintByRef.get(block.ref);
      if (!claimHint) throw new Error(`runtime_claim_hint_missing:${block.ref}`);
      return {
        ref: block.ref,
        status: block.status,
        completionReason: state.completionReason ?? null,
        blockedReason: state.blockedReason ?? null,
        divergenceReason: state.divergenceReason ?? null,
        dispatchable: claimHint.dispatchable
      };
    })
  });
}
