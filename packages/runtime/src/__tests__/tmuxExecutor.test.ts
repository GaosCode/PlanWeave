import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createTmuxSessionInfo, isTmuxAvailable, killActiveTmuxSessions, runCommandInTmux } from "../autoRun/tmuxExecutor.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("tmux executor", () => {
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
      args: ["-e", "process.stdout.write('hello from tmux'); process.stderr.write('progress from tmux');"],
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
});
