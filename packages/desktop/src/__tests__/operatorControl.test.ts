import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleSetupCodeIssueResponse } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { parseCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import {
  parseAgentHostSetupHandoff,
  serializeAgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import {
  OPERATOR_CONTROL_JSON_BODY_MAX_BYTES,
  OperatorControlClient
} from "../main/operatorControl/OperatorControlClient.js";
import {
  OperatorCredentialVault,
  type OperatorSafeStoragePort
} from "../main/operatorControl/operatorCredentialVault.js";
import { parseAgentHostHandoffInput } from "../main/operatorControl/localAgentHostHandoff.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import {
  assertNoSmuggledOperatorSecrets,
  operatorControlProfileSchema,
  operatorImportCredentialInputSchema
} from "../shared/operatorControl.js";

const tokenA = "operator_a_token_abcdefghijklmnopqrstuvwxyz_1234";
const tokenB = "operator_b_token_abcdefghijklmnopqrstuvwxyz_1234";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function safeStorage(available: boolean): OperatorSafeStoragePort {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8")
  };
}

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

const profile = (profileId: string, serverBaseUrl = "https://operator.example.test/") => ({
  profileId,
  displayName: profileId,
  serverBaseUrl,
  allowInsecureTransport: false
});

describe("Desktop operator control trust boundary", () => {
  it("keeps credential material out of the renderer import contract", () => {
    expect(operatorImportCredentialInputSchema.parse({ profileId: "profile-a" })).toEqual({
      profileId: "profile-a"
    });
    expect(() =>
      operatorImportCredentialInputSchema.parse({
        profileId: "profile-a",
        operatorToken: tokenA
      })
    ).toThrow();
  });

  it("rejects cyclic, deeply nested, and oversized IPC payloads without recursion", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertNoSmuggledOperatorSecrets(cyclic, "cyclic")).toThrow(/cyclic/);

    let deeplyNested: Record<string, unknown> = {};
    const root = deeplyNested;
    for (let depth = 0; depth < 20; depth += 1) {
      const next: Record<string, unknown> = {};
      deeplyNested.next = next;
      deeplyNested = next;
    }
    expect(() => assertNoSmuggledOperatorSecrets(root, "deep")).toThrow(/too deep/);

    expect(() =>
      assertNoSmuggledOperatorSecrets(
        { values: Array.from({ length: 300 }, (_, index) => ({ index })) },
        "large"
      )
    ).toThrow(/too many/);
  });

  it("allows a declared root command while still rejecting nested transport escapes", () => {
    expect(() =>
      assertNoSmuggledOperatorSecrets(
        {
          profileId: "profile-a",
          command: { schemaVersion: "remote-run/v3", projectId: "project-a" }
        },
        "dispatchOwnerFleetRemoteOperation",
        { allowedRootFields: ["command"] }
      )
    ).not.toThrow();
    expect(() =>
      assertNoSmuggledOperatorSecrets(
        {
          profileId: "profile-a",
          command: {
            schemaVersion: "remote-run/v3",
            projectId: "project-a",
            transport: { path: "/tmp/smuggled-credential" }
          }
        },
        "dispatchOwnerFleetRemoteOperation",
        { allowedRootFields: ["command"] }
      )
    ).toThrow(/field "path" is not allowed/);
  });

  it("uses safeStorage or explicit session-only persistence without plaintext", async () => {
    const directory = await root("planweave-operator-vault-");
    const durablePath = join(directory, "credentials.json");
    const durable = new OperatorCredentialVault({
      paths: { credentialsPath: durablePath },
      safeStorage: safeStorage(true)
    });
    expect(await durable.setOperatorToken("profile-a", tokenA)).toBe("persisted");
    const raw = await readFile(durablePath, "utf8");
    expect(raw).not.toContain(tokenA);
    expect(raw).toContain("encryptedOperatorToken");
    expect(await durable.getOperatorToken("profile-a")).toBe(tokenA);

    const sessionPath = join(directory, "session.json");
    const session = new OperatorCredentialVault({
      paths: { credentialsPath: sessionPath },
      safeStorage: safeStorage(false)
    });
    expect(await session.setOperatorToken("profile-a", tokenA)).toBe("session-only");
    expect(await session.getOperatorToken("profile-a")).toBe(tokenA);
    await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps profiles non-secret and rejects renderer secret smuggling", async () => {
    const directory = await root("planweave-operator-profile-");
    const store = new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") });
    await store.upsert(profile("profile-a"));
    const raw = await readFile(join(directory, "profiles.json"), "utf8");
    expect(raw).not.toContain("operatorToken");
    expect(() =>
      assertNoSmuggledOperatorSecrets(
        { profileId: "profile-a", request: { headers: { Authorization: `Bearer ${tokenA}` } } },
        "test"
      )
    ).toThrow(/not allowed/);
    expect(() =>
      operatorControlProfileSchema.parse({ ...profile("profile-b"), operatorToken: tokenA })
    ).toThrow();
    expect(() =>
      assertNoSmuggledOperatorSecrets(
        {
          ...profile("profile-b"),
          endpoint: {
            topology: "public_https",
            serverOrigin: "https://other.example",
            allowedClientOrigins: ["https://other.example"],
            tlsTrust: "system_ca"
          }
        },
        "upsertOperatorProfile"
      )
    ).toThrow(/endpoint/);
  });

  it.each([
    ["tailscale_https", "https://planweave.example-tailnet.ts.net/"],
    ["lan_https", "https://192.168.1.20:7443/"]
  ] as const)("migrates legacy operator %s endpoints to private HTTPS", async (topology, serverOrigin) => {
    const directory = await root("planweave-operator-topology-migration-");
    const profilesPath = join(directory, "profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        version: 1,
        activeProfileId: "private-server",
        profiles: [
          {
            profileId: "private-server",
            displayName: "Private server",
            serverBaseUrl: serverOrigin,
            allowInsecureTransport: false,
            endpoint: {
              topology,
              serverOrigin,
              allowedClientOrigins: [serverOrigin],
              tlsTrust: "system_ca"
            },
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ]
      })
    );

    const document = await new OperatorProfileStore({ profilesPath }).read();

    expect(document.profiles[0]?.endpoint?.topology).toBe("private_https");
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({
      version: 1,
      activeProfileId: "private-server",
      profiles: [{ endpoint: { topology: "private_https" } }]
    });
  });

  it("rejects a renderer URL edit that conflicts with a Main-owned endpoint", async () => {
    const directory = await root("planweave-operator-endpoint-");
    const store = new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") });
    await store.upsert({
      ...profile("profile-endpoint", "https://server.example/"),
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example",
        allowedClientOrigins: ["https://server.example"],
        tlsTrust: "system_ca"
      }
    });
    const service = new OperatorControlService({ profileStore: store });
    await expect(
      service.upsertProfile(profile("profile-endpoint", "https://other.example/"))
    ).rejects.toThrow();
    await expect(store.get("profile-endpoint")).resolves.toMatchObject({
      serverBaseUrl: "https://server.example/",
      endpoint: { serverOrigin: "https://server.example" }
    });
  });

  it("publishes the first Main-owned Server as the active Host administration profile", async () => {
    const directory = await root("planweave-operator-main-owned-status-");
    const onStatusChange = vi.fn();
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({
        profilesPath: join(directory, "profiles.json")
      }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      onStatusChange
    });

    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("planweave-local-operator", "https://planweave.example.ts.net/"),
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://planweave.example.ts.net",
          allowedClientOrigins: ["https://planweave.example.ts.net"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeProfileId: "planweave-local-operator",
        profiles: [
          expect.objectContaining({
            profileId: "planweave-local-operator",
            hasOperatorCredential: true,
            endpoint: expect.objectContaining({
              serverOrigin: "https://planweave.example.ts.net"
            })
          })
        ]
      })
    );
  });

  it("preserves a Main-owned persisted endpoint when copying a Host setup handoff", async () => {
    const directory = await root("planweave-operator-host-handoff-");
    const enrollmentCode = `pw_enroll_${"A".repeat(43)}`;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://operator.example.test/api/v1/host-enrollments");
      return new Response(
        JSON.stringify({
          enrollmentCode,
          workspaceId: "workspace-1",
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        }),
        { status: 201 }
      );
    });
    const profilesPath = join(directory, "profiles.json");
    const credentialsPath = join(directory, "credentials.json");
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath },
        safeStorage: safeStorage(true)
      })
    });
    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("profile-handoff"),
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://operator.example.test",
          allowedClientOrigins: ["https://operator.example.test"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });
    const restartedService = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath },
        safeStorage: safeStorage(true)
      }),
      request
    });
    const copyText = vi.fn();

    const view = await restartedService.copyHostBootstrapHandoff(
      {
        profileId: "profile-handoff",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        }
      },
      copyText
    );

    const command = copyText.mock.calls[0]?.[0] ?? "";
    const handoff = parseAgentHostSetupHandoff(
      command.slice("planweave agent-host enroll ".length)
    );
    expect(handoff.endpoint).toEqual({
      topology: "public_https",
      serverOrigin: "https://operator.example.test",
      allowedClientOrigins: ["https://operator.example.test"],
      tlsTrust: "system_ca"
    });
    expect(handoff.enrollmentCode).toBe(enrollmentCode);
    expect(view.commandPreview).toBe("planweave agent-host enroll <handoff>");
    await expect(restartedService.getStatus()).resolves.toMatchObject({
      profiles: [
        {
          profileId: "profile-handoff",
          endpoint: { serverOrigin: "https://operator.example.test" }
        }
      ]
    });
  });

  it("keeps the public Host endpoint while local Operator HTTP uses loopback", async () => {
    const directory = await root("planweave-operator-local-handoff-");
    const enrollmentCode = `pw_enroll_${"L".repeat(43)}`;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:50653/api/v1/host-enrollments");
      return new Response(
        JSON.stringify({
          enrollmentCode,
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        }),
        { status: 201 }
      );
    });
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({
        profilesPath: join(directory, "profiles.json")
      }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      request,
      localOperatorBackend: {
        getSnapshot: () => ({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:50653/",
          advertisedOrigin: "https://owner-device.example.ts.net/"
        }),
        whenRunning: vi.fn()
      }
    });
    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("planweave-local-loopback", "https://owner-device.example.ts.net/"),
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://owner-device.example.ts.net",
          allowedClientOrigins: ["https://owner-device.example.ts.net"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });
    const copyText = vi.fn();

    await service.copyHostBootstrapHandoff(
      {
        profileId: "planweave-local-loopback",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        }
      },
      copyText
    );

    const command = copyText.mock.calls[0]?.[0] ?? "";
    const handoff = parseAgentHostSetupHandoff(
      command.slice("planweave agent-host enroll ".length)
    );
    expect(handoff.endpoint).toEqual({
      topology: "private_https",
      serverOrigin: "https://owner-device.example.ts.net",
      allowedClientOrigins: ["https://owner-device.example.ts.net"],
      tlsTrust: "system_ca"
    });
  });

  it("redeems a local Host handoff entirely in main and returns only redacted status", async () => {
    const directory = await root("planweave-operator-local-host-");
    const enrollmentCode = `pw_enroll_${"B".repeat(43)}`;
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            enrollmentCode,
            workspaceId: "workspace-local",
            expiresAt: "2030-01-01T00:15:00.000Z",
            credentialExpiresAt: "2030-06-30T00:00:00.000Z",
            credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
          }),
          { status: 201 }
        )
    );
    const register = vi.fn().mockResolvedValue({
      supported: true,
      state: "ready",
      workspaceId: "workspace-local",
      background: "running",
      agents: []
    });
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      request,
      localAgentHost: {
        status: vi.fn().mockResolvedValue({ supported: true, state: "not_registered", agents: [] }),
        repair: vi.fn(),
        register
      }
    });
    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("profile-local"),
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://operator.example.test",
          allowedClientOrigins: ["https://operator.example.test"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });

    const result = await service.registerLocalAgentHost({
      profileId: "profile-local",
      request: {
        expiresAt: "2030-01-01T00:15:00.000Z",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      },
      exposedProfileIds: ["codex-acp"]
    });

    expect(register).toHaveBeenCalledWith(
      "profile-local",
      expect.stringMatching(/^planweave-agent-host-setup:/),
      ["codex-acp"]
    );
    expect(JSON.stringify(result)).not.toMatch(/enrollmentCode|credentialToken|configPath/);
    const localHandoff = parseAgentHostSetupHandoff(String(register.mock.calls[0]?.[1]));
    expect(localHandoff.enrollmentCode).toBe(enrollmentCode);

    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("profile-local"),
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://operator.example.test",
          allowedClientOrigins: ["https://operator.example.test"],
          tlsTrust: "configured_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });
    await expect(
      service.registerLocalAgentHost({
        profileId: "profile-local",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        },
        exposedProfileIds: ["codex-acp"]
      })
    ).rejects.toThrow("local_agent_host_custom_ca_unsupported");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("accepts a raw or copied Host command through the bounded enrollment contract", async () => {
    const encodedHandoff = serializeAgentHostSetupHandoff({
      version: "agent-host-setup/v2",
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net",
        allowedClientOrigins: ["https://planweave.example.ts.net"],
        tlsTrust: "system_ca"
      },
      workspaceId: "workspace-clipboard",
      enrollmentCode: `pw_enroll_${"C".repeat(43)}`,
      expiresAt: "2030-01-01T00:15:00.000Z",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      display: { workspaceName: "Workspace", serverName: "Server" }
    });
    expect(parseAgentHostHandoffInput(encodedHandoff)).toMatchObject({
      encodedHandoff,
      handoff: { workspaceId: "workspace-clipboard" }
    });
    expect(
      parseAgentHostHandoffInput(`planweave agent-host enroll ${encodedHandoff}`)
    ).toMatchObject({ encodedHandoff });
    expect(() => parseAgentHostHandoffInput("planweave agent-host enroll ")).toThrow(
      "local_agent_host_handoff_invalid"
    );
    const expiredHandoff = serializeAgentHostSetupHandoff({
      ...parseAgentHostSetupHandoff(encodedHandoff, new Date("2029-01-01T00:00:00.000Z")),
      expiresAt: "2020-01-01T00:00:00.000Z"
    });
    expect(() => parseAgentHostHandoffInput(expiredHandoff)).toThrow(
      "local_agent_host_handoff_expired"
    );

    const register = vi.fn().mockResolvedValue({
      supported: true,
      state: "ready",
      workspaceId: "workspace-clipboard",
      background: "running",
      agents: []
    });
    const service = new OperatorControlService({
      localAgentHost: {
        status: vi.fn().mockResolvedValue({ supported: true, state: "not_registered", agents: [] }),
        repair: vi.fn(),
        register
      }
    });
    const result = await service.enrollLocalAgentHost({
      handoff: `planweave agent-host enroll ${encodedHandoff}`,
      exposedProfileIds: ["codex-acp"]
    });

    expect(register).toHaveBeenCalledWith(undefined, encodedHandoff, ["codex-acp"]);
    expect(JSON.stringify(result)).not.toMatch(/enrollmentCode|planweave-agent-host-setup:/);
    await expect(
      service.enrollLocalAgentHost({
        handoff: encodedHandoff,
        exposedProfileIds: ["codex-acp"],
        enrollmentCode: "smuggled"
      })
    ).rejects.toThrow("Operator IPC rejected enrollLocalAgentHost");
  });

  it("repairs an existing local Host without issuing another enrollment grant", async () => {
    const repair = vi.fn().mockResolvedValue({
      supported: true,
      state: "ready",
      workspaceId: "workspace-repair",
      background: "running",
      agents: []
    });
    const service = new OperatorControlService({
      localAgentHost: {
        status: vi.fn(),
        repair,
        register: vi.fn()
      }
    });

    await expect(
      service.repairLocalAgentHost({
        profileId: "profile-a",
        exposedProfileIds: ["codex-acp", "pi-acp"]
      })
    ).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-repair"
    });
    expect(repair).toHaveBeenCalledWith("profile-a", ["codex-acp", "pi-acp"]);
  });

  it("preserves a safe Agent Host error code across the operator boundary", async () => {
    const service = new OperatorControlService({
      localAgentHost: {
        status: vi.fn().mockResolvedValue({ supported: true, state: "not_registered", agents: [] }),
        repair: vi.fn(),
        register: vi.fn().mockRejectedValue(new Error("agent_host_background_service_unavailable"))
      }
    });

    await expect(
      service.enrollLocalAgentHost({
        handoff: serializeAgentHostSetupHandoff({
          version: "agent-host-setup/v2",
          endpoint: {
            topology: "private_https",
            serverOrigin: "https://server.example/",
            allowedClientOrigins: ["https://server.example/"],
            tlsTrust: "system_ca"
          },
          workspaceId: "workspace-diagnostics",
          enrollmentCode: `pw_enroll_${"D".repeat(43)}`,
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
          display: { workspaceName: "Workspace", serverName: "Server" }
        }),
        exposedProfileIds: ["codex-acp"]
      })
    ).rejects.toMatchObject({
      name: "OperatorControlError",
      code: "agent_host_background_service_unavailable",
      message: "agent_host_background_service_unavailable"
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      lastErrorCode: "agent_host_background_service_unavailable"
    });
  });

  it("uses only bounded application endpoints and maps 401/403/malformed responses", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization")
      });
      const url = String(input);
      if (url.includes("/api/v1/agent-endpoints")) {
        return new Response(
          JSON.stringify({ schemaVersion: "agent-endpoint-list/v1", items: [] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    });
    const client = new OperatorControlClient({
      profile: profile("profile-a"),
      credential: { getOperatorToken: () => tokenA },
      request
    });
    await expect(client.listHosts({ cursor: 0, limit: 100 })).resolves.toEqual({
      items: [],
      nextCursor: null
    });
    await expect(client.listAgentEndpoints()).resolves.toEqual({
      schemaVersion: "agent-endpoint-list/v1",
      items: []
    });
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/hosts?cursor=0&limit=100"),
      authorization: `Bearer ${tokenA}`
    });
    expect(requests[1]).toMatchObject({
      url: expect.stringContaining("/api/v1/agent-endpoints"),
      authorization: `Bearer ${tokenA}`
    });

    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "operator_unauthorized" }), { status: 401 })
    );
    await expect(client.listHosts()).rejects.toMatchObject({
      kind: "unauthorized",
      httpStatus: 401,
      code: "operator_unauthorized"
    });
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "operator_admin_required" }), { status: 403 })
    );
    await expect(client.listHosts()).rejects.toMatchObject({ kind: "forbidden", httpStatus: 403 });
    request.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(client.listHosts()).rejects.toMatchObject({ code: "operator_malformed_json" });
    expect(JSON.stringify(requests)).toContain(tokenA);
  });

  it("replays Owner fleet ACP events through the Operator API", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://operator.example.test/api/v1/remote-operations/operation-owner-001/events?afterCursor=7"
      );
      return new Response(
        JSON.stringify({
          executionAttemptId: "attempt-owner-001",
          afterCursor: 7,
          cursor: 9,
          highWatermark: 9,
          hasMore: false,
          events: [],
          diagnostics: []
        }),
        { status: 200 }
      );
    });
    const client = new OperatorControlClient({
      profile: profile("profile-a"),
      credential: { getOperatorToken: () => tokenA },
      request
    });

    await expect(client.replayRemoteOperationEvents("operation-owner-001", 7)).resolves.toEqual(
      expect.objectContaining({ afterCursor: 7, cursor: 9, events: [] })
    );
  });

  it("requests one Host credential renewal through the fixed operator endpoint", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://operator.example.test/api/v1/hosts/host-1/credential-renewal"
      );
      expect(init).toMatchObject({ method: "POST", body: "{}" });
      return new Response(
        JSON.stringify({
          id: "host-1",
          displayName: "Host 1",
          capabilities: [],
          capacity: 1,
          online: true,
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
          credentialRenewalRequestedAt: "2030-01-01T00:00:00.000Z",
          availability: { status: "unavailable", reason: "readiness_not_reported" }
        }),
        { status: 202 }
      );
    });
    const client = new OperatorControlClient({
      profile: profile("profile-a"),
      credential: { getOperatorToken: () => tokenA },
      request
    });

    await expect(client.requestHostCredentialRenewal("host-1")).resolves.toMatchObject({
      id: "host-1",
      credentialRenewalRequestedAt: "2030-01-01T00:00:00.000Z"
    });
  });

  it("routes local-owned Operator HTTP through loopback instead of Tailscale origin", async () => {
    const directory = await root("planweave-operator-loopback-");
    const seenBases: string[] = [];
    const createClient = vi.fn(
      (options: ConstructorParameters<typeof OperatorControlClient>[0]) => {
        seenBases.push(options.profile.serverBaseUrl);
        return new OperatorControlClient({
          ...options,
          request: vi.fn(
            async () =>
              new Response(JSON.stringify({ schemaVersion: "agent-endpoint-list/v1", items: [] }), {
                status: 200
              })
          )
        });
      }
    );
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      createClient,
      localOperatorBackend: {
        getSnapshot: () => ({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:50653/",
          advertisedOrigin: "https://owner-device.example.ts.net/"
        }),
        whenRunning: vi.fn()
      }
    });
    await service.upsertProfile(
      profile("planweave-local-loopback", "https://owner-device.example.ts.net/")
    );
    await service.importCredential({
      profileId: "planweave-local-loopback",
      operatorToken: tokenA
    });

    await expect(
      service.listAgentEndpoints({ profileId: "planweave-local-loopback" })
    ).resolves.toEqual({ schemaVersion: "agent-endpoint-list/v1", items: [] });
    expect((await service.getStatus()).profiles[0]?.hostedByThisDesktop).toBe(true);
    expect(seenBases).toEqual(["http://127.0.0.1:50653/"]);
  });

  it("publishes local server readiness failures and clears them after the server returns", async () => {
    const directory = await root("planweave-operator-local-readiness-");
    const onStatusChange = vi.fn();
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      onStatusChange,
      localOperatorBackend: {
        getSnapshot: () => ({
          running: false,
          loopbackBaseUrl: null,
          advertisedOrigin: null
        }),
        whenRunning: vi.fn().mockRejectedValue(new Error("operator_local_server_not_ready"))
      }
    });
    await service.upsertProfile(
      profile("planweave-local-loopback", "https://owner-device.example.ts.net/")
    );
    await service.importCredential({
      profileId: "planweave-local-loopback",
      operatorToken: tokenA
    });
    onStatusChange.mockClear();

    await expect(
      service.listAgentEndpoints({ profileId: "planweave-local-loopback" })
    ).rejects.toMatchObject({ code: "operator_local_server_not_ready" });
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastErrorCode: "operator_local_server_not_ready" })
    );

    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("planweave-local-loopback", "https://owner-device.example.ts.net/"),
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://owner-device.example.ts.net",
          allowedClientOrigins: ["https://owner-device.example.ts.net"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastErrorCode: null })
    );
  });

  it("keeps remote Operator profiles on their persisted serverBaseUrl", async () => {
    const directory = await root("planweave-operator-remote-no-bypass-");
    const seenBases: string[] = [];
    const createClient = vi.fn(
      (options: ConstructorParameters<typeof OperatorControlClient>[0]) => {
        seenBases.push(options.profile.serverBaseUrl);
        return new OperatorControlClient({
          ...options,
          request: vi.fn(
            async () =>
              new Response(JSON.stringify({ schemaVersion: "agent-endpoint-list/v1", items: [] }), {
                status: 200
              })
          )
        });
      }
    );
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      createClient,
      localOperatorBackend: {
        getSnapshot: () => ({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:50653/",
          advertisedOrigin: "https://owner-device.example.ts.net/"
        }),
        whenRunning: vi.fn()
      }
    });
    await service.upsertProfile(profile("profile-remote", "https://remote-operator.example/"));
    await service.importCredential({ profileId: "profile-remote", operatorToken: tokenA });

    await expect(service.listAgentEndpoints({ profileId: "profile-remote" })).resolves.toEqual({
      schemaVersion: "agent-endpoint-list/v1",
      items: []
    });
    expect((await service.getStatus()).profiles[0]?.hostedByThisDesktop).toBe(false);
    expect(seenBases).toEqual(["https://remote-operator.example/"]);
  });

  it("copies a member setup code in main and returns only redacted handoff metadata", async () => {
    const directory = await root("planweave-operator-member-setup-");
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://operator.example.test/api/v1/setup-codes");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session"
      });
      return new Response(JSON.stringify(exampleSetupCodeIssueResponse), { status: 201 });
    });
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(false)
      }),
      request,
      clock: { now: () => new Date("2030-01-01T00:02:00.000Z") }
    });
    await service.upsertProfile(profile("profile-a"));
    await service.importCredential({ profileId: "profile-a", operatorToken: tokenA });
    const copyText = vi.fn();

    const handoff = await service.copyMemberSetupCode({ profileId: "profile-a" }, copyText);

    expect(parseCollaborationSetupHandoffV1(copyText.mock.calls[0]?.[0] ?? "")).toEqual({
      serverBaseUrl: "https://operator.example.test/",
      setupCode: exampleSetupCodeIssueResponse.setupCode,
      allowInsecureTransport: false
    });
    expect(handoff).toEqual({
      state: "ready",
      workspaceId: exampleSetupCodeIssueResponse.grant.workspaceId,
      expiresAt: exampleSetupCodeIssueResponse.grant.expiresAt,
      copiedAt: "2030-01-01T00:02:00.000Z"
    });
    expect(JSON.stringify(handoff)).not.toContain(exampleSetupCodeIssueResponse.setupCode);
    await expect(
      service.copyMemberSetupCode({ profileId: "profile-a" }, () => {
        throw new Error("clipboard_unavailable");
      })
    ).rejects.toThrow("clipboard_unavailable");
    await expect(
      service.copyMemberSetupCode(
        { profileId: "profile-a", setupCode: exampleSetupCodeIssueResponse.setupCode },
        copyText
      )
    ).rejects.toThrow("Operator IPC rejected copyMemberSetupCode");
  });

  it("stops reading declared and chunked responses at the byte limit", async () => {
    const request = vi.fn<typeof fetch>();
    const client = new OperatorControlClient({
      profile: profile("profile-a"),
      credential: { getOperatorToken: () => tokenA },
      request
    });
    request.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "content-length": String(OPERATOR_CONTROL_JSON_BODY_MAX_BYTES + 1) }
      })
    );
    await expect(client.listHosts()).rejects.toMatchObject({
      code: "operator_response_too_large"
    });

    let canceled = false;
    const oversizedChunk = new Uint8Array(40 * 1024);
    request.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(oversizedChunk);
          },
          cancel() {
            canceled = true;
          }
        }),
        { status: 200 }
      )
    );
    await expect(client.listHosts()).rejects.toMatchObject({
      code: "operator_response_too_large"
    });
    expect(canceled).toBe(true);
  });

  it("isolates profile credentials in the main service", async () => {
    const directory = await root("planweave-operator-isolation-");
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status:
            init?.headers && new Headers(init.headers).get("authorization") === `Bearer ${tokenA}`
              ? 200
              : 200
        })
    );
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(false)
      }),
      safeStorage: safeStorage(false),
      request
    });
    await service.upsertProfile(profile("profile-a"));
    await service.upsertProfile(profile("profile-b"));
    await service.importCredential({ profileId: "profile-a", operatorToken: tokenA });
    await service.importCredential({ profileId: "profile-b", operatorToken: tokenB });
    await service.listHosts({ profileId: "profile-a" });
    await service.listHosts({ profileId: "profile-b" });
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${tokenA}`
    );
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${tokenB}`
    );
    const status = await service.getStatus();
    expect(JSON.stringify(status)).not.toContain(tokenA);
    expect(JSON.stringify(status)).not.toContain(tokenB);
  });

  it("reuses a persisted self-host deployment credential for repeat exports", async () => {
    const directory = await root("planweave-operator-deployment-");
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      })
    });
    const first = await service.ensureDeploymentProfile({
      profile: profile("deployment-server", "https://collab.example.test/"),
      operatorId: "desktop-self-host-admin"
    });
    const second = await service.ensureDeploymentProfile({
      profile: {
        ...profile("deployment-server", "https://collab.example.test/"),
        displayName: "Updated"
      },
      operatorId: "desktop-self-host-admin"
    });
    expect(second).toBe(first);
    await expect(service.getStatus()).resolves.toMatchObject({
      profiles: [
        {
          profileId: "deployment-server",
          displayName: "Updated",
          hasOperatorCredential: true,
          operatorCredentialPersistence: "persisted"
        }
      ]
    });
  });

  it("removes a new deployment credential when its profile cannot be persisted", async () => {
    const directory = await root("planweave-operator-deployment-rollback-");
    const vault = new OperatorCredentialVault({
      paths: { credentialsPath: join(directory, "credentials.json") },
      safeStorage: safeStorage(true)
    });
    const store = new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") });
    vi.spyOn(store, "upsert").mockRejectedValueOnce(new Error("profile_store_failed"));
    const service = new OperatorControlService({ profileStore: store, vault });
    await expect(
      service.ensureDeploymentProfile({
        profile: profile("deployment-rollback", "https://collab.example.test/"),
        operatorId: "desktop-self-host-admin"
      })
    ).rejects.toThrow("profile_store_failed");
    expect(await vault.persistenceFor("deployment-rollback")).toBe("missing");
  });

  it("accepts loopback HTTP only when explicitly enabled", () => {
    expect(
      () =>
        new OperatorControlClient({
          profile: profile("p", "http://127.0.0.1:8080/"),
          credential: { getOperatorToken: () => tokenA }
        })
    ).toThrow();
    expect(
      () =>
        new OperatorControlClient({
          profile: { ...profile("p", "http://127.0.0.1:8080/"), allowInsecureTransport: true },
          credential: { getOperatorToken: () => tokenA }
        })
    ).not.toThrow();
    expect(
      () =>
        new OperatorControlClient({
          profile: { ...profile("p", "http://example.test/"), allowInsecureTransport: true },
          credential: { getOperatorToken: () => tokenA }
        })
    ).toThrow();
  });
});
