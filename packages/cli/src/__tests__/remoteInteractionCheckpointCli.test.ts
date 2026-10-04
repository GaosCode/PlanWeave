import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackageSnapshot,
  loadPlanGraphPackage,
  getRunSession,
  listRunSessions
} from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  repoRoot,
  runCli,
  runCliExpectFailure,
  execFileAsync,
  cliWorkflowTimeoutMs
} from "./support/cliTestHarness.js";
import {
  WorkspaceExecutionHttpHarness,
  workspaceExecutionToken,
  ownerExecutionOperatorToken,
  ownerExecutionHumanPrincipalId,
  writeWorkspaceExecutionProfiles,
  writeOperatorExecutionProfiles
} from "./support/workspaceExecutionHttpHarness.js";
import {
  skillRemoteRunArgv,
  skillOwnerRemoteRunArgv,
  skillInteractionListArgv,
  skillInteractionRespondArgv
} from "./support/workspaceExecutionSkillCommands.js";

async function lateInteractionWorkspace(
  mode: "workspace" | "owner",
  interactionKinds: readonly ("permission" | "elicitation" | "authentication")[] = ["permission"]
) {
  const home = await mkdtemp(join(tmpdir(), "planweave-late-interaction-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLANWEAVE_HOME: home,
    ...(mode === "workspace"
      ? { PLANWEAVE_COLLABORATION_DEVICE_TOKEN: workspaceExecutionToken }
      : {
          PLANWEAVE_OPERATOR_TOKEN: ownerExecutionOperatorToken,
          PLANWEAVE_HUMAN_IDENTITY_TOKEN: exampleHumanIdentityToken,
          PLANWEAVE_HUMAN_PRINCIPAL_ID: ownerExecutionHumanPrincipalId
        })
  };
  if (mode === "owner") delete env.PLANWEAVE_COLLABORATION_DEVICE_TOKEN;
  const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true
  });
  const manifestPath = join(init.workspace.packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.execution.defaultExecutor = "missing-codex";
  manifest.executors = {
    "missing-codex": {
      adapter: "codex-exec",
      command: "planweave-absent-interaction-fixture",
      args: ["exec", "-"]
    }
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const captured = await capturePackageSnapshot({ projectRoot: init.workspace });
  const graph = await loadPlanGraphPackage(init.workspace);
  const server = new WorkspaceExecutionHttpHarness({
    sourceRevision: captured.snapshot.sourceRevision,
    graphFingerprint: graph.graph.packageFingerprint,
    dispatchMode: "action_required",
    ownerHumanPrincipalId: ownerExecutionHumanPrincipalId,
    interactionKinds,
    registryCanvases: [
      {
        canvasId: "default",
        publishSource: { localProjectId: init.workspace.id, localCanvasId: "default" }
      }
    ]
  });
  server.hideInteractions();
  const serverOrigin = await server.start();
  await (mode === "workspace" ? writeWorkspaceExecutionProfiles : writeOperatorExecutionProfiles)({
    home,
    serverOrigin
  });
  const started = await runCliExpectFailure(
    (mode === "workspace" ? skillRemoteRunArgv : skillOwnerRemoteRunArgv)(
      "T-001#B-001",
      "endpoint-codex",
      "profile-1"
    ),
    env
  );
  expect(started.code).toBe(7);
  expect(started.stderr).toBe("");
  const session = (await listRunSessions(init.workspace)).sessions[0]!;
  expect(session.workspaceExecution?.interactions).toEqual([]);
  const respond = skillInteractionRespondArgv({
    sessionId: session.sessionId,
    dispatchId: "dispatch-1",
    leaseId: "lease-1",
    executionAttemptId: "attempt-1",
    acpSessionId: "acp-session-1",
    actionId: "action-1",
    option: "tool-approve-once",
    profileId: "profile-1"
  });
  return {
    env,
    workspace: init.workspace,
    sessionId: session.sessionId,
    server,
    respond,
    sessionDir: join(init.workspace.resultsDir, "run-sessions", session.sessionId)
  };
}

async function templateArgv(output: string, selection: string) {
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("POSIX: ") && candidate.includes(selection));
  if (!line) throw new Error(`Missing response example for ${selection}`);
  const received = await execFileAsync("sh", [
    "-c",
    `planweave() { node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"; };\n${line.slice(7)}`
  ]);
  const args: unknown = JSON.parse(received.stdout);
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string"))
    throw new Error("Response example did not yield string argv");
  return args;
}

