import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFileTunnelConfigStore, defaultTunnelConfigPath } from "../tunnel/configStore.js";
import {
  commitTunnelClientDownload,
  withTunnelClientDownload
} from "../tunnel/downloadCandidate.js";
import { downloadOfficialTunnelClient, tunnelClientPlatformAsset } from "../tunnel/downloader.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "planweave-candidate-"));
  vi.stubEnv("PLANWEAVE_HOME", root);
  expect(defaultTunnelConfigPath()).toBe(join(root, "config/mcp-tunnel/config.json"));
  const platform = tunnelClientPlatformAsset();
  const name = `tunnel-client-v-test-${platform.assetSuffix}`;
  const zip = zipSync({ [platform.binaryName]: Buffer.from("verified candidate") });
  const hash = createHash("sha256").update(zip).digest("hex");
  vi.stubGlobal("fetch", async (url: string) =>
    String(url).endsWith("/latest")
      ? Response.json({
          tag_name: "v-test",
          assets: [
            { name, browser_download_url: "https://fixture.test/zip" },
            { name: "SHA256SUMS.txt", browser_download_url: "https://fixture.test/sums" }
          ]
        })
      : String(url).endsWith("/sums")
        ? new Response(`${hash}  ${name}`)
        : new Response(zip)
  );
});
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await actual.rm(root, { recursive: true, force: true });
});
const candidate = () => downloadOfficialTunnelClient(join(root, "downloads"));

it("retains a candidate referenced by durable config even when the writer reports a post-commit failure", async () => {
  const result = await candidate();
  const store = createFileTunnelConfigStore();
  const config = await store.read();
  const failure = new Error("post-commit failure");
  await expect(
    commitTunnelClientDownload(result, {
      configPath: store.path(),
      write: async () => {
        await store.write({
          ...config,
          tunnelClientPath: result.binaryPath,
          verification: result.verification
        });
        throw failure;
      },
      readPath: async () => (await store.read()).tunnelClientPath
    })
  ).rejects.toBe(failure);
  expect(await fs.readFile(result.binaryPath, "utf8")).toBe("verified candidate");
  expect((await store.read()).verification).toEqual(result.verification);
});

it("releases unsubmitted candidates when config lock acquisition fails repeatedly, then retries", async () => {
  const store = createFileTunnelConfigStore();
  const previous = await candidate();
  const config = await store.read();
  await commitTunnelClientDownload(previous, {
    configPath: store.path(),
    write: () => store.write({ ...config, tunnelClientPath: previous.binaryPath }),
    readPath: async () => (await store.read()).tunnelClientPath
  });
  const before = await fs.readFile(store.path());
  const blockedParent = join(root, "blocked-parent");
  await fs.writeFile(blockedParent, "not a directory");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await candidate();
    const write = vi.fn(async () => undefined);
    await expect(
      commitTunnelClientDownload(result, {
        configPath: join(blockedParent, "config.json"),
        write,
        readPath: async () => null
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/EEXIST|ENOTDIR/) });
    expect(write).not.toHaveBeenCalled();
    await expect(fs.stat(dirname(result.binaryPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(dirname(dirname(previous.binaryPath)))).toHaveLength(1);
  }
  expect(await fs.readFile(store.path())).toEqual(before);
  expect(await fs.readFile(previous.binaryPath, "utf8")).toBe("verified candidate");
  const retry = await candidate();
  await commitTunnelClientDownload(retry, {
    configPath: store.path(),
    write: () => store.write({ ...config, tunnelClientPath: retry.binaryPath }),
    readPath: async () => (await store.read()).tunnelClientPath
  });
  expect((await store.read()).tunnelClientPath).toBe(retry.binaryPath);
  expect(await fs.readdir(dirname(dirname(previous.binaryPath)))).toHaveLength(2);
});

it("preserves a candidate when persistence was attempted but its durable reference is unknown", async () => {
  const result = await candidate();
  const store = createFileTunnelConfigStore();
  const failure = new Error("write result unknown");
  const readFailure = new Error("config unreadable");
  await expect(
    commitTunnelClientDownload(result, {
      configPath: store.path(),
      write: async () => {
        throw failure;
      },
      readPath: async () => {
        throw readFailure;
      }
    })
  ).rejects.toMatchObject({ errors: [failure, readFailure], cause: failure });
  expect(await fs.readFile(result.binaryPath, "utf8")).toBe("verified candidate");
});

it("releases an unsubmitted candidate on lock timeout without deleting the live holder", async () => {
  const result = await candidate();
  const store = createFileTunnelConfigStore();
  const lockPath = `${store.path()}.lock`;
  await fs.mkdir(lockPath, { recursive: true });
  const holder = JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    operation: "other writer"
  });
  await fs.writeFile(join(lockPath, "holder.json"), holder);
  const clock = vi
    .spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(1)
    .mockReturnValue(10_001);
  const write = vi.fn(async () => undefined);
  try {
    await expect(
      commitTunnelClientDownload(result, {
        configPath: store.path(),
        write,
        readPath: async () => null
      })
    ).rejects.toThrow(/Timed out.*lock/i);
  } finally {
    clock.mockRestore();
  }
  expect(write).not.toHaveBeenCalled();
  await expect(fs.stat(dirname(result.binaryPath))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(join(lockPath, "holder.json"), "utf8")).toBe(holder);
});

