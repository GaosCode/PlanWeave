import { randomBytes, randomUUID } from "node:crypto";
import {
  directHttpsTransportAdmission,
  loopbackHttpTransportAdmission
} from "./support/transportAdmission.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { attachHostEnrollmentHttp } from "../hostEnrollmentHttp.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";

const directories: string[] = [];
const stores: PlanweaveServer[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-enrollment-"));
  directories.push(directory);
  const store = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  stores.push(store);
  return store;
}

function token() {
  return `pw_host_${randomBytes(32).toString("base64url")}`;
}

function request(
  enrollmentCode: string,
  credentialToken = token(),
  enrollmentAttemptId = "attempt-http-001"
) {
  return {
    type: "host.enrollment.request",
    protocolVersion: 1,
    enrollmentCode,
    enrollmentAttemptId,
    installationId: randomUUID(),
    credentialToken,
    displayName: "Linux Build Host",
    capabilities: ["linux", "workspace.git"],
    capacity: 2
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  return address.port;
}

describe("Agent Host enrollment", () => {
  it("creates server-scoped grants without workspace binding", async () => {
    const store = await setup();
    const service = new HostEnrollmentService(store.database);
    const grant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    expect(grant.workspaceId).toBeUndefined();
    expect(grant.enrollmentCode).toMatch(/^pw_enroll_/);
    const bindings = store.database
      .prepare("SELECT workspace_id FROM workspace_host_enrollments")
      .all();
    expect(bindings).toHaveLength(0);
  });

  it("exchanges once without workspace binding, replays identically, and authenticates the host", async () => {
    const store = await setup();
    const service = new HostEnrollmentService(store.database);
    const grant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const credentialToken = token();
    const input = request(grant.enrollmentCode, credentialToken);

    const first = service.exchange(input);
    const replay = service.exchange(input);
    const hosts = new AgentHostRepository(store.database);

    expect(first.workspaceId).toBeUndefined();
    expect(replay).toEqual(first);
    expect(hosts.authenticate(first.hostId, credentialToken)?.id).toBe(first.hostId);
    const workspaceBindings = store.database
      .prepare("SELECT workspace_id FROM workspace_agent_hosts WHERE host_id=?")
      .all(first.hostId);
    expect(workspaceBindings).toHaveLength(0);
    store.database
      .prepare("UPDATE agent_hosts SET credential_expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1).toISOString(), first.hostId);
    expect(hosts.authenticate(first.hostId, credentialToken)).toBeUndefined();
    const persisted = JSON.stringify({
      grants: store.database.prepare("SELECT * FROM agent_host_enrollment_grants").all(),
      hosts: store.database.prepare("SELECT * FROM agent_hosts").all()
    });
    expect(persisted).not.toContain(grant.enrollmentCode);
    expect(persisted).not.toContain(credentialToken);
  });

  it("registers one visible generation per stable installation and retires the prior Host", async () => {
    const store = await setup();
    const superseded: string[] = [];
    const service = new HostEnrollmentService(
      store.database,
      () => new Date(),
      (hostId) => superseded.push(hostId)
    );
    const installationId = randomUUID();
    const firstGrant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const firstToken = token();
    const firstRequest = {
      ...request(firstGrant.enrollmentCode, firstToken, "attempt-generation-one"),
      installationId
    };
    const first = service.exchange(firstRequest);

    const secondGrant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const secondToken = token();
    const secondRequest = {
      ...request(secondGrant.enrollmentCode, secondToken, "attempt-generation-two"),
      installationId,
      supersedesHostId: first.hostId
    };
    const second = service.exchange(secondRequest);
    expect(service.exchange(secondRequest)).toEqual(second);

    const hosts = new AgentHostRepository(store.database);
    expect(second.hostId).not.toBe(first.hostId);
    expect(hosts.authenticate(first.hostId, firstToken)).toBeUndefined();
    expect(hosts.authenticate(second.hostId, secondToken)?.id).toBe(second.hostId);
    expect(hosts.list().map((host) => host.id)).toEqual([second.hostId]);
    expect(superseded).toEqual([first.hostId]);
    expect(
      store.database
        .prepare(
          "SELECT installation_id,superseded_at,superseded_by_host_id FROM agent_hosts WHERE id=?"
        )
        .get(first.hostId)
    ).toEqual({
      installation_id: installationId,
      superseded_at: expect.any(String),
      superseded_by_host_id: second.hostId
    });
  });

  it("rejects a stale Host generation that conflicts with the current installation", async () => {
    const store = await setup();
    const service = new HostEnrollmentService(store.database);
    const installationId = randomUUID();
    const firstGrant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    service.exchange({
      ...request(firstGrant.enrollmentCode, token(), "attempt-current-generation"),
      installationId
    });
    const conflictingGrant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    expect(() =>
      service.exchange({
        ...request(conflictingGrant.enrollmentCode, token(), "attempt-stale-generation"),
        installationId,
        supersedesHostId: "host-that-is-not-current"
      })
    ).toThrow("Agent Host enrollment was rejected.");
  });

  it("exchanges once with legacy workspace binding when grant is workspace-scoped", async () => {
    const store = await setup();
    const workspaceId = new WorkspaceIdentityRepository(
      store.database
    ).ensureWorkspaceForLegacyProject("project-enrollment");
    const service = new HostEnrollmentService(store.database);
    const grant = service.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const credentialToken = token();
    const input = request(grant.enrollmentCode, credentialToken);

    const first = service.exchange(input);
    const hosts = new AgentHostRepository(store.database);

    expect(first.workspaceId).toBe(workspaceId);
    expect(hosts.authenticate(first.hostId, credentialToken)?.id).toBe(first.hostId);
  });

  it("authenticates server-scoped hosts independently of legacy workspace bindings", async () => {
    const store = await setup();
    const hosts = new AgentHostRepository(store.database);
    const registration = hosts.register("Unbound Host");
    expect(hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );

    const identity = new WorkspaceIdentityRepository(store.database);
    const firstWorkspace = identity.ensureWorkspaceForLegacyProject("project-one");
    const secondWorkspace = identity.ensureWorkspaceForLegacyProject("project-two");

    hosts.bindToWorkspace(registration.host.id, firstWorkspace);
    expect(hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );
    expect(hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );

    hosts.bindToWorkspace(registration.host.id, secondWorkspace);
    expect(hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );
    expect(hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );
  });

  it("persists only the redacted target Host readiness observation from authenticated reports", async () => {
    const store = await setup();
    const hosts = new AgentHostRepository(store.database);
    const registered = hosts.register("Readiness Host");
    const reported = {
      workspaceMappings: [{ workspaceId: "workspace-readiness", status: "ready" as const }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready" as const,
          capabilities: ["acp.codex"]
        }
      ]
    };

    hosts.reportOnline(registered.host.id, ["acp.codex"], 1, reported);
    expect(hosts.getRequired(registered.host.id).readinessObservation).toEqual(reported);

    const missingProfile = {
      workspaceMappings: [{ workspaceId: "workspace-readiness", status: "ready" as const }],
      acpProfiles: []
    };
    hosts.touch(registered.host.id, new Date(), missingProfile);
    expect(hosts.getRequired(registered.host.id).readinessObservation).toEqual(missingProfile);
    hosts.reportOnline(registered.host.id, ["acp.codex"], 1);
    expect(hosts.getRequired(registered.host.id).readinessObservation).toBeUndefined();
    expect(
      JSON.stringify(store.database.prepare("SELECT readiness_json FROM agent_hosts").all())
    ).not.toContain("/private/");
  });

  it("revokes server-scoped grants and enrolled hosts", async () => {
    const store = await setup();
    const service = new HostEnrollmentService(store.database);
    const grant = service.createGrant({
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const credentialToken = token();
    const input = request(grant.enrollmentCode, credentialToken);
    const completed = service.exchange(input);
    const hosts = new AgentHostRepository(store.database);
    expect(hosts.authenticate(completed.hostId, credentialToken)?.id).toBe(completed.hostId);

    service.revokeGrant(grant.enrollmentCode);
    expect(() => service.exchange(input)).toThrow("Agent Host enrollment was rejected.");

    hosts.revoke(completed.hostId);
    expect(hosts.authenticate(completed.hostId, credentialToken)).toBeUndefined();
  });

  it("rejects conflicting replay, expired and revoked grants without leaking secrets", async () => {
    const store = await setup();
    const workspaceId = new WorkspaceIdentityRepository(
      store.database
    ).ensureWorkspaceForLegacyProject("project-enrollment");
    const service = new HostEnrollmentService(store.database);
    const create = () =>
      service.createGrant({
        workspaceId,
        expiresAt: new Date(Date.now() + 60_000),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      });
    const used = create();
    const input = request(used.enrollmentCode);
    service.exchange(input);
    expect(() => service.exchange({ ...input, displayName: "Different Host" })).toThrow(
      "Agent Host enrollment was rejected."
    );

    const expired = create();
    store.database
      .prepare("UPDATE agent_host_enrollment_grants SET expires_at=? WHERE code_hash<>?")
      .run(new Date(Date.now() - 1).toISOString(), "unused");
    expect(() => service.exchange(request(expired.enrollmentCode))).toThrow(
      "Agent Host enrollment was rejected."
    );

    const revoked = create();
    service.revokeGrant(revoked.enrollmentCode);
    expect(() => service.exchange(request(revoked.enrollmentCode))).toThrow(
      "Agent Host enrollment was rejected."
    );
  });

  it("serves the strict exchange over real loopback HTTP only with explicit development opt-in", async () => {
    const store = await setup();
    const workspaceId = new WorkspaceIdentityRepository(
      store.database
    ).ensureWorkspaceForLegacyProject("project-enrollment");
    const service = new HostEnrollmentService(store.database);
    const grant = service.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const server = createServer();
    servers.push(server);
    const strictAttachment = attachHostEnrollmentHttp(server, {
      service,
      transportAdmission: directHttpsTransportAdmission
    });
    const port = await listen(server);
    const endpoint = `http://127.0.0.1:${port}/agent-hosts/enrollments/exchange`;
    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request(grant.enrollmentCode))
    });
    expect(rejected.status).toBe(426);

    strictAttachment.close();
    attachHostEnrollmentHttp(server, {
      service,
      transportAdmission: loopbackHttpTransportAdmission
    });
    const acceptedRequest = request(grant.enrollmentCode);
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(acceptedRequest)
    });
    expect(accepted.status).toBe(200);
    const completed = await accepted.json();
    expect(completed).toMatchObject({
      type: "host.enrollment.completed",
      enrollmentAttemptId: acceptedRequest.enrollmentAttemptId
    });

    const replay = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(acceptedRequest)
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(completed);

    const conflict = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...acceptedRequest, displayName: "Conflicting Host" })
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "conflict", retryable: false });

    const revokedGrant = service.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    service.revokeGrant(revokedGrant.enrollmentCode);
    const revoked = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request(revokedGrant.enrollmentCode, token(), "attempt-revoked"))
    });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: "revoked", retryable: false });

    const expiredGrant = service.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    store.database
      .prepare("UPDATE agent_host_enrollment_grants SET expires_at=? WHERE expires_at=?")
      .run(new Date(Date.now() - 1).toISOString(), expiredGrant.expiresAt);
    const expired = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request(expiredGrant.enrollmentCode, token(), "attempt-expired"))
    });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: "expired", retryable: false });

    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(acceptedRequest)
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "malformed", retryable: false });
  });

  it("keeps unrelated HTTP routes available to sibling listeners", async () => {
    const store = await setup();
    const server = createServer();
    servers.push(server);
    attachHostEnrollmentHttp(server, {
      service: new HostEnrollmentService(store.database),
      transportAdmission: loopbackHttpTransportAdmission
    });
    server.on("request", (incoming, response) => {
      if (incoming.url === "/health" && !response.headersSent) response.writeHead(204).end();
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(204);
  });

  it("excludes expired credentials from authentication, liveness updates, and scheduling", async () => {
    const store = await setup();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const hosts = new AgentHostRepository(store.database, () => now);
    const credentialToken = token();
    const registered = hosts.registerWithCredential(
      "Expiring Host",
      credentialToken,
      ["linux"],
      1,
      "2030-01-01T00:01:00.000Z"
    );
    hosts.reportOnline(registered.host.id, ["linux"], 1);
    expect(hosts.listAvailable(["linux"], new Date("2029-12-31T23:59:00.000Z"))).toHaveLength(1);

    now = new Date("2030-01-01T00:01:00.000Z");
    expect(hosts.authenticate(registered.host.id, credentialToken)).toBeUndefined();
    expect(() => hosts.reportOnline(registered.host.id, ["linux"], 1)).toThrow(
      "agent_host_not_found_or_revoked"
    );
    expect(() => hosts.touch(registered.host.id, now)).toThrow("agent_host_not_found_or_revoked");
    expect(hosts.listAvailable(["linux"], new Date("2029-12-31T23:59:00.000Z"))).toEqual([]);
  });
});
