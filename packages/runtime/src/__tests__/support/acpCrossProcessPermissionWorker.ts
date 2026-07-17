import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActiveAgentRunRegistry } from "../../autoRun/activeAgentRunRegistry.js";
import { AcpSessionController, type AcpSessionRun } from "../../autoRun/acpSessionController.js";
import { runnerPermissionInteractionResponseSchema } from "../../autoRun/runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "../../autoRun/runnerInteractionStore.js";

const [mode, runDir] = process.argv.slice(2);
if (!runDir) throw new Error("Cross-process ACP worker requires a run directory.");

function ownerRun(): AcpSessionRun {
  const acpFixture = fileURLToPath(new URL("./acpMockAgent.mjs", import.meta.url));
  return {
    kind: "implementation",
    identity: {
      scope: runDir,
      runSessionId: "SESSION-CHILD-001",
      executorRunId: "RUN-CHILD-001",
      claimRef: "T-001#B-001"
    },
    runDir,
    metadataPath: join(runDir, "metadata.json"),
    prompt: "permission-secret",
    cwd: runDir,
    launch: { command: process.execPath, args: [acpFixture, "permission-secret"] },
    executorName: "mock-acp",
    agentId: "codex",
    taskId: "T-001",
    metadataIdentity: { blockId: "B-001" },
    projectId: "project-1",
    canvasId: "default"
  };
}

async function runOwner(): Promise<void> {
  const controller = new AcpSessionController(new ActiveAgentRunRegistry());
  const result = await controller.execute(ownerRun(), { timeoutMs: 8_000 });
  process.stdout.write(`${JSON.stringify({ kind: "owner_completed", result: result.kind })}\n`);
}

async function runResponder(): Promise<void> {
  const store = new PersistentRunnerInteractionStore(runDir);
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const snapshots = await store.listSnapshots();
    const pending = snapshots.find((snapshot) => snapshot.status === "pending");
    if (pending) {
      const heartbeat = JSON.parse(await readFile(join(runDir, "heartbeat.json"), "utf8")) as {
        runnerLifecycle?: unknown;
        pendingInteractionIds?: unknown;
      };
      if (
        heartbeat.runnerLifecycle !== "waiting_interaction" ||
        !Array.isArray(heartbeat.pendingInteractionIds) ||
        !heartbeat.pendingInteractionIds.includes(pending.interactionId)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      await store.createResponse(
        runnerPermissionInteractionResponseSchema.parse({
          version: "planweave.runner-interaction-response/v1",
          identity: pending.request.identity,
          decision: { kind: "select", optionId: "token=opaque-action-id" },
          respondedAt: new Date().toISOString(),
          decisionSource: "child-process-responder",
          reason: null
        })
      );
      process.stdout.write(
        `${JSON.stringify({ kind: "response_created", sessionId: pending.request.identity.sessionId })}\n`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the child owner permission request.");
}

if (mode === "owner") await runOwner();
else if (mode === "responder") await runResponder();
else throw new Error(`Unknown cross-process ACP worker mode '${String(mode)}'.`);
