import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { acpSessionIdSchema, taskWorkspaceInputSchema } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeBridgeRunnerInteractionHandlers as handlers } from "../main/runtimeBridgeRunnerInteractionHandlers";
import {
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listTaskWorkspaceRuns
} from "../../../runtime/src/desktop/taskWorkspaceApi";
import {
  createTaskWorkspaceAcpSmokeFixture,
  pauseTaskWorkspaceAcpFixture,
  releaseTaskWorkspaceAcpFixture,
  waitForTaskWorkspaceAcpBarrier
} from "./helpers/taskWorkspaceAcpSmokeFixture";

const oldHome = process.env.PLANWEAVE_HOME;
const oldSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
const ownedDirectories = new Set<string>();
// Prompt handlers do not access Electron event fields; the real handler validates every DTO.
const event = {} as IpcMainInvokeEvent;
afterEach(async () => {
  if (oldHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = oldHome;
  if (oldSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = oldSettings;
  for (const directory of ownedDirectories) await rm(directory, { recursive: true, force: true });
  ownedDirectories.clear();
});

async function fixture() {
  const value = await createTaskWorkspaceAcpSmokeFixture();
  ownedDirectories.add(value.directory);
  return value;
}
function request(
  identity: Awaited<ReturnType<typeof fixture>>["runs"][number]["identity"],
  text: string
) {
  return {
    version: "planweave.send-agent-prompt/v1" as const,
    identity: {
      ...identity,
      version: "planweave.agent-prompt-turn/v1" as const,
      turnId: randomUUID()
    },
    text
  };
}

describe("local ACP integration through actual Desktop bridge handlers", () => {
  it("discovers two completed runs and keeps independent exact turn owners through delay, success, and cancellation", async () => {
    const prepared = await fixture();
    const [a, b] = prepared.runs;
    const input = taskWorkspaceInputSchema.parse({
      projectRoot: prepared.root,
      canvasId: "default",
      taskId: "T-001"
    });
    const workspace = await getTaskWorkspace(input);
    expect(workspace.task.taskId).toBe("T-001");
    const page = await listTaskWorkspaceRuns(input);
    expect(page.items.map((item) => item.run.record.recordId).sort()).toEqual([
      a.identity.recordId,
      b.identity.recordId
    ]);
    for (const run of prepared.runs) {
      const detail = await getTaskWorkspaceRunDetail({ ...input, recordId: run.identity.recordId });
      expect(detail.record?.runnerReadModel?.intervention.prompt).toMatchObject({
        available: true,
        identity: run.identity
      });
    }
    const metadataBefore = await readFile(join(a.runDir, "metadata.json"));
    const reportBefore = await readFile(join(a.runDir, "report.md"));
    await pauseTaskWorkspaceAcpFixture(a.controlDir);
    const first = request(a.identity, "synthetic local A continuation");
    const sendingA = handlers.sendAgentPrompt(event, first);
    try {
      await waitForTaskWorkspaceAcpBarrier(a.controlDir);
      expect(await handlers.getCurrentAgentPromptTurn(event, a.identity)).toMatchObject({
        found: true,
        state: { identity: first.identity, terminal: null, cancellable: true }
      });
      expect(await handlers.getCurrentAgentPromptTurn(event, b.identity)).toMatchObject({
        found: false
      });
      await expect(
        handlers.sendAgentPrompt(event, request(a.identity, "synthetic duplicate A"))
      ).rejects.toThrow("already in progress");
      const second = request(b.identity, "synthetic local B continuation");
      await expect(handlers.sendAgentPrompt(event, second)).resolves.toMatchObject({
        identity: second.identity,
        terminal: "succeeded"
      });
      await expect(
        handlers.sendAgentPrompt(
          event,
          request(
            { ...a.identity, sessionId: acpSessionIdSchema.parse("stale-session") },
            "synthetic stale request"
          )
        )
      ).rejects.toThrow(/match/);
      await releaseTaskWorkspaceAcpFixture(a.controlDir);
      await expect(sendingA).resolves.toMatchObject({
        identity: first.identity,
        terminal: "succeeded"
      });
      expect(await readFile(join(a.runDir, "metadata.json"))).toEqual(metadataBefore);
      expect(await readFile(join(a.runDir, "report.md"))).toEqual(reportBefore);
      expect(await readFile(join(a.runDir, "events.ndjson"), "utf8")).toContain(
        "synthetic local A continuation"
      );
      await pauseTaskWorkspaceAcpFixture(a.controlDir);
      const cancelled = request(a.identity, "synthetic local cancellation");
      const cancellingSend = handlers.sendAgentPrompt(event, cancelled);
      try {
        // getCurrent crosses the same persistence/identity boundary as Desktop recovery.
        await waitForTaskWorkspaceAcpBarrier(a.controlDir);
        await expect(
          handlers.cancelAgentPromptTurn(event, cancelled.identity)
        ).resolves.toMatchObject({ outcome: "cancel_requested" });
        await releaseTaskWorkspaceAcpFixture(a.controlDir);
        await expect(cancellingSend).resolves.toMatchObject({
          identity: cancelled.identity,
          terminal: "cancelled"
        });
      } finally {
        const current = await handlers.getCurrentAgentPromptTurn(event, a.identity);
        if (current.found && current.state.terminal === null) {
          await handlers.cancelAgentPromptTurn(event, current.state.identity);
        }
        await cancellingSend.catch(() => undefined);
      }
    } finally {
      // All outstanding child processes settle before the owned fixture is removed.
      const current = await handlers.getCurrentAgentPromptTurn(event, a.identity);
      if (current.found && current.state.terminal === null)
        await handlers.cancelAgentPromptTurn(event, current.state.identity);
      await sendingA.catch(() => undefined);
    }
  });

  it("reports an external ACP process failure without mutating the completed record or the other run", async () => {
    const prepared = await fixture();
    const [a, b] = prepared.runs;
    await pauseTaskWorkspaceAcpFixture(a.controlDir);
    const sending = handlers.sendAgentPrompt(event, request(a.identity, "synthetic failure probe"));
    const rejection = expect(sending).rejects.toThrow();
    await waitForTaskWorkspaceAcpBarrier(a.controlDir);
    await writeFile(join(a.controlDir, "force-exit"), "42\n");
    await rejection;
    expect(await handlers.getCurrentAgentPromptTurn(event, b.identity)).toMatchObject({
      found: false
    });
    expect(JSON.parse(await readFile(join(a.runDir, "metadata.json"), "utf8"))).toMatchObject({
      status: "completed",
      outcome: "succeeded"
    });
  });
});
