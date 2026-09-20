import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorControlService } from "../main/operatorControl/operatorControlService";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault";
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
async function fixture(request: typeof fetch) {
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
    request,
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
  return { service, vault };
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
  expect(request).toHaveBeenCalledTimes(3);
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
