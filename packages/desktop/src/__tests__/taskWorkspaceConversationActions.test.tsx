/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { TaskWorkspaceComposer } from "../renderer/task-workspace/conversation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { readModel, recordId, selection } from "./helpers/taskWorkspaceConversationFixture";
import type { DesktopBridgeApi, DesktopAgentPromptTurnIdentity } from "@planweave-ai/runtime";

afterEach(cleanupRendererTestEnvironment);

const t = createTranslator("en");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function promptState(
  identity: DesktopAgentPromptTurnIdentity,
  terminal: "succeeded" | "cancelled" = "succeeded"
) {
  return {
    identity,
    phase: "terminal" as const,
    terminal,
    cancellationRequested: terminal === "cancelled",
    cancellable: false
  };
}

function retrySelection(runId: string) {
  const selectedRun = selection({ active: false, model: null, retry: true });
  const identity = selectedRun.item.run.capabilities.retry.identity;
  if (!identity) throw new Error("Expected retry identity fixture.");
  identity.runId = runId;
  identity.executorRunId = runId;
  identity.recordId = `T-001#B-001::${runId}`;
  return selectedRun;
}

describe("Task Workspace conversation actions", () => {
  it("sends and stops only with exact selected session identities and renders no retry or resume action", async () => {
    const model = readModel();
    const selectedRun = selection({ model });
    const sendAgentPrompt = vi.fn(
      async (request: Parameters<DesktopBridgeApi["sendAgentPrompt"]>[0]) =>
        promptState(request.identity)
    );
    const cancelAgentRun = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceComposer
        accessory={<span>Authoritative usage</span>}
        api={{ cancelAgentRun, sendAgentPrompt }}
        canvasRef={{ projectRoot: "/projects/demo", canvasId: "canvas-main" }}
        liveStatus="live"
        runnerModel={model}
        selectedRun={selectedRun}
        t={t}
      />
    );

    const input = screen.getByLabelText("Message the agent");
    expect(screen.getByTestId("task-workspace-composer")).toHaveClass("pointer-events-auto");
    expect(input.className).toContain("resize-none");
    expect(input.className).not.toContain("resize-y");
    fireEvent.change(input, { target: { value: "Continue with the focused fix" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() =>
      expect(sendAgentPrompt).toHaveBeenCalledWith({
        version: "planweave.send-agent-prompt/v1",
        identity: expect.objectContaining({
          ...model.intervention.prompt.identity,
          version: "planweave.agent-prompt-turn/v1",
          turnId: expect.any(String)
        }),
        text: "Continue with the focused fix"
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(cancelAgentRun).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      recordId,
      model.intervention.cancel.identity
    );
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue session/i })).not.toBeInTheDocument();
    expect(screen.getByText("Authoritative usage")).toBeInTheDocument();
  });

  it("shows a dedicated stop control only while a completed continuation is in flight", async () => {
    const liveModel = readModel();
    const model = {
      ...liveModel,
      terminal: true,
      cursor: { ...liveModel.cursor, terminal: true },
      intervention: {
        ...liveModel.intervention,
        cancel: { available: false, reason: "Run finished.", identity: null }
      }
    };
    const selectedRun = selection({ active: false, model });
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    const sendAgentPrompt = vi.fn(() => pending.promise);
    const cancelAgentPromptTurn = vi.fn(async () => ({
      outcome: "cancel_requested" as const,
      state: null
    }));
    render(
      <TaskWorkspaceComposer
        api={{ cancelAgentPromptTurn, sendAgentPrompt }}
        liveStatus="unavailable"
        runnerModel={model}
        selectedRun={selectedRun}
        t={t}
      />
    );

    const input = screen.getByLabelText("Message the agent");
    fireEvent.change(input, { target: { value: "continue" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const stop = await screen.findByRole("button", { name: "Stop follow-up" });
    const request = sendAgentPrompt.mock.calls[0]?.[0];
    if (!request) throw new Error("Expected versioned prompt request.");
    fireEvent.click(stop);

    await vi.waitFor(() => expect(cancelAgentPromptTurn).toHaveBeenCalledWith(request.identity));
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    pending.resolve(promptState(request.identity, "cancelled"));
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop follow-up" })).not.toBeInTheDocument()
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("recovers the exact active continuation after unmount and remount", async () => {
    const liveModel = readModel();
    const model = {
      ...liveModel,
      terminal: true,
      cursor: { ...liveModel.cursor, terminal: true },
      intervention: {
        ...liveModel.intervention,
        prompt: { ...liveModel.intervention.prompt, inFlight: true },
        cancel: { available: false, reason: "Run finished.", identity: null }
      }
    };
    const selectedRun = selection({ active: false, model });
    const stableIdentity = model.intervention.prompt.identity;
    if (!stableIdentity) throw new Error("Expected prompt identity.");
    const turnIdentity = {
      ...stableIdentity,
      version: "planweave.agent-prompt-turn/v1" as const,
      turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    };
    const getCurrentAgentPromptTurn = vi.fn(async () => ({
      found: true as const,
      state: {
        ...promptState(turnIdentity),
        phase: "prompting" as const,
        terminal: null,
        cancellationRequested: false,
        cancellable: true
      }
    }));
    const cancelAgentPromptTurn = vi.fn(async () => ({
      outcome: "cancel_requested" as const,
      state: null
    }));
    const props = {
      api: { cancelAgentPromptTurn, getCurrentAgentPromptTurn },
      liveStatus: "unavailable" as const,
      runnerModel: model,
      selectedRun,
      t
    };

    const first = render(<TaskWorkspaceComposer {...props} />);
    expect(await screen.findByRole("button", { name: "Stop follow-up" })).toBeInTheDocument();
    first.unmount();
    render(<TaskWorkspaceComposer {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop follow-up" }));

    await vi.waitFor(() => expect(cancelAgentPromptTurn).toHaveBeenCalledWith(turnIdentity));
    expect(getCurrentAgentPromptTurn).toHaveBeenCalledTimes(2);
  });

  it("rechecks a missing turn when runtime becomes in flight and hides stop during cleaning", async () => {
    const baseModel = readModel();
    const identity = baseModel.intervention.prompt.identity;
    if (!identity) throw new Error("Expected prompt identity.");
    const completedModel = (inFlight: boolean) => ({
      ...baseModel,
      terminal: true,
      cursor: { ...baseModel.cursor, terminal: true },
      intervention: {
        ...baseModel.intervention,
        prompt: { ...baseModel.intervention.prompt, inFlight },
        cancel: { available: false, reason: "Run finished.", identity: null }
      }
    });
    const turnIdentity = {
      ...identity,
      version: "planweave.agent-prompt-turn/v1" as const,
      turnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    };
    const getCurrentAgentPromptTurn = vi
      .fn<DesktopBridgeApi["getCurrentAgentPromptTurn"]>()
      .mockResolvedValueOnce({ found: false, reason: "not_found" })
      .mockResolvedValueOnce({
        found: true,
        state: {
          ...promptState(turnIdentity),
          phase: "prompting",
          terminal: null,
          cancellable: true
        }
      })
      .mockResolvedValueOnce({
        found: true,
        state: {
          ...promptState(turnIdentity),
          phase: "cleaning",
          terminal: null,
          cancellable: false
        }
      });
    const api = { getCurrentAgentPromptTurn };
    const initial = completedModel(false);
    const view = render(
      <TaskWorkspaceComposer
        api={api}
        liveStatus="unavailable"
        runnerModel={initial}
        selectedRun={selection({ active: false, model: initial })}
        t={t}
      />
    );
    await vi.waitFor(() => expect(getCurrentAgentPromptTurn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Stop follow-up" })).not.toBeInTheDocument();

    const active = completedModel(true);
    view.rerender(
      <TaskWorkspaceComposer
        api={api}
        liveStatus="unavailable"
        runnerModel={active}
        selectedRun={selection({ active: false, model: active })}
        t={t}
      />
    );
    expect(await screen.findByRole("button", { name: "Stop follow-up" })).toBeInTheDocument();

    const cleaning = { ...active };
    view.rerender(
      <TaskWorkspaceComposer
        api={api}
        liveStatus="unavailable"
        runnerModel={cleaning}
        selectedRun={selection({ active: false, model: cleaning })}
        t={t}
      />
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop follow-up" })).not.toBeInTheDocument()
    );
    expect(getCurrentAgentPromptTurn).toHaveBeenCalledTimes(3);
  });

  it("ignores stale current-turn recovery after switching the selected run", async () => {
    const firstModel = readModel();
    const firstIdentity = firstModel.intervention.prompt.identity;
    if (!firstIdentity) throw new Error("Expected prompt identity.");
    const secondIdentity = {
      ...firstIdentity,
      recordId: "T-001#B-001::RUN-002",
      executorRunId: "RUN-002",
      sessionId: "session-2"
    };
    const completedModel = (identity: typeof firstIdentity) => ({
      ...firstModel,
      terminal: true,
      cursor: { ...firstModel.cursor, terminal: true },
      intervention: {
        ...firstModel.intervention,
        prompt: { ...firstModel.intervention.prompt, identity, inFlight: true },
        cancel: { available: false, reason: "Run finished.", identity: null }
      }
    });
    const firstCurrent =
      deferred<Awaited<ReturnType<DesktopBridgeApi["getCurrentAgentPromptTurn"]>>>();
    const secondCurrent =
      deferred<Awaited<ReturnType<DesktopBridgeApi["getCurrentAgentPromptTurn"]>>>();
    const getCurrentAgentPromptTurn = vi.fn((identity: typeof firstIdentity) =>
      identity.recordId === firstIdentity.recordId ? firstCurrent.promise : secondCurrent.promise
    );
    const cancelAgentPromptTurn = vi.fn(async () => ({
      outcome: "cancel_requested" as const,
      state: null
    }));
    const firstCompletedModel = completedModel(firstIdentity);
    const view = render(
      <TaskWorkspaceComposer
        api={{ cancelAgentPromptTurn, getCurrentAgentPromptTurn }}
        liveStatus="unavailable"
        runnerModel={firstCompletedModel}
        selectedRun={selection({ active: false, model: firstCompletedModel })}
        t={t}
      />
    );
    const secondCompletedModel = completedModel(secondIdentity);
    view.rerender(
      <TaskWorkspaceComposer
        api={{ cancelAgentPromptTurn, getCurrentAgentPromptTurn }}
        liveStatus="unavailable"
        runnerModel={secondCompletedModel}
        selectedRun={selection({ active: false, model: secondCompletedModel })}
        t={t}
      />
    );
    firstCurrent.resolve({
      found: true,
      state: {
        ...promptState({
          ...firstIdentity,
          version: "planweave.agent-prompt-turn/v1",
          turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        }),
        phase: "prompting",
        terminal: null,
        cancellable: true
      }
    });
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Stop follow-up" })).not.toBeInTheDocument();
    const secondTurn = {
      ...secondIdentity,
      version: "planweave.agent-prompt-turn/v1" as const,
      turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    };
    secondCurrent.resolve({
      found: true,
      state: {
        ...promptState(secondTurn),
        phase: "prompting",
        terminal: null,
        cancellable: true
      }
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop follow-up" }));

    await vi.waitFor(() => expect(cancelAgentPromptTurn).toHaveBeenCalledWith(secondTurn));
  });

  it("retries with the canonical capability identity and refreshes even without a runner model", async () => {
    const selectedRun = selection({ active: false, model: null, retry: true });
    const retryTaskWorkspaceRun = vi.fn(async () => undefined);
    const refresh = vi.fn();
    render(
      <TaskWorkspaceComposer
        api={{ retryTaskWorkspaceRun }}
        liveStatus="unavailable"
        refresh={refresh}
        runnerModel={null}
        selectedRun={selectedRun}
        t={t}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() =>
      expect(retryTaskWorkspaceRun).toHaveBeenCalledWith(
        selectedRun.item.run.capabilities.retry.identity
      )
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted ACP session with the canonical capability identity", async () => {
    const selectedRun = selection({ active: false, model: null, recovery: true });
    const recoverTaskWorkspaceAcpRun = vi.fn(async () => undefined);
    const refresh = vi.fn();
    render(
      <TaskWorkspaceComposer
        api={{ recoverTaskWorkspaceAcpRun }}
        liveStatus="unavailable"
        refresh={refresh}
        runnerModel={null}
        selectedRun={selectedRun}
        t={t}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Recover ACP session" }));

    await vi.waitFor(() =>
      expect(recoverTaskWorkspaceAcpRun).toHaveBeenCalledWith(
        selectedRun.item.run.capabilities.recoverAcpSession.identity,
        {
          source: "planweave-desktop",
          reason: "User requested recovery of an interrupted ACP session."
        }
      )
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not keep a newly selected retry disabled while an older identity is pending", async () => {
    const first = retrySelection("RUN-001");
    const second = retrySelection("RUN-002");
    const firstRequest = deferred<void>();
    const retryTaskWorkspaceRun = vi.fn((identity) =>
      identity.runId === "RUN-001" ? firstRequest.promise : Promise.resolve()
    );
    const refresh = vi.fn();
    const { rerender } = render(
      <TaskWorkspaceComposer
        api={{ retryTaskWorkspaceRun }}
        liveStatus="unavailable"
        refresh={refresh}
        runnerModel={null}
        selectedRun={first}
        t={t}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    rerender(
      <TaskWorkspaceComposer
        api={{ retryTaskWorkspaceRun }}
        liveStatus="unavailable"
        refresh={refresh}
        runnerModel={null}
        selectedRun={second}
        t={t}
      />
    );
    const secondButton = screen.getByRole("button", { name: "Retry" });
    expect(secondButton).toBeEnabled();
    fireEvent.click(secondButton);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    await act(async () => firstRequest.resolve());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not show an older retry failure after selecting a different identity", async () => {
    const first = retrySelection("RUN-001");
    const second = retrySelection("RUN-002");
    const firstRequest = deferred<void>();
    const retryTaskWorkspaceRun = vi.fn(() => firstRequest.promise);
    const { rerender } = render(
      <TaskWorkspaceComposer
        api={{ retryTaskWorkspaceRun }}
        liveStatus="unavailable"
        refresh={vi.fn()}
        runnerModel={null}
        selectedRun={first}
        t={t}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    rerender(
      <TaskWorkspaceComposer
        api={{ retryTaskWorkspaceRun }}
        liveStatus="unavailable"
        refresh={vi.fn()}
        runnerModel={null}
        selectedRun={second}
        t={t}
      />
    );
    await act(async () => firstRequest.reject(new Error("old retry failed")));

    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/old retry failed/)).not.toBeInTheDocument();
  });
});
