import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService,
  resetHumanHttpRateLimits
} from "../identity/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const servers: HttpServer[] = [];
const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  resetHumanHttpRateLimits();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-human-display-name-http-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  const repository = new HumanIdentityRepository(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const collaborationScopeAuthority = {
    hasProject: (projectId: string) => projectId === "project-a"
  };
  const service = new HumanMembershipService({
    repository,
    collaborationScopeAuthority,
    workspaceForProject: (projectId) => workspaceIdentity.ensureWorkspaceForLegacyProject(projectId)
  });
  const server = createServer((request, response) => {
    void handleHumanHttpRequest(request, response, {
      service,
      repository,
      collaborationScopeAuthority,
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { origin: `http://127.0.0.1:${address.port}`, database };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? auth(token) : {})
});

describe("human display name HTTP API", () => {
  it("lets owners and members update only their own global display name", async () => {
    const { origin, database } = await setup();
    const bootstrapResponse = await fetch(`${origin}/api/v1/projects/project-a/human/bootstrap`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName: "Ada Owner", humanPrincipalId: "human-owner-1" })
    });
    const owner = (await bootstrapResponse.json()) as {
      deviceToken: string;
      principal: { humanPrincipalId: string };
    };

    const invitationResponse = await fetch(
      `${origin}/api/v1/projects/project-a/human/invitations`,
      { method: "POST", headers: jsonHeaders(owner.deviceToken), body: JSON.stringify({}) }
    );
    const invitation = (await invitationResponse.json()) as { invitationToken: string };
    const joinedResponse = await fetch(
      `${origin}/api/v1/projects/project-a/human/invitations/consume`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          displayName: "Bob Member"
        })
      }
    );
    const joined = (await joinedResponse.json()) as {
      deviceToken: string;
      principal: { humanPrincipalId: string };
    };

    const memberUpdate = await fetch(`${origin}/api/v1/projects/project-a/human/me`, {
      method: "PATCH",
      headers: jsonHeaders(joined.deviceToken),
      body: JSON.stringify({ displayName: "  Bob Builder  " })
    });
    expect(memberUpdate.status).toBe(200);
    await expect(memberUpdate.json()).resolves.toMatchObject({
      humanPrincipalId: joined.principal.humanPrincipalId,
      displayName: "Bob Builder"
    });

    const ownerUpdate = await fetch(`${origin}/api/v1/projects/project-a/human/me`, {
      method: "PATCH",
      headers: jsonHeaders(owner.deviceToken),
      body: JSON.stringify({ displayName: "Ada Lovelace" })
    });
    expect(ownerUpdate.status).toBe(200);

    const listed = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: auth(owner.deviceToken)
    });
    const members = (await listed.json()) as {
      items: Array<{ humanPrincipalId: string; displayName: string }>;
    };
    expect(members.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanPrincipalId: owner.principal.humanPrincipalId,
          displayName: "Ada Lovelace"
        }),
        expect.objectContaining({
          humanPrincipalId: joined.principal.humanPrincipalId,
          displayName: "Bob Builder"
        })
      ])
    );
    expect(
      database
        .prepare(
          "SELECT DISTINCT display_name FROM workspace_principals WHERE human_principal_id=?"
        )
        .all(joined.principal.humanPrincipalId)
    ).toEqual([{ display_name: "Bob Builder" }]);

    const invalid = await fetch(`${origin}/api/v1/projects/project-a/human/me`, {
      method: "PATCH",
      headers: jsonHeaders(owner.deviceToken),
      body: JSON.stringify({
        displayName: "Other",
        humanPrincipalId: joined.principal.humanPrincipalId
      })
    });
    expect(invalid.status).toBe(400);
    expect(
      (
        await fetch(`${origin}/api/v1/projects/project-a/human/me`, {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({ displayName: "Unauthenticated" })
        })
      ).status
    ).toBe(401);
  });
});
