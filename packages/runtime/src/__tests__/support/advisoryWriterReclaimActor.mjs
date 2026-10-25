import * as fs from "node:fs/promises";
import { join } from "node:path";

const { actor, lockPath, root, stage, oldName, moduleUrl, ownerModuleUrl } = JSON.parse(
  process.argv[2]
);
const { withAdvisoryDirectoryLock } = await import(moduleUrl);
const { defaultLockFs } = await import(ownerModuleUrl);
const queued = new Set();
const waiting = new Map();
process.on("message", (command) => {
  const resolve = waiting.get(command);
  if (resolve) {
    waiting.delete(command);
    resolve();
  } else queued.add(command);
});
function wait(command) {
  if (queued.delete(command)) return Promise.resolve();
  return new Promise((resolve) => waiting.set(command, resolve));
}
function send(event) {
  process.send({ event, actor, pid: process.pid });
}
let paused = false;
let resumed = false;
let blocked = false;
async function pause(path, window) {
  const target = join(lockPath, oldName ?? "", "external-writers-pending");
  if (
    actor !== "A" ||
    paused ||
    stage !== window ||
    path !== (window === "pending-lstat" ? target : join(target, "group-ready.json"))
  )
    return;
  paused = true;
  send("before-observation");
  await wait("resume");
  resumed = true;
}
const adapter = {
  ...defaultLockFs,
  async lstat(path) {
    await pause(path, "pending-lstat");
    return defaultLockFs.lstat(path);
  },
  async readFile(path, encoding) {
    await pause(path, "ready-read");
    return defaultLockFs.readFile(path, encoding);
  },
  async rename(from, to) {
    try {
      await defaultLockFs.rename(from, to);
    } catch (error) {
      if (resumed && !blocked && ["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY"].includes(error.code)) {
        blocked = true;
        send("blocked-on-successor");
        await wait("check-complete");
      }
      throw error;
    }
  }
};
try {
  await withAdvisoryDirectoryLock(
    { lockPath, operation: actor, fs: adapter, timeoutMs: 10000, retryDelayMs: 1 },
    async (scope) => {
      if (actor === "owner") {
        await scope.runManagedCommand({
          command: process.execPath,
          args: ["-e", "process.exit(0)"]
        });
        send("writer-drained");
        await wait("abandon");
        process.exit(0);
      }
      const sentinel = await fs.open(join(root, "occupied"), "wx");
      await sentinel.close();
      send("entered");
      await wait("release");
      await fs.unlink(join(root, "occupied"));
    }
  );
  send("complete");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.disconnect();
}
