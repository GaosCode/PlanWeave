import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { createProgram } from "../index.js";
import { commandOptionLongs, subcommandOptionLongs } from "./cliCommandTestHelpers.js";
import { cliWorkflowTimeoutMs, repoRoot, runCli } from "./support/cliTestHarness.js";

describe("remote execution CLI read models", () => {
  it("has no remote dispatch command or remote interaction settlement identity", () => {
    const commandNames = createProgram().commands.map((command) => command.name());
    const runOptions = commandOptionLongs("run");
    const interactionRespondOptions = subcommandOptionLongs("interaction", "respond");

    expect(commandNames).not.toEqual(
      expect.arrayContaining(["remote-run", "remote-operation", "workspace-execution"])
    );
    expect(runOptions).not.toEqual(
      expect.arrayContaining(["--remote", "--agent-endpoint", "--workspace"])
    );
    expect(interactionRespondOptions).toEqual(
      expect.arrayContaining([
        "--record",
        "--request",
        "--lease",
        "--option",
        "--cancel",
        "--source",
        "--reason",
        "--json",
        "--canvas"
      ])
    );
    expect(interactionRespondOptions).not.toEqual(
      expect.arrayContaining([
        "--operation",
        "--dispatch",
        "--execution-attempt",
        "--acp-session",
        "--session",
        "--action"
      ])
    );
  });

  it(
    "prints the canonical safe projection in status, explain, and doctor JSON",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
      await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
        recursive: true,
        force: true
      });
      await runCli(["claim-next"], env);
      const state = JSON.parse(await readFile(init.workspace.stateFile, "utf8"));
      state.blocks["T-001#B-001"].remoteOwnership = {
        phase: "active",
        operationId: "operation-001",
        sourceRevision: "revision-001",
        graphFingerprint: "fingerprint-001",
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001"
      };
      await writeFile(init.workspace.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      const expected = {
        identity: { operationId: "operation-001" },
        phase: "active",
        status: "owned",
        actionRequired: false,
        source: { revision: "revision-001", graphFingerprint: "fingerprint-001" },
        dispatchAttempt: { dispatchId: "dispatch-001", executionAttemptId: "attempt-001" }
      };
      const status = JSON.parse((await runCli(["status", "--json"], env)).stdout);
      expect(
        status.blocks.find((block: { ref: string }) => block.ref === "T-001#B-001")
      ).toMatchObject({ remoteExecution: expected });
      expect(JSON.parse((await runCli(["explain", "T-001#B-001"], env)).stdout)).toMatchObject({
        remoteExecution: expected
      });
      expect(JSON.parse((await runCli(["doctor"], env)).stdout)).toMatchObject({
        remoteExecutions: [{ ref: "T-001#B-001", execution: expected }]
      });
      expect(JSON.parse((await runCli(["current", "--json"], env)).stdout)).toMatchObject({
        currentRefs: ["T-001#B-001"],
        items: []
      });
      expect(JSON.stringify(status)).not.toMatch(/hostCredential|serverUrl|packageDir|stateFile/i);
    },
    cliWorkflowTimeoutMs
  );

  it(
    "never echoes a caller diagnostic after Runtime records a remote failure",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
      await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
        recursive: true,
        force: true
      });
      const manifestPath = join(init.workspace.packageDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.execution.defaultExecutor = "codex-acp";
      manifest.executors = {
        "codex-acp": {
          adapter: "agent",
          agent: "codex",
          runner: { transport: "acp" }
        }
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const port = createRemoteBlockRuntimePort({ projectRoot: init.workspace });
      const candidate = await port.inspect({ ref: "T-001#B-001" });
      const activeIdentity = {
        operationId: "operation-failed",
        controlPlane: "collaboration" as const,
        sourceRevision: candidate.sourceRevision,
        graphFingerprint: candidate.graphFingerprint,
        dispatchId: "dispatch-failed",
        executionAttemptId: "attempt-failed"
      };
      await port.claim({
        ref: "T-001#B-001",
        operationId: activeIdentity.operationId,
        controlPlane: activeIdentity.controlPlane,
        sourceRevision: activeIdentity.sourceRevision,
        graphFingerprint: activeIdentity.graphFingerprint
      });
      await port.activate({ ref: "T-001#B-001", ...activeIdentity });
      const rawDiagnostic =
        "Host failed at /tmp/private/token.db; retry https://internal.example:8443";
      await port.fail({
        ref: "T-001#B-001",
        ...activeIdentity,
        failure: { code: "executor_failed", message: rawDiagnostic, retryable: true }
      });

      const outputs = await Promise.all([
        runCli(["status", "--json"], env),
        runCli(["explain", "T-001#B-001"], env),
        runCli(["doctor"], env)
      ]);
      for (const output of outputs) {
        expect(output.stdout).not.toContain(rawDiagnostic);
        expect(output.stdout).not.toContain("/tmp/private/token.db");
        expect(output.stdout).not.toContain("internal.example");
      }
      expect(outputs[0]?.stdout).toContain("Remote executor failed.");
    },
    cliWorkflowTimeoutMs
  );
});
