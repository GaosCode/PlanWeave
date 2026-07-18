import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentRunnerInteractionStore } from "../../../runtime/src/autoRun/runnerInteractionStore.js";
import { writeJsonFile } from "../../../runtime/src/json.js";
import { AgentRunControlOwnerProcess } from "../../../runtime/src/__tests__/support/agentRunControlProcessHarness.js";
import { repoRoot, runCli, runCliExpectFailure } from "./support/cliTestHarness.js";

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

async function createPendingInteraction() {
  const home = await mkdtemp(join(tmpdir(), "planweave-interaction-cli-"));
  const env = { ...process.env, PLANWEAVE_HOME: home };
  const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
    workspace: { id: string; packageDir: string; resultsDir: string };
  };
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true,
    force: true
  });
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
    summary: "Allow tests?",
    toolCallId: "tool-1",
    options: [
      { optionId: "allow_once", label: "Allow once", decision: "approve" },
      { optionId: "reject_once", label: "Reject once", decision: "deny" }
    ]
  });
  const { owner } = await AgentRunControlOwnerProcess.start(
    runDir,
    controlIdentity,
    interactionFixtureReadyTimeoutMs
  );
  owners.add(owner);
  owner.send({ kind: "add_request", requestKind: "permission", requestId: identity.requestId });
  await owner.waitFor(
    (message) => message.kind === "request_ready" && message.requestId === identity.requestId,
    "CLI fixture permission request",
    interactionFixtureReadyTimeoutMs
  );
  return { env, identity, runDir };
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

describe("interaction CLI commands", () => {
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
    "returns stable codes for invalid options and replaced leases",
    async () => {
      const invalid = await createPendingInteraction();
      const invalidOption = await runCliExpectFailure(
        [...respondArgs(invalid.identity), "--option", "missing"],
        invalid.env
      );
      expect(JSON.parse(invalidOption.stdout)).toMatchObject({
        error: { code: "interaction_option_not_advertised" }
      });

      const replaced = await createPendingInteraction();
      const replacedLease = await runCliExpectFailure(
        [
          ...respondArgs(replaced.identity).map((value) =>
            value === replaced.identity.ownerLeaseId
              ? "22222222-2222-4222-8222-222222222222"
              : value
          ),
          "--cancel",
          "--reason",
          "operator cancelled"
        ],
        replaced.env
      );
      expect(JSON.parse(replacedLease.stdout)).toMatchObject({
        error: { code: "interaction_owner_replaced" }
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
    },
    interactionCommandsTimeoutMs
  );
});
