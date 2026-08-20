import {
  captureAuthorizedCanvasContent,
  capturePackageSnapshot,
  readAuthorizedCanvasRuntimeStatus,
  restorePackageSnapshot
} from "@planweave-ai/runtime";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RuntimeCanvasExpansion } from "../runtimeProjectRegistry.js";
import type { LocalFilesystemCanvasRuntimePort } from "./runtimePort.js";

export type ExactCanvasRuntimeLocationResolver = {
  resolveExactCanvasLocation(scope: CanvasScopeRef): RuntimeCanvasExpansion | undefined;
};

export function createLocalFilesystemCanvasRuntimeAdapter(
  locations: ExactCanvasRuntimeLocationResolver
): LocalFilesystemCanvasRuntimePort {
  const resolve = (scope: CanvasScopeRef): RuntimeCanvasExpansion => {
    const location = locations.resolveExactCanvasLocation(scope);
    if (!location) throw new Error("canvas_runtime_unavailable");
    return location;
  };

  return {
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
