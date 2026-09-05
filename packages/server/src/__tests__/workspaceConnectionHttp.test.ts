import { createServer, type Server } from "node:http";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { hashHumanToken } from "../identity/crypto.js";
import { handleWorkspaceConnectionHttpRequest } from "../identity/workspaceConnectionHttp.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-connection-http-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-connection");
  const otherWorkspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-other");
  const humanPrincipalId = "human-workspace-connection";
  const token = `pw_hdev_${"a".repeat(43)}`;
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  database
    .prepare(
      "INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
    )
    .run(workspaceId, humanPrincipalId, "Workspace Device", issuedAt);
  database
    .prepare(
      "INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,1,?,?,NULL)"
    )
    .run(
      workspaceId,
      "workspace-membership-connection",
      humanPrincipalId,
      "owner",
      issuedAt,
      issuedAt
    );
  database
    .prepare(
      "INSERT INTO workspace_device_sessions(workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at) VALUES(?,?,?,?,?,?,NULL,NULL)"
    )
    .run(
      workspaceId,
      "device-session-connection",
      humanPrincipalId,
      hashHumanToken(token),
      issuedAt,
      expiresAt
    );
  const server = createServer((request, response) => {
    void handleWorkspaceConnectionHttpRequest(request, response, {
      workspaceIdentity,
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_http_address");
  return {
    database,
    workspaceId,
    otherWorkspaceId,
    token,
    origin: `http://127.0.0.1:${address.port}`
  };
}

describe("workspace connection HTTP", () => {
  it("returns the authenticated Server Workspace picker without project or secret data", async () => {
    const { origin, workspaceId, otherWorkspaceId, token } = await setup();
    const unauthorized = await fetch(`${origin}/api/v1/workspace-connection`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${origin}/api/v1/workspace-connection?cursor=0&limit=20`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      items: Array<{ workspaceId: string; membershipActive: boolean }>;
    };
    expect(page.items).toEqual([expect.objectContaining({ workspaceId, membershipActive: true })]);
    expect(JSON.stringify(page)).not.toContain(otherWorkspaceId);
    expect(JSON.stringify(page)).not.toMatch(/projectRoot|credential|token|secret/i);
  });

  it("accepts active non-expiring Workspace device sessions", async () => {
    const { database, origin, token } = await setup();
    database
      .prepare("UPDATE workspace_device_sessions SET expires_at=NULL WHERE device_session_id=?")
      .run("device-session-connection");

    const response = await fetch(`${origin}/api/v1/workspace-connection`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
  });

  it("fails closed for revoked credentials and malformed picker queries", async () => {
    const { database, origin, token } = await setup();
    const malformed = await fetch(`${origin}/api/v1/workspace-connection?cursor=-1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(malformed.status).toBe(400);

    database
      .prepare("UPDATE workspace_device_sessions SET revoked_at=? WHERE device_session_id=?")
      .run(new Date().toISOString(), "device-session-connection");
    const revoked = await fetch(`${origin}/api/v1/workspace-connection`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(revoked.status).toBe(401);
  });

  it("reads and updates the authenticated human on this device without a project session", async () => {
    const { origin, workspaceId, token } = await setup();
    const selfResponse = await fetch(`${origin}/api/v1/workspace-connection/self`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(selfResponse.status).toBe(200);
    const self = (await selfResponse.json()) as {
      displayName: string;
      role: string;
      deviceSessionId: string;
      workspaceId: string;
    };
    expect(self).toMatchObject({
      workspaceId,
      displayName: "Workspace Device",
      role: "owner",
      deviceSessionId: "device-session-connection"
    });

    const updatedResponse = await fetch(`${origin}/api/v1/workspace-connection/self`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        displayName: "Windows Laptop"
      })
    });
    expect(updatedResponse.status).toBe(200);
    expect(await updatedResponse.json()).toMatchObject({
      displayName: "Windows Laptop",
      deviceSessionId: "device-session-connection"
    });
  });

  it("lists Workspace members and this device even when no project is shared", async () => {
    const { origin, token } = await setup();
    const response = await fetch(
      `${origin}/api/v1/workspace-connection/members?cursor=0&limit=50`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      items: Array<{
        displayName: string;
        devices: Array<{ deviceSessionId: string; isCurrentDevice: boolean }>;
      }>;
    };
    expect(page.items).toEqual([
      expect.objectContaining({
        displayName: "Workspace Device",
        role: "owner",
        devices: [
          expect.objectContaining({
            deviceSessionId: "device-session-connection",
            isCurrentDevice: true
          })
        ]
      })
    ]);
    expect(JSON.stringify(page)).not.toMatch(/credential|token|secret|projectRoot/i);
  });
});
