import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { AgentHostRepository } from "../hosts.js";
import { AuthorityRepository } from "../work/authorityRepository.js";
import { AuthorityService } from "../work/authorityService.js";
import {
  createAuthorityDispatchGate,
  DispatchAssignmentError
} from "../work/dispatchIntegration.js";
import { workItemPackageFactsSchema, type WorkItemRef } from "../work/schemas.js";
import type { WorkItemPackagePort } from "../work/workItemFacts.js";
import { runtimeFactsFromPackagePort } from "./workRuntimeFactsFixture.js";

const databases: SqliteDatabase[] = [];
const now = () => new Date("2026-07-27T10:00:00.000Z");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at)
      VALUES ('w','Workspace','2026-07-27T00:00:00.000Z');
    INSERT INTO human_principals(human_principal_id,display_name,created_at)
      VALUES ('owner','Owner','2026-07-27T00:00:00.000Z'),
             ('member','Member','2026-07-27T00:00:00.000Z');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at)
      VALUES ('w','owner','Owner','2026-07-27T00:00:00.000Z',NULL),
             ('w','member','Member','2026-07-27T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at)
      VALUES ('w','wm-owner','owner','owner',1,'2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL),
             ('w','wm-member','member','member',1,'2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL);
    INSERT INTO project_memberships(membership_id,project_id,human_principal_id,role,created_at,updated_at,revoked_at)
      VALUES ('pm-owner','p','owner','owner','2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL),
             ('pm-member','p','member','member','2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-07-27T00:00:00.000Z');
    INSERT INTO workspace_identity_migrations(
      migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
      interruption_marker,authoritative_read_version,failure_code,updated_at
    ) VALUES (
      'identity-migration-p','p','w',0,1,'verify_cutover','completed',
      'read_cutover_complete','workspace-identity/v1',NULL,'2026-07-27T00:00:00.000Z'
    );
  `);
  const access = new ProjectAccessRepository(database, now);
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: "/tmp/project-p",
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "c",
    packageDir: "/tmp/project-p/canvas-c",
    ownerHumanPrincipalId: "owner"
  });
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const hosts = new AgentHostRepository(database, now);
  const host = hosts.registerWithCredential(
    "Host",
    `pw_host_${"a".repeat(43)}`,
    ["acp.codex"],
    1
  ).host;
  hosts.bindToWorkspace(host.id, "w");
  hosts.reportOnline(host.id, ["acp.codex"], 1, {
    workspaceMappings: [{ workspaceId: "w", status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
  const repository = new AuthorityRepository(database, { clock: now });
  const resolveWorkItem = (workItem: WorkItemRef) =>
    workItemPackageFactsSchema.parse(
      workItem.canvasId !== "c"
        ? {
            canvasId: workItem.canvasId,
            kind: workItem.kind,
            exists: false,
            ...(workItem.kind === "task"
              ? { taskId: workItem.taskId }
              : { blockRef: workItem.blockRef }),
            requiredCapabilities: []
          }
        : workItem.kind === "task"
          ? {
              canvasId: "c",
              kind: "task",
              taskId: workItem.taskId,
              exists: workItem.taskId === "T-001",
              requiredCapabilities: []
            }
          : {
              canvasId: "c",
              kind: "block",
              blockRef: workItem.blockRef,
              taskId: "T-001",
              blockType: "implementation",
              exists: workItem.blockRef === "T-001#B-001",
              requiredCapabilities: ["acp.codex"]
            }
    );
  const packagePort: WorkItemPackagePort = {
    resolveWorkItem,
    resolveWorkItems(workItems) {
      return workItems.map(resolveWorkItem);
    }
  };
  const runtimeFacts = runtimeFactsFromPackagePort(packagePort);
  const service = new AuthorityService({
    repository,
    runtimeFacts,
    identity: new HumanIdentityRepository(database, now),
    access,
    workspaceIdentity,
    hosts,
    clock: now
  });
  const actor = {
    humanPrincipalId: "owner",
    displayName: "Owner",
    deviceCredentialId: "device-owner",
    projectId: "p",
    role: "owner" as const,
    membershipId: "pm-owner"
  };
  return {
    database,
    access,
    workspaceIdentity,
    hosts,
    host,
    repository,
    service,
    actor,
    runtimeFacts
  };
}

describe("separated assignment authorities", () => {
  it("keeps pure SQLite authority getters available without Runtime facts", async () => {
    const { service, actor, runtimeFacts } = await fixture();
    const scope = {
      kind: "task" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      taskId: "T-001"
    };
    const acquireFacts = vi.spyOn(runtimeFacts, "acquireFacts");
    expect(service.getResponsibility(actor, scope)).toBeUndefined();
    expect(service.getReviewer(actor, scope)).toBeUndefined();
    expect(service.currentRevisions(actor, scope)).toEqual({
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 0
    });
    expect(acquireFacts).not.toHaveBeenCalled();
  });

  it("mutates responsibility, reviewer, and Block execution target independently", async () => {
    const { service, actor, host } = await fixture();
    const taskScope = {
      kind: "task" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      taskId: "T-001"
    };
    expect(
      await service.updateResponsibility(actor, {
        schemaVersion: "responsibility/v1",
        scope: taskScope,
        principal: { kind: "human", humanPrincipalId: "member" },
        expectedRevision: 0
      })
    ).toMatchObject({ revision: 1, principal: { humanPrincipalId: "member" } });
    expect(
      await service.updateReviewer(actor, {
        schemaVersion: "review-assignment/v1",
        scope: taskScope,
        principal: { kind: "human", humanPrincipalId: "owner" },
        expectedRevision: 0
      })
    ).toMatchObject({ revision: 1, principal: { humanPrincipalId: "owner" } });
    expect(service.getResponsibility(actor, taskScope)).toMatchObject({
      revision: 1,
      principal: { humanPrincipalId: "member" }
    });

    const blockScope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    expect(
      await service.updateExecutionTarget(actor, {
        schemaVersion: "execution-target/v1",
        scope: blockScope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      })
    ).toMatchObject({ revision: 1, target: { kind: "exact_host", hostId: host.id } });
    expect(service.currentRevisions(actor, blockScope)).toEqual({
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 1
    });
    await expect(
      service.updateExecutionTarget(actor, {
        schemaVersion: "execution-target/v1",
        scope: taskScope,
        target: { kind: "automatic_host" },
        expectedRevision: 0
      })
    ).rejects.toThrow();
  });

  it("projects redacted work authority without coupling reviewer to Host execution", async () => {
    const { service, actor, host } = await fixture();
    const blockScope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    await service.updateResponsibility(actor, {
      schemaVersion: "responsibility/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "member" },
      expectedRevision: 0
    });
    await service.updateReviewer(actor, {
      schemaVersion: "review-assignment/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "owner" },
      expectedRevision: 0
    });
    await service.updateExecutionTarget(actor, {
      schemaVersion: "execution-target/v1",
      scope: blockScope,
      target: { kind: "exact_host", hostId: host.id },
      expectedRevision: 0
    });
    // Reviewer change must not rewrite execution target revision.
    await service.updateReviewer(actor, {
      schemaVersion: "review-assignment/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "member" },
      expectedRevision: 1
    });
    const projection = await service.getWorkAuthorityProjection(actor, blockScope);
    expect(projection.responsibility.principal).toEqual({
      kind: "human",
      humanPrincipalId: "member"
    });
    expect(projection.reviewer.principal).toEqual({
      kind: "human",
      humanPrincipalId: "member"
    });
    expect(projection.executionTarget?.target).toEqual({
      kind: "exact_host",
      hostId: host.id
    });
    expect(projection.revisions).toEqual({
      responsibilityRevision: 1,
      reviewerRevision: 2,
      executionTargetRevision: 1
    });
    expect(projection.selectedHost?.availabilityReason).toBe("ready");
    expect(projection.selectedHost?.lease.status).toBe("none");
    expect(JSON.stringify(projection)).not.toMatch(/pw_|\/tmp|secret/i);
  });
});

describe("strict Host dispatch authority", () => {
  it("isolates identical project and canvas identifiers by requested workspace", async () => {
    const { database, access, workspaceIdentity, hosts, host, repository } = await fixture();
    database.exec(
      "INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w2','Workspace 2','2026-07-27T00:00:00.000Z')"
    );
    access.registerProjectInternal({
      workspaceId: "w2",
      projectId: "p",
      projectRoot: "/tmp/project-p-w2"
    });
    access.registerCanvasInternal({
      workspaceId: "w2",
      projectId: "p",
      canvasId: "c",
      packageDir: "/tmp/project-p-w2/canvas-c"
    });
    const host2 = hosts.registerWithCredential(
      "Host 2",
      `pw_host_${"b".repeat(43)}`,
      ["acp.codex"],
      1
    ).host;
    hosts.bindToWorkspace(host2.id, "w2");
    hosts.reportOnline(host2.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: "w2", status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
    for (const [workspaceId, hostId] of [
      ["w", host.id],
      ["w2", host2.id]
    ] as const) {
      repository.applyExecutionTarget({
        mutation: {
          schemaVersion: "execution-target/v1",
          scope: {
            kind: "block",
            workspaceId,
            projectId: "p",
            canvasId: "c",
            blockRef: "T-001#B-001"
          },
          target: { kind: "exact_host", hostId },
          expectedRevision: 0
        },
        actor: { kind: "human", id: "owner" }
      });
    }
    const gate = createAuthorityDispatchGate({
      repository,
      database,
      workspaceIdentity,
      hosts,
      access,
      hostOfflineAfterMs: 60_000,
      clock: now
    });
    expect(
      gate.resolve({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toMatchObject({ workspaceId: "w", preferredHostId: host.id });
    expect(
      gate.resolve({
        workspaceId: "w2",
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toMatchObject({ workspaceId: "w2", preferredHostId: host2.id });
  });

  it("selects only an eligible workspace Host and rejects stale revisions", async () => {
    const { database, access, workspaceIdentity, hosts, host, repository } = await fixture();
    const scope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    repository.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    const gate = createAuthorityDispatchGate({
      repository,
      database,
      workspaceIdentity,
      hosts,
      access,
      hostOfflineAfterMs: 60_000,
      clock: now
    });
    expect(
      gate.resolve({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toMatchObject({ selection: "exact", preferredHostId: host.id });

    repository.applyReviewer({
      mutation: {
        schemaVersion: "review-assignment/v1",
        scope,
        principal: { kind: "human", humanPrincipalId: "owner" },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    expect(() =>
      gate.resolve({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toThrow(DispatchAssignmentError);
  });

  it.each([
    {
      name: "capability_mismatch",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        // Host online but missing required capability.
        ctx.hosts.reportOnline(ctx.host.id, ["acp.other"], 1, {
          workspaceMappings: [{ workspaceId: "w", status: "ready" }],
          acpProfiles: [
            {
              profileId: "codex-acp",
              agentId: "codex",
              displayName: "Test Agent",
              status: "ready",
              capabilities: ["acp.other"]
            }
          ]
        });
      }
    },
    {
      name: "host_offline",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        // lastSeen far in the past relative to clock.
        ctx.database
          .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
          .run("2020-01-01T00:00:00.000Z", ctx.host.id);
      }
    },
    {
      name: "host_revoked",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        ctx.hosts.revoke(ctx.host.id);
      }
    },
    {
      name: "workspace_mapping_missing",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        ctx.hosts.reportOnline(ctx.host.id, ["acp.codex"], 1, {
          workspaceMappings: [],
          acpProfiles: [
            {
              profileId: "codex-acp",
              agentId: "codex",
              displayName: "Test Agent",
              status: "ready",
              capabilities: ["acp.codex"]
            }
          ]
        });
      }
    },
    {
      name: "acp_profile_missing",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        ctx.hosts.reportOnline(ctx.host.id, ["acp.codex"], 1, {
          workspaceMappings: [{ workspaceId: "w", status: "ready" }],
          acpProfiles: []
        });
      }
    },
    {
      name: "exact_acp_profile_not_ready",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        ctx.hosts.reportOnline(ctx.host.id, ["acp.codex", "acp.opencode"], 1, {
          workspaceMappings: [{ workspaceId: "w", status: "ready" }],
          acpProfiles: [
            {
              profileId: "codex-acp",
              agentId: "codex",
              displayName: "Test Agent",
              status: "missing",
              capabilities: ["acp.codex"]
            },
            {
              profileId: "opencode-acp",
              agentId: "opencode",
              displayName: "Test Agent",
              status: "ready",
              capabilities: ["acp.opencode"]
            }
          ]
        });
      }
    },
    {
      name: "cross_workspace",
      setup: (ctx: Awaited<ReturnType<typeof fixture>>) => {
        ctx.database.exec(`
          INSERT INTO workspaces(workspace_id,display_name,created_at)
            VALUES ('other','Other','2026-07-27T00:00:00.000Z');
        `);
        ctx.hosts.bindToWorkspace(ctx.host.id, "other");
      }
    }
  ])("denies dispatch for $name at authority gate", async ({ setup }) => {
    const ctx = await fixture();
    const scope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    ctx.repository.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: ctx.host.id },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    setup(ctx);
    const gate = createAuthorityDispatchGate({
      repository: ctx.repository,
      database: ctx.database,
      workspaceIdentity: ctx.workspaceIdentity,
      hosts: ctx.hosts,
      access: ctx.access,
      hostOfflineAfterMs: 60_000,
      clock: now
    });
    expect(() =>
      gate.resolve({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toThrow(DispatchAssignmentError);
  });

  it("keeps automatic selection retryable until a compatible Host is available", async () => {
    const { database, access, workspaceIdentity, hosts, host, repository } = await fixture();
    const scope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    repository.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "automatic_host" },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    hosts.reportOnline(host.id, ["acp.other"], 1, {
      workspaceMappings: [{ workspaceId: "w", status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["acp.other"]
        }
      ]
    });
    const gate = createAuthorityDispatchGate({
      repository,
      database,
      workspaceIdentity,
      hosts,
      access,
      hostOfflineAfterMs: 60_000,
      clock: now
    });
    const request = {
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001",
      requiredCapabilities: ["acp.codex"],
      agentId: "codex",
      agentProfileId: "codex-acp",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      expectedExecutionTargetRevision: 1
    };

    const automatic = gate.resolve(request);
    expect(automatic).toMatchObject({
      target: { kind: "automatic_host" },
      selection: "automatic"
    });
    expect(automatic.preferredHostId).toBeUndefined();
    expect(() => gate.resolve({ ...request, requestedHostId: host.id })).toThrow(
      DispatchAssignmentError
    );
  });

  it("resolves current authority when expected revisions are omitted (retry re-snapshot)", async () => {
    const { database, access, workspaceIdentity, hosts, host, repository } = await fixture();
    const scope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    repository.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    const gate = createAuthorityDispatchGate({
      repository,
      database,
      workspaceIdentity,
      hosts,
      access,
      hostOfflineAfterMs: 60_000,
      clock: now
    });
    expect(
      gate.resolve({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp",
        preferAuthority: true
      })
    ).toMatchObject({
      selection: "exact",
      preferredHostId: host.id,
      authorityRevisions: {
        responsibilityRevision: 0,
        reviewerRevision: 0,
        executionTargetRevision: 1
      }
    });
  });

  it("keeps responsibility/reviewer humans independent of Block Host execution target", async () => {
    const { service, actor, host } = await fixture();
    const blockScope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    await service.updateResponsibility(actor, {
      schemaVersion: "responsibility/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "member" },
      expectedRevision: 0
    });
    await service.updateReviewer(actor, {
      schemaVersion: "review-assignment/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "owner" },
      expectedRevision: 0
    });
    await service.updateExecutionTarget(actor, {
      schemaVersion: "execution-target/v1",
      scope: blockScope,
      target: { kind: "exact_host", hostId: host.id },
      expectedRevision: 0
    });
    const projection = await service.getWorkAuthorityProjection(actor, blockScope);
    expect(projection.responsibility.principal?.humanPrincipalId).toBe("member");
    expect(projection.reviewer.principal?.humanPrincipalId).toBe("owner");
    expect(projection.executionTarget?.target).toEqual({
      kind: "exact_host",
      hostId: host.id
    });
    expect(projection.responsibility.principal?.humanPrincipalId).not.toBe(host.id);
    expect(projection.reviewer.principal?.humanPrincipalId).not.toBe(host.id);
    expect(projection.selectedHost?.hostId).toBe(host.id);
    expect(projection.selectedHost?.availabilityReason).toBe("ready");
  });

  it("surfaces offline Host on executionTarget availability, not only selectedHost", async () => {
    const ctx = await fixture();
    const blockScope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    await ctx.service.updateExecutionTarget(ctx.actor, {
      schemaVersion: "execution-target/v1",
      scope: blockScope,
      target: { kind: "exact_host", hostId: ctx.host.id },
      expectedRevision: 0
    });
    ctx.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", ctx.host.id);
    const execution = await ctx.service.getExecutionTarget(ctx.actor, blockScope);
    expect(execution?.availability).toEqual({
      status: "unavailable",
      reason: "host_offline"
    });
    const projection = await ctx.service.getWorkAuthorityProjection(ctx.actor, blockScope);
    expect(projection.selectedHost?.availabilityReason).toBe("host_offline");
    expect(projection.executionTarget?.availability.reason).toBe("host_offline");
  });
});
