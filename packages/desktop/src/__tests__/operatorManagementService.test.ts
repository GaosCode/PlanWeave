import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorControlService } from "../main/operatorControl/operatorControlService";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient";
import { OperatorManagementService } from "../main/operatorControl/operatorManagementService";
import { OperatorProfileOperations } from "../main/operatorControl/operatorProfileOperations";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore";
import { redactDiagnostic } from "../main/desktopDiagnosticsLog";

const roots: string[] = [];
const services: OperatorControlService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const oldToken = `pw_operator_${"A".repeat(43)}`;
const adminToken = `pw_operator_${"B".repeat(43)}`;
const recoveryCode = `pw_recover_${"C".repeat(43)}`;
const authorization = {
  operatorId: "target-admin",
  expiresAt: "2030-02-01T00:00:00.000Z",
  renewAfter: "2030-01-22T00:00:00.000Z"
};
async function fixture(request: typeof fetch, mockDeviceEndpoints = true) {
  const root = await mkdtemp(join(tmpdir(), "management-service-"));
  roots.push(root);
  const vault = new OperatorCredentialVault({
    paths: { credentialsPath: join(root, "credentials.json") },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString()
    }
  });
  const service = new OperatorControlService({
    vault,
    request: async (url, init) => {
      const action = String(url).split("/").at(-1);
      const device = {
        deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
        deviceName: "Test computer",
        operatorId: "target-admin",
        createdAt: "2030-01-01T00:00:00Z",
        lastUsedAt: "2030-01-01T00:00:00Z",
        revokedAt: null
      };
      if (mockDeviceEndpoints && action === "device-enroll") return response(device);
      if (mockDeviceEndpoints && action === "device-refresh")
        return response({ ...authorization, deviceId: device.deviceId });
      if (mockDeviceEndpoints && action === "device-list") return response([device]);
      return request(url, init);
    },
    localOperatorBackend: null,
    profileStore: new OperatorProfileStore({ profilesPath: join(root, "profiles.json") }),
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z") }
  });
  services.push(service);
  for (const [profileId, host] of [
    ["target", "server"],
    ["other", "server"],
    ["foreign", "foreign"]
  ]) {
    await service.upsertProfile({
      profileId,
      displayName: profileId,
      serverBaseUrl: `https://${host}.example/`,
      allowInsecureTransport: false,
      operatorId: "target-admin"
    });
    await vault.setOperatorToken(
      profileId,
      profileId === "target" ? oldToken : adminToken,
      "target-admin"
    );
  }
  return { service, vault, root };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("reauthorizes through another saved same-server administrator and never exposes new tokens to renderer", async () => {
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    return new Headers(init?.headers).get("authorization") === `Bearer ${oldToken}`
      ? response({ error: "operator_unauthorized" }, 401)
      : response(authorization);
  });
  const { service, vault } = await fixture(request);
  await expect(service.listHosts({ profileId: "target" })).rejects.toThrow("operator_unauthorized");
  const result = await service.reauthorizeManagement({ profileId: "target" });
  expect((await service.getStatus()).lastErrorCode).toBeNull();
  expect(request).toHaveBeenCalledTimes(4);
  expect(
    request.mock.calls.every(([url]) => String(url).startsWith("https://server.example/"))
  ).toBe(true);
  const replacement = await vault.getOperatorToken("target");
  expect(replacement).not.toBe(oldToken);
  expect(JSON.stringify(result)).not.toContain(replacement);
  expect(await vault.getOperatorToken("other")).toBe(adminToken);
});

it("preserves old credentials on failure and retries a lost recovery response with exactly the same replacement", async () => {
  const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    response({ error: "operator_management_failed" }, 503)
  );
  const { service, vault } = await fixture(request);
  await expect(service.recoverManagement({ profileId: "target", recoveryCode })).rejects.toThrow(
    "operator_management_failed"
  );
  expect(await vault.getOperatorToken("target")).toBe(oldToken);
  request.mockImplementation(async () => response(authorization));
  await service.recoverManagement({ profileId: "target", recoveryCode });
  expect(request.mock.calls[0][1]?.body).toBe(request.mock.calls[1][1]?.body);
  expect(new Headers(request.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  expect(await vault.getOperatorToken("target")).not.toBe(oldToken);
});

it("reports no saved administrator, unsupported Server, and invalid input distinctly", async () => {
  const request = vi.fn(async () => response({ error: "operator_unauthorized" }, 401));
  const { service, vault } = await fixture(request);
  await expect(service.reauthorizeManagement({ profileId: "target" })).rejects.toThrow(
    "operator_management_recovery_required"
  );
  request.mockImplementation(async () => response({ error: "route_not_found" }, 404));
  expect((await service.getManagementAuthorization({ profileId: "target" })).errorCode).toBe(
    "operator_management_upgrade_required"
  );
  expect(() => service.recoverManagement({ profileId: "target", recoveryCode: "invalid" })).toThrow(
    "operator_recovery_invalid"
  );
  await expect(
    service.importCredential({
      profileId: "target",
      operatorToken: "invalid",
      verifyBeforeSave: true
    })
  ).rejects.toThrow("operator_import_invalid");
  expect(await vault.getOperatorToken("target")).toBe(oldToken);
  expect(redactDiagnostic(recoveryCode)).toBe("[REDACTED]");
  expect(redactDiagnostic(`pw_device_${"D".repeat(43)}`)).toBe("[REDACTED]");
});

it("automatically maintains saved authorization and stops polling on shutdown", async () => {
  const request = vi.fn(async () => response(authorization));
  const { service } = await fixture(request);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  service.startAuthorizationMaintenance();
  await vi.advanceTimersByTimeAsync(1000);
  await service.getStatus();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await service.getStatus();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6)); // Server decides whether renewal is due
  await service.shutdown();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(request).toHaveBeenCalledTimes(6);
});

