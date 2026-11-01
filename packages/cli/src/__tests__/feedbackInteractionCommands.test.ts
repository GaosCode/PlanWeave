import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionController } from "../../../runtime/src/autoRun/acpSessionController.js";
import { ActiveAgentRunRegistry } from "../../../runtime/src/autoRun/activeAgentRunRegistry.js";
import { AcpEventReadModelRegistry } from "../../../runtime/src/autoRun/acpEventReadModel.js";
import type { RunEvent } from "../../../runtime/src/autoRun/runnerInteractionObserver.js";
import { PersistentRunnerInteractionStore } from "../../../runtime/src/autoRun/runnerInteractionStore.js";
import { acpProfileTestValues } from "../../../runtime/src/__tests__/support/acpProfileTestValues.js";
import { respondToRunnerInteraction } from "../../../runtime/src/desktop/runnerInteractionApi.js";
import {
  installPlanweaveShim,
  repoRoot,
  runCli,
  runShellCommand
} from "./support/cliTestHarness.js";

const readyTimeoutMs = 10_000;
const workflowTimeoutMs = 40_000;

async function createFeedbackWorkspace(runId = "RUN-FEEDBACK") {
  const root = await mkdtemp(join(tmpdir(), "planweave-feedback-interaction-cli-"));
  const projectRoot = join(root, "project");
  const home = join(root, "home");
  await mkdir(projectRoot);
  const sourceConfig = join(root, "tsconfig.json");
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
    workspace: { id: string; packageDir: string; resultsDir: string };
  };
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true
  });
  const binDir = join(root, "bin");
  await installPlanweaveShim(binDir);
  return {
    projectRoot,
    init,
    env: { ...env, PATH: `${binDir}:${env.PATH ?? ""}` },
    runId,
    runDir: join(init.workspace.resultsDir, "feedback-runs", runId)
  };
}

function startOwner(
  fixture: Awaited<ReturnType<typeof createFeedbackWorkspace>>,
  scenario: "permission-secret" | "permission-deny" | "artifact-review" = "permission-secret",
  onMetadataPersisted?: () => void,
  kind: "feedback" | "implementation" = "feedback"
) {
  const review = scenario === "artifact-review";
  const runDir = review
    ? join(fixture.init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", fixture.runId)
    : kind === "implementation"
      ? join(fixture.init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", fixture.runId)
      : fixture.runDir;
  const abort = new AbortController();
  const events: RunEvent[] = [];
  const execution = new AcpSessionController(
    new ActiveAgentRunRegistry(),
    undefined,
    new AcpEventReadModelRegistry()
  )
    .execute(
      {
        kind: review ? "review" : kind,
        identity: {
          scope: runDir,
          desktopRunId: null,
          runSessionId: "CLI-FEEDBACK",
          executorRunId: fixture.runId,
          claimRef: kind === "implementation" && !review ? "T-001#B-001" : "T-001#R-001"
        },
        runDir,
        metadataPath: join(runDir, "metadata.json"),
        prompt: scenario,
        cwd: fixture.projectRoot,
        ...acpProfileTestValues({
          command: process.execPath,
          args: [
            join(repoRoot, "packages/runtime/src/__tests__/support/acpMockAgent.mjs"),
            review || kind === "implementation" ? scenario : `feedback-${scenario}`
          ]
        }),
        executorName: "mock-acp",
        agentId: "codex",
        taskId: "T-001",
        metadataIdentity: review
          ? { blockId: "R-001" }
          : kind === "implementation"
            ? { blockId: "B-001" }
            : { feedbackId: "FE-001", sourceReviewBlockRef: "T-001#R-001" },
        projectId: fixture.init.workspace.id,
        canvasId: "default"
      },
      {
        signal: abort.signal,
        timeoutMs: 30_000,
        onMetadataPersisted,
        interactionObserver: {
          interactionRequired: (event) => {
            events.push(event);
          },
          interactionResolved: (event) => {
            events.push(event);
          }
        }
      }
    )
    .then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error })
    );
  return { abort, execution, events, runDir };
}

async function waitForHumanList(env: NodeJS.ProcessEnv): Promise<string> {
  let human = "";
  await vi.waitFor(
    async () => {
      human = (await runCli(["interaction", "list"], env)).stdout;
      expect(human).toContain("POSIX:");
    },
    { timeout: readyTimeoutMs, interval: 25 }
  );
  return human;
}

function printedCommand(human: string, kind: "response" | "cancel"): string {
  const section = kind === "cancel" ? human.slice(human.indexOf("Cancel:\n")) : human;
  const match = section.match(/^POSIX: (.+)$/m);
  if (!match) throw new Error(`Missing printed ${kind} command.`);
  return match[1]!;
}

