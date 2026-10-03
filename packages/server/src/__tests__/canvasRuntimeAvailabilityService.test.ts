import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
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
import { ArtifactStore } from "../artifacts.js";
import { AgentHostRepository } from "../hosts.js";
import { DurableMailbox, type MailboxMessage } from "../mailbox.js";
import { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { RemoteHostCanvasRuntimeAdapter } from "../canvas/remoteHostRuntimeAdapter.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import {
  respondToRuntimeRequest,
  runtimeRequestCommandAt
} from "./support/remoteHostRuntimeTestEnvironment.js";
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

  it("reflects offline and reconnected devices without changing content or runtime state", async () => {
    const { service, authority, fingerprint, readAvailability, runtimeStatuses } = await setup();
    runtimeStatuses.replaceFromExecution(status(fingerprint));
    const state = { kind: "initialized", runtimeRevision: 1, status: status(fingerprint) };

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({ authority, state, execution: { kind: "available" } });

    readAvailability.mockResolvedValueOnce({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "host_offline"
    });
    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      authority,
      state,
      execution: { kind: "unavailable", reason: "host_offline" }
    });

    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({ authority, state, execution: { kind: "available" } });
    expect(runtimeStatuses.read(scope)).toMatchObject({
      runtimeRevision: 1,
      status: status(fingerprint)
    });
  });

  it("isolates old attachment replies from a reconnected Host without rewriting shared state", async () => {
    const context = await setup();
    const evidence = readStableCanvasRuntimeEvidence(context.contentVersions, scope);
    if (!evidence) throw new Error("test_runtime_authority_missing");
    const hosts = new AgentHostRepository(context.database);
    const host = hosts.register("Availability Host").host;
    const reportOnline = () =>
      hosts.reportOnline(host.id, [CANVAS_RUNTIME_CAPABILITY], 1, {
        workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
        acpProfiles: [],
        runtimeProjects: [
          { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
        ]
      });
    reportOnline();
    const mailbox = new DurableMailbox(context.database);
    const broker = new CanvasRuntimeRpcBroker(context.database, hosts, mailbox, {
      requestTimeoutMs: 1_000
    });
    let attached = true;
    broker.attachSessionLookup({ isActive: (hostId) => attached && hostId === host.id });
    const deliveries: MailboxMessage[] = [];
    const unsubscribe = mailbox.subscribe(host.id, (message) => deliveries.push(message));
    const locator = new CanvasRuntimeHostLocator(
      hosts.runtimeBindings,
      hosts,
      broker,
      context.access
    );
    const adapter = new RemoteHostCanvasRuntimeAdapter(
      locator,
      broker,
      { read: () => evidence.target },
      {
        grants: new RuntimeArtifactGrantRepository(context.database, { maxArtifactBytes: 1024 }),
        artifacts: new ArtifactStore(context.database, "/not-observed", 1024)
      }
    );
    const service = new CanvasRuntimeAvailabilityService({
      access: context.access,
      workspaceIdentity: new WorkspaceIdentityRepository(context.database),
      contentVersions: context.contentVersions,
      runtimeAvailability: adapter,
      runtimeStatuses: context.runtimeStatuses,
      clock: () => new Date(capturedAt)
    });
    const persisted = context.runtimeStatuses.replaceFromExecution(status(context.fingerprint));
    const head = context.contentVersions.head(scope);
    const respond = (
      command: ReturnType<typeof runtimeRequestCommandAt>,
      sourceRevision = evidence.sourceRevision
    ) =>
      respondToRuntimeRequest(broker, host.id, command, {
        outcome: "success",
        operation: "availability",
        result: {
          kind: "available",
          sourceRevision,
          graphFingerprint: context.fingerprint,
          status: status(context.fingerprint)
        }
      });
    const read = () => service.read(actor("viewer"), { projectId: "p", canvasId: "default" });

    try {
      const online = read();
      respond(runtimeRequestCommandAt(deliveries, 0));
      await expect(online).resolves.toMatchObject({
        execution: { kind: "available", hostId: host.id }
      });
      const oldAttachmentVersion = broker.attachmentVersion(host.id);
      const interrupted = read();
      const oldRequest = runtimeRequestCommandAt(deliveries, 1);
      expect(broker.pendingCount()).toBe(1);
      attached = false;
      broker.detachHost(host.id, "disconnected");
      expect(broker.pendingCount()).toBe(0);
      await expect(interrupted).resolves.toMatchObject({
        execution: { kind: "unavailable", reason: "host_offline" }
      });
      await expect(read()).resolves.toMatchObject({
        execution: { kind: "unavailable", reason: "host_offline" }
      });
      expect(deliveries).toHaveLength(2);
      expect(context.runtimeStatuses.read(scope)).toEqual(persisted);

      attached = true;
      reportOnline();
      expect(broker.attachmentVersion(host.id)).toBeGreaterThan(oldAttachmentVersion);
      const reconnected = read();
      const newRequest = runtimeRequestCommandAt(deliveries, 2);
      expect(newRequest.requestId).not.toBe(oldRequest.requestId);
      respond(oldRequest);
      expect(broker.pendingCount()).toBe(1);
      respond(newRequest, `snapshot:${"c".repeat(64)}`);
      await expect(reconnected).resolves.toMatchObject({
        execution: { kind: "unavailable", reason: "content_out_of_sync" }
      });

      const restored = read();
      respond(runtimeRequestCommandAt(deliveries, 3));
      await expect(restored).resolves.toMatchObject({
        execution: { kind: "available", hostId: host.id }
      });
      expect(broker.pendingCount()).toBe(0);
      context.database
        .prepare(
          "UPDATE project_access_grants SET revoked_at=? WHERE workspace_id=? AND project_id=? AND canvas_id=? AND human_principal_id=?"
        )
        .run("2026-01-03T00:00:00.000Z", "w", "p", "default", "viewer");
      await expect(read()).rejects.toThrow("canvas_runtime_availability_forbidden");
      expect(deliveries).toHaveLength(4);
      expect(context.runtimeStatuses.read(scope)).toEqual(persisted);
      expect(context.contentVersions.head(scope)).toEqual(head);
    } finally {
      unsubscribe();
      broker.close();
    }
  });

  it("queries the device for each read with the existing bounded content validation cost", async () => {
    const { service, authority, contentVersions, readAvailability } = await setup();
    const readVersion = vi.spyOn(contentVersions, "readVersion");
    const verify = vi.spyOn(contentVersions, "verify");
    const reads = 4;
    for (let index = 0; index < reads; index += 1) {
      await expect(
        service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
      ).resolves.toMatchObject({ authority, execution: { kind: "available" } });
    }
    expect(readAvailability).toHaveBeenCalledTimes(reads);
    expect(readVersion.mock.calls.length).toBeLessThanOrEqual(2 * reads);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(2 * reads);
    process.stdout.write(
      `canvas_runtime_availability_read_cost ${JSON.stringify({
        reads,
        deviceQueries: readAvailability.mock.calls.length,
        contentVersionReads: readVersion.mock.calls.length,
        contentValidations: verify.mock.calls.length
      })}\n`
    );
  });

  it("does not cache transient host-offline execution evidence", async () => {
    const { service, readAvailability } = await setup({
      async readAvailability() {
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "host_offline"
        };
      }
    });

    await service.read(actor("viewer"), { projectId: "p", canvasId: "default" });
    await service.read(actor("viewer"), { projectId: "p", canvasId: "default" });
    expect(readAvailability).toHaveBeenCalledTimes(2);
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

  it("rechecks restored source evidence when the package fingerprint still matches", async () => {
    let graphFingerprint: string | undefined;
    let sourceRevision = `snapshot:${"c".repeat(64)}`;
    const stalePort: CanvasRuntimeAvailabilityPort = {
      async readAvailability(requestedScope, requestedAt) {
        if (!graphFingerprint) throw new Error("test_graph_fingerprint_missing");
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

    sourceRevision = authority.sourceRevision;
    await expect(
      service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      authority,
      execution: { kind: "available", sourceRevision, graphFingerprint: fingerprint }
    });
  });

  it("keeps cross-scope and ACL failures outside the Runtime view", async () => {
    const first = await setup();
    await expect(
      first.service.read(actor("viewer"), { projectId: "other", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_availability_cross_scope");
    expect(first.readAvailability).not.toHaveBeenCalled();

    await expect(
      first.service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({ execution: { kind: "available" } });

    first.database
      .prepare(
        "UPDATE project_access_grants SET revoked_at=? WHERE workspace_id=? AND project_id=? AND canvas_id=? AND human_principal_id=?"
      )
      .run("2026-01-03T00:00:00.000Z", "w", "p", "default", "viewer");
    await expect(
      first.service.read(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_availability_forbidden");
    expect(first.readAvailability).toHaveBeenCalledTimes(1);
  });
});
