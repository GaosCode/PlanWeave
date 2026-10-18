/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";

function mockPort(): CollaborationReadBridgePort {
  return {
    getCollaborationStatus: vi.fn().mockResolvedValue({
      profiles: [],
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        operationScope: null,
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      updatedAt: "2030-01-01T00:00:00.000Z",
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
    }),
    listCollaborationMembers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn(),
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined)
  };
}

describe("collaborationReadModelHub", () => {
  it("shares one controller per read port and disposes when the last ref releases", () => {
    const api = mockPort();
    const first = acquireCollaborationReadModelController(api);
    const second = acquireCollaborationReadModelController(api);
    expect(second.controller).toBe(first.controller);

    first.release();
    const third = acquireCollaborationReadModelController(api);
    expect(third.controller).toBe(second.controller);

    second.release();
    third.release();

    const fourth = acquireCollaborationReadModelController(api);
    expect(fourth.controller).not.toBe(first.controller);
    fourth.release();
    resetCollaborationReadModelHubForTests(api);
  });
});
