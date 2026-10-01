import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readTunnelClientConfig,
  writeTunnelClientConfig,
  type TunnelClientConfig
} from "../main/mcpTunnel/tunnelClientStore.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    chmod: vi.fn(actual.chmod),
    stat: vi.fn(actual.stat),
    unlink: vi.fn(actual.unlink)
  };
});

const first: TunnelClientConfig = {
  tunnelClientPath: "/test/first",
  verification: null,
  tunnelId: "first",
  encryptedRuntimeApiKey: "fake-legacy",
  encryptedRuntimeApiKeys: {
    system: "fake-system",
    application: "fake-application"
  },
  autoStart: false
};
const second: TunnelClientConfig = {
  ...first,
  tunnelClientPath: "/test/second",
  tunnelId: "second",
  autoStart: true
};
let root: string;
let configPath: string;

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.chmod).mockReset().mockImplementation(actual.chmod);
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  root = await fs.mkdtemp(join(tmpdir(), "planweave-tunnel-store-"));
  configPath = join(root, "config.json");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function expectUnchanged(previous: string | null): Promise<void> {
  if (previous === null) {
    await expect(fs.readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    expect(await fs.readFile(configPath, "utf8")).toBe(previous);
  }
}

describe("MCP tunnel config atomic replacement", () => {
  it("concurrently commits complete snapshots without colliding or deleting foreign temp files", async () => {
    const foreign = `${configPath}.tmp`;
    await fs.writeFile(foreign, "foreign writer");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeTunnelClientConfig(index % 2 ? first : second, { configPath })
      )
    );
    expect([first, second]).toContainEqual(JSON.parse(await fs.readFile(configPath, "utf8")));
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign writer");
    expect((await fs.readdir(root)).sort()).toEqual(["config.json", "config.json.tmp"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    }
  });

  it.each([
    "write",
    "permissions",
    "rename"
  ] as const)("%s failure preserves the old target or absence and permits the next commit", async (stage) => {
    for (const existing of [false, true]) {
      if (existing) await writeTunnelClientConfig(first, { configPath });
      const previous = existing ? await fs.readFile(configPath, "utf8") : null;
      const failure = new Error(`injected ${stage} failure`);
      if (stage === "rename") {
        vi.mocked(fs.rename).mockRejectedValueOnce(failure);
      } else {
        const realOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
        vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
          const file = await realOpen(...args);
          if (stage === "write") {
            vi.spyOn(file, "writeFile").mockRejectedValueOnce(failure);
          } else {
            // A restrictive umask can require correcting mode before commit.
            await file.chmod(0o400);
            vi.spyOn(file, "chmod").mockRejectedValueOnce(failure);
          }
          return file;
        });
      }
      await expect(writeTunnelClientConfig(second, { configPath })).rejects.toBe(failure);
      await expectUnchanged(previous);
      expect(await fs.readdir(root)).toEqual(existing ? ["config.json"] : []);
      await writeTunnelClientConfig(second, { configPath });
      expect(await readTunnelClientConfig({ configPath })).toEqual(second);
      await fs.unlink(configPath);
    }
  });

  it("retains the original failure and exposes cleanup failure without touching another writer", async () => {
    await writeTunnelClientConfig(first, { configPath });
    const previous = await fs.readFile(configPath, "utf8");
    const failure = new Error("injected rename failure");
    const cleanupFailure = new Error("injected cleanup failure");
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    vi.mocked(fs.unlink).mockRejectedValueOnce(cleanupFailure);
    const rejected = await writeTunnelClientConfig(second, { configPath }).catch(
      (error: unknown) => error
    );
    expect(rejected).toBeInstanceOf(AggregateError);
    if (!(rejected instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(rejected.errors).toEqual([failure, cleanupFailure]);
    await expectUnchanged(previous);
    const leftovers = (await fs.readdir(root)).filter((name) => name !== "config.json");
    expect(leftovers).toHaveLength(1);
    await writeTunnelClientConfig(second, { configPath });
    expect(await readTunnelClientConfig({ configPath })).toEqual(second);
    expect(await fs.readdir(root)).toContain(leftovers[0]);
  });

  it("does no fallible permission work after committing the replacement", async () => {
    const realRename = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await realRename(...args);
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error("post-commit permissions unavailable"));
    });
    await expect(writeTunnelClientConfig(second, { configPath })).resolves.toBeUndefined();
    expect(await readTunnelClientConfig({ configPath })).toEqual(second);
  });

  it("reports directory permission failure before creating temporary files and retains EPERM policy", async () => {
    const failure = Object.assign(new Error("directory denied"), { code: "EACCES" });
    vi.mocked(fs.chmod).mockRejectedValueOnce(failure);
    await expect(writeTunnelClientConfig(first, { configPath })).rejects.toBe(failure);
    expect(await fs.readdir(root)).toEqual([]);
    vi.mocked(fs.chmod).mockRejectedValueOnce(
      Object.assign(new Error("unsupported"), { code: "EPERM" })
    );
    await writeTunnelClientConfig(first, { configPath });
    expect(await readTunnelClientConfig({ configPath })).toEqual(first);
  });
});
