import { describe, expect, it, vi } from "vitest";
import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";
import {
  CanvasRuntimeAvailabilityService,
  CanvasRuntimeStatusRepository,
  type CanvasRuntimeAvailabilityPort
} from "../canvas/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  actor,
  canvasCommandServiceFixture as fixture
} from "./support/canvasCommandServiceFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;
const capturedAt = "2026-01-02T00:00:00.000Z";

function status(packageFingerprint: string) {
  return {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint,
    capturedAt,
    tasks: [],
    blocks: []
  };
}

function availablePort(graphFingerprint: string): CanvasRuntimeAvailabilityPort {
  return {
    async readAvailability(requestedScope, requestedAt) {
      return {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "available",
        sourceRevision: `snapshot:${"b".repeat(64)}`,
        graphFingerprint,
        status: {
          ...status(graphFingerprint),
          scope: requestedScope,
          capturedAt: requestedAt ?? capturedAt
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
  const runtimeStatuses = new CanvasRuntimeStatusRepository(
    context.database,
    () => new Date(capturedAt)
  );
  const service = new CanvasRuntimeAvailabilityService({
    access: context.access,
    workspaceIdentity: new WorkspaceIdentityRepository(context.database),
    contentVersions: context.contentVersions,
    runtimeAvailability: port,
    runtimeStatuses,
    clock: () => new Date(capturedAt)
  });
  return { ...context, fingerprint, readAvailability, runtimeStatuses, service };
}

describe("CanvasRuntimeAvailabilityService", () => {
  it("keeps shared state uninitialized until an explicit import", async () => {
    const { service, fingerprint, readAvailability } = await setup();

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "uninitialized" },
      execution: {
        kind: "available",
        graphFingerprint: fingerprint,
        status: { packageFingerprint: fingerprint }
      }
    });
    expect(readAvailability).toHaveBeenCalledWith(scope, capturedAt);
  });

  it("keeps Server-authoritative state visible while no execution device is attached", async () => {
    const { service, fingerprint, runtimeStatuses } = await setup({
      async readAvailability() {
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        };
      }
    });
    runtimeStatuses.initialize(status(fingerprint));

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toEqual({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "initialized", status: status(fingerprint) },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached"
      }
    });
  });

  it("hides mismatched execution evidence without clearing Server state", async () => {
    const { service, fingerprint, runtimeStatuses } = await setup(
      availablePort(`pkg-${"c".repeat(64)}`)
    );
    runtimeStatuses.initialize(status(fingerprint));

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toEqual({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "initialized", status: status(fingerprint) },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "content_out_of_sync"
      }
    });
  });

  it("imports an exact status once and never overwrites an initialized Server state", async () => {
    const { service, fingerprint } = await setup();
    const imported = status(fingerprint);

    expect(
      service.importInitial(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: { status: imported }
      })
    ).toEqual({ kind: "initialized", status: imported });
    expect(() =>
      service.importInitial(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: {
          status: { ...imported, capturedAt: "2026-01-03T00:00:00.000Z" }
        }
      })
    ).toThrow("canvas_runtime_status_already_initialized");
  });

  it("keeps cross-scope and ACL failures outside the Runtime view", async () => {
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
  });
});
