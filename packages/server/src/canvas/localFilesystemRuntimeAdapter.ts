import {
  captureAuthorizedCanvasContent,
  capturePackageSnapshot,
  readAuthorizedCanvasRuntimeStatus,
  restorePackageSnapshot
} from "@planweave-ai/runtime";
import { canvasRuntimeAvailabilitySchema } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RuntimeCanvasExpansion } from "../runtimeProjectRegistry.js";
import type { LocalFilesystemCanvasRuntimePort } from "./runtimePort.js";

export type ExactCanvasRuntimeLocationResolver = {
  resolveExactCanvasLocation(scope: CanvasScopeRef): RuntimeCanvasExpansion | undefined;
};

function filesystemErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function createLocalFilesystemCanvasRuntimeAdapter(
  locations: ExactCanvasRuntimeLocationResolver
): LocalFilesystemCanvasRuntimePort {
  const resolve = (scope: CanvasScopeRef): RuntimeCanvasExpansion => {
    const location = locations.resolveExactCanvasLocation(scope);
    if (!location) throw new Error("canvas_runtime_unavailable");
    return location;
  };

  return {
    async readAvailability(scope, capturedAt) {
      const location = locations.resolveExactCanvasLocation(scope);
      if (!location) {
        return canvasRuntimeAvailabilitySchema.parse({
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        });
      }
      try {
        const before = await capturePackageSnapshot({
          projectRoot: location.projectRoot,
          canvasId: scope.canvasId
        });
        const status = await readAuthorizedCanvasRuntimeStatus({
          projectRoot: location.projectRoot,
          canvasId: scope.canvasId,
          expectedPackageDir: location.packageDir,
          scope,
          capturedAt
        });
        const after = await capturePackageSnapshot({
          projectRoot: location.projectRoot,
          canvasId: scope.canvasId
        });
        if (
          before.resolvedPackageDir !== location.packageDir ||
          after.resolvedPackageDir !== location.packageDir
        ) {
          return canvasRuntimeAvailabilitySchema.parse({
            schemaVersion: "canvas-runtime-availability/v1",
            kind: "unavailable",
            reason: "runtime_not_attached"
          });
        }
        if (before.snapshot.sourceRevision !== after.snapshot.sourceRevision) {
          return canvasRuntimeAvailabilitySchema.parse({
            schemaVersion: "canvas-runtime-availability/v1",
            kind: "unavailable",
            reason: "content_out_of_sync"
          });
        }
        return canvasRuntimeAvailabilitySchema.parse({
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "available",
          status,
          sourceRevision: after.snapshot.sourceRevision,
          graphFingerprint: status.packageFingerprint
        });
      } catch (error) {
        const code = filesystemErrorCode(error);
        const message = error instanceof Error ? error.message : "";
        if (
          code === "ENOENT" ||
          code === "ENOTDIR" ||
          code === "EACCES" ||
          message === "runtime_package_location_mismatch"
        ) {
          return canvasRuntimeAvailabilitySchema.parse({
            schemaVersion: "canvas-runtime-availability/v1",
            kind: "unavailable",
            reason: "runtime_not_attached"
          });
        }
        throw error;
      }
    },
    async read(scope, capturedAt) {
      const location = resolve(scope);
      return readAuthorizedCanvasRuntimeStatus({
        projectRoot: location.projectRoot,
        canvasId: scope.canvasId,
        expectedPackageDir: location.packageDir,
        scope,
        capturedAt
      });
    },
    async captureInitialContent(scope) {
      const location = resolve(scope);
      const captured = await captureAuthorizedCanvasContent({
        projectRoot: location.projectRoot,
        canvasId: scope.canvasId,
        expectedPackageDir: location.packageDir,
        authorityProjectId: scope.projectId
      });
      return captured.content;
    },
    async captureSnapshot(scope) {
      const location = resolve(scope);
      const captured = await capturePackageSnapshot({
        projectRoot: location.projectRoot,
        canvasId: scope.canvasId
      });
      if (captured.resolvedPackageDir !== location.packageDir) {
        throw new Error("runtime_package_location_mismatch");
      }
      return captured.snapshot;
    },
    async restoreSnapshot(input) {
      const location = resolve(input.scope);
      await restorePackageSnapshot({
        projectRoot: location.projectRoot,
        canvasId: input.scope.canvasId,
        expectedPackageDir: location.packageDir,
        snapshot: input.snapshot,
        beforeCommit: input.beforeCommit
      });
    }
  };
}
