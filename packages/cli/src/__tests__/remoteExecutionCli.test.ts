import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackageSnapshot,
  createRemoteBlockRuntimePort,
  listRunSessions,
  loadPlanGraphPackage,
  workspaceExecutionEventSchema
} from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { createProgram } from "../index.js";
import { commandOptionLongs, subcommandOptionLongs } from "./cliCommandTestHelpers.js";
import {
  cliWorkflowTimeoutMs,
  repoRoot,
  runCli,
  runCliExpectFailure
} from "./support/cliTestHarness.js";
import {
  workspaceExecutionToken,
  WorkspaceExecutionHttpHarness,
  type WorkspaceExecutionHttpFailure,
  writeWorkspaceExecutionProfiles
} from "./support/workspaceExecutionHttpHarness.js";
import {
  skillEndpointListArgv,
  skillInteractionListArgv,
  skillInteractionRespondArgv,
  skillRemoteRunArgv,
  skillRunSessionResumeArgv
} from "./support/workspaceExecutionSkillCommands.js";

async function remoteWorkspace(input: {
  dispatchMode:
    | "action_required"
    | "hold_for_recovery"
    | "completed"
    | "failed"
    | "cancelled"
    | "writeback_failed";
  endpointCount?: number;
  localAvailable?: boolean;
  interactionKinds?: readonly ("permission" | "elicitation" | "authentication")[];
  duplicateActionId?: boolean;
  authorityMismatch?: boolean;
  replayTransition?: boolean;
  httpFailure?: WorkspaceExecutionHttpFailure;
  recoveryMiss?: boolean;
}) {
  const home = await mkdtemp(join(tmpdir(), "planweave-remote-cli-"));
  const env = {
    ...process.env,
    PLANWEAVE_HOME: home,
    PLANWEAVE_COLLABORATION_DEVICE_TOKEN: workspaceExecutionToken
  };
  const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true,
    force: true
  });
  const manifestPath = join(init.workspace.packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!input.localAvailable) {
    manifest.execution.defaultExecutor = "missing-codex";
    manifest.executors = {
      "missing-codex": {
        adapter: "codex-exec",
        command: `planweave-missing-codex-${Date.now()}`,
        args: ["exec", "-"]
      }
    };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const captured = await capturePackageSnapshot({ projectRoot: init.workspace });
  const graph = await loadPlanGraphPackage(init.workspace);
  const server = new WorkspaceExecutionHttpHarness({
    sourceRevision: captured.snapshot.sourceRevision,
    graphFingerprint: graph.graph.packageFingerprint,
    dispatchMode: input.dispatchMode,
    endpointCount: input.endpointCount,
    interactionKinds: input.interactionKinds,
    duplicateActionId: input.duplicateActionId,
    authorityMismatch: input.authorityMismatch,
    replayTransition: input.replayTransition,
    httpFailure: input.httpFailure,
    recoveryMiss: input.recoveryMiss
  });
  const serverOrigin = await server.start();
  await writeWorkspaceExecutionProfiles({ home, serverOrigin });
  return { env, init, server, serverOrigin };
}

function executionEvents(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => workspaceExecutionEventSchema.parse(JSON.parse(line)));
}

function remoteInteractionIdentityArgs(index = 1): string[] {
  return [
    "--dispatch",
    "dispatch-1",
    "--lease",
    "lease-1",
    "--attempt",
    "attempt-1",
    "--acp-session",
    `acp-session-${index}`
  ];
}

async function runCliAtExitCode(args: string[], env: NodeJS.ProcessEnv, exitCode: number) {
  if (exitCode === 0) {
    return { code: 0, ...(await runCli(args, env)) };
  }
  return runCliExpectFailure(args, env);
}

