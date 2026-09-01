import { rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRemoteAgentEndpointRedacted,
  remoteAgentEndpointListSchema
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { AgentHostRepository } from "../hosts.js";
import { syncRemoteAgentsFromHost } from "../remoteAgent/index.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";
import type { DistributedServerComposition } from "../serverComposition.js";
import { AuthorityRepository } from "../work/authorityRepository.js";
import {
  adminToken,
  jsonHeaders,
  projectToken,
  setupServerCompositionFixture
} from "./support/serverCompositionFixture.js";
import {
  ownHostRemoteAgents,
  TEST_REMOTE_AGENT_OWNER_ID
} from "./support/remoteAgentOwnerFixture.js";

const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function setup() {
  return setupServerCompositionFixture({ directories, httpServers, compositions });
}

async function bootstrapHumanIdentity(input: {
  origin: string;
  projectId: string;
  humanPrincipalId: string;
}): Promise<string> {
  const bootstrap = await fetch(
    `${input.origin}/api/v1/projects/${input.projectId}/human/bootstrap`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Trusted Remote Agent Owner",
        humanPrincipalId: input.humanPrincipalId
      })
    }
  );
  expect(bootstrap.status).toBe(201);
  const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
  const recovered = await fetch(`${input.origin}/api/v1/human-identity/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "human-identity/v1",
      existingDeviceToken: deviceToken
    })
  });
  expect(recovered.status).toBe(200);
  return ((await recovered.json()) as { identityToken: string }).identityToken;
}

describe("distributed server composition Stage H contracts", () => {
  it("lists stable redacted Agent Endpoints through the operator-admin project scope", async () => {
    const fixture = await setup();
    const ownerIdentityToken = await bootstrapHumanIdentity({
      origin: fixture.origin,
      projectId: fixture.projectId,
      humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
    });
    const database = await openServerDatabase(fixture.databasePath, 5_000);
    const hosts = new AgentHostRepository(
      database,
      () => new Date(),
      (host) => {
        syncRemoteAgentsFromHost({ database, host, clock: () => new Date() });
      }
    );
    const host = hosts.register("Builder").host;
    ownHostRemoteAgents({
      database,
      hostId: host.id,
      grantWorkspaceId: fixture.workspaceId
    });
    hosts.bindToWorkspace(host.id, fixture.workspaceId);
    hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: fixture.workspaceId, status: "ready" }],
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
    database.close();

    const endpointUrl = `${fixture.origin}/api/v1/agent-endpoints?projectId=${encodeURIComponent(fixture.projectId)}&canvasId=default&humanPrincipalId=${encodeURIComponent(TEST_REMOTE_AGENT_OWNER_ID)}`;
    const request = () =>
      fetch(endpointUrl, {
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "x-planweave-human-identity": `Bearer ${ownerIdentityToken}`
        }
      });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPage = remoteAgentEndpointListSchema.parse(await first.json());
    const secondPage = remoteAgentEndpointListSchema.parse(await second.json());
    expect(secondPage).toEqual(firstPage);
    expect(firstPage.items).toHaveLength(1);
    for (const endpoint of firstPage.items) assertRemoteAgentEndpointRedacted(endpoint);
    expect(JSON.stringify(firstPage)).not.toMatch(/hostId|path|env|token|readiness/i);

    const fleetUrl = `${fixture.origin}/api/v1/agent-endpoints`;
    const fleet = await fetch(fleetUrl, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(fleet.status).toBe(200);
    const fleetPage = remoteAgentEndpointListSchema.parse(await fleet.json());
    expect(fleetPage.items).toEqual([]);

    for (const invalidPath of [
      `/api/v1/agent-endpoints?projectId=${fixture.projectId}&projectId=${fixture.projectId}`,
      `/api/v1/agent-endpoints?projectId=${fixture.projectId}&unknown=1`,
      "/api/v1/agent-endpoints?unknown=1"
    ]) {
      const invalid = await fetch(`${fixture.origin}${invalidPath}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(invalid.status).toBe(400);
    }

    const nonAdmin = await fetch(endpointUrl, {
      headers: {
        Authorization: `Bearer ${projectToken}`,
        "x-planweave-human-identity": `Bearer ${ownerIdentityToken}`
      }
    });
    expect(nonAdmin.status).toBe(200);
    await expect(nonAdmin.json()).resolves.toEqual(firstPage);
    const crossProject = await fetch(
      `${fixture.origin}/api/v1/agent-endpoints?projectId=unknown-project&canvasId=default&humanPrincipalId=${encodeURIComponent(TEST_REMOTE_AGENT_OWNER_ID)}`,
      {
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "x-planweave-human-identity": `Bearer ${ownerIdentityToken}`
        }
      }
    );
    expect(crossProject.status).toBe(200);
    await expect(crossProject.json()).resolves.toEqual(firstPage);
  });

  it("wires health, enrollment, legacy dispatch rejection, pagination, and shutdown", async () => {
    const fixture = await setup();
    expect(fixture.composition.ownsHttpServer).toBe(false);
    await expect((await fetch(`${fixture.origin}/readyz`)).json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });

    const trustedBootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
      }
    );
    expect(trustedBootstrap.status).toBe(201);
    const trustedOwner = (await trustedBootstrap.json()) as {
      deviceToken: string;
      principal: { humanPrincipalId: string };
    };
    const trustedIdentityResponse = await fetch(`${fixture.origin}/api/v1/human-identity/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "human-identity/v1",
        existingDeviceToken: trustedOwner.deviceToken
      })
    });
    expect(trustedIdentityResponse.status).toBe(200);
    const { identityToken: trustedIdentityToken } = (await trustedIdentityResponse.json()) as {
      identityToken: string;
    };

    const legacyScope = {
      kind: "block",
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      canvasId: "default",
      blockRef: "T-001#B-001"
    } as const;
    const executionTargetUrl = `${fixture.origin}/api/v1/projects/${fixture.projectId}/assignments/execution-target`;
    const legacyRead = await fetch(
      `${executionTargetUrl}?scope=${encodeURIComponent(JSON.stringify(legacyScope))}`,
      { headers: { Authorization: `Bearer ${trustedOwner.deviceToken}` } }
    );
    expect(legacyRead.status).toBe(200);
    await expect(legacyRead.json()).resolves.toMatchObject({
      target: { kind: "automatic_host" }
    });
    const authorityDatabase = await openServerDatabase(fixture.databasePath, 5_000);
    const exactTargetRevision = new AuthorityRepository(authorityDatabase).applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope: legacyScope,
        target: { kind: "exact_host", hostId: "legacy-private-host" },
        expectedRevision: fixture.executionTargetRevision
      },
      actor: { kind: "system", id: "server-composition-test" }
    }).revision;
    authorityDatabase.close();
    const exactLegacyRead = await fetch(
      `${executionTargetUrl}?scope=${encodeURIComponent(JSON.stringify(legacyScope))}`,
      { headers: { Authorization: `Bearer ${trustedOwner.deviceToken}` } }
    );
    expect(exactLegacyRead.status).toBe(200);
    await expect(exactLegacyRead.json()).resolves.toMatchObject({
      target: { kind: "exact_host", hostId: "legacy-private-host" }
    });
    const readOnlyWrite = await fetch(executionTargetUrl, {
      method: "POST",
      headers: jsonHeaders(trustedOwner.deviceToken),
      body: JSON.stringify({
        schemaVersion: "execution-target/v1",
        scope: legacyScope,
        target: { kind: "unassigned" },
        expectedRevision: exactTargetRevision
      })
    });
    expect(readOnlyWrite.status).toBe(400);
    await expect(readOnlyWrite.json()).resolves.toEqual({ error: "execution_target_read_only" });

    const assignmentsUrl = `${fixture.origin}/api/v1/projects/${fixture.projectId}/assignments`;
    for (const target of [
      { kind: "exact_host", hostId: "legacy-host" },
      { kind: "automatic_host" }
    ]) {
      const rejected = await fetch(assignmentsUrl, {
        method: "POST",
        headers: jsonHeaders(trustedOwner.deviceToken),
        body: JSON.stringify({
          workItem: { kind: "block", canvasId: "default", blockRef: "T-001#B-001" },
          target,
          expectedRevision: 0
        })
      });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({ error: "execution_target_read_only" });
    }
    const humanAssignment = await fetch(assignmentsUrl, {
      method: "POST",
      headers: jsonHeaders(trustedOwner.deviceToken),
      body: JSON.stringify({
        workItem: { kind: "task", canvasId: "default", taskId: "T-001" },
        target: {
          kind: "human",
          humanPrincipalId: trustedOwner.principal.humanPrincipalId
        },
        expectedRevision: 0
      })
    });
    expect(humanAssignment.status).toBe(200);

    const unknownBootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/unknown-project/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Unknown Owner", humanPrincipalId: "unknown-owner" })
      }
    );
    expect(unknownBootstrap.status).toBe(403);
    await expect(unknownBootstrap.json()).resolves.toEqual({
      error: "human_cross_project_forbidden"
    });

    const enrollment = await fetch(`${fixture.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: {
        ...jsonHeaders(adminToken),
        "x-planweave-human-identity": `Bearer ${trustedIdentityToken}`
      },
      body: JSON.stringify({
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      })
    });
    expect(enrollment.status).toBe(201);
    await expect(enrollment.json()).resolves.toMatchObject({
      enrollmentCode: expect.stringMatching(/^pw_enroll_/)
    });

    const request = {
      schemaVersion: "remote-run/v2",
      projectId: fixture.projectId,
      canvasId: "default",
      blockRef: "T-001#B-001",
      idempotencyKey: "composition-dispatch-1",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      expectedExecutionTargetRevision: fixture.executionTargetRevision
    };
    const dispatch = async (token: string, body = request, humanIdentityToken?: string) =>
      fetch(`${fixture.origin}/api/v1/remote-operations`, {
        method: "POST",
        headers: {
          ...jsonHeaders(token),
          ...(humanIdentityToken
            ? { "x-planweave-human-identity": `Bearer ${humanIdentityToken}` }
            : {})
        },
        body: JSON.stringify(body)
      });
    const first = await dispatch(adminToken);
    const second = await dispatch(adminToken);
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    await expect(first.json()).resolves.toEqual({
      error: "remote_run_v3_required",
      serverBuildRevision: "development"
    });
    await expect(second.json()).resolves.toEqual({
      error: "remote_run_v3_required",
      serverBuildRevision: "development"
    });

    const forbidden = await dispatch(
      projectToken,
      {
        schemaVersion: "remote-run/v3",
        projectId: "different-project",
        canvasId: request.canvasId,
        blockRef: request.blockRef,
        agentEndpointId: "endpoint-unauthorized",
        idempotencyKey: request.idempotencyKey,
        ...fixture.dispatchAuthority,
        humanPrincipalId: trustedOwner.principal.humanPrincipalId
      },
      trustedIdentityToken
    );
    expect(forbidden.status).toBe(403);
    const hosts = await fetch(`${fixture.origin}/api/v1/hosts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(hosts.status).toBe(200);
    await expect(hosts.json()).resolves.toEqual({ items: [], nextCursor: null });

    await fixture.composition.close();
    await fixture.composition.close();
    expect(fixture.composition.readiness()).toMatchObject({ status: "draining" });
    compositions.splice(compositions.indexOf(fixture.composition), 1);
  });
});
