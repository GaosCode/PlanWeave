import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { attachManagedProcessTree } from "../process/managedProcessTree.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
