import { chmod, copyFile, cp, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnManagedProcess, type ManagedProcessTree } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import {
  CliTestHardTimeoutError,
  cliWorkflowTimeoutMs,
  defaultCliHardTimeoutMs,
  repoRoot,
  resolveCliHardTimeoutMs,
  runCli,
  runCliExpectFailure,
  runManagedTestCommand,
  terminateTimedOutCliProcess
} from "./support/cliTestHarness.js";

const mockAgent = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);
const acpProfiles = {
  "codex-acp": "codex-acp",
  "claude-code-acp": "claude-agent-acp",
  "opencode-acp": "opencode",
  "pi-acp": "pi-acp",
  "grok-acp": "grok"
} as const;

let fakeAcpBinPromise: Promise<{ bin: string; nodeOptions: string | undefined }> | undefined;

function fakeAcpBin(): Promise<{ bin: string; nodeOptions: string | undefined }> {
  fakeAcpBinPromise ??= createFakeAcpBin();
  return fakeAcpBinPromise;
}

async function createFakeAcpBin(): Promise<{
  bin: string;
  nodeOptions: string | undefined;
}> {
  const bin = await mkdtemp(join(tmpdir(), "planweave-acp-cli-bin-"));
  if (process.platform === "win32") {
    const bootstrap = join(bin, "acp-mock-bootstrap.mjs");
    const executableNames = Object.values(acpProfiles).map((command) => `${command}.exe`);
    await writeFile(
      bootstrap,
      `import { basename } from "node:path";\nconst commands = new Set(${JSON.stringify(executableNames)});\nif (commands.has(basename(process.execPath).toLowerCase())) {\n  process.argv[2] = process.env.PLANWEAVE_ACP_SCENARIO ?? "artifact-implementation";\n  await import(${JSON.stringify(pathToFileURL(mockAgent).href)});\n}\n`,
      "utf8"
    );
    const agentHost = join(bin, "planweave-acp-agent-host.exe");
    await copyFile(process.execPath, agentHost);
    for (const executableName of executableNames) {
      await link(agentHost, join(bin, executableName));
    }
    const bootstrapOption = `--import=${pathToFileURL(bootstrap).href}`;
    return {
      bin,
      nodeOptions: process.env.NODE_OPTIONS
        ? `${process.env.NODE_OPTIONS} ${bootstrapOption}`
        : bootstrapOption
    };
  }

  for (const command of Object.values(acpProfiles)) {
    const wrapper = join(bin, command);
    await writeFile(
      wrapper,
      `#!/usr/bin/env node\nprocess.argv[2] = process.env.PLANWEAVE_ACP_SCENARIO ?? "artifact-implementation";\nawait import(${JSON.stringify(pathToFileURL(mockAgent).href)});\n`,
      "utf8"
    );
    await chmod(wrapper, 0o755);
  }
  return { bin, nodeOptions: process.env.NODE_OPTIONS };
}

