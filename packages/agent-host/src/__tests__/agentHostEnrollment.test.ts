import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentHostConfig } from "../config/schema.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import {
  AgentHostEnrollmentService,
  type AgentHostEnrollmentExchange
} from "../enrollment/enrollmentService.js";
import type { HostEnrollmentRequest } from "@planweave-ai/agent-host-protocol";
import {
  HttpAgentHostEnrollmentExchange,
  resolveHostEnrollmentEndpoint
} from "../enrollment/httpEnrollmentExchange.js";
import {
  HttpAgentHostSetupCodeRedeem,
  resolveSetupCodeRedeemEndpoint
} from "../enrollment/httpSetupCodeRedeem.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const secret = (prefix: "pw_enroll_" | "pw_host_" | "pw_setup_") =>
  `${prefix}${randomBytes(32).toString("base64url")}`;

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-credential-"));
  directories.push(directory);
  const config = parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: { url: "https://coordinator.example.com" },
    dataDirectory: join(directory, "data"),
    workspaceRoot: directory,
    host: { displayName: "Build Host", capacity: 1, capabilities: ["linux"] },
    workspaces: [],
    agentProfiles: []
  });
  return {
    directory,
    config,
    store: new FileHostCredentialStore(join(directory, "credentials", "host.json"))
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  return address.port;
}

