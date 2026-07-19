import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  type ManagedProcessTree,
  type ProcessTreePlatformAdapter
} from "../process/managedProcessTree.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
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
    const signals: Array<{ kind: "graceful" | "force"; pid: number }> = [];
    const adapter = createFakeProcessTreeAdapter({
      signals,
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
    expect(signals).toEqual([{ kind: "force", pid: 77_001 }]);
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

  it("uses the Windows Job to force cleanup when graceful taskkill fails", async () => {
    let forceCalls = 0;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.pid === undefined) throw new Error("Expected Windows force test child pid.");
    const adapter: ProcessTreePlatformAdapter = {
      name: "windows",
      configureSpawn: (options) => options,
      signalGraceful: () => {
        throw Object.assign(new Error("taskkill failed"), { code: "EPERM" });
      },
      signalForce: () => {
        forceCalls += 1;
        child.kill("SIGKILL");
      },
      isAlive: () => child.exitCode === null && child.signalCode === null
    };
    const tree = attachManagedProcessTree({ child, pid: child.pid, adapter, graceMs: 10_000 });

    await expect(tree.terminate("taskkill failed")).resolves.toEqual({
      outcome: "forced",
      reason: "taskkill failed"
    });
    expect(forceCalls).toBe(1);
  });

  it("preserves graceful taskkill and Windows Job force failures", async () => {
    const gracefulError = Object.assign(new Error("taskkill access denied"), { code: "EPERM" });
    const forceError = Object.assign(new Error("job access denied"), { code: "EPERM" });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.pid === undefined) throw new Error("Expected Windows force-failure test child pid.");
    const adapter: ProcessTreePlatformAdapter = {
      name: "windows",
      configureSpawn: (options) => options,
      signalGraceful: () => {
        throw gracefulError;
      },
      signalForce: () => {
        throw forceError;
      },
      isAlive: () => true
    };
    const tree = attachManagedProcessTree({ child, pid: child.pid, adapter, graceMs: 10_000 });

    try {
      let terminationError: unknown;
      try {
        await tree.terminate("taskkill and Job failed");
      } catch (error) {
        terminationError = error;
      }

      expect(terminationError).toBeInstanceOf(AggregateError);
      if (!(terminationError instanceof AggregateError)) {
        throw new Error("Expected graceful and force failures to be aggregated.");
      }
      expect(terminationError.errors).toEqual([gracefulError, forceError]);
      expect(terminationError.message).toContain("Force failure: job access denied");
    } finally {
      child.kill("SIGKILL");
      await tree.exited;
    }
  });

  it("bounds exit confirmation when Windows Job force reports success", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.pid === undefined) throw new Error("Expected Windows bounded-exit test child pid.");
    const adapter: ProcessTreePlatformAdapter = {
      name: "windows",
      configureSpawn: (options) => options,
      signalGraceful: () => {
        throw Object.assign(new Error("taskkill failed"), { code: "EPERM" });
      },
      signalForce: () => {},
      isAlive: () => child.exitCode === null && child.signalCode === null
    };
    const tree = attachManagedProcessTree({ child, pid: child.pid, adapter, graceMs: 20 });

    try {
      await expect(tree.terminate("force did not exit")).rejects.toThrow(
        "did not exit after force termination"
      );
    } finally {
      child.kill("SIGKILL");
      await tree.exited;
    }
  });

  it("forces immediately when the root exits between liveness and graceful signaling", async () => {
    let alive = true;
    let exitListener: (() => void) | undefined;
    const signals: Array<{ kind: "graceful" | "force"; pid: number }> = [];
    const child = {
      exitCode: null,
      signalCode: null,
      once(event: string, listener: () => void) {
        if (event === "exit") exitListener = listener;
        return child;
      }
    } as unknown as ChildProcessWithoutNullStreams;
    const adapter = createFakeProcessTreeAdapter({
      signals,
      isAlive: () => alive,
      onGraceful: () => {
        alive = false;
        (child as { exitCode: number | null }).exitCode = 0;
        exitListener?.();
        throw Object.assign(new Error("root exited"), { code: "ECHILD" });
      }
    });
    const tree = attachManagedProcessTree({ child, pid: 88_002, adapter, graceMs: 10_000 });

    await expect(tree.terminate("race")).resolves.toEqual({ outcome: "graceful", reason: "race" });
    expect(signals).toEqual([
      { kind: "graceful", pid: 88_002 },
      { kind: "force", pid: 88_002 }
    ]);
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

  it("runs graceful and force taskkill through the shared argv helper with shell:false", async () => {
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
      isAlive: () => true,
      job: {
        name: "Local\\PlanWeave-test",
        markerPath: "/tmp/planweave-test-owner-marker",
        helperPath: "windowsJobProcess.ps1"
      },
      terminateJob: () => {}
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

  it("always opens the owner-independent named Job even when root and marker are absent", async () => {
    const terminated: string[] = [];
    const adapter = createWindowsProcessTreeAdapter({
      job: {
        name: "Local\\PlanWeave-test",
        markerPath: "/tmp/planweave-nonexistent-owner-marker",
        helperPath: "windowsJobProcess.ps1"
      },
      isAlive: () => false,
      terminateJob: (job) => {
        terminated.push(job.name);
      }
    });

    await adapter.signalForce(4_322);
    expect(terminated).toEqual(["Local\\PlanWeave-test"]);
  });

  it("never treats taskkill root-not-found as proof that the managed tree is gone", async () => {
    const spawnWithExit = (exitCode: number) =>
      ((_command: string, _args: readonly string[], _options: unknown) => {
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
    await expect(notFound.signalGraceful(9_001)).rejects.toMatchObject({ code: "ECHILD" });

    const denied = createWindowsProcessTreeAdapter({
      spawnTaskKill: spawnWithExit(1),
      isAlive: () => true
    });
    await expect(denied.signalGraceful(9_002)).rejects.toMatchObject({ code: "EPERM" });

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

describe("host process-tree grandchild termination", () => {
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

  it.runIf(process.platform === "win32")(
    "preserves Windows PATHEXT batch lookup, arguments, cwd, env, stdio, and exit code",
    async () => {
      const baseDir = await mkdtemp(join(tmpdir(), "planweave-windows-owner-contract-"));
      const dir = join(baseDir, "cwd space %PLANWEAVE_BATCH_PATH%");
      await mkdir(dir);
      const executable = join(dir, "planweave-path-probe.cmd");
      const source =
        "process.stdout.write(JSON.stringify({cwd:process.cwd(),env:process.env.PLANWEAVE_OWNER_PROBE,args:process.argv.slice(1)}));process.exit(23);";
      await writeFile(
        executable,
        `@echo off\r\n"${process.execPath}" -e "${source}" %*\r\n`,
        "utf8"
      );
      const probeArgs = [
        "plain",
        "space value",
        'amp&pipe|percent%caret^quote"trail\\',
        "%PATH%",
        "paired%%percent"
      ];
      const managed = spawnManagedProcess({
        command: "planweave-path-probe",
        args: probeArgs,
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir};${process.env.PATH ?? ""}`,
          PATHEXT: ".CMD;.EXE;.COM;.BAT",
          PLANWEAVE_BATCH_PATH: "unexpected-expanded-path",
          PLANWEAVE_OWNER_PROBE: "ok"
        }
      });
      trees.push(managed.tree);
      let stdout = "";
      managed.child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        managed.child.once("error", reject);
        managed.child.once("close", resolveExit);
      });

      expect(exitCode).toBe(23);
      expect(JSON.parse(stdout)).toEqual({ cwd: dir, env: "ok", args: probeArgs });
      expect(managed.child.pid).toBe(managed.tree.pid);
    },
    30_000
  );

  it.runIf(process.platform === "win32")(
    "preserves child_process error semantics when the target executable cannot be resolved",
    async () => {
      const managed = spawnManagedProcess({
        command: `planweave-missing-${Date.now()}`,
        args: []
      });

      await expect(
        new Promise<void>((_resolveError, reject) => {
          managed.child.once("error", reject);
        })
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(managed.tree.pid).toBe(-1);
    }
  );

  it.runIf(process.platform === "win32")(
    "closes the named Job when the PlanWeave owner exits unexpectedly",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "planweave-windows-owner-exit-"));
      const readyPath = join(dir, "ready.txt");
      const grandchildPidPath = join(dir, "grandchild.pid");
      const heartbeatPath = join(dir, "heartbeat.txt");
      const runtimeEntry = pathToFileURL(
        join(import.meta.dirname, "../process/managedProcessTree.ts")
      ).href;
      const grandchildSource = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(heartbeatPath)}, "start");
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"), 40);
`;
      const targetSource = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });
child.unref();
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 100);
`;
      const ownerSource = `
const { spawnManagedProcess } = await import(${JSON.stringify(runtimeEntry)});
spawnManagedProcess({ command: process.execPath, args: ["-e", ${JSON.stringify(targetSource)}], cwd: ${JSON.stringify(dir)} });
const fs = await import("node:fs");
while (!fs.existsSync(${JSON.stringify(grandchildPidPath)})) await new Promise((resolve) => setTimeout(resolve, 20));
process.exit(91);
`;
      const owner = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", ownerSource],
        {
          cwd: import.meta.dirname,
          stdio: "ignore"
        }
      );

      await waitUntil(async () => {
        try {
          return (await readFile(readyPath, "utf8")) === "ready";
        } catch {
          return false;
        }
      });
      if (owner.exitCode === null && owner.signalCode === null) {
        await new Promise<void>((resolveExit, reject) => {
          owner.once("error", reject);
          owner.once("close", () => resolveExit());
        });
      }
      const grandchildPid = Number.parseInt(await readFile(grandchildPidPath, "utf8"), 10);
      pids.push(grandchildPid);
      await waitUntil(() => !isAlive(grandchildPid));
      const sizeAfterExit = (await readFile(heartbeatPath)).byteLength;
      await sleep(120);
      expect((await readFile(heartbeatPath)).byteLength).toBe(sizeAfterExit);
    }
  );

  it("reaps descendants after the managed root exits first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-exited-root-tree-"));
    const grandchildPidPath = join(dir, "grandchild.pid");
    const heartbeatPath = join(dir, "heartbeat.txt");
    const grandchildSource = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(heartbeatPath)}, "start");
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"), 40);
`;
    const rootSource = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });
child.unref();
setTimeout(() => process.exit(17), 50);
`;
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: ["-e", rootSource],
      cwd: dir,
      graceMs: 40
    });
    trees.push(managed.tree);
    pids.push(managed.tree.pid);

    await waitUntil(async () => {
      try {
        return (await readFile(grandchildPidPath, "utf8")).trim().length > 0;
      } catch {
        return false;
      }
    });
    const grandchildPid = Number.parseInt(await readFile(grandchildPidPath, "utf8"), 10);
    pids.push(grandchildPid);
    await managed.tree.exited;
    expect(managed.tree.isAlive()).toBe(false);

    await managed.tree.terminate("root exited before readiness");

    await waitUntil(() => !isAlive(grandchildPid));
    const sizeAfterExit = (await readFile(heartbeatPath)).byteLength;
    await sleep(120);
    expect((await readFile(heartbeatPath)).byteLength).toBe(sizeAfterExit);
  });

  it("kills a grandchild that direct root termination would leave behind", async () => {
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
if (process.platform !== "win32") process.on("SIGTERM", () => {});
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

    // Managed tree: the host adapter reaps both root and grandchild.
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
    if (process.platform === "win32") {
      // Windows exposes the stable Job owner/launcher pid; the target pid is deliberately
      // different so the owner can outlive a root-first exit and retain the named Job.
      expect(managedChildPid).not.toBe(managed.tree.pid);
      expect(managed.child.pid).toBe(managed.tree.pid);
    } else {
      expect(managedChildPid).toBe(managed.tree.pid);
    }
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
  });
});
