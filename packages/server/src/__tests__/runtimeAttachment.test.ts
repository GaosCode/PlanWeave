import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CanvasRuntimeAttachmentConflictError,
  ensureRuntimeAttachmentForOperation
} from "../canvas/runtimeAttachment.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = {
  workspaceId: "workspace-attach",
  projectId: "project-attach",
  canvasId: "default"
};
const graphFingerprint = `pkg-${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(scope.workspaceId);
  const projectAccess = new ProjectAccessRepository(database);
  projectAccess.registerProjectInternal({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    projectRoot: "/runtime/project"
  });
  projectAccess.registerCanvasInternal({ ...scope, packageDir: "/runtime/project/package" });
  const hosts = new AgentHostRepository(database, () => new Date("2026-08-26T00:00:00.000Z"));
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: 1024,
    clock: () => new Date("2026-08-26T00:00:00.000Z"),
    leaseActive: () => true
  });
  const attach = (input: Parameters<typeof ensureRuntimeAttachmentForOperation>[1]) =>
    ensureRuntimeAttachmentForOperation(
      {
        bindings: hosts.runtimeBindings,
        database,
        clock: () => new Date("2026-08-26T00:00:00.000Z")
      },
      input
    );
  return { attach, database, grants, hosts };
}

describe("ensureRuntimeAttachmentForOperation", () => {
  it("creates one binding on first run and does not duplicate on idempotent reenter", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Attach Host").host;
    const request = {
      ...scope,
      hostId: host.id,
      hostGeneration: host.id,
      operationId: "operation-attach-1",
      executionAttemptId: "attempt-attach-1",
      graphFingerprint
    };
    fixture.attach(request);
    fixture.attach(request);
    const bindings = fixture.hosts.runtimeBindings.list(scope);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      hostId: host.id,
      hostGeneration: host.id,
      operationId: "operation-attach-1",
      executionAttemptId: "attempt-attach-1",
      graphFingerprint,
      readinessStatus: "ready"
    });
  });

  it("refuses a silent Host swap while another Host holds an active Runtime lease", async () => {
    const fixture = await setup();
    const first = fixture.hosts.register("First Host").host;
    const second = fixture.hosts.register("Second Host").host;
    fixture.attach({
      ...scope,
      hostId: first.id,
      hostGeneration: first.id,
      operationId: "operation-lease-1",
      executionAttemptId: "attempt-lease-1"
    });
    fixture.grants.recordLease({
      runtimeLeaseId: "runtime-lease-first",
      hostId: first.id,
      ...scope,
      attachmentVersion: 0,
      sourceRevision: "src-attach",
      graphFingerprint,
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    expect(() =>
      fixture.attach({
        ...scope,
        hostId: second.id,
        hostGeneration: second.id,
        operationId: "operation-lease-2",
        executionAttemptId: "attempt-lease-2"
      })
    ).toThrow(CanvasRuntimeAttachmentConflictError);
    expect(fixture.hosts.runtimeBindings.list(scope)).toEqual([
      expect.objectContaining({ hostId: first.id, readinessStatus: "ready" })
    ]);
  });

  it("records the Host row id as generation instead of a caller-supplied stand-in", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Generation Host").host;
    const spoofedGeneration = randomUUID();
    fixture.attach({
      ...scope,
      hostId: host.id,
      hostGeneration: spoofedGeneration,
      operationId: "operation-generation-1",
      executionAttemptId: "attempt-generation-1"
    });
    const bindings = fixture.hosts.runtimeBindings.list(scope);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.hostGeneration).toBe(host.id);
    expect(bindings[0]?.hostGeneration).not.toBe(spoofedGeneration);
  });

  it("writes the new Host row id as generation when a later attempt attaches a superseded Host", async () => {
    const fixture = await setup();
    const first = fixture.hosts.register("Generation One").host;
    const next = fixture.hosts.register("Generation Two").host;
    fixture.attach({
      ...scope,
      hostId: first.id,
      hostGeneration: first.id,
      operationId: "operation-generation-retry",
      executionAttemptId: "attempt-generation-1"
    });
    fixture.attach({
      ...scope,
      hostId: next.id,
      hostGeneration: next.id,
      operationId: "operation-generation-retry",
      executionAttemptId: "attempt-generation-2"
    });
    const bindings = fixture.hosts.runtimeBindings.list(scope);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostId: first.id,
          readinessStatus: "missing"
        }),
        expect.objectContaining({
          hostId: next.id,
          hostGeneration: next.id,
          operationId: "operation-generation-retry",
          executionAttemptId: "attempt-generation-2",
          readinessStatus: "ready"
        })
      ])
    );
    expect(bindings).toHaveLength(2);
  });

  it("refuses to persist a ready binding before an accepted operation exists", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Premature Host").host;
    expect(() =>
      fixture.attach({
        ...scope,
        hostId: host.id,
        hostGeneration: host.id
      })
    ).toThrow("canvas_runtime_attachment_requires_accepted_operation");
    expect(fixture.hosts.runtimeBindings.list(scope)).toEqual([]);
  });
});
