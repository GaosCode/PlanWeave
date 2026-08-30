import { describe, expect, it, vi } from "vitest";
import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";
import {
  CanvasRuntimeAvailabilityService,
  type CanvasRuntimeAuthorityAvailabilityPort,
  type CanvasRuntimeAvailabilityPort
} from "../canvas/index.js";
import { createInvalidatingCanvasRuntimeStatusRepository } from "../canvas/runtimeStatusInvalidation.js";
import { readStableCanvasRuntimeEvidence } from "../canvas/contentFingerprint.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
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

function availablePort(
  graphFingerprint: string,
  sourceRevision = `snapshot:${"b".repeat(64)}`
): CanvasRuntimeAvailabilityPort {
  return {
    async readAvailability(requestedScope, requestedAt) {
      return {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "available",
        sourceRevision,
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
  const evidence = readStableCanvasRuntimeEvidence(context.contentVersions, scope);
  if (!evidence) throw new Error("test_runtime_authority_missing");
  const authority = {
    revision: evidence.target.revision,
    sourceRevision: evidence.sourceRevision,
    graphFingerprint: evidence.target.graphFingerprint
  };
  const port = runtimeAvailability ?? availablePort(fingerprint, authority.sourceRevision);
  const readAvailability = vi.spyOn(port, "readAvailability");
  const authorityPort: CanvasRuntimeAuthorityAvailabilityPort = {
    readAvailabilityForAuthority: (requestedScope, requestedAt) =>
      port.readAvailability(requestedScope, requestedAt)
  };
  const runtimeStatuses = createInvalidatingCanvasRuntimeStatusRepository({
    database: context.database,
    observerJournal: new HumanObserverJournal(context.database, 100),
    clock: () => new Date(capturedAt)
  });
  const service = new CanvasRuntimeAvailabilityService({
    access: context.access,
    workspaceIdentity: new WorkspaceIdentityRepository(context.database),
    contentVersions: context.contentVersions,
    runtimeAvailability: authorityPort,
    runtimeStatuses,
    clock: () => new Date(capturedAt)
  });
  return { ...context, authority, fingerprint, readAvailability, runtimeStatuses, service };
}

describe("CanvasRuntimeAvailabilityService", () => {
  it("keeps shared state uninitialized until an authoritative execution result", async () => {
    const { service, authority, fingerprint, readAvailability } = await setup();

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-view/v2",
      authority,
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
    const { service, authority, fingerprint, runtimeStatuses } = await setup({
      async readAvailability() {
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        };
      }
    });
    runtimeStatuses.replaceFromExecution(status(fingerprint));

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toEqual({
      schemaVersion: "canvas-runtime-view/v2",
      authority,
      state: { kind: "initialized", runtimeRevision: 1, status: status(fingerprint) },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached"
      }
    });
  });

  it("hides mismatched execution evidence without clearing Server state", async () => {
    const { service, authority, fingerprint, runtimeStatuses } = await setup(
      availablePort(`pkg-${"c".repeat(64)}`)
    );
    runtimeStatuses.replaceFromExecution(status(fingerprint));

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toEqual({
      schemaVersion: "canvas-runtime-view/v2",
      authority,
      state: { kind: "initialized", runtimeRevision: 1, status: status(fingerprint) },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "content_out_of_sync"
      }
    });
  });

  it("rejects stale source evidence even when the package fingerprint still matches", async () => {
    let graphFingerprint: string | undefined;
    const stalePort: CanvasRuntimeAvailabilityPort = {
      async readAvailability(requestedScope, requestedAt) {
        if (!graphFingerprint) throw new Error("test_graph_fingerprint_missing");
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "available",
          sourceRevision: `snapshot:${"c".repeat(64)}`,
          graphFingerprint,
          status: {
            ...status(graphFingerprint),
            scope: requestedScope,
            capturedAt: requestedAt ?? capturedAt
          }
        };
      }
    };
    const { service, authority, fingerprint } = await setup(stalePort);
    graphFingerprint = fingerprint;

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-view/v2",
      authority,
      execution: {
        kind: "unavailable",
        reason: "content_out_of_sync"
      }
    });
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
