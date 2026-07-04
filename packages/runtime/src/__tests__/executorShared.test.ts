import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execWithStdin, execWithStreaming, executorHeartbeatPath } from "../autoRun/executorShared.js";

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
    await expect(readFile(stdoutPath, "utf8")).resolves.toContain("stdout output truncated after 128 bytes");
  });

  it("force kills a child that ignores SIGTERM after stdout exceeds its limit", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout.md");
    const startedAt = Date.now();

    const result = await execWithStreaming({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 100);"],
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
    const liveHeartbeat = JSON.parse(await readFile(heartbeatPath, "utf8")) as Record<string, unknown>;
    expect(liveHeartbeat).toMatchObject({
      status: "running",
      pid: expect.any(Number),
      lastHeartbeatAt: expect.any(String),
      lastStdoutAt: null,
      lastStderrAt: null
    });

    await expect(running).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    await expect(readFile(heartbeatPath, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>)).resolves.toMatchObject({
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
      args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 100);"],
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

  it("rejects and terminates when a stdout write stream errors", async () => {
    const runDir = await tempRunDir();
    const stdoutPath = join(runDir, "stdout-dir");
    const startedAt = Date.now();
    await mkdir(stdoutPath);

    await expect(
      execWithStreaming({
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('trigger'); setInterval(() => {}, 100);"],
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
    await expect(readFile(stderrPath, "utf8")).resolves.toContain("stderr output truncated after 96 bytes");
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
});
