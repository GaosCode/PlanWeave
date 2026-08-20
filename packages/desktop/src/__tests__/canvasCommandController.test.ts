import {
  exampleCanvasCommandAccepted,
  exampleCanvasReconnectAfterDisconnect
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { describe, expect, it, vi } from "vitest";
import {
  CanvasCommandController,
  type CanvasCommandBridge,
  type CanvasCommandLabels
} from "../renderer/collaboration/CanvasCommandController.js";
import type { CollaborationCanvasCommandSessionView } from "../shared/collaboration.js";

const labels: CanvasCommandLabels = {
  staleRevision: (expected, authoritative) => `stale:${expected}->${authoritative}`,
  rejected: (code) => `rejected:${code}`,
  reconnectFailed: (code) => `reconnect:${code}`,
  notConnected: "not-connected"
};

const initialSession: CollaborationCanvasCommandSessionView = {
  canvasId: "remote-canvas",
  revision: 0,
  contentDigest: null,
  lastOperationId: null,
  lastJournalEntryId: null,
  pendingOperationId: null,
  lastConflict: null,
  lastRejectCode: null
};

describe("CanvasCommandController", () => {
  it("waits for the initial authoritative reconnect before the first submit", async () => {
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const submit = vi.fn<CanvasCommandBridge["submitCollaborationCanvasCommand"]>(async () => ({
      outcome: exampleCanvasCommandAccepted,
      session: {
        ...initialSession,
        revision: exampleCanvasCommandAccepted.revision,
        contentDigest: exampleCanvasCommandAccepted.contentDigest
      }
    }));
    const api: CanvasCommandBridge = {
      bindCollaborationCanvasBindingSession: vi.fn(async () => initialSession),
      getCollaborationCanvasCommandSession: vi.fn(async () => initialSession),
      reconnectCollaborationCanvas: vi.fn(async () => {
        await reconnectGate;
        return {
          response: exampleCanvasReconnectAfterDisconnect,
          entriesToApply: exampleCanvasReconnectAfterDisconnect.entries,
          snapshotRequired: false,
          session: {
            ...initialSession,
            revision: exampleCanvasReconnectAfterDisconnect.headRevision,
            contentDigest: exampleCanvasReconnectAfterDisconnect.headContentDigest
          }
        };
      }),
      submitCollaborationCanvasCommand: submit
    };
    const controller = new CanvasCommandController({ api, labels });

    const binding = controller.bind({
      kind: "local",
      localProjectId: "local-project",
      canvasId: "local-canvas"
    });
    const submitting = controller.submit({
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# first edit after reconnect\n"
      }
    });
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();

    releaseReconnect();
    await binding;
    await submitting;
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
