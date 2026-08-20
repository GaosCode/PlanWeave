import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HumanAuthContext } from "../identity/schemas.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import {
  createActiveDispatchResolver,
  resolveActiveDispatchSnapshot
} from "../work/dispatchIntegration.js";
import type { AssignmentHostPort, AssignmentMembershipPort } from "../work/ports.js";
import { WorkAssignmentRepository } from "../work/repository.js";
import { WorkAssignmentService } from "../work/service.js";
import type { WorkItemRef } from "../work/schemas.js";
import type { WorkItemPackagePort } from "../work/workItemFacts.js";
import { runtimeFactsFromPackagePort } from "./workRuntimeFactsFixture.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("workspace-scoped active dispatch projections", () => {
  it("never projects another workspace with matching project and Block identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-projection-"));
    directories.push(directory);
    const server = await startPlanweaveServer({
      dataDirectory: directory,
      databasePath: join(directory, "server.sqlite"),
      busyTimeoutMs: 5_000
    });
    servers.push(server);

    const projectId = "shared-project-id";
    const workItem: WorkItemRef = {
      kind: "block",
      canvasId: "default",
      blockRef: "T-001#B-001"
    };
    const workspaceIdentity = new WorkspaceIdentityRepository(server.database);
    const workspaceA = workspaceIdentity.ensureConfiguredWorkspace("workspace-a");
    const workspaceB = workspaceIdentity.ensureConfiguredWorkspace("workspace-b");
    const workspaceWithoutDispatch = workspaceIdentity.ensureConfiguredWorkspace("workspace-empty");
    const operations = new RemoteOperationRepository(server.database);
    const createActiveOperation = (workspaceId: string, suffix: string) =>
      operations.markClaimed(
        operations.create({
          workspaceId,
          projectId,
          canvasId: workItem.canvasId,
          blockRef: workItem.blockRef,
          ownershipGeneration: `generation-${suffix}`,
          idempotencyKey: `workspace-projection-${suffix}`,
          sourceFingerprint: `fingerprint-${suffix}`,
          requiredCapabilities: []
        }).id
      );

    const operationA = createActiveOperation(workspaceA, "a");
    const operationB = createActiveOperation(workspaceB, "b");
    const packagePort: WorkItemPackagePort = {
      resolveWorkItem(candidate) {
        if (
          candidate.kind === "block" &&
          candidate.canvasId === workItem.canvasId &&
          candidate.blockRef === workItem.blockRef
        ) {
          return {
            kind: "block",
            canvasId: workItem.canvasId,
            blockRef: workItem.blockRef,
            exists: true,
            requiredCapabilities: []
          };
        }
        return { ...candidate, exists: false, requiredCapabilities: [] };
      },
      resolveWorkItems(candidates) {
        return candidates.map((candidate) => this.resolveWorkItem(candidate));
      }
    };
    const membershipPort: AssignmentMembershipPort = {
      getMembershipFacts: () => undefined,
      listActiveMemberFacts: () => []
    };
    const hostPort: AssignmentHostPort = {
      getHostFacts: () => undefined,
      listHostFacts: () => [],
      listEligibleHostProjections: () => []
    };
    const resolveActiveDispatch = createActiveDispatchResolver(server.database);
    const createService = (workspaceId: string) =>
      new WorkAssignmentService({
        workspaceId,
        repository: new WorkAssignmentRepository(server.database),
        runtimeFacts: runtimeFactsFromPackagePort(packagePort),
        membershipPort,
        hostPort,
        resolveActiveDispatch
      });
    const owner: HumanAuthContext = {
      humanPrincipalId: "owner",
      displayName: "Owner",
      deviceCredentialId: "device-owner",
      projectId,
      role: "owner",
      membershipId: "membership-owner"
    };

    expect(
      resolveActiveDispatchSnapshot(server.database, {
        workspaceId: workspaceA,
        projectId,
        workItem
      })
    ).toMatchObject({ present: true, dispatchId: operationA.dispatchId });
    expect(
      resolveActiveDispatchSnapshot(server.database, {
        workspaceId: workspaceB,
        projectId,
        workItem
      })
    ).toMatchObject({ present: true, dispatchId: operationB.dispatchId });
    expect(
      (await createService(workspaceA).getAssignment(owner, projectId, workItem)).activeDispatch
    ).toEqual({ present: true, dispatchId: operationA.dispatchId });
    expect(
      (await createService(workspaceB).getAssignment(owner, projectId, workItem)).activeDispatch
    ).toEqual({ present: true, dispatchId: operationB.dispatchId });
    expect(
      (await createService(workspaceWithoutDispatch).getAssignment(owner, projectId, workItem))
        .activeDispatch
    ).toEqual({ present: false });
  });
});
