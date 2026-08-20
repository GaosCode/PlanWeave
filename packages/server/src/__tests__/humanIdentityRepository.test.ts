import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityRepository } from "../comments/activityRepository.js";
import { ActivityProjectionService } from "../comments/service.js";
import {
  digestsEqual,
  hashHumanToken,
  HumanIdentityError,
  HumanIdentityRepository,
  mintHumanDeviceToken,
  mintProjectInvitationToken
} from "../identity/index.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

function prepareHistoricalSchema(database: SqliteDatabase, throughVersion: number): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      migration.before?.(database);
      database.exec(migration.sql);
      migration.after?.(database);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, "2020-01-01T00:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

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

async function openMigrated() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-human-identity-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  return { directory, database, repo: new HumanIdentityRepository(database) };
}

function localAdminProof(
  projectId = "project-a",
  humanPrincipalId = "human-owner-1",
  displayName = "Ada Owner"
) {
  return {
    kind: "local_administrative_proof" as const,
    projectId,
    humanPrincipalId,
    displayName,
    issuedAt: "2026-07-24T10:00:00.000Z"
  };
}

function bindProjectToWorkspace(database: SqliteDatabase, projectId: string, workspaceId: string) {
  const at = "2026-07-24T10:00:00.000Z";
  database
    .prepare(
      `INSERT INTO legacy_project_workspace_mappings(
        legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
      ) VALUES(?,?,?,?)`
    )
    .run(projectId, `legacy-project:${projectId}`, workspaceId, at);
  database
    .prepare(
      `INSERT INTO workspace_identity_migrations(
        migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
        interruption_marker,authoritative_read_version,failure_code,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      `identity-migration-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`,
      projectId,
      workspaceId,
      0,
      1,
      "verify_cutover",
      "completed",
      "read_cutover_complete",
      "workspace-identity/v1",
      null,
      at
    );
}

describe("human identity migration v16", () => {
  it("backfills membership revision deterministically when upgrading from v23", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-revision-mig-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    prepareHistoricalSchema(database, 23);
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at)
      VALUES ('human-old','Old Human','2026-01-01T00:00:00.000Z');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,created_at,updated_at
      ) VALUES (
        'membership-old','project-a','human-old','member',
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
      );
    `);
    applyMigrations(database);

    expect(
      database
        .prepare("SELECT revision FROM project_memberships WHERE membership_id=?")
        .get("membership-old")
    ).toEqual({ revision: 1 });
    expect(() =>
      database
        .prepare("UPDATE project_memberships SET revision=0 WHERE membership_id=?")
        .run("membership-old")
    ).toThrow(/CHECK/i);
  });

  it("creates normalized identity tables on upgrade from v15", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-mig-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);

    prepareHistoricalSchema(database, 15);
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(latestCentralSchemaVersion).toBe(52);

    for (const table of [
      "human_principals",
      "project_memberships",
      "project_invitations",
      "human_device_credentials"
    ]) {
      expect(
        database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      ).toBeDefined();
    }

    const indexes = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_project_%'
         OR name LIKE 'idx_human_%'`
      )
      .all()
      .map((row) => String(row.name));
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_project_memberships_active_unique",
        "idx_project_invitations_project_open",
        "idx_human_devices_principal_active"
      ])
    );
  });

  it("enforces foreign keys and unique token digests", async () => {
    const { database, repo } = await openMigrated();
    const boot = repo.bootstrapOwner(localAdminProof());
    expect(boot.deviceToken).toBeDefined();

    expect(() =>
      database
        .prepare(
          `INSERT INTO project_memberships(
            membership_id,project_id,human_principal_id,role,created_at,updated_at
          ) VALUES (?,?,?,?,?,?)`
        )
        .run(
          "membership-orphan",
          "project-a",
          "missing-principal",
          "member",
          "2026-07-24T10:00:00.000Z",
          "2026-07-24T10:00:00.000Z"
        )
    ).toThrow(/FOREIGN KEY/i);

    expect(() =>
      database
        .prepare(
          `INSERT INTO human_device_credentials(
            device_credential_id,human_principal_id,minted_for_project_id,token_sha256,created_at
          ) VALUES (?,?,?,?,?)`
        )
        .run(
          "device-collision",
          boot.principal.humanPrincipalId,
          "project-a",
          boot.device.tokenSha256,
          "2026-07-24T10:00:00.000Z"
        )
    ).toThrow(/UNIQUE/i);
  });
});

describe("human identity repository", () => {
  it("rolls back every invitation when a batch revoke transition fails", async () => {
    const { database, repo: setupRepo } = await openMigrated();
    setupRepo.bootstrapOwner(localAdminProof());
    const invitations = [
      setupRepo.createInvitation({
        projectId: "project-a",
        createdByHumanPrincipalId: "human-owner-1"
      }).invitation,
      setupRepo.createInvitation({
        projectId: "project-a",
        createdByHumanPrincipalId: "human-owner-1"
      }).invitation
    ];
    let transitions = 0;
    const repo = new HumanIdentityRepository(database, () => new Date(), {
      onInvitationTransitionInTransaction: ({ type }) => {
        if (type === "invitation_revoked" && ++transitions === 2) {
          throw new Error("invitation_projection_failed");
        }
      }
    });

    expect(() =>
      repo.revokeInvitations(
        invitations.map((invitation) => invitation.invitationId),
        "project-a"
      )
    ).toThrow("invitation_projection_failed");
    expect(
      invitations.map((invitation) => repo.getInvitation(invitation.invitationId)?.revokedAt)
    ).toEqual([undefined, undefined]);
  });

  it("rolls back membership creation when transactional activity projection fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-projector-failure-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    applyMigrations(database);
    const activity = new ActivityRepository(database);
    const projection = new ActivityProjectionService({ activity });
    const repo = new HumanIdentityRepository(database, () => new Date(), {
      onMembershipTransitionInTransaction: ({ membership, principal, type }) => {
        projection.projectMembershipEventInCallerTransaction({
          projectId: membership.projectId,
          type,
          membershipId: membership.membershipId,
          transitionRevision: membership.revision,
          humanPrincipalId: principal.humanPrincipalId,
          displayName: principal.displayName,
          membershipRole: membership.role,
          occurredAt: membership.updatedAt
        });
        throw new Error("activity_projection_failed");
      }
    });

    expect(() => repo.bootstrapOwner(localAdminProof())).toThrow("activity_projection_failed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM human_principals").get()).toEqual({
      count: 0
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_memberships").get()).toEqual({
      count: 0
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM human_device_credentials").get()
    ).toEqual({
      count: 0
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_records").get()).toEqual({
      count: 0
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM activity_projection_outbox").get()
    ).toEqual({ count: 0 });
  });

  it("increments membership revision only for real role and removal transitions", async () => {
    const { repo } = await openMigrated();
    const owner = repo.bootstrapOwner(localAdminProof());
    const invitation = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    const member = repo.consumeInvitation({
      invitationToken: invitation.invitationToken,
      projectId: "project-a",
      displayName: "Revision Member"
    });
    expect(owner.membership.revision).toBe(1);
    expect(member.membership.revision).toBe(1);

    const promoted = repo.promoteToOwner("project-a", member.principal.humanPrincipalId);
    expect(promoted.revision).toBe(2);
    expect(repo.promoteToOwner("project-a", member.principal.humanPrincipalId).revision).toBe(2);
    const demoted = repo.demoteOwner("project-a", member.principal.humanPrincipalId);
    expect(demoted.revision).toBe(3);
    expect(repo.promoteToOwner("project-a", member.principal.humanPrincipalId).revision).toBe(4);
    expect(repo.removeMember("project-a", member.principal.humanPrincipalId).revision).toBe(5);
  });

  it("bootstraps owner once, stores only digests, and returns device secret once", async () => {
    const { database, repo } = await openMigrated();
    const first = repo.bootstrapOwner(localAdminProof(), { deviceLabel: "laptop" });
    expect(first.created).toBe(true);
    expect(first.membership.role).toBe("owner");
    expect(first.deviceToken).toMatch(/^pw_hdev_/);
    expect(first.device.tokenSha256).toBe(hashHumanToken(first.deviceToken!));
    expect(digestsEqual(first.device.tokenSha256, hashHumanToken(first.deviceToken!))).toBe(true);

    const dump = JSON.stringify({
      principals: database.prepare("SELECT * FROM human_principals").all(),
      memberships: database.prepare("SELECT * FROM project_memberships").all(),
      devices: database.prepare("SELECT * FROM human_device_credentials").all()
    });
    expect(dump).not.toContain(first.deviceToken);
    expect(dump).not.toMatch(/pw_hdev_/);
    expect(dump).not.toMatch(/pw_inv_/);

    const again = repo.bootstrapOwner(localAdminProof());
    expect(again.created).toBe(false);
    expect(again.deviceToken).toBeUndefined();
    expect(again.membership.membershipId).toBe(first.membership.membershipId);
    expect(again.device.deviceCredentialId).toBe(first.device.deviceCredentialId);

    expect(() =>
      repo.bootstrapOwner(localAdminProof("project-a", "human-other", "Other"))
    ).toThrowError(HumanIdentityError);
    try {
      repo.bootstrapOwner(localAdminProof("project-a", "human-other", "Other"));
    } catch (error) {
      expect(error).toMatchObject({ code: "human_bootstrap_conflict" });
    }

    const auth = repo.authenticateDevice(first.deviceToken!, "project-a");
    expect(auth?.principal.humanPrincipalId).toBe(first.principal.humanPrincipalId);
    expect(auth?.membership?.role).toBe("owner");
  });

  it("re-mints a device token on local-admin re-bootstrap after all devices are revoked", async () => {
    const { repo } = await openMigrated();
    const first = repo.bootstrapOwner(localAdminProof());
    expect(first.deviceToken).toBeDefined();
    repo.revokeDevice(
      first.device.deviceCredentialId,
      "project-a",
      first.principal.humanPrincipalId
    );
    expect(repo.authenticateDevice(first.deviceToken!, "project-a")).toBeUndefined();

    const recovered = repo.bootstrapOwner(localAdminProof());
    expect(recovered.created).toBe(false);
    expect(recovered.deviceToken).toMatch(/^pw_hdev_/);
    expect(recovered.device.deviceCredentialId).not.toBe(first.device.deviceCredentialId);
    expect(recovered.device.revokedAt).toBeUndefined();
    expect(recovered.membership.membershipId).toBe(first.membership.membershipId);
    expect(recovered.membership.role).toBe("owner");

    const auth = repo.authenticateDevice(recovered.deviceToken!, "project-a");
    expect(auth?.principal.humanPrincipalId).toBe(first.principal.humanPrincipalId);
    expect(auth?.membership?.role).toBe("owner");

    // Healthy owner re-bootstrap remains non-minting and still conflicts for other principals.
    const healthyAgain = repo.bootstrapOwner(localAdminProof());
    expect(healthyAgain.created).toBe(false);
    expect(healthyAgain.deviceToken).toBeUndefined();
    expect(healthyAgain.device.deviceCredentialId).toBe(recovered.device.deviceCredentialId);
    expect(() =>
      repo.bootstrapOwner(localAdminProof("project-a", "human-other", "Other"))
    ).toThrowError(HumanIdentityError);
  });

  it("supports repeated read-only authorization probes without rewriting last-used metadata", async () => {
    const { database, repo } = await openMigrated();
    const owner = repo.bootstrapOwner(localAdminProof());
    const lastUsed = () =>
      database
        .prepare("SELECT last_used_at FROM human_device_credentials WHERE device_credential_id=?")
        .get(owner.device.deviceCredentialId)?.last_used_at;
    expect(lastUsed()).toBeNull();

    expect(
      repo.authenticateDevice(owner.deviceToken!, "project-a", { recordLastUsed: false })
    ).toBeDefined();
    expect(
      repo.authenticateDevice(owner.deviceToken!, "project-a", { recordLastUsed: false })
    ).toBeDefined();
    expect(lastUsed()).toBeNull();

    expect(repo.authenticateDevice(owner.deviceToken!, "project-a")).toBeDefined();
    expect(lastUsed()).not.toBeNull();
  });

  it("recovers the target project when another project still has a usable device", async () => {
    const { repo, database } = await openMigrated();
    const principalId = "shared-owner";
    const projectA = repo.bootstrapOwner(localAdminProof("project-a", principalId, "Shared Owner"));
    bindProjectToWorkspace(
      database,
      "project-b",
      String(
        database
          .prepare(
            "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
          )
          .get("project-a")?.workspace_id
      )
    );
    const projectB = repo.bootstrapOwner(localAdminProof("project-b", principalId, "Shared Owner"));

    repo.revokeDevice(projectB.device.deviceCredentialId, "project-b", principalId);
    expect(repo.authenticateDevice(projectA.deviceToken!, "project-a")).toBeDefined();
    expect(repo.authenticateDevice(projectA.deviceToken!, "project-b")).toBeUndefined();

    const recoveredB = repo.bootstrapOwner(
      localAdminProof("project-b", principalId, "Shared Owner")
    );
    expect(recoveredB.created).toBe(false);
    expect(recoveredB.deviceToken).toMatch(/^pw_hdev_/);
    expect(recoveredB.device.mintedForProjectId).toBe("project-b");
    expect(recoveredB.device.deviceCredentialId).not.toBe(projectA.device.deviceCredentialId);
    expect(repo.authenticateDevice(recoveredB.deviceToken!, "project-b")?.membership?.role).toBe(
      "owner"
    );
  });

  it("rejects an existing device token when the invitation belongs to another workspace", async () => {
    const { repo, database } = await openMigrated();
    const ownerA = repo.bootstrapOwner(localAdminProof("workspace-a-project", "owner-a", "A"));
    const ownerB = repo.bootstrapOwner(localAdminProof("workspace-b-project", "owner-b", "B"));
    const invitation = repo.createInvitation({
      projectId: "workspace-b-project",
      createdByHumanPrincipalId: ownerB.principal.humanPrincipalId
    });

    expect(() =>
      repo.consumeInvitation({
        invitationToken: invitation.invitationToken,
        projectId: "workspace-b-project",
        displayName: "ignored",
        existingDeviceToken: ownerA.deviceToken
      })
    ).toThrowError(expect.objectContaining({ code: "human_identity_workspace_mismatch" }));
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM project_memberships WHERE project_id=? AND revoked_at IS NULL"
        )
        .get("workspace-b-project")
    ).toEqual({ count: 1 });
  });

  it("rejects concurrent bootstrap of different principals for the same project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-boot-race-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const setup = await openServerDatabase(path, 5_000);
    databases.push(setup);
    applyMigrations(setup);
    setup.close();
    databases.pop();

    const dbA = await openServerDatabase(path, 5_000);
    const dbB = await openServerDatabase(path, 5_000);
    databases.push(dbA, dbB);
    const repoA = new HumanIdentityRepository(dbA);
    const repoB = new HumanIdentityRepository(dbB);

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        repoA.bootstrapOwner(localAdminProof("project-race", "owner-a", "A"))
      ),
      Promise.resolve().then(() =>
        repoB.bootstrapOwner(localAdminProof("project-race", "owner-b", "B"))
      )
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(HumanIdentityError);
    expect((reason as HumanIdentityError).code).toBe("human_bootstrap_conflict");

    const owners = dbA
      .prepare(
        `SELECT human_principal_id FROM project_memberships
         WHERE project_id=? AND role='owner' AND revoked_at IS NULL`
      )
      .all("project-race");
    expect(owners).toHaveLength(1);
  });

  it("creates invitations, consumes once, and supports existing principal link without enumeration", async () => {
    const { database, repo } = await openMigrated();
    const owner = repo.bootstrapOwner(localAdminProof());
    const created = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    expect(created.invitationToken).toMatch(/^pw_inv_/);
    expect(created.invitation.tokenSha256).toBe(hashHumanToken(created.invitationToken));
    expect(created.invitation.role).toBe("member");

    const dump = JSON.stringify(database.prepare("SELECT * FROM project_invitations").all());
    expect(dump).not.toContain(created.invitationToken);

    const joined = repo.consumeInvitation({
      invitationToken: created.invitationToken,
      projectId: "project-a",
      displayName: "Bob Member"
    });
    expect(joined.principalCreated).toBe(true);
    expect(joined.membership.role).toBe("member");
    expect(joined.deviceToken).toMatch(/^pw_hdev_/);
    expect(joined.invitation.consumedByHumanPrincipalId).toBe(joined.principal.humanPrincipalId);

    try {
      repo.consumeInvitation({
        invitationToken: created.invitationToken,
        projectId: "project-a",
        displayName: "Charlie"
      });
      expect.fail("expected double consume to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_invitation_consumed" });
    }

    // Second invitation for existing principal via device proof (no display-name lookup).
    const second = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    // Promote is separate; join always member. Create second project for link test.
    bindProjectToWorkspace(
      database,
      "project-b",
      String(
        database
          .prepare(
            "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
          )
          .get("project-a")?.workspace_id
      )
    );
    const ownerB = repo.bootstrapOwner(localAdminProof("project-b", "human-owner-1", "Ada Owner"));
    expect(ownerB.created).toBe(true);
    const inviteB = repo.createInvitation({
      projectId: "project-b",
      createdByHumanPrincipalId: ownerB.principal.humanPrincipalId
    });
    const linked = repo.consumeInvitation({
      invitationToken: inviteB.invitationToken,
      projectId: "project-b",
      displayName: "ignored-when-linking",
      existingDeviceToken: joined.deviceToken
    });
    expect(linked.principalCreated).toBe(false);
    expect(linked.principal.humanPrincipalId).toBe(joined.principal.humanPrincipalId);
    expect(linked.membership.projectId).toBe("project-b");
    // Device credentials are scoped to the project that minted them, even when projects share
    // a workspace and the principal is a member of both.
    expect(repo.authenticateDevice(joined.deviceToken, "project-b")).toBeUndefined();
    expect(repo.authenticateDevice(linked.deviceToken, "project-b")?.membership?.role).toBe(
      "member"
    );
    expect(repo.authenticateDevice(joined.deviceToken, "project-a")?.membership?.role).toBe(
      "member"
    );
    repo.promoteToOwner("project-a", joined.principal.humanPrincipalId);
    const workspaceId = String(
      database
        .prepare(
          "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
        )
        .get("project-a")?.workspace_id
    );
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_memberships WHERE workspace_id=? AND human_principal_id=? AND revoked_at IS NULL"
        )
        .get(workspaceId, joined.principal.humanPrincipalId)
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT role FROM workspace_memberships WHERE workspace_id=? AND human_principal_id=? AND revoked_at IS NULL"
        )
        .get(workspaceId, joined.principal.humanPrincipalId)
    ).toEqual({ role: "owner" });
    // No implicit privilege on a project without membership.
    expect(repo.authenticateDevice(joined.deviceToken, "project-unrelated")).toBeUndefined();
    expect(repo.authenticateDevice(linked.deviceToken, "project-a")).toBeUndefined();
    expect(
      repo
        .listDevicesForPrincipal(joined.principal.humanPrincipalId, "project-a")
        .map((device) => device.deviceCredentialId)
    ).toContain(joined.device.deviceCredentialId);
    expect(
      repo
        .listDevicesForPrincipal(joined.principal.humanPrincipalId, "project-a")
        .map((device) => device.deviceCredentialId)
    ).not.toContain(linked.device.deviceCredentialId);
    expect(
      repo.listDevicesForProjectMembers("project-b").map((device) => device.deviceCredentialId)
    ).toContain(linked.device.deviceCredentialId);
    expect(
      repo.listDevicesForProjectMembers("project-b").map((device) => device.deviceCredentialId)
    ).not.toContain(joined.device.deviceCredentialId);
    expect(() => repo.revokeDevice(linked.device.deviceCredentialId, "project-a")).toThrowError(
      expect.objectContaining({ code: "human_cross_project_forbidden" })
    );

    // Invalid existing device token does not enumerate or create.
    const inviteC = repo.createInvitation({
      projectId: "project-b",
      createdByHumanPrincipalId: ownerB.principal.humanPrincipalId
    });
    const beforePrincipals = (
      database.prepare("SELECT COUNT(*) AS c FROM human_principals").get() as { c: number }
    ).c;
    try {
      repo.consumeInvitation({
        invitationToken: inviteC.invitationToken,
        projectId: "project-b",
        displayName: "Eve",
        existingDeviceToken: mintHumanDeviceToken()
      });
      expect.fail("expected unauthenticated link to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_auth_unauthenticated" });
    }
    const afterPrincipals = (
      database.prepare("SELECT COUNT(*) AS c FROM human_principals").get() as { c: number }
    ).c;
    expect(afterPrincipals).toBe(beforePrincipals);
    // Invitation remains usable after failed link attempt.
    const recovered = repo.consumeInvitation({
      invitationToken: inviteC.invitationToken,
      projectId: "project-b",
      displayName: "Eve"
    });
    expect(recovered.principalCreated).toBe(true);

    // second invite for project-a still open if not used (cleanup expectation)
    expect(repo.getInvitation(second.invitation.invitationId)?.consumedAt).toBeUndefined();
  });

  it("rejects concurrent double consumption of the same invitation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-invite-race-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const setupDb = await openServerDatabase(path, 5_000);
    databases.push(setupDb);
    applyMigrations(setupDb);
    const setup = new HumanIdentityRepository(setupDb);
    const owner = setup.bootstrapOwner(localAdminProof("project-race"));
    const invite = setup.createInvitation({
      projectId: "project-race",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    setupDb.close();
    databases.pop();

    const dbA = await openServerDatabase(path, 5_000);
    const dbB = await openServerDatabase(path, 5_000);
    databases.push(dbA, dbB);
    const repoA = new HumanIdentityRepository(dbA);
    const repoB = new HumanIdentityRepository(dbB);

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        repoA.consumeInvitation({
          invitationToken: invite.invitationToken,
          projectId: "project-race",
          displayName: "Racer A"
        })
      ),
      Promise.resolve().then(() =>
        repoB.consumeInvitation({
          invitationToken: invite.invitationToken,
          projectId: "project-race",
          displayName: "Racer B"
        })
      )
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const code = ((rejected[0] as PromiseRejectedResult).reason as HumanIdentityError).code;
    expect(["human_invitation_consumed", "human_invitation_invalid"]).toContain(code);

    const members = dbA
      .prepare(
        `SELECT * FROM project_memberships
         WHERE project_id=? AND role='member' AND revoked_at IS NULL`
      )
      .all("project-race");
    expect(members).toHaveLength(1);
    const invitation = dbA
      .prepare("SELECT consumed_at FROM project_invitations WHERE invitation_id=?")
      .get(invite.invitation.invitationId) as { consumed_at: string | null };
    expect(invitation.consumed_at).toBeTruthy();
  });

  it("rejects expired and revoked invitations and expired/revoked devices", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const { database, directory } = await openMigrated();
    databases.pop();
    database.close();
    const db = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(db);
    const repo = new HumanIdentityRepository(db, () => now);

    const owner = repo.bootstrapOwner(localAdminProof());
    const invite = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId,
      ttlMs: 60_000
    });
    now = new Date("2026-07-24T12:02:00.000Z");
    try {
      repo.consumeInvitation({
        invitationToken: invite.invitationToken,
        projectId: "project-a",
        displayName: "Late"
      });
      expect.fail("expected expired");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_invitation_expired" });
    }

    now = new Date("2026-07-24T12:00:30.000Z");
    const revokable = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    repo.revokeInvitation(revokable.invitation.invitationId, "project-a");
    try {
      repo.consumeInvitation({
        invitationToken: revokable.invitationToken,
        projectId: "project-a",
        displayName: "Nope"
      });
      expect.fail("expected revoked");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_invitation_revoked" });
    }

    const shortLived = repo.bootstrapOwner(localAdminProof("project-ttl", "owner-ttl", "TTL"), {
      deviceTtlMs: 60_000
    });
    expect(repo.authenticateDevice(shortLived.deviceToken!, "project-ttl")).toBeDefined();
    now = new Date("2026-07-24T12:05:00.000Z");
    expect(repo.authenticateDevice(shortLived.deviceToken!, "project-ttl")).toBeUndefined();

    now = new Date("2026-07-24T12:00:00.000Z");
    const revDevice = repo.bootstrapOwner(localAdminProof("project-rev", "owner-rev", "Rev"), {
      deviceLabel: "phone"
    });
    repo.revokeDevice(
      revDevice.device.deviceCredentialId,
      "project-rev",
      revDevice.principal.humanPrincipalId
    );
    expect(repo.authenticateDevice(revDevice.deviceToken!, "project-rev")).toBeUndefined();
  });

  it("protects last owner under remove/demote races and isolates project scope on remove", async () => {
    const { repo, database } = await openMigrated();
    const owner = repo.bootstrapOwner(localAdminProof());
    const invite = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    const member = repo.consumeInvitation({
      invitationToken: invite.invitationToken,
      projectId: "project-a",
      displayName: "Bob"
    });

    // Member also joins project-b as owner bootstrap would be different principal; instead
    // bootstrap project-b with owner and link Bob.
    bindProjectToWorkspace(
      database,
      "project-b",
      String(
        database
          .prepare(
            "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
          )
          .get("project-a")?.workspace_id
      )
    );
    const ownerB = repo.bootstrapOwner(localAdminProof("project-b", "owner-b", "Owner B"));
    const inviteB = repo.createInvitation({
      projectId: "project-b",
      createdByHumanPrincipalId: ownerB.principal.humanPrincipalId
    });
    const linked = repo.consumeInvitation({
      invitationToken: inviteB.invitationToken,
      projectId: "project-b",
      displayName: "Bob",
      existingDeviceToken: member.deviceToken
    });
    expect(linked.principal.humanPrincipalId).toBe(member.principal.humanPrincipalId);

    try {
      repo.removeMember("project-a", owner.principal.humanPrincipalId);
      expect.fail("last owner protected");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_last_owner_protected" });
    }

    repo.promoteToOwner("project-a", member.principal.humanPrincipalId);
    expect(repo.countActiveOwners("project-a")).toBe(2);

    const removed = repo.removeMember("project-a", member.principal.humanPrincipalId);
    expect(removed.revokedAt).toBeDefined();
    expect(repo.authenticateDevice(member.deviceToken, "project-a")).toBeUndefined();
    // Device minted for project-a is revoked; project-b device still works.
    expect(repo.getDevice(member.device.deviceCredentialId)?.revokedAt).toBeDefined();
    expect(repo.authenticateDevice(linked.deviceToken, "project-b")?.membership?.role).toBe(
      "member"
    );
    expect(repo.getActiveMembership("project-b", member.principal.humanPrincipalId)?.role).toBe(
      "member"
    );

    // Demote last owner fails.
    try {
      repo.demoteOwner("project-a", owner.principal.humanPrincipalId);
      expect.fail("expected last owner demote protection");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_last_owner_protected" });
    }

    // Concurrent last-owner remove race: both try to remove the sole remaining owner.
    const directory = await mkdtemp(join(tmpdir(), "planweave-human-owner-race-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const setupDb = await openServerDatabase(path, 5_000);
    databases.push(setupDb);
    applyMigrations(setupDb);
    const setup = new HumanIdentityRepository(setupDb);
    const o1 = setup.bootstrapOwner(localAdminProof("p-race", "o1", "O1"));
    const inv = setup.createInvitation({
      projectId: "p-race",
      createdByHumanPrincipalId: o1.principal.humanPrincipalId
    });
    const m1 = setup.consumeInvitation({
      invitationToken: inv.invitationToken,
      projectId: "p-race",
      displayName: "M1"
    });
    setup.promoteToOwner("p-race", m1.principal.humanPrincipalId);
    setupDb.close();
    databases.pop();

    const dbA = await openServerDatabase(path, 5_000);
    const dbB = await openServerDatabase(path, 5_000);
    databases.push(dbA, dbB);
    const repoA = new HumanIdentityRepository(dbA);
    const repoB = new HumanIdentityRepository(dbB);

    const race = await Promise.allSettled([
      Promise.resolve().then(() => repoA.removeMember("p-race", o1.principal.humanPrincipalId)),
      Promise.resolve().then(() => repoB.removeMember("p-race", m1.principal.humanPrincipalId))
    ]);
    // Both can succeed (two owners) OR one may fail if serialized poorly — after both,
    // at least one owner must remain.
    const ownersLeft = (
      dbA
        .prepare(
          `SELECT COUNT(*) AS c FROM project_memberships
           WHERE project_id=? AND role='owner' AND revoked_at IS NULL`
        )
        .get("p-race") as { c: number }
    ).c;
    expect(ownersLeft).toBeGreaterThanOrEqual(1);
    // If both removals succeeded, we'd have 0 owners — that must not happen.
    expect(ownersLeft).toBe(1);
    const fulfilledRemoves = race.filter((r) => r.status === "fulfilled");
    const rejectedRemoves = race.filter((r) => r.status === "rejected");
    expect(fulfilledRemoves.length + rejectedRemoves.length).toBe(2);
    expect(fulfilledRemoves.length).toBeGreaterThanOrEqual(1);
  });

  it("maps token digest hash collisions/conflicts to safe errors", async () => {
    const { database, repo } = await openMigrated();
    const owner = repo.bootstrapOwner(localAdminProof());
    const invite = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });

    database
      .prepare(
        `INSERT INTO project_invitations(
          invitation_id,project_id,role,created_by_human_principal_id,token_sha256,created_at,expires_at
        ) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        "invite-forced",
        "project-a",
        "member",
        owner.principal.humanPrincipalId,
        "a".repeat(64),
        "2026-07-24T10:00:00.000Z",
        "2026-07-25T10:00:00.000Z"
      );

    expect(() =>
      database
        .prepare(
          `INSERT INTO human_device_credentials(
            device_credential_id,human_principal_id,minted_for_project_id,token_sha256,created_at
          ) VALUES (?,?,?,?,?)`
        )
        .run(
          "dev-forced",
          owner.principal.humanPrincipalId,
          "project-a",
          owner.device.tokenSha256,
          "2026-07-24T10:00:00.000Z"
        )
    ).toThrow(/UNIQUE/i);

    try {
      repo.consumeInvitation({
        invitationToken: invite.invitationToken,
        projectId: "project-other",
        displayName: "X"
      });
      expect.fail("expected cross-project");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_cross_project_forbidden" });
    }

    try {
      repo.consumeInvitation({
        invitationToken: mintProjectInvitationToken(),
        projectId: "project-a",
        displayName: "X"
      });
      expect.fail("expected invalid");
    } catch (error) {
      expect(error).toMatchObject({ code: "human_invitation_invalid" });
    }

    expect(digestsEqual("zz", "aa")).toBe(false);
    expect(hashHumanToken(invite.invitationToken)).toHaveLength(64);
    expect(createHash("sha256").update(invite.invitationToken).digest("hex")).toBe(
      hashHumanToken(invite.invitationToken)
    );
  });

  it("restricts cascade: deleting principal blocked while membership exists", async () => {
    const { database, repo } = await openMigrated();
    const owner = repo.bootstrapOwner(localAdminProof());
    expect(() =>
      database
        .prepare("DELETE FROM human_principals WHERE human_principal_id=?")
        .run(owner.principal.humanPrincipalId)
    ).toThrow(/FOREIGN KEY/i);

    // Soft-revoke membership still leaves FK from membership row; hard delete still blocked.
    // Promote second owner then remove first — principal rows retained for audit trail.
    const invite = repo.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: owner.principal.humanPrincipalId
    });
    const member = repo.consumeInvitation({
      invitationToken: invite.invitationToken,
      projectId: "project-a",
      displayName: "Bob"
    });
    repo.promoteToOwner("project-a", member.principal.humanPrincipalId);
    repo.removeMember("project-a", owner.principal.humanPrincipalId);
    expect(repo.getPrincipal(owner.principal.humanPrincipalId)).toBeDefined();
    expect(repo.getMembership(owner.membership.membershipId)?.revokedAt).toBeDefined();
    // invitation audit trail retained without secrets
    const invitationRows = database.prepare("SELECT * FROM project_invitations").all();
    expect(JSON.stringify(invitationRows)).not.toMatch(/pw_inv_/);
    expect(invitationRows[0]).toMatchObject({
      consumed_by_human_principal_id: member.principal.humanPrincipalId
    });
  });
});
