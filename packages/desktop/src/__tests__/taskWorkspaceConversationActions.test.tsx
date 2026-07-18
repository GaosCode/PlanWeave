/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { TaskWorkspaceComposer } from "../renderer/task-workspace/conversation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { readModel, recordId, selection } from "./helpers/taskWorkspaceConversationFixture";

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
    const sendAgentPrompt = vi.fn(async () => undefined);
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
      expect(sendAgentPrompt).toHaveBeenCalledWith(
        model.intervention.prompt.identity,
        "Continue with the focused fix"
      )
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
