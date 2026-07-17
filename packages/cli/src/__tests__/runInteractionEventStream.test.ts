import { spawn } from "node:child_process";
import { access, chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runEventSchema, type RunEvent } from "@planweave-ai/runtime";
import { repoRoot, runCli, runCliExpectFailure } from "./support/cliTestHarness.js";

const mockAgent = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);
const childTimeoutMs = 15_000;
const cleanupTimeoutMs = 2_000;
const activeChildren = new Set<ReturnType<typeof spawn>>();

async function initializeRun(scenario: string) {
  const home = await mkdtemp(join(tmpdir(), "planweave-run-events-home-"));
  const bin = await mkdtemp(join(tmpdir(), "planweave-run-events-bin-"));
  const wrapper = join(bin, "codex-acp");
  await writeFile(
    wrapper,
    `#!/usr/bin/env node\nprocess.argv[2] = process.env.PLANWEAVE_ACP_SCENARIO ?? "artifact-implementation";\nawait import(${JSON.stringify(pathToFileURL(mockAgent).href)});\n`,
    "utf8"
  );
  await chmod(wrapper, 0o755);
  const env = {
    ...process.env,
    PLANWEAVE_HOME: home,
    PLANWEAVE_ACP_SCENARIO: scenario,
    PATH: `${bin}:${process.env.PATH ?? ""}`
  };
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
  manifest.execution.defaultExecutor = "codex-acp";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { env, resultsDir: init.workspace.resultsDir };
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for CLI child exit.")),
      timeoutMs
    );
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function cleanupChild(child: ReturnType<typeof spawn>): Promise<void> {
  activeChildren.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForClose(child, cleanupTimeoutMs);
  } catch {
    child.kill("SIGKILL");
    await waitForClose(child, cleanupTimeoutMs);
  }
}

afterEach(async () => {
  await Promise.all([...activeChildren].map(cleanupChild));
});

function startEventStream(env: NodeJS.ProcessEnv) {
  const child = spawn(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      "run",
      "--once",
      "--scope",
      "block",
      "--block",
      "T-001#B-001",
      "--event-stream"
    ],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  activeChildren.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const events: RunEvent[] = [];
  let buffer = "";
  let stderr = "";
  let parseError: unknown;
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        events.push(runEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        parseError ??= error;
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = waitForClose(child, childTimeoutMs).then((result) => {
    activeChildren.delete(child);
    if (parseError) throw parseError;
    if (buffer.trim().length > 0) {
      throw new Error(`Event stream ended with a partial frame: ${buffer}`);
    }
    return result;
  });
  return { child, completed, events, stderr: () => stderr };
}

async function waitForRequired(
  events: RunEvent[]
): Promise<Extract<RunEvent, { type: "interaction_required" }>> {
  const deadline = Date.now() + childTimeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(
      (candidate): candidate is Extract<RunEvent, { type: "interaction_required" }> =>
        candidate.type === "interaction_required"
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for interaction_required.");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + childTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

describe("run --event-stream", () => {
  it("keeps the owner alive from required through a second CLI response to terminal", async () => {
    const fixture = await initializeRun("permission-secret");
    const run = startEventStream(fixture.env);
    try {
      const event = await waitForRequired(run.events);
      expect(run.child.exitCode).toBeNull();
      const selectedOption = event.interaction.options[0];
      if (!selectedOption) throw new Error("Expected an advertised permission option.");
      const receipt = JSON.parse(
        (
          await runCli(
            [
              "interaction",
              "respond",
              "--record",
              event.interaction.recordId,
              "--request",
              event.interaction.requestId,
              "--lease",
              event.interaction.ownerLeaseId,
              "--option",
              selectedOption.optionId,
              "--source",
              "arbitrary-coordinator",
              "--reason",
              "approved by test",
              "--json"
            ],
            fixture.env
          )
        ).stdout
      );
      expect(receipt).toMatchObject({ decisionSource: "arbitrary-coordinator" });
      await expect(run.completed).resolves.toMatchObject({ code: 0, signal: null });
      expect(run.events.map(({ type }) => type)).toEqual([
        "interaction_required",
        "interaction_resolved",
        "run_completed"
      ]);
      expect(run.events[1]).toMatchObject({
        interaction: { resolutionStage: "owner_consumed", outcome: "approved" }
      });
      expect(run.events[2]).toMatchObject({ terminalReason: "completed", ok: true });
      expect(run.stderr()).toBe("");
    } finally {
      await cleanupChild(run.child);
      await run.completed.catch(() => undefined);
    }
  });

  it("emits exactly one valid run_failed terminal frame after SIGINT", async () => {
    const fixture = await initializeRun("delayed-artifact-implementation");
    const run = startEventStream(fixture.env);
    try {
      await waitForFile(
        join(fixture.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "heartbeat.json")
      );
      run.child.kill("SIGINT");
      await expect(run.completed).resolves.toMatchObject({ code: 1, signal: null });
      const terminal = run.events.filter(
        (event) => event.type === "run_completed" || event.type === "run_failed"
      );
      expect(terminal).toEqual([
        expect.objectContaining({ type: "run_failed", terminalReason: "cancelled", ok: false })
      ]);
      expect(run.stderr()).toBe("");
    } finally {
      await cleanupChild(run.child);
      await run.completed.catch(() => undefined);
    }
  });

  it("rejects --json and --event-stream together", async () => {
    const fixture = await initializeRun("artifact-implementation");
    const failure = await runCliExpectFailure(["run", "--json", "--event-stream"], fixture.env);
    expect(failure.stderr).toContain("--event-stream cannot be combined with --json");
  });
});
