/* @vitest-environment jsdom */

import { act, waitFor } from "@testing-library/react";
import type { RemoteInteractionResponse } from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import type { UseRemoteRunPanelControllerResult } from "../renderer/hooks/useRemoteRunPanelController";
import type { DesktopWorkspaceExecutionResponse } from "../shared/workspaceExecution";
import {
  apiReturning,
  blockItem,
  deferred,
  locator,
  remoteView,
  renderController,
  runtimeRemoteExecution
} from "./helpers/remoteRunPanelControllerFixtures";

const permissionResponse: RemoteInteractionResponse = {
  type: "interaction.permission_response",
  decision: "select_option",
  optionId: "write-once",
  actionId: "action-1",
  dispatchId: "dispatch-1",
  leaseId: "lease-1",
  executionAttemptId: "attempt-1",
  acpSessionId: "acp-session-1"
};

const mutations = ["cancel", "answer_interaction"] as const;
const settlements = ["resolve", "reject"] as const;
const orders = ["observation-first", "mutation-first"] as const;
type Mutation = (typeof mutations)[number];
type Settlement = (typeof settlements)[number];

function mutate(controller: UseRemoteRunPanelControllerResult, kind: Mutation) {
  if (kind === "cancel") {
    controller.setConfirmKind("cancel");
    return controller.cancel("stop");
  }
  return controller.answerInteraction(permissionResponse);
}

function settleMutation(
  pending: ReturnType<typeof deferred<DesktopWorkspaceExecutionResponse>>,
  kind: Mutation,
  settlement: Settlement
) {
  if (settlement === "reject") pending.reject(new Error("mutation denied"));
  else pending.resolve(remoteView({ phase: kind === "cancel" ? "stopped" : "running" }));
}

function expectSettled(
  controller: UseRemoteRunPanelControllerResult,
  kind: Mutation,
  settlement: Settlement
) {
  expect(controller.viewModel.phase).toBe(
    settlement === "reject"
      ? "action_required"
      : kind === "cancel"
        ? "terminal_cancelled"
        : "running"
  );
  expect(controller.viewModel.pendingInteractions).toHaveLength(settlement === "reject" ? 1 : 0);
  expect(controller.actionError).toBe(settlement === "reject" ? "mutation denied" : null);
  expect(controller.actionInFlight).toBeNull();
  expect(controller.loading).toBe(false);
  expect(controller.confirmKind).toBe(
    kind === "cancel" && settlement === "reject" ? "cancel" : null
  );
}

