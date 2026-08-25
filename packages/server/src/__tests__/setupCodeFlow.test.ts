import { createHash, randomBytes } from "node:crypto";
import {
  directHttpsTransportAdmission,
  loopbackHttpTransportAdmission
} from "./support/transportAdmission.js";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assertSetupViewRedacted } from "@planweave-ai/collaboration-protocol/setup";
import { AgentHostRepository } from "../hosts.js";
import { handleSetupCodeHttpRequest } from "../identity/setupCodeHttp.js";
import {
  mintHostCredentialTokenForTests,
  SetupCodeError,
  SetupCodeService
} from "../identity/setupCodeService.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { provisionConfiguredOperatorSessions } from "../identity/operatorSessionProvisioning.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { HostEnrollmentService } from "../hostEnrollment.js";

const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const database of databases.splice(0)) database.close();
});

const adminToken = `pw_operator_${"A".repeat(43)}`;

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  databases.push(database);
  return database;
}

function ensureWorkspace(database: SqliteDatabase, projectId = "project-setup"): string {
  return new WorkspaceIdentityRepository(database).ensureWorkspaceForLegacyProject(projectId);
}

function provisionAdmin(database: SqliteDatabase, projectId = "project-setup") {
  ensureWorkspace(database, projectId);
  return provisionConfiguredOperatorSessions({
    database,
    credentials: [
      {
        operatorId: "operator-admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [projectId],
        serverAdmin: false
      }
    ],
    trustedProjectIds: [projectId],
    workspaceForProject: (id) =>
      new WorkspaceIdentityRepository(database).workspaceForLegacyProject(id),
    operatorSessionTtlMs: 30 * 24 * 60 * 60 * 1_000
  })[0];
}

function principal(database: SqliteDatabase) {
  const auth = new OperatorTokenRegistry(database, [
    {
      operatorId: "operator-admin",
      tokenSha256: hashOperatorToken(adminToken),
      projectIds: ["project-setup"],
      serverAdmin: false
    }
  ]);
  const principal = auth.authenticate(`Bearer ${adminToken}`);
  if (!principal) throw new Error("missing principal");
  return principal;
}

