/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  logicalExecutorsFromLocalAgentEndpoints,
  useRemoteRunPanelController
} from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";

const startAutoRun = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
);

vi.mock("../renderer/bridge", () => ({
  bridge: { startAutoRun },
  collaborationBridge: null,
  workspaceExecutionBridge: null
}));

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

const availableLocalEndpoint = {
  executorName: "codex-acp",
  displayName: "Codex",
  locationName: "This device",
  capabilities: ["acp.codex"],
  available: true,
  unavailableReason: null
} as const;

afterEach(() => startAutoRun.mockClear());

describe("logicalExecutorsFromLocalAgentEndpoints", () => {
  it("maps profile-style local names to logical agent family executors", () => {
    expect(logicalExecutorsFromLocalAgentEndpoints([availableLocalEndpoint])).toEqual([
      {
        executorName: "codex",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        capabilities: ["acp.codex"],
        available: true,
        unavailableReason: null,
        custom: false
      }
    ]);
  });
});

describe("useRemoteRunPanelController local Endpoint", () => {
  it("uses the selected local Endpoint as the one-run executor override", async () => {
    const canvasRef = { projectRoot: "/tmp/project", canvasId: "default" };
    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        canvasRef,
        localAgentEndpoints: [availableLocalEndpoint],
        requiredProfileId: "codex-acp",
        open: true,
        t: createTranslator("en")
      })
    );

    await waitFor(() =>
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "local:codex-acp", available: true })
        ])
      )
    );
    act(() => result.current.setSelectedAgentEndpointId("local:codex-acp"));
    await act(async () => result.current.dispatch());

    expect(startAutoRun).toHaveBeenCalledWith(
      canvasRef,
      { kind: "block", blockRef: "T-1#B-1" },
      20,
      { executorOverride: "codex-acp" }
    );
  });
  it.each([
    "block",
    "canvas",
    "project"
  ] as const)("isolates local dispatch without a locator across %s", async (boundary) => {
    let finishA!: () => void;
    let finishB!: () => void;
    const pendingA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    const pendingB = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    startAutoRun.mockImplementationOnce(() => pendingA).mockImplementationOnce(() => pendingB);
    const initialProps = {
      canvasRef: { projectRoot: "/tmp/project", canvasId: "default" },
      workItem: blockItem
    };
    const { result, rerender } = renderHook(
      ({ canvasRef, workItem }) =>
        useRemoteRunPanelController({
          canvasRef,
          workItem,
          localAgentEndpoints: [availableLocalEndpoint],
          requiredProfileId: "codex-acp",
          open: true,
          selectedAgentEndpointId: "local:codex-acp",
          t: createTranslator("en")
        }),
      { initialProps }
    );
    let callA!: Promise<void>;
    act(() => {
      callA = result.current.dispatch();
    });
    const nextProps = {
      canvasRef: {
        projectRoot: boundary === "project" ? "/tmp/other" : "/tmp/project",
        canvasId: boundary === "canvas" ? "other" : "default"
      },
      workItem: {
        ...blockItem,
        blockRef: boundary === "block" ? "T-1#B-2" : blockItem.blockRef,
        canvasId: boundary === "canvas" ? "other" : "default"
      }
    };
    rerender(nextProps);
    expect(result.current.actionInFlight).toBeNull();
    let callB!: Promise<void>;
    act(() => {
      callB = result.current.dispatch();
    });
    await act(async () => {
      finishA();
      await callA;
    });
    expect(result.current.actionInFlight).toBe("dispatch");
    expect(startAutoRun).toHaveBeenLastCalledWith(
      nextProps.canvasRef,
      { kind: "block", blockRef: nextProps.workItem.blockRef },
      20,
      { executorOverride: "codex-acp" }
    );
    await act(async () => {
      finishB();
      await callB;
    });
    expect(result.current.actionInFlight).toBeNull();
  });
});
