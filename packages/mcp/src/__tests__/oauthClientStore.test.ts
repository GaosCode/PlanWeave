import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileOAuthClientStore, type RegisteredClient } from "../oauthClientStore.js";

const tempDirs: string[] = [];
const supportsPosixModeAssertions = process.platform !== "win32";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-oauth-client-store-"));
  tempDirs.push(dir);
  return join(dir, "config", "oauth", "clients.json");
}

function registeredClient(overrides: Partial<RegisteredClient> = {}): RegisteredClient {
  return {
    clientId: "client-a",
    clientIdIssuedAt: 1_700_000_000,
    clientName: "Client A",
    redirectUris: ["https://chatgpt.com/connector/oauth/callback"],
    ...overrides
  };
}

async function readStoredClients(
  path: string
): Promise<{ version: 1; clients: RegisteredClient[] }> {
  return JSON.parse(await readFile(path, "utf8")) as { version: 1; clients: RegisteredClient[] };
}

async function expectPrivateStorePermissions(path: string): Promise<void> {
  if (!supportsPosixModeAssertions) {
    return;
  }
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}

describe("file OAuth client store", () => {
  it("writes clients with private file and corrected directory permissions", async () => {
    const storePath = await createTempStorePath();
    const storeDir = dirname(storePath);
    await mkdir(storeDir, { recursive: true, mode: 0o755 });
    if (supportsPosixModeAssertions) {
      await chmod(storeDir, 0o755);
    }
    const store = createFileOAuthClientStore(storePath);

    await store.set(registeredClient({ clientId: "client-private" }));

    expect(await store.get("client-private")).toMatchObject({ clientName: "Client A" });
    expect(await readStoredClients(storePath)).toMatchObject({
      version: 1,
      clients: [{ clientId: "client-private" }]
    });
    await expectPrivateStorePermissions(storePath);
  });

  it("keeps sorted, current content after repeated writes", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthClientStore(storePath);

    await store.set(registeredClient({ clientId: "client-b", clientName: "Client B" }));
    await store.set(registeredClient({ clientId: "client-a", clientName: "Client A" }));
    await store.set(registeredClient({ clientId: "client-b", clientName: "Client B Updated" }));

    expect(await readStoredClients(storePath)).toMatchObject({
      version: 1,
      clients: [
        { clientId: "client-a", clientName: "Client A" },
        { clientId: "client-b", clientName: "Client B Updated" }
      ]
    });
    await expectPrivateStorePermissions(storePath);
  });
});
