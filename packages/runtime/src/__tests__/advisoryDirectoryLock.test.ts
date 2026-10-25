import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AdvisoryLockFs, withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { DEFAULT_CANVAS_LOCK_OPERATION, withCanvasLock } from "../fs/withCanvasLock.js";
import { optionalStat } from "../fs/optionalFile.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-advisory-lock-"));
  roots.push(root);
  const fs: AdvisoryLockFs = {
    mkdir: async (path) => {
      await mkdir(path);
    },
    readdir,
    lstat,
    readFile: (path, encoding) => readFile(path, encoding),
    writeFile,
    rename,
    rm,
    rmdir,
    optionalStat
  };
  return {
    root,
    lockPath: join(root, "lock"),
    operation: "test-lock",
    fs,
    timeoutMs: 80,
    retryDelayMs: 1
  };
}
async function seed(
  options: Awaited<ReturnType<typeof fixture>>,
  pid: number,
  holder: string | null = "valid"
) {
  const token = randomUUID(),
    name = `lease-v2-${pid}-${token}`;
  await mkdir(options.lockPath);
  await mkdir(join(options.lockPath, name));
  if (holder !== null)
    await writeFile(
      join(options.lockPath, name, "holder.json"),
      holder === "valid"
        ? JSON.stringify({
            version: 2,
            pid,
            ownerToken: token,
            operation: "holder-work",
            acquiredAt: new Date().toISOString()
          })
        : holder
    );
  return name;
}
async function holderAt(lockPath: string) {
  return join(lockPath, (await readdir(lockPath))[0], "holder.json");
}

