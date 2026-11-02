import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type AdvisoryLockFs, withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { optionalStat } from "../fs/optionalFile.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fixture(remove: AdvisoryLockFs["rm"]) {
  const root = await fs.mkdtemp(join(tmpdir(), "planweave-lock-release-"));
  directories.push(root);
  const adapter: AdvisoryLockFs = {
    readdir: (path) => fs.readdir(path),
    mkdir: async (path) => {
      await fs.mkdir(path);
    },
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    readFile: (path, encoding) => fs.readFile(path, encoding),
    rename: fs.rename,
    lstat: fs.lstat,
    rmdir: fs.rmdir,
    rm: remove,
    optionalStat
  };
  return { lockPath: join(root, "lock"), operation: "release-recovery", fs: adapter };
}

it.each([
  false,
  true
])("does not poison the next acquisition after a transient release failure (operationFails=%s)", async (operationFails) => {
  const releaseError = Object.assign(new Error("release EIO"), { code: "EIO" });
  const operationError = new Error("operation failed");
  let failed = false;
  const options = await fixture(async (path, removal) => {
    if (!failed) {
      failed = true;
      throw releaseError;
    }
    await fs.rm(path, removal);
  });
  const result = withAdvisoryDirectoryLock(options, async () => {
    if (operationFails) throw operationError;
    return "first";
  });
  if (operationFails) {
    await expect(result).rejects.toMatchObject({ errors: [operationError, releaseError] });
  } else await expect(result).rejects.toBe(releaseError);
  await expect(fs.access(options.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(withAdvisoryDirectoryLock(options, async () => "retry")).resolves.toBe("retry");
});

it("preserves a replacement owner when retrying failed release", async () => {
  const releaseError = Object.assign(new Error("release EIO"), { code: "EIO" });
  let replacementName = "";
  let options: Awaited<ReturnType<typeof fixture>>;
  options = await fixture(async (path, removal) => {
    await fs.rm(path, removal);
    if (!replacementName) {
      const { randomUUID } = await import("node:crypto");
      replacementName = `lease-v2-${process.pid}-${randomUUID()}`;
      await fs.mkdir(join(options.lockPath, replacementName));
      await fs.writeFile(
        join(options.lockPath, replacementName, "holder.json"),
        "replacement evidence"
      );
      throw releaseError;
    }
  });
  await expect(withAdvisoryDirectoryLock(options, async () => "first")).rejects.toBe(releaseError);
  expect(await fs.readFile(join(options.lockPath, replacementName, "holder.json"), "utf8")).toBe(
    "replacement evidence"
  );
});

it("reports both failed release attempts while preserving the owned lock", async () => {
  const failures = [new Error("first release failed"), new Error("second release failed")];
  let attempt = 0;
  const options = await fixture(async () => {
    throw failures[attempt++];
  });
  await expect(withAdvisoryDirectoryLock(options, async () => "first")).rejects.toMatchObject({
    errors: failures
  });
  expect(
    JSON.parse(
      await fs.readFile(
        join(options.lockPath, (await fs.readdir(options.lockPath))[0], "holder.json"),
        "utf8"
      )
    )
  ).toMatchObject({ pid: process.pid, operation: options.operation });
});

it("rejects legacy nonempty locks without deleting them even when their pid is dead", async () => {
  const options = await fixture(fs.rm);
  await fs.mkdir(options.lockPath);
  const legacy = JSON.stringify({ pid: 99999999, operation: "legacy", acquiredAt: "2000-01-01" });
  await fs.writeFile(join(options.lockPath, "holder.json"), legacy);
  await expect(
    withAdvisoryDirectoryLock({ ...options, isPidAlive: () => false }, async () => "entered")
  ).rejects.toThrow("LOCK_FORMAT_UNSUPPORTED");
  expect(await fs.readFile(join(options.lockPath, "holder.json"), "utf8")).toBe(legacy);
});

it("does not remove the shared holder when private metadata publication fails", async () => {
  const options = await fixture(fs.rm);
  await fs.mkdir(options.lockPath);
  await fs.writeFile(join(options.lockPath, "evidence"), "preserve");
  options.fs.writeFile = async () => {
    throw new Error("private metadata failure");
  };
  await expect(
    withAdvisoryDirectoryLock({ ...options, timeoutMs: 100 }, async () => "entered")
  ).rejects.toThrow("private metadata failure");
  expect(await fs.readFile(join(options.lockPath, "evidence"), "utf8")).toBe("preserve");
});

it("recovers when both cleanup attempts remove metadata before failing", async () => {
  let attempts = 0;
  const options = await fixture(async (path, removal) => {
    if (attempts++ < 2) {
      await fs.rm(join(path, "holder.json"), { force: true });
      await fs.rm(join(path, "external-writers-pending"), { recursive: true, force: true });
      throw new Error("metadata cleanup interrupted");
    }
    await fs.rm(path, removal);
  });
  await expect(
    withAdvisoryDirectoryLock(options, async (scope) => {
      await scope.runManagedCommand({ command: process.execPath, args: ["-e", "process.exit(0)"] });
    })
  ).rejects.toThrow("Directory lock release failed");
  const owner = (await fs.readdir(options.lockPath))[0];
  await expect(fs.access(join(options.lockPath, owner, "holder.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(
    fs.access(join(options.lockPath, owner, "external-writers-pending"))
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    withAdvisoryDirectoryLock(
      { ...options, timeoutMs: 100, retryDelayMs: 1 },
      async () => "recovered"
    )
  ).resolves.toBe("recovered");
});

function transientDenial(): Error {
  return Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
}

it("retries transient denials while retiring, removing, and pruning the released lease", async () => {
  const options = await fixture(fs.rm);
  const deniedOnce = new Set<string>();
  function denyFirst(key: string) {
    if (deniedOnce.has(key)) return;
    deniedOnce.add(key);
    throw transientDenial();
  }
  options.fs.rename = async (from, to) => {
    if (to.includes("drained-v2-")) denyFirst("rename");
    await fs.rename(from, to);
  };
  options.fs.rm = async (path, removal) => {
    if (path.includes("drained-v2-")) denyFirst("rm");
    await fs.rm(path, removal);
  };
  options.fs.rmdir = async (path) => {
    denyFirst("rmdir");
    await fs.rmdir(path);
  };
  await expect(withAdvisoryDirectoryLock(options, async () => "entered")).resolves.toBe("entered");
  expect(deniedOnce).toEqual(new Set(["rename", "rm", "rmdir"]));
  await expect(fs.access(options.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("leaves a stale empty root instead of failing release when its removal stays denied", async () => {
  const options = await fixture(fs.rm);
  options.fs.rmdir = async () => {
    throw transientDenial();
  };
  await expect(withAdvisoryDirectoryLock(options, async () => "entered")).resolves.toBe("entered");
  expect(await fs.readdir(options.lockPath)).toEqual([]);
  options.fs.rmdir = fs.rmdir;
  await expect(
    withAdvisoryDirectoryLock({ ...options, timeoutMs: 500 }, async () => "recovered")
  ).resolves.toBe("recovered");
});
