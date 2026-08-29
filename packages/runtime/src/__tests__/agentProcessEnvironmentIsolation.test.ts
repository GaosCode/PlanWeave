import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAcpExecutionProfile } from "../acpProfile/runtimeResolver.js";
import { execWithStdin } from "../autoRun/executorShared.js";
import { runCommandInTmux } from "../autoRun/tmuxExecutor.js";
import { tmuxRunnerSource } from "../autoRun/tmuxRunnerScript.js";

const controlCredentialName = "PLANWEAVE_COLLABORATION_DEVICE_TOKEN";
const fakeCredential = "characterization-device-token-not-a-real-secret";
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function runNodeFile(path: string, environment: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { env: environment, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

describe("agent process environment isolation characterization", () => {
  it("forwards the collaboration device credential through an actual local Agent spawn", async () => {
    const result = await execWithStdin({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(process.env.${controlCredentialName} ? "present" : "missing")`
      ],
      cwd: process.cwd(),
      stdin: "",
      env: { [controlCredentialName]: fakeCredential }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("present");
    expect(result.stdout).not.toContain(fakeCredential);
  });

  it("forwards a declared collaboration device credential through Runtime ACP resolution", async () => {
    vi.stubEnv(controlCredentialName, fakeCredential);

    const resolved = await resolveAcpExecutionProfile({
      executorProfile: {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp", profileId: "credential-characterization" }
      },
      projectRoot: process.cwd(),
      executorSource: "builtin",
      resolver: {
        resolve: async () => ({
          profileId: "credential-characterization",
          agentId: "codex",
          displayName: "Credential characterization",
          host: { kind: "native" },
          launch: { command: process.execPath, args: [] },
          environment: [{ name: controlCredentialName, required: true }],
          shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 },
          capabilities: { required: ["session", "prompt"], optional: [] },
          connection: { mode: "dedicated" },
          source: "local-user",
          fingerprint: "a".repeat(64)
        })
      }
    });

    expect(resolved.environment.availableNames).toContain(controlCredentialName);
    expect(Object.keys(resolved.environment.env)).toContain(controlCredentialName);
    expect(resolved.environment.env[controlCredentialName]).toBeDefined();
  });

  it("persists an explicitly supplied collaboration device credential in tmux command.json", async () => {
    const directory = await temporaryDirectory("planweave-tmux-env-persistence-");
    const fakeBin = join(directory, "bin");
    await mkdir(fakeBin);
    const fakeTmux = join(fakeBin, "tmux");
    await writeFile(fakeTmux, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(fakeTmux, 0o755);
    vi.stubEnv("PATH", `${fakeBin}:${process.env.PATH ?? ""}`);

    const stdoutPath = join(directory, "stdout.md");
    await expect(
      runCommandInTmux({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: directory,
        stdin: "",
        env: { [controlCredentialName]: fakeCredential },
        stdoutPath,
        stderrPath: join(directory, "stderr.md"),
        tmux: {
          sessionName: "credential-characterization",
          attachCommand: "tmux attach -t credential-characterization",
          readOnlyAttachCommand: "tmux attach -r -t credential-characterization"
        }
      })
    ).rejects.toThrow();

    const persisted = JSON.parse(
      await readFile(join(directory, ".tmux-stdout.md", "command.json"), "utf8")
    );
    expect(Object.keys(persisted.env)).toContain(controlCredentialName);
    expect(persisted.env[controlCredentialName]).toBeDefined();
  });

  it("merges the tmux runner parent environment into the Agent child environment", async () => {
    const directory = await temporaryDirectory("planweave-tmux-runner-env-");
    const configPath = join(directory, "command.json");
    const runnerPath = join(directory, "runner.mjs");
    const stdoutPath = join(directory, "stdout.md");
    const stderrPath = join(directory, "stderr.md");
    await writeFile(join(directory, "stdin.txt"), "", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(process.env.${controlCredentialName} ? "present" : "missing")`
        ],
        cwd: directory,
        env: {},
        stdinPath: join(directory, "stdin.txt"),
        stdoutPath,
        stderrPath,
        donePath: join(directory, "done.json"),
        heartbeatPath: join(directory, "heartbeat.json"),
        heartbeatIntervalMs: null,
        timeoutMs: null,
        maxStdoutBytes: null,
        maxStderrBytes: null
      }),
      "utf8"
    );
    await writeFile(runnerPath, tmuxRunnerSource(configPath), "utf8");

    await expect(
      runNodeFile(runnerPath, { ...process.env, [controlCredentialName]: fakeCredential })
    ).resolves.toBe(0);
    expect(await readFile(stdoutPath, "utf8")).toBe("present");
    expect(await readFile(stderrPath, "utf8")).not.toContain(fakeCredential);
  });
});
