import type { CanvasPresenceServerMessage } from "@planweave-ai/collaboration-protocol/canvas/presence";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceCanvasPresenceController,
  type CanvasPresenceBridge
} from "../renderer/collaboration/WorkspaceCanvasPresenceController";
import type { CollaborationPresenceSignal } from "../shared/collaboration";
import { createTranslator } from "../renderer/i18n";

const labels = (language: "en" | "zh-CN") => {
  const t = createTranslator(language);
  return {
    error: (code: string) => t("canvasPresenceError").replace("{code}", code)
  };
};

function session(sessionId: string, humanPrincipalId: string, displayName: string) {
  return {
    identity: { sessionId, humanPrincipalId, displayName },
    pointer: { x: 120, y: 240 },
    selectionIds: ["T-001"]
  } as const;
}

function signal(message: CanvasPresenceServerMessage): CollaborationPresenceSignal {
  return { profileId: "profile-1", message };
}

function createBridge() {
  const listeners = new Set<(value: CollaborationPresenceSignal) => void>();
  const bridge: CanvasPresenceBridge = {
    startCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    stopCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    publishCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    onCollaborationPresenceSignal: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    })
  };
  return {
    bridge,
    emit: (value: CollaborationPresenceSignal) => {
      listeners.forEach((listener) => {
        listener(value);
      });
    },
    emitTo: (index: number, value: CollaborationPresenceSignal) => [...listeners][index]?.(value)
  };
}

