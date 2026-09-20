import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorControlService } from "../main/operatorControl/operatorControlService";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault";
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
