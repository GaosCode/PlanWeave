/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { activeAgentRunRegistry } from "../../../runtime/src/autoRun/activeAgentRunRegistry";
import { codebuddyAgentDefinition } from "../../../runtime/src/autoRun/codebuddyIntegration";
import {
  getAutoRunState,
  getGraphViewModel,
  respondToDesktopAgentRequest,
  startAutoRun,
  stopAutoRun,
  updateBlockExecutor,
  updateTaskExecutor
} from "../../../runtime/src/desktop/index";
import {
  consumeRunnerRecordReadModel,
  readRunnerRecordReadModel
} from "../../../runtime/src/autoRun/runnerRecordReadModel";
import { acpEventReadModels } from "../../../runtime/src/autoRun/acpEventReadModel";
import { trustCommand } from "../../../runtime/src/taskManager/hookTrustStore";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers";
import { manifestTestBuilder } from "../../../runtime/src/__tests__/manifestTestBuilder";
import { RunnerRecordMonitor } from "../renderer/inspector/RunnerRecordMonitor";
import { createTranslator } from "../renderer/i18n";
import {
  buildExecutorOptionViews,
  executorDisplayName
} from "../renderer/executors/executorOptionViewModel";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const fixture = join(process.cwd(), "packages/runtime/src/__tests__/support/acpMockAgent.mjs");
const activeRuns = new Set<string>();

afterEach(async () => {
  await Promise.all([...activeRuns].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  activeRuns.clear();
  cleanupRendererTestEnvironment();
});

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 500 && !accept(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  if (!accept(value)) throw new Error("Timed out waiting for CodeBuddy ACP Desktop E2E state.");
  return value;
}

describe("provider-free CodeBuddy ACP Desktop E2E", () => {
  it("assigns CodeBuddy from Desktop options through intervention, submit, cleanup, and stale replay", async () => {
    const workspace = await createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("manual").build()
    );
    const graph = await getGraphViewModel(workspace.root);
    const options = buildExecutorOptionViews({
      executorOptions: graph.executorOptions,
      literalExecutorNames: graph.packageExecutorNames
    }).filter((candidate) => executorDisplayName(candidate.name) === "CodeBuddy");
    expect(options).toHaveLength(1);
    const [option] = options;
    if (!option) throw new Error("Expected a CodeBuddy Desktop option.");
    await expect(updateTaskExecutor(workspace.root, "T-001", option.name)).resolves.toMatchObject({
      ok: true
    });
    await expect(
      updateBlockExecutor(workspace.root, "T-001#B-001", option.name)
    ).resolves.toMatchObject({ ok: true });
    await expect(updateBlockExecutor(workspace.root, "T-001#B-001", null)).resolves.toMatchObject({
      ok: true
    });
    const previousLaunch = codebuddyAgentDefinition.acp.launch;
    codebuddyAgentDefinition.acp.launch = {
      command: process.execPath,
      args: [fixture, "permission-secret"]
    };
    await trustCommand(workspace.init.workspace, process.execPath, [fixture, "permission-secret"]);
    try {
      const started = await startAutoRun(workspace.root, null, { kind: "project" }, 1, {
        tmuxEnabled: false
      });
      activeRuns.add(started.runId);
      const handle = await waitFor(
        () => activeAgentRunRegistry.lookupDesktopRun(started.runId),
        (value) => value?.control.pendingRequests.size === 1
      );
      expect(handle?.identity).toMatchObject({
        desktopRunId: started.runId,
        claimRef: "T-001#B-001"
      });
      const runDir = handle?.identity.scope ?? "";
      const recordId = `T-001#B-001::${handle?.identity.executorRunId}`;
      const prepared = await waitFor(
        async () =>
          JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as {
            sessionId?: string | null;
            executor?: string;
            adapter?: string;
            agentId?: string;
          },
        (value) => value.sessionId === handle?.identity.sessionId
      );
      expect(prepared).toMatchObject({
        executor: "codebuddy-acp",
        adapter: "agent",
        agentId: "codebuddy"
      });
      const eventModel = acpEventReadModels.get(runDir);
      const canonical = eventModel?.replay().cursor.canonicalIdentity?.identity;
      if (!eventModel || !canonical) throw new Error("Expected an active ACP event model.");
      const metadata = {
        runnerKind: "acp",
        scope: runDir,
        runId: canonical.runId,
        ref: canonical.claimRef,
        claimRef: canonical.claimRef,
        taskId: canonical.taskId,
        blockId: canonical.blockId,
        projectId: canonical.projectId,
        canvasId: canonical.canvasId,
        executorRunId: canonical.executorRunId,
        desktopRunId: canonical.desktopRunId,
        runSessionId: canonical.runSessionId
      };
      let bridgeListener: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1] | null = null;
      const initialConsumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata,
        subscriber: (snapshot) =>
          bridgeListener?.({
            kind: "snapshot",
            updateSequence: Math.max(1, snapshot.cursor.afterSequence),
            snapshot
          })
      });
      if (!initialConsumer.snapshot) throw new Error("Expected an active ACP read model.");
      const initialModel = initialConsumer.snapshot;
      const api: Pick<
        DesktopBridgeApi,
        "subscribeRunnerRecord" | "revealRunnerRecordArtifact" | "respondToAgentRequest"
      > = {
        subscribeRunnerRecord: async (_input, listener) => {
          bridgeListener = listener;
          return {
            subscriptionId: "codebuddy-mock-e2e",
            updateSequence: initialModel.cursor.afterSequence,
            snapshot: initialModel,
            unsubscribe: async () => initialConsumer.subscription?.unsubscribe()
          };
        },
        revealRunnerRecordArtifact: async () => undefined,
        respondToAgentRequest: respondToDesktopAgentRequest
      };
      const view = render(
        <RunnerRecordMonitor
          api={api}
          canvasRef={{ projectRoot: workspace.root }}
          initialModel={initialModel}
          recordId={recordId}
          t={createTranslator("en")}
        />
      );
      const permissionOption = await screen.findByRole("button", {
        name: /redacted|password|allow/i
      });
      fireEvent.click(permissionOption);
      await waitFor(
        () => getAutoRunState(started.runId),
        (value) => value.phase === "paused" && value.stepCount === 1
      );
      expect(acpEventReadModels.get(runDir)).toBeNull();
      const reopened = await readRunnerRecordReadModel({
        runDir,
        metadata
      });
      expect(reopened).toMatchObject({
        terminal: true,
        interaction: { persisted: true, active: false, stale: true }
      });
      if (!reopened) throw new Error("Expected reopened ACP read model.");
      bridgeListener?.({
        kind: "snapshot",
        updateSequence: Math.max(1, reopened.cursor.afterSequence),
        snapshot: reopened
      });
      expect(await screen.findByText(/implementation: report.md/)).toBeInTheDocument();
      expect(activeAgentRunRegistry.lookupDesktopRun(started.runId)).toBeNull();
      view.unmount();
    } finally {
      codebuddyAgentDefinition.acp.launch = previousLaunch;
    }
  });
});
