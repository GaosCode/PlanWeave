import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CapturedPackageSnapshot } from "@planweave-ai/runtime";

export type CanvasRuntimeStatusPort = {
  read(scope: CanvasScopeRef, capturedAt?: string): Promise<CanvasRuntimeStatusProjection>;
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

export type LocalFilesystemCanvasRuntimePort = CanvasRuntimeStatusPort &
  CanvasInitialContentCapturePort &
  CanvasPackageSnapshotRuntimePort;