async function fakeAcpEnvironment() {
  const home = await mkdtemp(join(tmpdir(), "planweave-acp-cli-home-"));
  const { bin, nodeOptions } = await fakeAcpBin();
  return {
    ...process.env,
    PLANWEAVE_HOME: home,
    NODE_OPTIONS: nodeOptions,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`
  };
}

async function initializePackage(env: NodeJS.ProcessEnv, profile: keyof typeof acpProfiles) {
  const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
    workspace: { packageDir: string; resultsDir: string };
  };
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true,
    force: true
  });
  const manifestPath = join(init.workspace.packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    execution: { defaultExecutor?: string };
  };
  manifest.execution.defaultExecutor = profile;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return init;
}

async function runBlock(env: NodeJS.ProcessEnv, ref: string) {
  return JSON.parse(
    (await runCli(["run", "--once", "--scope", "block", "--block", ref, "--json"], env)).stdout
  ) as Record<string, unknown>;
}

function followedRunSessionIds(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith('{"kind":"runner_event"'))
    .map(
      (line) =>
        JSON.parse(line) as {
          kind: string;
          event?: { identity?: { runSessionId?: string | null } };
        }
    )
    .flatMap((item) =>
      item.kind === "runner_event" && item.event?.identity?.runSessionId
        ? [item.event.identity.runSessionId]
        : []
    );
}

async function waitForFileText(path: string, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (pattern.test(await readFile(path, "utf8"))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}.`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesToExit(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (pids.every((pid) => !processIsAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for managed CLI test processes to exit: ${pids.join(", ")}`);
}

function forceKillProcess(pid: number): void {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup after a failed process-tree assertion.
  }
}

describe("ACP CLI end-to-end", () => {
  it("uses one default hard budget below the enclosing Vitest timeout", () => {
    expect(resolveCliHardTimeoutMs()).toBe(defaultCliHardTimeoutMs);
    expect(defaultCliHardTimeoutMs).toBeLessThan(cliWorkflowTimeoutMs);
    expect(resolveCliHardTimeoutMs(1_234)).toBe(1_234);
  });

  it("keeps the hard timeout primary when process-tree cleanup also fails", async () => {
    const cleanupError = new Error("scripted cleanup failure");
    const tree: ManagedProcessTree = {
      pid: 42_424,
      exited: Promise.resolve(),
      isAlive: () => true,
      terminate: async () => {
        throw cleanupError;
      }
    };

    let failure: unknown;
    try {
      await terminateTimedOutCliProcess({
        tree,
        hardTimeoutMs: 250,
        stdout: "partial stdout",
        stderr: "partial stderr"
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CliTestHardTimeoutError);
    if (!(failure instanceof CliTestHardTimeoutError)) {
      throw new Error("Expected CliTestHardTimeoutError.");
    }
    expect(failure.timeoutMs).toBe(250);
    expect(failure.message).toContain("exceeded the 250ms test-owned hard budget");
    expect(failure.message).toContain("cleanup also failed");
    expect(failure.cause).toBe(cleanupError);
  });

  it(
    "terminates a hanging CLI test root and grandchild at the harness hard timeout",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "planweave-cli-hard-timeout-"));
      const pidPath = join(directory, "processes.json");
      const grandchildSource = [
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);"
      ].join("\n");
      const parentSource = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);"
      ].join("\n");
      let pids: { root: number; grandchild: number } | undefined;

      try {
        await expect(
          runManagedTestCommand({
            command: process.execPath,
            args: ["-e", parentSource],
            cwd: directory,
            env: process.env,
            hardTimeoutMs: 1_000,
            graceMs: 100
          })
        ).rejects.toMatchObject({
          name: "CliTestHardTimeoutError",
          timeoutMs: 1_000,
          message: expect.stringContaining("managed process tree was terminated")
        });

        pids = JSON.parse(await readFile(pidPath, "utf8")) as {
          root: number;
          grandchild: number;
        };
        await waitForProcessesToExit([pids.root, pids.grandchild]);
        expect(processIsAlive(pids.root)).toBe(false);
        expect(processIsAlive(pids.grandchild)).toBe(false);
      } finally {
        if (pids) {
          forceKillProcess(pids.root);
          forceKillProcess(pids.grandchild);
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    cliWorkflowTimeoutMs
  );

  it.each(Object.keys(acpProfiles) as Array<keyof typeof acpProfiles>)(
    "routes package-assigned %s through ACP and submits its artifact",
    async (profile) => {
      const env = await fakeAcpEnvironment();
      await initializePackage(env, profile);
      const result = await runBlock(env, "T-001#B-001");
      expect(result).toMatchObject({
        ok: true,
        terminalReason: "completed",
        session: { autoRun: { effectiveExecutor: profile, runnerKind: "acp" } },
        steps: [{ kind: "submitted", adapterResult: { runnerKind: "acp" } }]
      });
    },
    cliWorkflowTimeoutMs
  );

  it(
    "executes implementation, review, feedback and exposes ordered runner evidence",
    async () => {
      const baseEnv = await fakeAcpEnvironment();
      const init = await initializePackage(baseEnv, "codex-acp");
      const implementation = await runBlock(
        { ...baseEnv, PLANWEAVE_ACP_SCENARIO: "artifact-implementation" },
        "T-001#B-001"
      );
      expect(implementation).toMatchObject({ steps: [{ kind: "submitted" }] });

      const review = await runBlock(
        { ...baseEnv, PLANWEAVE_ACP_SCENARIO: "artifact-review-needs-changes" },
        "T-001#R-001"
      );
      expect(review).toMatchObject({
        steps: [{ kind: "submitted", submitResult: { verdict: "needs_changes" } }]
      });
      const reviewSessionId = (review.session as { sessionId: string }).sessionId;
      const reviewFollow = await runCli(["run-status", "--follow", "--json"], baseEnv);
      expect(new Set(followedRunSessionIds(reviewFollow.stdout))).toEqual(
        new Set([reviewSessionId])
      );

      const feedback = await runBlock(
        { ...baseEnv, PLANWEAVE_ACP_SCENARIO: "artifact-feedback" },
        "T-001#R-001"
      );
      expect(feedback).toMatchObject({
        steps: [{ kind: "submitted", claim: { kind: "feedback" } }]
      });

      const sessionId = (feedback.session as { sessionId: string }).sessionId;
      const detail = JSON.parse(
        (await runCli(["run-session", sessionId, "--json"], baseEnv)).stdout
      ) as {
        session: { autoRun: { effectiveExecutor: string; agentId: string; runnerKind: string } };
        runnerReadModel: {
          events: Array<{ sequence: number }>;
          interaction: object;
          terminal: boolean;
        };
      };
      expect(detail.session.autoRun).toEqual(
        expect.objectContaining({
          effectiveExecutor: "codex-acp",
          agentId: "codex",
          runnerKind: "acp"
        })
      );
      expect(detail.runnerReadModel.terminal).toBe(true);
      expect(detail.runnerReadModel.events.map((event) => event.sequence)).toEqual(
        [...detail.runnerReadModel.events.map((event) => event.sequence)].sort((a, b) => a - b)
      );
      const followed = await runCli(["run-status", "--follow", "--json"], baseEnv);
      expect(followed.stdout).toContain('"kind":"runner_event"');
      expect(new Set(followedRunSessionIds(followed.stdout))).toEqual(new Set([sessionId]));
      expect(sessionId).not.toBe(reviewSessionId);
      expect(init.workspace.resultsDir).toEqual(expect.any(String));
    },
    cliWorkflowTimeoutMs
  );

  it.each(["auth-required", "elicitation"])(
    "fails closed for headless %s without executor fallback",
    async (scenario) => {
      const baseEnv = await fakeAcpEnvironment();
      await initializePackage(baseEnv, "codex-acp");
      const failure = await runCliExpectFailure(
        ["run", "--once", "--scope", "block", "--block", "T-001#B-001", "--json"],
        { ...baseEnv, PLANWEAVE_ACP_SCENARIO: scenario }
      );
      const result = JSON.parse(failure.stdout) as {
        terminalReason: string;
        session: {
          autoRun: { effectiveExecutor: string; runnerKind: string };
          error: string | null;
        };
      };
      expect(result).toMatchObject({
        terminalReason: "blocked",
        session: { autoRun: { effectiveExecutor: "codex-acp", runnerKind: "acp" } }
      });
      expect(JSON.stringify(result)).not.toContain("codex-exec");
    },
    cliWorkflowTimeoutMs
  );

  it(
    "keeps permission pending until the explicit runtime timeout without executor fallback",
    async () => {
      const baseEnv = await fakeAcpEnvironment();
      await initializePackage(baseEnv, "codex-acp");
      const failure = await runCliExpectFailure(
        [
          "run",
          "--once",
          "--timeout",
          "250",
          "--scope",
          "block",
          "--block",
          "T-001#B-001",
          "--json"
        ],
        { ...baseEnv, PLANWEAVE_ACP_SCENARIO: "permission" },
        { hardTimeoutMs: 10_000 }
      );
      const result = JSON.parse(failure.stdout) as {
        terminalReason: string;
        session: {
          phase: string;
          autoRun: { effectiveExecutor: string; runnerKind: string };
          error: string | null;
        };
      };
      expect(result).toMatchObject({
        terminalReason: "blocked",
        session: {
          phase: "blocked",
          autoRun: { effectiveExecutor: "codex-acp", runnerKind: "acp" }
        }
      });
      expect(result.session.error).toMatch(/timed out after 250ms/i);
      expect(JSON.stringify(result)).not.toContain("codex-exec");
    },
    cliWorkflowTimeoutMs
  );

  it(
    "bounds ACP execution with --timeout and preserves recovery evidence",
    async () => {
      const baseEnv = await fakeAcpEnvironment();
      await initializePackage(baseEnv, "codex-acp");
      const failure = await runCliExpectFailure(
        [
          "run",
          "--once",
          "--timeout",
          "25",
          "--scope",
          "block",
          "--block",
          "T-001#B-001",
          "--json"
        ],
        { ...baseEnv, PLANWEAVE_ACP_SCENARIO: "long-prompt" }
      );
      const result = JSON.parse(failure.stdout) as {
        terminalReason: string;
        session: { sessionId: string; phase: string; latestRecordPath: string | null };
      };
      expect(result).toMatchObject({ terminalReason: "blocked", session: { phase: "blocked" } });
      expect(result.session.latestRecordPath).toEqual(expect.stringContaining("metadata.json"));
      const detail = JSON.parse(
        (await runCli(["run-session", result.session.sessionId, "--json"], baseEnv)).stdout
      );
      expect(detail.runnerReadModel).toMatchObject({ terminal: true });
    },
    cliWorkflowTimeoutMs
  );

  it.skipIf(process.platform === "win32")(
    "propagates SIGINT through the ACP cancellation and cleanup chain",
    async () => {
      const baseEnv = await fakeAcpEnvironment();
      const init = await initializePackage(baseEnv, "codex-acp");
      const env = { ...baseEnv, PLANWEAVE_ACP_SCENARIO: "long-prompt" };
      const managed = spawnManagedProcess({
        command: process.execPath,
        args: [
          join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          join(repoRoot, "packages", "cli", "src", "index.ts"),
          "run",
          "--once",
          "--scope",
          "block",
          "--block",
          "T-001#B-001",
          "--json"
        ],
        cwd: repoRoot,
        env
      });
      const { child, tree } = managed;
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const metadataPath = join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "metadata.json"
      );
      try {
        await waitForFileText(metadataPath, /"finishedAt": null/);
        child.kill("SIGINT");
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(exitCode).toBe(1);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toMatchObject({
          terminalReason: "cancelled",
          session: { phase: "stopped", autoRun: { runnerKind: "acp" } }
        });
        expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
          outcome: "cancelled",
          finishedAt: expect.any(String)
        });
      } finally {
        if (tree.isAlive()) {
          await tree.terminate("ACP SIGINT test cleanup");
        }
      }
    },
    cliWorkflowTimeoutMs
  );
});
