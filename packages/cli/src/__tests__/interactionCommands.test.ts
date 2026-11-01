import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpEventReadModelRegistry } from "../../../runtime/src/autoRun/acpEventReadModel.js";
import { AcpSessionController } from "../../../runtime/src/autoRun/acpSessionController.js";
import { ActiveAgentRunRegistry } from "../../../runtime/src/autoRun/activeAgentRunRegistry.js";
import { PersistentRunnerInteractionStore } from "../../../runtime/src/autoRun/runnerInteractionStore.js";
import { writeJsonFile } from "../../../runtime/src/json.js";
import { acpProfileTestValues } from "../../../runtime/src/__tests__/support/acpProfileTestValues.js";
import { AgentRunControlOwnerProcess } from "../../../runtime/src/__tests__/support/agentRunControlProcessHarness.js";
import {
  installPlanweaveShim,
  repoRoot,
  runCli,
  runCliExpectFailure,
  runShellCommand
} from "./support/cliTestHarness.js";

const ownerLeaseId = "11111111-1111-4111-8111-111111111111";
const interactionCommandsTimeoutMs = 30_000;
const interactionFixtureReadyTimeoutMs = 10_000;
const owners = new Set<AgentRunControlOwnerProcess>();

afterEach(async () => {
  await Promise.all(
    [...owners].map(async (owner) => {
      owners.delete(owner);
      await owner.terminate();
    })
  );
});

async function createInteractionWorkspace(projectName?: string) {
  const home = await mkdtemp(join(tmpdir(), `planweave-interaction-cli-${projectName ?? ""}`));
  const projectRoot = repoRoot;
  const sourceConfig = join(home, "tsconfig.json");
  await writeFile(
    sourceConfig,
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.json"),
      compilerOptions: {
        paths: { "@planweave-ai/runtime": [join(repoRoot, "packages/runtime/src/index.ts")] }
      }
    })
  );
  const env = {
    ...process.env,
    PLANWEAVE_HOME: home,
    PLANWEAVE_PROJECT_ROOT: projectRoot,
    TSX_TSCONFIG_PATH: sourceConfig
  };
  const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
    workspace: { id: string; packageDir: string; resultsDir: string; workspaceRoot: string };
  };
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true,
    force: true
  });
  return {
    home,
    env: { ...env, PLANWEAVE_PROJECT_ROOT: init.workspace.workspaceRoot },
    init,
    projectRoot: init.workspace.workspaceRoot
  };
}

async function createPendingInteraction(optionId = "allow_once", projectName?: string) {
  const { env, init, home, projectRoot } = await createInteractionWorkspace(projectName);
  const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
  await mkdir(runDir, { recursive: true });
  const now = new Date().toISOString();
  const identity = {
    projectId: init.workspace.id,
    canvasId: "default",
    claimRef: "T-001#B-001",
    executorRunId: "RUN-001",
    sessionId: "session-1",
    requestId: "permission:1",
    ownerLeaseId,
    ownerGeneration: 1
  } as const;
  const controlIdentity = {
    scope: runDir,
    executorRunId: identity.executorRunId,
    desktopRunId: null,
    runSessionId: "CLI-SESSION-001",
    claimRef: identity.claimRef,
    sessionId: identity.sessionId
  };
  await writeJsonFile(join(runDir, "metadata.json"), {
    runnerKind: "acp",
    runId: identity.executorRunId,
    executorRunId: identity.executorRunId,
    ref: identity.claimRef,
    projectId: identity.projectId,
    canvasId: identity.canvasId,
    sessionId: identity.sessionId,
    ownerLeaseId,
    ownerGeneration: 1,
    status: "running",
    desktopRunId: controlIdentity.desktopRunId,
    runSessionId: controlIdentity.runSessionId,
    claimRef: controlIdentity.claimRef
  });
  await writeJsonFile(join(runDir, "heartbeat.json"), {
    status: "running",
    pid: process.pid,
    startedAt: now,
    lastHeartbeatAt: now,
    finishedAt: null,
    ownerLeaseId,
    ownerGeneration: 1,
    runnerLifecycle: "waiting_interaction",
    pendingInteractionIds: [identity.requestId]
  });
  await new PersistentRunnerInteractionStore(runDir).createRequest({
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity,
    requestedAt: now,
    summary: "Permission requested for: Allow tests?",
    toolCallId: "tool-1",
    options: [
      { optionId, label: "Allow once", decision: "approve" },
      { optionId: "reject_once", label: "Reject once", decision: "deny" }
    ]
  });
  const { owner } = await AgentRunControlOwnerProcess.start(
    runDir,
    controlIdentity,
    interactionFixtureReadyTimeoutMs
  );
  owners.add(owner);
  owner.send({
    kind: "add_request",
    requestKind: "permission",
    requestId: identity.requestId,
    persistent: true
  });
  await owner.waitFor(
    (message) => message.kind === "request_ready" && message.requestId === identity.requestId,
    "CLI fixture permission request",
    interactionFixtureReadyTimeoutMs
  );
  return { env, identity, runDir, home, projectRoot, init };
}