describe("WorkspaceCanvasPresenceController", () => {
  beforeEach(() => vi.useRealTimers());

  it("flushes the latest local cursor after the presence handshake completes", async () => {
    const transport = createBridge();
    const controller = new WorkspaceCanvasPresenceController({
      api: transport.bridge,
      labels: labels("en")
    });
    await controller.start({ profileId: "profile-1", canvasId: "canvas-main" });

    await controller.publish({ pointer: { x: 10, y: 20 }, selectionIds: [] });
    await controller.publish({ pointer: { x: 30, y: 40 }, selectionIds: ["T-001"] });
    expect(transport.bridge.publishCollaborationPresence).not.toHaveBeenCalled();

    transport.emit(
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: []
      })
    );
    await Promise.resolve();

    expect(transport.bridge.publishCollaborationPresence).toHaveBeenCalledTimes(1);
    expect(transport.bridge.publishCollaborationPresence).toHaveBeenCalledWith({
      pointer: { x: 30, y: 40 },
      selectionIds: ["T-001"]
    });
  });

  it("keeps two client read models scoped, validated, and remote-only", async () => {
    const transport = createBridge();
    const first = new WorkspaceCanvasPresenceController({
      api: transport.bridge,
      labels: labels("en")
    });
    const second = new WorkspaceCanvasPresenceController({
      api: transport.bridge,
      labels: labels("en")
    });
    await first.start({
      profileId: "profile-1",
      canvasId: "canvas-main"
    });
    await second.start({
      profileId: "profile-1",
      canvasId: "canvas-main"
    });

    transport.emitTo(
      0,
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: [session("session-b", "human-a", "Bob")]
      })
    );
    transport.emitTo(
      1,
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: [session("session-a", "human-a", "  Alice ")]
      })
    );

    expect(first.getSnapshot().sessions).toEqual([
      {
        sessionId: "session-b",
        humanPrincipalId: "human-a",
        displayName: "Bob",
        pointer: { x: 120, y: 240 },
        selectionIds: ["T-001"]
      }
    ]);
    expect(second.getSnapshot().sessions).toEqual([
      {
        sessionId: "session-a",
        humanPrincipalId: "human-a",
        displayName: "Alice",
        pointer: { x: 120, y: 240 },
        selectionIds: ["T-001"]
      }
    ]);

    transport.emitTo(
      0,
      signal({
        type: "canvas.presence.leave",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessionId: "session-b"
      })
    );
    expect(first.getSnapshot().sessions).toEqual([]);
    expect(second.getSnapshot().sessions).toHaveLength(1);

    await first.stop();
    expect(first.getSnapshot().sessions).toEqual([]);
  });

  it("keeps a quiet session until the server sends leave and ignores another canvas", async () => {
    const transport = createBridge();
    const controller = new WorkspaceCanvasPresenceController({
      api: transport.bridge,
      labels: labels("zh-CN")
    });
    await controller.start({
      profileId: "profile-1",
      canvasId: "canvas-main"
    });
    const update = (canvasId: string) =>
      signal({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId,
        session: session("session-b", "human-b", "Bob")
      });
    transport.emit(update("canvas-other"));
    expect(controller.getSnapshot().sessions).toEqual([]);
    transport.emit(update("canvas-main"));
    expect(controller.getSnapshot().sessions).toHaveLength(1);
    transport.emit({
      profileId: "profile-1",
      reset: { canvasId: "canvas-main", reason: "disconnected" }
    });
    expect(controller.getSnapshot().sessions).toEqual([]);
    transport.emit(update("canvas-main"));
    expect(controller.getSnapshot().sessions).toHaveLength(1);
    transport.emit(
      signal({
        type: "canvas.presence.leave",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessionId: "session-b"
      })
    );
    expect(controller.getSnapshot().sessions).toEqual([]);
    await controller.stop();
  });

  it("re-publishes the last local pointer after disconnect reset + reconnect snapshot", async () => {
    const transport = createBridge();
    const controller = new WorkspaceCanvasPresenceController({
      api: transport.bridge,
      labels: labels("en")
    });
    await controller.start({ profileId: "profile-1", canvasId: "canvas-main" });
    transport.emit(
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: []
      })
    );
    await Promise.resolve();
    await controller.publish({ pointer: { x: 11, y: 22 }, selectionIds: ["T-001"] });
    expect(transport.bridge.publishCollaborationPresence).toHaveBeenLastCalledWith({
      pointer: { x: 11, y: 22 },
      selectionIds: ["T-001"]
    });
    const publishesBeforeReconnect = vi.mocked(transport.bridge.publishCollaborationPresence).mock
      .calls.length;

    transport.emit({
      profileId: "profile-1",
      reset: { canvasId: "canvas-main", reason: "disconnected" }
    });
    expect(controller.getSnapshot().sessions).toEqual([]);

    transport.emit(
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: []
      })
    );
    await Promise.resolve();
    expect(vi.mocked(transport.bridge.publishCollaborationPresence).mock.calls.length).toBe(
      publishesBeforeReconnect + 1
    );
    expect(transport.bridge.publishCollaborationPresence).toHaveBeenLastCalledWith({
      pointer: { x: 11, y: 22 },
      selectionIds: ["T-001"]
    });
    await controller.stop();
  });

  it("drops stale signals after canvas/profile generation changes", async () => {
    const transport = createBridge();
    const controller = new WorkspaceCanvasPresenceController({
      api: transport.bridge,
      labels: labels("en")
    });
    await controller.start({ profileId: "profile-1", canvasId: "canvas-a" });
    const gen0ListenerCount = vi.mocked(transport.bridge.onCollaborationPresenceSignal).mock.calls
      .length;
    await controller.start({ profileId: "profile-1", canvasId: "canvas-b" });
    expect(
      vi.mocked(transport.bridge.onCollaborationPresenceSignal).mock.calls.length
    ).toBeGreaterThan(gen0ListenerCount);

    // Late signal for the previous canvas must not pollute the new scope.
    transport.emit(
      signal({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-a",
        session: session("session-old", "human-old", "Old")
      })
    );
    expect(controller.getSnapshot().sessions).toEqual([]);

    transport.emit(
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-b",
        sessions: [session("session-new", "human-new", "New")]
      })
    );
    expect(controller.getSnapshot().sessions).toEqual([
      expect.objectContaining({ sessionId: "session-new", displayName: "New" })
    ]);
    await controller.stop();
  });
});