it("keeps a recovered credential when the local Server reconciles its original bootstrap profile", async () => {
  const { service, vault } = await fixture(async () => response(authorization));
  await service.recoverManagement({ profileId: "target", recoveryCode });
  const recovered = await vault.getOperatorToken("target");
  await service.ensureMainOwnedServerProfile({
    profile: {
      profileId: "target",
      displayName: "Local Server",
      serverBaseUrl: "https://server.example/",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example",
        allowedClientOrigins: ["https://server.example"],
        tlsTrust: "system_ca"
      }
    },
    operatorId: "target-admin",
    operatorToken: oldToken
  });
  expect(await vault.getOperatorToken("target")).toBe(recovered);
});

it("persists a refresh retry before sending it and resumes after a lost response and process restart", async () => {
  const deviceId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
  const device = {
    deviceId,
    deviceName: "Laptop",
    operatorId: "target-admin",
    createdAt: "2030-01-01T00:00:00Z",
    lastUsedAt: "2030-01-01T00:00:00Z",
    revokedAt: null
  };
  const requests: { deviceSecret: string; newToken: string }[] = [];
  let lost = true;
  const request: typeof fetch = async (url, init) => {
    const action = String(url).split("/").at(-1);
    if (action === "maintain") return response(authorization);
    if (action === "device-enroll") return response(device);
    if (action === "device-list") return response([device]);
    if (action === "device-refresh") {
      requests.push(JSON.parse(String(init?.body)));
      if (lost) {
        lost = false;
        throw new Error("connection interrupted");
      }
      return response({ ...authorization, deviceId });
    }
    throw new Error("unexpected request");
  };
  const f = await fixture(request, false);
  expect(
    (await f.service.getManagementAuthorization({ profileId: "target" })).authorization
  ).toBeNull();
  const pending = await f.vault.getManagementDevice("target");
  expect(pending?.pendingToken).toBe(requests[0].newToken);
  const disk = await readFile(f.vault.credentialsPath, "utf8");
  expect(disk).not.toContain(requests[0].deviceSecret);
  expect(disk).not.toContain(requests[0].newToken);
  await f.service.shutdown();
  const vault = new OperatorCredentialVault({
    paths: { credentialsPath: f.vault.credentialsPath },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString()
    }
  });
  const restarted = new OperatorControlService({
    vault,
    request,
    localOperatorBackend: null,
    profileStore: new OperatorProfileStore({ profilesPath: join(f.root, "profiles.json") })
  });
  services.push(restarted);
  const view = await restarted.getManagementAuthorization({ profileId: "target" });
  expect(view.deviceId).toBe(deviceId);
  expect(view.errorCode).toBeNull();
  expect(requests[1]).toEqual(requests[0]);
  expect(await vault.getOperatorToken("target")).toBe(requests[0].newToken);
  expect(JSON.stringify(view)).not.toContain(requests[0].deviceSecret);
  expect((await vault.getManagementDevice("target"))?.pendingToken).toBeNull();
});

it("refreshes expired access from the stored device, but does not refresh on an offline check or silently replace a revoked device", async () => {
  const calls: string[] = [];
  let failure = "operator_unauthorized";
  let revoked = false;
  const deviceId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
  const request: typeof fetch = async (url) => {
    const action = String(url).split("/").at(-1)!;
    calls.push(action);
    if (action === "maintain")
      return response({ error: failure }, failure === "operator_unauthorized" ? 401 : 503);
    if (action === "device-refresh")
      return revoked
        ? response({ error: "operator_device_revoked" }, 403)
        : response({ ...authorization, deviceId });
    if (action === "device-list") return response([]);
    throw new Error("unexpected request");
  };
  const f = await fixture(request, false);
  const saved = {
    secret: `pw_device_${"D".repeat(43)}`,
    origin: "https://server.example",
    operatorId: "target-admin",
    deviceId,
    pendingToken: null
  };
  await f.vault.setManagementDevice("target", saved);
  expect(
    (await f.service.getManagementAuthorization({ profileId: "target" })).authorization
  ).toEqual(authorization);
  expect(calls).toEqual(["maintain", "device-refresh", "device-list"]);
  calls.length = 0;
  failure = "operator_offline";
  expect((await f.service.getManagementAuthorization({ profileId: "target" })).errorCode).toBe(
    "operator_offline"
  );
  expect(calls).toEqual(["maintain"]);
  calls.length = 0;
  failure = "operator_unauthorized";
  revoked = true;
  expect((await f.service.getManagementAuthorization({ profileId: "target" })).errorCode).toBe(
    "operator_device_revoked"
  );
  expect(calls).toEqual(["maintain", "device-refresh"]);
  expect((await f.vault.getManagementDevice("target"))?.secret).toBe(saved.secret);
});