function respondArgs(identity: Awaited<ReturnType<typeof createPendingInteraction>>["identity"]) {
  return [
    "interaction",
    "respond",
    "--record",
    `${identity.claimRef}::${identity.executorRunId}`,
    "--request",
    identity.requestId,
    "--lease",
    identity.ownerLeaseId,
    "--source",
    "coordinator-any",
    "--json"
  ];
}

function startLiveOwner(
  init: Awaited<ReturnType<typeof createInteractionWorkspace>>["init"],
  runDir: string,
  onMetadataPersisted?: () => void
) {
  const abort = new AbortController();
  const execution = new AcpSessionController(
    new ActiveAgentRunRegistry(),
    undefined,
    new AcpEventReadModelRegistry()
  )
    .execute(
      {
        kind: "implementation",
        identity: {
          scope: runDir,
          desktopRunId: null,
          runSessionId: "CLI-LIVE",
          executorRunId: "RUN-LIVE",
          claimRef: "T-001#B-001"
        },
        runDir,
        metadataPath: join(runDir, "metadata.json"),
        prompt: "permission-secret",
        cwd: repoRoot,
        ...acpProfileTestValues({
          command: process.execPath,
          args: [
            join(repoRoot, "packages/runtime/src/__tests__/support/acpMockAgent.mjs"),
            "permission-secret"
          ]
        }),
        executorName: "mock-acp",
        agentId: "codex",
        taskId: "T-001",
        metadataIdentity: { blockId: "B-001" },
        projectId: init.workspace.id,
        canvasId: "default"
      },
      { signal: abort.signal, timeoutMs: 20_000, onMetadataPersisted }
    )
    .then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error })
    );
  return { abort, execution };
}

function firstPosixCommand(human: string): string {
  const start = human.indexOf("POSIX: ");
  const end = human.indexOf("\nPowerShell:", start);
  if (start < 0 || end < 0) throw new Error("Missing POSIX response command");
  return human.slice(start + "POSIX: ".length, end);
}

