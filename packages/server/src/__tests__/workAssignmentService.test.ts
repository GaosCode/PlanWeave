import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import type { HumanAuthContext } from "../identity/schemas.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { createHostAssignmentPort, createIdentityMembershipPort } from "../work/ports.js";
import { WorkAssignmentRepository } from "../work/repository.js";
import { WorkAssignmentService, WorkAssignmentServiceError } from "../work/service.js";
import type {
  AssignmentHostFacts,
  AssignmentMembershipFacts,
  WorkItemPackageFacts,
  WorkItemRef
} from "../work/schemas.js";
import type { WorkItemPackagePort } from "../work/workItemFacts.js";
import { runtimeFactsFromPackagePort } from "./workRuntimeFactsFixture.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const projectId = "project-a";
const now = new Date("2026-07-24T15:00:00.000Z");

const taskItem: WorkItemRef = { kind: "task", canvasId: "default", taskId: "T-001" };
const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-001#B-001"
};
const missingItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-001#B-GONE"
};
const renamedItem: WorkItemRef = {
  kind: "task",
  canvasId: "default",
  taskId: "T-RENAMED"
};

function readyObservation(workspaceId: string, capabilities: readonly string[]) {
  return {
    workspaceMappings: [{ workspaceId, status: "ready" as const }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Test Agent",
        status: "ready" as const,
        capabilities: [...capabilities]
      }
    ]
  };
}

function packageFactsFor(workItem: WorkItemRef): WorkItemPackageFacts {
  if (workItem.kind === "task" && workItem.taskId === "T-001") {
    return {
      canvasId: "default",
      kind: "task",
      exists: true,
      taskId: "T-001",
      requiredCapabilities: []
    };
  }
  if (
    workItem.kind === "block" &&
    (workItem.blockRef === "T-001#B-001" || workItem.blockRef === "T-001#B-002")
  ) {
    return {
      canvasId: "default",
      kind: "block",
      exists: true,
      blockRef: workItem.blockRef,
      taskId: "T-001",
      blockType: "implementation",
      requiredCapabilities: ["acp.codex", "linux"]
    };
  }
  return {
    canvasId: workItem.canvasId,
    kind: workItem.kind,
    exists: false,
    taskId: workItem.kind === "task" ? workItem.taskId : undefined,
    blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
    requiredCapabilities: []
  };
}

const packagePort: WorkItemPackagePort = {
  resolveWorkItem(workItem) {
    return packageFactsFor(workItem);
  },
  resolveWorkItems(workItems) {
    return workItems.map(packageFactsFor);
  }
};

