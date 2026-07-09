import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTmuxSessionInfo,
  isTmuxAvailable,
  killActiveTmuxSessions,
  killTmuxSessionsForRun,
  runCommandInTmux
} from "../autoRun/tmuxExecutor.js";

let tempDirs: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await sleep(100);
    }
  }
  await stat(path);
}

async function hasTmuxSession(sessionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function waitForTmuxSessionExit(sessionName: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await hasTmuxSession(sessionName))) {
      return;
    }
    await sleep(100);
  }
  expect(await hasTmuxSession(sessionName)).toBe(false);
}

afterEach(async () => {
  await killActiveTmuxSessions();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("tmux executor", () => {
  it("does not create a session when tmux monitoring is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-disabled-"));
    tempDirs.push(dir);

    await expect(
      createTmuxSessionInfo({
        runDir: dir,
        runId: "RUN-DISABLED",
        ref: "T-001#B-001",
        kind: "block",
        enabled: false
      })
    ).resolves.toBeNull();
  });

  it("runs a command inside a per-run tmux session and mirrors output to log files", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-"));
    tempDirs.push(dir);
    const tmux = await createTmuxSessionInfo({
      runDir: dir,
      runId: "RUN-001",
      ref: "T-001#B-001",
      kind: "block"
    });

    expect(tmux).toMatchObject({
      sessionName: expect.stringContaining("planweave-T-001-B-001-RUN-001"),
      readOnlyAttachCommand: expect.stringContaining("tmux attach-session -r -t")
    });

    const result = await runCommandInTmux({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('hello from tmux'); process.stderr.write('progress from tmux');"
      ],
      cwd: dir,
      stdin: "",
      stdoutPath: join(dir, "stdout.md"),
      stderrPath: join(dir, "stderr.log"),
      timeoutMs: 5000,
      tmux: tmux!,
      onStdout: () => undefined,
      onStderr: () => undefined
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    await expect(readFile(join(dir, "stdout.md"), "utf8")).resolves.toBe("hello from tmux");
    await expect(readFile(join(dir, "stderr.log"), "utf8")).resolves.toBe("progress from tmux");
    await waitForTmuxSessionExit(tmux!.sessionName);
  });

  it("can stop an active tmux-backed command", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-stop-"));
    tempDirs.push(dir);
    const tmux = await createTmuxSessionInfo({
      runDir: dir,
      runId: "RUN-STOP",
      ref: "T-001#B-002",
      kind: "block"
    });

    const running = runCommandInTmux({
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('tick\\n'), 100);"],
      cwd: dir,
      stdin: "",
      stdoutPath: join(dir, "stdout.md"),
      stderrPath: join(dir, "stderr.log"),
      timeoutMs: 10000,
      tmux: tmux!,
      onStdout: () => undefined,
      onStderr: () => undefined
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(killActiveTmuxSessions()).resolves.toContain(tmux!.sessionName);
    await expect(running).resolves.toMatchObject({ exitCode: 130, timedOut: false });
  });

  it("terminates a tmux-backed command when stdout exceeds its limit", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-limit-"));
    tempDirs.push(dir);
    const tmux = await createTmuxSessionInfo({
      runDir: dir,
      runId: "RUN-LIMIT",
      ref: "T-001#B-003",
      kind: "block"
    });
    const stdoutPath = join(dir, "stdout.md");
    const donePath = join(dir, ".tmux-stdout.md", "done.json");

    const result = await runCommandInTmux({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1024 * 1024)); setTimeout(() => {}, 1000);"],
      cwd: dir,
      stdin: "",
      stdoutPath,
      stderrPath: join(dir, "stderr.log"),
      timeoutMs: 5000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
      tmux: tmux!,
      onStdout: () => undefined,
      onStderr: () => undefined
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      limitExceeded: { stream: "stdout", limitBytes: 128 }
    });
    expect((await stat(stdoutPath)).size).toBeLessThan(256);
    await expect(readFile(stdoutPath, "utf8")).resolves.toContain(
      "stdout output truncated after 128 bytes"
    );
    await expect(
      readFile(donePath, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>)
    ).resolves.toMatchObject({
      exitCode: 1,
      timedOut: false,
      limitExceeded: { stream: "stdout", limitBytes: 128 }
    });
  });

  it("kills a tmux session when a stdout callback rejects", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-callback-"));
    tempDirs.push(dir);
    const tmux = await createTmuxSessionInfo({
      runDir: dir,
      runId: "RUN-CALLBACK",
      ref: "T-001#B-004",
      kind: "block"
    });

    await expect(
      runCommandInTmux({
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('trigger'); setInterval(() => {}, 100);"
        ],
        cwd: dir,
        stdin: "",
        stdoutPath: join(dir, "stdout.md"),
        stderrPath: join(dir, "stderr.log"),
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        tmux: tmux!,
        onStdout: () => {
          throw new Error("tmux stdout callback failed");
        },
        onStderr: () => undefined
      })
    ).rejects.toThrow("tmux stdout callback failed");

    await expect(hasTmuxSession(tmux!.sessionName)).resolves.toBe(false);
  });

  it("kills only active tmux sessions owned by the requested run", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const runADir = await mkdtemp(join(tmpdir(), "planweave-tmux-owner-a-"));
    const runBDir = await mkdtemp(join(tmpdir(), "planweave-tmux-owner-b-"));
    tempDirs.push(runADir, runBDir);
    const runATmux = await createTmuxSessionInfo({
      runDir: runADir,
      runId: "RUN-A",
      tmuxOwnerRunId: "AUTO-RUN-A",
      ref: "T-001#B-001",
      kind: "block"
    });
    const runBTmux = await createTmuxSessionInfo({
      runDir: runBDir,
      runId: "RUN-B",
      tmuxOwnerRunId: "AUTO-RUN-B",
      ref: "T-001#B-002",
      kind: "block"
    });

    const runA = runCommandInTmux({
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('a\\n'), 100);"],
      cwd: runADir,
      stdin: "",
      stdoutPath: join(runADir, "stdout.md"),
      stderrPath: join(runADir, "stderr.log"),
      timeoutMs: 10000,
      tmux: runATmux!,
      onStdout: () => undefined,
      onStderr: () => undefined
    });
    const runB = runCommandInTmux({
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('b\\n'), 100);"],
      cwd: runBDir,
      stdin: "",
      stdoutPath: join(runBDir, "stdout.md"),
      stderrPath: join(runBDir, "stderr.log"),
      timeoutMs: 10000,
      tmux: runBTmux!,
      onStdout: () => undefined,
      onStderr: () => undefined
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(killTmuxSessionsForRun("AUTO-RUN-A")).resolves.toEqual([runATmux!.sessionName]);
    await expect(runA).resolves.toMatchObject({ exitCode: 130, timedOut: false });
    await expect(killActiveTmuxSessions()).resolves.toContain(runBTmux!.sessionName);
    await expect(runB).resolves.toMatchObject({ exitCode: 130, timedOut: false });
  });

  it("force stops the running tmux command process when killing sessions for a run", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-force-stop-"));
    tempDirs.push(dir);
    const heartbeatPath = join(dir, "heartbeat.txt");
    const childPidPath = join(dir, "child.pid");
    const tmux = await createTmuxSessionInfo({
      runDir: dir,
      runId: "RUN-FORCE-STOP",
      tmuxOwnerRunId: "AUTO-RUN-FORCE-STOP",
      ref: "T-001#B-003",
      kind: "block"
    });

    let childPid: number | null = null;
    try {
      const running = runCommandInTmux({
        command: process.execPath,
        args: [
          "-e",
          `
const { spawn } = require("node:child_process");
const childCode = ${JSON.stringify(`
const fs = require("node:fs");
const heartbeatPath = ${JSON.stringify(heartbeatPath)};
const childPidPath = ${JSON.stringify(childPidPath)};
process.on("SIGTERM", () => {});
fs.writeFileSync(childPidPath, String(process.pid));
fs.writeFileSync(heartbeatPath, "start");
setInterval(() => fs.appendFileSync(heartbeatPath, "x"), 50);
`)};
const child = spawn(process.execPath, ["-e", childCode], { detached: true, stdio: "ignore" });
child.unref();
setInterval(() => {}, 100);
`
        ],
        cwd: dir,
        stdin: "",
        stdoutPath: join(dir, "stdout.md"),
        stderrPath: join(dir, "stderr.log"),
        timeoutMs: 10000,
        tmux: tmux!,
        onStdout: () => undefined,
        onStderr: () => undefined
      });

      await waitForFile(heartbeatPath);
      await waitForFile(childPidPath);
      childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
      await expect(killTmuxSessionsForRun("AUTO-RUN-FORCE-STOP")).resolves.toEqual([
        tmux!.sessionName
      ]);
      await expect(running).resolves.toMatchObject({ exitCode: 130, timedOut: false });
      const sizeAfterStop = (await stat(heartbeatPath)).size;
      await sleep(800);
      expect((await stat(heartbeatPath)).size).toBe(sizeAfterStop);
    } finally {
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The process is expected to be gone when termination works.
        }
      }
    }
  });
});
