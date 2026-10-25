import * as fs from "node:fs/promises";
import { join } from "node:path";

const request = JSON.parse(process.argv[2]);
const { actor, root, lockPath, moduleUrl, oldName } = request;
const commands = new Set();
const waiting = new Map();
process.on("message", (command) => {
  const done = waiting.get(command);
  if (done) {
    waiting.delete(command);
    done();
  } else commands.add(command);
});
function wait(command) {
  if (commands.delete(command)) return Promise.resolve();
  return new Promise((resolve) => waiting.set(command, resolve));
}
function send(event, extra = {}) {
  process.send({ event, actor, pid: process.pid, ...extra });
}
const { withAdvisoryDirectoryLock } = await import(moduleUrl);
let paused = false;
let cleanupDone = false;
let contended = false;
let observedOldOwner = false;
async function beforeCleanup() {
  if (!observedOldOwner) throw new Error("Cleanup barrier reached without reading the old owner");
  paused = true;
  send("before-cleanup", { observedOldOwner });
  await wait("resume-cleanup");
}
async function afterCleanup() {
  cleanupDone = true;
  send("after-cleanup");
  await wait("finish-cleanup");
}
const adapter = {
  ...fs,
  readFile: async (path, encoding) => {
    const raw = await fs.readFile(path, encoding);
    if (
      actor === "A" &&
      [join(lockPath, "holder.json"), join(lockPath, oldName, "holder.json")].includes(path)
    )
      observedOldOwner ||= JSON.parse(raw).pid === 2147483647;
    return raw;
  },
  optionalStat: async (path) => {
    try {
      return await fs.stat(path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  rename: async (from, to) => {
    const pause = actor === "A" && [lockPath, join(lockPath, oldName)].includes(from) && !paused;
    if (pause) await beforeCleanup();
    try {
      await fs.rename(from, to);
    } catch (error) {
      if (pause && error.code === "ENOENT") await afterCleanup();
      if (to === lockPath && ["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"].includes(error.code)) {
        if (cleanupDone) send("blocked-after-cleanup");
        else if (!contended) {
          contended = true;
          send("contended");
        }
      }
      throw error;
    }
    if (pause) await afterCleanup();
  },
  rm: async (path, options) => {
    const pause = actor === "A" && path === join(lockPath, oldName) && !paused;
    if (pause) await beforeCleanup();
    await fs.rm(path, options);
    if (pause) await afterCleanup();
  }
};
try {
  await withAdvisoryDirectoryLock(
    {
      lockPath,
      operation: actor,
      timeoutMs: 5000,
      retryDelayMs: 1,
      fs: adapter
    },
    async () => {
      const sentinel = join(root, "occupied");
      let exclusive = true;
      try {
        await (await fs.open(sentinel, "wx")).close();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        exclusive = false;
      }
      await fs.appendFile(
        join(root, "trace.jsonl"),
        `${JSON.stringify({ event: "enter", actor, pid: process.pid, exclusive })}\n`
      );
      send("entered", { exclusive });
      await wait("release");
      await fs.appendFile(
        join(root, "trace.jsonl"),
        `${JSON.stringify({ event: "exit", actor, pid: process.pid })}\n`
      );
      if (exclusive) await fs.unlink(sentinel);
      send("left");
    }
  );
  send("complete");
} catch (error) {
  send("failed", { message: String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
