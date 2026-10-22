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

async function fixture(rename: AdvisoryLockFs["rename"]) {
  const root = await fs.mkdtemp(join(tmpdir(), "planweave-lock-release-"));
  directories.push(root);
  const adapter: AdvisoryLockFs = {
    readdir: (path) => fs.readdir(path),
    mkdir: async (path) => {
      await fs.mkdir(path);
    },
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    readFile: (path, encoding) => fs.readFile(path, encoding),
    rename,
    rm: (path, options) => fs.rm(path, options),
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
  const options = await fixture(async (from, to) => {
    if (!failed) {
      failed = true;
      throw releaseError;
    }
    await fs.rename(from, to);
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
  let holderPath = "";
  const replacement = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    operation: "replacement",
    ownerToken: "replacement-owner"
  };
  const options = await fixture(async () => {
    await fs.writeFile(holderPath, JSON.stringify(replacement));
    throw releaseError;
  });
  holderPath = join(options.lockPath, "holder.json");
  await expect(withAdvisoryDirectoryLock(options, async () => "first")).rejects.toBe(releaseError);
  expect(JSON.parse(await fs.readFile(holderPath, "utf8"))).toEqual(replacement);
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
    JSON.parse(await fs.readFile(join(options.lockPath, "holder.json"), "utf8"))
  ).toMatchObject({ pid: process.pid, operation: options.operation });
});
