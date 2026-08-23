import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { ContentVersionService } from "../canvas/contentVersionService.js";
import { CanvasRuntimeStatusRepository } from "../canvas/runtimeStatusRepository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function content(updatedAt = "2026-01-01T00:00:00.000Z"): CompleteContentVersion {
  const members = [
    {
      kind: "desktop_layout" as const,
      path: "desktop/layout.json",
      content: JSON.stringify({
        version: "desktop-layout/v1",
        projectId: "p",
        nodes: [],
        updatedAt
      })
    },
    {
      kind: "manifest" as const,
      path: "manifest.json",
      content: JSON.stringify({
        version: "plan-package/v1",
        project: { title: "Plan", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        executors: {},
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001/prompt.md",
            acceptance: ["done"],
            blocks: [
              {
                id: "B-001",
                type: "implementation",
                title: "Block",
                prompt: "nodes/T-001/blocks/B-001.prompt.md"
              }
            ]
          }
        ],
        edges: []
      })
    },
    { kind: "task_prompt" as const, path: "nodes/T-001/prompt.md", content: "# Task\n" },
    {
      kind: "block_prompt" as const,
      path: "nodes/T-001/blocks/B-001.prompt.md",
      content: "# Block\n"
    }
  ].map((member) => ({
    ...member,
    digestSha256: sha256(member.content),
    sizeBytes: Buffer.byteLength(member.content)
  }));
  const canonicalMembers = members.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = canonicalMembers.reduce((sum, member) => sum + member.sizeBytes, 0);
  return {
    ...withoutDigest(canonicalMembers, totalBytes),
    canonicalDigest: sha256(
      canonicalContentVersionDigestPayload({
        members: canonicalMembers,
        totalBytes,
        canonicalDigest: "0".repeat(64)
      })
    )
  };
}

function withoutDigest(
  members: CompleteContentVersion["members"],
  totalBytes: number
): Pick<CompleteContentVersion, "members" | "totalBytes"> {
  return { members, totalBytes };
}

async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL),('w','member','Member','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),('w','m-member','member','member',1,'2026-01-01','2026-01-01',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-01-01');
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: workspace.root,
    ownerHumanPrincipalId: "owner"
  });
  const repository = new ContentVersionRepository(
    database,
    () => new Date("2026-01-02T00:00:00.000Z")
  );
  const service = new ContentVersionService({
    repository,
    access,
    workspaceIdentity: new WorkspaceIdentityRepository(database)
  });
  return { database, repository, service, access };
}

const owner = {
  humanPrincipalId: "owner",
  displayName: "Owner",
  deviceCredentialId: "device-owner",
  projectId: "p",
  role: "owner" as const,
  membershipId: "m-owner"
};