describe("remote interaction CLI durable checkpoints", () => {
  it.each(["workspace", "owner"] as const)(
    "synchronizes a late pending request after no-follow run for %s authority",
    async (mode) => {
      const f = await lateInteractionWorkspace(mode);
      try {
        f.server.publishInteractions();
        const human = (
          await runCli(
            skillInteractionListArgv(f.sessionId, "profile-1").filter((arg) => arg !== "--json"),
            f.env
          )
        ).stdout;
        expect(human).toContain("Approve tool use");
        expect(human).toContain("tool-approve-once");
        expect(human).toContain("POSIX:");
        expect(human).toContain("PowerShell:");
        const listed = JSON.parse(
          (await runCli(skillInteractionListArgv(f.sessionId, "profile-1"), f.env)).stdout
        );
        expect(listed).toEqual([
          expect.objectContaining({
            status: "pending",
            request: expect.objectContaining({ actionId: "action-1" })
          })
        ]);
        const durable = (await getRunSession(f.workspace, f.sessionId)).session;
        expect(durable.workspaceExecution?.interactions).toEqual([
          expect.objectContaining({ status: "pending" })
        ]);
        expect(durable.workspaceExecution?.binding.kind).toBe("remote");
        if (mode === "owner")
          expect(durable.workspaceExecution?.binding).toMatchObject({
            authorityKind: "owner_canvas"
          });
        else
          expect(durable.workspaceExecution?.binding.contentAuthority.kind).toBe(
            "package_snapshot"
          );
        const template = await templateArgv(human, "--option=tool-approve-once");
        for (const flag of ["--action", "--dispatch", "--lease", "--attempt", "--acp-session"]) {
          const wrong = [...template];
          wrong[wrong.indexOf(flag) + 1] = "wrong-identity";
          const rejected = await runCliExpectFailure(wrong, f.env);
          expect(rejected.stderr).toContain("remote_interaction_not_found");
        }
        const invalidOption = await runCliExpectFailure(
          template.map((arg) =>
            arg === "--option=tool-approve-once" ? "--option=unadvertised-option" : arg
          ),
          f.env
        );
        expect(invalidOption.stderr).toContain("interaction_permission_option_unknown");
        expect(f.server.settlementCount).toBe(0);
        const answered = JSON.parse((await runCli([...template, "--json"], f.env)).stdout);
        expect(answered).toMatchObject({
          type: "interaction_resolved",
          data: { actionId: "action-1", optionId: "tool-approve-once" }
        });
        expect(
          (await getRunSession(f.workspace, f.sessionId)).session.workspaceExecution?.interactions
        ).toEqual([expect.objectContaining({ status: "settled" })]);
        expect(
          JSON.parse(
            (await runCli(skillInteractionListArgv(f.sessionId, "profile-1"), f.env)).stdout
          )
        ).toEqual([]);
        const again = await runCliExpectFailure(f.respond, f.env);
        expect(again.stderr).toContain("remote_interaction_not_found");
        expect(f.server.settlementCount).toBe(1);
        expect(mode === "workspace" ? f.server.dispatchCount : f.server.ownerDispatchCount).toBe(1);
      } finally {
        await f.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "responds to elicitation and authentication examples and cancels the permission over HTTP",
    async () => {
      const f = await lateInteractionWorkspace("workspace", [
        "permission",
        "elicitation",
        "authentication"
      ]);
      try {
        f.server.publishInteractions();
        const human = (
          await runCli(
            skillInteractionListArgv(f.sessionId, "profile-1").filter((arg) => arg !== "--json"),
            f.env
          )
        ).stdout;
        expect(human).toContain("Prompt: Provide input");
        expect(human).toContain("Option: answer");
        expect(human).toContain("Host instruction: Authenticate on the Host");
        expect(human).toContain("not a permission option");
        let settledCount = 0;
        for (const [selection, settlement] of [
          [
            "--option=answer",
            { type: "interaction.elicitation_response", outcome: "accepted", response: "answer" }
          ],
          [
            "--option=retry_after_host_login",
            { type: "interaction.authentication_action", action: "retry_after_host_login" }
          ],
          ["--cancel", { type: "interaction.permission_response", decision: "deny" }]
        ] as const) {
          const args = await templateArgv(human, selection);
          const accepted = JSON.parse((await runCli([...args, "--json"], f.env)).stdout);
          expect(accepted).toMatchObject({ type: "interaction_resolved", data: settlement });
          const persisted = (await getRunSession(f.workspace, f.sessionId)).session;
          expect(
            persisted.workspaceExecution?.interactions.filter((item) => item.status === "settled")
          ).toHaveLength(++settledCount);
        }
        expect(f.server.settlementCount).toBe(3);
      } finally {
        await f.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "preserves the remote expiration rejection for a response copied from human output",
    async () => {
      const f = await lateInteractionWorkspace("workspace");
      try {
        f.server.publishInteractions();
        const human = (
          await runCli(
            skillInteractionListArgv(f.sessionId, "profile-1").filter((arg) => arg !== "--json"),
            f.env
          )
        ).stdout;
        const args = await templateArgv(human, "--option=tool-approve-once");
        f.server.expireInteraction();
        const rejected = await runCliExpectFailure(args, f.env);
        expect(rejected.stderr).toContain("remote_interaction_expired");
        expect(f.server.settlementCount).toBe(0);
      } finally {
        await f.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it.skipIf(process.platform === "win32")(
    "recovers the same CLI response intent after remote success and real filesystem checkpoint failure",
    async () => {
      const f = await lateInteractionWorkspace("workspace");
      try {
        f.server.publishInteractions();
        f.server.onSettlement = async () => {
          await chmod(f.sessionDir, 0o500);
        };
        const failed = await runCliExpectFailure(f.respond, f.env);
        expect(failed.code).toBe(9);
        expect(failed.stderr).toContain(
          "Remote response accepted; synchronize this same interaction before retrying."
        );
        await chmod(f.sessionDir, 0o700);
        const interrupted = (await getRunSession(f.workspace, f.sessionId)).session;
        expect(interrupted.workspaceExecution?.interactions[0]).toMatchObject({
          status: "pending",
          responseIntent: {
            response: { actionId: "action-1", optionId: "tool-approve-once" }
          }
        });
        const deliveryRequests = f.server.calls.filter((call) =>
          call.endsWith("/interactions/respond")
        ).length;
        expect(
          JSON.parse(
            (await runCli(skillInteractionListArgv(f.sessionId, "profile-1"), f.env)).stdout
          )
        ).toEqual([]);
        expect(
          f.server.calls.filter((call) => call.endsWith("/interactions/respond"))
        ).toHaveLength(deliveryRequests);
        const changed = await runCliExpectFailure(
          f.respond.map((value) => (value === "tool-approve-once" ? "tool-reject-once" : value)),
          f.env
        );
        expect(changed.stderr).toContain("remote_interaction_response_conflict");
        expect(f.server.settlementCount).toBe(1);
        const recovered = JSON.parse((await runCli(f.respond, f.env)).stdout);
        expect(recovered).toMatchObject({
          type: "interaction_resolved",
          data: { optionId: "tool-approve-once" }
        });
        expect(
          (await getRunSession(f.workspace, f.sessionId)).session.workspaceExecution?.interactions
        ).toEqual([expect.objectContaining({ status: "settled" })]);
        expect(f.server.settlementCount).toBe(1);
      } finally {
        await chmod(f.sessionDir, 0o700);
        await f.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );
});
