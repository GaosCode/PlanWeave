import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { attachManagedProcessTree, spawnManagedProcess } from "../process/managedProcessTree.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("allows a Windows Job query to finish independently of a short signal grace", async () => {
  let forced = false;
  const managed = spawnManagedProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    graceMs: 1,
    adapter: {
      name: "windows",
      configureSpawn: (options) => options,
      isAlive: () => managed.child.exitCode === null && managed.child.signalCode === null,
      isTreeAlive: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return !forced;
      },
      signalGraceful: () => undefined,
      signalForce: () => {
        forced = true;
        managed.child.kill();
      },
      awaitTreeExit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return forced;
      }
    }
  });
  try {
    await expect(managed.tree.terminate("cancel")).resolves.toMatchObject({ reason: "cancel" });
    expect(managed.tree.isAlive()).toBe(false);
  } finally {
    managed.child.kill("SIGKILL");
    await managed.tree.exited;
  }
});

it.each([
  false,
  true
])("starts force-exit confirmation after an asynchronous signal (graceful failure=%s)", async (gracefulFailure) => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const child = new ChildProcess() as ChildProcessWithoutNullStreams;
  let alive = true;
  let forced = false;
  const tree = attachManagedProcessTree({
    child,
    pid: 88_101,
    graceMs: 0,
    forceExitConfirmMs: 20,
    adapter: {
      name: "windows",
      configureSpawn: (options) => options,
      isAlive: () => child.exitCode === null,
      isTreeAlive: () => alive,
      signalGraceful: () => {
        if (gracefulFailure) throw Object.assign(new Error("taskkill failed"), { code: "EPERM" });
      },
      signalForce: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        forced = true;
      },
      awaitTreeExit: async () => {
        if (!forced) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
        alive = false;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        return true;
      }
    }
  });
  await Promise.all([
    expect(tree.terminate("cancel")).resolves.toMatchObject({ reason: "cancel" }),
    vi.runAllTimersAsync()
  ]);
  expect(alive).toBe(false);
});

it("does not reset a shared deadline after an asynchronous force signal", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const started = performance.now();
  const expiresAt = started + 35;
  const child = new ChildProcess() as ChildProcessWithoutNullStreams;
  const waits: number[] = [];
  const tree = attachManagedProcessTree({
    child,
    pid: 88_102,
    graceMs: 0,
    forceExitConfirmMs: 20,
    adapter: {
      name: "windows",
      configureSpawn: (options) => options,
      isAlive: () => true,
      isTreeAlive: () => true,
      signalGraceful: () => undefined,
      signalForce: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      awaitTreeExit: async (_pid, timeoutMs) => {
        waits.push(timeoutMs);
        await new Promise(() => undefined);
        return true;
      }
    }
  });
  const result = expect(
    tree.terminate("cancel", {
      deadline: { expiresAt, remainingMs: () => Math.max(0, expiresAt - performance.now()) }
    })
  ).rejects.toThrow("did not exit after force termination");
  await vi.advanceTimersByTimeAsync(35);
  await result;
  expect(waits).toEqual([5]);
  expect(performance.now() - started).toBe(35);
});

const cases = ["already-exited", "tree-final", "success-final"].flatMap((stage) =>
  [false, true].flatMap((deadline) =>
    ["slow", "unsettled"].map((probe) => ({ stage, deadline, probe }))
  )
);

it.each(
  cases
)("bounds $probe $stage confirmation within the existing budget (shared deadline=$deadline)", async ({
  stage,
  deadline,
  probe
}) => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  await once(child, "close");
  if (!child.pid) throw new Error("Missing real exited child pid");
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const started = performance.now();
  const expiresAt = started + 20;
  let probes = 0;
  let repaired = false;
  const firstSlowProbe = stage === "success-final" ? 3 : 2;
  const tree = attachManagedProcessTree({
    child,
    pid: child.pid,
    graceMs: 20,
    forceExitConfirmMs: 20,
    adapter: {
      name: "windows",
      configureSpawn: (options) => options,
      isAlive: () => false,
      isTreeAlive: async () => {
        probes++;
        if (repaired) return false;
        if (probes === 1) return stage !== "already-exited";
        if (probes < firstSlowProbe) return false;
        if (probe === "slow") await new Promise((resolve) => setTimeout(resolve, 120));
        else await new Promise(() => undefined);
        return false;
      },
      awaitTreeExit: async () => {
        if (stage === "tree-final") await new Promise((resolve) => setTimeout(resolve, 12));
        return true;
      },
      signalGraceful: () => undefined,
      signalForce: () => undefined
    }
  });
  let result: "pending" | "success" | "failure" = "pending";
  const cancellation = tree.terminate(
    "first cancel",
    deadline
      ? {
          deadline: { expiresAt, remainingMs: () => Math.max(0, expiresAt - performance.now()) }
        }
      : {}
  );
  void cancellation.then(
    () => {
      result = "success";
    },
    () => {
      result = "failure";
    }
  );
  await vi.advanceTimersByTimeAsync(deadline ? 20 : 40);
  expect(result, "an async confirmation must settle without waiting for its own watchdog").toBe(
    "failure"
  );
  await expect(cancellation).rejects.toThrow();
  expect(performance.now() - started).toBeLessThanOrEqual(deadline ? 20 : 40);
  repaired = true;
  await expect(tree.terminate("retry cancel")).resolves.toMatchObject({ reason: "retry cancel" });
  await vi.advanceTimersByTimeAsync(240);
  await expect(tree.terminate("cached real success")).resolves.toMatchObject({
    reason: "retry cancel"
  });
});