async function openStack() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-work-svc-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);

  const identity = new HumanIdentityRepository(database, () => now);
  const hosts = new AgentHostRepository(database, () => now);
  const repository = new WorkAssignmentRepository(database);

  // Bootstrap owner + second member.
  const ownerBoot = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId,
    humanPrincipalId: "human-owner",
    displayName: "Ada Owner",
    issuedAt: now.toISOString()
  });
  const invite = identity.createInvitation({
    projectId,
    createdByHumanPrincipalId: ownerBoot.principal.humanPrincipalId
  });
  const member = identity.consumeInvitation({
    invitationToken: invite.invitationToken,
    projectId,
    displayName: "Bob Member"
  });

  const ownerContext: HumanAuthContext = {
    humanPrincipalId: ownerBoot.principal.humanPrincipalId,
    displayName: ownerBoot.principal.displayName,
    deviceCredentialId: ownerBoot.device.deviceCredentialId,
    projectId,
    role: "owner",
    membershipId: ownerBoot.membership.membershipId
  };
  const memberContext: HumanAuthContext = {
    humanPrincipalId: member.principal.humanPrincipalId,
    displayName: member.principal.displayName,
    deviceCredentialId: member.device.deviceCredentialId,
    projectId,
    role: "member",
    membershipId: member.membership.membershipId
  };
  const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
    projectId
  );
  if (!workspaceId) throw new Error("test_workspace_missing");

  const capableHost = hosts.registerWithCredential(
    "Capable Host",
    "pw_host_Y2FwYWJsZXh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg",
    ["acp.codex", "linux", "git.read"],
    2
  );
  hosts.bindToWorkspace(capableHost.host.id, workspaceId);
  hosts.reportOnline(
    capableHost.host.id,
    ["acp.codex", "linux", "git.read"],
    2,
    readyObservation(workspaceId, ["acp.codex", "linux", "git.read"])
  );

  const weakHost = hosts.registerWithCredential(
    "Weak Host",
    "pw_host_d2Vha2hvc3R4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg",
    ["git.read"],
    1
  );
  hosts.bindToWorkspace(weakHost.host.id, workspaceId);
  hosts.reportOnline(
    weakHost.host.id,
    ["git.read"],
    1,
    readyObservation(workspaceId, ["git.read"])
  );

  const offlineHost = hosts.registerWithCredential(
    "Offline Host",
    "pw_host_b2ZmbGluZXh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg",
    ["acp.codex", "linux"],
    1
  );
  hosts.bindToWorkspace(offlineHost.host.id, workspaceId);
  // No reportOnline → offline.

  const revokedHost = hosts.registerWithCredential(
    "Revoked Host",
    "pw_host_cmV2b2tlZHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg",
    ["acp.codex", "linux"],
    1
  );
  hosts.bindToWorkspace(revokedHost.host.id, workspaceId);
  hosts.reportOnline(
    revokedHost.host.id,
    ["acp.codex", "linux"],
    1,
    readyObservation(workspaceId, ["acp.codex", "linux"])
  );
  hosts.revoke(revokedHost.host.id);

  const hostPort = createHostAssignmentPort({
    hosts,
    hostOfflineAfterMs: 60_000,
    clock: () => now,
    countActiveDispatches: () => 0
  });
  const service = new WorkAssignmentService({
    workspaceId,
    repository,
    runtimeFacts: runtimeFactsFromPackagePort(packagePort),
    membershipPort: createIdentityMembershipPort({ identity }),
    hostPort,
    clock: () => now
  });

  return {
    database,
    identity,
    hosts,
    repository,
    service,
    ownerContext,
    memberContext,
    member,
    workspaceId,
    capableHost,
    weakHost,
    offlineHost,
    revokedHost,
    hostPort
  };
}

