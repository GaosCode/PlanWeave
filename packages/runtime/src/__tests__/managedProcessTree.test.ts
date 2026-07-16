import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachManagedProcessTree,
  createFakeProcessTreeAdapter,
  createHostProcessTreeAdapter,
  createPosixProcessTreeAdapter,
  createWindowsProcessTreeAdapter,
  DEFAULT_PROCESS_TREE_GRACE_MS,
  spawnManagedProcess,
  windowsTaskKillArgs,
  type ManagedProcessTree
} from "../process/managedProcessTree.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error("Timed out waiting for condition.");
}

async function forceReap(pid: number | null | undefined): Promise<void> {
  if (pid === null || pid === undefined || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ignore
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}

describe("managedProcessTree contract (fake adapter)", () => {
  it("shares one terminate promise across concurrent callers", async () => {
    let alive = true;
    let gracefulCalls = 0;
    let forceCalls = 0;
    const signals: Array<{ kind: "graceful" | "force"; pid: number }> = [];
    const adapter = createFakeProcessTreeAdapter({
      signals,
      isAlive: () => alive,
      onGraceful: async () => {
        gracefulCalls += 1;
        await sleep(20);
        alive = false;
      },
      onForce: async () => {
        forceCalls += 1;
        alive = false;
      }
    });

    const child = {
      exitCode: null,
      signalCode: null,
      once(event: string, listener: (...args: unknown[]) => void) {
        if (event === "exit") {
          const poll = setInterval(() => {
            if (!alive) {
              clearInterval(poll);
              (child as { exitCode: number }).exitCode = 1;
              listener(1, null);
            }
          }, 5);
        }
        return child;
      }
    } as unknown as ChildProcessWithoutNullStreams;

    const tree = attachManagedProcessTree({
      child,
      pid: 42_424,
      adapter,
      graceMs: 50
    });

    const first = tree.terminate("timeout");
    const second = tree.terminate("cancel");
    const third = tree.terminate("limit");
    expect(second).toBe(first);
    expect(third).toBe(first);

    const result = await first;
    expect(result).toEqual({ outcome: "graceful", reason: "timeout" });
    expect(gracefulCalls).toBe(1);
    expect(forceCalls).toBe(1);
    expect(signals).toEqual([
      { kind: "graceful", pid: 42_424 },
      { kind: "force", pid: 42_424 }
    ]);
  });

  it("escalates to force when the tree ignores graceful termination", async () => {
    let alive = true;
    const signals: Array<{ kind: "graceful" | "force"; pid: number }> = [];
    const adapter = createFakeProcessTreeAdapter({
      signals,
      isAlive: () => alive,
      onGraceful: () => {
        // ignore
      },
      onForce: () => {
        alive = false;
      }
    });

    const child = {
      exitCode: null,
      signalCode: null,
      once(event: string, listener: (...args: unknown[]) => void) {
        if (event === "exit") {
          const poll = setInterval(() => {
            if (!alive) {
              clearInterval(poll);
              (child as { exitCode: number }).exitCode = 1;
              listener(1, "SIGKILL");
            }
          }, 5);
        }
        return child;
      }
    } as unknown as ChildProcessWithoutNullStreams;

    const tree = attachManagedProcessTree({
      child,
      pid: 55_001,
      adapter,
      graceMs: 30
    });

    await expect(tree.terminate("timeout")).resolves.toEqual({
      outcome: "forced",
      reason: "timeout"
    });
    expect(signals).toEqual([
      { kind: "graceful", pid: 55_001 },
      { kind: "force", pid: 55_001 }
    ]);
  });

  it("treats already-exited trees as idempotent success", async () => {
    const adapter = createFakeProcessTreeAdapter({
      isAlive: () => false
    });
    const child = {
      exitCode: 0,
      signalCode: null,
      once() {
        return child;
      }
    } as unknown as ChildProcessWithoutNullStreams;

    const tree = attachManagedProcessTree({
      child,
      pid: 77_001,
      adapter,
      graceMs: 10
    });

    await expect(tree.terminate("dispose")).resolves.toEqual({
      outcome: "already_exited",
      reason: "dispose"
    });
    await expect(tree.terminate("again")).resolves.toEqual({
      outcome: "already_exited",
      reason: "dispose"
    });
  });

  it("surfaces real EPERM from the graceful signal path", async () => {
    const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const adapter = createFakeProcessTreeAdapter({
      isAlive: () => true,
      onGraceful: () => {
        throw eperm;
      }
    });
    const child = {
      exitCode: null,
      signalCode: null,
      once() {
        return child;
      }
    } as unknown as ChildProcessWithoutNullStreams;

    const tree = attachManagedProcessTree({
      child,
      pid: 88_001,
      adapter,
      graceMs: 10
    });

    await expect(tree.terminate("cancel")).rejects.toMatchObject({ code: "EPERM" });
  });

  it("refuses invalid or self pids", () => {
    expect(() => windowsTaskKillArgs(-1, true)).toThrow("Invalid managed process pid");
    expect(() => windowsTaskKillArgs(process.pid, false)).toThrow(
      "Refusing to terminate the current PlanWeave process"
    );
  });
});

describe("platform adapters", () => {
  it("selects windows vs posix adapters by platform", () => {
    expect(createHostProcessTreeAdapter("win32").name).toBe("windows");
    expect(createHostProcessTreeAdapter("darwin").name).toBe("posix");
    expect(createHostProcessTreeAdapter("linux").name).toBe("posix");
  });

  it("builds taskkill argv without shell concatenation", () => {
    expect(windowsTaskKillArgs(1234, false)).toEqual(["/pid", "1234", "/t"]);
    expect(windowsTaskKillArgs(1234, true)).toEqual(["/pid", "1234", "/t", "/f"]);
    const windows = createWindowsProcessTreeAdapter();
    const configured = windows.configureSpawn({ stdio: "ignore" });
    expect(configured.shell).toBe(false);
    expect(configured.detached).toBe(false);
  });

  it("runs taskkill through the shared argv helper with shell:false (graceful and force)", async () => {
    const spawns: Array<{
      command: string;
      args: readonly string[];
      options: { shell?: boolean; windowsHide?: boolean; stdio?: unknown };
    }> = [];
    const spawnTaskKill = ((
      command: string,
      args: readonly string[],
      options: { shell?: boolean; windowsHide?: boolean; stdio?: unknown }
    ) => {
      spawns.push({ command, args, options });
      const handlers: { error?: (error: Error) => void; close?: (code: number | null) => void } =
        {};
      queueMicrotask(() => handlers.close?.(0));
      return {
        once(event: string, listener: (...args: unknown[]) => void) {
          if (event === "error") {
            handlers.error = listener as (error: Error) => void;
          }
          if (event === "close") {
            handlers.close = listener as (code: number | null) => void;
          }
          return this;
        }
      };
    }) as unknown as import("../process/managedProcessTree.js").TaskKillSpawnFn;

    const adapter = createWindowsProcessTreeAdapter({
      spawnTaskKill,
      isAlive: () => false
    });

    await adapter.signalGraceful(4_321);
    await adapter.signalForce(4_321);

    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toMatchObject({
      command: "taskkill",
      args: windowsTaskKillArgs(4_321, false),
      options: { shell: false, windowsHide: true, stdio: "ignore" }
    });
    expect(spawns[1]).toMatchObject({
      command: "taskkill",
      args: windowsTaskKillArgs(4_321, true),
      options: { shell: false, windowsHide: true, stdio: "ignore" }
    });
  });

  it("maps taskkill not-found (non-zero + dead root) to success and access-denied to EPERM", async () => {
    const spawnWithExit = (exitCode: number) =>
      ((
        _command: string,
        _args: readonly string[],
        _options: unknown
      ) => {
        const handlers: { close?: (code: number | null) => void; error?: (error: Error) => void } =
          {};
        queueMicrotask(() => handlers.close?.(exitCode));
        return {
          once(event: string, listener: (...args: unknown[]) => void) {
            if (event === "close") {
              handlers.close = listener as (code: number | null) => void;
            }
            if (event === "error") {
              handlers.error = listener as (error: Error) => void;
            }
            return this;
          }
        };
      }) as unknown as import("../process/managedProcessTree.js").TaskKillSpawnFn;

    const notFound = createWindowsProcessTreeAdapter({
      spawnTaskKill: spawnWithExit(128),
      isAlive: () => false
    });
    await expect(notFound.signalGraceful(9_001)).resolves.toBeUndefined();

    const denied = createWindowsProcessTreeAdapter({
      spawnTaskKill: spawnWithExit(1),
      isAlive: () => true
    });
    await expect(denied.signalForce(9_002)).rejects.toMatchObject({ code: "EPERM" });

    const spawnError = createWindowsProcessTreeAdapter({
      spawnTaskKill: ((_command, _args, _options) => {
        const handlers: { error?: (error: Error) => void } = {};
        queueMicrotask(() =>
          handlers.error?.(Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }))
        );
        return {
          once(event: string, listener: (...args: unknown[]) => void) {
            if (event === "error") {
              handlers.error = listener as (error: Error) => void;
            }
            return this;
          }
        };
      }) as unknown as import("../process/managedProcessTree.js").TaskKillSpawnFn,
      isAlive: () => true
    });
    await expect(spawnError.signalGraceful(9_003)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("configures posix spawn as a detached process-group leader", () => {
    const posix = createPosixProcessTreeAdapter();
    const configured = posix.configureSpawn({ stdio: ["pipe", "pipe", "pipe"] });
    expect(configured.detached).toBe(true);
    expect(configured.shell).toBe(false);
  });

  it("uses a non-negative default grace", () => {
    expect(DEFAULT_PROCESS_TREE_GRACE_MS).toBe(500);
  });
});

describe("posix process-group grandchild termination", () => {
  const trees: ManagedProcessTree[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    for (const tree of trees.splice(0)) {
      try {
        await tree.terminate("test-cleanup");
      } catch {
        // best effort
      }
    }
    for (const pid of pids.splice(0)) {
      await forceReap(pid);
    }
  });

  it.runIf(process.platform !== "win32")(
    "kills a SIGTERM-resistant grandchild that direct child.kill would leave behind",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "planweave-process-tree-"));
      const childPidPath = join(dir, "child.pid");
      const grandchildPidPath = join(dir, "grandchild.pid");
      const heartbeatPath = join(dir, "heartbeat.txt");

      const parentSource = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const childPidPath = ${JSON.stringify(childPidPath)};
const grandchildPidPath = ${JSON.stringify(grandchildPidPath)};
const heartbeatPath = ${JSON.stringify(heartbeatPath)};
fs.writeFileSync(childPidPath, String(process.pid));
const g = spawn(process.execPath, ["-e", ${JSON.stringify(`
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(heartbeatPath)}, "start");
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"), 40);
`)}], { stdio: "ignore" });
g.unref();
setInterval(() => {}, 100);
`;

      // Baseline: direct kill of non-group child leaves the grandchild.
      const baseline = spawn(process.execPath, ["-e", parentSource], {
        cwd: dir,
        stdio: ["ignore", "ignore", "ignore"]
      });
      await waitUntil(async () => {
        try {
          await readFile(grandchildPidPath, "utf8");
          return true;
        } catch {
          return false;
        }
      });
      const baselineChildPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
      const baselineGrandchildPid = Number.parseInt(await readFile(grandchildPidPath, "utf8"), 10);
      pids.push(baselineChildPid, baselineGrandchildPid);
      baseline.kill("SIGKILL");
      await waitUntil(() => !isAlive(baselineChildPid));
      // Grandchild may still be alive after killing only the direct child.
      expect(isAlive(baselineGrandchildPid)).toBe(true);
      await forceReap(baselineGrandchildPid);
      await forceReap(baselineChildPid);
      await writeFile(childPidPath, "", "utf8");
      await writeFile(grandchildPidPath, "", "utf8");
      await writeFile(heartbeatPath, "", "utf8");

      // Managed tree: process-group terminate reaps child and grandchild.
      const managed = spawnManagedProcess({
        command: process.execPath,
        args: ["-e", parentSource],
        cwd: dir,
        graceMs: 40
      });
      trees.push(managed.tree);
      pids.push(managed.tree.pid);

      await waitUntil(async () => {
        try {
          const text = await readFile(grandchildPidPath, "utf8");
          return text.trim().length > 0;
        } catch {
          return false;
        }
      });
      const managedChildPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
      const managedGrandchildPid = Number.parseInt(await readFile(grandchildPidPath, "utf8"), 10);
      pids.push(managedChildPid, managedGrandchildPid);
      expect(managedChildPid).toBe(managed.tree.pid);
      expect(managedGrandchildPid).not.toBe(managedChildPid);
      expect(isAlive(managedGrandchildPid)).toBe(true);

      const result = await managed.tree.terminate("timeout");
      expect(["graceful", "forced"]).toContain(result.outcome);

      await waitUntil(() => !isAlive(managedChildPid) && !isAlive(managedGrandchildPid));
      expect(isAlive(managedChildPid)).toBe(false);
      expect(isAlive(managedGrandchildPid)).toBe(false);

      const sizeAfterExit = (await readFile(heartbeatPath)).byteLength;
      await sleep(120);
      const sizeAfterQuiet = (await readFile(heartbeatPath)).byteLength;
      expect(sizeAfterQuiet).toBe(sizeAfterExit);
    }
  );

  it.runIf(process.platform === "win32")(
    "skips posix process-group grandchild integration on Windows",
    () => {
      expect(createHostProcessTreeAdapter().name).toBe("windows");
    }
  );
});
