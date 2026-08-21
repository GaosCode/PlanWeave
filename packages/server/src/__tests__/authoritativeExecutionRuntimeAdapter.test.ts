import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { AuthoritativeExecutionRuntimeAdapter } from "../canvas/authoritativeExecutionRuntimeAdapter.js";

const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" };
const fingerprint = `pkg-${"a".repeat(64)}`;
const claimInput = {
  ref: "T-001#B-001",
  operationId: "operation-1",
  controlPlane: "owner" as const,
  sourceRevision: "source-1",
  graphFingerprint: fingerprint
};
const binding = { ref: claimInput.ref, status: "in_progress" as const };

function runtime(): RemoteBlockRuntimePort {
  return {
    inspect: vi.fn(),
    claim: vi.fn(async () => binding),
    activate: vi.fn(),
    query: vi.fn(),
    reconcile: vi.fn(),
    markInterrupted: vi.fn(),
    resumeAttempt: vi.fn(),
    retryAttempt: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn()
  };
}

function status(packageFingerprint = fingerprint): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope,
    packageFingerprint,
    capturedAt: "2026-08-21T00:00:00.000Z",
    tasks: [],
    blocks: []
  };
}

describe("AuthoritativeExecutionRuntimeAdapter", () => {
  it("persists the real Runtime projection after a shared-canvas mutation", async () => {
    const replaceFromExecution = vi.fn((value: CanvasRuntimeStatusProjection) => value);
    const readStatus = vi.fn(async () => status());
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus,
          release: vi.fn()
        }))
      },
      readContentFingerprint: () => fingerprint,
      runtimeStatuses: { replaceFromExecution }
    });

    const lease = await adapter.acquire(scope);
    await expect(lease.runtime.claim(claimInput)).resolves.toEqual(binding);
    expect(readStatus).toHaveBeenCalledOnce();
    expect(replaceFromExecution).toHaveBeenCalledWith(status());
  });

  it("does not involve Server state for a local-only canvas", async () => {
    const readStatus = vi.fn(async () => status());
    const replaceFromExecution = vi.fn((value: CanvasRuntimeStatusProjection) => value);
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus,
          release: vi.fn()
        }))
      },
      readContentFingerprint: () => undefined,
      runtimeStatuses: { replaceFromExecution }
    });

    const lease = await adapter.acquire(scope);
    await lease.runtime.claim(claimInput);
    expect(readStatus).not.toHaveBeenCalled();
    expect(replaceFromExecution).not.toHaveBeenCalled();
  });

  it("refuses to overwrite Server state with a different content fingerprint", async () => {
    const replaceFromExecution = vi.fn((value: CanvasRuntimeStatusProjection) => value);
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus: vi.fn(async () => status(`pkg-${"b".repeat(64)}`)),
          release: vi.fn()
        }))
      },
      readContentFingerprint: () => fingerprint,
      runtimeStatuses: { replaceFromExecution }
    });

    const lease = await adapter.acquire(scope);
    await expect(lease.runtime.claim(claimInput)).rejects.toThrow(
      "canvas_runtime_status_content_out_of_sync"
    );
    expect(replaceFromExecution).not.toHaveBeenCalled();
  });
});
