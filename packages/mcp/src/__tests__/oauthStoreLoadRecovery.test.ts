import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileOAuthClientStore } from "../oauthClientStore.js";
import { createFileOAuthTokenStore, type StoredAccessToken } from "../oauthTokenStore.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const tempDirs: string[] = [];
const client = {
  clientId: "loaded",
  clientIdIssuedAt: 100,
  redirectUris: ["https://example.com"]
};
const token: StoredAccessToken = {
  kind: "access",
  tokenHash: "loaded",
  clientId: "client",
  expiresAt: 4_000_000_000_000,
  resource: "http://127.0.0.1/mcp",
  scope: "planweave:mcp"
};

const cases = [
  {
    name: "client",
    value: client,
    file: { version: 1, clients: [client] },
    invalid: { version: 1, clients: [client, { clientId: "invalid" }] },
    open(path: string) {
      const store = createFileOAuthClientStore(path);
      return {
        get: (key = "loaded") => store.get(key),
        set: (key: string) => store.set({ ...client, clientId: key })
      };
    }
  },
  {
    name: "token",
    value: token,
    file: { version: 2, tokens: [token] },
    invalid: { version: 2, tokens: [token, { kind: "access" }] },
    open(path: string) {
      const store = createFileOAuthTokenStore(path);
      return {
        get: (key = "loaded") => store.get(key),
        set: (key: string) => store.set({ ...token, tokenHash: key })
      };
    }
  }
];

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function pathForStore() {
  const dir = await mkdtemp(join(tmpdir(), "planweave-oauth-load-"));
  tempDirs.push(dir);
  return join(dir, "store.json");
}

afterEach(async () => {
  vi.mocked(readFile).mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.each(cases)("$name store load recovery", (fixture) => {
  it.each(["read", "write"])("retries after EACCES on the first %s", async (operation) => {
    const path = await pathForStore();
    await writeFile(path, JSON.stringify(fixture.file));
    const store = fixture.open(path);
    const failure = Object.assign(new Error("injected read denial"), { code: "EACCES" });
    vi.mocked(readFile).mockRejectedValueOnce(failure);

    await expect(operation === "read" ? store.get() : store.set("new")).rejects.toBe(failure);
    await expect(store.get()).resolves.toEqual(fixture.value);
    await expect(store.set("new")).resolves.toBeUndefined();
    await expect(fixture.open(path).get("new")).resolves.toBeDefined();
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(3);
  });

  it.each(["JSON", "schema"])("loads only repaired data after invalid %s", async (format) => {
    const path = await pathForStore();
    await writeFile(path, format === "JSON" ? "{" : JSON.stringify(fixture.invalid));
    const store = fixture.open(path);
    await expect(store.get()).rejects.toThrow();
    await expect(store.set("unpublished")).rejects.toThrow();
    const repaired =
      fixture.name === "client" ? { version: 1, clients: [] } : { version: 2, tokens: [] };
    await writeFile(path, JSON.stringify(repaired));

    await expect(store.get()).resolves.toBeUndefined();
    await expect(store.set("repaired")).resolves.toBeUndefined();
    await expect(store.get("unpublished")).resolves.toBeUndefined();
    await expect(fixture.open(path).get("repaired")).resolves.toBeDefined();
  });

  it("shares each load round across concurrent reads and writes after failure", async () => {
    const path = await pathForStore();
    await writeFile(path, JSON.stringify(fixture.file));
    const store = fixture.open(path);
    const entered = barrier();
    const release = barrier();
    const failure = Object.assign(new Error("injected shared read denial"), { code: "EACCES" });
    vi.mocked(readFile).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    });
    const failed = Promise.allSettled([store.get(), store.get(), store.set("failed")]);
    await entered.promise;
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
    release.resolve();
    expect(await failed).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure }
    ]);

    const retryRelease = barrier();
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      await retryRelease.promise;
      return actualFs.readFile(...args);
    });
    const retry = Promise.allSettled([store.set("first"), store.set("second"), store.get()]);
    const retryReadCount = vi.mocked(readFile).mock.calls.length;
    retryRelease.resolve();
    expect(await retry).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: fixture.value }
    ]);
    expect(retryReadCount).toBe(2);
    await expect(store.get("failed")).resolves.toBeUndefined();
    await expect(store.get("first")).resolves.toBeDefined();
    await expect(store.get("second")).resolves.toBeDefined();
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
    const reopened = fixture.open(path);
    await expect(reopened.get("first")).resolves.toBeDefined();
    await expect(reopened.get("second")).resolves.toBeDefined();
  });

  it("keeps ENOENT as an empty successful load without reading again", async () => {
    const path = await pathForStore();
    const store = fixture.open(path);
    await expect(store.get()).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify(fixture.file));
    await expect(store.get()).resolves.toBeUndefined();
    await store.set("new");
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
    await expect(fixture.open(path).get("new")).resolves.toBeDefined();
    await expect(fixture.open(path).get()).resolves.toBeUndefined();
  });
});
