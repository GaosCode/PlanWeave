import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  execWithStdin,
  execWithStreaming,
  executorHeartbeatPath
} from "../autoRun/executorShared.js";

async function tempRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "planweave-executor-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await sleep(20);
    }
  }
  await stat(path);
}

describe("executor streaming", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    unhandledRejections.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  it("cleans up repeated spawn errors without unhandled rejections", async () => {
    const runDir = await tempRunDir();

    for (let index = 0; index < 5; index += 1) {
      await expect(
        execWithStreaming({
          command: "planweave-definitely-missing-command",
          args: [],
          cwd: runDir,
          stdin: "",
          stdoutPath: join(runDir, `missing-${index}.stdout`),
          stderrPath: join(runDir, `missing-${index}.stderr`),
          timeoutMs: 50,
          maxStdoutBytes: 64,
          maxStderrBytes: 64
        })
      ).rejects.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });

  it("terminates the child and bounds stdout when stdout exceeds its limit", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const stderrPath = join(runDir, "stderr.log");

    const result = await execWithStreaming({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048)); setTimeout(() => {}, 1000);"],
      cwd: runDir,
      stdin: "",
      stdoutPath,
      stderrPath,
      timeoutMs: 1000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      limitExceeded: { stream: "stdout", limitBytes: 128 }
    });
    expect(result.stdout).toContain("stdout output truncated after 128 bytes");
    expect((await stat(stdoutPath)).size).toBeLessThan(256);
    await expect(readFile(stdoutPath, "utf8")).resolves.toContain(
      "stdout output truncated after 128 bytes"
    );
  });

  it("force kills a child that ignores SIGTERM after stdout exceeds its limit", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const startedAt = Date.now();

    const result = await execWithStreaming({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 100);"
      ],
      cwd: runDir,
      stdin: "",
      stdoutPath,
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 5000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      limitExceeded: { stream: "stdout", limitBytes: 128 }
    });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect((await stat(stdoutPath)).size).toBeLessThan(256);
  });

  it("force kills a child that ignores SIGTERM after timeout", async () => {
    const runDir = await tempRunDir();
    const startedAt = Date.now();

    const result = await execWithStreaming({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);"],
      cwd: runDir,
      stdin: "",
      stdoutPath: join(runDir, "stdout.md"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 50,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024
    });

    expect(result).toMatchObject({
      exitCode: 124,
      timedOut: true
    });
    expect(result.limitExceeded).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("writes heartbeat records while a streaming child is alive but quiet", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const stderrPath = join(runDir, "stderr.log");
    const heartbeatPath = executorHeartbeatPath(stdoutPath);

    const running = execWithStreaming({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 220);"],
      cwd: runDir,
      stdin: "",
      stdoutPath,
      stderrPath,
      timeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      heartbeatIntervalMs: 25
    });

    await waitForFile(heartbeatPath);
    await sleep(80);
    const liveHeartbeat = JSON.parse(await readFile(heartbeatPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(liveHeartbeat).toMatchObject({
      status: "running",
      pid: expect.any(Number),
      lastHeartbeatAt: expect.any(String),
      lastStdoutAt: null,
      lastStderrAt: null
    });

    await expect(running).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    await expect(
      readFile(heartbeatPath, "utf8").then(
        (content) => JSON.parse(content) as Record<string, unknown>
      )
    ).resolves.toMatchObject({
      status: "finished",
      exitCode: 0,
      timedOut: false,
      finishedAt: expect.any(String)
    });
  });

  it("force kills an execWithStdin child that ignores SIGTERM after timeout", async () => {
    const runDir = await tempRunDir();
    const startedAt = Date.now();

    const result = await execWithStdin({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);"],
      cwd: runDir,
      stdin: "",
      timeoutMs: 50
    });

    expect(result).toMatchObject({
      exitCode: 124,
      timedOut: true
    });
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("bounds execWithStdin output and terminates the child when stdout exceeds its limit", async () => {
    const runDir = await tempRunDir();
    const startedAt = Date.now();

    const result = await execWithStdin({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 100);"
      ],
      cwd: runDir,
      stdin: "",
      timeoutMs: 5000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      limitExceeded: { stream: "stdout", limitBytes: 128 }
    });
    expect(result.stdout).toContain("stdout output truncated after 128 bytes");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(256);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("force kills a child when a stdout callback rejects", async () => {
    const runDir = await tempRunDir();
    const heartbeatPath = join(runDir, "heartbeat.txt");

    await expect(
      execWithStreaming({
        command: process.execPath,
        args: [
          "-e",
          `
const fs = require("node:fs");
const heartbeatPath = ${JSON.stringify(heartbeatPath)};
process.on("SIGTERM", () => {});
fs.writeFileSync(heartbeatPath, "start");
setInterval(() => fs.appendFileSync(heartbeatPath, "x"), 50);
process.stdout.write("trigger");
`
        ],
        cwd: runDir,
        stdin: "",
        stdoutPath: join(runDir, "stdout.md"),
        stderrPath: join(runDir, "stderr.log"),
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        onStdout: () => {
          throw new Error("stdout callback failed");
        }
      })
    ).rejects.toThrow("stdout callback failed");

    const sizeAfterReject = (await stat(heartbeatPath)).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await stat(heartbeatPath)).size).toBe(sizeAfterReject);
  });

  it("rejects when an async stdout callback fails after the child has already closed", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const heartbeatPath = executorHeartbeatPath(stdoutPath);
    const startedAt = Date.now();

    await expect(
      execWithStreaming({
        command: process.execPath,
        // Exit immediately after writing so close settles while the callback is still pending.
        args: ["-e", "process.stdout.write('trigger');"],
        cwd: runDir,
        stdin: "",
        stdoutPath,
        stderrPath: join(runDir, "stderr.log"),
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        onStdout: async () => {
          await sleep(150);
          throw new Error("late callback failed");
        }
      })
    ).rejects.toThrow("late callback failed");

    expect(Date.now() - startedAt).toBeLessThan(3000);
    await expect(
      readFile(heartbeatPath, "utf8").then(
        (content) => JSON.parse(content) as Record<string, unknown>
      )
    ).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      error: expect.stringContaining("late callback failed")
    });
  });

  it("rejects when heartbeat finalization fails instead of hanging", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const heartbeatPath = executorHeartbeatPath(stdoutPath);
    const startedAt = Date.now();

    const running = execWithStreaming({
      command: process.execPath,
      args: [
        "-e",
        // Stay alive briefly so the parent can replace heartbeat.json with a directory.
        "setTimeout(() => {}, 80);"
      ],
      cwd: runDir,
      stdin: "",
      stdoutPath,
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      heartbeatIntervalMs: 0
    });
    const rejection = running.catch((error: unknown) => error);

    await waitForFile(heartbeatPath);
    await unlink(heartbeatPath);
    await mkdir(heartbeatPath);

    await expect(rejection).resolves.toMatchObject({
      message: expect.stringMatching(/EISDIR|illegal operation on a directory|directory/i)
    });
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("rejects and terminates when a stdout write stream errors", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout-dir");
    const startedAt = Date.now();
    await mkdir(stdoutPath);

    await expect(
      execWithStreaming({
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('trigger'); setInterval(() => {}, 100);"
        ],
        cwd: runDir,
        stdin: "",
        stdoutPath,
        stderrPath: join(runDir, "stderr.log"),
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024
      })
    ).rejects.toThrow();
    await sleep(800);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("terminates the child and bounds stderr when stderr exceeds its limit", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const stderrPath = join(runDir, "stderr.log");

    const result = await execWithStreaming({
      command: process.execPath,
      args: ["-e", "process.stderr.write('e'.repeat(2048)); setTimeout(() => {}, 1000);"],
      cwd: runDir,
      stdin: "",
      stdoutPath,
      stderrPath,
      timeoutMs: 1000,
      maxStdoutBytes: 128,
      maxStderrBytes: 96
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      limitExceeded: { stream: "stderr", limitBytes: 96 }
    });
    expect(result.stderr).toContain("stderr output truncated after 96 bytes");
    expect((await stat(stderrPath)).size).toBeLessThan(224);
    await expect(readFile(stderrPath, "utf8")).resolves.toContain(
      "stderr output truncated after 96 bytes"
    );
  });

  it("preserves under-limit stdout and stderr for successful commands", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const stderrPath = join(runDir, "stderr.log");
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    const result = await execWithStreaming({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello stdout'); process.stderr.write('hello stderr');"],
      cwd: runDir,
      stdin: "",
      stdoutPath,
      stderrPath,
      timeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      onStdout,
      onStderr
    });

    expect(result).toMatchObject({
      stdout: "hello stdout",
      stderr: "hello stderr",
      exitCode: 0,
      timedOut: false
    });
    expect(result.limitExceeded).toBeUndefined();
    expect(onStdout).toHaveBeenCalledWith("hello stdout");
    expect(onStderr).toHaveBeenCalledWith("hello stderr");
    await expect(readFile(stdoutPath, "utf8")).resolves.toBe("hello stdout");
    await expect(readFile(stderrPath, "utf8")).resolves.toBe("hello stderr");
  });

  /**
   * Integration: root exits on SIGTERM quickly, grandchild ignores SIGTERM.
   * Executor settlement must await force reap so the grandchild is dead when the promise settles.
   */
  async function writeGrandchildTreeScripts(runDir: string): Promise<{
    parentScript: string;
    grandchildPidPath: string;
    heartbeatPath: string;
  }> {
    const grandchildPidPath = join(runDir, "grandchild.pid");
    const heartbeatPath = join(runDir, "gc-heartbeat.txt");
    const grandchildScript = join(runDir, "grandchild.js");
    const parentScript = join(runDir, "parent.js");
    await writeFile(
      grandchildScript,
      `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(heartbeatPath)}, "start");
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"), 40);
`,
      "utf8"
    );
    await writeFile(
      parentScript,
      `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
g.unref();
// Root responds to SIGTERM by exiting; grandchild stays in the process group.
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 100);
`,
      "utf8"
    );
    return { parentScript, grandchildPidPath, heartbeatPath };
  }

  async function waitForPidFile(path: string): Promise<number> {
    // Allow extra headroom under full-suite CPU contention (spawn can lag).
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        const text = (await readFile(path, "utf8")).trim();
        if (text.length > 0) {
          const pid = Number.parseInt(text, 10);
          if (Number.isInteger(pid) && pid > 0) {
            return pid;
          }
        }
      } catch {
        // not yet
      }
      await sleep(20);
    }
    throw new Error(`Timed out waiting for pid file: ${path}`);
  }

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!processIsAlive(pid)) {
        return;
      }
      await sleep(20);
    }
    throw new Error(`Process ${String(pid)} still observable after ${String(timeoutMs)}ms.`);
  }

  it.runIf(process.platform !== "win32")(
    "execWithStreaming awaits tree force before settle when a SIGTERM-resistant grandchild outlives the root",
    async () => {
      const runDir = await tempRunDir();
      const { parentScript, grandchildPidPath, heartbeatPath } =
        await writeGrandchildTreeScripts(runDir);
      const stdoutPath = join(runDir, "stdout.md");

      const startedAt = Date.now();
      // Timeout must outlive grandchild spawn under parallel suite load; keep grace-after-timeout semantics.
      const timeoutMs = 1_500;
      const running = execWithStreaming({
        command: process.execPath,
        args: [parentScript],
        cwd: runDir,
        stdin: "",
        stdoutPath,
        stderrPath: join(runDir, "stderr.log"),
        timeoutMs,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024
      });

      const grandchildPid = await waitForPidFile(grandchildPidPath);
      expect(processIsAlive(grandchildPid)).toBe(true);

      const result = await running;
      expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
      // Settlement must not precede force; default grace is 500ms after timeout.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(timeoutMs + 500);

      // Heartbeat must stop at settle time (force completed); pid may briefly remain as a zombie.
      const sizeAfterSettle = (await readFile(heartbeatPath)).byteLength;
      await sleep(150);
      expect((await readFile(heartbeatPath)).byteLength).toBe(sizeAfterSettle);
      await waitUntilDead(grandchildPid);

      const heartbeat = executorHeartbeatPath(stdoutPath);
      await expect(
        readFile(heartbeat, "utf8").then(
          (content) => JSON.parse(content) as Record<string, unknown>
        )
      ).resolves.toMatchObject({
        status: "finished",
        timedOut: true,
        finishedAt: expect.any(String)
      });
    }
  );

  it.runIf(process.platform !== "win32")(
    "execWithStdin awaits tree force before settle when a SIGTERM-resistant grandchild outlives the root",
    async () => {
      const runDir = await tempRunDir();
      const { parentScript, grandchildPidPath, heartbeatPath } =
        await writeGrandchildTreeScripts(runDir);

      const startedAt = Date.now();
      const timeoutMs = 1_500;
      const running = execWithStdin({
        command: process.execPath,
        args: [parentScript],
        cwd: runDir,
        stdin: "",
        timeoutMs
      });

      const grandchildPid = await waitForPidFile(grandchildPidPath);
      expect(processIsAlive(grandchildPid)).toBe(true);

      const result = await running;
      expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(timeoutMs + 500);

      const sizeAfterSettle = (await readFile(heartbeatPath)).byteLength;
      await sleep(150);
      expect((await readFile(heartbeatPath)).byteLength).toBe(sizeAfterSettle);
      await waitUntilDead(grandchildPid);
    }
  );
});
