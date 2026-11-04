import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHostSetupHandoffSchema,
  serializeAgentHostSetupHandoff,
  type AgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentHostConfig, type AgentHostConfig } from "../config/schema.js";
import { hostCredentialDocumentSchema } from "../credentials/credentialContract.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import {
  activePortableHandoffProvenanceSchema,
  consumePortableHandoffProvenance,
  createPendingPortableHandoffProvenance,
  pendingPortableHandoffProvenanceSchema,
  verifyActivePortableHandoffProvenance
} from "../credentials/handoffProvenance.js";
import {
  AgentHostEnrollmentService,
  type AgentHostEnrollmentExchange
} from "../enrollment/enrollmentService.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const secret = (prefix: "pw_enroll_" | "pw_host_" | "pw_setup_") =>
  `${prefix}${randomBytes(32).toString("base64url")}`;

async function setup(): Promise<{
  config: AgentHostConfig;
  encodedHandoff: string;
  handoff: AgentHostSetupHandoff;
  store: FileHostCredentialStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-handoff-provenance-"));
  directories.push(directory);
  const handoff = agentHostSetupHandoffSchema.parse({
    version: "agent-host-setup/v2",
    endpoint: {
      topology: "lan_http",
      serverOrigin: "http://192.168.1.8:4317",
      allowedClientOrigins: ["http://192.168.1.8:4317"],
      tlsTrust: "not_applicable"
    },
    workspaceId: "workspace-portable",
    enrollmentCode: secret("pw_enroll_"),
    expiresAt: "2030-01-01T00:00:00.000Z",
    credentialExpiresAt: "2030-06-30T00:00:00.000Z",
    credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
    display: { workspaceName: "Studio", serverName: "Private server" }
  });
  const config = parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: {
      url: handoff.endpoint.serverOrigin,
      allowInsecureDevelopment: true,
      endpoint: handoff.endpoint
    },
    dataDirectory: join(directory, "data"),
    workspaceRoot: directory,
    host: { displayName: "Build Host", capacity: 1, capabilities: ["linux"] },
    workspaces: [{ id: handoff.workspaceId, path: handoff.workspaceId }],
    agentProfiles: []
  });
  return {
    config,
    encodedHandoff: serializeAgentHostSetupHandoff(handoff),
    handoff,
    store: new FileHostCredentialStore(join(directory, "credentials", "host.json"))
  };
}

async function setupFleet(): Promise<{
  config: AgentHostConfig;
  encodedHandoff: string;
  handoff: AgentHostSetupHandoff;
  store: FileHostCredentialStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-handoff-fleet-"));
  directories.push(directory);
  const handoff = agentHostSetupHandoffSchema.parse({
    version: "agent-host-setup/v2",
    endpoint: {
      topology: "lan_http",
      serverOrigin: "http://192.168.1.8:4317",
      allowedClientOrigins: ["http://192.168.1.8:4317"],
      tlsTrust: "not_applicable"
    },
    enrollmentCode: secret("pw_enroll_"),
    expiresAt: "2030-01-01T00:00:00.000Z",
    credentialExpiresAt: "2030-06-30T00:00:00.000Z",
    credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
    display: { workspaceName: "Owner fleet", serverName: "Private server" }
  });
  const config = parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: {
      url: handoff.endpoint.serverOrigin,
      allowInsecureDevelopment: true,
      endpoint: handoff.endpoint
    },
    dataDirectory: join(directory, "data"),
    workspaceRoot: directory,
    host: { displayName: "Fleet Host", capacity: 1, capabilities: ["linux"] },
    workspaces: [],
    agentProfiles: []
  });
  return {
    config,
    encodedHandoff: serializeAgentHostSetupHandoff(handoff),
    handoff,
    store: new FileHostCredentialStore(join(directory, "credentials", "host.json"))
  };
}

