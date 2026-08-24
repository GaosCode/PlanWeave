import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(import.meta.dirname, "../..");

type FakeParentProcess = EventEmitter & { exitCode?: number };
type FakeChildProcess = EventEmitter & { kill: (signal: string) => boolean };

async function importScript<T>(filename: string): Promise<T> {
  return (await import(pathToFileURL(resolve(desktopRoot, "scripts", filename)).href)) as T;
}

describe("desktop development command", () => {
  it("reserves dev and start for the complete Electron lifecycle", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(desktopRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.dev).toBe("node scripts/dev-desktop.mjs");
    expect(packageJson.scripts.start).toBe("node scripts/start-desktop.mjs");
    expect(packageJson.scripts["dev:renderer"]).toBe("vite --host 127.0.0.1");
  });

  it("creates the executable Node Agent Host environment for start and dev", async () => {
    const { createDesktopDevelopmentLaunchEnvironment } = await importScript<{
      createDesktopDevelopmentLaunchEnvironment: (rendererUrl?: string) => NodeJS.ProcessEnv;
    }>("desktop-launch-environment.mjs");
    const inheritedKey = "PLANWEAVE_DESKTOP_LAUNCH_CONTRACT_TEST";
    const originalInherited = process.env[inheritedKey];
    const originalNode = process.env.PLANWEAVE_DESKTOP_NODE_EXECUTABLE;
    const originalCli = process.env.PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH;
    process.env[inheritedKey] = "inherited";
    process.env.PLANWEAVE_DESKTOP_NODE_EXECUTABLE = "/stale/node";
    process.env.PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH = "/stale/agent-host.js";

    try {
      const startEnvironment = createDesktopDevelopmentLaunchEnvironment();
      const devEnvironment = createDesktopDevelopmentLaunchEnvironment("http://127.0.0.1:5173/");

      expect(startEnvironment[inheritedKey]).toBe("inherited");
      expect(startEnvironment.PLANWEAVE_DESKTOP_NODE_EXECUTABLE).toBe(process.execPath);
      expect(startEnvironment.PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH).toBe(
        resolve(desktopRoot, "../agent-host/dist/bin.js")
      );
      expect(startEnvironment.PLANWEAVE_DESKTOP_DEV_SERVER_URL).toBeUndefined();
      expect(devEnvironment.PLANWEAVE_DESKTOP_DEV_SERVER_URL).toBe("http://127.0.0.1:5173/");
    } finally {
      if (originalInherited === undefined) delete process.env[inheritedKey];
      else process.env[inheritedKey] = originalInherited;
      if (originalNode === undefined) delete process.env.PLANWEAVE_DESKTOP_NODE_EXECUTABLE;
      else process.env.PLANWEAVE_DESKTOP_NODE_EXECUTABLE = originalNode;
      if (originalCli === undefined) delete process.env.PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH;
      else process.env.PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH = originalCli;
    }
  });

  it("owns only the launched child lifecycle and maps its terminal events", async () => {
    const { startDesktopChild } = await importScript<{
      startDesktopChild: (input: {
        command: string;
        args: string[];
        options: Record<string, unknown>;
        spawnChild: (
          command: string,
          args: string[],
          options: Record<string, unknown>
        ) => FakeChildProcess;
        parentProcess: FakeParentProcess;
        writeError: (error: unknown) => void;
      }) => FakeChildProcess;
    }>("desktop-launch-process.mjs");
    const parent = new EventEmitter() as FakeParentProcess;
    const child = new EventEmitter() as FakeChildProcess;
    const killedSignals: string[] = [];
    const errors: unknown[] = [];
    child.kill = (signal) => {
      killedSignals.push(signal);
      return true;
    };
    const spawnCalls: unknown[][] = [];

    const launched = startDesktopChild({
      command: "/electron",
      args: ["/main.js"],
      options: { cwd: "/desktop" },
      spawnChild: (...args) => {
        spawnCalls.push(args);
        return child;
      },
      parentProcess: parent,
      writeError: (error) => errors.push(error)
    });

    expect(launched).toBe(child);
    expect(spawnCalls).toEqual([["/electron", ["/main.js"], { cwd: "/desktop" }]]);
    parent.emit("SIGTERM");
    expect(killedSignals).toEqual(["SIGTERM"]);
    child.emit("exit", null, "SIGTERM");
    expect(parent.exitCode).toBe(0);
    expect(parent.listenerCount("SIGINT")).toBe(0);
    expect(parent.listenerCount("SIGTERM")).toBe(0);
    expect(errors).toEqual([]);
  });

  it("fails closed for spawn errors and unexpected signal exits", async () => {
    const { startDesktopChild } = await importScript<{
      startDesktopChild: (input: {
        command: string;
        args: string[];
        options: Record<string, unknown>;
        spawnChild: () => FakeChildProcess;
        parentProcess: FakeParentProcess;
        writeError: (error: unknown) => void;
      }) => FakeChildProcess;
    }>("desktop-launch-process.mjs");
    const errors: unknown[] = [];
    const errorParent = new EventEmitter() as FakeParentProcess;
    const errorChild = new EventEmitter() as FakeChildProcess;
    errorChild.kill = () => true;
    startDesktopChild({
      command: "/electron",
      args: [],
      options: {},
      spawnChild: () => errorChild,
      parentProcess: errorParent,
      writeError: (error) => errors.push(error)
    });
    const spawnError = new Error("spawn failed");
    errorChild.emit("error", spawnError);
    expect(errorParent.exitCode).toBe(1);
    expect(errors).toEqual([spawnError]);
    errorChild.emit("exit", 0, null);
    expect(errorParent.exitCode).toBe(1);

    const signalParent = new EventEmitter() as FakeParentProcess;
    const signalChild = new EventEmitter() as FakeChildProcess;
    signalChild.kill = () => true;
    startDesktopChild({
      command: "/electron",
      args: [],
      options: {},
      spawnChild: () => signalChild,
      parentProcess: signalParent,
      writeError: (error) => errors.push(error)
    });
    signalChild.emit("exit", null, "SIGKILL");
    expect(signalParent.exitCode).toBe(1);

    const failedKillParent = new EventEmitter() as FakeParentProcess;
    const failedKillChild = new EventEmitter() as FakeChildProcess;
    failedKillChild.kill = () => false;
    startDesktopChild({
      command: "/electron",
      args: [],
      options: {},
      spawnChild: () => failedKillChild,
      parentProcess: failedKillParent,
      writeError: (error) => errors.push(error)
    });
    failedKillParent.emit("SIGINT");
    expect(failedKillParent.exitCode).toBe(1);
    failedKillChild.emit("exit", 0, null);
    expect(failedKillParent.exitCode).toBe(1);
  });
});
