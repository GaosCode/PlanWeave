import type { CanvasRuntimeExecutionAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CapturedPackageSnapshot } from "@planweave-ai/runtime";

export type CanvasRuntimeAvailabilityPort = {
  readAvailability(
    scope: CanvasScopeRef,
    capturedAt?: string
  ): Promise<CanvasRuntimeExecutionAvailability>;
};

export type CanvasInitialContentCapturePort = {
  captureInitialContent(scope: CanvasScopeRef): Promise<CompleteContentVersion>;
};

export type CanvasPackageSnapshotRuntimePort = {
  captureSnapshot(scope: CanvasScopeRef): Promise<CapturedPackageSnapshot>;
  restoreSnapshot(input: {
    scope: CanvasScopeRef;
    snapshot: CapturedPackageSnapshot;
    beforeCommit(): void;
  }): Promise<void>;
};

export type LocalFilesystemCanvasRuntimePort = CanvasRuntimeAvailabilityPort &
  CanvasInitialContentCapturePort &
  CanvasPackageSnapshotRuntimePort;
