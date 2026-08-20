import { describe, expect, it, vi } from "vitest";
import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";
import {
  CanvasRuntimeAvailabilityService,
  type CanvasRuntimeAvailabilityPort
} from "../canvas/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  actor,
  canvasCommandServiceFixture as fixture
} from "./support/canvasCommandServiceFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;

function availablePort(graphFingerprint: string): CanvasRuntimeAvailabilityPort {
  return {
    async readAvailability(requestedScope, capturedAt) {
      return {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "available",
        sourceRevision: `snapshot:${"b".repeat(64)}`,
        graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope: requestedScope,
          packageFingerprint: graphFingerprint,
          capturedAt: capturedAt ?? "2026-01-02T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      };
    }
  };
}

async function setup(runtimeAvailability?: CanvasRuntimeAvailabilityPort) {
  const context = await fixture();
  const head = context.contentVersions.head(scope);
  if (!head) throw new Error("test_content_head_missing");
  const authoritative = context.contentVersions.readVersion(scope, head.content);
  const fingerprint = projectCanvasReplicaDocument(
    decodeCanvasReplicaDocument(authoritative.content)
  ).packageFingerprint;
  const port = runtimeAvailability ?? availablePort(fingerprint);
  const readAvailability = vi.spyOn(port, "readAvailability");
  const service = new CanvasRuntimeAvailabilityService({
    access: context.access,
    workspaceIdentity: new WorkspaceIdentityRepository(context.database),
    contentVersions: context.contentVersions,
    runtimeAvailability: port,
    clock: () => new Date("2026-01-02T00:00:00.000Z")
  });
  return { ...context, fingerprint, readAvailability, service };
}

describe("CanvasRuntimeAvailabilityService", () => {
  it("returns available only when Runtime evidence matches the authoritative content head", async () => {
    const { service, fingerprint, readAvailability } = await setup();

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "available",
      graphFingerprint: fingerprint,
      status: { packageFingerprint: fingerprint }
    });
    expect(readAvailability).toHaveBeenCalledWith(scope, "2026-01-02T00:00:00.000Z");
  });

  it("preserves runtime_not_attached as an authorized HTTP-success domain result", async () => {
    const { service } = await setup({
      async readAvailability() {
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        };
      }
    });

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "runtime_not_attached"
    });
  });

  it("hides Runtime status when its graph differs from authoritative content", async () => {
    const { service } = await setup(availablePort(`pkg-${"c".repeat(64)}`));

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "content_out_of_sync"
    });
  });

  it("keeps cross-scope, ACL revocation, and revoked Canvas failures outside availability", async () => {
    const first = await setup();
    await expect(
      first.service.read(actor("viewer"), { projectId: "other", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_availability_cross_scope");
    expect(first.readAvailability).not.toHaveBeenCalled();

    first.database
      .prepare(
        "UPDATE project_access_grants SET revoked_at=? WHERE workspace_id=? AND project_id=? AND canvas_id=? AND human_principal_id=?"
      )
      .run("2026-01-03T00:00:00.000Z", "w", "p", "default", "viewer");
    await expect(
      first.service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_availability_forbidden");
    expect(first.readAvailability).not.toHaveBeenCalled();

    first.database
      .prepare(
        "UPDATE canvas_registry SET revoked_at=? WHERE workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .run("2026-01-03T00:00:00.000Z", "w", "p", "default");
    await expect(
      first.service.read(actor("owner"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_availability_unknown_canvas");
  });
});
