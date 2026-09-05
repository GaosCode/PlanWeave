/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import { operation, renderRun } from "./workspaceAgentEndpointRunTestFixture";

describe("workspace Agent Endpoint cancellation", () => {
  it("settles a cancellation reported by the execution composer without a failure banner", async () => {
    const { result, lifecycle, setError } = renderRun({
      remoteTerminal: operation("cancelled")
    });
    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(lifecycle.onCompleted).not.toHaveBeenCalled();
    expect(lifecycle.onFailed).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("waits for a pending Workspace start before stop cancels the exact returned session once", async () => {
    let releaseStart = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { result, startWorkspaceExecution, cancelWorkspaceExecution, lifecycle } = renderRun({
      startGate
    });

    let run: Promise<void> | undefined;
    act(() => {
      run = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledOnce());

    let stopSettled = false;
    const stop = result.current.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseStart();
    await act(() => stop);
    await act(() => run);

    expect(cancelWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(cancelWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0001", blockRef: "T-001#B-001" })
    );
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
  });

  it("cancels a pending Workspace start once when its authority scope changes", async () => {
    let releaseStart = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { result, rerender, startWorkspaceExecution, cancelWorkspaceExecution, lifecycle } =
      renderRun({ startGate });

    let run: Promise<void> | undefined;
    act(() => {
      run = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledOnce());

    rerender({ authorityKey: "workspace-authority-2" });
    releaseStart();
    await act(() => run);

    expect(cancelWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(cancelWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0001", blockRef: "T-001#B-001" })
    );
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
  });

  it("durably cancels an active collaboration remote operation when endpoint scope stops", async () => {
    const waitForTerminal = vi.fn(
      async (input: { signal?: AbortSignal }) =>
        new Promise<RemoteOperationObservation>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new Error("remote_task_run_cancelled")),
            { once: true }
          );
        })
    );
    const { result, dispatch, cancelWorkspaceExecution, lifecycle, setError } = renderRun({
      waitForTerminal
    });

    let run: Promise<void> | undefined;
    act(() => {
      run = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

    await act(() => result.current.stop());
    await act(() => run);

    expect(cancelWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        sessionId: "SESSION-0001",
        reason: "Desktop Auto Run stop requested."
      })
    );
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(setError).not.toHaveBeenCalled();
  });
});
