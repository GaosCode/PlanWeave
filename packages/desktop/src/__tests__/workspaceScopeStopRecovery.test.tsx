/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoRunControl } from "../renderer/hooks/useAutoRunControl";
import type { EndpointScopeCancellationState } from "../renderer/hooks/useWorkspaceAgentEndpointRun";
import { FloatingAutoRunControl } from "../renderer/run/FloatingAutoRunControl";
import { defaultAutoRunControlArgs } from "./helpers/autoRunControlHarness";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { renderRun } from "./workspaceAgentEndpointRunTestFixture";

afterEach(cleanupRendererTestEnvironment);

const retained: EndpointScopeCancellationState = {
  scopeIdentity: "scope-1",
  phase: "failed",
  sessions: [
    {
      blockRef: "T-001#B-001",
      sessionId: "SESSION-0001",
      status: "failed",
      error: "workspace_execution_cancel_unconfirmed"
    }
  ]
};

function Controls({
  cancellation,
  stop,
  openBlock
}: {
  cancellation: EndpointScopeCancellationState | null;
  stop: () => Promise<void>;
  openBlock?: (ref: string) => void;
}) {
  const control = useAutoRunControl(
    defaultAutoRunControlArgs({
      endpointScopeCancellation: cancellation,
      stopAutoRunScope: stop
    })
  );
  return (
    <FloatingAutoRunControl
      {...control}
      affectedTasks={[]}
      diagnostics={[]}
      projectDiagnostics={[]}
      dirtyPromptCount={0}
      dirtyPromptRefs={[]}
      refreshedPromptCount={0}
      refreshConcurrency={null}
      autoRunPreflightExecutorHint={null}
      handleRevealPathInFinder={vi.fn()}
      refreshPackageFiles={vi.fn()}
      onOpenFileSyncRef={openBlock ?? vi.fn()}
      selectedBlockPresent={false}
      selectedProject={null}
      selectedTaskPanelId={null}
      selectedCanvasId="canvas-main"
      selectedRemoteRunPhase="running"
      workspaceCanvasSelected={true}
      controlRef={null}
      style={{}}
      t={defaultAutoRunControlArgs().t}
    />
  );
}

describe("scope Stop recovery consumers", () => {
  it("does not publish a late recovered session into a different scope", async () => {
    const example = renderRun();
    const confirmed = await example.cancelWorkspaceExecution();
    example.unmount();
    const old = deferred<{ version: string; sessions: unknown[] }>();
    const recover = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({
      version: "planweave.workspace-cancellation-recovery/v1",
      sessions: []
    });
    const h = renderRun({ recoverWorkspaceExecutionCancellations: recover });
    await act(async () => undefined);
    h.rerender({ authorityKey: "workspace-authority-2" });
    await act(async () => undefined);
    await act(async () =>
      old.resolve({
        version: "planweave.workspace-cancellation-recovery/v1",
        sessions: [
          {
            sessionId: "SESSION-0001",
            blockRef: "T-001#B-001",
            intent: {
              actionId: "cancel-old-scope",
              reason: "Original scope stop",
              expectedRemoteHandle: confirmed.handle,
              effectiveExecutor: { name: "codex-acp", agentId: "codex" }
            }
          }
        ]
      })
    );
    expect(h.result.current.cancellation).toBeNull();
    await act(() => h.result.current.stop());
    expect(h.cancelWorkspaceExecution).not.toHaveBeenCalled();
    h.rerender({ authorityKey: "workspace-authority-1" });
    expect(h.result.current.cancellation).toMatchObject({
      phase: "failed",
      sessions: [{ sessionId: "SESSION-0001" }]
    });
  });

  it("shows retained sessions and disables repeated Stop while retry is pending", async () => {
    const response = deferred<void>();
    const stop = vi.fn(() => response.promise);
    const openBlock = vi.fn();
    render(<Controls cancellation={retained} stop={stop} openBlock={openBlock} />);
    expect(screen.getByTestId("auto-run-control-phase")).toHaveTextContent("部分取消尚未确认");
    const retry = screen.getByRole("button", { name: "重试取消" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByTestId("auto-run-control-phase")).toHaveTextContent("取消中");
    expect(
      screen
        .getAllByRole("button", { name: "停止" })
        .every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true);
    expect(screen.getByTestId("auto-run-cancellation-sessions")).toHaveTextContent("SESSION-0001");
    fireEvent.click(
      screen.getByRole("button", { name: defaultAutoRunControlArgs().t("openBlock") })
    );
    expect(openBlock).toHaveBeenCalledWith("T-001#B-001");
    await act(async () => response.reject(new Error("response lost")));
    expect(screen.getAllByRole("button", { name: "重试取消" })[0]).toBeEnabled();
  });

  it("restores an unconfirmed session after remount and replays its original action identity", async () => {
    const follow = deferred<never>();
    const followExecution = vi.fn(() => follow.promise);
    const first = renderRun({ followWorkspaceExecution: followExecution });
    first.cancelWorkspaceExecution.mockRejectedValue(new Error("cancel response lost"));
    let run!: Promise<void>;
    act(() => {
      run = first.result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(followExecution).toHaveBeenCalledOnce(), { timeout: 5000 });
    first.unmount();
    await act(async () => {
      follow.reject(new Error("follow disconnected"));
      await run;
    });
    expect(first.cancelWorkspaceExecution).toHaveBeenCalledOnce();
    const original = first.cancelWorkspaceExecution.mock.calls[0]?.[0];
    if (!original?.expectedRemoteHandle) throw new Error("original cancellation identity required");
    const intent = {
      actionId: original.actionId,
      reason: original.reason,
      expectedRemoteHandle: original.expectedRemoteHandle,
      effectiveExecutor: { name: "codex-acp", agentId: "codex" }
    };
    const recover = vi.fn(async () => ({
      version: "planweave.workspace-cancellation-recovery/v1",
      sessions: [
        {
          sessionId: "SESSION-0001",
          blockRef: "T-001#B-001",
          intent
        }
      ]
    }));
    const restored = renderRun({ recoverWorkspaceExecutionCancellations: recover });
    await act(async () => undefined);
    expect(restored.result.current.cancellation).toMatchObject({
      phase: "failed",
      sessions: [{ sessionId: "SESSION-0001" }]
    });
    await act(() => restored.result.current({ kind: "project" }));
    expect(restored.startWorkspaceExecution).not.toHaveBeenCalled();
    expect(restored.cancelWorkspaceExecution).not.toHaveBeenCalled();
    const controls = render(
      <Controls
        cancellation={restored.result.current.cancellation}
        stop={restored.result.current.stop}
      />
    );
    expect(screen.getByRole("button", { name: "重试取消" })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试取消" })));
    expect(restored.cancelWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "SESSION-0001",
        actionId: original.actionId,
        reason: original.reason,
        expectedRemoteHandle: intent.expectedRemoteHandle
      })
    );
    expect(restored.result.current.cancellation).toBeNull();
    controls.rerender(
      <Controls
        cancellation={restored.result.current.cancellation}
        stop={restored.result.current.stop}
      />
    );
    expect(screen.queryByTestId("auto-run-cancellation-sessions")).not.toBeInTheDocument();
    expect(restored.startWorkspaceExecution).not.toHaveBeenCalled();
  });
});
