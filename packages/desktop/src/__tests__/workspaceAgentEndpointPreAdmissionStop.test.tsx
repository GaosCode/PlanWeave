/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  blockClaim,
  project,
  remoteEndpoint,
  renderRun
} from "./workspaceAgentEndpointRunTestFixture";
import { agentEndpointPreferenceKey } from "../renderer/collaboration/agentEndpointPreferences";
import { WorkspaceExecutionStartIntents } from "../main/workspaceExecutionStartIntents.js";
import {
  pauseStartAfterJournalPersisted,
  setupPreAdmissionStop
} from "./workspaceExecutionPreAdmissionStopFixture.js";
import {
  availableRuntime,
  statusProjection
} from "./helpers/collaborationRuntimeAvailabilityFixture";

function renderRealWorkspaceRun(main: Awaited<ReturnType<typeof setupPreAdmissionStop>>) {
  const service = main.create();
  const preload = main.preload(service);
  const start = vi.fn(preload.startWorkspaceExecution);
  const cancelStart = vi.fn(preload.cancelWorkspaceExecutionStart);
  const recover = vi.fn(preload.recoverWorkspaceExecutionCancellations);
  let id = 0;
  const h = renderRun({
    workspaceLocator: main.input.locator,
    createId: () => `renderer-request-${++id}`,
    endpoint: { ...remoteEndpoint, remoteEndpointId: main.input.agentEndpointId },
    preferences: {
      [agentEndpointPreferenceKey({
        projectRoot: project.rootPath,
        canvasId: main.input.locator.canvasId,
        scope: { kind: "task", taskId: "T-001" }
      })]: {
        kind: "remote",
        remoteEndpointId: main.input.agentEndpointId
      }
    },
    startWorkspaceExecution: start,
    cancelWorkspaceExecutionStart: cancelStart,
    recoverWorkspaceExecutionCancellations: recover,
    previewClaimNext: vi.fn(async () => blockClaim(main.input.blockRef)),
    readRuntimeAvailability: vi.fn(async () =>
      availableRuntime(
        statusProjection({
          taskStatus: "ready",
          blocks: [{ ref: main.input.blockRef, status: "ready" }]
        })
      )
    )
  });
  return { h, service, preload, start, cancelStart, recover };
}

it("releases a recovered Stop from a reused PID instance through real Main before dispatching a new request", async () => {
  const main = await setupPreAdmissionStop();
  const journal = new WorkspaceExecutionStartIntents(main.sessionsRoot);
  const owner = {
    pid: process.pid,
    instanceId:
      journal.owner.instanceId === "00000000-0000-4000-8000-000000000001"
        ? "00000000-0000-4000-8000-000000000002"
        : "00000000-0000-4000-8000-000000000001"
  };
  await journal.write({
    input: main.input,
    owner,
    settled: false,
    cancellation: main.stop,
    cancellationConfirmed: false
  });
  const { h, service, preload, start, cancelStart, recover } = renderRealWorkspaceRun(main);
  await vi.waitFor(() =>
    expect(h.result.current.cancellation).toMatchObject({
      phase: "failed",
      sessions: [{ sessionId: main.input.startRequestId, status: "failed" }]
    })
  );
  expect(await recover.mock.results[0]?.value).toMatchObject({ starts: [main.stop], sessions: [] });
  await act(() => h.result.current({ kind: "block", blockRef: main.input.blockRef }));
  expect(start).not.toHaveBeenCalled();
  expect(h.setError).toHaveBeenCalledWith("agent_endpoint_scope_run_already_active");
  expect(main.server.countOperations()).toBe(0);
  await act(() => h.result.current.stop());
  expect(h.result.current.cancellation).toBeNull();
  expect(cancelStart).toHaveBeenCalledWith(main.stop);
  expect((await service.recoverCancellations({ locator: main.input.locator })).starts).toEqual([]);
  expect(await journal.read(main.input)).toMatchObject({
    owner,
    settled: false,
    cancellation: main.stop,
    cancellationConfirmed: true
  });
  await expect(service.start(main.input)).rejects.toThrow("workspace_execution_cancel_unconfirmed");
  await expect(preload.cancelWorkspaceExecutionStart(main.stop)).resolves.toMatchObject({
    confirmed: true
  });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  start.mockImplementationOnce(async (input) => {
    await preload.startWorkspaceExecution(input);
    await gate;
    throw new Error("dispatch_response_lost_during_test_teardown");
  });
  let running!: Promise<void>;
  act(() => {
    running = h.result.current({ kind: "block", blockRef: main.input.blockRef });
  });
  await vi.waitFor(() => expect(main.server.countOperations()).toBe(1));
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]?.[0].startRequestId).not.toBe(main.input.startRequestId);
  expect(
    main.requests.filter(
      (request) => request.path.endsWith("/remote-operations") && request.method === "POST"
    )
  ).toHaveLength(1);
  h.unmount();
  await act(async () => {
    release();
    await running;
  });
  expect(main.server.countOperations()).toBe(1);
});

