import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { defaultLockFs, removeExactLockOwner } from "../fs/advisoryLockOwner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-reclaim-"));
  roots.push(root);
  const lockPath = join(root, "lock");
  const token = randomUUID();
  const name = `lease-v2-2147483647-${token}`;
  const ownerPath = join(lockPath, name);
  const pending = join(ownerPath, "external-writers-pending");
  const ready = join(pending, "group-ready.json");
  await mkdir(pending, { recursive: true });
  await writeFile(
    join(ownerPath, "holder.json"),
    JSON.stringify({
      version: 2,
      pid: 2147483647,
      ownerToken: token,
      operation: "old-build",
      acquiredAt: new Date().toISOString()
    })
  );
  await writeFile(ready, JSON.stringify({ version: 1, kind: "posix", pgid: 2147483646 }));
  return { root, lockPath, name, ownerPath, pending, ready };
}
it.each([
  "pending-lstat",
  "ready-read"
])("retries %s within the original budget only after the observed UUID disappears", async (stage) => {
  const f = await fixture();
  let crossed = false;
  async function removeAt(path: string, window: string) {
    if (
      !crossed &&
      window === stage &&
      path === (stage === "pending-lstat" ? f.pending : f.ready)
    ) {
      crossed = true;
      await removeExactLockOwner(f.lockPath, f.name, defaultLockFs);
    }
  }
  await expect(
    withAdvisoryDirectoryLock(
      {
        lockPath: f.lockPath,
        operation: "retry",
        timeoutMs: 500,
        fs: {
          ...defaultLockFs,
          async lstat(path) {
            await removeAt(path, "pending-lstat");
            return defaultLockFs.lstat(path);
          },
          async readFile(path, encoding) {
            await removeAt(path, "ready-read");
            return defaultLockFs.readFile(path, encoding);
          }
        }
      },
      async () => "entered"
    )
  ).resolves.toBe("entered");
  expect(crossed).toBe(true);
  expect(await readdir(f.root)).toEqual([]);
});
it.each([
  "missing",
  "corrupt",
  "unknown-entry",
  "EIO"
])("retains a still-present old UUID when writer observation fails: %s", async (failure) => {
  const f = await fixture();
  if (failure === "missing") await rm(f.ready);
  if (failure === "corrupt") await writeFile(f.ready, "{");
  if (failure === "unknown-entry")
    await writeFile(join(f.ownerPath, "unknown"), "owned-by-someone");
  const holder = await readFile(join(f.ownerPath, "holder.json"), "utf8");
  let entered = false;
  await expect(
    withAdvisoryDirectoryLock(
      {
        lockPath: f.lockPath,
        operation: "fail-closed",
        fs: {
          ...defaultLockFs,
          async lstat(path) {
            if (failure === "EIO" && path === f.pending)
              throw Object.assign(new Error("observation EIO"), { code: "EIO" });
            return defaultLockFs.lstat(path);
          }
        }
      },
      async () => {
        entered = true;
      }
    )
  ).rejects.toThrow(
    failure === "unknown-entry"
      ? "WRITER_GROUP_INVALID"
      : failure === "EIO"
        ? "observation EIO"
        : "WRITER_GROUP_UNREGISTERED"
  );
  expect(entered).toBe(false);
  expect(await readdir(f.lockPath)).toEqual([f.name]);
  expect(await readFile(join(f.ownerPath, "holder.json"), "utf8")).toBe(holder);
});
it.skipIf(process.platform === "win32")(
  "does not reclaim an exited owner while its registered writer group is alive",
  async () => {
    const f = await fixture();
    const writer = spawn(
      process.execPath,
      ["-e", "process.send('ready');setInterval(()=>{},1000)"],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    const closed = once(writer, "close");
    try {
      await once(writer, "message");
      if (!writer.pid) throw new Error("Writer did not start");
      await writeFile(f.ready, JSON.stringify({ version: 1, kind: "posix", pgid: writer.pid }));
      await expect(
        withAdvisoryDirectoryLock(
          { lockPath: f.lockPath, operation: "live-writer", timeoutMs: 50, retryDelayMs: 1 },
          async () => "entered"
        )
      ).rejects.toThrow("Timed out acquiring directory lock");
      expect(await readdir(f.lockPath)).toEqual([f.name]);
    } finally {
      writer.kill("SIGKILL");
      await closed;
    }
  }
);
it("preserves observation and identity errors when absence cannot be confirmed", async () => {
  const f = await fixture();
  const observationError = Object.assign(new Error("pending unavailable"), { code: "ENOENT" });
  const identityError = Object.assign(new Error("identity unavailable"), { code: "EIO" });
  let observingFailed = false;
  await expect(
    withAdvisoryDirectoryLock(
      {
        lockPath: f.lockPath,
        operation: "uncertain-identity",
        fs: {
          ...defaultLockFs,
          async lstat(path) {
            if (path === f.pending) {
              observingFailed = true;
              throw observationError;
            }
            if (observingFailed && path === f.ownerPath) throw identityError;
            return defaultLockFs.lstat(path);
          }
        }
      },
      async () => "entered"
    )
  ).rejects.toMatchObject({ errors: [observationError, identityError] });
  expect(await readdir(f.lockPath)).toEqual([f.name]);
});
