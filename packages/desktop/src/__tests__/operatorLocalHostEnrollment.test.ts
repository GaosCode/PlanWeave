import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { serializeAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";
import type { OperatorRegisterLocalAgentHostInput } from "../shared/operatorControl.js";

const roots: string[] = [];
const services: OperatorControlService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const endpoint = {
  topology: "public_https" as const,
  serverOrigin: "https://enrollment.example.test",
  allowedClientOrigins: ["https://enrollment.example.test"],
  tlsTrust: "system_ca" as const
};
const input: OperatorRegisterLocalAgentHostInput = {
  profileId: "profile-enrollment",
  request: {
    expiresAt: "2030-01-01T00:15:00.000Z",
    ownerHumanPrincipalId: "owner-a",
    accessMode: "unrestricted",
    credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
  },
  exposedProfileIds: ["codex-acp"]
};
const ready = { supported: true, state: "ready" as const, agents: [] };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-desktop-enrollment-"));
  roots.push(directory);
  let grants = 0;
  const register = vi.fn().mockResolvedValue(ready);
  const profile = {
    profileId: input.profileId,
    displayName: "Enrollment",
    serverBaseUrl: endpoint.serverOrigin,
    allowInsecureTransport: false,
    endpoint
  };
  const service = new OperatorControlService({
    resolveHumanIdentityCredential: async () => ({
      humanPrincipalId: "owner-a",
      identityToken: exampleHumanIdentityToken
    }),
    profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
    vault: new OperatorCredentialVault({
      paths: { credentialsPath: join(directory, "credentials.json") },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      }
    }),
    request: async () =>
      new Response(
        JSON.stringify({
          enrollmentCode: `pw_enroll_${String(++grants).padStart(43, "a")}`,
          expiresAt: input.request.expiresAt,
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: input.request.credentialPolicy
        }),
        { status: 201 }
      ),
    localAgentHost: {
      status: async () => ({ supported: true, state: "not_registered", agents: [] }),
      register,
      repair: async () => ready
    }
  });
  services.push(service);
  await service.ensureMainOwnedServerProfile({
    profile,
    operatorId: "operator-a",
    operatorToken: `pw_operator_${"a".repeat(43)}`
  });
  return { service, register, profile, grants: () => grants };
}

describe("one-click local Host enrollment retry authority", () => {
  it.each([
    "timeout",
    "canceled",
    "exchange_failed",
    "response_malformed",
    "response_too_large"
  ])("retains a %s unknown outcome and clears the attempt after successful retry", async (code) => {
    const fixture = await setup();
    fixture.register.mockRejectedValueOnce(new Error(`agent_host_enrollment_${code}`));
    await expect(fixture.service.registerLocalAgentHost(input)).rejects.toMatchObject({
      code: `agent_host_enrollment_${code}`
    });
    await expect(
      fixture.service.registerLocalAgentHost({
        ...input,
        request: { ...input.request, expiresAt: "2030-01-01T00:16:00.000Z" },
        exposedProfileIds: ["claude-acp"]
      })
    ).resolves.toEqual(ready);
    expect(fixture.grants()).toBe(1);
    expect(fixture.register.mock.calls[1]?.[1]).toBe(fixture.register.mock.calls[0]?.[1]);
    expect(fixture.register.mock.calls[1]?.[2]).toEqual(["claude-acp"]);
    await fixture.service.registerLocalAgentHost(input);
    expect(fixture.grants()).toBe(2);
  });

  it("does not reuse a grant after a confirmed Server rejection", async () => {
    const fixture = await setup();
    fixture.register.mockRejectedValueOnce(new Error("agent_host_enrollment_rejected"));
    await expect(fixture.service.registerLocalAgentHost(input)).rejects.toMatchObject({
      code: "agent_host_enrollment_rejected"
    });
    await fixture.service.registerLocalAgentHost(input);
    expect(fixture.grants()).toBe(2);
    expect(fixture.register.mock.calls[1]?.[1]).not.toBe(fixture.register.mock.calls[0]?.[1]);
  });

  it.each([
    { name: "owner", request: { ...input.request, ownerHumanPrincipalId: "owner-b" } },
    {
      name: "workspace",
      request: {
        ...input.request,
        workspaceId: "workspace-b",
        accessMode: "workspace_restricted" as const,
        createWorkspaceGrant: true
      }
    },
    {
      name: "credential policy",
      request: {
        ...input.request,
        credentialPolicy: { lifetimeDays: 365 as const, renewal: "automatic" as const }
      }
    }
  ])("rejects $name changes without overwriting an unknown pending registration", async ({
    request
  }) => {
    const fixture = await setup();
    fixture.register.mockRejectedValueOnce(new Error("agent_host_enrollment_timeout"));
    await expect(fixture.service.registerLocalAgentHost(input)).rejects.toMatchObject({
      code: "agent_host_enrollment_timeout"
    });
    await expect(fixture.service.registerLocalAgentHost({ ...input, request })).rejects.toThrow(
      "agent_host_handoff_pending_conflict"
    );
    expect(fixture.grants()).toBe(1);
    expect(fixture.register).toHaveBeenCalledTimes(1);
    await fixture.service.registerLocalAgentHost(input);
    expect(fixture.register.mock.calls[1]?.[1]).toBe(fixture.register.mock.calls[0]?.[1]);
  });

  it.each([
    "server",
    "credential"
  ])("refuses to recover under a changed %s authority", async (change) => {
    const fixture = await setup();
    fixture.register.mockRejectedValueOnce(new Error("agent_host_enrollment_timeout"));
    await expect(fixture.service.registerLocalAgentHost(input)).rejects.toMatchObject({
      code: "agent_host_enrollment_timeout"
    });
    if (change === "server") {
      await fixture.service.ensureMainOwnedServerProfile({
        profile: {
          ...fixture.profile,
          serverBaseUrl: "https://other.example.test",
          endpoint: {
            ...endpoint,
            serverOrigin: "https://other.example.test",
            allowedClientOrigins: ["https://other.example.test"]
          }
        },
        operatorId: "operator-a",
        operatorToken: `pw_operator_${"a".repeat(43)}`
      });
    } else {
      await fixture.service.importCredential({
        profileId: input.profileId,
        operatorId: "operator-b",
        operatorToken: `pw_operator_${"b".repeat(43)}`
      });
    }
    await expect(fixture.service.registerLocalAgentHost(input)).rejects.toThrow(
      "agent_host_handoff_pending_conflict"
    );
    expect(fixture.register).toHaveBeenCalledTimes(1);
    expect(fixture.grants()).toBe(1);
  });

  it("keeps explicit fresh handoff enrollment available and retires the automatic retry on success", async () => {
    const fixture = await setup();
    fixture.register.mockRejectedValueOnce(new Error("agent_host_enrollment_timeout"));
    await expect(fixture.service.registerLocalAgentHost(input)).rejects.toThrow(
      "agent_host_enrollment_timeout"
    );
    const handoff = serializeAgentHostSetupHandoff({
      version: "agent-host-setup/v2",
      endpoint,
      enrollmentCode: `pw_enroll_${"f".repeat(43)}`,
      expiresAt: input.request.expiresAt,
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: input.request.credentialPolicy,
      display: { workspaceName: "Fleet", serverName: "Server" }
    });
    await fixture.service.enrollLocalAgentHost({ handoff, exposedProfileIds: ["codex-acp"] });
    expect(fixture.register.mock.calls[1]?.[1]).toBe(handoff);
    await fixture.service.registerLocalAgentHost(input);
    expect(fixture.grants()).toBe(2);
  });
});