it("reports a pre-write release failure once across nested ownership scopes and fences reuse", async () => {
  const result = await candidate();
  const blockedParent = join(root, "blocked-parent");
  await fs.writeFile(blockedParent, "not a directory");
  const cleanup = new Error("remove denied before write");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rm).mockImplementation((path, options) => {
    if (path === dirname(result.binaryPath)) return Promise.reject(cleanup);
    return actual.rm(path, options);
  });
  const write = vi.fn(async () => undefined);
  const operation = () =>
    commitTunnelClientDownload(result, {
      configPath: join(blockedParent, "config.json"),
      write,
      readPath: async () => null
    });
  let failure: unknown;
  try {
    await withTunnelClientDownload(result, operation);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected cleanup failure");
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(failure.cause);
  expect(failure.errors[1]).toBe(cleanup);
  expect(
    vi.mocked(fs.rm).mock.calls.filter(([path]) => path === dirname(result.binaryPath))
  ).toHaveLength(1);
  expect(await fs.readFile(result.binaryPath, "utf8")).toBe("verified candidate");
  await expect(operation()).rejects.toThrow("already been released");
  expect(write).not.toHaveBeenCalled();
});

it("does not release a committed installation on a later pre-write lock failure", async () => {
  const result = await candidate();
  const store = createFileTunnelConfigStore();
  const config = await store.read();
  await commitTunnelClientDownload(result, {
    configPath: store.path(),
    write: () => store.write({ ...config, tunnelClientPath: result.binaryPath }),
    readPath: async () => (await store.read()).tunnelClientPath
  });
  const blockedParent = join(root, "blocked-parent");
  await fs.writeFile(blockedParent, "not a directory");
  await expect(
    commitTunnelClientDownload(result, {
      configPath: join(blockedParent, "config.json"),
      write: async () => undefined,
      readPath: async () => null
    })
  ).rejects.toThrow();
  expect((await store.read()).tunnelClientPath).toBe(result.binaryPath);
  expect(await fs.readFile(result.binaryPath, "utf8")).toBe("verified candidate");
});

it("serializes failure release with another successful commit and never releases a previously committed candidate", async () => {
  const failed = await candidate();
  const success = await candidate();
  const store = createFileTunnelConfigStore();
  const config = await store.read();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let fail!: () => void;
  const blocked = new Promise<void>((resolve) => {
    fail = resolve;
  });
  const failure = new Error("commit rejected");
  const first = commitTunnelClientDownload(failed, {
    configPath: store.path(),
    write: async () => {
      enter();
      await blocked;
      throw failure;
    },
    readPath: async () => (await store.read()).tunnelClientPath
  });
  const rejected = expect(first).rejects.toBe(failure);
  await entered;
  const second = commitTunnelClientDownload(success, {
    configPath: store.path(),
    write: () =>
      store.write({
        ...config,
        tunnelClientPath: success.binaryPath,
        verification: success.verification
      }),
    readPath: async () => (await store.read()).tunnelClientPath
  });
  fail();
  await rejected;
  await second;
  await expect(fs.stat(dirname(failed.binaryPath))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await store.read()).tunnelClientPath).toBe(success.binaryPath);
  await expect(
    commitTunnelClientDownload(success, {
      configPath: store.path(),
      write: async () => {
        throw failure;
      },
      readPath: async () => null
    })
  ).rejects.toBe(failure);
  expect(await fs.readFile(success.binaryPath, "utf8")).toBe("verified candidate");
});

it("reports both commit and candidate cleanup failures while preserving the candidate", async () => {
  const result = await candidate();
  const store = createFileTunnelConfigStore();
  const failure = new Error("write denied");
  const cleanup = new Error("remove denied");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rm).mockImplementation((path, options) => {
    if (path === dirname(result.binaryPath)) return Promise.reject(cleanup);
    return actual.rm(path, options);
  });
  await expect(
    commitTunnelClientDownload(result, {
      configPath: store.path(),
      write: async () => {
        throw failure;
      },
      readPath: async () => (await store.read()).tunnelClientPath
    })
  ).rejects.toMatchObject({ errors: [failure, cleanup], cause: failure });
  expect(await fs.readFile(result.binaryPath, "utf8")).toBe("verified candidate");
});

it("does not accept forged results as candidate cleanup authority", async () => {
  const result = await candidate();
  const store = createFileTunnelConfigStore();
  await expect(
    commitTunnelClientDownload(
      { ...result },
      {
        configPath: store.path(),
        write: async () => {
          throw new Error("denied");
        },
        readPath: async () => null
      }
    )
  ).rejects.toThrow("not owned");
  expect(await fs.readFile(result.binaryPath, "utf8")).toBe("verified candidate");
});