async function runInterruptedCli(input: {
  args: string[];
  env: NodeJS.ProcessEnv;
  interruptWhen: Promise<void>;
}) {
  const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const cliEntrypoint = join(repoRoot, "packages", "cli", "src", "index.ts");
  const child = spawn(process.execPath, [tsxCli, cliEntrypoint, ...input.args], {
    cwd: repoRoot,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );
  await input.interruptWhen;
  child.kill("SIGINT");
  return { ...(await closed), stdout, stderr };
}

function stableFixtureJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableFixtureJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableFixtureJson(record[key])}`)
    .join(",")}}`;
}

describe("remote execution CLI", () => {
  it("exposes the Coordinator-backed target, endpoint, connection, and event flags", () => {
    const commandNames = createProgram().commands.map((command) => command.name());
    const runOptions = commandOptionLongs("run");
    const interactionRespondOptions = subcommandOptionLongs("interaction", "respond");

    expect(commandNames).toContain("agent-endpoints");
    expect(commandNames).not.toEqual(expect.arrayContaining(["remote-run", "remote-operation"]));
    expect(runOptions).toEqual(
      expect.arrayContaining([
        "--target",
        "--agent-endpoint",
        "--connection-profile",
        "--event-format",
        "--follow"
      ])
    );
    expect(interactionRespondOptions).toEqual(
      expect.arrayContaining([
        "--record",
        "--request",
        "--lease",
        "--dispatch",
        "--attempt",
        "--acp-session",
        "--option",
        "--cancel",
        "--source",
        "--reason",
        "--json",
        "--canvas"
      ])
    );
    expect(interactionRespondOptions).not.toEqual(expect.arrayContaining(["--operation"]));
  });

  it(
    "restores an original pre-T005 v1 session across status, interaction, and follow subprocesses",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-pre-t005-cli-"));
      const env = {
        ...process.env,
        PLANWEAVE_HOME: home,
        PLANWEAVE_COLLABORATION_DEVICE_TOKEN: workspaceExecutionToken
      };
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
      const sourceRevision = "snapshot:pre-t005";
      const graphFingerprint = `pkg-${"b".repeat(64)}`;
      const server = new WorkspaceExecutionHttpHarness({
        sourceRevision,
        graphFingerprint,
        dispatchMode: "action_required"
      });
      const serverOrigin = await server.start();
      try {
        server.seedPersistedOperation();
        await writeWorkspaceExecutionProfiles({ home, serverOrigin });
        const legacyIdentity = {
          version: "planweave.workspace-authority-binding/v1",
          kind: "remote",
          packageWorkspace: init.workspace.workspaceRoot,
          connectionProfileId: "profile-1",
          serverOrigin,
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-001#B-001",
          authorityRevisions: {
            responsibilityRevision: 1,
            reviewerRevision: 2,
            executionTargetRevision: 3
          },
          contentRevision: sourceRevision,
          graphFingerprint
        };
        const bindingId = `wxb:sha256:${createHash("sha256")
          .update(stableFixtureJson(legacyIdentity))
          .digest("hex")}`;
        const rawFixture = await readFile(
          join(import.meta.dirname, "fixtures/preT005RemoteRunSession.json"),
          "utf8"
        );
        const sessionRoot = join(init.workspace.resultsDir, "run-sessions", "SESSION-0001");
        await mkdir(sessionRoot, { recursive: true });
        await writeFile(
          join(sessionRoot, "session.json"),
          rawFixture
            .replaceAll("__SERVER_ORIGIN__", serverOrigin)
            .replaceAll("__PACKAGE_WORKSPACE__", init.workspace.workspaceRoot)
            .replaceAll("__BINDING_ID__", bindingId),
          "utf8"
        );

        const status = JSON.parse(
          (await runCli(["run-status", "--session", "SESSION-0001", "--json"], env)).stdout
        );
        expect(status.session.workspaceExecution).toMatchObject({
          binding: {
            bindingId,
            contentAuthority: {
              kind: "package_snapshot",
              packageWorkspace: init.workspace.workspaceRoot
            }
          },
          handle: { authorityBindingId: bindingId }
        });

        const interactions = JSON.parse(
          (await runCli(skillInteractionListArgv("SESSION-0001", "profile-1"), env)).stdout
        );
        expect(interactions).toEqual([
          expect.objectContaining({ request: expect.objectContaining({ actionId: "action-1" }) })
        ]);

        const followed = await runCliExpectFailure(
          skillRunSessionResumeArgv("SESSION-0001", "profile-1"),
          env
        );
        expect(followed.code).toBe(7);
        expect(executionEvents(followed.stdout).map((event) => event.type)).toEqual(
          expect.arrayContaining(["operation_observed", "action_required", "interaction_required"])
        );
        expect(server.catalogCount).toBe(0);
        expect(server.dispatchCount).toBe(0);
      } finally {
        await server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

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

  it(
    "runs the remote CLI and settles the exact action with execution-v1-only stdout",
    async () => {
      const fixture = await remoteWorkspace({ dispatchMode: "action_required" });
      try {
        const endpoints = await runCli(skillEndpointListArgv("default", "profile-1"), fixture.env);
        expect(JSON.parse(endpoints.stdout).items).toHaveLength(1);
        const catalogBeforeRun = fixture.server.catalogCount;

        const started = await runCliExpectFailure(
          [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "auto",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1"
          ],
          fixture.env
        );
        expect(started.code).toBe(7);
        expect(started.stderr).toBe("");
        expect(started.stdout).not.toContain(workspaceExecutionToken);
        const events = executionEvents(started.stdout);
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining(["execution_selected", "action_required", "interaction_required"])
        );
        expect(events.find((event) => event.type === "execution_selected")?.data).toMatchObject({
          target: "remote",
          agentEndpointId: "endpoint-codex",
          connectionProfileId: "profile-1"
        });
        const sessionId = events[0]?.runSessionId;
        expect(sessionId).toMatch(/^SESSION-/);
        expect(fixture.server.catalogCount - catalogBeforeRun).toBe(1);
        expect(fixture.server.dispatchCount).toBe(1);
        expect((await listRunSessions(fixture.init.workspace)).sessions).toHaveLength(1);

        const listed = await runCli(
          [
            "interaction",
            "list",
            "--session",
            sessionId!,
            "--connection-profile",
            "profile-1",
            "--json"
          ],
          fixture.env
        );
        expect(JSON.parse(listed.stdout)).toEqual([
          expect.objectContaining({
            status: "pending",
            request: expect.objectContaining({ actionId: "action-1" })
          })
        ]);

        const responded = await runCli(
          [
            "interaction",
            "respond",
            "--session",
            sessionId!,
            "--action",
            "action-1",
            ...remoteInteractionIdentityArgs(),
            "--option",
            "allow_once",
            "--connection-profile",
            "profile-1",
            "--json"
          ],
          fixture.env
        );
        expect(JSON.parse(responded.stdout)).toMatchObject({ type: "interaction_resolved" });

        const settled = await runCliExpectFailure(
          [
            "interaction",
            "respond",
            "--session",
            sessionId!,
            "--action",
            "action-1",
            ...remoteInteractionIdentityArgs(),
            "--option",
            "allow_once",
            "--connection-profile",
            "profile-1"
          ],
          fixture.env
        );
        expect(settled).toMatchObject({ code: 7 });
        expect(settled.stderr).toContain("remote_interaction_not_found");
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "settles permission, elicitation, and authentication by complete identity when action ids repeat",
    async () => {
      const fixture = await remoteWorkspace({
        dispatchMode: "action_required",
        interactionKinds: ["permission", "elicitation", "authentication"],
        duplicateActionId: true,
        replayTransition: true
      });
      try {
        const endpoints = await runCli(skillEndpointListArgv("default", "profile-1"), fixture.env);
        expect(JSON.parse(endpoints.stdout).items).toHaveLength(1);
        const catalogAfterPreflight = fixture.server.catalogCount;
        const started = await runCliExpectFailure(
          skillRemoteRunArgv("T-001#B-001", "endpoint-codex", "profile-1"),
          fixture.env
        );
        expect(started.code).toBe(7);
        const events = executionEvents(started.stdout);
        const interactionEvents = events.filter((event) => event.type === "interaction_required");
        expect(interactionEvents).toHaveLength(3);
        expect(new Set(interactionEvents.map((event) => event.eventId)).size).toBe(3);
        const sessionId = events[0]!.runSessionId;

        const listed = JSON.parse(
          (await runCli(skillInteractionListArgv(sessionId, "profile-1"), fixture.env)).stdout
        );
        expect(listed).toHaveLength(3);
        expect(
          listed.map((item: { request: { actionId: string } }) => item.request.actionId)
        ).toEqual(["action-1", "action-1", "action-1"]);

        const expectations = [
          { index: 1, option: "allow_once", type: "interaction.permission_response" },
          { index: 2, option: "answer", type: "interaction.elicitation_response" },
          { index: 3, option: "retry", type: "interaction.authentication_action" }
        ] as const;
        for (const expected of expectations) {
          const responded = await runCli(
            skillInteractionRespondArgv({
              sessionId,
              dispatchId: "dispatch-1",
              leaseId: "lease-1",
              executionAttemptId: "attempt-1",
              acpSessionId: `acp-session-${expected.index}`,
              actionId: "action-1",
              option: expected.option,
              profileId: "profile-1"
            }),
            fixture.env
          );
          expect(JSON.parse(responded.stdout)).toMatchObject({
            type: "interaction_resolved",
            data: {
              type: expected.type,
              actionId: "action-1",
              acpSessionId: `acp-session-${expected.index}`
            }
          });
        }

        const empty = await runCli(skillInteractionListArgv(sessionId, "profile-1"), fixture.env);
        expect(JSON.parse(empty.stdout)).toEqual([]);

        const resumed = await runCli(
          skillRunSessionResumeArgv(sessionId, "profile-1"),
          fixture.env
        );
        const replayed = executionEvents(resumed.stdout);
        expect(replayed.map((event) => event.type)).toEqual(
          expect.arrayContaining([
            "attempt_changed",
            "retention_gap",
            "runner_event",
            "writeback_observed",
            "run_terminal"
          ])
        );
        expect(replayed.filter((event) => event.type === "runner_event")).toHaveLength(2);
        expect(fixture.server.replayQueries.slice(-2)).toEqual([0, 2]);

        const terminal = JSON.parse(
          (await runCli(["run-status", "--session", sessionId, "--json"], fixture.env)).stdout
        );
        expect(terminal.session.phase).toBe("completed");
        expect(catalogAfterPreflight).toBe(1);
        expect(fixture.server.catalogCount - catalogAfterPreflight).toBe(1);
        expect(fixture.server.dispatchCount).toBe(1);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "rejects command-level authority mismatch before Catalog, Dispatch, or session creation",
    async () => {
      const fixture = await remoteWorkspace({
        dispatchMode: "action_required",
        authorityMismatch: true
      });
      try {
        const failed = await runCliExpectFailure(
          [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "auto",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1"
          ],
          fixture.env
        );
        expect(failed.code).toBe(5);
        expect(failed.stderr).toContain("workspace_content_revision_mismatch");
        expect(fixture.server.catalogCount).toBe(0);
        expect(fixture.server.dispatchCount).toBe(0);
        expect((await listRunSessions(fixture.init.workspace)).sessions).toHaveLength(0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it.each([
    ["expired", "remote_interaction_expired", 7],
    ["settled", "remote_interaction_already_settled", 7],
    ["forbidden", "human_cross_project_forbidden", 5]
  ] as const)(
    "preserves the %s interaction settlement domain error through the HTTP CLI round trip",
    async (failure, errorCode, exitCode) => {
      const fixture = await remoteWorkspace({ dispatchMode: "action_required" });
      try {
        const started = await runCliExpectFailure(
          [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "remote",
            "--agent-endpoint",
            "endpoint-codex",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1"
          ],
          fixture.env
        );
        const sessionId = executionEvents(started.stdout)[0]!.runSessionId;
        fixture.server.rejectNextSettlementAs(failure);

        const response = await runCliExpectFailure(
          [
            "interaction",
            "respond",
            "--session",
            sessionId,
            "--action",
            "action-1",
            ...remoteInteractionIdentityArgs(),
            "--option",
            "allow_once",
            "--connection-profile",
            "profile-1"
          ],
          fixture.env
        );
        expect(response.code, response.stderr).toBe(exitCode);
        expect(response.stdout).toBe("");
        expect(response.stderr).toContain(errorCode);
        expect(response.stderr).not.toContain(workspaceExecutionToken);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it.each(
    (["catalog", "authority", "dispatch"] as const).flatMap((stage) =>
      (
        [
          [400, "human_remote_request_invalid", 2],
          [403, "human_cross_project_forbidden", 5],
          [409, "agent_endpoint_selection_required", 5],
          [500, "human_remote_request_failed", 8],
          [503, "human_remote_host_offline", 9]
        ] as const
      ).map(([status, code, exitCode]) => ({ stage, status, code, exitCode }))
    )
  )(
    "preserves $stage HTTP $status domain classification through the real CLI",
    async ({ stage, status, code, exitCode }) => {
      const fixture = await remoteWorkspace({
        dispatchMode: "action_required",
        httpFailure: { stage, status, code }
      });
      try {
        const failed = await runCliExpectFailure(
          stage === "catalog"
            ? skillEndpointListArgv("default", "profile-1")
            : skillRemoteRunArgv("T-001#B-001", "endpoint-codex", "profile-1"),
          fixture.env
        );
        expect(failed).toMatchObject({ code: exitCode, stdout: "" });
        expect(failed.stderr).toContain(code);
        expect(failed.stderr).not.toContain(workspaceExecutionToken);
        expect(fixture.server.catalogCount).toBe(stage === "authority" ? 0 : 1);
        expect(fixture.server.dispatchCount).toBe(stage === "dispatch" ? 1 : 0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it.each([
    [0, "agent_endpoint_unavailable"],
    [2, "agent_endpoint_selection_required"]
  ] as const)(
    "keeps auto remote selection side-effect free when Catalog has %i endpoints",
    async (endpointCount, errorCode) => {
      const fixture = await remoteWorkspace({
        dispatchMode: "action_required",
        endpointCount
      });
      try {
        const failed = await runCliExpectFailure(
          [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "auto",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1"
          ],
          fixture.env
        );
        expect(failed).toMatchObject({ code: 6, stdout: "" });
        expect(failed.stderr).toContain(errorCode);
        expect(fixture.server.catalogCount).toBe(1);
        expect(fixture.server.dispatchCount).toBe(0);
        expect((await listRunSessions(fixture.init.workspace)).sessions).toHaveLength(0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it.each([
    ["completed", 0],
    ["failed", 8],
    ["cancelled", 8],
    ["writeback_failed", 8],
    ["action_required", 7]
  ] as const)(
    "maps the %s Workspace result consistently across run, run-session, and run-status",
    async (dispatchMode, exitCode) => {
      const fixture = await remoteWorkspace({ dispatchMode });
      try {
        const started = await runCliAtExitCode(
          [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "remote",
            "--agent-endpoint",
            "endpoint-codex",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1"
          ],
          fixture.env,
          exitCode
        );
        expect(started.code).toBe(exitCode);
        const sessionId = executionEvents(started.stdout)[0]!.runSessionId;

        const session = await runCliAtExitCode(
          [
            "run-session",
            sessionId,
            "--follow",
            "--event-format",
            "execution-v1",
            "--connection-profile",
            "profile-1"
          ],
          fixture.env,
          exitCode
        );
        expect(session.code).toBe(exitCode);

        const status = await runCliAtExitCode(
          [
            "run-status",
            "--session",
            sessionId,
            "--follow",
            "--event-format",
            "execution-v1",
            "--connection-profile",
            "profile-1"
          ],
          fixture.env,
          exitCode
        );
        expect(status.code).toBe(exitCode);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "keeps auto local selection independent from remote Catalog and dispatch",
    async () => {
      const fixture = await remoteWorkspace({
        dispatchMode: "action_required",
        localAvailable: true
      });
      try {
        const result = await runCliExpectFailure(
          [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "auto",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1"
          ],
          fixture.env
        );
        expect(result.code).toBe(7);
        expect(executionEvents(result.stdout).map((event) => event.type)).toEqual(
          expect.arrayContaining(["execution_selected", "action_required"])
        );
        expect(fixture.server.catalogCount).toBe(0);
        expect(fixture.server.dispatchCount).toBe(0);
        expect((await listRunSessions(fixture.init.workspace)).sessions).toHaveLength(1);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "recovers an interrupted dispatch by exact idempotency key without redispatch",
    async () => {
      const fixture = await remoteWorkspace({ dispatchMode: "hold_for_recovery" });
      try {
        const interrupted = await runInterruptedCli({
          args: [
            "run",
            "--once",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--target",
            "remote",
            "--agent-endpoint",
            "endpoint-codex",
            "--connection-profile",
            "profile-1",
            "--event-format",
            "execution-v1",
            "--follow"
          ],
          env: fixture.env,
          interruptWhen: fixture.server.dispatchReceived
        });
        expect(interrupted).toMatchObject({ code: 130, signal: null });
        expect(interrupted.stdout).toBe("");
        const sessions = await listRunSessions(fixture.init.workspace);
        expect(sessions.sessions).toHaveLength(1);
        const session = sessions.sessions[0]!;
        expect(session.workspaceExecution).toMatchObject({
          handle: null,
          dispatchIntent: expect.objectContaining({
            canvasId: "default",
            blockRef: "T-001#B-001"
          })
        });

        const recovered = await runCli(
          [
            "run-session",
            session.sessionId,
            "--follow",
            "--event-format",
            "execution-v1",
            "--connection-profile",
            "profile-1"
          ],
          fixture.env
        );
        const events = executionEvents(recovered.stdout);
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining(["operation_observed", "writeback_observed", "run_terminal"])
        );
        expect(recovered.stdout).not.toContain("idempotencyKey");
        expect(fixture.server.dispatchCount).toBe(1);
        expect(fixture.server.recoveryQueries).toHaveLength(1);
        expect(Object.fromEntries(fixture.server.recoveryQueries[0]!)).toEqual({
          canvasId: "default",
          blockRef: "T-001#B-001",
          idempotencyKey: session.workspaceExecution?.dispatchIntent?.idempotencyKey
        });
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "fails closed when exact interrupted-dispatch recovery returns no operation",
    async () => {
      const fixture = await remoteWorkspace({
        dispatchMode: "hold_for_recovery",
        recoveryMiss: true
      });
      try {
        const interrupted = await runInterruptedCli({
          args: skillRemoteRunArgv("T-001#B-001", "endpoint-codex", "profile-1"),
          env: fixture.env,
          interruptWhen: fixture.server.dispatchReceived
        });
        expect(interrupted).toMatchObject({ code: 130, signal: null });
        const sessions = await listRunSessions(fixture.init.workspace);
        const session = sessions.sessions[0]!;
        expect(session.workspaceExecution).toMatchObject({
          handle: null,
          dispatchIntent: expect.objectContaining({
            canvasId: "default",
            blockRef: "T-001#B-001"
          })
        });

        const failed = await runCliExpectFailure(
          skillRunSessionResumeArgv(session.sessionId, "profile-1"),
          fixture.env
        );
        expect(failed).toMatchObject({ code: 8, stdout: "" });
        expect(failed.stderr).toContain("workspace_execution_resume_mismatch");
        expect(failed.stderr).not.toContain(
          session.workspaceExecution?.dispatchIntent?.idempotencyKey ?? "missing-key"
        );
        expect(fixture.server.dispatchCount).toBe(1);
        expect(fixture.server.recoveryQueries).toHaveLength(1);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );
});
