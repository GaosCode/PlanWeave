import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";

it.each([
  "held",
  "partial",
  "missing"
])("recovers a real owner exit at publication stage %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "planweave-lock-owner-exit-"));
  const lockPath = join(root, "lock");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./support/advisoryLockOwner.mjs", import.meta.url)),
      new URL("../fs/advisoryDirectoryLock.ts", import.meta.url).href,
      lockPath,
      mode
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  const closed = once(child, "close");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error(`Lock owner exited before readiness: ${stderr}`);
      })
    ]);
    expect(message).toMatchObject({
      event: mode === "held" ? "held" : "publishing",
      pid: child.pid
    });
    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "live-contender",
          timeoutMs: 50,
          retryDelayMs: 1
        },
        async () => "entered"
      )
    ).rejects.toThrow("Timed out acquiring directory lock");
    if (mode === "held") {
      const holder = JSON.parse(await readFile(join(lockPath, "holder.json"), "utf8"));
      expect(holder.pid).toBe(child.pid);
      expect(Date.now() - Date.parse(holder.acquiredAt)).toBeLessThan(60_000);
    } else if (mode === "partial") {
      expect(await readFile(join(lockPath, "holder.json"), "utf8")).toBe("{");
    } else {
      await expect(readFile(join(lockPath, "holder.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
    child.send("exit");
    expect(await closed).toEqual([0, null]);
    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "immediate-restart",
          timeoutMs: 500
        },
        async () => "recovered"
      )
    ).resolves.toBe("recovered");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
