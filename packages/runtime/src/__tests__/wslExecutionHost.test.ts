import { describe, expect, it, vi } from "vitest";
import {
  availableExecutionHostEnvironmentVariables,
  listWslDistributions,
  mapWindowsPathToWsl,
  prepareExecutionHostInvocation,
  prepareWslProcessInvocation,
  resolveWslExecutable
} from "../process/wslExecutionHost.js";
import { executorProfileExecutionHost, executorProfileSchema } from "../types/executor.js";

describe("WSL execution host", () => {
  it("resolves executables inside the declared distribution without host filesystem checks", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from("/usr/local/bin/custom-acp\n"),
      stderr: Buffer.alloc(0)
    });

    await expect(
      resolveWslExecutable("custom-acp", "Ubuntu Dev", { platform: "win32", run })
    ).resolves.toBe("/usr/local/bin/custom-acp");
    expect(run).toHaveBeenCalledWith([
      "--distribution",
      "Ubuntu Dev",
      "--exec",
      "sh",
      "-c",
      expect.stringContaining("readlink -f"),
      "planweave-wsl-resolve",
      "custom-acp"
    ]);
  });
  it("does not treat native credentials as available inside WSL", () => {
    const environment = { PATH: "native-path", PLANWEAVE_HOME: "C:\\pw", XAI_API_KEY: "secret" };

    expect([
      ...availableExecutionHostEnvironmentVariables({ kind: "native" }, environment)
    ]).toEqual(["PATH", "PLANWEAVE_HOME", "XAI_API_KEY"]);
    expect([
      ...availableExecutionHostEnvironmentVariables(
        { kind: "wsl", distribution: "Ubuntu" },
        environment
      )
    ]).toEqual(["PATH", "PLANWEAVE_HOME"]);
  });

  it("does not expose Windows credentials or WSLENV to a WSL launcher", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
      }
      return {
        stdout: Buffer.from(
          "__PLANWEAVE_PATH_BEGIN__/home/dev/.local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });

    const prepared = await prepareExecutionHostInvocation({
      host: { kind: "wsl", distribution: "Ubuntu" },
      command: "grok",
      args: [],
      cwd: "C:\\work",
      env: {
        Path: "C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        WSLENV: "XAI_API_KEY/u:PLANWEAVE_SENTINEL/u",
        XAI_API_KEY: "xai-secret-sentinel",
        PLANWEAVE_SENTINEL: "must-not-cross-host"
      },
      platform: "win32",
      run,
      token: "sanitized-environment"
    });

    expect(prepared.spawnEnvironment).toEqual({
      Path: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp"
    });
  });

  it("keeps old agent profiles native and requires an explicit WSL distribution", () => {
    const native = executorProfileSchema.parse({
      adapter: "agent",
      agent: "pi",
      runner: { transport: "acp" }
    });
    expect(executorProfileExecutionHost(native)).toEqual({ kind: "native" });

    const wsl = executorProfileSchema.parse({
      adapter: "agent",
      agent: "pi",
      runner: { transport: "acp" },
      host: { kind: "wsl", distribution: " Ubuntu " }
    });
    expect(executorProfileExecutionHost(wsl)).toEqual({
      kind: "wsl",
      distribution: "Ubuntu"
    });
    expect(() =>
      executorProfileSchema.parse({
        adapter: "agent",
        agent: "pi",
        runner: { transport: "acp" },
        host: { kind: "wsl" }
      })
    ).toThrow();
  });

  it("parses UTF-16 WSL distribution output without inventing a native fallback", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from("Ubuntu\r\nDebian\r\n", "utf16le"),
      stderr: Buffer.alloc(0)
    });

    await expect(listWslDistributions({ platform: "win32", run })).resolves.toEqual({
      available: true,
      distributions: ["Ubuntu", "Debian"],
      unavailableReason: null
    });
    expect(run).toHaveBeenCalledWith(["--list", "--quiet"]);
  });

  it("reports WSL absence explicitly", async () => {
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn wsl.exe ENOENT"), {
        code: "ENOENT"
      })
    );

    await expect(listWslDistributions({ platform: "win32", run })).resolves.toEqual({
      available: false,
      distributions: [],
      unavailableReason: "WSL is not installed or wsl.exe is unavailable."
    });
  });

  it("maps drive paths and matching WSL UNC paths, rejecting distribution mismatch", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from("/mnt/c/code/PlanWeave\n"),
      stderr: Buffer.alloc(0)
    });

    await expect(
      mapWindowsPathToWsl("C:\\code\\PlanWeave", "Ubuntu", { platform: "win32", run })
    ).resolves.toBe("/mnt/c/code/PlanWeave");
    expect(run).toHaveBeenCalledWith([
      "--distribution",
      "Ubuntu",
      "--exec",
      "wslpath",
      "-a",
      "-u",
      "C:\\code\\PlanWeave"
    ]);

    await expect(
      mapWindowsPathToWsl("\\\\wsl.localhost\\Ubuntu\\home\\dev\\app", "Ubuntu", {
        platform: "win32",
        run
      })
    ).resolves.toBe("/home/dev/app");

    await expect(
      mapWindowsPathToWsl("\\\\wsl.localhost\\Debian\\home\\dev\\app", "Ubuntu", {
        platform: "win32",
        run
      })
    ).rejects.toThrow("belongs to WSL distribution 'Debian', not selected distribution 'Ubuntu'");
  });

  it("builds a structured WSL invocation with login-shell PATH and mapped path arguments", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        const source = args.at(-1);
        if (source === "C:\\work") {
          return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
        }
        if (source === "C:\\work\\prompt.md") {
          return { stdout: Buffer.from("/mnt/c/work/prompt.md\n"), stderr: Buffer.alloc(0) };
        }
        if (source === "C:\\pw") {
          return { stdout: Buffer.from("/mnt/c/pw\n"), stderr: Buffer.alloc(0) };
        }
      }
      return {
        stdout: Buffer.from(
          "shell noise\n__PLANWEAVE_PATH_BEGIN__/home/dev/.local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });

    const prepared = await prepareWslProcessInvocation({
      host: { kind: "wsl", distribution: "Ubuntu Dev" },
      command: "grok",
      args: ["--prompt-file", "C:\\work\\prompt.md", "literal;$(touch nope)"],
      pathArgIndexes: [1],
      cwd: "C:\\work",
      env: { PLANWEAVE_HOME: "C:\\pw", XAI_API_KEY: "must-not-cross-host" },
      platform: "win32",
      run,
      token: "safe-token"
    });

    expect(prepared.command).toBe("wsl.exe");
    expect(prepared.sessionCwd).toBe("/mnt/c/work");
    expect(prepared.args).toEqual([
      "--distribution",
      "Ubuntu Dev",
      "--cd",
      "/mnt/c/work",
      "--exec",
      "sh",
      "-c",
      expect.any(String),
      "planweave-wsl",
      "/tmp/planweave-safe-token.pid",
      "env",
      "PATH=/home/dev/.local/bin:/usr/bin",
      "PLANWEAVE_HOME=/mnt/c/pw",
      "grok",
      "--prompt-file",
      "/mnt/c/work/prompt.md",
      "literal;$(touch nope)"
    ]);
    expect(prepared.args).not.toContain("XAI_API_KEY=must-not-cross-host");
  });

  it("shares one WSL cleanup across an exited launcher and decorated tree termination", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
      }
      if (args.includes("planweave-wsl-terminate")) {
        return { stdout: Buffer.from("exited\n"), stderr: Buffer.alloc(0) };
      }
      return {
        stdout: Buffer.from(
          "__PLANWEAVE_PATH_BEGIN__/home/dev/.local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });
    const prepared = await prepareWslProcessInvocation({
      host: { kind: "wsl", distribution: "Ubuntu" },
      command: "pi-acp",
      args: [],
      cwd: "C:\\work",
      platform: "win32",
      run,
      token: "cleanup-token"
    });
    const nativeTerminate = vi.fn().mockResolvedValue({
      outcome: "graceful" as const,
      reason: "cancelled"
    });
    const tree = prepared.decorateProcessTree({
      pid: 1234,
      exited: Promise.resolve(),
      isAlive: () => true,
      terminate: nativeTerminate
    });

    const cleanupAfterExit = prepared.cleanupExitedProcessTree();
    const first = tree.terminate("cancelled");
    const second = tree.terminate("second reason");
    await expect(cleanupAfterExit).resolves.toBeUndefined();
    await expect(first).resolves.toEqual({ outcome: "graceful", reason: "cancelled" });
    await expect(second).resolves.toEqual({ outcome: "graceful", reason: "cancelled" });

    expect(nativeTerminate).toHaveBeenCalledTimes(1);
    expect(nativeTerminate).toHaveBeenCalledWith("cancelled");
    const cleanupCalls = run.mock.calls.filter(([args]) =>
      args.includes("planweave-wsl-terminate")
    );
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0]?.[0]).toEqual([
      "--distribution",
      "Ubuntu",
      "--exec",
      "sh",
      "-c",
      expect.stringContaining("/bin/kill -TERM"),
      "planweave-wsl-terminate",
      "terminate",
      "/tmp/planweave-cleanup-token.pid",
      "50",
      "50"
    ]);
  });

  it("reaps the Windows launcher before starting WSL process-group cleanup", async () => {
    let releaseNative: (() => void) | undefined;
    let wslCleanupStarted = false;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
      }
      if (args.includes("planweave-wsl-terminate")) {
        wslCleanupStarted = true;
        return { stdout: Buffer.from("exited\n"), stderr: Buffer.alloc(0) };
      }
      return {
        stdout: Buffer.from(
          "__PLANWEAVE_PATH_BEGIN__/home/dev/.local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });
    const prepared = await prepareWslProcessInvocation({
      host: { kind: "wsl", distribution: "Ubuntu" },
      command: "pi-acp",
      args: [],
      cwd: "C:\\work",
      platform: "win32",
      run,
      token: "native-first"
    });
    const nativeTerminate = vi.fn(async () => {
      expect(wslCleanupStarted).toBe(false);
      await nativeGate;
      expect(wslCleanupStarted).toBe(false);
      return { outcome: "forced" as const, reason: "cancelled" };
    });
    const tree = prepared.decorateProcessTree({
      pid: 1234,
      exited: Promise.resolve(),
      isAlive: () => true,
      terminate: nativeTerminate
    });

    const terminating = tree.terminate("cancelled");
    await Promise.resolve();
    expect(nativeTerminate).toHaveBeenCalledOnce();
    expect(wslCleanupStarted).toBe(false);
    releaseNative?.();
    await expect(terminating).resolves.toEqual({ outcome: "forced", reason: "cancelled" });
    expect(wslCleanupStarted).toBe(true);
  });

  it("surfaces WSL cleanup failure even if native process termination succeeds", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
      }
      if (args.includes("planweave-wsl-terminate")) {
        throw new Error("process group still alive");
      }
      return {
        stdout: Buffer.from(
          "__PLANWEAVE_PATH_BEGIN__/usr/local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });
    const prepared = await prepareWslProcessInvocation({
      host: { kind: "wsl", distribution: "Ubuntu" },
      command: "grok",
      args: [],
      cwd: "C:\\work",
      platform: "win32",
      run,
      token: "cleanup-failure"
    });
    const tree = prepared.decorateProcessTree({
      pid: 1234,
      exited: Promise.resolve(),
      isAlive: () => true,
      terminate: vi.fn().mockResolvedValue({ outcome: "forced", reason: "cancelled" })
    });

    await expect(tree.terminate("cancelled")).rejects.toThrow(
      "WSL process group terminate failed in distribution 'Ubuntu'"
    );
  });

  it("passes a minimal remaining policy to WSL cleanup without fixed grace windows", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
      }
      if (args.includes("planweave-wsl-terminate")) {
        return { stdout: Buffer.from("exited\n"), stderr: Buffer.alloc(0) };
      }
      return {
        stdout: Buffer.from(
          "__PLANWEAVE_PATH_BEGIN__/usr/local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });
    const prepared = await prepareWslProcessInvocation({
      host: { kind: "wsl", distribution: "Ubuntu" },
      command: "pi-acp",
      args: [],
      cwd: "C:\\work",
      platform: "win32",
      run,
      token: "minimal-policy"
    });

    await prepared.cleanupExitedProcessTree({ graceMs: 10, forceExitConfirmMs: 20 });

    const cleanupArgs = run.mock.calls.find(([args]) =>
      args.includes("planweave-wsl-terminate")
    )?.[0];
    expect(cleanupArgs?.slice(-4)).toEqual([
      "terminate",
      "/tmp/planweave-minimal-policy.pid",
      "1",
      "2"
    ]);
    expect(cleanupArgs?.[5]).not.toContain("sleep 0.5");
    expect(cleanupArgs?.[5]).not.toContain("sleep 0.1");
  });

  it("keeps a root-exited WSL descendant visible through probe, wait, and force cleanup", async () => {
    let wslTreeAlive = true;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("wslpath")) {
        return { stdout: Buffer.from("/mnt/c/work\n"), stderr: Buffer.alloc(0) };
      }
      if (args.includes("planweave-wsl-probe") || args.includes("planweave-wsl-wait")) {
        return {
          stdout: Buffer.from(wslTreeAlive ? "alive\n" : "exited\n"),
          stderr: Buffer.alloc(0)
        };
      }
      if (args.includes("planweave-wsl-terminate")) {
        wslTreeAlive = false;
        return { stdout: Buffer.from("exited\n"), stderr: Buffer.alloc(0) };
      }
      return {
        stdout: Buffer.from(
          "__PLANWEAVE_PATH_BEGIN__/usr/local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
        ),
        stderr: Buffer.alloc(0)
      };
    });
    const prepared = await prepareWslProcessInvocation({
      host: { kind: "wsl", distribution: "Ubuntu" },
      command: "pi-acp",
      args: [],
      cwd: "C:\\work",
      platform: "win32",
      run,
      token: "root-exited-descendant"
    });
    const nativeTerminate = vi
      .fn()
      .mockResolvedValue({ outcome: "already_exited" as const, reason: "cleanup" });
    const tree = prepared.decorateProcessTree({
      pid: 1234,
      exited: Promise.resolve(),
      isAlive: () => false,
      isTreeAlive: async () => false,
      awaitTreeExit: async () => true,
      terminate: nativeTerminate
    });

    await expect(tree.isTreeAlive()).resolves.toBe(true);
    await expect(tree.awaitTreeExit(20)).resolves.toBe(false);
    await expect(
      tree.terminate("cleanup", { graceMs: 10, forceExitConfirmMs: 20 })
    ).resolves.toEqual({ outcome: "already_exited", reason: "cleanup" });
    await expect(tree.isTreeAlive()).resolves.toBe(false);
    expect(nativeTerminate).toHaveBeenCalledWith("cleanup", {
      graceMs: 10,
      forceExitConfirmMs: 20
    });
  });
});
