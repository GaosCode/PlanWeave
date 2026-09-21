import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorControlService } from "../main/operatorControl/operatorControlService";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault";
import { OperatorProfileOperations } from "../main/operatorControl/operatorProfileOperations";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it.each([
  200, 401, 403, 503
])("validates replacement credentials before saving: HTTP %s", async (status) => {
  const directory = await mkdtemp(join(tmpdir(), "operator-recovery-"));
  directories.push(directory);
  const oldToken = "operator_old_abcdefghijklmnopqrstuvwxyz_123456";
  const newToken = "operator_new_abcdefghijklmnopqrstuvwxyz_123456";
  const vault = new OperatorCredentialVault({
    paths: { credentialsPath: join(directory, "credentials.json") },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (buffer) => buffer.toString()
    }
  });
  await vault.setOperatorToken("target", oldToken);
  await vault.setOperatorToken("other", oldToken);
  const request = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          status === 200
            ? { items: [], nextCursor: null }
            : { error: status === 401 ? "operator_unauthorized" : "operator_forbidden" }
        ),
        { status }
      )
  );
  const service = new OperatorControlService({
    profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
    vault,
    request,
    localOperatorBackend: null
  });
  await service.upsertProfile({
    profileId: "target",
    displayName: "Target",
    serverBaseUrl: "https://target.example/",
    allowInsecureTransport: false
  });
  const result = service.importCredential({
    profileId: "target",
    operatorToken: newToken,
    verifyBeforeSave: true
  });
  if (status === 200) {
    const view = await result;
    expect(JSON.stringify(view)).not.toContain(newToken);
    await service.listHosts({ profileId: "target" });
  } else {
    await expect(result).rejects.toThrow();
  }
  expect(await vault.getOperatorToken("target")).toBe(status === 200 ? newToken : oldToken);
  expect(await vault.getOperatorToken("other")).toBe(oldToken);
  const calls = request.mock.calls;
  expect(String(calls[0]?.[0])).toBe("https://target.example/api/v1/hosts?cursor=0&limit=1");
  expect(new Headers(calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${newToken}`);
});

const tokenA = `pw_operator_${"A".repeat(43)}`;
const tokenB = `pw_operator_${"B".repeat(43)}`;
const device = {
  secret: `pw_device_${"D".repeat(43)}`,
  origin: "https://target.example",
  operatorId: "operator",
  deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
  pendingToken: tokenB
};

async function vaultFixture() {
  const directory = await mkdtemp(join(tmpdir(), "operator-vault-transactions-"));
  directories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`encrypted:${text}`),
    decryptString: (buffer: Buffer) => {
      const ciphertext = buffer.toString();
      if (!ciphertext.startsWith("encrypted:")) throw new Error("invalid ciphertext");
      return ciphertext.slice("encrypted:".length);
    }
  };
  const options = { paths: { credentialsPath }, safeStorage };
  return {
    directory,
    credentialsPath,
    vault: new OperatorCredentialVault(options),
    reload: () => new OperatorCredentialVault(options)
  };
}

it("serializes first-load writes across profiles and preserves pending-token commits on reload", async () => {
  const { vault, reload, credentialsPath } = await vaultFixture();
  await Promise.all([
    vault.setOperatorToken("a", tokenA, "operator"),
    vault.setOperatorToken("b", tokenB, "operator")
  ]);
  await Promise.all([
    vault.setManagementDevice("a", device),
    vault.setOperatorToken("b", tokenA, "operator"),
    vault.setOperatorToken("a", tokenB, "operator"),
    vault.setManagementDevice("a", { ...device, pendingToken: null })
  ]);
  const restored = reload();
  expect(await restored.getOperatorToken("a")).toBe(tokenB);
  expect(await restored.getOperatorToken("b")).toBe(tokenA);
  expect(await restored.getManagementDevice("a")).toEqual({ ...device, pendingToken: null });
  const raw = await readFile(credentialsPath, "utf8");
  expect(raw).not.toContain(tokenA);
  expect(raw).not.toContain(tokenB);
  expect(raw).not.toContain(device.secret);
  const external = await restored.getManagementDevice("a");
  if (!external) throw new Error("device missing");
  external.pendingToken = tokenA;
  expect((await restored.getManagementDevice("a"))?.pendingToken).toBeNull();
});

it("keeps committed memory after failed token, device and clear writes and recovers the queue", async () => {
  const { vault, reload, directory, credentialsPath } = await vaultFixture();
  await vault.setOperatorToken("a", tokenA, "operator");
  await vault.setManagementDevice("a", device);
  await mkdir(`${credentialsPath}.tmp`);
  await expect(vault.setOperatorToken("a", tokenB, "operator")).rejects.toThrow();
  await expect(vault.setManagementDevice("a", { ...device, pendingToken: null })).rejects.toThrow();
  await expect(vault.clear("a")).rejects.toThrow();
  expect(await vault.getOperatorToken("a")).toBe(tokenA);
  expect(await vault.getManagementDevice("a")).toEqual(device);
  expect(await vault.persistenceFor("a")).toBe("persisted");
  expect(await reload().getOperatorToken("a")).toBe(tokenA);
  await rename(`${credentialsPath}.tmp`, join(directory, "blocked-temp"));
  await vault.setOperatorToken("a", tokenB, "operator");
  expect(await reload().getOperatorToken("a")).toBe(tokenB);
  await vault.clear("a");
  expect(await vault.persistenceFor("a")).toBe("missing");
  expect(await reload().getOperatorToken("a")).toBeUndefined();
});

it("retries a failed initial load without publishing a failed first credential", async () => {
  const { vault, credentialsPath, reload, directory } = await vaultFixture();
  await writeFile(credentialsPath, "invalid json");
  await expect(Promise.all([vault.getMetadata("a"), vault.getMetadata("b")])).rejects.toThrow();
  await writeFile(credentialsPath, JSON.stringify({ version: 1, credentials: {} }));
  await mkdir(`${credentialsPath}.tmp`);
  await expect(vault.setOperatorToken("a", tokenA)).rejects.toThrow();
  expect(await vault.persistenceFor("a")).toBe("missing");
  expect(await vault.getOperatorToken("a")).toBeUndefined();
  await rename(`${credentialsPath}.tmp`, join(directory, "blocked-temp"));
  await vault.setOperatorToken("a", tokenA);
  expect(await reload().getOperatorToken("a")).toBe(tokenA);
});

it("serializes invalid-token repair with concurrent writes", async () => {
  const { credentialsPath, vault, reload } = await vaultFixture();
  await writeFile(
    credentialsPath,
    JSON.stringify({
      version: 1,
      credentials: {
        broken: {
          encryptedOperatorToken: Buffer.from("encrypted:invalid").toString("base64"),
          operatorId: null,
          updatedAt: new Date().toISOString()
        }
      }
    })
  );
  const [invalid] = await Promise.all([
    vault.getOperatorToken("broken"),
    vault.setOperatorToken("good", tokenA)
  ]);
  expect(invalid).toBeUndefined();
  const restored = reload();
  expect(await restored.persistenceFor("broken")).toBe("missing");
  expect(await restored.getOperatorToken("good")).toBe(tokenA);
});

it("checks generation inside the queued mutation and prevents late refresh from recreating cleared credentials", async () => {
  const { vault, reload } = await vaultFixture();
  const operations = new OperatorProfileOperations();
  await vault.setOperatorToken("a", tokenA);
  const operation = operations.capture("a");
  const dispose = vi.fn();
  operation.track({ dispose });
  const lateWrite = vault.setOperatorToken("a", tokenB, "operator", operation.assertCurrent);
  operations.invalidate("a");
  const clear = vault.clear("a");
  await expect(lateWrite).rejects.toThrow("operator_operation_invalidated");
  await clear;
  expect(dispose).toHaveBeenCalledOnce();
  expect(await reload().getOperatorToken("a")).toBeUndefined();
  const replacement = operations.capture("a");
  operation.release();
  expect(replacement.isCurrent()).toBe(true);
  await vault.setOperatorToken("a", tokenA, "operator", replacement.assertCurrent);
  operations.shutdown();
  await expect(vault.setManagementDevice("a", device, replacement.assertCurrent)).rejects.toThrow(
    "operator_operation_invalidated"
  );
  expect(await reload().getManagementDevice("a")).toBeUndefined();
});
