import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { createPosixProcessTreeAdapter } from "../process/managedProcessTree.js";
import {
  prepareIsolatedWorkspaceBuild,
  readIsolatedBuildGroup
} from "./support/advisoryBuildHarness.js";
import { createAdvisoryControlServer } from "./support/advisoryControlServer.js";
import { observeActor, runThreeProcessRace } from "./support/advisoryProcessHarness.js";

it("keeps three independent processes exclusive when an old reclaimer resumes after replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-three-lock-"));
  try {
    const result = await runThreeProcessRace(
      root,
      new URL("../fs/advisoryDirectoryLock.ts", import.meta.url).href
    );
    expect(result.maximum).toBe(1);
    expect(
      result.trace
        .filter((event) => event.event === "enter")
        .map((event) => event.actor)
        .sort()
    ).toEqual(["A", "B", "C"]);
    console.info("THREE_PROCESS_EXCLUSION", JSON.stringify(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["held", "normal"],
  ["partial", "normal"],
  ["missing", "normal"],
  ["held", "terminated"],
  ["partial", "terminated"],
  ["missing", "terminated"]
])("recovers a real owner at stage %s after %s exit within the original budget", async (mode, exit) => {
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
    const ownerPath = join(lockPath, (await readdir(lockPath))[0]);
    if (mode === "held") {
      const holder = JSON.parse(await readFile(join(ownerPath, "holder.json"), "utf8"));
      expect(holder.pid).toBe(child.pid);
      expect(Date.now() - Date.parse(holder.acquiredAt)).toBeLessThan(60_000);
    } else if (mode === "partial") {
      expect(await readFile(join(ownerPath, "holder.json"), "utf8")).toBe("{");
    } else {
      await expect(readFile(join(ownerPath, "holder.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
    if (exit === "normal") child.send("exit");
    else child.kill("SIGKILL");
    const [code, signal] = await closed;
    if (exit === "normal") expect([code, signal]).toEqual([0, null]);
    else expect(signal === "SIGKILL" || (process.platform === "win32" && code !== 0)).toBe(true);
    const started = performance.now();
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
    expect(performance.now() - started).toBeLessThan(500);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

it("drains a managed writer before releasing and permits a second build", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-managed-lock-build-"));
  const lockPath = join(root, "lock");
  try {
    for (let round = 0; round < 2; round += 1) {
      await withAdvisoryDirectoryLock({ lockPath, operation: "managed-build" }, async (scope) => {
        await scope.runManagedCommand({
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], process.env.PLANWEAVE_BUILD_STORE_DIR)",
            join(root, "output")
          ]
        });
      });
      expect(await readFile(join(root, "output"), "utf8")).toContain("writer-work");
      await expect(readFile(join(lockPath, "holder.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(await readdir(root)).toEqual(["output"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an unawaited writer failure while still releasing its drained lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-managed-lock-failure-"));
  const lockPath = join(root, "lock");
  try {
    await expect(
      withAdvisoryDirectoryLock({ lockPath, operation: "failing-build" }, async (scope) => {
        void scope.runManagedCommand({
          command: process.execPath,
          args: ["-e", "process.exit(7)"]
        });
        return "callback returned";
      })
    ).rejects.toThrow("exit code");
    expect(await readdir(root)).toEqual([]);
    await expect(
      withAdvisoryDirectoryLock({ lockPath, operation: "retry" }, async () => "retry")
    ).resolves.toBe("retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "retains a killed owner's lease while its orphan writer can still write, then recovers immediately",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-orphan-writer-"));
    const control = await createAdvisoryControlServer();
    const actor = observeActor(
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./support/advisoryBuildTarget.mjs", import.meta.url)),
          "owner"
        ],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: {
            ...process.env,
            TEST_BUILD_ROOT: root,
            TEST_CONTROL_PORT: String(control.port),
            TEST_LOCK_MODULE: new URL("../fs/advisoryDirectoryLock.ts", import.meta.url).href
          }
        }
      )
    );
    const lockPath = join(root, "lock");
    let pgid: number | undefined;
    const adapter = createPosixProcessTreeAdapter();
    try {
      const writer = await control.wait("writer", "writer-ready");
      const ownerPath = join(lockPath, (await readdir(lockPath))[0]);
      const descriptor: unknown = JSON.parse(
        await readFile(join(ownerPath, "external-writers-pending", "group-ready.json"), "utf8")
      );
      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        !("pgid" in descriptor) ||
        typeof descriptor.pgid !== "number"
      )
        throw new Error("Expected persisted POSIX writer group");
      pgid = descriptor.pgid;
      const deadline = performance.now() + 5000;
      while (true) {
        try {
          process.kill(pgid, 0);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ESRCH")
            break;
          throw error;
        }
        expect(performance.now()).toBeLessThan(deadline);
        await new Promise(setImmediate);
      }
      expect(await adapter.isTreeAlive(pgid)).toBe(true);
      actor.child.kill("SIGKILL");
      await actor.done;
      let entered = false;
      await expect(
        withAdvisoryDirectoryLock(
          {
            lockPath,
            operation: "orphan-contender",
            timeoutMs: 80,
            retryDelayMs: 1,
            staleMs: 0
          },
          async () => {
            entered = true;
          }
        )
      ).rejects.toThrow("Timed out");
      expect(entered).toBe(false);
      control.send("writer", "write");
      await control.wait("writer", "written");
      expect(await readFile(join(root, "written"), "utf8")).toBe("writer survived owner");
      expect(await adapter.awaitTreeExit(pgid, 5000)).toBe(true);
      const started = performance.now();
      await expect(
        withAdvisoryDirectoryLock(
          {
            lockPath,
            operation: "drained-successor",
            timeoutMs: 500
          },
          async () => 42
        )
      ).resolves.toBe(42);
      expect(performance.now() - started).toBeLessThan(500);
      console.info(
        "ORPHAN_WRITER_EXCLUSION",
        JSON.stringify({ owner: actor.child.pid, pgid, writer: writer.pid })
      );
    } finally {
      await actor.stop();
      if (pgid && (await adapter.isTreeAlive(pgid))) {
        process.kill(-pgid, "SIGKILL");
        await adapter.awaitTreeExit(pgid, 5000);
      }
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);

it("serializes the actual CLI and Desktop workspace wrappers against isolated build targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-wrapper-competition-"));
  const control = await createAdvisoryControlServer();
  const actors: ReturnType<typeof observeActor>[] = [];
  try {
    const { wrapper } = await prepareIsolatedWorkspaceBuild(root);
    const pnpmPath = process.env.npm_execpath;
    if (!pnpmPath) throw new Error("Run this workspace wrapper regression through pnpm test:file");
    function launch(target: string) {
      const actor = observeActor(
        spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            new URL("./support/advisoryBuildObserve.mjs", import.meta.url).href,
            wrapper,
            target
          ],
          {
            cwd: root,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
            env: {
              ...process.env,
              npm_execpath: pnpmPath,
              TEST_BUILD_ROOT: root,
              TEST_BUILD_ACTOR: target,
              TEST_CONTROL_PORT: String(control.port)
            }
          }
        )
      );
      actors.push(actor);
      return actor;
    }
    const cli = launch("cli");
    const first = await Promise.race([
      control.wait("cli", "build-entered"),
      cli.done.then((result) => {
        throw new Error(`CLI wrapper exited before target: ${JSON.stringify(result)}`);
      })
    ]);
    const desktop = launch("desktop");
    await desktop.wait("contended");
    expect(
      control.messages.some(
        (message) => message.actor === "desktop" && message.event === "build-entered"
      )
    ).toBe(false);
    const lockPath = join(root, ".planweave-workspace-consumer-build.lock");
    const ownerPath = join(lockPath, (await readdir(lockPath))[0]);
    expect(JSON.parse(await readFile(join(ownerPath, "holder.json"), "utf8"))).toMatchObject({
      pid: cli.child.pid
    });
    control.send("cli", "release");
    expect((await cli.done).code).toBe(0);
    const second = await Promise.race([
      control.wait("desktop", "build-entered"),
      desktop.done.then((result) => {
        throw new Error(`Desktop wrapper exited before target: ${JSON.stringify(result)}`);
      })
    ]);
    expect(first.store).not.toBe(second.store);
    expect(String(first.store)).toContain("writer-work");
    expect(String(second.store)).toContain("writer-work");
    control.send("desktop", "release");
    expect((await desktop.done).code).toBe(0);
    expect(JSON.parse(await readFile(join(root, "registry.json"), "utf8"))).toEqual([
      "cli",
      "desktop"
    ]);
    const trace = (await readFile(join(root, "build-trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({ event: z.enum(["enter", "exit"]), actor: z.string(), pid: z.number() })
          .parse(JSON.parse(line))
      );
    expect(trace.map((event) => [event.event, event.actor])).toEqual([
      ["enter", "cli"],
      ["exit", "cli"],
      ["enter", "desktop"],
      ["exit", "desktop"]
    ]);
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    console.info("WORKSPACE_WRAPPER_EXCLUSION", JSON.stringify(trace));
  } finally {
    const cleanupFailures: unknown[] = [];
    const group = await readIsolatedBuildGroup(root).catch((error) => {
      cleanupFailures.push(error);
      return undefined;
    });
    await Promise.all(actors.map((actor) => actor.stop()));
    if (group && (await createPosixProcessTreeAdapter().isTreeAlive(group))) {
      process.kill(-group, "SIGKILL");
      expect(await createPosixProcessTreeAdapter().awaitTreeExit(group, 5000)).toBe(true);
    }
    await control.close();
    await rm(root, { recursive: true, force: true });
    expect(cleanupFailures).toEqual([]);
  }
});