describe("Agent Host enrollment and protected credentials", () => {
  it("persists pending before exchange, promotes atomically, and protects directory/file modes", async () => {
    const { config, store } = await setup();
    const exchange: AgentHostEnrollmentExchange = {
      exchange: vi.fn(async (request) => ({
        type: "host.enrollment.completed",
        protocolVersion: agentHostProtocolVersion,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: "host-001",
        workspaceId: "workspace-001",
        credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }))
    };
    const active = await new AgentHostEnrollmentService(config, store, exchange).enroll(
      secret("pw_enroll_")
    );
    expect(active.hostId).toBe("host-001");
    expect(active.provenance).toBeUndefined();
    expect((await store.read())?.pending).toBeUndefined();
    expect((await stat(join(config.dataDirectory, "..", "credentials"))).mode & 0o777).toBe(0o700);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it("keeps one installation UUID while replacing the prior Host credential generation", async () => {
    const { config, store } = await setup();
    const requests: HostEnrollmentRequest[] = [];
    const exchange: AgentHostEnrollmentExchange = {
      exchange: async (request) => {
        requests.push(request);
        return {
          type: "host.enrollment.completed",
          protocolVersion: agentHostProtocolVersion,
          enrollmentAttemptId: request.enrollmentAttemptId,
          hostId: requests.length === 1 ? "host-generation-one" : "host-generation-two",
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        };
      }
    };
    const service = new AgentHostEnrollmentService(config, store, exchange);
    await service.enroll(secret("pw_enroll_"));
    await service.enroll(secret("pw_enroll_"), { replaceExisting: true });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(requests[1]?.installationId).toBe(requests[0]?.installationId);
    expect(requests[0]?.supersedesHostId).toBeUndefined();
    expect(requests[1]?.supersedesHostId).toBe("host-generation-one");
    expect((await stat(join(config.dataDirectory, "installation.json"))).mode & 0o777).toBe(0o600);
  });

  it("retains pending state after interruption and resumes the exact attempt/token", async () => {
    const { config, store } = await setup();
    const first: AgentHostEnrollmentExchange = {
      exchange: vi.fn(async () => {
        throw new Error("network interrupted");
      })
    };
    await expect(
      new AgentHostEnrollmentService(config, store, first).enroll(secret("pw_enroll_"))
    ).rejects.toThrow("network interrupted");
    const pending = (await store.read())?.pending;
    expect(pending).toBeDefined();
    const resumed: AgentHostEnrollmentExchange = {
      exchange: vi.fn(async (request) => ({
        type: "host.enrollment.completed",
        protocolVersion: agentHostProtocolVersion,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: "host-resumed",
        workspaceId: "workspace-001",
        credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }))
    };
    await new AgentHostEnrollmentService(config, store, resumed).resume();
    expect(resumed.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        enrollmentAttemptId: pending?.enrollmentAttemptId,
        credentialToken: pending?.credentialToken
      }),
      undefined
    );
  });

  it("rejects a response for another attempt and keeps the resumable pending credential", async () => {
    const { config, store } = await setup();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "host.enrollment.completed",
          protocolVersion: agentHostProtocolVersion,
          enrollmentAttemptId: "another-attempt",
          hostId: "host-mismatch",
          workspaceId: "workspace-001",
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        })
      );
    });
    servers.push(server);
    const port = await listen(server);
    const exchange = new HttpAgentHostEnrollmentExchange(`http://127.0.0.1:${port}`, {
      allowInsecureDevelopment: true
    });

    await expect(
      new AgentHostEnrollmentService(config, store, exchange).enroll(secret("pw_enroll_"))
    ).rejects.toThrow("agent_host_enrollment_response_mismatch");
    expect((await store.read())?.pending).toBeDefined();
    expect((await store.read())?.active).toBeUndefined();
  });

  it("never forwards enrollment credentials through an HTTP redirect", async () => {
    let redirectedRequests = 0;
    const target = createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    servers.push(target);
    const targetPort = await listen(target);
    const source = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetPort}/credential-capture`
      });
      response.end();
    });
    servers.push(source);
    const sourcePort = await listen(source);
    const exchange = new HttpAgentHostEnrollmentExchange(`http://127.0.0.1:${sourcePort}`, {
      allowInsecureDevelopment: true
    });

    await expect(
      exchange.exchange({
        type: "host.enrollment.request",
        protocolVersion: agentHostProtocolVersion,
        enrollmentCode: secret("pw_enroll_"),
        enrollmentAttemptId: "attempt-no-redirect",
        credentialToken: secret("pw_host_"),
        displayName: "Build Host",
        capabilities: ["linux"],
        capacity: 1
      })
    ).rejects.toThrow("agent_host_enrollment_exchange_failed");
    expect(redirectedRequests).toBe(0);
  });

  it("requires explicit replacement, preserves active on failed replacement, and rejects expiry/revocation", async () => {
    const { config, store } = await setup();
    const successful: AgentHostEnrollmentExchange = {
      exchange: async (request) => ({
        type: "host.enrollment.completed",
        protocolVersion: agentHostProtocolVersion,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: "host-original",
        workspaceId: "workspace-001",
        credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      })
    };
    const service = new AgentHostEnrollmentService(config, store, successful);
    const original = await service.enroll(secret("pw_enroll_"));
    await expect(service.enroll(secret("pw_enroll_"))).rejects.toThrow(
      "replacement_requires_operator"
    );
    const failed = new AgentHostEnrollmentService(config, store, {
      exchange: async () => {
        throw new Error("offline");
      }
    });
    await expect(failed.enroll(secret("pw_enroll_"), { replaceExisting: true })).rejects.toThrow(
      "offline"
    );
    expect((await store.read())?.active).toEqual(original);
    await expect(store.requireUsable(new Date(Date.parse(original.expiresAt) + 1))).rejects.toThrow(
      "credential_unavailable"
    );
    await store.markRevoked();
    await expect(store.requireUsable()).rejects.toThrow("credential_unavailable");
  });

  it("rejects corrupt or permission-unsafe credential files without fallback and does not expose secrets in errors", async () => {
    const { store } = await setup();
    await store.begin(
      {
        kind: "host_enrollment_code",
        enrollmentAttemptId: "attempt-001",
        enrollmentCode: secret("pw_enroll_"),
        credentialToken: secret("pw_host_"),
        createdAt: new Date().toISOString()
      },
      false
    );
    await writeFile(store.path, "{broken", "utf8");
    await expect(store.read()).rejects.toThrow();
    await writeFile(
      store.path,
      JSON.stringify({ version: "agent-host-credentials/v1", unexpected: true }),
      "utf8"
    );
    await expect(store.read()).rejects.toThrow();
    await chmod(store.path, 0o644);
    await expect(store.read()).rejects.toThrow("permissions_unsafe");
    expect(await readFile(store.path, "utf8")).not.toContain("pw_host_");
  });

  it("redeems setup codes through the setup route and never mixes enrollment codes", async () => {
    const { config, store } = await setup();
    const server = createServer((request, response) => {
      expect(request.url).toBe("/api/v1/setup-codes/redeem");
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as {
          purpose: string;
          setupCode: string;
          enrollmentAttemptId: string;
          hostCredentialToken: string;
        };
        expect(parsed.purpose).toBe("host_enrollment");
        expect(parsed.setupCode).toMatch(/^pw_setup_/);
        expect(parsed.enrollmentAttemptId).toMatch(/^enroll-/);
        expect(parsed.hostCredentialToken).toMatch(/^pw_host_/);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            schemaVersion: "workspace-setup/v1",
            purpose: "host_enrollment",
            workspaceId: "workspace-001",
            workspaceDisplayName: "Demo",
            connectionProfile: {
              schemaVersion: "workspace-identity/v1",
              profileId: "profile-001",
              displayName: "Demo",
              serverBaseUrl: "http://127.0.0.1/",
              workspaceId: "workspace-001",
              allowInsecureTransport: true
            },
            enrollmentAttemptId: parsed.enrollmentAttemptId,
            enrollmentId: "enrollment-setup-001",
            hostId: "host-setup-001",
            hostCredentialExpiresAt: new Date(Date.now() + 60_000).toISOString()
          })
        );
      });
    });
    servers.push(server);
    const port = await listen(server);
    const setupRedeem = new HttpAgentHostSetupCodeRedeem(`http://127.0.0.1:${port}`, {
      allowInsecureDevelopment: true
    });
    const active = await new AgentHostEnrollmentService(
      config,
      store,
      {
        exchange: async () => {
          throw new Error("legacy enrollment path must not run for setup codes");
        }
      },
      () => new Date(),
      setupRedeem
    ).enroll(secret("pw_setup_"));
    expect(active.hostId).toBe("host-setup-001");
    expect((await store.read())?.pending).toBeUndefined();
    expect(resolveSetupCodeRedeemEndpoint("https://coordinator.example.com").href).toBe(
      "https://coordinator.example.com/api/v1/setup-codes/redeem"
    );
  });

  it("keeps a setup-code enrollment pending when the response attempt does not match", async () => {
    const { config, store } = await setup();
    const setupRedeem = new HttpAgentHostSetupCodeRedeem("https://coordinator.example.com", {
      request: async () =>
        new Response(
          JSON.stringify({
            schemaVersion: "workspace-setup/v1",
            purpose: "host_enrollment",
            workspaceId: "workspace-001",
            workspaceDisplayName: "Demo",
            connectionProfile: {
              schemaVersion: "workspace-identity/v1",
              profileId: "profile-001",
              displayName: "Demo",
              serverBaseUrl: "https://coordinator.example.com/",
              workspaceId: "workspace-001",
              allowInsecureTransport: false
            },
            enrollmentAttemptId: "enroll-another-attempt",
            enrollmentId: "enrollment-setup-001",
            hostId: "host-setup-001",
            hostCredentialExpiresAt: new Date(Date.now() + 60_000).toISOString()
          }),
          { headers: { "content-type": "application/json" } }
        )
    });

    await expect(
      new AgentHostEnrollmentService(
        config,
        store,
        {
          exchange: async () => {
            throw new Error("legacy enrollment path must not run");
          }
        },
        () => new Date(),
        setupRedeem
      ).enroll(secret("pw_setup_"))
    ).rejects.toThrow("agent_host_enrollment_response_mismatch");
    expect((await store.read())?.pending?.kind).toBe("setup_code");
    expect((await store.read())?.active).toBeUndefined();
  });

  it("maps coordinator schemes once and bounds or normalizes HTTP exchange failures", async () => {
    expect(resolveHostEnrollmentEndpoint("wss://coordinator.example.com").href).toBe(
      "https://coordinator.example.com/agent-hosts/enrollments/exchange"
    );
    expect(resolveHostEnrollmentEndpoint("ws://coordinator.example.com", true).href).toBe(
      "http://coordinator.example.com/agent-hosts/enrollments/exchange"
    );
    expect(() => resolveHostEnrollmentEndpoint("http://coordinator.example.com")).toThrow(
      "agent_host_enrollment_transport_insecure"
    );
    expect(() => resolveHostEnrollmentEndpoint("ws://coordinator.example.com")).toThrow(
      "agent_host_enrollment_transport_insecure"
    );
    const credentialToken = secret("pw_host_");
    const input = {
      type: "host.enrollment.request" as const,
      protocolVersion: agentHostProtocolVersion,
      enrollmentCode: secret("pw_enroll_"),
      enrollmentAttemptId: "attempt-http-bounds",
      credentialToken,
      displayName: "Build Host",
      capabilities: ["linux"],
      capacity: 1
    };
    const oversized = new HttpAgentHostEnrollmentExchange("https://coordinator.example.com", {
      request: async () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "16385" }
        })
    });
    await expect(oversized.exchange(input)).rejects.toThrow(
      "agent_host_enrollment_response_too_large"
    );
    const wrongContentType = new HttpAgentHostEnrollmentExchange(
      "https://coordinator.example.com",
      {
        request: async () => new Response("{}", { headers: { "content-type": "text/plain" } })
      }
    );
    await expect(wrongContentType.exchange(input)).rejects.toThrow(
      "agent_host_enrollment_response_malformed"
    );
    const networkFailure = new HttpAgentHostEnrollmentExchange("https://coordinator.example.com", {
      request: async () => {
        throw new Error(`network failed for ${credentialToken}`);
      }
    });
    await expect(networkFailure.exchange(input)).rejects.toThrow(
      "agent_host_enrollment_exchange_failed"
    );
    await expect(networkFailure.exchange(input)).rejects.not.toThrow(credentialToken);
  });
});
