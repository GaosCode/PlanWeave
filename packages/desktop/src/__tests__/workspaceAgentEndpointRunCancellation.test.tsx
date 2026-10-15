/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import { operation, renderRun } from "./workspaceAgentEndpointRunTestFixture";

describe("workspace Agent Endpoint cancellation", () => {
  it.each([
    "Stop",
    "scope switch"
  ] as const)("retains the same Stop request after an accepted start rejects on %s", async (source) => {
    let rejectStart!: (error: Error) => void;
    const start = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectStart = reject;
        })
    );
    let confirmed = false;
    const cancelStart = vi.fn(async () => ({
      version: "planweave.workspace-start-cancellation/v1",
      confirmed
    }));
    const h = renderRun({
      startWorkspaceExecution: start,
      cancelWorkspaceExecutionStart: cancelStart
    });
    let run!: Promise<void>;
    act(() => {
      run = h.result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    let stopped: Promise<unknown> | undefined;
    if (source === "Stop") stopped = h.result.current.stop().catch(() => undefined);
    else act(() => h.rerender({ authorityKey: "workspace-authority-2" }));
    await act(async () => {
      rejectStart(new Error("accepted response lost"));
      await run;
      await stopped;
    });
    expect(h.lifecycle.onCancelled).not.toHaveBeenCalled();
    if (source === "scope switch") {
      expect(h.result.current.cancellation).toBeNull();
      act(() => h.rerender({ authorityKey: "workspace-authority-1" }));
    }
    expect(h.result.current.cancellation).toMatchObject({
      phase: "failed",
      sessions: [{ blockRef: "T-001#B-001", status: "failed" }]
    });
    expect(cancelStart).toHaveBeenCalled();
    confirmed = true;
    await act(() => h.result.current.stop());
    expect(cancelStart.mock.calls.at(-1)).toEqual(cancelStart.mock.calls[0]);
    expect(h.result.current.cancellation).toBeNull();
    expect(start).toHaveBeenCalledOnce();
  });
  it.each([
    "follow failure",
    "scope switch",
    "unmount"
  ] as const)("requests remote cancellation after returned start on %s", async (source) => {
    let rejectFollow!: (error: Error) => void;
    const follow = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectFollow = reject;
        })
    );
    const h = renderRun({ followWorkspaceExecution: follow });
    const confirmed = await h.cancelWorkspaceExecution();
    h.cancelWorkspaceExecution.mockClear();
    h.cancelWorkspaceExecution.mockRejectedValueOnce(new Error("cancel response lost"));
    h.cancelWorkspaceExecution.mockResolvedValue(confirmed);
    let run!: Promise<void>;
    act(() => {
      run = h.result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(follow).toHaveBeenCalledOnce(), { timeout: 5000 });
    if (source === "scope switch") act(() => h.rerender({ authorityKey: "workspace-authority-2" }));
    if (source === "unmount") h.unmount();
    await act(async () => {
      rejectFollow(new Error("follow unavailable"));
      await run;
    });
    expect(h.cancelWorkspaceExecution).toHaveBeenCalledOnce();
    if (source === "unmount") return;
    if (source === "scope switch") {
      expect(h.result.current.cancellation).toBeNull();
      expect(h.setError).not.toHaveBeenCalled();
      h.rerender({ authorityKey: "workspace-authority-1" });
    }
    expect(h.result.current.cancellation).toMatchObject({
      phase: "failed",
      sessions: [{ status: "failed", error: "cancel response lost" }]
    });
    await act(() => h.result.current.stop());
    expect(h.cancelWorkspaceExecution.mock.calls[1]).toEqual(
      h.cancelWorkspaceExecution.mock.calls[0]
    );
    expect(h.result.current.cancellation).toBeNull();
  });

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

  it("retains pre-dispatch cancellation failure and retries with the same session and action", async () => {
    const { result, startWorkspaceExecution, cancelWorkspaceExecution, lifecycle } = renderRun();
    const confirmed = await cancelWorkspaceExecution();
    cancelWorkspaceExecution.mockClear();
    cancelWorkspaceExecution.mockRejectedValueOnce(new Error("observe unavailable"));
    cancelWorkspaceExecution.mockResolvedValue(confirmed);
    let run: Promise<void> | undefined;
    act(() => {
      run = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledOnce());
    await act(async () => {
      await expect(result.current.stop()).rejects.toThrow("workspace_remote_scope_cancel_failed");
    });
    await act(() => run);
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    await act(() => result.current.stop());
    expect(cancelWorkspaceExecution).toHaveBeenCalledTimes(2);
    expect(cancelWorkspaceExecution.mock.calls[1]).toEqual(cancelWorkspaceExecution.mock.calls[0]);
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
  });

  it("shares only the in-flight cancellation and waits for remote confirmation", async () => {
    const { result, startWorkspaceExecution, cancelWorkspaceExecution, lifecycle } = renderRun();
    const confirmed = await cancelWorkspaceExecution();
    cancelWorkspaceExecution.mockClear();
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cancelWorkspaceExecution.mockImplementation(async () => {
      await gate;
      return confirmed;
    });
    let run: Promise<void> | undefined;
    act(() => {
      run = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledOnce());
    const first = result.current.stop();
    const second = result.current.stop();
    await act(() => run);
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    expect(cancelWorkspaceExecution).toHaveBeenCalledOnce();
    release();
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
  });

  it("retains a late-start session when its first cancellation is unconfirmed", async () => {
    let releaseStart = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { result, startWorkspaceExecution, cancelWorkspaceExecution, lifecycle } = renderRun({
      startGate
    });
    const confirmed = await cancelWorkspaceExecution();
    cancelWorkspaceExecution.mockClear();
    cancelWorkspaceExecution.mockRejectedValueOnce(new Error("response lost"));
    cancelWorkspaceExecution.mockResolvedValue(confirmed);
    let run: Promise<void> | undefined;
    act(() => {
      run = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledOnce());
    const stop = result.current.stop();
    const failedStop = expect(stop).rejects.toThrow("workspace_remote_scope_cancel_failed");
    releaseStart();
    await act(async () => {
      await failedStop;
      await run;
    });
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    await act(() => result.current.stop());
    expect(cancelWorkspaceExecution).toHaveBeenCalledTimes(2);
    expect(cancelWorkspaceExecution.mock.calls[1]).toEqual(cancelWorkspaceExecution.mock.calls[0]);
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
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
