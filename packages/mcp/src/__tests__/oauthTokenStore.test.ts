import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileOAuthTokenStore,
  type StoredAccessToken,
  type StoredOAuthToken,
  type StoredRefreshToken
} from "../oauthTokenStore.js";

const tempDirs: string[] = [];
const supportsPosixModeAssertions = process.platform !== "win32";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-oauth-token-store-"));
  tempDirs.push(dir);
  return join(dir, "config", "oauth", "tokens.json");
}

function accessToken(overrides: Partial<StoredAccessToken> = {}): StoredAccessToken {
  return {
    kind: "access",
    tokenHash: "token-a",
    clientId: "client-a",
    expiresAt: Date.now() + 60_000,
    resource: "http://127.0.0.1:8787/mcp",
    scope: "planweave:mcp",
    ...overrides
  };
}

function refreshToken(overrides: Partial<StoredRefreshToken> = {}): StoredRefreshToken {
  return {
    kind: "refresh",
    tokenHash: "refresh-a",
    clientId: "client-a",
    expiresAt: Date.now() + 60_000,
    resource: "http://127.0.0.1:8787/mcp",
    scope: "planweave:mcp offline_access",
    ...overrides
  };
}

async function readStoredTokens(path: string): Promise<{ version: 2; tokens: StoredOAuthToken[] }> {
  return JSON.parse(await readFile(path, "utf8")) as { version: 2; tokens: StoredOAuthToken[] };
}

async function expectPrivateStorePermissions(path: string): Promise<void> {
  if (!supportsPosixModeAssertions) {
    return;
  }
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}

describe("file OAuth token store", () => {
  it("writes tokens with private file and directory permissions", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthTokenStore(storePath);

    await store.set(accessToken({ tokenHash: "token-private" }));

    expect(await store.get("token-private")).toMatchObject({ clientId: "client-a" });
    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [{ kind: "access", tokenHash: "token-private" }]
    });
    await expectPrivateStorePermissions(storePath);
  });

  it("deletes requested and expired tokens while preserving private permissions", async () => {
    const storePath = await createTempStorePath();
    const storeDir = dirname(storePath);
    const now = Date.now();
    await mkdir(storeDir, { recursive: true, mode: 0o755 });
    if (supportsPosixModeAssertions) {
      await chmod(storeDir, 0o755);
    }
    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          tokens: [legacyAccessToken("expired-token", now - 1), legacyAccessToken("deleted-token")]
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o644 }
    );
    if (supportsPosixModeAssertions) {
      await chmod(storePath, 0o644);
    }
    const store = createFileOAuthTokenStore(storePath);

    await store.delete("deleted-token");

    expect(await readStoredTokens(storePath)).toEqual({ version: 2, tokens: [] });
    await expectPrivateStorePermissions(storePath);
  });

  it("keeps sorted, current content after repeated writes", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthTokenStore(storePath);

    await store.set(accessToken({ tokenHash: "token-b", clientId: "client-b" }));
    await store.set(accessToken({ tokenHash: "token-a", clientId: "client-a" }));
    await store.set(accessToken({ tokenHash: "token-b", clientId: "client-b-updated" }));

    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [
        { tokenHash: "token-a", clientId: "client-a" },
        { tokenHash: "token-b", clientId: "client-b-updated" }
      ]
    });
    await expectPrivateStorePermissions(storePath);
  });

  it("migrates version 1 access tokens without invalidating them", async () => {
    const storePath = await createTempStorePath();
    await mkdir(dirname(storePath), { recursive: true });
    const legacyToken = accessToken({ tokenHash: "legacy-access-token" });
    const { kind: _kind, ...legacyRecord } = legacyToken;
    await writeFile(
      storePath,
      `${JSON.stringify({ version: 1, tokens: [legacyRecord] }, null, 2)}\n`,
      "utf8"
    );
    const store = createFileOAuthTokenStore(storePath);

    await expect(store.get("legacy-access-token")).resolves.toMatchObject({
      kind: "access",
      clientId: "client-a"
    });
    await store.set(accessToken({ tokenHash: "new-access-token" }));

    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [
        { kind: "access", tokenHash: "legacy-access-token" },
        { kind: "access", tokenHash: "new-access-token" }
      ]
    });
  });

  it("atomically consumes one refresh token and persists its replacements", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthTokenStore(storePath);
    await store.setMany([
      refreshToken({ tokenHash: "refresh-old" }),
      accessToken({ tokenHash: "access-old" })
    ]);

    const first = await store.replace("refresh-old", [
      refreshToken({ tokenHash: "refresh-new" }),
      accessToken({ tokenHash: "access-new" })
    ]);
    const reused = await store.replace("refresh-old", [
      refreshToken({ tokenHash: "refresh-unexpected" })
    ]);

    expect(first).toMatchObject({ kind: "refresh", tokenHash: "refresh-old" });
    expect(reused).toBeUndefined();
    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [
        { kind: "access", tokenHash: "access-new" },
        { kind: "access", tokenHash: "access-old" },
        { kind: "refresh", tokenHash: "refresh-new" }
      ]
    });
  });
});

function legacyAccessToken(tokenHash: string, expiresAt = Date.now() + 60_000) {
  const { kind: _kind, ...legacyToken } = accessToken({ tokenHash, expiresAt });
  return legacyToken;
}
