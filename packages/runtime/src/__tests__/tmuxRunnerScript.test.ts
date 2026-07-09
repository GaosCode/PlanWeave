import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmuxRunnerSource } from "../autoRun/tmuxRunnerScript.js";

async function runNodeScript(
  path: string,
  cwd: string
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
  });
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
      await sleep(100);
    }
  }
  await stat(path);
}

async function waitForJsonFile(path: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out reading JSON file: ${path}`);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? 1}`));
    });
  });
}

describe("tmux runner script", () => {
  it("records a failed done state when a stdout log stream errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-runner-"));
    const stdoutPath = join(dir, "stdout-dir");
    const stderrPath = join(dir, "stderr.log");
    const donePath = join(dir, "done.json");
    const stdinPath = join(dir, "stdin.txt");
    const configPath = join(dir, "command.json");
    const runnerPath = join(dir, "runner.mjs");
    await mkdir(stdoutPath);
    await writeFile(stdinPath, "", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('trigger'); setInterval(() => {}, 100);"
        ],
        cwd: dir,
        env: {},
        stdinPath,
        stdoutPath,
        stderrPath,
        donePath,
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024
      }),
      "utf8"
    );
    await writeFile(runnerPath, tmuxRunnerSource(configPath), "utf8");

    const result = await runNodeScript(runnerPath, dir);

    expect(result.exitCode).toBe(1);
    await expect(
      readFile(donePath, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>)
    ).resolves.toMatchObject({
      exitCode: 1,
      timedOut: false
    });
    await expect(readFile(stderrPath, "utf8")).resolves.toContain("stdout log stream failed");
  });

  it("kills the child before exiting after a stdout log stream error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-runner-kill-"));
    const stdoutPath = join(dir, "stdout.fifo");
    const stderrPath = join(dir, "stderr.log");
    const donePath = join(dir, "done.json");
    const stdinPath = join(dir, "stdin.txt");
    const childPidPath = join(dir, "child.pid");
    const heartbeatPath = join(dir, "heartbeat.txt");
    const configPath = join(dir, "command.json");
    const runnerPath = join(dir, "runner.mjs");
    await runCommand("mkfifo", [stdoutPath], dir);
    await writeFile(stdinPath, "", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        command: process.execPath,
        args: [
          "-e",
          `
const fs = require("node:fs");
const childPidPath = ${JSON.stringify(childPidPath)};
const heartbeatPath = ${JSON.stringify(heartbeatPath)};
process.on("SIGTERM", () => {});
fs.writeFileSync(childPidPath, String(process.pid));
fs.writeFileSync(heartbeatPath, "start");
setInterval(() => fs.appendFileSync(heartbeatPath, "x"), 50);
setTimeout(() => process.stdout.write("trigger"), 500);
`
        ],
        cwd: dir,
        env: {},
        stdinPath,
        stdoutPath,
        stderrPath,
        donePath,
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024
      }),
      "utf8"
    );
    await writeFile(runnerPath, tmuxRunnerSource(configPath), "utf8");

    const runner = spawn(process.execPath, [runnerPath], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    const runnerDone = new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      runner.stderr.setEncoding("utf8");
      runner.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      runner.on("error", reject);
      runner.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
    });
    const reader = spawn("cat", [stdoutPath], { cwd: dir, stdio: "ignore" });
    let childPid: number | null = null;
    try {
      await waitForFile(childPidPath);
      childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
      await sleep(100);
      reader.kill("SIGTERM");

      const result = await runnerDone;

      expect(result.exitCode).toBe(1);
      await expect(
        readFile(donePath, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>)
      ).resolves.toMatchObject({
        exitCode: 1,
        timedOut: false,
        error: expect.stringContaining("stdout log stream failed")
      });
      expect(result.stderr).toContain("stdout log stream failed");
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      reader.kill("SIGKILL");
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The process is expected to be gone when fatal termination works.
        }
      }
    }
  });

  it("writes heartbeat records while the tmux runner child is alive but quiet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-runner-heartbeat-"));
    const stdoutPath = join(dir, "stdout.md");
    const stderrPath = join(dir, "stderr.log");
    const donePath = join(dir, "done.json");
    const heartbeatPath = join(dir, "heartbeat.json");
    const stdinPath = join(dir, "stdin.txt");
    const configPath = join(dir, "command.json");
    const runnerPath = join(dir, "runner.mjs");
    await writeFile(stdinPath, "", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 500);"],
        cwd: dir,
        env: {},
        stdinPath,
        stdoutPath,
        stderrPath,
        donePath,
        heartbeatPath,
        heartbeatIntervalMs: 25,
        timeoutMs: 1000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024
      }),
      "utf8"
    );
    await writeFile(runnerPath, tmuxRunnerSource(configPath), "utf8");

    const runner = spawn(process.execPath, [runnerPath], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const runnerDone = new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      let stderr = "";
      runner.stderr.setEncoding("utf8");
      runner.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      runner.on("error", reject);
      runner.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
    });

    await waitForFile(heartbeatPath);
    await sleep(80);
    await expect(waitForJsonFile(heartbeatPath)).resolves.toMatchObject({
      status: "running",
      pid: expect.any(Number),
      lastHeartbeatAt: expect.any(String)
    });

    await expect(runnerDone).resolves.toMatchObject({ exitCode: 0 });
    await expect(waitForJsonFile(heartbeatPath)).resolves.toMatchObject({
      status: "finished",
      exitCode: 0,
      timedOut: false,
      finishedAt: expect.any(String)
    });
  });
});
