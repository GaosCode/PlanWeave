import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

const electronMock = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  return {
    exposed,
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed.set(key, api);
      })
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }
  };
});

vi.mock("electron", () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer
}));

const rateLimitedResult = {
  ok: false,
  error: {
    kind: "rate_limited",
    code: "human_rate_limited",
    message: "Too many collaboration requests. Try again shortly.",
    httpStatus: 429,
    retryAfterMs: 2_000,
    retryable: true
  }
};

const expectedBoundaryError = {
  name: "CollaborationBoundaryError",
  kind: "rate_limited",
  code: "human_rate_limited",
  message: "Too many collaboration requests. Try again shortly.",
  httpStatus: 429,
  retryAfterMs: 2_000,
  retryable: true
};

describe("preload collaboration command bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.PLANWEAVE_DESKTOP_SMOKE;
    electronMock.exposed.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockClear();
    electronMock.ipcRenderer.on.mockClear();
    electronMock.ipcRenderer.off.mockClear();
    electronMock.ipcRenderer.invoke.mockResolvedValue(rateLimitedResult);
  });

  it("unwraps collaboration invitation command errors without exposing Electron invoke text", async () => {
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveCollaboration") as PlanWeaveCollaborationApi;

    await expect(api.createCollaborationInvitation({})).rejects.toMatchObject(
      expectedBoundaryError
    );
    await expect(api.createCollaborationInvitationHandoff({})).rejects.toMatchObject(
      expectedBoundaryError
    );
  });

  it("unwraps People read errors without exposing Electron invoke text", async () => {
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveCollaboration") as PlanWeaveCollaborationApi;

    for (const operation of [
      api.listCollaborationMembers(),
      api.listCollaborationDevices(),
      api.listCollaborationInvitations(),
      api.listCollaborationContentBootstrapCandidates()
    ]) {
      await expect(operation).rejects.toMatchObject(expectedBoundaryError);
    }
  });
});