function successfulExchange(
  workspaceId: string,
  hostId = "host-portable"
): AgentHostEnrollmentExchange {
  return {
    exchange: async (request) => ({
      type: "host.enrollment.completed",
      protocolVersion: agentHostProtocolVersion,
      enrollmentAttemptId: request.enrollmentAttemptId,
      hostId,
      workspaceId,
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    })
  };
}

function successfulFleetExchange(hostId = "host-fleet"): AgentHostEnrollmentExchange {
  return {
    exchange: async (request) => ({
      type: "host.enrollment.completed",
      protocolVersion: agentHostProtocolVersion,
      enrollmentAttemptId: request.enrollmentAttemptId,
      hostId,
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    })
  };
}

describe("Agent Host portable handoff enrollment provenance", () => {
  it("locks the persisted v2 canonical digest vectors", () => {
    const handoff = agentHostSetupHandoffSchema.parse({
      version: "agent-host-setup/v2",
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.8:4317",
        allowedClientOrigins: ["http://192.168.1.8:4317"],
        tlsTrust: "not_applicable"
      },
      workspaceId: "workspace-portable",
      enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      display: { workspaceName: "Studio", serverName: "Private server" }
    });
    const pending = createPendingPortableHandoffProvenance(
      handoff,
      new Date("2029-01-01T00:00:00.000Z")
    );
    expect(pending.handoffDigest).toBe(
      "0afa289e3966cd9d1f733863b4a0af1d9142d8bf2ae10da0a25c2d4785d30b8c"
    );
    expect(pending.endpointWorkspaceBindingDigest).toBe(
      "004c9a2a466c46d5d815332767f3d2b893ab04e22185b5303ba85dd7ec9ef03f"
    );
    const active = consumePortableHandoffProvenance(
      pending,
      {
        hostId: "host-portable",
        workspaceId: "workspace-portable",
        credentialToken: `pw_host_${"b".repeat(43)}`,
        issuedAt: "2029-01-01T00:00:01.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z"
      },
      new Date("2029-01-01T00:00:01.000Z")
    );
    expect(active.credentialBindingDigest).toBe(
      "ce0b443060b4740ee269019a15e1bfaacabc4db52b3bde0ab05bdb7fa5102bd3"
    );
  });

  it("rejects expired encoded handoffs before creating pending state", async () => {
    const { config, handoff, store } = await setup();
    const expired = serializeAgentHostSetupHandoff({
      ...handoff,
      expiresAt: "2028-12-31T23:59:59.000Z"
    });
    const exchange = vi.fn();
    await expect(
      new AgentHostEnrollmentService(
        config,
        store,
        { exchange },
        () => new Date("2029-01-01T00:00:00.000Z")
      ).enrollPortableHandoff(expired)
    ).rejects.toThrow("agent_host_setup_handoff_expired");
    expect(exchange).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  });

  it("rejects full endpoint binding drift before creating pending state", async () => {
    const { config, encodedHandoff, handoff, store } = await setup();
    const driftedConfig = parseAgentHostConfig({
      ...config,
      coordinator: {
        ...config.coordinator,
        endpoint: {
          ...handoff.endpoint,
          allowedClientOrigins: ["http://192.168.1.9:4317"]
        }
      }
    });
    const exchange = vi.fn();
    await expect(
      new AgentHostEnrollmentService(
        driftedConfig,
        store,
        { exchange },
        () => new Date("2029-01-01T00:00:00.000Z")
      ).enrollPortableHandoff(encodedHandoff)
    ).rejects.toThrow("agent_host_handoff_config_conflict");
    expect(exchange).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  });

  it("promotes provenance atomically, verifies it after restart, and preserves it on revoke", async () => {
    const { config, encodedHandoff, handoff, store } = await setup();
    const acceptedAt = new Date("2029-01-01T00:00:00.000Z");
    const consumedAt = new Date("2029-01-01T00:00:01.000Z");
    const clock = vi.fn().mockReturnValueOnce(acceptedAt).mockReturnValueOnce(consumedAt);
    const active = await new AgentHostEnrollmentService(
      config,
      store,
      successfulExchange(handoff.workspaceId!),
      clock
    ).enrollPortableHandoff(encodedHandoff);

    expect(active.provenance).toMatchObject({
      kind: "portable_handoff",
      acceptedAt: acceptedAt.toISOString(),
      consumedAt: consumedAt.toISOString()
    });
    expect(verifyActivePortableHandoffProvenance(active, config)).toBe(true);
    const restarted = await new FileHostCredentialStore(store.path).read();
    expect(restarted?.pending).toBeUndefined();
    expect(
      restarted?.active && verifyActivePortableHandoffProvenance(restarted.active, config)
    ).toBe(true);

    await store.markRevoked(new Date("2029-01-01T00:00:02.000Z"));
    const revoked = (await store.read())?.active;
    expect(revoked?.provenance).toEqual(active.provenance);
    expect(revoked && verifyActivePortableHandoffProvenance(revoked, config)).toBe(true);
    await expect(store.requireUsable()).rejects.toThrow("credential_unavailable");
  });

  it("persists the same provenance through interruption and resume", async () => {
    const { config, encodedHandoff, handoff, store } = await setup();
    const tokenLeak = secret("pw_host_");
    const failingExchange = vi.fn(async () => {
      throw new Error(`network failed for ${tokenLeak}`);
    });
    const failing = new AgentHostEnrollmentService(
      config,
      store,
      { exchange: failingExchange },
      () => new Date("2029-01-01T00:00:00.000Z")
    );
    const error = await failing.enrollPortableHandoff(encodedHandoff).then(
      () => null,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    const pending = (await store.read())?.pending;
    if (pending?.kind !== "host_enrollment_code" || !pending.provenance) {
      throw new Error("expected_portable_pending");
    }
    expect(JSON.stringify(pending.provenance)).not.toContain(handoff.enrollmentCode);

    const active = await new AgentHostEnrollmentService(
      config,
      store,
      successfulExchange(handoff.workspaceId!, "host-resumed"),
      () => new Date("2029-01-01T00:00:03.000Z")
    ).resume();
    expect(active.provenance).toMatchObject(pending.provenance);
    expect(verifyActivePortableHandoffProvenance(active, config)).toBe(true);
  });

  it("rejects pending digest drift before exchange without exposing stored credentials", async () => {
    const { config, encodedHandoff, store } = await setup();
    await expect(
      new AgentHostEnrollmentService(
        config,
        store,
        {
          exchange: async () => {
            throw new Error("offline");
          }
        },
        () => new Date("2029-01-01T00:00:00.000Z")
      ).enrollPortableHandoff(encodedHandoff)
    ).rejects.toThrow("offline");
    const document = await store.read();
    if (document?.pending?.kind !== "host_enrollment_code" || !document.pending.provenance) {
      throw new Error("expected_portable_pending");
    }
    await writeFile(
      store.path,
      `${JSON.stringify({
        ...document,
        pending: {
          ...document.pending,
          provenance: { ...document.pending.provenance, handoffDigest: "0".repeat(64) }
        }
      })}\n`,
      { mode: 0o600 }
    );
    const exchange = vi.fn(async () => {
      throw new Error("exchange_must_not_run");
    });
    const error = await new AgentHostEnrollmentService(config, store, { exchange }).resume().then(
      () => null,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("agent_host_handoff_provenance_invalid");
    expect(String(error)).not.toContain(document.pending.enrollmentCode);
    expect(String(error)).not.toContain(document.pending.credentialToken);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("clears provenance on ordinary replacement and detects config or credential drift", async () => {
    const { config, encodedHandoff, handoff, store } = await setup();
    const service = new AgentHostEnrollmentService(
      config,
      store,
      successfulExchange(handoff.workspaceId!),
      () => new Date("2029-01-01T00:00:01.000Z")
    );
    const portable = await service.enrollPortableHandoff(encodedHandoff);
    const copiedConfig = parseAgentHostConfig({
      ...config,
      coordinator: {
        url: "http://192.168.1.9:4317",
        allowInsecureDevelopment: true,
        endpoint: {
          ...handoff.endpoint,
          serverOrigin: "http://192.168.1.9:4317",
          allowedClientOrigins: ["http://192.168.1.9:4317"]
        }
      }
    });
    expect(verifyActivePortableHandoffProvenance(portable, copiedConfig)).toBe(false);
    expect(
      verifyActivePortableHandoffProvenance(
        { ...portable, credentialToken: secret("pw_host_") },
        config
      )
    ).toBe(false);
    expect(
      verifyActivePortableHandoffProvenance(
        {
          ...portable,
          provenance: portable.provenance && {
            ...portable.provenance,
            credentialBindingDigest: "0".repeat(64)
          }
        },
        config
      )
    ).toBe(false);
    expect(
      verifyActivePortableHandoffProvenance(
        {
          ...portable,
          provenance: portable.provenance && {
            ...portable.provenance,
            consumedAt: "2029-01-01T00:00:02.000Z"
          }
        },
        config
      )
    ).toBe(false);

    const replacement = await service.enroll(secret("pw_enroll_"), { replaceExisting: true });
    expect(replacement.provenance).toBeUndefined();
    expect((await store.read())?.active?.provenance).toBeUndefined();
    expect(verifyActivePortableHandoffProvenance(replacement, config)).toBe(false);
  });

  it("uses strict hash-only schemas and keeps legacy/setup documents compatible", async () => {
    const { config, handoff } = await setup();
    const pending = createPendingPortableHandoffProvenance(
      handoff,
      new Date("2029-01-01T00:00:00.000Z")
    );
    expect(
      pendingPortableHandoffProvenanceSchema.safeParse({ ...pending, origin: "secret" }).success
    ).toBe(false);
    expect(
      pendingPortableHandoffProvenanceSchema.safeParse({
        ...pending,
        enrollmentCode: handoff.enrollmentCode
      }).success
    ).toBe(false);
    expect(
      activePortableHandoffProvenanceSchema.safeParse({
        ...pending,
        credentialBindingDigest: "a".repeat(64),
        consumedAt: "2029-01-01T00:00:01.000Z",
        rawHandoff: handoff
      }).success
    ).toBe(false);
    expect(
      hostCredentialDocumentSchema.safeParse({
        version: "agent-host-credentials/v1",
        pending: {
          kind: "setup_code",
          enrollmentAttemptId: "attempt-setup",
          setupCode: secret("pw_setup_"),
          credentialToken: secret("pw_host_"),
          createdAt: new Date().toISOString(),
          provenance: pending
        }
      }).success
    ).toBe(false);
    const legacy = hostCredentialDocumentSchema.parse({
      version: "agent-host-credentials/v1",
      active: {
        hostId: "host-legacy",
        workspaceId: handoff.workspaceId,
        credentialToken: secret("pw_host_"),
        issuedAt: "2029-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    });
    expect(legacy.active?.provenance).toBeUndefined();
    expect(legacy.active && verifyActivePortableHandoffProvenance(legacy.active, config)).toBe(
      false
    );
  });

  it("enrolls server-scoped fleet handoffs without workspace binding", async () => {
    const { config, encodedHandoff, store } = await setupFleet();
    const active = await new AgentHostEnrollmentService(
      config,
      store,
      successfulFleetExchange(),
      () => new Date("2029-01-01T00:00:00.000Z")
    ).enrollPortableHandoff(encodedHandoff);

    expect(active.workspaceId).toBeUndefined();
    expect(active.provenance).toMatchObject({ kind: "portable_handoff" });
    expect(verifyActivePortableHandoffProvenance(active, config)).toBe(true);
  });
});