describe("advisory directory lock", () => {
  it("prepares holder privately and cleans only its private candidate on a write failure", async () => {
    const options = await fixture();
    options.fs.writeFile = async (path) => {
      expect(path.startsWith(`${options.lockPath}.prepare-`)).toBe(true);
      await expect(access(options.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path, "{");
      throw new Error("holder write failed");
    };
    await expect(withAdvisoryDirectoryLock(options, async () => "entered")).rejects.toThrow(
      "holder write failed"
    );
    expect(await readdir(options.root)).toEqual([]);
  });
  it("cleans its published token if rename completes but reports an uncertain failure", async () => {
    const options = await fixture();
    const failure = Object.assign(new Error("publication EIO"), { code: "EIO" });
    let entered = false;
    options.fs.rename = async (from, to) => {
      await rename(from, to);
      if (to === options.lockPath) {
        expect(await readdir(to)).toHaveLength(1);
        throw failure;
      }
    };
    await expect(
      withAdvisoryDirectoryLock(options, async () => {
        entered = true;
      })
    ).rejects.toBe(failure);
    expect(entered).toBe(false);
    expect(await readdir(options.root)).toEqual([]);
  });
  it("preserves holder and cleanup failures", async () => {
    const options = await fixture();
    const writeError = new Error("holder write failed"),
      cleanupError = new Error("cleanup failed");
    options.fs.writeFile = async () => {
      throw writeError;
    };
    options.fs.rm = async () => {
      throw cleanupError;
    };
    await expect(withAdvisoryDirectoryLock(options, async () => "entered")).rejects.toMatchObject({
      errors: [writeError, cleanupError]
    });
    expect((await readdir(options.root)).every((entry) => entry.startsWith("lock.prepare-"))).toBe(
      true
    );
  });
  it("records operation diagnostics and retains the canvas default", async () => {
    const options = await fixture();
    for (const operation of [undefined, "claim-next", "   "]) {
      await withCanvasLock(
        options.root,
        async () => {
          const holder = JSON.parse(
            await readFile(await holderAt(join(options.root, ".planweave.lock")), "utf8")
          );
          expect(holder).toMatchObject({
            version: 2,
            pid: process.pid,
            operation: operation?.trim() || DEFAULT_CANVAS_LOCK_OPERATION
          });
        },
        { operation }
      );
    }
  });
  it("rejects empty primitive operations", async () => {
    const options = await fixture();
    await expect(
      withAdvisoryDirectoryLock({ ...options, operation: " " }, async () => undefined)
    ).rejects.toThrow("non-empty string");
  });
  it.each([
    "valid",
    "{",
    null
  ])("preserves a live owner regardless of holder diagnostics: %s", async (raw) => {
    const options = await fixture();
    const name = await seed(options, process.pid, raw);
    await expect(
      withAdvisoryDirectoryLock({ ...options, staleMs: 0 }, async () => "entered")
    ).rejects.toThrow("Timed out acquiring directory lock");
    expect(await readdir(options.lockPath)).toEqual([name]);
  });
  it.each([
    "valid",
    "{",
    null
  ])("recovers a confirmed dead owner immediately with metadata %s", async (raw) => {
    const options = await fixture();
    await seed(options, 99999999, raw);
    await expect(
      withAdvisoryDirectoryLock({ ...options, isPidAlive: () => false }, async () => "recovered")
    ).resolves.toBe("recovered");
    await expect(access(options.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rechecks a live owner after it exits during acquisition", async () => {
    const options = await fixture();
    await seed(options, 7777);
    let alive = true;
    await expect(
      withAdvisoryDirectoryLock(
        {
          ...options,
          isPidAlive: () => alive,
          clock: {
            nowMs: Date.now,
            performanceNow: () => performance.now(),
            delay: async () => {
              alive = false;
            }
          }
        },
        async () => "recovered"
      )
    ).resolves.toBe("recovered");
  });
  it("preserves a new owner published before a delayed stale-owner cleanup", async () => {
    const options = await fixture();
    const oldName = await seed(options, 7777);
    let replacementName = "";
    options.fs.rename = async (from, to) => {
      if (from === join(options.lockPath, oldName) && !replacementName) {
        await rm(from, { recursive: true, force: true });
        await rmdir(options.lockPath);
        replacementName = await seed(options, process.pid);
      }
      await rename(from, to);
    };
    await expect(
      withAdvisoryDirectoryLock(
        { ...options, isPidAlive: (pid) => pid === process.pid },
        async () => "entered"
      )
    ).rejects.toThrow("Timed out acquiring directory lock");
    expect(replacementName).not.toBe("");
    expect(await readdir(options.lockPath)).toEqual([replacementName]);
    expect(JSON.parse(await readFile(await holderAt(options.lockPath), "utf8"))).toMatchObject({
      pid: process.pid,
      operation: "holder-work"
    });
  });
  it("removes an empty released root without an age threshold", async () => {
    const options = await fixture();
    await mkdir(options.lockPath);
    await expect(withAdvisoryDirectoryLock(options, async () => "recovered")).resolves.toBe(
      "recovered"
    );
  });
  it.each([
    "holder.json",
    "owner-77-old",
    "unknown-version"
  ])("rejects unknown nonempty format %s without changing shared data", async (entry) => {
    const options = await fixture();
    await mkdir(options.lockPath);
    await writeFile(join(options.lockPath, entry), "evidence");
    await expect(
      withAdvisoryDirectoryLock(
        { ...options, isPidAlive: () => false, staleMs: 0 },
        async () => "entered"
      )
    ).rejects.toThrow("LOCK_FORMAT_UNSUPPORTED");
    expect(await readFile(join(options.lockPath, entry), "utf8")).toBe("evidence");
  });
  it("rejects symlink roots without following them", async () => {
    const options = await fixture();
    const target = join(options.root, "target");
    await mkdir(target);
    await writeFile(join(target, "evidence"), "evidence");
    await symlink(target, options.lockPath, "dir");
    await expect(withAdvisoryDirectoryLock(options, async () => "entered")).rejects.toThrow(
      "LOCK_FORMAT_UNSUPPORTED"
    );
    expect(await readFile(join(target, "evidence"), "utf8")).toBe("evidence");
  });
  it("propagates uncertain liveness rather than reclaiming", async () => {
    const options = await fixture();
    const name = await seed(options, 7777);
    await expect(
      withAdvisoryDirectoryLock(
        {
          ...options,
          isPidAlive: () => {
            throw new Error("liveness unavailable");
          }
        },
        async () => "entered"
      )
    ).rejects.toThrow("liveness unavailable");
    expect(await readdir(options.lockPath)).toEqual([name]);
  });
  it.each([
    null,
    "{",
    JSON.stringify({ version: 1, kind: "posix", pgid: 0 }),
    JSON.stringify({ version: 1, kind: "future", pgid: 7777 })
  ])("retains dead owners with unregistered or invalid writers: %s", async (descriptor) => {
    const options = await fixture();
    const name = await seed(options, 7777);
    const pending = join(options.lockPath, name, "external-writers-pending");
    await mkdir(pending);
    if (descriptor !== null) await writeFile(join(pending, "group-ready.json"), descriptor);
    await expect(
      withAdvisoryDirectoryLock({ ...options, isPidAlive: () => false }, async () => "entered")
    ).rejects.toThrow("WRITER_GROUP_UNREGISTERED");
    expect(await readdir(options.lockPath)).toEqual([name]);
  });
  it("retains timeout holder and operation diagnostics", async () => {
    const options = await fixture();
    await seed(options, process.pid);
    await expect(withAdvisoryDirectoryLock(options, async () => undefined)).rejects.toThrow(
      /requested operation=test-lock; holder pid=\d+; holder operation=holder-work; holder acquiredAt=.*; holder age=\d+ms; holder pidAlive=true; lock age=\d+ms/
    );
  });
  it("identifies unreadable holder diagnostics on timeout while retaining its live identity", async () => {
    const options = await fixture();
    const name = await seed(options, process.pid, null);
    await expect(withAdvisoryDirectoryLock(options, async () => "entered")).rejects.toThrow(
      /holder unreadable \(holder missing\); lock age=\d+ms/
    );
    expect(await readdir(options.lockPath)).toEqual([name]);
  });
  it("reenters in the same async context and preserves callback values", async () => {
    const options = await fixture();
    await expect(
      withAdvisoryDirectoryLock(options, async () =>
        withAdvisoryDirectoryLock(options, async () => 42)
      )
    ).resolves.toBe(42);
  });
  it("serializes waiters and does not poison the queue after callback failure", async () => {
    const options = await fixture();
    const order: string[] = [];
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const error = new Error("callback failed");
    const first = withAdvisoryDirectoryLock(options, async () => {
      order.push("first");
      enter();
      await gate;
      throw error;
    });
    const observed = expect(first).rejects.toBe(error);
    await entered;
    const second = withAdvisoryDirectoryLock(options, async () => {
      order.push("second");
      return 2;
    });
    expect(order).toEqual(["first"]);
    release();
    await observed;
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
});