it("never sends a device secret to a changed Server origin", async () => {
  const request = vi.fn(async () => response({ error: "operator_unauthorized" }, 401));
  const f = await fixture(request, false);
  const secret = `pw_device_${"D".repeat(43)}`;
  await f.vault.setManagementDevice("target", {
    secret,
    origin: "https://server.example",
    operatorId: "target-admin",
    deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
    pendingToken: null
  });
  await f.service.upsertProfile({
    profileId: "target",
    displayName: "Moved",
    serverBaseUrl: "https://changed.example/",
    allowInsecureTransport: false,
    operatorId: "target-admin"
  });
  await f.service.getManagementAuthorization({ profileId: "target" });
  expect(JSON.stringify(request.mock.calls)).not.toContain(secret);
  expect(await f.vault.getManagementDevice("target")).toBeUndefined();
});

it("does not persist device secrets when operating without encrypted storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-session-vault-"));
  roots.push(root);
  const options = { paths: { credentialsPath: join(root, "credentials.json") } };
  const vault = new OperatorCredentialVault(options);
  await vault.setOperatorToken("target", oldToken, "target-admin");
  const device = {
    secret: `pw_device_${"D".repeat(43)}`,
    origin: "https://server.example",
    operatorId: "target-admin",
    deviceId: null,
    pendingToken: null
  };
  await vault.setManagementDevice("target", device);
  expect(await vault.persistenceFor("target")).toBe("session-only");
  expect(await vault.getManagementDevice("target")).toEqual(device);
  expect(await new OperatorCredentialVault(options).getManagementDevice("target")).toBeUndefined();
  await vault.clearSessionMemory();
  expect(await vault.getManagementDevice("target")).toBeUndefined();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  "clear",
  "remove",
  "import",
  "origin",
  "identity",
  "shutdown"
])("does not commit an old management refresh after %s invalidation", async (change) => {
  const root = await mkdtemp(join(tmpdir(), "management-invalidation-"));
  roots.push(root);
  const paths = { credentialsPath: join(root, "credentials.json") };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString()
  };
  const vault = new OperatorCredentialVault({ paths, safeStorage });
  const profiles = new OperatorProfileStore({ profilesPath: join(root, "profiles.json") });
  const profile = {
    profileId: "target",
    displayName: "Target",
    serverBaseUrl: "https://server.example",
    allowInsecureTransport: false,
    operatorId: "target-admin"
  };
  await profiles.upsert(profile);
  await vault.setOperatorToken("target", oldToken, "target-admin");
  const pendingToken = `pw_operator_${"P".repeat(43)}`;
  await vault.setManagementDevice("target", {
    secret: `pw_device_${"D".repeat(43)}`,
    origin: "https://server.example",
    operatorId: "target-admin",
    deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
    pendingToken
  });
  const entered = deferred<void>();
  const refresh = deferred<Response>();
  const operations = new OperatorProfileOperations();
  let refreshSignal: AbortSignal | null | undefined;
  const management = new OperatorManagementService({
    profiles,
    vault,
    operations,
    client: async () => ({
      client: new OperatorControlClient({
        profile,
        credential: { getOperatorToken: () => vault.getOperatorToken("target") },
        request: async (_url, init) => {
          refreshSignal = init?.signal;
          entered.resolve();
          // Deliberately deliver a response even after abort to test the commit guard.
          return refresh.promise;
        }
      }),
      profile
    })
  });
  const checking = management.check("target");
  expect(management.check("target")).toBe(checking);
  await entered.promise;
  expect((await vault.getManagementDevice("target"))?.pendingToken).toBe(pendingToken);
  if (change === "shutdown") operations.shutdown();
  else management.forget("target");
  if (change === "clear" || change === "remove") await vault.clear("target");
  if (change === "remove") await profiles.remove("target");
  if (change === "import") {
    await vault.setManagementDevice("target", undefined);
    await vault.setOperatorToken("target", adminToken, "target-admin");
  }
  if (change === "origin")
    await profiles.upsert({ ...profile, serverBaseUrl: "https://moved.example" });
  if (change === "identity") await profiles.upsert({ ...profile, operatorId: "new-admin" });
  expect(refreshSignal?.aborted).toBe(true);
  refresh.resolve(response({ ...authorization, deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc" }));
  expect((await checking).errorCode).toBe("operator_operation_invalidated");
  const restored = new OperatorCredentialVault({ paths, safeStorage });
  expect(await restored.getOperatorToken("target")).toBe(
    change === "clear" || change === "remove"
      ? undefined
      : change === "import"
        ? adminToken
        : oldToken
  );
  if (change === "remove") expect(await profiles.get("target")).toBeNull();
  operations.shutdown();
});
