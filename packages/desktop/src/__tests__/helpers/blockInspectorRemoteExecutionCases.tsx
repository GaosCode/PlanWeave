import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopBlockDetail, DesktopBridgeApi } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockInspectorWindow } from "../../renderer/BlockInspectorWindow";
import type { PlanWeaveWorkspaceExecutionApi } from "../../shared/workspaceExecution";
import { createDesktopBridgeMock } from "../desktopBridgeMock";
import { selectedBlock } from "./autoRunControlHarness";
import { graph } from "./graphFixtures";
import {
  apiReturning,
  blockItem,
  deferred,
  locator,
  remoteView,
  runtimeRemoteExecution
} from "./remoteRunPanelControllerFixtures";

export type BlockInspectorRemoteExecutionPorts = {
  desktop: DesktopBridgeApi | null;
  execution: PlanWeaveWorkspaceExecutionApi | null;
  profileId: string;
};

const block: DesktopBlockDetail = {
  ...selectedBlock,
  ref: blockItem.blockRef,
  taskId: "T-1",
  blockId: "B-1",
  executor: "codex-acp",
  effectiveExecutor: "codex-acp",
  remoteExecution: runtimeRemoteExecution
};

async function openWindow(
  ports: BlockInspectorRemoteExecutionPorts,
  overrides: Partial<DesktopBridgeApi> = {}
) {
  const fixture = apiReturning(remoteView({ phase: "blocked", includeInteraction: true }));
  ports.profileId = locator.operatorProfileId;
  ports.execution = fixture.api;
  const bridge = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([]),
    getGraphViewModel: vi.fn().mockResolvedValue({ ...graph, projectId: locator.projectId }),
    getBlockDetail: vi.fn().mockResolvedValue(block),
    listBlockRunRecords: vi.fn().mockResolvedValue([]),
    getReviewAttempts: vi.fn().mockResolvedValue([]),
    getFeedbackRecords: vi.fn().mockResolvedValue([]),
    detectTerminalApps: vi.fn().mockResolvedValue([]),
    getTerminalPreferences: vi.fn().mockResolvedValue({ defaultTerminalAppId: null }),
    ...overrides
  });
  ports.desktop = bridge;
  window.history.replaceState(
    {},
    "",
    `/?projectRoot=${locator.projectRoot}&canvasId=${locator.canvasId}&blockRef=${encodeURIComponent(block.ref)}&language=en`
  );
  const view = render(<BlockInspectorWindow />);
  return { ...fixture, bridge, ...view };
}

function startMutation(kind: "cancel" | "respond") {
  if (kind === "cancel") {
    fireEvent.click(screen.getByTestId("remote-run-action-cancel"));
    fireEvent.click(screen.getByTestId("remote-run-confirm-yes"));
  } else fireEvent.click(screen.getByTestId("acp-permission-option"));
}

function expectSettled(kind: "cancel" | "respond", settlement: "resolve" | "reject") {
  expect(screen.getByTestId("remote-run-identity")).toHaveTextContent("operation-1");
  expect(screen.getByTestId("remote-run-panel")).toHaveAttribute(
    "data-remote-run-phase",
    settlement === "reject"
      ? "action_required"
      : kind === "cancel"
        ? "terminal_cancelled"
        : "running"
  );
  expect(screen.queryAllByTestId("remote-run-interaction")).toHaveLength(
    settlement === "reject" ? 1 : 0
  );
  if (settlement === "reject") {
    expect(screen.getByTestId("remote-run-error")).toHaveTextContent("mutation denied");
    expect(
      screen.getByTestId(kind === "cancel" ? "remote-run-action-cancel" : "acp-permission-option")
    ).toBeEnabled();
  } else {
    expect(screen.queryByTestId("remote-run-error")).toBeNull();
    expect(screen.queryByTestId("acp-permission-option")).toBeNull();
    if (kind === "cancel") expect(screen.queryByTestId("remote-run-action-cancel")).toBeNull();
    else expect(screen.getByTestId("remote-run-action-cancel")).toBeEnabled();
  }
  if (kind === "cancel" && settlement === "reject")
    expect(screen.getByTestId("remote-run-confirm")).toBeInTheDocument();
  else expect(screen.queryByTestId("remote-run-confirm")).toBeNull();
}

