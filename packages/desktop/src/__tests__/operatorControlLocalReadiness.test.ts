/* @vitest-environment jsdom */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";
import { setLocalOperatorBackendPort } from "../main/operatorControl/localOperatorBackend.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import { useAgentEndpointCatalog } from "../renderer/hooks/useAgentEndpointCatalog.js";
import { deriveFleetCatalogBlockedCode } from "../renderer/hooks/useOwnerControlPlaneAvailability.js";

const roots: string[] = [];
const operatorToken = "operator_local_token_abcdefghijklmnopqrstuvwxyz_1234";

function profile(serverBaseUrl = "https://owner-device.example.ts.net/") {
  return {
    profileId: "planweave-local-loopback",
    displayName: "PlanWeave local server",
    serverBaseUrl,
    allowInsecureTransport: false
  };
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8")
  };
}

afterEach(async () => {
  setLocalOperatorBackendPort(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Operator control local readiness", () => {
  it("blocks the fleet catalog before the Desktop-owned Server is ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-operator-readiness-"));
    roots.push(directory);
    let running = false;
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage()
      })
    });
    setLocalOperatorBackendPort({
      getSnapshot: () => ({
        running,
        loopbackBaseUrl: running ? "http://127.0.0.1:50653/" : null,
        advertisedOrigin: running ? "https://owner-device.example.ts.net/" : null
      }),
      whenRunning: vi.fn()
    });
    await service.upsertProfile(profile());
    await service.importCredential({
      profileId: "planweave-local-loopback",
      operatorToken
    });
    await service.setActiveProfile({ profileId: "planweave-local-loopback" });

    const status = await service.getStatus();

    expect(status.profiles[0]?.hostedByThisDesktop).toBe(true);
    expect(status.lastErrorCode).toBe("operator_local_server_not_ready");
    expect(deriveFleetCatalogBlockedCode(status, { bridgeAvailable: true })).toBe(
      "operator_local_server_not_ready"
    );
    const listOperatorAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: []
    }));
    const { rerender } = renderHook(
      ({ blockedCode }) =>
        useAgentEndpointCatalog({
          enabled: blockedCode === null,
          fleetCatalogBlockedCode: blockedCode,
          fleetApi: { listOperatorAgentEndpoints },
          logicalExecutors: [],
          operatorProfileId: "planweave-local-loopback"
        }),
      {
        initialProps: {
          blockedCode: deriveFleetCatalogBlockedCode(status, { bridgeAvailable: true })
        }
      }
    );
    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).not.toHaveBeenCalled();

    running = true;
    const readyStatus = await service.getStatus();
    expect(readyStatus.lastErrorCode).toBeNull();
    const readyBlockedCode = deriveFleetCatalogBlockedCode(readyStatus, {
      bridgeAvailable: true
    });
    expect(readyBlockedCode).toBeNull();
    rerender({ blockedCode: readyBlockedCode });
    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).toHaveBeenCalledTimes(1);
  });

  it("routes a ready Desktop-owned profile through its loopback backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-operator-loopback-"));
    roots.push(directory);
    const seenBases: string[] = [];
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage()
      }),
      createClient: (options) => {
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
      },
      localOperatorBackend: {
        getSnapshot: () => ({
          running: true,
          loopbackBaseUrl: "http://127.0.0.1:50653/",
          advertisedOrigin: "https://owner-device.example.ts.net/"
        }),
        whenRunning: vi.fn()
      }
    });
    await service.upsertProfile(profile());
    await service.importCredential({
      profileId: "planweave-local-loopback",
      operatorToken
    });

    await expect(
      service.listAgentEndpoints({ profileId: "planweave-local-loopback" })
    ).resolves.toEqual({ schemaVersion: "agent-endpoint-list/v1", items: [] });
    expect((await service.getStatus()).profiles[0]?.hostedByThisDesktop).toBe(true);
    expect(seenBases).toEqual(["http://127.0.0.1:50653/"]);
  });

  it("publishes a readiness timeout and clears it after the backend returns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-operator-timeout-"));
    roots.push(directory);
    let running = false;
    const onStatusChange = vi.fn();
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage()
      }),
      onStatusChange,
      localOperatorBackend: {
        getSnapshot: () => ({
          running,
          loopbackBaseUrl: running ? "http://127.0.0.1:50653/" : null,
          advertisedOrigin: running ? "https://owner-device.example.ts.net/" : null
        }),
        whenRunning: vi.fn().mockRejectedValue(new Error("operator_local_server_not_ready"))
      }
    });
    await service.upsertProfile(profile());
    await service.importCredential({
      profileId: "planweave-local-loopback",
      operatorToken
    });
    onStatusChange.mockClear();

    await expect(
      service.listAgentEndpoints({ profileId: "planweave-local-loopback" })
    ).rejects.toMatchObject({ code: "operator_local_server_not_ready" });
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastErrorCode: "operator_local_server_not_ready" })
    );

    running = true;
    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile(),
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://owner-device.example.ts.net",
          allowedClientOrigins: ["https://owner-device.example.ts.net"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken
    });
    expect(onStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastErrorCode: null })
    );
  });
});