describe("work assignment service API", () => {
  it("assigns, reassigns, unassigns with CAS and surfaces availability", async () => {
    const { service, memberContext, member } = await openStack();

    const assigned = await service.updateAssignment({
      projectId,
      workItem: taskItem,
      target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
      expectedRevision: 0,
      actor: memberContext,
      reason: "initial claim of ownership"
    });
    expect(assigned.record.revision).toBe(1);
    expect(assigned.display.availability).toEqual({ status: "ready", reason: "ready" });
    expect(assigned.display.human?.membershipActive).toBe(true);

    // Idempotent same-target update with matching expected revision advances revision.
    const same = await service.updateAssignment({
      projectId,
      workItem: taskItem,
      target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
      expectedRevision: 1,
      actor: memberContext
    });
    expect(same.record.revision).toBe(2);
    expect(same.record.target).toEqual({
      kind: "human",
      humanPrincipalId: member.principal.humanPrincipalId
    });

    const unassigned = await service.updateAssignment({
      projectId,
      workItem: taskItem,
      target: { kind: "unassigned" },
      expectedRevision: 2,
      actor: memberContext
    });
    expect(unassigned.record.target).toEqual({ kind: "unassigned" });
    expect(unassigned.display.availability).toEqual({
      status: "unassigned",
      reason: "unassigned"
    });
    expect(unassigned.record.revision).toBe(3);

    try {
      await service.updateAssignment({
        projectId,
        workItem: taskItem,
        target: { kind: "unassigned" },
        expectedRevision: 2,
        actor: memberContext
      });
      expect.fail("stale revision should conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkAssignmentServiceError);
      expect((error as WorkAssignmentServiceError).code).toBe("work_revision_conflict");
    }
  });

  it("rejects concurrent CAS losers and deleted/renamed work items", async () => {
    const { service, memberContext, member } = await openStack();

    await service.updateAssignment({
      projectId,
      workItem: taskItem,
      target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
      expectedRevision: 0,
      actor: memberContext
    });

    try {
      await service.updateAssignment({
        projectId,
        workItem: taskItem,
        target: { kind: "unassigned" },
        expectedRevision: 0,
        actor: memberContext
      });
      expect.fail("expected concurrent conflict");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toBe("work_revision_conflict");
    }

    try {
      await service.updateAssignment({
        projectId,
        workItem: missingItem,
        target: { kind: "unassigned" },
        expectedRevision: 0,
        actor: memberContext
      });
      expect.fail("missing work item");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toBe("work_item_not_found");
    }

    try {
      await service.updateAssignment({
        projectId,
        workItem: renamedItem,
        target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
        expectedRevision: 0,
        actor: memberContext
      });
      expect.fail("renamed work item");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toBe("work_item_not_found");
    }
  });

  it("rejects removed member and invalid Host targets with clear codes", async () => {
    const {
      service,
      identity,
      hosts,
      ownerContext,
      memberContext,
      member,
      capableHost,
      weakHost,
      offlineHost,
      revokedHost,
      workspaceId
    } = await openStack();

    // Remove member, then try assign.
    identity.removeMember(projectId, member.principal.humanPrincipalId);
    try {
      await service.updateAssignment({
        projectId,
        workItem: taskItem,
        target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
        expectedRevision: 0,
        actor: ownerContext
      });
      expect.fail("removed member");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toBe("work_human_not_member");
    }

    // Host capability mismatch.
    try {
      await service.updateAssignment({
        projectId,
        workItem: blockItem,
        target: { kind: "exact_host", hostId: weakHost.host.id },
        expectedRevision: 0,
        actor: ownerContext
      });
      expect.fail("capability mismatch");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toBe("work_host_capability_mismatch");
    }

    // Revoked host.
    try {
      await service.updateAssignment({
        projectId,
        workItem: blockItem,
        target: { kind: "exact_host", hostId: revokedHost.host.id },
        expectedRevision: 0,
        actor: ownerContext
      });
      expect.fail("revoked host");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toBe("work_host_revoked");
    }

    // Exact Host assignment fails closed when the Host is not ready.
    await expect(
      service.updateAssignment({
        projectId,
        workItem: blockItem,
        target: { kind: "exact_host", hostId: offlineHost.host.id },
        expectedRevision: 0,
        actor: ownerContext
      })
    ).rejects.toThrow(/ready workspace and ACP profile state/);

    hosts.reportOnline(capableHost.host.id, ["acp.codex", "linux", "git.read"], 2, {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities: ["acp.codex", "linux", "git.read"]
        }
      ]
    });
    await expect(
      service.updateAssignment({
        projectId,
        workItem: blockItem,
        target: { kind: "exact_host", hostId: capableHost.host.id },
        expectedRevision: 0,
        actor: ownerContext
      })
    ).rejects.toThrow(/ready workspace and ACP profile state/);
    hosts.reportOnline(
      capableHost.host.id,
      ["acp.codex", "linux", "git.read"],
      2,
      readyObservation(workspaceId, ["acp.codex", "linux", "git.read"])
    );

    // Reassign to capable online host.
    const online = await service.updateAssignment({
      projectId,
      workItem: blockItem,
      target: { kind: "exact_host", hostId: capableHost.host.id },
      expectedRevision: 0,
      actor: ownerContext
    });
    expect(online.display.availability).toEqual({ status: "ready", reason: "ready" });

    // Task cannot target Host.
    try {
      await service.updateAssignment({
        projectId,
        workItem: taskItem,
        target: { kind: "exact_host", hostId: capableHost.host.id },
        expectedRevision: 0,
        actor: ownerContext
      });
      expect.fail("task host");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toMatch(
        /work_item_kind_target_mismatch|work_input_invalid/
      );
    }

    // Cross-project actor rejected.
    try {
      await service.updateAssignment({
        projectId,
        workItem: taskItem,
        target: { kind: "unassigned" },
        expectedRevision: 0,
        actor: { ...memberContext, projectId: "project-other", role: "member" }
      });
      expect.fail("cross project");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toMatch(
        /work_auth_project_mismatch|work_input_invalid|work_auth_forbidden/
      );
    }
  });

  it("authorizes viewers and lists eligible assignees + batch projections", async () => {
    const { service, ownerContext, memberContext, member, capableHost, weakHost } =
      await openStack();

    await service.updateAssignment({
      projectId,
      workItem: taskItem,
      target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
      expectedRevision: 0,
      actor: memberContext
    });
    await service.updateAssignment({
      projectId,
      workItem: blockItem,
      target: { kind: "exact_host", hostId: capableHost.host.id },
      expectedRevision: 0,
      actor: ownerContext
    });

    const eligibleTask = await service.listEligibleAssignees(ownerContext, projectId, taskItem);
    expect(eligibleTask.humans.length).toBeGreaterThanOrEqual(2);
    expect(eligibleTask.hosts).toEqual([]);
    expect(eligibleTask.humans.every((h: AssignmentMembershipFacts) => h.membershipActive)).toBe(
      true
    );

    const eligibleBlock = await service.listEligibleAssignees(memberContext, projectId, blockItem);
    expect(eligibleBlock.hosts.some((h) => h.hostId === capableHost.host.id)).toBe(true);
    expect(eligibleBlock.hosts.some((h) => h.hostId === weakHost.host.id)).toBe(false);

    const batch = await service.listAssignments(memberContext, projectId, {
      workItems: [taskItem, blockItem, missingItem]
    });
    expect(batch.items).toHaveLength(3);
    const taskProj = batch.items.find((item) => item.workItem.kind === "task");
    const blockProj = batch.items.find(
      (item) => item.workItem.kind === "block" && item.workItem.blockRef === "T-001#B-001"
    );
    const missingProj = batch.items.find(
      (item) => item.workItem.kind === "block" && item.workItem.blockRef === "T-001#B-GONE"
    );
    expect(taskProj?.revision).toBe(1);
    expect(taskProj?.availability.status).toBe("ready");
    expect(blockProj?.availability.status).toBe("ready");
    expect(missingProj?.revision).toBe(0);
    expect(missingProj?.availability).toEqual({
      status: "invalid",
      reason: "work_item_missing"
    });

    const canvasPage = await service.listAssignments(ownerContext, projectId, {
      canvasId: "default",
      limit: 1,
      cursor: 0
    });
    expect(canvasPage.items).toHaveLength(1);
    expect(canvasPage.nextCursor).toBe(1);

    // Removed member keeps durable assignment but surfaces invalid availability.
    // Re-open identity path: revoke via assign then remove.
  });

  it("projects a Host eligibility batch with one inventory read and single-item equivalence", async () => {
    const { service, memberContext, capableHost, weakHost, hostPort, hosts } = await openStack();
    const single = await service.listEligibleAssignees(memberContext, projectId, blockItem);
    const inventory = vi.spyOn(hostPort, "listEligibleHostProjections");
    const hostList = vi.spyOn(hosts, "list");
    const workspaceBatch = vi.spyOn(hosts, "workspaceIdsForHosts");
    const equivalentBlockItem: WorkItemRef = {
      kind: "block",
      canvasId: "default",
      blockRef: "T-001#B-002"
    };
    const batch = await service.listEligibleHostsBatch(memberContext, projectId, {
      workItems: [blockItem, equivalentBlockItem]
    });

    expect(inventory).toHaveBeenCalledTimes(1);
    expect(hostList).toHaveBeenCalledTimes(1);
    expect(workspaceBatch).toHaveBeenCalledTimes(1);
    expect(batch.items).toEqual([
      { index: 0, workItem: blockItem, hostIds: single.hosts.map((host) => host.hostId) },
      {
        index: 1,
        workItem: equivalentBlockItem,
        hostIds: single.hosts.map((host) => host.hostId)
      }
    ]);
    expect(batch.hosts.some((host) => host.hostId === capableHost.host.id)).toBe(true);
    expect(batch.hosts.some((host) => host.hostId === weakHost.host.id)).toBe(false);

    await expect(
      service.listEligibleHostsBatch({ ...memberContext, projectId: "project-other" }, projectId, {
        workItems: [blockItem]
      })
    ).rejects.toThrowError(expect.objectContaining({ code: "work_auth_project_mismatch" }));
    await expect(
      service.listEligibleHostsBatch(memberContext, projectId, { workItems: [missingItem] })
    ).rejects.toThrowError(expect.objectContaining({ code: "work_item_not_found" }));
  });

  it("keeps durable assignment when member is removed (no silent retarget)", async () => {
    const { service, identity, ownerContext, memberContext, member } = await openStack();

    await service.updateAssignment({
      projectId,
      workItem: taskItem,
      target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
      expectedRevision: 0,
      actor: memberContext
    });
    identity.removeMember(projectId, member.principal.humanPrincipalId);

    const projection = await service.getAssignment(ownerContext, projectId, taskItem);
    expect(projection.target).toEqual({
      kind: "human",
      humanPrincipalId: member.principal.humanPrincipalId
    });
    expect(projection.revision).toBe(1);
    expect(projection.availability).toEqual({
      status: "invalid",
      reason: "human_membership_inactive"
    });
  });

  it("rejects unauthenticated-shaped callers on view and assign", async () => {
    const { service, member } = await openStack();
    const bogus = {
      humanPrincipalId: "nope",
      displayName: "Nope",
      deviceCredentialId: "device-x",
      projectId: "project-other",
      role: "member" as const,
      membershipId: "membership-x"
    };

    try {
      await service.getAssignment(bogus, projectId, taskItem);
      expect.fail("cross project view");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toMatch(/work_auth|work_input_invalid/);
    }

    try {
      await service.updateAssignment({
        projectId,
        workItem: taskItem,
        target: { kind: "human", humanPrincipalId: member.principal.humanPrincipalId },
        expectedRevision: 0,
        actor: bogus
      });
      expect.fail("cross project assign");
    } catch (error) {
      expect((error as WorkAssignmentServiceError).code).toMatch(
        /work_auth_project_mismatch|work_input_invalid|work_auth_forbidden/
      );
    }
  });

  it("supports automatic_host assign and pending availability", async () => {
    const { service, ownerContext } = await openStack();
    const result = await service.updateAssignment({
      projectId,
      workItem: blockItem,
      target: { kind: "automatic_host" },
      expectedRevision: 0,
      actor: ownerContext
    });
    expect(result.record.target).toEqual({ kind: "automatic_host" });
    expect(result.display.availability).toEqual({
      status: "pending",
      reason: "automatic_pending_selection"
    });
  });
});