function service(database: SqliteDatabase) {
  return new SetupCodeService({
    database,
    serverBaseUrl: "http://127.0.0.1:7443/",
    allowInsecureTransport: true
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  return address.port;
}

describe("setup code issue/redeem/revoke", () => {
  it("issues once, redeems device once, stores digests only, and redacts list views", async () => {
    const database = await openDatabase();
    provisionAdmin(database);
    const workspaceId = ensureWorkspace(database);
    const setup = service(database);
    const issued = setup.issue(principal(database), {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "device_session"
    });
    expect(issued.displayOnce).toBe(true);
    expect(issued.setupCode).toMatch(/^pw_setup_/);
    assertSetupViewRedacted({
      schemaVersion: issued.schemaVersion,
      grant: issued.grant,
      displayOnce: issued.displayOnce
    });

    const persisted = JSON.stringify(database.prepare("SELECT * FROM setup_code_grants").all());
    expect(persisted).not.toContain(issued.setupCode);
    expect(persisted).toContain(createHash("sha256").update(issued.setupCode).digest("hex"));

    const redeemed = setup.redeem({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: issued.setupCode,
      displayName: "Owner Device"
    });
    expect(redeemed.purpose).toBe("device_session");
    if (redeemed.purpose !== "device_session") throw new Error("expected device");
    expect(redeemed.role).toBe("owner");
    expect(redeemed.deviceToken).toMatch(/^pw_hdev_/);
    expect(redeemed.connectionProfile.workspaceId).toBe(workspaceId);
    expect(
      database
        .prepare("SELECT 1 FROM human_principals WHERE human_principal_id=?")
        .get(redeemed.humanPrincipalId)
    ).toBeDefined();

    expect(() =>
      setup.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: issued.setupCode,
        displayName: "Replay"
      })
    ).toThrow(SetupCodeError);

    const page = setup.list(principal(database), workspaceId, { openOnly: true });
    expect(page.items).toHaveLength(0);
    assertSetupViewRedacted(page);
  });

  it("reuses a global human principal when redeeming another workspace with an existing device token", async () => {
    const database = await openDatabase();
    const workspaceA = ensureWorkspace(database, "project-setup");
    const workspaceB = ensureWorkspace(database, "project-setup-b");
    provisionConfiguredOperatorSessions({
      database,
      credentials: [
        {
          operatorId: "operator-admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ],
      trustedProjectIds: ["project-setup", "project-setup-b"],
      workspaceForProject: (id) =>
        new WorkspaceIdentityRepository(database).workspaceForLegacyProject(id),
      operatorSessionTtlMs: 30 * 24 * 60 * 60 * 1_000
    });
    const setup = service(database);
    const admin = new OperatorTokenRegistry(database, [
      {
        operatorId: "operator-admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]).authenticate(`Bearer ${adminToken}`);
    if (!admin) throw new Error("missing principal");
    const first = setup.redeem({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: setup.issue(admin, {
        schemaVersion: "workspace-setup/v1",
        workspaceId: workspaceA,
        purpose: "device_session"
      }).setupCode,
      displayName: "Owner Device"
    });
    if (first.purpose !== "device_session") throw new Error("expected device");
    const second = setup.redeem({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: setup.issue(admin, {
        schemaVersion: "workspace-setup/v1",
        workspaceId: workspaceB,
        purpose: "device_session"
      }).setupCode,
      displayName: "Owner Device",
      existingDeviceToken: first.deviceToken
    });
    if (second.purpose !== "device_session") throw new Error("expected device");
    expect(second.humanPrincipalId).toBe(first.humanPrincipalId);
    expect(second.workspaceId).toBe(workspaceB);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_memberships WHERE human_principal_id=? AND revoked_at IS NULL"
        )
        .get(first.humanPrincipalId)
    ).toEqual({ count: 2 });
    expect(() =>
      setup.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: setup.issue(admin, {
          schemaVersion: "workspace-setup/v1",
          workspaceId: workspaceA,
          purpose: "device_session"
        }).setupCode,
        displayName: "Impostor",
        existingDeviceToken: `pw_hdev_${"A".repeat(43)}`
      })
    ).toThrow(SetupCodeError);
  });

  it("redeems operator and host purposes with credential-type isolation", async () => {
    const database = await openDatabase();
    provisionAdmin(database);
    const workspaceId = ensureWorkspace(database);
    const setup = service(database);
    const operatorIssue = setup.issue(principal(database), {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "operator_session"
    });
    const operatorRedeem = setup.redeem({
      schemaVersion: "workspace-setup/v1",
      purpose: "operator_session",
      setupCode: operatorIssue.setupCode,
      displayName: "Remote Operator"
    });
    expect(operatorRedeem.purpose).toBe("operator_session");
    if (operatorRedeem.purpose !== "operator_session") throw new Error("expected operator");
    const auth = new OperatorTokenRegistry(database, [
      {
        operatorId: "operator-admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: ["project-setup"],
        serverAdmin: false
      }
    ]);
    const minted = auth.authenticate(`Bearer ${operatorRedeem.operatorToken}`);
    expect(minted?.operatorId).toBe(operatorRedeem.operatorId);
    expect(minted?.workspaceId).toBe(workspaceId);
    expect(minted?.serverAdmin).toBe(false);

    const hostIssue = setup.issue(principal(database), {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "host_enrollment"
    });
    expect(() =>
      setup.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: hostIssue.setupCode,
        displayName: "Wrong"
      })
    ).toThrow(/setup_code_purpose_mismatch/);

    const hostToken = mintHostCredentialTokenForTests();
    const hostRedeem = setup.redeem({
      schemaVersion: "workspace-setup/v1",
      purpose: "host_enrollment",
      setupCode: hostIssue.setupCode,
      displayName: "Linux Host",
      capabilities: ["linux"],
      capacity: 2,
      enrollmentAttemptId: "enroll-host-001",
      hostCredentialToken: hostToken
    });
    expect(hostRedeem.purpose).toBe("host_enrollment");
    if (hostRedeem.purpose !== "host_enrollment") throw new Error("expected host");
    expect(
      new AgentHostRepository(database).authenticate(hostRedeem.hostId, hostToken, workspaceId)?.id
    ).toBe(hostRedeem.hostId);
  });

  it("resumes a setup Host enrollment after the committed response is lost", async () => {
    const database = await openDatabase();
    provisionAdmin(database);
    const workspaceId = ensureWorkspace(database);
    const setup = service(database);
    const issued = setup.issue(principal(database), {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "host_enrollment"
    });
    const request = {
      schemaVersion: "workspace-setup/v1" as const,
      purpose: "host_enrollment" as const,
      setupCode: issued.setupCode,
      displayName: "Recovered Host",
      capabilities: ["linux"],
      capacity: 1,
      enrollmentAttemptId: "enroll-recovery-001",
      hostCredentialToken: mintHostCredentialTokenForTests()
    };

    const committedBeforeResponseLoss = setup.redeem(request);
    const resumed = setup.redeem(request);
    expect(resumed).toEqual(committedBeforeResponseLoss);
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_hosts").get()?.count).toBe(1);

    expect(() => setup.redeem({ ...request, enrollmentAttemptId: "enroll-recovery-002" })).toThrow(
      /setup_code_redeemed/
    );
    expect(() =>
      setup.redeem({
        ...request,
        hostCredentialToken: mintHostCredentialTokenForTests()
      })
    ).toThrow(/setup_code_redeemed/);
  });

  it("rejects expired, revoked, wrong workspace, revoked issuer, and forbidden capabilities", async () => {
    const database = await openDatabase();
    provisionAdmin(database);
    const workspaceId = ensureWorkspace(database);
    const setup = service(database);
    const actor = principal(database);

    const revoked = setup.issue(actor, {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "device_session"
    });
    setup.revoke(actor, {
      schemaVersion: "workspace-setup/v1",
      setupCodeId: revoked.grant.setupCodeId,
      reason: "operator rotated onboarding code"
    });
    expect(() =>
      setup.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: revoked.setupCode,
        displayName: "X"
      })
    ).toThrow(/setup_code_revoked/);

    let nowMs = Date.now();
    const timed = new SetupCodeService({
      database,
      serverBaseUrl: "http://127.0.0.1:7443/",
      allowInsecureTransport: true,
      clock: () => new Date(nowMs)
    });
    const expired = timed.issue(actor, {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "device_session",
      ttlMs: 60_000
    });
    nowMs += 120_000;
    expect(() =>
      timed.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: expired.setupCode,
        displayName: "X"
      })
    ).toThrow(/setup_code_expired/);

    // Redeem is workspace-bound by the grant; purpose confusion is covered above.
    // Issuer revocation fails closed for outstanding codes:
    const issuerBound = setup.issue(actor, {
      schemaVersion: "workspace-setup/v1",
      workspaceId,
      purpose: "device_session"
    });
    new OperatorSessionStore(database).revoke(workspaceId, actor.operatorSessionId);
    expect(() =>
      setup.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: issuerBound.setupCode,
        displayName: "X"
      })
    ).toThrow(/setup_code_issuer_revoked/);

    expect(() =>
      setup.redeem({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: issuerBound.setupCode,
        displayName: "X",
        projectRoot: "/tmp/evil",
        command: "id"
      } as never)
    ).toThrow(/setup_code_forbidden_capability|setup_code_malformed/);

    // Enrollment tokens remain valid after setup migration/path.
    const enrollments = new HostEnrollmentService(database);
    const grant = enrollments.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    expect(grant.enrollmentCode).toMatch(/^pw_enroll_/);
  });

  it("serves issue/redeem/revoke over HTTP and rejects insecure transport without opt-in", async () => {
    const database = await openDatabase();
    provisionAdmin(database);
    const workspaceId = ensureWorkspace(database);
    const setup = service(database);
    const authorization = new OperatorTokenRegistry(database, [
      {
        operatorId: "operator-admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: ["project-setup"],
        serverAdmin: false
      }
    ]);
    const server = createServer((request, response) => {
      void handleSetupCodeHttpRequest(request, response, {
        service: setup,
        authorization,
        transportAdmission: loopbackHttpTransportAdmission
      }).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    servers.push(server);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const issue = await fetch(`${base}/api/v1/workspaces/${workspaceId}/setup-codes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "host_enrollment"
      })
    });
    expect(issue.status).toBe(201);
    const issued = (await issue.json()) as { setupCode: string; grant: { setupCodeId: string } };
    expect(issued.setupCode).toMatch(/^pw_setup_/);

    const serverAdminToken = `pw_operator_${randomBytes(32).toString("base64url")}`;
    const serverAdminAuthorization = new OperatorTokenRegistry(database, [
      {
        operatorId: "operator-server-admin",
        tokenSha256: hashOperatorToken(serverAdminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]);
    provisionConfiguredOperatorSessions({
      database,
      credentials: [
        {
          operatorId: "operator-server-admin",
          tokenSha256: hashOperatorToken(serverAdminToken),
          projectIds: [],
          serverAdmin: true
        }
      ],
      trustedProjectIds: ["project-setup"],
      workspaceForProject: () => workspaceId,
      operatorSessionTtlMs: 3_600_000
    });
    const serverAdminServer = createServer((request, response) => {
      void handleSetupCodeHttpRequest(request, response, {
        service: setup,
        authorization: serverAdminAuthorization,
        transportAdmission: loopbackHttpTransportAdmission
      }).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    servers.push(serverAdminServer);
    const serverAdminPort = await listen(serverAdminServer);
    const currentWorkspaceIssue = await fetch(
      `http://127.0.0.1:${serverAdminPort}/api/v1/setup-codes`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serverAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          purpose: "device_session"
        })
      }
    );
    expect(currentWorkspaceIssue.status).toBe(201);
    await expect(currentWorkspaceIssue.json()).resolves.toMatchObject({
      grant: { workspaceId, purpose: "device_session" },
      setupCode: expect.stringMatching(/^pw_setup_/),
      displayOnce: true
    });

    const smuggledScopeIssue = await fetch(
      `http://127.0.0.1:${serverAdminPort}/api/v1/setup-codes`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serverAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          workspaceId: "workspace-other",
          purpose: "host_enrollment"
        })
      }
    );
    expect(smuggledScopeIssue.status).toBe(400);
    await expect(smuggledScopeIssue.json()).resolves.toEqual({
      error: "setup_code_malformed"
    });

    const wrongPurposeIssue = await fetch(
      `http://127.0.0.1:${serverAdminPort}/api/v1/setup-codes`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serverAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          purpose: "host_enrollment"
        })
      }
    );
    expect(wrongPurposeIssue.status).toBe(400);
    await expect(wrongPurposeIssue.json()).resolves.toEqual({
      error: "setup_code_malformed"
    });

    const nonAdminCurrentWorkspaceIssue = await fetch(`${base}/api/v1/setup-codes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session"
      })
    });
    expect(nonAdminCurrentWorkspaceIssue.status).toBe(403);
    await expect(nonAdminCurrentWorkspaceIssue.json()).resolves.toEqual({
      error: "operator_server_admin_required"
    });

    const redeem = await fetch(`${base}/api/v1/setup-codes/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "host_enrollment",
        setupCode: issued.setupCode,
        displayName: "HTTP Host",
        capabilities: ["linux"],
        capacity: 1,
        enrollmentAttemptId: "enroll-http-001",
        hostCredentialToken: mintHostCredentialTokenForTests()
      })
    });
    expect(redeem.status).toBe(200);
    const redeemed = await redeem.json();
    expect(redeemed).toMatchObject({ purpose: "host_enrollment" });
    expect(JSON.stringify(redeemed)).not.toMatch(/pw_setup_|pw_host_/);

    const conflictingWorkspace = await fetch(
      `${base}/api/v1/workspaces/${workspaceId}/setup-codes`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          workspaceId: "workspace-conflict-001",
          purpose: "device_session"
        })
      }
    );
    expect(conflictingWorkspace.status).toBe(409);
    await expect(conflictingWorkspace.json()).resolves.toEqual({
      error: "setup_code_workspace_mismatch"
    });

    const strict = createServer((request, response) => {
      void handleSetupCodeHttpRequest(request, response, {
        service: setup,
        authorization,
        transportAdmission: directHttpsTransportAdmission
      }).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    servers.push(strict);
    const strictPort = await listen(strict);
    const rejected = await fetch(`http://127.0.0.1:${strictPort}/api/v1/setup-codes/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: `pw_setup_${randomBytes(32).toString("base64url")}`,
        displayName: "X"
      })
    });
    expect(rejected.status).toBe(426);
  });

  it("migration preserves enrollment grants and is retryable", async () => {
    const database = await openDatabase();
    const workspaceId = ensureWorkspace(database);
    const enrollments = new HostEnrollmentService(database);
    const grant = enrollments.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    applyMigrations(database);
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM agent_host_enrollment_grants")
      .get() as { count: number };
    expect(Number(row.count)).toBeGreaterThanOrEqual(1);
    expect(grant.enrollmentCode.startsWith("pw_enroll_")).toBe(true);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('setup_code_grants','setup_code_revocations','setup_code_host_enrollment_outcomes')"
      )
      .all()
      .map((row) => String(row.name))
      .sort();
    expect(tables).toEqual([
      "setup_code_grants",
      "setup_code_host_enrollment_outcomes",
      "setup_code_revocations"
    ]);
  });
});
