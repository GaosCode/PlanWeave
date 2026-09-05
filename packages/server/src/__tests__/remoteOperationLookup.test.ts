import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationLookupConflictError } from "../remoteOperationLookup.js";
import { RemoteOperationRepository } from "../remoteOperations.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<PlanweaveServer> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-operation-lookup-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  return server;
}

const operationInput = {
  workspaceId: "workspace-a",
  projectId: "project-a",
  canvasId: "default",
  blockRef: "RC-002#B-001",
  ownershipGeneration: "generation-1",
  idempotencyKey: "request-1",
  sourceFingerprint: "graph-fingerprint-1",
  requiredCapabilities: ["linux", "acp.codex"]
} as const;

describe("remote operation exact lookup", () => {
  it("preserves readable historical v2 operations whose target revision was never stored", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const operation = repository.create({
      ...operationInput,
      endpointSelection: {
        schemaVersion: "endpoint-selection/v1",
        endpointId: "endpoint-codex",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        hostId: "host-a",
        hostDisplayName: "Agent Host",
        capabilities: ["linux", "acp.codex"],
        resolvedAt: "2030-01-01T00:00:00.000Z",
        authority: {
          schemaVersion: "endpoint-authority/v2",
          kind: "workspace_canvas",
          workspaceId: operationInput.workspaceId,
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 1
        }
      }
    });
    server.database
      .prepare(`UPDATE remote_operations SET endpoint_selection_json=
        json_remove(endpoint_selection_json,'$.authority.executionTargetRevision') WHERE id=?`)
      .run(operation.id);
    const read = repository.findLatestByScope({
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef
    });
    expect(read?.id).toBe(operation.id);
    expect(read?.endpointSelection?.authority).not.toHaveProperty("executionTargetRevision");
    expect(
      repository.findLatestByScope({
        workspaceId: "workspace-other",
        projectId: operation.projectId,
        canvasId: operation.canvasId,
        blockRef: operation.blockRef
      })
    ).toBeUndefined();
  });

  it("matches the idempotency key only in the complete block scope", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const operation = repository.create(operationInput);
    const scope = {
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      idempotencyKey: operationInput.idempotencyKey
    };

    expect(repository.findByIdempotencyKeyInScope(scope)).toEqual(operation);
    expect(
      repository.findByIdempotencyKeyInScope({ ...scope, blockRef: "RC-002#B-002" })
    ).toBeUndefined();
    expect(
      repository.findByIdempotencyKeyInScope({ ...scope, idempotencyKey: "request-missing" })
    ).toBeUndefined();
  });

  it("rejects the same scoped key across ownership generations as ambiguous", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const first = repository.create(operationInput);
    server.database
      .prepare("UPDATE remote_operations SET state='completed',terminal_at=? WHERE id=?")
      .run("2030-01-01T00:00:01.000Z", first.id);
    repository.create({ ...operationInput, ownershipGeneration: "generation-2" });

    expect(() =>
      repository.findByIdempotencyKeyInScope({
        workspaceId: operationInput.workspaceId,
        projectId: operationInput.projectId,
        canvasId: operationInput.canvasId,
        blockRef: operationInput.blockRef,
        idempotencyKey: operationInput.idempotencyKey
      })
    ).toThrow(RemoteOperationLookupConflictError);
  });
});