export function registerBlockInspectorRemoteExecutionCases(
  ports: BlockInspectorRemoteExecutionPorts
) {
  afterEach(() => {
    cleanup();
    ports.desktop = null;
    ports.execution = null;
    window.history.replaceState({}, "", "/");
  });

  const cases = (["cancel", "respond"] as const).flatMap((kind) =>
    (["resolve", "reject"] as const).flatMap((settlement) =>
      (["resolve", "reject"] as const).flatMap((readerSettlement) =>
        (["reader-first", "mutation-first"] as const).map((order) => ({
          kind,
          settlement,
          readerSettlement,
          order
        }))
      )
    )
  );
  it.each(
    cases
  )("keeps $kind $settlement when the real Window reader $readerSettlement ($order)", async ({
    kind,
    settlement,
    readerSettlement,
    order
  }) => {
    const fixture = await openWindow(ports);
    await waitFor(() => expect(fixture.follow).toHaveBeenCalledOnce());
    await screen.findByTestId("remote-run-interaction");
    const reader = deferred<DesktopBlockDetail>();
    const mutation = deferred<ReturnType<typeof remoteView>>();
    vi.mocked(fixture.bridge.getBlockDetail).mockImplementationOnce(() => reader.promise);
    (kind === "cancel" ? fixture.cancel : fixture.respond).mockImplementationOnce(
      () => mutation.promise
    );
    fireEvent.click(screen.getByTestId("remote-run-refresh"));
    expect(fixture.bridge.getBlockDetail).toHaveBeenCalledTimes(2);
    startMutation(kind);
    const action = kind === "cancel" ? fixture.cancel : fixture.respond;
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ locator, blockRef: block.ref, sessionId: "SESSION-0001" })
    );
    const completeReader = async () => {
      await act(async () => {
        if (readerSettlement === "resolve") reader.resolve(block);
        else reader.reject(new Error("runtime reader failed"));
      });
    };
    const completeMutation = async () => {
      await act(async () => {
        if (settlement === "resolve")
          mutation.resolve(remoteView({ phase: kind === "cancel" ? "stopped" : "running" }));
        else mutation.reject(new Error("mutation denied"));
      });
    };
    if (order === "reader-first") {
      await completeReader();
      expect(screen.getByTestId("remote-run-action-cancel")).toBeDisabled();
      expect(screen.getByTestId("acp-permission-option")).toBeDisabled();
      expect(screen.queryByTestId("remote-run-error")).toBeNull();
      await completeMutation();
    } else {
      await completeMutation();
      expectSettled(kind, settlement);
      await completeReader();
    }
    expectSettled(kind, settlement);
    if (readerSettlement === "reject")
      expect(screen.getByText("runtime reader failed")).toBeInTheDocument();
    expect(fixture.follow).toHaveBeenCalledOnce();
    if (kind === "respond")
      expect(fixture.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            actionId: "action-1",
            optionId: "write-once",
            decision: "select_option"
          })
        })
      );
  });

  it("reports initial read failure without establishing an execution locator", async () => {
    const fixture = await openWindow(ports, {
      getBlockDetail: vi.fn().mockRejectedValue(new Error("initial reader failed"))
    });
    await screen.findByText("initial reader failed");
    expect(screen.queryByTestId("remote-run-panel")).toBeNull();
    expect(fixture.follow).not.toHaveBeenCalled();
  });

  describe.each(["project", "canvas"] as const)("%s scope read failure", (boundary) => {
    it("does not reuse the previous locator or accept its late cancellation", async () => {
      const fixture = await openWindow(ports);
      await screen.findByTestId("remote-run-interaction");
      const mutation = deferred<ReturnType<typeof remoteView>>();
      fixture.cancel.mockImplementationOnce(() => mutation.promise);
      startMutation("cancel");
      vi.mocked(fixture.bridge.getBlockDetail).mockRejectedValue(
        new Error("new scope read failed")
      );
      window.history.replaceState(
        {},
        "",
        `/?projectRoot=${boundary === "project" ? "/tmp/new-project" : locator.projectRoot}&canvasId=${boundary === "canvas" ? "canvas-new" : locator.canvasId}&blockRef=${encodeURIComponent(block.ref)}&language=en`
      );
      fixture.rerender(<BlockInspectorWindow />);
      await screen.findByText("new scope read failed");
      expect(screen.queryByTestId("remote-run-confirm")).toBeNull();
      expect(screen.getByTestId("remote-run-panel")).not.toHaveAttribute(
        "data-remote-run-phase",
        "action_required"
      );
      await act(async () => {
        mutation.resolve(remoteView({ phase: "stopped" }));
      });
      expect(screen.getByTestId("remote-run-panel")).not.toHaveAttribute(
        "data-remote-run-phase",
        "terminal_cancelled"
      );
      expect(fixture.follow).toHaveBeenCalledOnce();
    });
  });

  it.each([
    "profile",
    "operation"
  ] as const)("retires the previous mutation after a real Window %s change", async (boundary) => {
    const fixture = await openWindow(ports);
    await screen.findByTestId("remote-run-interaction");
    const mutation = deferred<ReturnType<typeof remoteView>>();
    const reader = deferred<DesktopBlockDetail>();
    vi.mocked(fixture.bridge.getBlockDetail).mockImplementationOnce(() => reader.promise);
    fireEvent.click(screen.getByTestId("remote-run-refresh"));
    fixture.cancel.mockImplementationOnce(() => mutation.promise);
    startMutation("cancel");
    const nextOperation = boundary === "operation" ? "operation-2" : "operation-1";
    fixture.follow.mockResolvedValue(
      remoteView({ operationId: nextOperation, sessionId: "SESSION-0002", phase: "running" })
    );
    if (boundary === "profile") {
      ports.profileId = "profile-other";
      fixture.rerender(<BlockInspectorWindow />);
    }
    await act(async () => {
      reader.resolve({
        ...block,
        remoteExecution: { ...runtimeRemoteExecution, identity: { operationId: nextOperation } }
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("remote-run-panel")).toHaveAttribute(
        "data-remote-run-phase",
        "running"
      )
    );
    await act(async () => {
      mutation.resolve(remoteView({ phase: "stopped" }));
    });
    expect(screen.getByTestId("remote-run-panel")).toHaveAttribute(
      "data-remote-run-phase",
      "running"
    );
    expect(screen.queryByTestId("remote-run-confirm")).toBeNull();
    expect(fixture.follow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        locator: {
          ...locator,
          operatorProfileId: boundary === "profile" ? "profile-other" : locator.operatorProfileId
        },
        operationId: nextOperation
      })
    );
  });
}