describe("work assignment host port facts", () => {
  it("marks offline and capability filters for eligibility", async () => {
    const stack = await openStack();
    const port = createHostAssignmentPort({
      hosts: stack.hosts,
      hostOfflineAfterMs: 60_000,
      clock: () => now,
      countActiveDispatches: () => 0
    });

    const online = port.getHostFacts(stack.workspaceId, projectId, stack.capableHost.host.id)!;
    expect(online.online).toBe(true);
    expect(online.authorizedForProject).toBe(true);

    const offline = port.getHostFacts(stack.workspaceId, projectId, stack.offlineHost.host.id)!;
    expect(offline.online).toBe(false);
    expect(offline.exists).toBe(true);

    const revoked = port.getHostFacts(stack.workspaceId, projectId, stack.revokedHost.host.id)!;
    expect(revoked.revoked).toBe(true);

    const eligible = port.listHostFacts(stack.workspaceId, projectId, {
      requiredCapabilities: ["acp.codex", "linux"]
    });
    expect(eligible.every((h: AssignmentHostFacts) => !h.revoked)).toBe(true);
    expect(eligible.some((h) => h.hostId === stack.weakHost.host.id)).toBe(false);
    expect(eligible.some((h) => h.hostId === stack.offlineHost.host.id)).toBe(false);

    const capabilities = ["acp.codex", "linux", "git.read"];
    stack.hosts.reportOnline(stack.capableHost.host.id, capabilities, 2, {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities
        }
      ]
    });
    expect(
      port
        .listHostFacts(stack.workspaceId, projectId)
        .some((host) => host.hostId === stack.capableHost.host.id)
    ).toBe(false);

    stack.hosts.reportOnline(stack.capableHost.host.id, capabilities, 2, {
      workspaceMappings: [{ workspaceId: stack.workspaceId, status: "ready" }],
      acpProfiles: []
    });
    expect(
      port
        .listHostFacts(stack.workspaceId, projectId)
        .some((host) => host.hostId === stack.capableHost.host.id)
    ).toBe(false);

    const stalePort = createHostAssignmentPort({
      hosts: stack.hosts,
      hostOfflineAfterMs: 60_000,
      clock: () => new Date(now.getTime() + 60_001)
    });
    expect(
      stalePort
        .listHostFacts(stack.workspaceId, projectId)
        .some((host) => host.hostId === stack.weakHost.host.id)
    ).toBe(false);
  });
});
