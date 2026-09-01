/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  logicalExecutorsFromLocalAgentEndpoints,
  useRemoteRunPanelController
} from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";

const startAutoRun = vi.hoisted(() => vi.fn(async () => undefined));

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
});