describe("Remote Run mutation and observation ownership", () => {
  const observationCases = mutations.flatMap((kind) =>
    (["refresh", "autoFollow", "loadMoreEvents", "resume"] as const).flatMap((entry) =>
      settlements.flatMap((settlement) =>
        orders.map((order) => ({ kind, entry, settlement, order }))
      )
    )
  );

  it.each(
    observationCases
  )("keeps $kind $settlement after $entry starts during the mutation ($order)", async ({
    kind,
    entry,
    settlement,
    order
  }) => {
    const initial = remoteView({ phase: "blocked", includeInteraction: true });
    const fixture = apiReturning(initial);
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution
    });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));
    const action = deferred<DesktopWorkspaceExecutionResponse>();
    const observation = deferred<DesktopWorkspaceExecutionResponse>();
    (kind === "cancel" ? fixture.cancel : fixture.respond).mockImplementationOnce(
      () => action.promise
    );
    fixture.follow.mockImplementationOnce(() => observation.promise);
    let actionCall!: Promise<void>;
    let observationCall: Promise<void> | undefined;
    act(() => {
      actionCall = mutate(result.current, kind);
    });
    if (entry === "autoFollow") {
      rerender({
        executionLocator: locator,
        workItem: blockItem,
        runtime: runtimeRemoteExecution,
        open: false
      });
      rerender({
        executionLocator: locator,
        workItem: blockItem,
        runtime: runtimeRemoteExecution,
        open: true
      });
    } else {
      act(() => {
        observationCall =
          entry === "resume" ? result.current.resume("continue") : result.current[entry]();
      });
    }
    expect(result.current.actionInFlight).toBe(kind);
    const completeObservation = async () => {
      await act(async () => {
        observation.resolve(initial);
        await observationCall;
        await observation.promise;
      });
    };
    const completeMutation = async () => {
      await act(async () => {
        settleMutation(action, kind, settlement);
        await actionCall;
      });
    };
    if (order === "observation-first") {
      await completeObservation();
      expect(result.current.actionInFlight).toBe(kind);
      await completeMutation();
    } else {
      await completeMutation();
      await completeObservation();
    }
    expectSettled(result.current, kind, settlement);
  });

  const readerCases = mutations.flatMap((kind) =>
    settlements.flatMap((settlement) =>
      settlements.flatMap((readerSettlement) =>
        orders.map((order) => ({ kind, settlement, readerSettlement, order }))
      )
    )
  );

  it.each(
    readerCases
  )("retires a runtime reader that $readerSettlement around $kind $settlement ($order)", async ({
    kind,
    settlement,
    readerSettlement,
    order
  }) => {
    const fixture = apiReturning(remoteView({ phase: "blocked", includeInteraction: true }));
    const reader = deferred<RemoteBlockExecutionReadModel | null>();
    const readRuntime = vi.fn(() => reader.promise);
    const { result } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution,
      refreshRuntimeRemoteExecution: readRuntime
    });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));
    const action = deferred<DesktopWorkspaceExecutionResponse>();
    (kind === "cancel" ? fixture.cancel : fixture.respond).mockImplementationOnce(
      () => action.promise
    );
    let refreshing!: Promise<void>;
    let actionCall!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
      actionCall = mutate(result.current, kind);
    });
    expect(readRuntime).toHaveBeenCalledOnce();
    const completeReader = async () => {
      await act(async () => {
        if (readerSettlement === "resolve") reader.resolve(runtimeRemoteExecution);
        else reader.reject(new Error("obsolete runtime reader"));
        await refreshing;
      });
    };
    const completeMutation = async () => {
      await act(async () => {
        settleMutation(action, kind, settlement);
        await actionCall;
      });
    };
    if (order === "observation-first") {
      await completeReader();
      expect(result.current.actionInFlight).toBe(kind);
      expect(result.current.actionError).toBeNull();
      await completeMutation();
    } else {
      await completeMutation();
      await completeReader();
    }
    expectSettled(result.current, kind, settlement);
    expect(fixture.follow).toHaveBeenCalledOnce();
  });

  const earlierFollowCases = mutations.flatMap((kind) =>
    settlements.flatMap((settlement) =>
      settlements.flatMap((followSettlement) =>
        orders.map((order) => ({ kind, settlement, followSettlement, order }))
      )
    )
  );

  it.each(
    earlierFollowCases
  )("settles loading after an earlier follow $followSettlement around $kind $settlement ($order)", async ({
    kind,
    settlement,
    followSettlement,
    order
  }) => {
    const initial = remoteView({ phase: "blocked", includeInteraction: true });
    const fixture = apiReturning(initial);
    const { result } = renderController({ api: fixture.api, runtime: runtimeRemoteExecution });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));
    const observation = deferred<DesktopWorkspaceExecutionResponse>();
    const action = deferred<DesktopWorkspaceExecutionResponse>();
    fixture.follow.mockImplementationOnce(() => observation.promise);
    (kind === "cancel" ? fixture.cancel : fixture.respond).mockImplementationOnce(
      () => action.promise
    );
    let refreshing!: Promise<void>;
    let actionCall!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
      actionCall = mutate(result.current, kind);
    });
    expect(result.current.loading).toBe(true);
    const completeObservation = async () => {
      await act(async () => {
        if (followSettlement === "resolve") observation.resolve(initial);
        else observation.reject(new Error("obsolete follow"));
        await refreshing;
      });
    };
    const completeMutation = async () => {
      await act(async () => {
        settleMutation(action, kind, settlement);
        await actionCall;
      });
    };
    if (order === "observation-first") {
      await completeObservation();
      expect(result.current.loading).toBe(false);
      expect(result.current.actionInFlight).toBe(kind);
      await completeMutation();
    } else {
      await completeMutation();
      await completeObservation();
    }
    expectSettled(result.current, kind, settlement);
  });

  it("does not start a runtime refresh during a mutation and permits refresh after settlement", async () => {
    const fixture = apiReturning(remoteView({ phase: "blocked", includeInteraction: true }));
    const readRuntime = vi.fn().mockResolvedValue(runtimeRemoteExecution);
    const { result } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution,
      refreshRuntimeRemoteExecution: readRuntime
    });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));
    const action = deferred<DesktopWorkspaceExecutionResponse>();
    fixture.cancel.mockImplementationOnce(() => action.promise);
    let actionCall!: Promise<void>;
    act(() => {
      actionCall = mutate(result.current, "cancel");
    });
    await act(async () => result.current.refresh());
    expect(readRuntime).not.toHaveBeenCalled();
    expect(fixture.follow).toHaveBeenCalledOnce();
    await act(async () => {
      action.resolve(remoteView({ phase: "stopped" }));
      await actionCall;
    });
    fixture.follow.mockResolvedValue(remoteView({ phase: "stopped" }));
    await act(async () => result.current.refresh());
    expect(readRuntime).toHaveBeenCalledOnce();
    expect(fixture.follow).toHaveBeenCalledTimes(2);
    expectSettled(result.current, "cancel", "resolve");
  });
});