describe("workspace canvas atomic publish", () => {
  it("does not infer a publish source from matching shared registry ids", async () => {
    const { access } = await fixture();
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      packageDir: "/srv/p/canvases/default",
      visibility: "shared",
      ownerHumanPrincipalId: "owner"
    });

    const canvases = access.listAuthorizedCanvases({
      workspaceId: "w",
      projectId: "p",
      actor: { kind: "human", id: "member" },
      limit: 20,
      offset: 0
    });

    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({
      registry: { projectId: "p", canvasId: "default" },
      visibility: "shared",
      publishSource: null
    });
  });

  it("assigns a durable Server canvasId independent from the local canvasId", async () => {
    const { access, repository, service, database } = await fixture();
    const result = service.publishWorkspaceCanvas(owner, "p", {
      operationId: "publish-op-1",
      localSource: { localProjectId: "local-project-a", localCanvasId: "default" },
      content: content()
    });
    expect(result).toMatchObject({
      outcome: "published",
      operationId: "publish-op-1",
      recoveryToken: "wp-publish-op-1",
      scope: { workspaceId: "w", projectId: "p" },
      revision: 1,
      visibility: "private"
    });
    if (result.outcome === "rejected") throw new Error("expected published canvas");
    expect(result.scope.canvasId).toMatch(/^wsc-[0-9a-f-]{36}$/);
    expect(result.scope.canvasId).not.toBe("default");
    expect(result).not.toHaveProperty("connectionProfileId");
    const canvas = access.registry.canvasInternal("w", "p", result.scope.canvasId);
    expect(canvas?.visibility).toBe("private");
    expect(canvas?.packageDir).toBeNull();
    expect(repository.head(result.scope)?.revision).toBe(1);
    expect(new CanvasRuntimeStatusRepository(database).read(result.scope)).toBeNull();
    expect(
      access.listAuthorizedCanvases({
        workspaceId: "w",
        projectId: "p",
        actor: { kind: "human", id: "owner" },
        limit: 20,
        offset: 0
      })
    ).toMatchObject([
      {
        registry: { canvasId: result.scope.canvasId },
        publishSource: { localProjectId: "local-project-a", localCanvasId: "default" }
      }
    ]);
  });

  it("lets two local default canvases publish into the same Workspace project", async () => {
    const { access, service } = await fixture();
    const first = service.publishWorkspaceCanvas(owner, "p", {
      operationId: "publish-op-a",
      localSource: { localProjectId: "local-project-a", localCanvasId: "default" },
      content: content()
    });
    const second = service.publishWorkspaceCanvas(owner, "p", {
      operationId: "publish-op-b",
      localSource: { localProjectId: "local-project-b", localCanvasId: "default" },
      content: content()
    });
    expect(first.outcome).toBe("published");
    expect(second.outcome).toBe("published");
    if (first.outcome === "rejected" || second.outcome === "rejected") {
      throw new Error("expected two published canvases");
    }
    expect(first.scope.canvasId).not.toBe(second.scope.canvasId);
    const canvases = access.listAuthorizedCanvases({
      workspaceId: "w",
      projectId: "p",
      actor: { kind: "human", id: "owner" },
      limit: 20,
      offset: 0
    });
    expect(canvases.map((canvas) => canvas.registry.canvasId).sort()).toEqual(
      [first.scope.canvasId, second.scope.canvasId].sort()
    );
  });

  it("replays the same operation identity without creating a second canvas", async () => {
    const { access, service } = await fixture();
    const request = {
      operationId: "publish-op-1",
      localSource: { localProjectId: "local-project-a", localCanvasId: "default" },
      content: content()
    };
    const first = service.publishWorkspaceCanvas(owner, "p", request);
    const second = service.publishWorkspaceCanvas(owner, "p", request);
    expect(first.outcome).toBe("published");
    expect(second).toMatchObject({
      outcome: "reused",
      operationId: "publish-op-1",
      recoveryToken: "wp-publish-op-1"
    });
    if (first.outcome === "rejected" || second.outcome === "rejected") {
      throw new Error("expected reused publish");
    }
    expect(second.scope.canvasId).toBe(first.scope.canvasId);
    const canvases = access.listAuthorizedCanvases({
      workspaceId: "w",
      projectId: "p",
      actor: { kind: "human", id: "owner" },
      limit: 20,
      offset: 0
    });
    expect(canvases).toHaveLength(1);
  });

  it("recovers the original locator when the same local source retries with a new operationId", async () => {
    const { service } = await fixture();
    const localSource = { localProjectId: "local-project-a", localCanvasId: "default" };
    const first = service.publishWorkspaceCanvas(owner, "p", {
      operationId: "publish-op-1",
      localSource,
      content: content()
    });
    const recovered = service.publishWorkspaceCanvas(owner, "p", {
      operationId: "publish-op-restart",
      localSource,
      content: content()
    });
    expect(first.outcome).toBe("published");
    expect(recovered).toMatchObject({
      outcome: "reused",
      operationId: "publish-op-1",
      recoveryToken: "wp-publish-op-1"
    });
    if (first.outcome === "rejected" || recovered.outcome === "rejected") {
      throw new Error("expected recovered publish");
    }
    expect(recovered.scope.canvasId).toBe(first.scope.canvasId);
  });

  it("rejects reusing an operationId for a different local source", async () => {
    const { service } = await fixture();
    expect(
      service.publishWorkspaceCanvas(owner, "p", {
        operationId: "publish-op-1",
        localSource: { localProjectId: "local-project-a", localCanvasId: "default" },
        content: content()
      }).outcome
    ).toBe("published");
    expect(
      service.publishWorkspaceCanvas(owner, "p", {
        operationId: "publish-op-1",
        localSource: { localProjectId: "local-project-b", localCanvasId: "default" },
        content: content()
      })
    ).toMatchObject({
      outcome: "rejected",
      reason: "operation_conflict",
      retryable: false,
      scope: null,
      recoveryToken: null
    });
  });

  it("rolls back registry and content when publication fails after canvas insert", async () => {
    const { access, repository, service } = await fixture();
    const original = repository.publishInitial.bind(repository);
    repository.publishInitial = () => {
      throw new Error("injected_publish_failure");
    };
    try {
      expect(
        service.publishWorkspaceCanvas(owner, "p", {
          operationId: "publish-op-fail",
          localSource: { localProjectId: "local-project-a", localCanvasId: "default" },
          content: content()
        })
      ).toMatchObject({
        outcome: "rejected",
        reason: "storage_unavailable",
        retryable: true,
        scope: null,
        recoveryToken: null
      });
    } finally {
      repository.publishInitial = original;
    }
    const canvases = access.listAuthorizedCanvases({
      workspaceId: "w",
      projectId: "p",
      actor: { kind: "human", id: "owner" },
      limit: 20,
      offset: 0
    });
    expect(canvases).toHaveLength(0);
    expect(repository.readWorkspacePublishOperation("publish-op-fail")).toBeNull();
  });

  it("rolls nested writes back when the outer transaction fails", async () => {
    const { access, database } = await fixture();
    expect(() =>
      inWriteTransaction(database, () => {
        access.registry.registerPathlessCanvas({
          workspaceId: "w",
          projectId: "p",
          canvasId: "nested"
        });
        throw new Error("nested_failure");
      })
    ).toThrow("nested_failure");
    expect(access.registry.canvasInternal("w", "p", "nested")).toBeUndefined();
  });
});
