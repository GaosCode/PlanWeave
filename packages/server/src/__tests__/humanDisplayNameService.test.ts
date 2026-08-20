import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanIdentityRepository } from "../identity/repository.js";
import type { HumanAuthContext } from "../identity/schemas.js";
import { HumanMembershipService } from "../identity/service.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("human display name service", () => {
  it("authorizes the current member and returns the updated principal view", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-display-name-service-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    applyMigrations(database);
    const repository = new HumanIdentityRepository(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const bootstrapped = repository.bootstrapOwner({
      kind: "local_administrative_proof",
      projectId: "project-a",
      humanPrincipalId: "human-owner-1",
      displayName: "Ada Owner",
      issuedAt: "2026-07-24T10:00:00.000Z"
    });
    const context: HumanAuthContext = {
      humanPrincipalId: bootstrapped.principal.humanPrincipalId,
      displayName: bootstrapped.principal.displayName,
      deviceCredentialId: bootstrapped.device.deviceCredentialId,
      projectId: "project-a",
      role: "owner",
      membershipId: bootstrapped.membership.membershipId
    };
    const service = new HumanMembershipService({
      repository,
      collaborationScopeAuthority: { hasProject: (projectId) => projectId === "project-a" },
      workspaceForProject: (projectId) =>
        workspaceIdentity.ensureWorkspaceForLegacyProject(projectId)
    });

    expect(
      service.updateOwnDisplayName(context, "project-a", { displayName: "  Ada Lovelace  " })
    ).toMatchObject({
      humanPrincipalId: bootstrapped.principal.humanPrincipalId,
      displayName: "Ada Lovelace"
    });
    expect(() =>
      service.updateOwnDisplayName(context, "project-a", {
        displayName: "Other",
        humanPrincipalId: "human-other"
      })
    ).toThrowError(/Unrecognized key.*humanPrincipalId/s);
  });
});
