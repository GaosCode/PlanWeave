import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  attachManagedProcessTree,
  createWindowsProcessTreeAdapter
} from "../process/managedProcessTree.js";

it.each([
  false,
  true
])("confirms launcher exit and rechecks a late Job before caching termination (lateJob=%s)", async (lateJob) => {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
    stdio: ["pipe", "pipe", "pipe", "ipc"]
  });
  const closed = once(child, "close");
  await once(child, "message");
  if (!child.pid) throw new Error("launcher did not start");
  let jobAlive = false;
  child.once("exit", () => {
    if (lateJob) jobAlive = true;
  });
  let forceFails = true;
  let jobTerminations = 0;
  const adapter = createWindowsProcessTreeAdapter({
    job: { name: "Local\\launcher-test", markerPath: "unused", helperPath: "unused" },
    isTreeAlive: () => jobAlive,
    awaitTreeExit: async () => !jobAlive,
    spawnTaskKill: (_command, args) => {
      if (args.includes("/f") && forceFails)
        return spawn(process.execPath, ["-e", "process.exit(1)"]);
      if (!forceFails) child.kill();
      return spawn(process.execPath, ["-e", "process.exit(0)"]);
    },
    terminateJob: () => {
      jobTerminations++;
      if (!forceFails) jobAlive = false;
    }
  });
  const tree = attachManagedProcessTree({
    child,
    pid: child.pid,
    adapter,
    graceMs: 10,
    forceExitConfirmMs: 40
  });
  try {
    await expect(tree.terminate("first cancel")).rejects.toThrow();
    expect(child.exitCode).toBeNull();
    forceFails = false;
    await expect(tree.terminate("second cancel")).resolves.toMatchObject({
      reason: "second cancel"
    });
    await closed;
    expect(jobAlive).toBe(false);
    expect(jobTerminations).toBeGreaterThan(0);
    await expect(tree.terminate("third cancel")).resolves.toMatchObject({
      reason: "second cancel"
    });
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});
