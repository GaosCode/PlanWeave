/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { activeAgentRunRegistry } from "../../../runtime/src/autoRun/activeAgentRunRegistry";
import { codexAgentDefinition } from "../../../runtime/src/autoRun/codexIntegration";
import {
  getAutoRunState,
  respondToDesktopAgentRequest,
  startAutoRun,
  stopAutoRun
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
  if (!accept(value)) throw new Error("Timed out waiting for provider-free ACP Desktop E2E state.");
  return value;
}

describe("provider-free ACP Desktop E2E", () => {
  it("routes one profile-owned run through live bridge updates, intervention, submit, cleanup, and stale replay", async () => {
    const workspace = await createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("codex-acp").build()
    );
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = {
      command: process.execPath,
      args: [fixture, "permission-secret"]
    };
    await trustCommand(workspace.init.workspace, process.execPath, [fixture, "permission-secret"]);
    try {
      const started = await startAutoRun(
        workspace.root,
        null,
        { kind: "project" },
        1,
        { tmuxEnabled: false }
      );
      activeRuns.add(started.runId);
      const handle = await waitFor(
        () => activeAgentRunRegistry.lookupDesktopRun(started.runId),
        (value) => value?.control.pendingRequests.size === 1
      );
      expect(handle?.identity).toMatchObject({
        desktopRunId: started.runId,
        claimRef: "T-001#B-001"
      });
      const recordId = `T-001#B-001::${handle?.identity.executorRunId}`;
      await waitFor(
        async () => JSON.parse(await readFile(join(handle?.identity.scope ?? "", "metadata.json"), "utf8")) as { sessionId?: string | null },
        (value) => value.sessionId === handle?.identity.sessionId
      );
      const eventModel = acpEventReadModels.get(handle?.identity.scope ?? "");
      const canonical = eventModel?.replay().cursor.canonicalIdentity?.identity;
      if (!eventModel || !canonical) throw new Error("Expected an active ACP event model.");
      const metadata = {
        runnerKind: "acp",
        scope: handle?.identity.scope,
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
        runDir: handle?.identity.scope ?? "",
        metadata,
        subscriber: (snapshot) => bridgeListener?.({
          updateSequence: snapshot.cursor.afterSequence,
          snapshot
        })
      });
      if (!initialConsumer.snapshot) throw new Error("Expected an active ACP read model.");
      const initialModel = initialConsumer.snapshot;
      const api: Pick<DesktopBridgeApi, "subscribeRunnerRecord" | "revealRunnerRecordArtifact" | "respondToAgentRequest"> = {
        subscribeRunnerRecord: async (_input, listener) => {
          bridgeListener = listener;
          return {
            subscriptionId: "mock-e2e",
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
      const option = await screen.findByRole("button", { name: /redacted|password|allow/i });
      fireEvent.click(option);
      await waitFor(
        () => getAutoRunState(started.runId),
        (value) => value.phase === "paused" && value.stepCount === 1
      );
      expect(acpEventReadModels.release(handle?.identity.scope ?? "")).toBe(true);
      const reopened = await readRunnerRecordReadModel({
        runDir: handle?.identity.scope ?? "",
        metadata
      });
      expect(reopened).toMatchObject({
        terminal: true,
        interaction: { persisted: true, active: false, stale: true }
      });
      if (!reopened) throw new Error("Expected reopened ACP read model.");
      bridgeListener?.({
        updateSequence: reopened.cursor.afterSequence,
        snapshot: reopened
      });
      expect(await screen.findByText(/implementation: report.md/)).toBeInTheDocument();
      expect(activeAgentRunRegistry.lookupDesktopRun(started.runId)).toBeNull();
      view.unmount();
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });
});