describe("interaction CLI commands", () => {
  it(
    "responds to a real ACP owner using only the human list command",
    async () => {
      const { home, env, init } = await createInteractionWorkspace();
      const runDir = join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-LIVE"
      );
      const { abort, execution } = startLiveOwner(init, runDir);
      try {
        let human = "";
        const deadline = Date.now() + interactionFixtureReadyTimeoutMs;
        while (Date.now() < deadline) {
          human = (await runCli(["interaction", "list"], env)).stdout;
          if (!human.includes("No actionable runner interactions.")) break;
        }
        expect(human).toContain(`Project: ${init.workspace.id}`);
        expect(human).toContain("Canvas: default");
        expect(human).toContain("Owner lease:");
        const command = firstPosixCommand(human);
        const binDir = join(home, "bin");
        await installPlanweaveShim(binDir);
        const responded = await runShellCommand(
          command,
          { ...env, PATH: `${binDir}:${env.PATH}` },
          repoRoot
        );
        expect(responded.stdout).toContain("Runner interaction response accepted");
        expect((await execution).error).toBeUndefined();
        expect((await runCli(["interaction", "list"], env)).stdout.trim()).toBe(
          "No actionable runner interactions."
        );
      } finally {
        abort.abort();
        await execution;
      }
    },
    interactionCommandsTimeoutMs
  );

  it(
    "registers interaction commands and the event-stream run option in help",
    async () => {
      const env = { ...process.env };
      const interactionHelp = (await runCli(["interaction", "--help"], env)).stdout;
      expect(interactionHelp).toContain("list");
      expect(interactionHelp).toContain("respond");
      expect((await runCli(["run", "--help"], env)).stdout).toContain("--event-stream");
    },
    interactionCommandsTimeoutMs
  );

  it(
    "lists only actionable Runtime snapshots and accepts an advertised option",
    async () => {
      const fixture = await createPendingInteraction();
      const listed = JSON.parse(
        (await runCli(["interaction", "list", "--json"], fixture.env)).stdout
      ) as Array<{ status: string; request: { identity: { requestId: string } } }>;
      expect(listed).toMatchObject([
        { status: "pending", request: { identity: { requestId: "permission:1" } } }
      ]);

      const receipt = JSON.parse(
        (
          await runCli(
            [...respondArgs(fixture.identity), "--option", "allow_once", "--reason", "approved"],
            fixture.env
          )
        ).stdout
      );
      expect(receipt).toMatchObject({
        version: "planweave.runner-interaction-response-receipt/v1",
        decisionSource: "coordinator-any",
        selectedOption: { optionId: "allow_once", decision: "approve" }
      });

      const answered = await runCliExpectFailure(
        [...respondArgs(fixture.identity), "--option", "allow_once"],
        fixture.env
      );
      expect(JSON.parse(answered.stdout)).toMatchObject({
        ok: false,
        error: { code: "interaction_already_answered" }
      });
    },
    interactionCommandsTimeoutMs
  );

  it(
    "rejects an option that the owner did not advertise",
    async () => {
      const invalid = await createPendingInteraction();
      const invalidOption = await runCliExpectFailure(
        [...respondArgs(invalid.identity), "--option", "missing"],
        invalid.env
      );
      expect(JSON.parse(invalidOption.stdout)).toMatchObject({
        error: { code: "interaction_option_not_advertised" }
      });
    },
    interactionCommandsTimeoutMs
  );

  it(
    "returns stable codes for stale, terminal, and invalid persisted state",
    async () => {
      const stale = await createPendingInteraction();
      const staleAt = new Date(Date.now() - 60_000).toISOString();
      await writeJsonFile(join(stale.runDir, "heartbeat.json"), {
        status: "running",
        pid: process.pid,
        startedAt: staleAt,
        lastHeartbeatAt: staleAt,
        finishedAt: null,
        ownerLeaseId,
        ownerGeneration: 1,
        runnerLifecycle: "waiting_interaction",
        pendingInteractionIds: [stale.identity.requestId]
      });
      const staleFailure = await runCliExpectFailure(
        [...respondArgs(stale.identity), "--option", "allow_once"],
        stale.env
      );
      expect(staleFailure.code).not.toBe(0);
      expect(JSON.parse(staleFailure.stdout)).toMatchObject({
        error: { code: "interaction_owner_unavailable" }
      });

      const terminal = await createPendingInteraction();
      await writeJsonFile(join(terminal.runDir, "metadata.json"), {
        runnerKind: "acp",
        runId: terminal.identity.executorRunId,
        executorRunId: terminal.identity.executorRunId,
        ref: terminal.identity.claimRef,
        projectId: terminal.identity.projectId,
        canvasId: terminal.identity.canvasId,
        sessionId: terminal.identity.sessionId,
        ownerLeaseId,
        ownerGeneration: 1,
        status: "completed",
        desktopRunId: null,
        runSessionId: "CLI-SESSION-001",
        claimRef: terminal.identity.claimRef
      });
      const terminalFailure = await runCliExpectFailure(
        [...respondArgs(terminal.identity), "--cancel", "--reason", "run ended"],
        terminal.env
      );
      expect(terminalFailure.code).not.toBe(0);
      expect(JSON.parse(terminalFailure.stdout)).toMatchObject({
        error: { code: "interaction_run_terminal" }
      });

      const invalid = await createPendingInteraction();
      await writeFile(join(invalid.runDir, "heartbeat.json"), "{}", "utf8");
      const invalidFailure = await runCliExpectFailure(
        [...respondArgs(invalid.identity), "--option", "allow_once"],
        invalid.env
      );
      expect(invalidFailure.code).not.toBe(0);
      expect(JSON.parse(invalidFailure.stdout)).toMatchObject({
        error: { code: "interaction_contract_invalid" }
      });
    },
    interactionCommandsTimeoutMs
  );

  it(
    "rejects a copied human command after a real ACP owner replaces its lease",
    async () => {
      const { home, env, init } = await createInteractionWorkspace();
      const runDir = join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-LIVE"
      );
      const first = startLiveOwner(init, runDir);
      let second: ReturnType<typeof startLiveOwner> | undefined;
      try {
        let human = "";
        const deadline = Date.now() + interactionFixtureReadyTimeoutMs;
        while (Date.now() < deadline) {
          human = (await runCli(["interaction", "list"], env)).stdout;
          if (human.includes("POSIX:")) break;
        }
        const command = firstPosixCommand(human);
        const listedLease = human.match(/^Owner lease: (.+)$/m)?.[1];
        expect(listedLease).toBeTruthy();
        const original = await new PersistentRunnerInteractionStore(runDir).readSnapshot(
          "permission:1"
        );
        let metadataPersisted!: () => void;
        const persisted = new Promise<void>((resolve) => {
          metadataPersisted = resolve;
        });
        second = startLiveOwner(init, runDir, metadataPersisted);
        await Promise.race([
          persisted,
          second.execution.then(({ error }) => {
            throw error ?? new Error("Replacement owner ended before metadata publication");
          })
        ]);
        const metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"));
        expect(metadata.ownerLeaseId).not.toBe(listedLease);
        await vi.waitFor(
          async () => {
            const current = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"));
            expect(current.sessionId).toBe(original.request.identity.sessionId);
            expect(current.ownerLeaseId).not.toBe(listedLease);
          },
          { timeout: interactionFixtureReadyTimeoutMs }
        );
        const binDir = join(home, "bin");
        await installPlanweaveShim(binDir);
        await expect(
          runShellCommand(`${command} --json`, { ...env, PATH: `${binDir}:${env.PATH}` }, repoRoot)
        ).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining('"code":"interaction_owner_replaced"')
        });
      } finally {
        first.abort.abort();
        second?.abort.abort();
        await Promise.all([first.execution, second?.execution]);
      }
    },
    interactionCommandsTimeoutMs
  );

  it.each([
    "--leading-dashes",
    "space Unicode 中文",
    "single'quote",
    "smart‘’‚‛quotes",
    "line\nbreak",
    '$(printf INJECTED); `printf INJECTED` "double"'
  ])(
    "round trips local option %j through POSIX and keeps the exact audit identity",
    async (optionId) => {
      const projectName = "-project '单引号' ‘智能’ space\nline $(printf INJECTED)";
      const fixture = await createPendingInteraction(optionId, projectName);
      const human = (await runCli(["interaction", "list"], fixture.env)).stdout;
      const binDir = join(fixture.home, "bin");
      await installPlanweaveShim(binDir);
      const result = await runShellCommand(
        `${firstPosixCommand(human)} --json`,
        { ...fixture.env, PATH: `${binDir}:${fixture.env.PATH}`, PLANWEAVE_PROJECT_ROOT: repoRoot },
        repoRoot
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        version: "planweave.runner-interaction-response-receipt/v1",
        identity: { projectId: fixture.init.workspace.id, canvasId: "default" },
        selectedOption: { optionId, label: "Allow once", decision: "approve" },
        decisionSource: "cli.interaction-list"
      });
    },
    interactionCommandsTimeoutMs
  );

  it.each(["\x1b[2J", "\r", "\u202e"])(
    "refuses local commands with unsafe option %j while JSON keeps the canonical value",
    async (control) => {
      const optionId = `choice${control}tail`;
      const fixture = await createPendingInteraction(optionId);
      const human = (await runCli(["interaction", "list"], fixture.env)).stdout;
      expect(human).toContain("Response: command unavailable");
      expect(human).not.toContain(control);
      const listed = JSON.parse(
        (await runCli(["interaction", "list", "--json"], fixture.env)).stdout
      );
      expect(listed[0].request.options[0].optionId).toBe(optionId);
    },
    interactionCommandsTimeoutMs
  );

  it(
    "keeps the fixed JSON snapshot contract, empty output, and canvas isolation",
    async () => {
      const fixture = await createPendingInteraction();
      const json = (await runCli(["interaction", "list", "--json"], fixture.env)).stdout;
      const snapshot = await new PersistentRunnerInteractionStore(fixture.runDir).readSnapshot(
        "permission:1"
      );
      expect(json).toBe(`${JSON.stringify([snapshot], null, 2)}\n`);
      expect(Object.keys(JSON.parse(json)[0]).sort()).toEqual([
        "interactionId",
        "ownerResult",
        "request",
        "response",
        "status",
        "version"
      ]);
      await runCli(
        ["canvas", "create", "--id=other-canvas", "--title=Other", "--activate"],
        fixture.env
      );
      expect((await runCli(["interaction", "list"], fixture.env)).stdout).toBe(
        "No actionable runner interactions.\n"
      );
      expect((await runCli(["interaction", "list", "--json"], fixture.env)).stdout).toBe("[]\n");
      const crossed = await runCliExpectFailure(
        [...respondArgs(fixture.identity), "--option=allow_once"],
        fixture.env
      );
      expect(JSON.parse(crossed.stdout)).toMatchObject({
        error: { code: "interaction_not_found" }
      });
      const human = (await runCli(["interaction", "list", "--canvas=default"], fixture.env)).stdout;
      expect(human).toContain("Canvas: default");
      const binDir = join(fixture.home, "bin");
      await installPlanweaveShim(binDir);
      const result = await runShellCommand(
        `${firstPosixCommand(human)} --json`,
        { ...fixture.env, PATH: `${binDir}:${fixture.env.PATH}` },
        repoRoot
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        identity: { canvasId: "default" },
        selectedOption: { optionId: "allow_once" }
      });
    },
    interactionCommandsTimeoutMs
  );

  it(
    "requires exactly one decision and a cancellation reason",
    async () => {
      const fixture = await createPendingInteraction();
      const both = await runCliExpectFailure(
        [...respondArgs(fixture.identity), "--option", "allow_once", "--cancel", "--reason", "no"],
        fixture.env
      );
      expect(both.stderr).toContain("exactly one of --option or --cancel");

      const missingReason = await runCliExpectFailure(
        [...respondArgs(fixture.identity), "--cancel"],
        fixture.env
      );
      expect(missingReason.stderr).toContain("--cancel requires --reason");
      const blankReason = await runCliExpectFailure(
        [...respondArgs(fixture.identity), "--cancel", "--reason=   "],
        fixture.env
      );
      expect(blankReason.stderr).toContain("--cancel requires --reason");
      const blankSource = await runCliExpectFailure(
        [...respondArgs(fixture.identity), "--option=allow_once", "--source=   "],
        fixture.env
      );
      expect(JSON.parse(blankSource.stdout)).toMatchObject({
        error: { code: "interaction_contract_invalid" }
      });
      const reason = "Operator chose to stop 中文";
      const cancelled = JSON.parse(
        (
          await runCli(
            [...respondArgs(fixture.identity), "--cancel", `--reason=${reason}`],
            fixture.env
          )
        ).stdout
      );
      expect(cancelled).toMatchObject({
        decision: { kind: "cancel" },
        selectedOption: null,
        decisionSource: "coordinator-any"
      });
    },
    interactionCommandsTimeoutMs
  );
});