it.each([
  "before",
  "after"
] as const)("retains a failed %s-admission Workspace start until real Main Stop recovery frees the renderer scope", async (timing) => {
  const main = await setupPreAdmissionStop();
  const { h, service, preload, start, cancelStart, recover } = renderRealWorkspaceRun(main);
  await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
  await act(async () => {
    await recover.mock.results[0]?.value;
  });
  if (timing === "before") {
    await main.clearCredential();
    await act(() => h.result.current({ kind: "block", blockRef: main.input.blockRef }));
  } else {
    const barrier = pauseStartAfterJournalPersisted("renderer-request-1");
    let starting!: Promise<void>;
    act(() => {
      starting = h.result.current({ kind: "block", blockRef: main.input.blockRef });
    });
    try {
      await barrier.persisted;
      expect((await main.journals()).map((journal) => journal.value)).toEqual([
        expect.objectContaining({
          owner: expect.objectContaining({ pid: process.pid }),
          settled: false,
          cancellation: null
        })
      ]);
      await main.clearCredential();
    } finally {
      barrier.release();
    }
    await act(() => starting);
  }
  expect(h.setError.mock.calls).toEqual([["workspace_execution_request_failed"]]);
  expect(start).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(h.result.current.cancellation).toMatchObject({
      phase: "failed",
      sessions: [{ blockRef: main.input.blockRef, status: "failed" }]
    })
  );
  expect(start).toHaveBeenCalledOnce();
  expect(cancelStart).toHaveBeenCalled();
  expect(main.server.countOperations()).toBe(0);
  if (timing === "before") expect(await main.diskFiles()).toEqual([]);
  else expect(await main.journals()).toHaveLength(1);
  expect(h.lifecycle.onCancelled).not.toHaveBeenCalled();
  await act(() => h.result.current({ kind: "block", blockRef: main.input.blockRef }));
  expect(start).toHaveBeenCalledOnce();
  expect(h.setError).toHaveBeenCalledWith("agent_endpoint_scope_run_already_active");

  await main.restoreCredential();
  await act(() => h.result.current.stop());
  expect(h.result.current.cancellation).toBeNull();
  expect(h.lifecycle.onCancelled).toHaveBeenCalledOnce();
  expect(cancelStart.mock.calls.at(-1)).toEqual(cancelStart.mock.calls[0]);
  expect((await service.recoverCancellations({ locator: main.input.locator })).starts).toEqual([]);
  const firstStart = start.mock.calls[0]?.[0];
  if (!firstStart) throw new Error("renderer_start_required");
  await expect(service.start(firstStart)).rejects.toThrow("workspace_execution_cancel_unconfirmed");

  // Keep the real dispatch response in flight so teardown also uses Main cancelStart.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  start.mockImplementationOnce(async (input) => {
    await preload.startWorkspaceExecution(input);
    await gate;
    throw new Error("dispatch_response_lost_during_test_teardown");
  });
  let running!: Promise<void>;
  act(() => {
    running = h.result.current({ kind: "block", blockRef: main.input.blockRef });
  });
  await vi.waitFor(() => expect(main.server.countOperations()).toBe(1));
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]?.[0].startRequestId).not.toBe(firstStart.startRequestId);
  h.unmount();
  await act(async () => {
    release();
    await running;
  });
});
