/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import type {
  RemoteEventReplay,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRemoteTaskWorkspaceConversation } from "../renderer/task-workspace/useRemoteTaskWorkspaceConversation";
import { remoteTaskWorkspaceConversationSource } from "../renderer/task-workspace/remoteTaskWorkspaceConversationSource";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("remote Task Workspace conversation", () => {
  it("loads a live ACP conversation through a transport-neutral operation source", async () => {
    const observation = {
      operationId: "operation-owner-001",
      state: "running"
    } as RemoteOperationObservation;
    const replay = {
      executionAttemptId: "attempt-001",
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: []
    } as RemoteEventReplay;
    const api = {
      observe: vi.fn(async () => observation),
      replay: vi.fn(async () => replay),
      subscribe: vi.fn(() => () => undefined)
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-owner-001",
        onTerminal
      })
    );

    await waitFor(() => expect(api.observe).toHaveBeenCalledWith("operation-owner-001"));
    expect(api.replay).toHaveBeenCalledWith("operation-owner-001", 0);
    await waitFor(() =>
      expect(result.current).toMatchObject({
        error: null,
        operationId: "operation-owner-001",
        state: "running"
      })
    );
  });

  it("routes Owner live operations through operator control without a collaboration session", async () => {
    const observation = {
      operationId: "operation-owner-001",
      state: "running"
    } as RemoteOperationObservation;
    const replay = {
      executionAttemptId: "attempt-001",
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: []
    } as RemoteEventReplay;
    const collaborationApi = {
      observeCollaborationRemoteOperation: vi.fn(async () => observation),
      replayCollaborationRemoteOperationEvents: vi.fn(async () => replay),
      onCollaborationObserverSignal: vi.fn(() => () => undefined)
    };
    const operatorApi = {
      observeOwnerFleetRemoteOperation: vi.fn(async () => observation),
      replayOwnerFleetRemoteOperationEvents: vi.fn(async () => replay)
    };
    const source = remoteTaskWorkspaceConversationSource({
      controlPlane: "owner",
      collaborationApi,
      operatorApi,
      operatorProfileId: "operator-profile-001"
    });

    await expect(source.observe("operation-owner-001")).resolves.toBe(observation);
    await expect(source.replay("operation-owner-001", 0)).resolves.toBe(replay);
    expect(operatorApi.observeOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "operator-profile-001",
      operationId: "operation-owner-001"
    });
    expect(collaborationApi.observeCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(collaborationApi.replayCollaborationRemoteOperationEvents).not.toHaveBeenCalled();
  });

  it("refreshes the disk-backed run at terminal without replaying a retired live operation", async () => {
    const observation = {
      operationId: "operation-owner-001",
      state: "completed"
    } as RemoteOperationObservation;
    const api = {
      observe: vi.fn(async () => observation),
      replay: vi.fn(async () => {
        throw new Error("operator_resource_not_found");
      }),
      replayTerminal: false
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-owner-001",
        onTerminal
      })
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
    expect(api.replay).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ error: null, state: "completed" });
  });

  it("preserves a durable terminal state when its event replay is unavailable", async () => {
    const api = {
      observe: vi.fn(async () => ({
        operationId: "operation-workspace-001",
        state: "failed" as const
      })),
      replay: vi.fn(async () => {
        throw new Error("collaboration_event_replay_unavailable");
      }),
      replayTerminal: true
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal
      })
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
    expect(result.current).toMatchObject({
      error: "collaboration_event_replay_unavailable",
      state: "failed",
      timeline: []
    });
  });
});