describe("feedback interaction CLI commands", () => {
  it(
    "answers the feedback owner when completed review history has the same RUN-001",
    async () => {
      const fixture = await createFeedbackWorkspace("RUN-001");
      vi.stubEnv("PLANWEAVE_HOME", fixture.env.PLANWEAVE_HOME);
      const review = await startOwner(fixture, "artifact-review").execution;
      expect(review.error).toBeUndefined();
      expect(review.result).toMatchObject({ kind: "review", exitCode: 0 });
      const owner = startOwner(fixture);
      try {
        await waitForHumanList(fixture.env);
        const snapshot = await new PersistentRunnerInteractionStore(fixture.runDir).readSnapshot(
          "permission:1"
        );
        await expect(
          respondToRunnerInteraction(
            { projectRoot: fixture.projectRoot, canvasId: "default" },
            snapshot.request.identity,
            { kind: "select", optionId: "token=opaque-action-id" },
            { decisionSource: "runtime-feedback-test", reason: null }
          )
        ).resolves.toMatchObject({ selectedOption: { decision: "approve" } });
        expect((await owner.execution).error).toBeUndefined();
        expect(await readFile(join(fixture.runDir, "protocol.ndjson"), "utf8")).toContain(
          '"optionId":"token=opaque-action-id"'
        );
      } finally {
        owner.abort.abort();
        await owner.execution;
      }
    },
    workflowTimeoutMs
  );

  it.each(["mismatched", "ambiguous"] as const)(
    "rejects %s complete identities without delivering a decision",
    async (caseName) => {
      const fixture = await createFeedbackWorkspace("RUN-001");
      vi.stubEnv("PLANWEAVE_HOME", fixture.env.PLANWEAVE_HOME);
      const review = await startOwner(fixture, "artifact-review").execution;
      expect(review.error).toBeUndefined();
      const owner = startOwner(fixture);
      try {
        await waitForHumanList(fixture.env);
        const store = new PersistentRunnerInteractionStore(fixture.runDir);
        const snapshot = await store.readSnapshot("permission:1");
        const respond = (identity: typeof snapshot.request.identity) =>
          respondToRunnerInteraction(
            { projectRoot: fixture.projectRoot, canvasId: "default" },
            identity,
            { kind: "select", optionId: "token=opaque-action-id" },
            { decisionSource: "runtime-feedback-test", reason: null }
          );
        if (caseName === "mismatched") {
          await expect(
            respond({ ...snapshot.request.identity, sessionId: "another-session" })
          ).rejects.toMatchObject({ code: "interaction_identity_mismatch" });
        } else {
          const reviewStore = new PersistentRunnerInteractionStore(
            join(
              fixture.init.workspace.resultsDir,
              "T-001",
              "blocks",
              "R-001",
              "runs",
              fixture.runId
            )
          );
          await reviewStore.createRequest(snapshot.request);
          await expect(respond(snapshot.request.identity)).rejects.toMatchObject({
            code: "interaction_identity_mismatch",
            message: "Runner interaction identity matches multiple canonical run records."
          });
          await expect(reviewStore.readSnapshot("permission:1")).resolves.toMatchObject({
            response: null
          });
        }
        await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({ response: null });
        expect(await readFile(join(fixture.runDir, "protocol.ndjson"), "utf8")).not.toContain(
          '"outcome":"selected"'
        );
      } finally {
        owner.abort.abort();
        await owner.execution;
      }
    },
    workflowTimeoutMs
  );

  describe.each(["feedback", "implementation"] as const)("persists %s CLI audit", (kind) => {
    it.each([
      ["approve", "permission-secret", "token=opaque-action-id", "approved"],
      ["deny", "permission-deny", "deny", "denied"],
      ["cancel", "permission-secret", null, "cancelled"]
    ] as const)(
      "delivers the printed %s command to the real feedback ACP owner",
      async (decision, scenario, optionId, outcome) => {
        const fixture = await createFeedbackWorkspace();
        const owner = startOwner(fixture, scenario, undefined, kind);
        try {
          const human = await waitForHumanList(fixture.env);
          const store = new PersistentRunnerInteractionStore(owner.runDir);
          const snapshot = await store.readSnapshot("permission:1");
          const json = (await runCli(["interaction", "list", "--json"], fixture.env)).stdout;
          expect(json).toBe(`${JSON.stringify([snapshot], null, 2)}\n`);
          const recordId =
            kind === "feedback" ? "FE-001::RUN-FEEDBACK" : "T-001#B-001::RUN-FEEDBACK";
          const actionArgs = [
            "interaction",
            "respond",
            "--record",
            recordId,
            "--request",
            snapshot.request.identity.requestId,
            "--lease",
            snapshot.request.identity.ownerLeaseId,
            "--source",
            "cli.audit-proof",
            "--json"
          ];
          const rejected = await runCli(
            [...actionArgs, "--option", "unpublished-option"],
            fixture.env
          ).then(
            () => {
              throw new Error("Unexpectedly accepted unpublished option.");
            },
            (error: unknown) => error
          );
          expect(rejected).toMatchObject({
            code: 1,
            stdout: expect.stringContaining("interaction_option_not_advertised")
          });
          expect((await store.readSnapshot("permission:1")).response).toBeNull();
          const reason =
            decision === "deny"
              ? "Operator reason; password=super-secret"
              : "User supplied non-secret audit reason";
          const expectedReason =
            decision === "deny" ? "Operator reason; [REDACTED:CREDENTIAL]" : reason;
          const command = printedCommand(human, decision === "cancel" ? "cancel" : "response")
            .replace("<REPLACE_WITH_YOUR_REASON>", "User supplied non-secret audit reason")
            .replace("cli.interaction-list", "cli.audit-proof");
          const receipt = JSON.parse(
            (
              await runShellCommand(
                `${command} --reason '${reason}' --json`,
                fixture.env,
                fixture.projectRoot
              )
            ).stdout
          );
          expect(receipt).toMatchObject({
            identity: snapshot.request.identity,
            decisionSource: "cli.audit-proof",
            decision: optionId === null ? { kind: "cancel" } : { kind: "select", optionId }
          });
          expect(human).toContain(`Record: ${recordId}`);
          expect((await owner.execution).error).toBeUndefined();
          const protocol = await readFile(join(owner.runDir, "protocol.ndjson"), "utf8");
          expect(protocol).toContain(
            optionId === null ? '"outcome":"cancelled"' : `"optionId":"${optionId}"`
          );
          const history = await readFile(join(owner.runDir, "events.ndjson"), "utf8");
          expect(history).toContain(`"outcome":"${outcome}"`);
          expect(owner.events).toMatchObject([
            { type: "interaction_required", interaction: { recordId } },
            {
              type: "interaction_resolved",
              interaction: { recordId, outcome }
            }
          ]);
          await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({
            status: "answered",
            response: {
              decision: receipt.decision,
              decisionSource: "cli.audit-proof",
              reason: expectedReason
            }
          });
          const accepted = (await store.readSnapshot("permission:1")).response;
          expect(receipt.acceptedAt).toBe(accepted?.respondedAt);
          expect(receipt.decisionSource).toBe(accepted?.decisionSource);
          await expect(
            runCli(
              [...actionArgs, "--cancel", "--reason", "Duplicate audit must not persist"],
              fixture.env
            )
          ).rejects.toMatchObject({ code: 1 });
          expect((await store.readSnapshot("permission:1")).response).toEqual(accepted);
          expect(JSON.stringify(accepted)).not.toContain("super-secret");
          expect((await runCli(["interaction", "list"], fixture.env)).stdout).toBe(
            "No actionable runner interactions.\n"
          );
        } finally {
          owner.abort.abort();
          await owner.execution;
        }
      },
      workflowTimeoutMs
    );
  });

  it(
    "rejects a printed feedback command after its real owner lease is replaced",
    async () => {
      const fixture = await createFeedbackWorkspace("RUN-001");
      vi.stubEnv("PLANWEAVE_HOME", fixture.env.PLANWEAVE_HOME);
      const review = await startOwner(fixture, "artifact-review").execution;
      expect(review.error).toBeUndefined();
      const first = startOwner(fixture);
      let second: ReturnType<typeof startOwner> | undefined;
      try {
        const human = await waitForHumanList(fixture.env);
        const command = printedCommand(human, "response");
        const original = await new PersistentRunnerInteractionStore(fixture.runDir).readSnapshot(
          "permission:1"
        );
        const oldLease = human.match(/^Owner lease: (.+)$/m)?.[1];
        expect(oldLease).toBeTruthy();
        let persisted!: () => void;
        const published = new Promise<void>((resolve) => {
          persisted = resolve;
        });
        second = startOwner(fixture, "permission-secret", persisted);
        await Promise.race([
          published,
          second.execution.then(({ error }) => {
            throw error ?? new Error("Replacement owner ended before metadata publication.");
          })
        ]);
        const metadata = JSON.parse(await readFile(join(fixture.runDir, "metadata.json"), "utf8"));
        expect(metadata.ownerLeaseId).not.toBe(oldLease);
        await vi.waitFor(
          async () => {
            const current = JSON.parse(
              await readFile(join(fixture.runDir, "metadata.json"), "utf8")
            );
            expect(current.sessionId).toBe(original.request.identity.sessionId);
            expect(current.ownerLeaseId).not.toBe(oldLease);
          },
          { timeout: readyTimeoutMs }
        );
        await expect(
          respondToRunnerInteraction(
            { projectRoot: fixture.projectRoot, canvasId: "default" },
            original.request.identity,
            { kind: "select", optionId: "token=opaque-action-id" },
            { decisionSource: "runtime-feedback-test", reason: null }
          )
        ).rejects.toMatchObject({ code: "interaction_owner_replaced" });
        await expect(
          runShellCommand(`${command} --json`, fixture.env, fixture.projectRoot)
        ).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining('"code":"interaction_owner_replaced"')
        });
        const snapshot = await new PersistentRunnerInteractionStore(fixture.runDir).readSnapshot(
          "permission:1"
        );
        expect(snapshot.response).toBeNull();
      } finally {
        first.abort.abort();
        second?.abort.abort();
        await Promise.all([first.execution, second?.execution]);
      }
    },
    workflowTimeoutMs
  );
});
